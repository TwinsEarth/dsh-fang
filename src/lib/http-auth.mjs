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

/** Host 是否 loopback（支持 localhost / 127.0.0.1 / [::1] / ::1，可带端口）。 */
export function isLoopbackHost(host) {
  const raw = String(host ?? '').trim().toLowerCase()
  if (raw.length === 0) return false
  const name = raw.startsWith('[')
    ? raw.slice(0, raw.indexOf(']') + 1)
    : raw.includes(':') && raw.split(':').length === 2 && /^\d+$/.test(raw.split(':')[1])
      ? raw.split(':')[0]
      : raw
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name === '::1'
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
