// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// fang-link（v2.9.0）— 母体连接描述 + 连通性探测（纯逻辑，供 orchestrator 服务与 HTTP 路由复用）。
//
// 边界：
//   * 只描述、不持有连接状态：分身的 token 由 Forker 在 spawn 时注入，fang 不落盘、不回显；
//   * 探测是只读 GET `${target}${prefix}/api/status`，带超时、不抛异常，失败以结构化错误返回；
//   * 目标只接受 http(s) origin，拒绝凭据/查询串/非 http 协议（避免把 token 写进 URL）。

import fs from 'node:fs'
import path from 'node:path'

export const MOTHER_LINK_PATHS = Object.freeze({
  DESCRIBE: '/api/mother-link',
  PROBE: '/api/mother-link/probe',
})

export const DEFAULT_LINK_TIMEOUT_MS = 3000
export const MAX_LINK_TIMEOUT_MS = 10000
export const MIN_LINK_TIMEOUT_MS = 200

/** @param {unknown} raw @returns {string} */
export function normalizePrefix(raw) {
  const text = String(raw ?? '/fang').trim().replace(/\/+$/, '')
  if (text.length === 0) return '/fang'
  return text.startsWith('/') ? text : `/${text}`
}

/**
 * 校验并归一化母体地址（只保留 origin，丢弃 path/query/hash）。
 * @param {unknown} raw
 * @returns {{ok:true, origin:string, host:string} | {ok:false, error:string}}
 */
export function normalizeLinkOrigin(raw) {
  const text = String(raw ?? '').trim()
  if (text.length === 0) return { ok: false, error: 'target-empty' }
  if (text.length > 512) return { ok: false, error: 'target-too-long' }
  let url
  try {
    url = new URL(text)
  } catch {
    return { ok: false, error: 'target-invalid-url' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'target-scheme' }
  if (url.username.length > 0 || url.password.length > 0) return { ok: false, error: 'target-credentials' }
  if (url.search.length > 0 || url.hash.length > 0) return { ok: false, error: 'target-query' }
  return { ok: true, origin: `${url.protocol}//${url.host}`, host: url.host }
}

/**
 * 母体侧读取 profile 的“共享配置摘要”（只读、失败降级为 null。
 * @param {{profileDir?: string, env?: Record<string, string|undefined>}} [options]
 * @returns {{layer:'profile', profile:string|null, profileDir:string|null, bundles:number|null, name?:string}}
 */
export function readSharedProfileSummary(options = {}) {
  const env = options.env ?? process.env
  const profile = typeof env.DSH_PROFILE === 'string' && env.DSH_PROFILE.length > 0 ? env.DSH_PROFILE : null
  const profileDir = String(options.profileDir ?? '').trim()
  const fallback = { layer: 'profile', profile, profileDir: profileDir.length > 0 ? profileDir : null, bundles: null }
  if (profileDir.length === 0) return fallback
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles.length : null
    return {
      ...fallback,
      bundles,
      name: typeof pkg?.name === 'string' ? pkg.name : undefined,
    }
  } catch {
    return fallback
  }
}

/**
 * 生成母体连接描述（纯函数）。
 * @param {{role?: string, version?: string, prefix?: string, profileDir?: string, sharedConfig?: object, now?: () => number}} options
 * @returns {Record<string, unknown>}
 */
export function describeMotherLink(options = {}) {
  const now = options.now ?? Date.now
  const prefix = normalizePrefix(options.prefix ?? '/fang')
  const sharedConfig = options.sharedConfig ?? readSharedProfileSummary({ profileDir: options.profileDir })
  return {
    ok: true,
    role: typeof options.role === 'string' ? options.role : 'mother',
    version: typeof options.version === 'string' ? options.version : '',
    at: now(),
    prefix,
    motherApiBase: `${prefix}/api`,
    adapterBase: `${prefix}/adapter`,
    probe: {
      method: 'POST',
      path: `${prefix}${MOTHER_LINK_PATHS.PROBE}`,
      body: { target: 'http(s)://<mother-host>', timeoutMs: DEFAULT_LINK_TIMEOUT_MS },
    },
    tokenPolicy: 'fork adapter token is injected by Forker at spawn time; fang never persists or echoes it',
    sharedConfig,
    forkInstructions: [
      '打开母体 web 门户（/fang/panel）或瓮城面板的「母体连接」卡片',
      '分身只需母体地址；令牌由 Forker 注入 DSH_ADAPTER_TOKEN，不需要手工填写',
      '连通性测试调用 POST /fang/api/mother-link/probe，不会写入任何配置',
    ],
  }
}

/**
 * 探测母体 `/api/status`（一次 GET，超时上限 10s；任何失败都返回结构化错误，不抛）。
 * @param {{target?: unknown, prefix?: string, timeoutMs?: number, timeoutMsLimit?: number, fetchImpl?: typeof fetch, now?: () => number}} options
 * @returns {Promise<Record<string, unknown>>}
 */
export async function probeLink(options = {}) {
  const now = options.now ?? Date.now
  const normalized = normalizeLinkOrigin(options.target)
  if (!normalized.ok) {
    return { ok: false, target: String(options.target ?? ''), error: normalized.error, latencyMs: 0, checkedAt: now() }
  }
  const rawTimeout = Number.isFinite(options.timeoutMs) ? Math.trunc(options.timeoutMs) : DEFAULT_LINK_TIMEOUT_MS
  const timeoutMs = Math.min(Math.max(rawTimeout, MIN_LINK_TIMEOUT_MS), MAX_LINK_TIMEOUT_MS)
  const prefix = normalizePrefix(options.prefix ?? '/fang')
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    return { ok: false, target: normalized.origin, error: 'fetch-unavailable', latencyMs: 0, checkedAt: now() }
  }
  const started = now()
  try {
    const response = await fetchImpl(`${normalized.origin}${prefix}/api/status`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const latencyMs = Math.max(0, now() - started)
    let payload = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    const version = typeof payload?.version === 'string' ? payload.version : null
    if (!response.ok) {
      return { ok: false, target: normalized.origin, httpStatus: response.status, latencyMs, version, error: 'status-http-error', checkedAt: now() }
    }
    return { ok: true, target: normalized.origin, httpStatus: response.status, latencyMs, version, checkedAt: now() }
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    const message = error instanceof Error ? error.message : String(error)
    const timedOut = name === 'TimeoutError' || name === 'AbortError'
    return {
      ok: false,
      target: normalized.origin,
      error: timedOut ? 'timeout' : 'network-error',
      message: message.slice(0, 200),
      latencyMs: Math.max(0, now() - started),
      checkedAt: now(),
    }
  }
}
