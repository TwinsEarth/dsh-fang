// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.8 — 空闲降级事件 + 审计聚合：事件字段、分组统计、建议阈值、快照语义。
import test from 'node:test'
import assert from 'node:assert/strict'

import { IdleAuditAggregator, IDLE_AUDIT_KIND, IDLE_AUDIT_SUMMARY_KIND } from '../src/lib/idle-audit.mjs'
import { MirrorStatusStore } from '../src/lib/status-store.mjs'

class FakeClock {
  constructor() {
    this.now = 0; this.seq = 1; this.timers = new Map()
    this.setTimeout = (fn, ms) => { const id = this.seq++; this.timers.set(id, { fn, at: this.now + ms, interval: null }); return id }
    this.setInterval = (fn, ms) => { const id = this.seq++; this.timers.set(id, { fn, at: this.now + ms, interval: ms }); return id }
    this.clearTimeout = (id) => this.timers.delete(id)
    this.clearInterval = (id) => this.timers.delete(id)
  }
  async advance(ms) {
    const target = this.now + ms
    for (;;) {
      let next = null
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && (next === null || timer.at < next.timer.at)) next = { id, timer }
      }
      if (next === null) break
      this.now = next.timer.at
      if (next.timer.interval !== null) next.timer.at = this.now + next.timer.interval
      else this.timers.delete(next.id)
      next.timer.fn()
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    }
    this.now = target
    await Promise.resolve(); await Promise.resolve()
  }
}

function makeStore(options = {}) {
  const clock = new FakeClock()
  const store = new MirrorStatusStore({
    fetcher: async () => ({ status: null, notModified: true }),
    timers: clock, now: () => clock.now,
    idleIntervalMs: 60_000, activeIntervalMs: 5_000, activeIdleTimeoutMs: 30_000,
    ...options,
  })
  return { store, clock }
}

function makeEvent(over = {}) {
  return {
    at: 60_000, timeoutMs: 30_000, acquiredAt: 0, lastPokeAt: 30_000,
    idleAfterMs: 30_000, totalActiveMs: 60_000, activeConsumers: 1, ...over,
  }
}

test('idle event: poke 后降级字段正确（idleAfterMs 从最后一次交互起算）', async () => {
  const { store, clock } = makeStore()
  const events = []
  store.onIdleDowngraded((event) => events.push(event))
  store.subscribe(() => {})
  await clock.advance(0)
  store.acquireActive()
  await clock.advance(10_000)
  store.pokeActive()
  await clock.advance(30_000)
  assert.equal(events.length, 1)
  assert.equal(events[0].timeoutMs, 30_000)
  assert.equal(events[0].lastPokeAt, 10_000)
  assert.ok(events[0].idleAfterMs >= 30_000)
  assert.ok(events[0].idleAfterMs < 31_000)
  assert.ok(events[0].totalActiveMs >= 40_000)
  assert.equal(events[0].activeConsumers, 1)
  assert.equal(store.isIdle(), true)
  store.dispose()
})

test('idle event: 无 poke 时从 acquire 起算；release 不触发；unsubscribe/dispose 生效', async () => {
  const { store, clock } = makeStore({ activeIdleTimeoutMs: 15_000 })
  const events = []
  const unsubscribe = store.onIdleDowngraded((event) => events.push(event))
  store.subscribe(() => {})
  await clock.advance(0)
  store.acquireActive()
  await clock.advance(15_000)
  assert.equal(events[0].lastPokeAt, null)
  assert.ok(events[0].idleAfterMs >= 15_000)

  store.dispose()
  unsubscribe()
  await clock.advance(20_000)
  assert.equal(events.length, 1)
})

test('idle event: 多个 sink 都收到；单个 sink 抛错隔离', async () => {
  const { store, clock } = makeStore({ activeIdleTimeoutMs: 15_000 })
  let a = 0; let b = 0
  store.onIdleDowngraded(() => { a += 1 })
  store.onIdleDowngraded(() => { throw new Error('boom') })
  store.onIdleDowngraded(() => { b += 1 })
  store.subscribe(() => {})
  await clock.advance(0)
  store.acquireActive()
  await clock.advance(15_000)
  assert.equal(a, 1)
  assert.equal(b, 1)
  store.dispose()
})

