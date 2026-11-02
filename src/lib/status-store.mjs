// SPDX-License-Identifier: AGPL-3.0-or-later
// dsh-Fang v3.1.0 — MirrorStatusStore（插件层外部 store，框架无关）。
//
// 供 DSH client-half（React）用 useSyncExternalStore 订阅：
//   const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
//
// 语义：
//   * 订阅者 0 → 不轮询；首个订阅者立即 refresh；
//   * 轮询间隔 = activeConsumers > 0 且未空闲降级 ? activeIntervalMs : idleIntervalMs；
//   * acquireActive() 引用计数 + 每次调用重置 idleTimer（默认 30s 无交互 → 降回 idle）；
//   * pokeActive() 只报告“用户还活着”，不改变引用计数（refcount=0 时 no-op）；
//   * 降级后 pokeActive() 立即恢复高频档（不立即 refresh，节奏仍由 interval 决定）；
//   * refresh 结果 304 时只更新 lastUpdatedAt，不替换 status 引用；
//   * dispose() 清理所有定时器并 abort in-flight。
//
// 测试可注入 timers/now/fetcher，避免真实等待。

export const INITIAL_MIRROR_SNAPSHOT = Object.freeze({
  status: null, loading: false, error: null, lastUpdatedAt: null,
})

export class MirrorStatusStore {
  /**
   * @param {{fetcher: (options: {force?: boolean, signal?: AbortSignal}) => Promise<{status: object|null, notModified: boolean}>,
   *   idleIntervalMs?: number, activeIntervalMs?: number, activeIdleTimeoutMs?: number,
   *   logger?: {warn?: Function},
   *   timers?: {setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function},
   *   now?: () => number}} options
   */
  constructor(options) {
    if (options === null || typeof options !== 'object' || typeof options.fetcher !== 'function') {
      throw new Error('MirrorStatusStore: fetcher required')
    }
    this.fetcher = options.fetcher
    this.idleIntervalMs = Math.max(1, Number(options.idleIntervalMs) || 60_000)
    this.activeIntervalMs = Math.max(1, Number(options.activeIntervalMs) || 5_000)
    this.activeIdleTimeoutMs = Math.max(1, Number(options.activeIdleTimeoutMs) || 30_000)
    this.logger = options.logger ?? {}
    this.timers = options.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval }
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.snapshot = INITIAL_MIRROR_SNAPSHOT
    this.subscribers = new Set()
    this.idleSinks = new Set()
    this.activeConsumers = 0
    this.activeAcquiredAt = null
    this.lastPokeAt = null
    this.idleTimedOut = false
    this.idleTimer = null
    this.timer = null
    this.inFlight = false
    this.stopped = false
    this.controller = typeof AbortController === 'function' ? new AbortController() : null
    this.getSnapshot = () => this.snapshot
    this.subscribe = (callback) => this.addSubscriber(callback)
  }

  addSubscriber(callback) {
    this.subscribers.add(callback)
    if (this.subscribers.size === 1) this.startPolling()
    return () => {
      this.subscribers.delete(callback)
      if (this.subscribers.size === 0) this.stopPolling()
    }
  }

  startPolling() {
    void this.refresh()
    this.rescheduleTimer()
  }

  stopPolling() {
    this.clearTimer()
  }

  /** 注册高频消费者；返回幂等 release。 */
  acquireActive() {
    this.activeConsumers += 1
    if (this.activeConsumers === 1) {
      this.activeAcquiredAt = this.now()
      this.lastPokeAt = null
    }
    this.idleTimedOut = false
    this.resetIdleTimer()
    this.rescheduleTimer()
    let released = false
    return () => {
      if (released) return
      released = true
      this.activeConsumers = Math.max(0, this.activeConsumers - 1)
      if (this.activeConsumers === 0) {
        this.idleTimedOut = false
        this.activeAcquiredAt = null
        this.lastPokeAt = null
        this.clearIdleTimer()
      }
      this.rescheduleTimer()
    }
  }

  /** 报告用户交互；refcount=0 或已 dispose 时 no-op。 */
  pokeActive() {
    if (this.stopped || this.activeConsumers === 0) return
    this.lastPokeAt = this.now()
    if (!this.idleTimedOut) { this.resetIdleTimer(); return }
    this.idleTimedOut = false
    this.resetIdleTimer()
    this.rescheduleTimer()
  }

  /** 是否处于空闲降级态（供重算轮询等消费者降频）。 */
  isIdle() {
    return this.idleTimedOut
  }

  /**
   * 订阅空闲降级事件（用于 Auditor 统计“打开后多久走开”）。
   * @param {(event: {at:number, timeoutMs:number, acquiredAt:number, lastPokeAt:number|null,
   *   idleAfterMs:number, totalActiveMs:number, activeConsumers:number}) => void} sink
   * @returns {() => void} unsubscribe
   */
  onIdleDowngraded(sink) {
    if (typeof sink !== 'function') throw new TypeError('onIdleDowngraded: sink must be a function')
    this.idleSinks.add(sink)
    return () => { this.idleSinks.delete(sink) }
  }

  /** 当前有效轮询间隔（诊断/测试用）。 */
  currentIntervalMs() {
    return this.activeConsumers > 0 && !this.idleTimedOut ? this.activeIntervalMs : this.idleIntervalMs
  }

  /** 当前交互超时（毫秒）。 */
  getActiveIdleTimeout() {
    return this.activeIdleTimeoutMs
  }

  /**
   * 运行时调整“无交互降级”超时（设置面板 15/30/60s）。
   * - 无活跃消费者：只记录，下次 acquireActive 生效；
   * - 已降级：视为用户回来操作，恢复高频并重建 idleTimer；
   * - 活跃未降级：只重建 idleTimer（不重建轮询 timer，避免推迟下一次轮询）。
   * @param {number} ms
   */
  setActiveIdleTimeout(ms) {
    const next = Number(ms)
    if (!Number.isFinite(next) || next < 1) throw new RangeError('invalid activeIdleTimeoutMs')
    if (next === this.activeIdleTimeoutMs) return
    this.activeIdleTimeoutMs = next
    if (this.stopped || this.activeConsumers === 0) return
    if (this.idleTimedOut) {
      this.idleTimedOut = false
      this.rescheduleTimer()
    }
    this.resetIdleTimer()
  }

  async refresh(options = {}) {
    if (this.stopped || this.inFlight) return
    if (this.controller !== null && this.controller.signal.aborted) return
    this.inFlight = true
    this.update({ loading: true })
    try {
      const result = await this.fetcher({
        force: options.force === true,
        signal: this.controller === null ? undefined : this.controller.signal,
      })
      if (this.stopped || (this.controller !== null && this.controller.signal.aborted)) return
      if (result.notModified === true) {
        this.update({ loading: false, error: null, lastUpdatedAt: this.now() })
      } else if (result.status !== null && result.status !== undefined) {
        this.update({ status: result.status, loading: false, error: null, lastUpdatedAt: this.now() })
      }
    } catch (error) {
      if (this.stopped || (this.controller !== null && this.controller.signal.aborted)) return
      this.logger.warn?.('[mirror-status] refresh failed', {
        error: String(error instanceof Error ? error.message : error),
      })
      this.update({ loading: false, error: String(error instanceof Error ? error.message : error) })
    } finally {
      this.inFlight = false
    }
  }

  dispose() {
    this.stopped = true
    this.clearTimer()
    this.clearIdleTimer()
    if (this.controller !== null) this.controller.abort()
    this.subscribers.clear()
    this.idleSinks.clear()
  }

  // ── internals ────────────────────────────────────────────────────────────

  resetIdleTimer() {
    this.clearIdleTimer()
    if (this.stopped || this.activeConsumers === 0) return
    this.idleTimer = this.timers.setTimeout(() => { this.handleIdleTimeout() }, this.activeIdleTimeoutMs)
    this.idleTimer?.unref?.()
  }

  /** 降级发生：记录事件（真实走开时长 = now - lastPokeAt/acquiredAt）并通知订阅者。 */
  handleIdleTimeout() {
    this.idleTimer = null
    if (this.stopped || this.activeConsumers === 0) return
    const at = this.now()
    const acquiredAt = this.activeAcquiredAt ?? at
    const reference = this.lastPokeAt ?? acquiredAt
    const event = {
      at,
      timeoutMs: this.activeIdleTimeoutMs,
      acquiredAt,
      lastPokeAt: this.lastPokeAt,
      idleAfterMs: at - reference,
      totalActiveMs: at - acquiredAt,
      activeConsumers: this.activeConsumers,
    }
    this.idleTimedOut = true
    this.rescheduleTimer()
    this.logger.warn?.('[mirror-status] active consumer idle, downgrading to idle interval', {
      idleIntervalMs: this.idleIntervalMs, idleAfterMs: event.idleAfterMs,
    })
    for (const sink of [...this.idleSinks]) {
      try { sink(event) } catch { /* 订阅者异常隔离 */ }
    }
  }

  clearIdleTimer() {
    if (this.idleTimer !== null) {
      this.timers.clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  rescheduleTimer() {
    if (this.stopped || this.subscribers.size === 0) return
    this.clearTimer()
    this.timer = this.timers.setInterval(() => { void this.refresh() }, this.currentIntervalMs())
    this.timer?.unref?.()
  }

  clearTimer() {
    if (this.timer !== null) {
      this.timers.clearInterval(this.timer)
      this.timer = null
    }
  }

  update(patch) {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const callback of [...this.subscribers]) {
      try { callback() } catch { /* 订阅者异常隔离 */ }
    }
  }
}

export const _internals = Object.freeze({ INITIAL_MIRROR_SNAPSHOT })
