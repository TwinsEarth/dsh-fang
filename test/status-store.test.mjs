// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.8 — MirrorStatusStore：订阅计数 / 轮询间隔 / 交互空闲降级 / 超时可配置。
import test from 'node:test'
import assert from 'node:assert/strict'

import { MirrorStatusStore, INITIAL_MIRROR_SNAPSHOT } from '../src/lib/status-store.mjs'

function makeStatus(version = '3.0.8') {
  return {
    ok: true, currentVersion: version, officialLatest: null, updateAvailable: false,
    meta: { version, backupIntervalHours: 24, lastBackupAt: null, nextBackupAt: null },
    backups: [], activeEssenceCount: 0, activeSessionCount: 0, diskUsageBytes: 0,
  }
}

class FakeClock {
  constructor() {
    this.now = 0
    this.seq = 1
    this.timers = new Map()
    this.setTimeout = this.setTimeout.bind(this)
    this.clearTimeout = this.clearTimeout.bind(this)
    this.setInterval = this.setInterval.bind(this)
    this.clearInterval = this.clearInterval.bind(this)
  }
  setTimeout(fn, ms) { const id = this.seq++; this.timers.set(id, { fn, at: this.now + ms, interval: null }); return id }
  setInterval(fn, ms) { const id = this.seq++; this.timers.set(id, { fn, at: this.now + ms, interval: ms }); return id }
  clearTimeout(id) { this.timers.delete(id) }
  clearInterval(id) { this.timers.delete(id) }
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
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  }
}

function makeStore(options = {}) {
  const clock = new FakeClock()
  let calls = 0
  const store = new MirrorStatusStore({
    fetcher: async () => { calls += 1; return { status: makeStatus(), notModified: false } },
    timers: clock,
    now: () => clock.now,
    idleIntervalMs: 60_000,
    activeIntervalMs: 5_000,
    activeIdleTimeoutMs: 30_000,
    ...options,
  })
  return { store, clock, calls: () => calls }
}

test('store: 初始快照稳定，订阅前不轮询', () => {
  const { store, clock } = makeStore()
  assert.equal(store.getSnapshot(), INITIAL_MIRROR_SNAPSHOT)
  assert.equal(store.getSnapshot(), store.getSnapshot())
  store.dispose()
})

test('store: 无活跃消费者 → idle 间隔（60s）', async () => {
  const { store, clock, calls } = makeStore()
  store.subscribe(() => {})
  await clock.advance(0)
  const base = calls()
  await clock.advance(30_000)
  assert.equal(calls(), base)
  await clock.advance(30_000)
  assert.equal(calls(), base + 1)
  store.dispose()
})

test('store: acquireActive → 5s 间隔；release → 立即回 idle', async () => {
  const { store, clock, calls } = makeStore()
  store.subscribe(() => {})
  await clock.advance(0)
  const base = calls()
  const release = store.acquireActive()
  await clock.advance(5_000)
  assert.equal(calls(), base + 1)
  release()
  const afterRelease = calls()
  await clock.advance(10_000)
  assert.equal(calls(), afterRelease)
  store.dispose()
})

test('store: 30s 无交互 → 降级；poke 重置计时器；降级后 poke 恢复高频', async () => {
  const { store, clock, calls } = makeStore()
  store.subscribe(() => {})
  await clock.advance(0)
  store.acquireActive()
  await clock.advance(20_000)
  store.pokeActive()               // 交互：空闲起点后移
  const before = calls()
  await clock.advance(25_000)      // 距 poke 25s：仍高频
  assert.ok(calls() > before)
  store.pokeActive()
  await clock.advance(35_000)      // 距 poke 35s：已降级（idle 60s 内无请求）
  const afterDowngrade = calls()
  await clock.advance(20_000)
  assert.equal(calls(), afterDowngrade)
  store.pokeActive()               // 降级后交互 → 恢复高频
  await clock.advance(5_000)
  assert.equal(calls(), afterDowngrade + 1)
  store.dispose()
})

