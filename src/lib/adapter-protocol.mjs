// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang v2.6.1 — Adapter 协议的可共享部分（契约：docs/PROTOCOL-V3.md）。
//
// 这里只放**纯函数与纯状态**：cursor 编解码、事件环形缓冲、命令幂等缓存、
// 协议协商、Bearer 解析、SSE 帧编解码、错误码 → HTTP 状态码。
// 不 import `node:*`，因此分身侧（adapter.mjs）与母体侧（adapter-client.mjs）
// 可以共用同一份语义，测试也不需要真实 socket。
import {
  ADAPTER_ERROR_STATUS,
  ADAPTER_PROTOCOL_MIN,
  ADAPTER_PROTOCOL_VERSION,
} from '../kernel/types.mjs'

/** 事件环形缓冲默认容量：母体断线后能追多久（1000 条 ≈ 数十分钟的常规事件）。 */
export const DEFAULT_EVENT_CAPACITY = 1000
/** 命令幂等缓存默认容量（LRU）。 */
export const DEFAULT_COMMAND_CACHE_SIZE = 500
/** SSE 心跳间隔：注释帧，不占 cursor（应小于常见代理 60s idle 超时）。 */
export const SSE_HEARTBEAT_MS = 15000
/** 母体侧重连退避默认值（毫秒）。 */
export const RECONNECT_DEFAULTS = Object.freeze({ baseMs: 500, maxMs: 8000 })

const MAX_UINT64 = 18446744073709551615n
const DECIMAL_RE = /^(0|[1-9][0-9]{0,19})$/
const COMMAND_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * cursor 是单调递增 uint64，JSON 里用十进制字符串表示（bigint 不能 JSON 序列化）。
 * @param {unknown} value
 * @returns {bigint|null} 非法输入返回 null（调用方映射 400 cursor-invalid）
 */
export function parseCursor(value) {
  if (typeof value === 'bigint') return value >= 0n && value <= MAX_UINT64 ? value : null
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null
    return BigInt(value)
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!DECIMAL_RE.test(text)) return null
  try {
    const n = BigInt(text)
    return n <= MAX_UINT64 ? n : null
  } catch {
    return null
  }
}

/** @param {bigint|number|string} value @returns {string} */
export function formatCursor(value) {
  try {
    const n = typeof value === 'bigint' ? value : BigInt(value)
    return n < 0n ? '0' : n.toString()
  } catch {
    return '0'
  }
}

/**
 * 分身侧事件环形缓冲。append 返回完整事件信封；since 支持断线续传。
 *
 * cursor 语义（PROTOCOL-V3 §7）：
 *   * `since=0`  → 从头回放当前缓冲；
 *   * `since` 落在缓冲内 → 返回之后的事件，gap=false；
 *   * `since` 早于最旧一条 → gap=true（调用方回 410，让母体重新拉快照）；
 *   * `since` 超前（分身重启 / 伪造）→ gap=true，reason='cursor-ahead'。
 */
export class EventLog {
  constructor({ capacity = DEFAULT_EVENT_CAPACITY, sessionId = '', now = () => Date.now() } = {}) {
    const size = Math.floor(Number(capacity))
    this.capacity = Number.isFinite(size) && size > 0 ? size : DEFAULT_EVENT_CAPACITY
    this.sessionId = String(sessionId ?? '')
    this.entries = []
    this.next = 1n
    this.now = typeof now === 'function' ? now : () => Date.now()
  }

  get size() {
    return this.entries.length
  }

