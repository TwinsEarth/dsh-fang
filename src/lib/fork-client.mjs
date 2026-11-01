// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang v2.6.4 — ForkClient：母体侧命令外观（传输 + 幂等 + inflight + 超时兜底）。
//
// 分层（契约：docs/FORK-CLIENT.md）：
//   * 传输层：`createAdapterClient()`（/commands JSON + SSE 事件流、光标续传、重连）；
//     本类只依赖它的 commands/connect/stop/onEvent/onReconnect/onDisconnect 与 lastState/lastCursor；
//   * 幂等层：`CommandCache.run()`（in-flight 合并 + completed 重放 + 失败契约）；
//   * 命令层（本类）：commandId 生成、同步/异步分派、trackingId → inflight 匹配、
//     异步命令等待 `command-done` 的超时兜底、SSE 生命周期对 inflight 的处置。
//
// 三条处置规则：
//   1. SSE 断开（网络抖动）→ inflight 保留：cursor 续传会补发 command-done；
//   2. 重连 resetCursor=true（分身重启/session 变了）→ 所有 inflight reject；
//   3. disconnect()（用户主动）→ 所有 inflight reject。
//
// 幂等/缓存语义：异步命令的缓存结果必须等到 command-done 终态才写入（选项 B）——
// 缓存 202 accepted 会把「已接受」误报成「已完成」，并让重试跳过真正的等待。
import { ADAPTER_OP } from '../kernel/types.mjs'
import { createAdapterClient } from './adapter-client.mjs'
import { CommandCache } from './command-cache.mjs'

export const FORK_CLIENT_DEFAULTS = Object.freeze({
  synchronousTimeoutMs: 30_000,
  asynchronousTimeoutMs: 120_000,
  cacheCapacity: 500,
})

const msgOf = (e) => String(e && e.message !== undefined ? e.message : e)

function makeError(message, extra = null) {
  const error = new Error(message)
  if (extra && typeof extra === 'object') Object.assign(error, extra)
  return error
}

