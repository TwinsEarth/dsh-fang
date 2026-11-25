// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// 关闭浏览器前的 fork 会话落盘调用（pure helpers）。
// DSH 没有公开的 HTTP flush/save 路由；官方入口是宿主内 ctx.sessions.flush(session)。
// Fang 通过 /fang/adapter/flush-session 在分身宿主内调用该入口，再由这里解析结果。
// 关键约束：adapter 鉴权只走 Authorization Bearer；fork URL 的 Web token 不进入落盘请求。

/**
 * 解析 fork 落盘端点。
 *
 * 注意：`new URL('/path', forkUrl)` 会丢掉 forkUrl 的查询串——这是预期行为。
 * forkUrl 的 `?token=` 是 Web 页面 token，不是 adapter Bearer；adapter 鉴权只看
 * Authorization 头，绝不把 token 放进落盘请求 URL。
 *
 * @param {string} forkUrl - 带 token 的分身 Web URL（只在内存中）
 * @param {string} flushPath - 配置的落盘路径
 * @returns {URL}
 */
export function resolveFlushEndpoint(forkUrl, flushPath) {
  return new URL(flushPath, new URL(forkUrl))
}

/**
 * 关闭流程调用 fork adapter 的请求头。adapter 只接受 Authorization Bearer，
 * 不接受 query token；token 从 forker().getToken(forkId) 取（只在内存）。
 * @param {string} token
 * @returns {Record<string,string>}
 */
export function flushRequestHeaders(token) {
  const headers = { accept: 'application/json' }
  const value = String(token ?? '').trim()
  if (value) headers.authorization = `Bearer ${value}`
  return headers
}

/**
 * 构造关闭浏览器前的未保存警告。`saved === true` 时返回 null。
 * 该警告必须在物理强杀之前写入任务状态/审计，避免“已经杀了才提示”。
 * @param {{saved:boolean, forkFlush?:object|null, at:number}} input
 * @returns {null | {at:number, code:string, message:string, detail:string, forkFlush:object|null}}
 */
export function unsavedCloseWarning({ saved, forkFlush = null, at }) {
  if (saved === true) return null
  const detail = forkFlush?.error ?? forkFlush?.detail
    ?? (forkFlush?.status ? `flush-http-${forkFlush.status}` : 'flush-unconfirmed')
  return {
    at,
    code: 'unsaved-force-close',
    message: '未保存强杀',
    detail,
    forkFlush,
  }
}

/**
 * 把 HTTP 响应折叠成关闭流程可审计的结果。
 * `saved` 只认服务端显式 `saved:true`；空 2xx / 非 JSON 不推断为已保存。
 * @param {{ok:boolean,status:number}} response
 * @param {unknown} body
 * @returns {{ok:boolean,status:number,saved:boolean,response:unknown}}
 */
export function flushResultFromResponse(response, body) {
  return {
    ok: response.ok === true && (body === null || body?.ok !== false),
    status: response.status,
    saved: body?.saved === true,
    response: body ?? null,
  }
}