  /** 最后一条事件的 cursor（空缓冲返回 '0'）。 */
  get lastCursor() {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1].cursor : '0'
  }

  /** 下一条事件将拿到的 cursor（不会回退）。 */
  get nextCursor() {
    return formatCursor(this.next)
  }

  /**
   * 追加一条事件。
   * @param {object} event
   * @returns {{cursor:string, sessionId:string, at:number, event:object}}
   */
  append(event) {
    const cursor = this.next++
    const body = event && typeof event === 'object' ? event : { kind: 'error', code: 'bad-event' }
    const envelope = {
      cursor: formatCursor(cursor),
      sessionId: this.sessionId,
      at: this.now(),
      event: body,
    }
    this.entries.push(envelope)
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity)
    }
    return envelope
  }

  /**
   * 取 `cursor` 之后的事件。
   * @param {unknown} cursor
   * @returns {{ok:boolean, code?:string, events:object[], gap:boolean, reason?:string,
   *   lastCursor:string, nextCursor:string, sessionId:string}}
   */
  since(cursor) {
    const parsed = parseCursor(cursor)
    if (parsed === null) {
      return {
        ok: false,
        code: 'cursor-invalid',
        events: [],
        gap: false,
        lastCursor: this.lastCursor,
        nextCursor: this.nextCursor,
        sessionId: this.sessionId,
      }
    }
    const base = { ok: true, events: [], gap: false, lastCursor: this.lastCursor, nextCursor: this.nextCursor, sessionId: this.sessionId }
    if (this.entries.length === 0) return base
    if (parsed >= this.next) return { ...base, gap: true, reason: 'cursor-ahead' }
    const oldest = parseCursor(this.entries[0].cursor)
    const events = this.entries.filter((entry) => parseCursor(entry.cursor) > parsed)
    return { ...base, events, gap: oldest !== null && parsed + 1n < oldest }
  }

  clear() {
    this.entries = []
  }
}

/**
 * 命令幂等缓存（LRU）。键是 commandId；命中后重放第一次的结果，不重复执行副作用。
 * 命中会刷新 LRU 顺序（Map 保序：先删后插）。
 */
export class CommandCache {
  constructor({ capacity = DEFAULT_COMMAND_CACHE_SIZE } = {}) {
    const size = Math.floor(Number(capacity))
    this.capacity = Number.isFinite(size) && size > 0 ? size : DEFAULT_COMMAND_CACHE_SIZE
    this.map = new Map()
  }

  get size() {
    return this.map.size
  }