function positiveMs(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function requireTransportMethods(transport) {
  const required = ['connect', 'stop', 'commands', 'onEvent', 'onReconnect', 'onDisconnect']
  for (const method of required) {
    if (typeof transport?.[method] !== 'function') {
      throw new TypeError(`fork client transport is missing ${method}()`)
    }
  }
  return transport
}

/**
 * 母体侧命令外观。
 *
 * @param {object} [options]
 * @param {string} [options.url] 分身 web URL（可带 `?token=`）
 * @param {string} [options.token] DSH web token
 * @param {string} [options.adapterToken] v3 Adapter Bearer token
 * @param {Function} [options.fetchImpl] 透传给传输层（测试用）
 * @param {object} [options.transport] 直接注入传输层（测试用）
 * @param {(opts:object)=>object} [options.transportFactory] 自定义传输层工厂
 * @param {CommandCache} [options.commandCache] 直接注入缓存（测试用）
 * @param {number} [options.cacheCapacity=500]
 * @param {number} [options.synchronousTimeoutMs=30000] 同步 POST 的传输超时
 * @param {number} [options.asynchronousTimeoutMs=120000] 异步命令等待 command-done 的超时
 * @param {{debug?:Function, warn?:Function}} [options.logger]
 */
export class ForkClient {
  constructor(options = {}) {
    const opts = options && typeof options === 'object' ? options : {}
    this.opts = { ...opts }
    this.syncTimeoutMs = positiveMs(opts.synchronousTimeoutMs, FORK_CLIENT_DEFAULTS.synchronousTimeoutMs)
    this.asyncTimeoutMs = positiveMs(opts.asynchronousTimeoutMs, FORK_CLIENT_DEFAULTS.asynchronousTimeoutMs)
    this.logger = opts.logger && typeof opts.logger === 'object' ? opts.logger : {}

    const factory = typeof opts.transportFactory === 'function'
      ? opts.transportFactory
      : (transportOptions) => createAdapterClient(transportOptions)
    this.transport = requireTransportMethods(
      opts.transport ?? factory({
        url: opts.url,
        token: opts.token,
        adapterToken: opts.adapterToken,
        fetchImpl: opts.fetchImpl,
        prefix: opts.prefix ?? '/fang',
        timeoutMs: this.syncTimeoutMs,
      }),
    )

    this.cache = opts.commandCache instanceof CommandCache
      ? opts.commandCache
      : new CommandCache({
        capacity: positiveMs(opts.cacheCapacity, FORK_CLIENT_DEFAULTS.cacheCapacity),
        onEvict: (commandId, entry) => {
          try {
            this.logger.debug?.(`[fork-client] cache evict ${commandId}`, { result: entry?.result })
          } catch {
            /* logger 异常隔离 */
          }
        },
      })

    /** @type {Map<string, {trackingId:string, commandId:string, op:string, resolve:Function, reject:Function, timer:any, startedAt:number}>} */
    this.inflight = new Map()
    this.commandCounter = 0
    this.stopped = false
    this.connected = false
    this.attached = false
    this.lastSnapshot = null
    this.transportUnsubs = []
    this.listeners = { event: new Set(), disconnect: new Set(), reconnect: new Set() }
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  /** 建立连接（版本协商 → 快照 → SSE）。失败抛出带 code/fatal 的错误。 */
  async connect() {
    if (this.stopped) throw makeError('fork client already disconnected', { code: 'disconnected' })
    this.attach()
    const result = await this.transport.connect()
    if (result && result.ok === false) {
      const error = makeError(String(result.code ?? result.error ?? 'connect-failed'), {
        code: result.code ?? 'connect-failed',
        fatal: !!result.fatal,
        retryable: !!result.retryable,
      })
      throw error
    }
    this.connected = true
    this.lastSnapshot = this.transport.lastState ?? this.lastSnapshot
    return result
  }

  /**
   * 主动断开：取消订阅、reject 所有 inflight、停止传输层。幂等。
   */
  async disconnect() {
    if (this.stopped) return
    this.stopped = true
    this.connected = false
    for (const off of this.transportUnsubs.splice(0)) {
      try {
        off()
      } catch {
        /* 取消订阅失败不阻塞断开 */
      }
    }
    this.rejectAllInflight('client disconnected')
    await this.transport.stop()
  }

  /** @deprecated 用 disconnect()；保留兼容。 */
  stop() {
    return this.disconnect()
  }

  // ── 查询 ──────────────────────────────────────────────────────────────────

  getState() {
    return this.lastSnapshot ?? this.transport.lastState ?? null
  }

  getCursor() {
    return String(this.transport.lastCursor ?? '0')
  }

  getInflightCount() {
    return this.inflight.size
  }

  get cacheStats() {
    return this.cache.stats()
  }

  /** 测试/诊断：某 commandId 是否仍在缓存（running 或 completed）。 */
  hasCachedCommand(commandId) {
    return this.cache.has(String(commandId ?? ''))
  }

  // ── 事件订阅 ──────────────────────────────────────────────────────────────

  onEvent(handler) {
    return addListener(this.listeners.event, handler)
  }

  onDisconnect(handler) {
    return addListener(this.listeners.disconnect, handler)
  }

  onReconnect(handler) {
    return addListener(this.listeners.reconnect, handler)
  }

  // ── 命令 API（dsh-Fang Adapter 的 9 个 op）───────────────────────────────

  command(op, payload = {}, options = {}) {
    const commandId = String(options?.commandId ?? '') || this.nextCommandId()
    return this.runCommand(commandId, op, payload, { async: !!options?.async })
  }

  /** 低层入口：复用给定 commandId（网络层重试/测试用），命中缓存时不会重复执行。 */
  commandWithId(commandId, op, payload = {}, options = {}) {
    return this.runCommand(String(commandId ?? ''), op, payload, { async: !!options?.async })
  }

  ping(payload = {}) {
    return this.command(ADAPTER_OP.PING, payload)
  }

  status(payload = {}) {
    return this.command(ADAPTER_OP.STATUS, payload)
  }

  flushBuffer(payload = {}) {
    return this.command(ADAPTER_OP.FLUSH_BUFFER, payload)
  }

  scorePlugin(payload = {}) {
    return this.command(ADAPTER_OP.SCORE_PLUGIN, payload)
  }

  readPlugin(payload = {}) {
    return this.command(ADAPTER_OP.READ_PLUGIN, payload)
  }

  routeConfirm(payload = {}) {
    return this.command(ADAPTER_OP.ROUTE_CONFIRM, payload)
  }

  approvals(payload = {}) {
    return this.command(ADAPTER_OP.APPROVALS, payload)
  }

  approvalDecide(payload = {}) {
    return this.command(ADAPTER_OP.APPROVAL_DECIDE, payload)
  }

  archive(payload = {}) {
    return this.command(ADAPTER_OP.ARCHIVE, payload)
  }

  // ── 内部：命令执行（CommandCache 包装）────────────────────────────────────

  /**
   * 幂等执行：`cache.run()` 内完成「POST → （异步）等待 command-done → 返回终态」。
   * 传输错误/超时/session 变化都会让 fn 抛错 → 缓存移除 → 允许用同一 commandId 重试。
   */
  runCommand(commandId, op, payload, { async: isAsync = false } = {}) {
    const id = String(commandId ?? '').trim()
    if (!id) return Promise.reject(makeError('commandId is required', { code: 'bad-command-id' }))
    const operation = String(op ?? '').trim()
    if (!operation) return Promise.reject(makeError('op is required', { code: 'missing-op' }))

    return this.cache.run(id, async () => {
      if (this.stopped) throw makeError('client disconnected', { code: 'disconnected' })
      if (!this.connected) throw makeError('fork client is not connected', { code: 'not-connected' })
      const envelope = { commandId: id, op: operation, payload: payload && typeof payload === 'object' ? payload : {} }
      if (isAsync) envelope.async = true

      const res = await this.transport.commands(envelope)
      if (!res || res.ok !== true) {
        const code = String(res?.data?.code ?? res?.error ?? res?.kind ?? 'command-failed')
        const error = makeError(`command ${operation} failed: ${code}`, {
          code,
          status: Number(res?.status) || 0,
          transport: true,
        })
        throw error
      }

      const body = res.data && typeof res.data === 'object' ? res.data : {}
      if (body.status === 'accepted') {
        const trackingId = String(body.trackingId ?? id)
        return this.waitForCommandDone(trackingId, { commandId: id, op: operation })
      }
      return body
    })
  }

  // ── 内部：inflight（trackingId → promise）────────────────────────────────

  /**
   * 等待异步命令的 `command-done`。
   * 超时 reject（code=command-timeout）→ 缓存移除；迟到的 command-done 会被静默忽略。
   */
  waitForCommandDone(trackingId, meta = {}) {
    const trackId = String(trackingId ?? '').trim()
    if (this.stopped) return Promise.reject(makeError('client disconnected', { code: 'disconnected' }))
    if (!trackId) return Promise.reject(makeError('trackingId is required', { code: 'bad-tracking-id' }))
    if (this.inflight.has(trackId)) {
      return Promise.reject(makeError(`duplicate trackingId: ${trackId}`, { code: 'duplicate-tracking-id' }))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inflight.delete(trackId)
        const error = makeError(
          `command ${meta.op ?? '?'} timed out after ${this.asyncTimeoutMs}ms (trackingId=${trackId})`,
          { code: 'command-timeout' },
        )
        reject(error)
      }, this.asyncTimeoutMs)
      this.inflight.set(trackId, {
        trackingId: trackId,
        commandId: String(meta.commandId ?? ''),
        op: String(meta.op ?? ''),
        resolve,
        reject,
        timer,
        startedAt: Date.now(),
      })
    })
  }

  resolveInflight(trackingId, result) {
    const entry = this.inflight.get(String(trackingId ?? ''))
    if (!entry) {
      this.logger.debug?.(`[fork-client] stale command-done: ${trackingId}`)
      return false
    }
    clearTimeout(entry.timer)
    this.inflight.delete(entry.trackingId)
    entry.resolve(result)
    return true
  }

  rejectAllInflight(reason) {
    let count = 0
    for (const [trackingId, entry] of [...this.inflight]) {
      clearTimeout(entry.timer)
      this.inflight.delete(trackingId)
      entry.reject(makeError(String(reason ?? 'inflight rejected'), { code: 'inflight-rejected' }))
      count += 1
    }
    return count
  }

  // ── 内部：传输层事件接线 ─────────────────────────────────────────────────

  attach() {
    if (this.attached) return
    this.attached = true
    this.transportUnsubs.push(this.transport.onEvent((envelope) => this.handleTransportEvent(envelope)))
    this.transportUnsubs.push(this.transport.onReconnect((payload) => this.handleTransportReconnect(payload)))
    this.transportUnsubs.push(this.transport.onDisconnect((payload) => this.handleTransportDisconnect(payload)))
  }

  handleTransportEvent(envelope) {
    const event = envelope && typeof envelope === 'object' ? envelope.event : null
    if (event && typeof event === 'object') {
      if (event.kind === 'command-done') {
        this.resolveInflight(event.trackingId, event.result)
      } else if (event.kind === 'state-changed' && event.snapshot) {
        this.lastSnapshot = event.snapshot
      } else if (event.kind === 'error') {
        this.logger.warn?.(`[fork-client] adapter error: ${event.code} ${event.message}`, { event })
      }
    }
    for (const handler of [...this.listeners.event]) {
      try {
        handler(envelope)
      } catch (e) {
        this.logger.warn?.(`[fork-client] event handler threw: ${msgOf(e)}`)
      }
    }
  }

  handleTransportReconnect(payload) {
    const resetCursor = typeof payload === 'boolean' ? payload : !!payload?.resetCursor
    if (resetCursor) {
      // 分身进程变了：旧 session 的 command-done 不会再来，继续等只会拖到超时。
      this.rejectAllInflight('session-changed: adapter restarted')
    }
    for (const handler of [...this.listeners.reconnect]) {
      try {
        handler(payload)
      } catch {
        /* 隔离 */
      }
    }
  }

  handleTransportDisconnect(payload) {
    // 网络抖动：保留 inflight，等 cursor 续传补发 command-done。
    for (const handler of [...this.listeners.disconnect]) {
      try {
        handler(payload)
      } catch {
        /* 隔离 */
      }
    }
  }

  nextCommandId() {
    this.commandCounter += 1
    return `cmd_${this.commandCounter}_${Date.now().toString(36)}`
  }
}

function addListener(set, handler) {
  if (typeof handler !== 'function') return () => {}
  set.add(handler)
  return () => set.delete(handler)
}

/** 便捷工厂（与 createAdapterClient 对称）。 */
export function createForkClient(options = {}) {
  return new ForkClient(options)
}

export const _internals = { positiveMs, requireTransportMethods }
