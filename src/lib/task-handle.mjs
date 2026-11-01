// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang v2.6.7 — TaskHandle：Forker 进程层 + ForkClient 命令层的统一生命周期对象。
//
// 契约：docs/TASK-HANDLE.md。
// 职责：
//   * start()：确保 fork 已运行（可选 spawn）→ 用 forker 的 token 建 ForkClient → 连接；
//   * 崩溃：监听 forker 的 fang/fork-crashed 事件 → reconnecting → 等 fang/fork-started
//     （或轮询 status）→ 用**新 token/新端口**重建 client；
//   * 命令代理：转发到 ForkClient；重连窗口内短等待（commandWaitMs），之后 reject；
//   * 生命周期：stop（保留 home）/ recycle（stop + reap）；stop/recycle 幂等；
//   * 事件：onEvent（SSE 事件）+ onTaskEvent（状态/崩溃/重启/重连/失败）。
//
// 与 fork-client.mjs 的分工：ForkClient 处理「同一个分身进程内的 SSE 断线/游标/命令 inflight」；
// TaskHandle 处理「整个分身进程崩溃重启」——端口与 Adapter token 都会变，必须重建 client。
import { bus as kernelBus } from '../kernel/core.mjs'
import { ADAPTER_OP } from '../kernel/types.mjs'
import { createForkClient } from './fork-client.mjs'

export const TASK_HANDLE_STATE = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',
  RUNNING: 'running',
  RECONNECTING: 'reconnecting',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
  FAILED: 'failed',
})

export const TASK_HANDLE_DEFAULTS = Object.freeze({
  commandWaitMs: 5_000,
  restartTimeoutMs: 60_000,
  pollMs: 250,
})