test('audit: 单条事件写入 kind/字段', () => {
  const records = []
  const aggregator = new IdleAuditAggregator({ record: (payload) => { records.push(payload) } })
  aggregator.asSink()(makeEvent())
  assert.equal(records.length, 1)
  assert.equal(records[0].kind, IDLE_AUDIT_KIND)
  assert.equal(records[0].idleAfterMs, 30_000)
  assert.equal(records[0].totalActiveMs, 60_000)
})

test('audit: summary 按 timeout 分组 + rapid/full 统计 + 建议', () => {
  const aggregator = new IdleAuditAggregator({ record: () => {}, minSamplesForRecommendation: 4 })
  const sink = aggregator.asSink()
  // 4 条：2 个 15s 档（一条 rapid、一条 full），2 个 30s 档
  sink(makeEvent({ timeoutMs: 15_000, idleAfterMs: 3_000, totalActiveMs: 10_000 }))
  sink(makeEvent({ timeoutMs: 15_000, idleAfterMs: 15_000, totalActiveMs: 20_000 }))
  sink(makeEvent({ timeoutMs: 30_000, idleAfterMs: 30_000, totalActiveMs: 40_000 }))
  sink(makeEvent({ timeoutMs: 30_000, idleAfterMs: 8_000, totalActiveMs: 12_000 }))
  const summary = aggregator.computeSummary()
  assert.equal(summary.totalEvents, 4)
  assert.equal(summary.byTimeout[15_000].count, 2)
  assert.equal(summary.byTimeout[15_000].avgIdleAfterMs, 9_000)
  assert.equal(summary.byTimeout[30_000].count, 2)
  assert.equal(summary.rapidAwayCount, 2)
  assert.equal(summary.fullTimeoutCount, 2)
  assert.equal(summary.recommendation, null) // 50% rapid / 50% full 都不超阈值
})

test('audit: 样本不足不给建议；多数 rapid → 降默认；多数 full → 提默认', () => {
  const small = new IdleAuditAggregator({ record: () => {}, minSamplesForRecommendation: 10 })
  for (let i = 0; i < 5; i += 1) small.asSink()(makeEvent({ idleAfterMs: 1_000 }))
  assert.equal(small.computeSummary().recommendation, null)

  const rapid = new IdleAuditAggregator({ record: () => {}, minSamplesForRecommendation: 10 })
  for (let i = 0; i < 10; i += 1) rapid.asSink()(makeEvent({ timeoutMs: 30_000, idleAfterMs: 3_000 }))
  assert.match(rapid.computeSummary().recommendation, /降到 15 秒/)

  const full = new IdleAuditAggregator({ record: () => {}, minSamplesForRecommendation: 10 })
  for (let i = 0; i < 10; i += 1) full.asSink()(makeEvent({ timeoutMs: 30_000, idleAfterMs: 30_000 }))
  assert.match(full.computeSummary().recommendation, /提高到 60 秒/)
})

test('audit: publishSnapshot 聚合后清空，空窗口不发', async () => {
  const records = []
  const aggregator = new IdleAuditAggregator({ record: (payload) => { records.push(payload) }, now: () => 123 })
  aggregator.asSink()(makeEvent({ at: 10 }))
  aggregator.asSink()(makeEvent({ at: 20 }))
  const summary = await aggregator.publishSnapshot()
  assert.equal(summary.totalEvents, 2)
  const record = records.find((item) => item.kind === IDLE_AUDIT_SUMMARY_KIND)
  assert.ok(record)
  assert.equal(record.windowStart, 10)
  assert.equal(record.windowEnd, 20)
  assert.equal(await aggregator.publishSnapshot(), null)
})