test('store: 两个消费者 + release 幂等', async () => {
  const { store, clock, calls } = makeStore()
  store.subscribe(() => {})
  await clock.advance(0)
  const base = calls()
  const r1 = store.acquireActive()
  const r2 = store.acquireActive()
  r1(); r1()                       // 幂等
  await clock.advance(5_000)
  assert.equal(calls(), base + 1)  // 仍有 r2 → 高频
  r2()
  const after = calls()
  await clock.advance(10_000)
  assert.equal(calls(), after)
  store.dispose()
})

test('store: pokeActive 在 refcount=0 时 no-op', async () => {
  const { store, clock, calls } = makeStore()
  store.subscribe(() => {})
  await clock.advance(0)
  const base = calls()
  store.pokeActive()
  await clock.advance(10_000)
  assert.equal(calls(), base)
  store.dispose()
})

test('store: setActiveIdleTimeout — 无消费者只记录；活跃时缩短提前降级', async () => {
  const { store, clock, calls } = makeStore()
  store.subscribe(() => {})
  await clock.advance(0)
  store.setActiveIdleTimeout(15_000)
  assert.equal(store.getActiveIdleTimeout(), 15_000)
  store.acquireActive()
  const base = calls()
  await clock.advance(15_000)      // 到达新超时
  const beforeIdle = calls()
  assert.ok(beforeIdle >= base + 2) // 降级前至少跑了 2 次高频轮询
  await clock.advance(10_000)      // 已降级：idle 60s 内无请求
  assert.equal(calls(), beforeIdle)
  store.dispose()
})

test('store: setActiveIdleTimeout — 延长超时延后降级', async () => {
  const { store, clock, calls } = makeStore({ activeIdleTimeoutMs: 15_000 })
  store.subscribe(() => {})
  await clock.advance(0)
  store.acquireActive()
  await clock.advance(10_000)
  store.setActiveIdleTimeout(60_000)
  const base = calls()
  await clock.advance(10_000)      // 距 set 10s，仍高频
  assert.ok(calls() > base)
  store.dispose()
})

test('store: 已降级时 setActiveIdleTimeout 恢复高频', async () => {
  const { store, clock, calls } = makeStore({ activeIdleTimeoutMs: 15_000 })
  store.subscribe(() => {})
  await clock.advance(0)
  store.acquireActive()
  await clock.advance(16_000)      // 降级
  const base = calls()
  store.setActiveIdleTimeout(30_000)
  await clock.advance(5_000)
  assert.equal(calls(), base + 1)
  store.dispose()
})

test('store: 相同超时值 no-op；非法值抛错', () => {
  const { store } = makeStore()
  store.subscribe(() => {})
  const timer = store.idleTimer
  store.setActiveIdleTimeout(30_000)
  assert.equal(store.idleTimer, timer)
  assert.throws(() => store.setActiveIdleTimeout(0), /invalid activeIdleTimeoutMs/)
  store.dispose()
})

test('store: 304 只更新 lastUpdatedAt，不替换 status 引用', async () => {
  const clock = new FakeClock()
  const store = new MirrorStatusStore({
    fetcher: async () => ({ status: null, notModified: true }),
    timers: clock, now: () => clock.now,
    idleIntervalMs: 60_000, activeIntervalMs: 5_000,
  })
  store.subscribe(() => {})
  await clock.advance(0)
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.status, null)
  assert.equal(typeof snapshot.lastUpdatedAt, 'number')
  store.dispose()
})

test('store: dispose 清理定时器与订阅', async () => {
  const { store, clock, calls } = makeStore()
  store.subscribe(() => {})
  await clock.advance(0)
  store.acquireActive()
  const base = calls()
  store.dispose()
  await clock.advance(120_000)
  assert.equal(calls(), base)
})