  /** 命中返回值（任意 JSON 兼容对象），未命中返回 null。 */
  get(commandId) {
    const key = String(commandId ?? '')
    if (!key || !this.map.has(key)) return null
    const value = this.map.get(key)
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  has(commandId) {
    return this.map.has(String(commandId ?? ''))
  }

  set(commandId, value) {
    const key = String(commandId ?? '')
    if (!key) return null
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
    return value
  }

  clear() {
    this.map.clear()
  }
}

/**
 * 版本协商。父体拿到分身 /adapter/version 的 protocol 后调用。
 * @param {unknown} remote
 * @param {{min?:number, max?:number}} [options]
 * @returns {{ok:boolean, protocol?:number, reason?:string, remote?:unknown, min:number, max:number}}
 */
export function negotiateProtocol(remote, { min = ADAPTER_PROTOCOL_MIN, max = ADAPTER_PROTOCOL_VERSION } = {}) {
  const raw = Number(remote)
  if (!Number.isInteger(raw) || raw < 1) {
    return { ok: false, reason: 'protocol-invalid', remote, min, max }
  }
  if (raw < min) return { ok: false, reason: 'protocol-too-old', protocol: raw, remote: raw, min, max }
  if (raw > max) return { ok: false, reason: 'protocol-too-new', protocol: raw, remote: raw, min, max }
  return { ok: true, protocol: raw, min, max }
}

/** 从 Authorization 头取 Bearer token（大小写不敏感，空值返回 ''）。 */
export function parseBearer(header) {
  const text = String(header ?? '').trim()
  if (!text) return ''
  const match = /^Bearer\s+(\S+)$/i.exec(text)
  return match ? match[1] : ''
}

/**
 * 校验并归一化 v3 命令信封。
 * 接受 `{commandId, op, payload, async}`，也接受嵌套 `{commandId, command:{kind, payload}}`。
 * @returns {{ok:true, commandId:string, op:string, payload:object, async:boolean} |
 *   {ok:false, code:'command-id-invalid'|'missing-op', error:string, commandId:string}}
 */
export function normalizeCommandEnvelope(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const command = raw.command && typeof raw.command === 'object' ? raw.command : null
  const commandId = raw.commandId === undefined || raw.commandId === null ? '' : String(raw.commandId).trim()
  if (commandId && !COMMAND_ID_RE.test(commandId)) {
    return { ok: false, code: 'command-id-invalid', error: 'command-id-invalid', commandId }
  }
  const op = String(raw.op ?? command?.op ?? command?.kind ?? '').trim()
  if (!op) return { ok: false, code: 'missing-op', error: 'missing-op', commandId }
  const payloadRaw = raw.payload ?? command?.payload
  const payload = payloadRaw && typeof payloadRaw === 'object' ? payloadRaw : {}
  const async = raw.async === true || command?.async === true || payload.async === true
  return { ok: true, commandId, op, payload, async }
}

/** 构造失败信封（所有 Adapter 端点共用）。 */
export function adapterError(code, message, extra = null) {
  const envelope = { ok: false, code: String(code ?? 'internal-error'), error: String(message ?? code ?? 'internal-error') }
  if (extra && typeof extra === 'object') Object.assign(envelope, extra)
  return envelope
}

/** 错误码 → HTTP 状态码（未登记 = 500）。 */
export function statusForAdapterError(code) {
  return ADAPTER_ERROR_STATUS[String(code ?? '')] ?? 500
}

/**
 * 一条 SSE 帧。data 是事件信封的 JSON（JSON 会转义换行，因此永远是单行）。
 * @param {{cursor:string, sessionId:string, at:number, event:object}} envelope
 * @param {string} [eventName]
 */
export function sseFrame(envelope, eventName = 'adapter') {
  const data = JSON.stringify(envelope)
  return `id: ${envelope.cursor}\nevent: ${eventName}\ndata: ${data}\n\n`
}

/** SSE 注释帧（心跳/连接确认），不占 cursor。 */
export function sseComment(text = 'heartbeat') {
  return `: ${text}\n\n`
}

/** 连接建立时建议客户端重连间隔。 */
export const SSE_RETRY_FRAME = 'retry: 2000\n\n'

/**
 * 增量 SSE 解析器（母体侧）：把任意 chunk 切片还原成完整帧。
 * push() 返回本次解析出的帧数组；flush() 处理流结束时残留的半帧。
 * @returns {{push:(chunk:unknown)=>object[], flush:()=>object[]}}
 */
export function createSseParser() {
  let buffer = ''
  return {
    push(chunk) {
      buffer += String(chunk ?? '')
      const frames = []
      let at = buffer.indexOf('\n\n')
      while (at >= 0) {
        const block = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        const frame = parseSseBlock(block)
        if (frame) frames.push(frame)
        at = buffer.indexOf('\n\n')
      }
      return frames
    },
    flush() {
      const block = buffer
      buffer = ''
      if (!block.trim()) return []
      const frame = parseSseBlock(block)
      return frame ? [frame] : []
    },
  }
}

/** 解析一个 SSE 块：返回 {event, id, data}；只有注释的块返回 null。 */
function parseSseBlock(block) {
  const lines = String(block ?? '').split(/\r?\n/)
  let event = 'message'
  let id = ''
  const data = []
  let hasData = false
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'id') id = value
    else if (field === 'data') {
      data.push(value)
      hasData = true
    }
  }
  if (!hasData) return null
  return { event, id, data: data.join('\n') }
}

/** 生成一个命令幂等键（crypto.randomUUID 可用时优先）。 */
export function newCommandId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return `cmd_${globalThis.crypto.randomUUID()}`
    }
  } catch {
    /* 老运行时退化到时间戳 + 随机串 */
  }
  return `cmd_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}