export const FORK_EVENT = Object.freeze({
  STARTED: 'fang/fork-started',
  CRASHED: 'fang/fork-crashed',
  REAPED: 'fang/fork-reaped',
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

function requireForker(forker) {
  const required = ['status', 'adapterToken', 'stop', 'reap']
  for (const method of required) {
    if (typeof forker?.[method] !== 'function') {
      throw new TypeError(`task handle forker is missing ${method}()`)
    }
  }
  return forker
}

/**
 * @typedef {object} TaskHandleOptions
 * @property {string} taskId
 * @property {object} forker             repo 的 fangForker 服务（status/adapterToken/stop/reap/spawn）
 * @property {(opts:object)=>object} [createClient] 默认 createForkClient
 * @property {object|null} [spawnOptions] 若 fork 尚未运行，start() 用它调用 forker.spawn
 * @property {{on:(topic:string,fn:Function)=>()=>void}} [eventSource] 默认 kernel bus
 * @property {number} [commandWaitMs=5000]
 * @property {number} [restartTimeoutMs=60000]
 * @property {number} [pollMs=250]
 * @property {{debug?:Function,warn?:Function}} [logger]
 */

export class TaskHandle {
  /** @param {TaskHandleOptions} options */
  constructor(options = {}) {
    const opts = options && typeof options === 'object' ? options : {}
    this.taskId = String(opts.taskId ?? '').trim()
    if (!this.taskId) throw new TypeError('TaskHandle requires a taskId')
    this.forker = requireForker(opts.forker)
    this.createClient = typeof opts.createClient === 'function' ? opts.createClient : (clientOptions) => createForkClient(clientOptions)
    this.spawnOptions = opts.spawnOptions && typeof opts.spawnOptions === 'object' ? { ...opts.spawnOptions } : null
    this.eventSource = opts.eventSource && typeof opts.eventSource.on === 'function' ? opts.eventSource : kernelBus
    this.commandWaitMs = positiveMs(opts.commandWaitMs, TASK_HANDLE_DEFAULTS.commandWaitMs)
    this.restartTimeoutMs = positiveMs(opts.restartTimeoutMs, TASK_HANDLE_DEFAULTS.restartTimeoutMs)
    this.pollMs = positiveMs(opts.pollMs, TASK_HANDLE_DEFAULTS.pollMs)
    this.logger = opts.logger && typeof opts.logger === 'object' ? opts.logger : {}

    this.state = TASK_HANDLE_STATE.IDLE
    this.meta = null
    this.client = null
    this.clientUnsubs = []
    this.busUnsubs = []
    this.eventsAttached = false
    this.startPromise = null
    this.stopPromise = null
    this.connectPromise = null
    this.crashHandler = null
    this.restartSlot = null
    this.disposed = false

    /** @type {Set<{resolve:Function,reject:Function,timer:any}>} */
    this.waiters = new Set()
    this.taskEventHandlers = new Set()
    this.eventHandlers = new Set()

    // 绑定一次，避免每次订阅产生新函数（unsubscribe 依赖同一个引用）
    this.onForkStarted = (payload) => this.handleForkStarted(payload)
    this.onForkCrashed = (payload) => this.handleForkCrashed(payload)
    this.onForkReaped = (payload) => this.handleForkReaped(payload)
  }

  get status() {
    return this.state
  }

  get taskMeta() {
    return this.meta
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  /** 启动：确保 fork 运行 → 建 client → connect。幂等（重复调用返回同一 promise）。 */
  start() {
    if (this.startPromise) return this.startPromise
    if (this.state !== TASK_HANDLE_STATE.IDLE) {
      return Promise.reject(makeError(`cannot start in status ${this.state}`, { code: 'bad-state' }))
    }
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  async doStart() {
    this.setState(TASK_HANDLE_STATE.STARTING)
    try {
      this.attachForkEvents()
      let live = this.forker.status(this.taskId)
      if (!live || !live.running) {
        if (!this.spawnOptions) {
          throw makeError('fork is not running and no spawnOptions were provided', { code: 'fork-not-running' })
        }
        if (typeof this.forker.spawn !== 'function') {
          throw makeError('forker.spawn is not available', { code: 'spawn-unavailable' })
        }
        const spawned = await this.forker.spawn({ forkId: this.taskId, ...this.spawnOptions })
        if (!spawned || spawned.ok !== true) {
          throw makeError(`fork spawn failed: ${spawned?.error ?? 'unknown'}`, {
            code: 'spawn-failed',
            detail: spawned,
          })
        }
        live = this.forker.status(this.taskId)
      }
      this.meta = live
      await this.connectClient()
      this.setState(TASK_HANDLE_STATE.RUNNING)
    } catch (e) {
      this.setState(TASK_HANDLE_STATE.FAILED)
      this.emitTaskEvent({ kind: 'failed', reason: msgOf(e) })
      this.rejectWaiters(e)
      throw e
    }
  }

  /**
   * 停止：取消订阅 → reject 等待中的命令 → 断开 client → forker.stop。
   * 与 recycle 的区别：stop 保留 fork home，recycle 之后会 reap 删除。
   */
  stop(options = {}) {
    if (this.stopPromise) return this.stopPromise
    if (this.state === TASK_HANDLE_STATE.STOPPED || this.state === TASK_HANDLE_STATE.IDLE) {
      return Promise.resolve()
    }
    this.stopPromise = this.doStop(options).finally(() => {
      this.stopPromise = null
    })
    return this.stopPromise
  }

  async doStop(options = {}) {
    this.setState(TASK_HANDLE_STATE.STOPPING)
    this.detachForkEvents()
    const stopping = makeError('task is stopping', { code: 'task-stopping' })
    this.restartSlot?.finish(stopping)
    this.rejectWaiters(stopping)
    await this.detachClient()
    try {
      await this.forker.stop(this.taskId)
    } catch (e) {
      this.logger.warn?.(`[task-handle] stop failed: ${msgOf(e)}`)
    }
    this.setState(TASK_HANDLE_STATE.STOPPED)
  }

  /** 停止并回收（删除 fork home）。返回 forker.reap 的结果。 */
  async recycle(options = {}) {
    if (this.state === TASK_HANDLE_STATE.STOPPED) {
      return this.forker.reap(this.taskId)
    }
    await this.stop({ graceful: options?.graceful !== false })
    return this.forker.reap(this.taskId)
  }

  /** 释放本地资源（不杀 fork；用于宿主卸载）。 */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.detachForkEvents()
    this.restartSlot?.finish(makeError('task handle disposed', { code: 'disposed' }))
    this.rejectWaiters(makeError('task handle disposed', { code: 'disposed' }))
    await this.detachClient()
    this.setState(TASK_HANDLE_STATE.STOPPED)
  }

  // ── 连接 ──────────────────────────────────────────────────────────────────

  connectClient() {
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = null
    })
    return this.connectPromise
  }

  async doConnect() {
    const live = this.forker.status(this.taskId)
    if (!live || !live.running || !live.url) {
      throw makeError('fork is not running', { code: 'fork-not-running' })
    }
    const adapterToken = String(this.forker.adapterToken?.(this.taskId) ?? '')
    if (!adapterToken) {
      throw makeError('fork adapter token is not available', { code: 'fork-token-missing' })
    }

    const client = this.createClient({ url: live.url, adapterToken, taskId: this.taskId })
    const unsubs = []
    unsubs.push(client.onEvent((envelope) => this.emitEvent(envelope)))
    unsubs.push(client.onReconnect((payload) => {
      this.emitTaskEvent({
        kind: 'reconnected',
        resetCursor: !!(payload && payload.resetCursor),
        meta: this.meta,
      })
    }))
    unsubs.push(client.onDisconnect((payload) => {
      // SSE 断开 ≠ 进程退出：状态由 fork 事件决定，这里只记录（可等 ForkClient 自己重连）。
      this.logger.warn?.(`[task-handle] adapter stream disconnected: ${payload?.reason ?? 'unknown'}`)
    }))

    try {
      const result = await client.connect()
      if (result && result.ok === false) {
        throw makeError(`adapter connect failed: ${result.code ?? 'unknown'}`, {
          code: result.code ?? 'connect-failed',
          fatal: !!result.fatal,
        })
      }
    } catch (e) {
      for (const off of unsubs) {
        try {
          off()
        } catch {
          /* ignore */
        }
      }
      try {
        await client.disconnect()
      } catch {
        /* ignore */
      }
      throw e
    }

    const previous = this.client
    const previousUnsubs = this.clientUnsubs
    this.client = client
    this.clientUnsubs = unsubs
    this.meta = live
    if (previous) {
      for (const off of previousUnsubs) {
        try {
          off()
        } catch {
          /* ignore */
        }
      }
      try {
        await previous.disconnect()
      } catch {
        /* ignore */
      }
    }
    return client
  }

  async detachClient() {
    const client = this.client
    this.client = null
    for (const off of this.clientUnsubs.splice(0)) {
      try {
        off()
      } catch {
        /* ignore */
      }
    }
    if (client) {
      try {
        await client.disconnect()
      } catch {
        /* ignore */
      }
    }
  }

  // ── fork 事件与崩溃恢复 ───────────────────────────────────────────────────

  attachForkEvents() {
    if (this.eventsAttached) return
    this.eventsAttached = true
    this.busUnsubs.push(this.eventSource.on(FORK_EVENT.STARTED, this.onForkStarted))
    this.busUnsubs.push(this.eventSource.on(FORK_EVENT.CRASHED, this.onForkCrashed))
    this.busUnsubs.push(this.eventSource.on(FORK_EVENT.REAPED, this.onForkReaped))
  }

  detachForkEvents() {
    this.eventsAttached = false
    for (const off of this.busUnsubs.splice(0)) {
      try {
        off()
      } catch {
        /* ignore */
      }
    }
  }

  handleForkStarted(payload) {
    if (String(payload?.forkId ?? '') !== this.taskId) return
    if (this.state !== TASK_HANDLE_STATE.RECONNECTING) return
    const live = this.forker.status(this.taskId)
    if (!live || !live.running || !live.url) return
    this.restartSlot?.finish(null, live)
  }

  handleForkCrashed(payload) {
    if (String(payload?.forkId ?? '') !== this.taskId) return
    if (this.state !== TASK_HANDLE_STATE.RUNNING) return
    if (this.crashHandler) return
    this.crashHandler = this.handleCrash(payload)
      .catch((e) => this.logger.warn?.(`[task-handle] crash handler failed: ${msgOf(e)}`))
      .finally(() => {
        this.crashHandler = null
      })
  }

  handleForkReaped(payload) {
    if (String(payload?.forkId ?? '') !== this.taskId) return
    if (this.state === TASK_HANDLE_STATE.STOPPING || this.state === TASK_HANDLE_STATE.STOPPED) return
    this.detachForkEvents()
    void this.detachClient()
    this.setState(TASK_HANDLE_STATE.STOPPED)
    this.rejectWaiters(makeError('task was reaped', { code: 'task-reaped' }))
  }

  async handleCrash(payload) {
    this.emitTaskEvent({
      kind: 'crashed',
      meta: this.meta,
      reason: String(payload?.kind ?? (payload?.code === null ? 'crash' : `exit ${payload?.code ?? ''}`)),
    })
    this.setState(TASK_HANDLE_STATE.RECONNECTING)
    await this.detachClient()

    let live
    try {
      live = await this.waitForRestart()
    } catch (e) {
      if (this.state === TASK_HANDLE_STATE.STOPPING || this.state === TASK_HANDLE_STATE.STOPPED) return
      this.setState(TASK_HANDLE_STATE.FAILED)
      this.emitTaskEvent({ kind: 'failed', reason: msgOf(e) })
      this.rejectWaiters(e)
      return
    }

    this.meta = live
    this.emitTaskEvent({ kind: 'restarting', meta: live })
    try {
      await this.connectClient()
      if (this.state === TASK_HANDLE_STATE.STOPPING || this.state === TASK_HANDLE_STATE.STOPPED) {
        await this.detachClient()
        return
      }
      this.setState(TASK_HANDLE_STATE.RUNNING)
      this.resolveWaiters()
      this.emitTaskEvent({ kind: 'reconnected', resetCursor: true, meta: live })
    } catch (e) {
      if (this.state === TASK_HANDLE_STATE.STOPPING || this.state === TASK_HANDLE_STATE.STOPPED) return
      this.setState(TASK_HANDLE_STATE.FAILED)
      this.emitTaskEvent({ kind: 'failed', reason: msgOf(e) })
      this.rejectWaiters(e)
    }
  }

  /**
   * 等待 fork 重新运行（端口/token 由 Forker 重启时更新）。
   * 优先由 fang/fork-started 事件唤醒；事件丢失时用 status 轮询兜底。
   */
  waitForRestart() {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + this.restartTimeoutMs
      let settled = false
      let timer = null
      const cleanup = () => {
        if (timer) clearInterval(timer)
        if (this.restartSlot?.finish === finish) this.restartSlot = null
      }
      const finish = (error, live) => {
        if (settled) return
        settled = true
        cleanup()
        if (error) reject(error)
        else resolve(live)
      }
      const check = () => {
        const live = this.forker.status(this.taskId)
        if (live && live.running && live.url) return finish(null, live)
        if (Date.now() >= deadline) {
          return finish(makeError(`fork did not restart within ${this.restartTimeoutMs}ms`, { code: 'restart-timeout' }))
        }
      }
      this.restartSlot = { finish }
      timer = setInterval(check, this.pollMs)
      check()
    })
  }

  // ── 命令代理 ──────────────────────────────────────────────────────────────

  /** 通用命令代理：等待可用（最多 commandWaitMs），然后转发给 ForkClient。 */
  async command(op, payload = {}, options = {}) {
    const operation = String(op ?? '').trim()
    if (!operation) throw makeError('op is required', { code: 'missing-op' })
    await this.waitUntilReady()
    const client = this.client
    if (!client) throw makeError('adapter client is not connected', { code: 'client-missing' })
    return client.command(operation, payload, options)
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

  waitUntilReady() {
    if (this.state === TASK_HANDLE_STATE.RUNNING && this.client) return Promise.resolve()
    if (this.state === TASK_HANDLE_STATE.IDLE) {
      return Promise.reject(makeError('task is not started', { code: 'task-not-started' }))
    }
    if (this.state === TASK_HANDLE_STATE.STOPPED || this.state === TASK_HANDLE_STATE.STOPPING) {
      return Promise.reject(makeError('task is stopped', { code: 'task-stopped' }))
    }
    if (this.state === TASK_HANDLE_STATE.FAILED) {
      return Promise.reject(makeError('task failed', { code: 'task-failed' }))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        reject(makeError(`task not available within ${this.commandWaitMs}ms`, { code: 'task-unavailable' }))
      }, this.commandWaitMs)
      const waiter = {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
        timer,
      }
      this.waiters.add(waiter)
    })
  }

  resolveWaiters() {
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter)
      waiter.resolve()
    }
  }

  rejectWaiters(error) {
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter)
      waiter.reject(error ?? makeError('task unavailable', { code: 'task-unavailable' }))
    }
  }

  // ── 查询 / 事件 ───────────────────────────────────────────────────────────

  getState() {
    return this.client?.getState?.() ?? null
  }

  getCursor() {
    return String(this.client?.getCursor?.() ?? '0')
  }

  getInflightCount() {
    return Number(this.client?.getInflightCount?.() ?? 0)
  }

  onEvent(handler) {
    return addListener(this.eventHandlers, handler)
  }

  onTaskEvent(handler) {
    return addListener(this.taskEventHandlers, handler)
  }

  emitEvent(envelope) {
    for (const handler of [...this.eventHandlers]) {
      try {
        handler(envelope)
      } catch (e) {
        this.logger.warn?.(`[task-handle] event handler threw: ${msgOf(e)}`)
      }
    }
  }

  emitTaskEvent(event) {
    const payload = { ...event, taskId: this.taskId, at: Date.now() }
    for (const handler of [...this.taskEventHandlers]) {
      try {
        handler(payload)
      } catch (e) {
        this.logger.warn?.(`[task-handle] task event handler threw: ${msgOf(e)}`)
      }
    }
  }

  setState(next) {
    if (this.state === next) return
    const from = this.state
    this.state = next
    this.emitTaskEvent({ kind: 'status-changed', from, to: next })
  }
}

function addListener(set, handler) {
  if (typeof handler !== 'function') return () => {}
  set.add(handler)
  return () => set.delete(handler)
}

export function createTaskHandle(options) {
  return new TaskHandle(options)
}

export const _internals = { positiveMs, requireForker }
