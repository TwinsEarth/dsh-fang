// SPDX-License-Identifier: AGPL-3.0-or-later
// dsh-Fang v3.0.8 — 空闲降级审计聚合。
//
// MirrorStatusStore 在“活跃消费者 30s 无交互 → 降级”时发 ActiveIdleEvent；
// 本模块把事件写入 Auditor（单条 + 周期 summary），并从统计里生成 UI 优化建议：
//   * idleAfterMs = 降级时刻 - 最后一次交互（真实的“走开时长”）
//   * totalActiveMs = 降级时刻 - 首次 acquireActive（用户停留总时长）
// 样本不足（默认 <10）不给建议，避免小样本误导。

export const IDLE_AUDIT_KIND = 'mirror-idle-downgrade'
export const IDLE_AUDIT_SUMMARY_KIND = 'mirror-idle-downgrade-summary'

export class IdleAuditAggregator {
  /**
   * @param {{record: (payload: Record<string, unknown>) => (void|Promise<void>),
   *   minSamplesForRecommendation?: number, snapshotIntervalMs?: number,
   *   timers?: {setInterval: Function, clearInterval: Function}, now?: () => number}} options
   */
  constructor(options) {
    if (options === null || typeof options !== 'object' || typeof options.record !== 'function') {
      throw new Error('IdleAuditAggregator: record required')
    }
    this.record = options.record
    this.minSamples = Math.max(1, Math.floor(Number(options.minSamplesForRecommendation) || 10))
    this.snapshotIntervalMs = Math.max(1, Math.floor(Number(options.snapshotIntervalMs) || 300_000))
    this.timers = options.timers ?? { setInterval, clearInterval }
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.events = []
    this.rollingEvents = []
    this.rollingCapacity = Math.max(1, Math.floor(Number(options.rollingCapacity) || 500))
    this.snapshotTimer = null
    this.sink = (event) => { this.handle(event) }
  }

  /** 传给 MirrorStatusStore.onIdleDowngraded(sink)。 */
  asSink() {
    return this.sink
  }

  start() {
    this.stop()
    this.snapshotTimer = this.timers.setInterval(() => { void this.publishSnapshot() }, this.snapshotIntervalMs)
    this.snapshotTimer?.unref?.()
  }

  stop() {
    if (this.snapshotTimer !== null) {
      this.timers.clearInterval(this.snapshotTimer)
      this.snapshotTimer = null
    }
  }

  /** 基于滚动窗口（长期，最近 N 条）生成结构化建议；样本不足返回空数组。 */
  getRecommendations() {
    if (this.rollingEvents.length < this.minSamples) return []
    return this.buildRecommendations(this.rollingEvents)
  }

  /** 由事件数组生成结构化建议（fieldKey/suggestedValue/text/sampleCount/confidence）。 */
  buildRecommendations(events) {
    const total = events.length
    if (total === 0) return []
    let rapid = 0
    let full = 0
    for (const event of events) {
      if (event.idleAfterMs < event.timeoutMs * 0.3) rapid += 1
      if (event.idleAfterMs >= event.timeoutMs * 0.9) full += 1
    }
    const rapidRatio = rapid / total
    const fullRatio = full / total
    const recommendations = []
    if (rapidRatio > 0.5) {
      recommendations.push({
        fieldKey: 'activeIdleTimeoutMs',
        suggestedValue: 15_000,
        text: `超过一半（${(rapidRatio * 100).toFixed(0)}%）的对话框打开后很快走开，可考虑把交互超时降到 15 秒，减少无意义的高频轮询。`,
        sampleCount: total,
        confidence: rapidRatio,
      })
    }
    if (fullRatio > 0.8) {
      recommendations.push({
        fieldKey: 'activeIdleTimeoutMs',
        suggestedValue: 60_000,
        text: `${(fullRatio * 100).toFixed(0)}% 的用户活跃到超时窗口末尾，建议把交互超时提高到 60 秒，让状态刷新更实时。`,
        sampleCount: total,
        confidence: fullRatio,
      })
    }
    return recommendations
  }

  /** 发布聚合快照（无事件则不发）；发布后清空窗口。 */
  async publishSnapshot() {
    if (this.events.length === 0) return null
    const windowStart = this.events[0].at
    const windowEnd = this.events[this.events.length - 1].at
    const summary = this.computeSummary()
    this.events = []
    const payload = {
      kind: IDLE_AUDIT_SUMMARY_KIND,
      at: this.now(),
      windowStart,
      windowEnd,
      summary,
    }
    await this.record(payload)
    return summary
  }

  computeSummary() {
    const byTimeout = {}
    let rapidAway = 0
    let fullTimeout = 0
    for (const event of this.events) {
      const bucket = byTimeout[event.timeoutMs] ?? { count: 0, totalIdleAfterMs: 0, totalActiveMs: 0 }
      bucket.count += 1
      bucket.totalIdleAfterMs += event.idleAfterMs
      bucket.totalActiveMs += event.totalActiveMs
      byTimeout[event.timeoutMs] = bucket
      if (event.idleAfterMs < event.timeoutMs * 0.3) rapidAway += 1
      if (event.idleAfterMs >= event.timeoutMs * 0.9) fullTimeout += 1
    }
    for (const key of Object.keys(byTimeout)) {
      const bucket = byTimeout[key]
      bucket.avgIdleAfterMs = Math.round(bucket.totalIdleAfterMs / bucket.count)
      bucket.avgTotalActiveMs = Math.round(bucket.totalActiveMs / bucket.count)
      delete bucket.totalIdleAfterMs
      delete bucket.totalActiveMs
    }
    const recommendations = this.events.length >= this.minSamples ? this.buildRecommendations(this.events) : []
    return {
      totalEvents: this.events.length,
      byTimeout,
      rapidAwayCount: rapidAway,
      fullTimeoutCount: fullTimeout,
      recommendation: recommendations[0]?.text ?? null,
      recommendations,
    }
  }

  buildRecommendation(rapidAway, fullTimeout) {
    const total = this.events.length
    if (total < this.minSamples) return null
    const rapidRatio = rapidAway / total
    const fullRatio = fullTimeout / total
    if (rapidRatio > 0.5) {
      return `超过一半（${(rapidRatio * 100).toFixed(0)}%）的对话框打开后很快走开，建议把默认交互超时降到 15s 以减少无意义轮询。`
    }
    if (fullRatio > 0.8) {
      return `${(fullRatio * 100).toFixed(0)}% 的用户活跃到超时窗口末尾，建议把默认交互超时提高到 60s。`
    }
    return null
  }

  handle(event) {
    this.events.push(event)
    this.rollingEvents.push(event)
    if (this.rollingEvents.length > this.rollingCapacity) {
      this.rollingEvents.splice(0, this.rollingEvents.length - this.rollingCapacity)
    }
    const payload = {
      kind: IDLE_AUDIT_KIND,
      at: event.at,
      timeoutMs: event.timeoutMs,
      idleAfterMs: event.idleAfterMs,
      totalActiveMs: event.totalActiveMs,
      lastPokeAt: event.lastPokeAt,
      activeConsumers: event.activeConsumers,
    }
    try {
      const result = this.record(payload)
      if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
        result.catch(() => { /* 审计失败不影响 UI */ })
      }
    } catch { /* 审计失败不影响 UI */ }
  }
}
