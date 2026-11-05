// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.5/B1 — 安装级 HTTP 鉴权：token 文件（0600）、loopback Host 校验、CSRF/Origin 检查。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { ensureDir, exists } from '../kernel/index.mjs'

export const AUTH_TOKEN_FILE = 'fang-auth.json'
export const AUTH_HEADER = 'x-fang-auth'
export const MIN_TOKEN_LENGTH = 32

/** 读取/生成安装级 token（env 覆盖 > 0600 文件 > 新建）。 */
export function loadAuthToken(dataDir, envToken = process.env.DSH_FANG_AUTH_TOKEN) {
  const fromEnv = String(envToken ?? '').trim()
  if (fromEnv.length >= MIN_TOKEN_LENGTH) return fromEnv
  const file = path.join(dataDir, AUTH_TOKEN_FILE)
  if (exists(file)) {
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (typeof doc?.token === 'string' && doc.token.length >= MIN_TOKEN_LENGTH) return doc.token
    } catch { /* 损坏则重建 */ }
  }
  const token = crypto.randomBytes(32).toString('hex')
  ensureDir(dataDir)
  fs.writeFileSync(file, JSON.stringify({ token, createdAt: Date.now() }), { encoding: 'utf8', mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch { /* Windows 上 chmod 可能无效 */ }
  return token
}

/**
 * Host 是否 loopback（支持 localhost / 127.0.0.1 / [::1] / ::1，可带端口）。
 *
 * 严格解析：`[::1]evil.example`、`127.0.0.1:3080@evil.example` 这类带尾随垃圾的
 * Host 必须判假——否则 DNS rebinding 防护会被一个字符串前缀绕过。
 */
export function isLoopbackHost(host) {
  const raw = String(host ?? '').trim().toLowerCase()
  if (raw.length === 0) return false
  if (raw === '::1') return true
  if (raw.startsWith('[')) {
    const match = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/.exec(raw)
    if (!match) return false
    if (match[2] !== undefined && Number(match[2]) > 65535) return false
    return match[1] === '::1'
  }
  const match = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(raw)
  if (!match) return false
  if (match[2] !== undefined && Number(match[2]) > 65535) return false
  return match[1] === 'localhost' || match[1] === '127.0.0.1'
}

/** Origin 是否允许（同源 loopback / dsh-app 壳 / 无 Origin）。 */
export function isAllowedOrigin(origin) {
  const raw = String(origin ?? '').trim()
  if (raw.length === 0) return true
  if (raw === 'dsh-app://app' || raw.startsWith('dsh-app://')) return true
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return isLoopbackHost(url.host)
  } catch {
    return false
  }
}

function header(req, name) {
  const headers = req?.headers ?? {}
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return String(headers[key] ?? '')
  }
  return ''
}

function timingSafeEqualText(expected, actual) {
  const a = Buffer.from(String(expected), 'utf8')
  const b = Buffer.from(String(actual), 'utf8')
  if (a.length !== b.length || a.length === 0) return false
  try { return crypto.timingSafeEqual(a, b) } catch { return false }
}

/**
 * 请求鉴权决策（fail-closed）。
 * @param {any} req
 * @param {{token:string, publicRoute?:boolean}} options
 * @returns {{ok:true} | {ok:false, status:number, code:string}}
 */
export function checkRequestAuth(req, options) {
  const token = String(options?.token ?? '')
  const method = String(req?.method ?? 'GET').toUpperCase()
  const host = header(req, 'host')
  if (host && !isLoopbackHost(host)) return { ok: false, status: 403, code: 'bad-host' }
  const origin = header(req, 'origin')
  if (!isAllowedOrigin(origin)) return { ok: false, status: 403, code: 'bad-origin' }
  const site = header(req, 'sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'same-site' && site !== 'none') {
    return { ok: false, status: 403, code: 'cross-site' }
  }
  if (options?.publicRoute === true) return { ok: true }
  const given = header(req, AUTH_HEADER) || (() => {
    const auth = header(req, 'authorization')
    const match = /^Bearer\s+(.+)$/i.exec(auth)
    return match ? match[1].trim() : ''
  })()
  if (!timingSafeEqualText(token, given)) return { ok: false, status: 401, code: 'unauthorized' }
  // 写操作要求 JSON content-type（阻止 text/plain 简单请求 CSRF；无 body 的 POST 也允许）
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const contentType = header(req, 'content-type').toLowerCase()
    if (contentType && !contentType.includes('application/json')) {
      return { ok: false, status: 415, code: 'content-type-required' }
    }
  }
  return { ok: true }
}

/** Stable error envelope for every auth/host/origin rejection (additive `code`). */
export function authErrorBody(decision) {
  const code = String(decision?.code ?? 'unauthorized')
  return { ok: false, error: code, code }
}

/**
 * Install-level guard shared by every plugin that owns `/fang/api/*` routes.
 *
 * Resolves the token exactly once at startup, with the same precedence as the
 * orchestrator: explicit config > env > `<dataDir>/fang-auth.json` (0600).
 * `enabled: false` is the explicit test/debug escape hatch and still enforces
 * Host/Origin/CSRF — it only skips the token comparison.
 *
 * @param {{dataDir?:string, token?:string, envToken?:string, enabled?:boolean}} [options]
 * @returns {{token:string, enabled:boolean, check:(req:any, routeOptions?:{public?:boolean})=>
 *   ({ok:true}|{ok:false,status:number,code:string})}}
 */
export function createHttpGuard(options = {}) {
  const enabled = options.enabled !== false
  const dataDir = String(options.dataDir ?? '').trim()
  const explicit = String(options.token ?? '').trim()
  const envToken = options.envToken === undefined ? process.env.DSH_FANG_AUTH_TOKEN : options.envToken
  let token = ''
  if (enabled) {
    if (dataDir) {
      token = loadAuthToken(dataDir, explicit || envToken)
    } else {
      const candidate = explicit || String(envToken ?? '').trim()
      if (candidate.length < MIN_TOKEN_LENGTH) {
        throw new Error('http-auth: dataDir or a >=32-char auth token is required when auth is enabled')
      }
      token = candidate
    }
  }
  return {
    token,
    enabled: token.length > 0,
    check(req, routeOptions = {}) {
      return checkRequestAuth(req, {
        token,
        publicRoute: token.length === 0 || routeOptions.public === true,
      })
    },
  }
}
