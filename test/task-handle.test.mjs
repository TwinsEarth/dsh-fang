// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// TaskHandle 单测（契约：docs/TASK-HANDLE.md）：
//   启动链（spawn + token + connect）、崩溃重连（新 token/新端口）、命令短等待、
//   stop/recycle 生命周期、事件聚合、幂等。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createBus } from '../src/kernel/core.mjs'
import { TaskHandle, TASK_HANDLE_STATE } from '../src/lib/task-handle.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const task = (h) => h.state
const status = (h) => h.state

function makeForker({ running = false, url = 'http://127.0.0.1:18000/?token=web-token-1', token = 'adapter-token-1' } = {}) {
  const state = {
    running,
    url,
    token,
    pid: 111,
    spawnCalls: 0,
    stopCalls: 0,
    reapCalls: 0,
    spawnImpl: null,
    stopImpl: null,
    reapImpl: null,
  }
  const forker = {
    state,
    status(id) {
      return { forkId: id, running: state.running, pid: state.pid, port: 18000, url: state.url }
    },
    adapterToken() {
      return state.token
    },
    async spawn(args) {
      state.spawnCalls += 1
      if (state.spawnImpl) return state.spawnImpl(args)
      state.running = true
      return { forkId: args.forkId, ok: true, url: state.url }
    },
    async stop() {
      state.stopCalls += 1
      if (state.stopImpl) return state.stopImpl()
      state.running = false
      return { ok: true }
    },
    async reap() {
      state.reapCalls += 1
      if (state.reapImpl) return state.reapImpl()
      state.running = false
      return { ok: true }
    },
  }
  return { forker, state }
}

function makeClients() {
  const clients = []
  const factory = (opts) => {
    const handlers = { event: new Set(), reconnect: new Set(), disconnect: new Set() }
    const client = {
      opts,
      connects: 0,
      disconnects: 0,
      commands: [],
      failConnect: false,
      async connect() {
        client.connects += 1
        if (client.failConnect) throw new Error('connect failed')
        return { ok: true }
      },
      async disconnect() {
        client.disconnects += 1
      },
      async command(op, payload, options) {
        client.commands.push({ op, payload, options })
        return { ok: true, op, result: payload }
      },
      getState() {
        return { sessionId: 's-1', lastCursor: '0' }
      },
      getCursor() {
        return '0'
      },
      getInflightCount() {
        return 0
      },
      onEvent(fn) {
        handlers.event.add(fn)
        return () => handlers.event.delete(fn)
      },
      onReconnect(fn) {
        handlers.reconnect.add(fn)
        return () => handlers.reconnect.delete(fn)
      },
      onDisconnect(fn) {
        handlers.disconnect.add(fn)
        return () => handlers.disconnect.delete(fn)
      },
      emitEvent(envelope) {
        for (const fn of [...handlers.event]) fn(envelope)
      },
      emitReconnect(payload) {
        for (const fn of [...handlers.reconnect]) fn(payload)
      },
      emitDisconnect(payload) {
        for (const fn of [...handlers.disconnect]) fn(payload)
      },
    }
    clients.push(client)
    return client
  }
  return { factory, clients }
}

function makeHarness(options = {}) {
  const eventSource = createBus()
  const { forker, state } = makeForker({ running: options.running === true })
  const { factory, clients } = makeClients()
  const handle = new TaskHandle({
    taskId: 'task_1',
    forker,
    createClient: factory,
    ...(options.spawnOptions === undefined ? {} : { spawnOptions: options.spawnOptions }),
    eventSource,
    commandWaitMs: options.commandWaitMs ?? 60,
    restartTimeoutMs: options.restartTimeoutMs ?? 200,
    pollMs: 10,
    logger: { debug() {}, warn() {} },
  })
  const taskEvents = []
  handle.onTaskEvent((e) => taskEvents.push(e))
  return { handle, forker, state, clients, eventSource, taskEvents }
}

test('start：spawn → 用 forker token 建 client → running', async () => {
  const h = makeHarness({ spawnOptions: { homeDir: 'H' } })
  await h.handle.start()
  assert.equal(status(h.handle), 'running')
  assert.equal(h.state.spawnCalls, 1)
  assert.equal(h.clients.length, 1)
  assert.equal(h.clients[0].connects, 1)
  assert.equal(h.clients[0].opts.adapterToken, 'adapter-token-1')
  assert.match(h.clients[0].opts.url, /token=web-token-1/)
  assert.equal(h.handle.taskMeta.pid, 111)
  await h.handle.stop()
})

test('start：fork 已在运行时不重复 spawn，直接连接', async () => {
  const h = makeHarness({ running: true })
  await h.handle.start()
  assert.equal(h.state.spawnCalls, 0)
  assert.equal(h.clients.length, 1)
  assert.equal(status(h.handle), 'running')
  await h.handle.stop()
})

test('start：spawn 失败 → failed + task 事件', async () => {
  const h = makeHarness({ spawnOptions: { homeDir: 'H' } })
  h.state.spawnImpl = async () => ({ ok: false, error: 'port-exhausted' })
  await assert.rejects(h.handle.start(), /spawn failed/)
  assert.equal(status(h.handle), 'failed')
  assert.ok(h.taskEvents.some((e) => e.kind === 'failed'))
})

test('start：token 缺失 → failed（fail-closed）', async () => {
  const h = makeHarness({ running: true })
  h.state.token = ''
  await assert.rejects(h.handle.start(), (error) => error.code === 'fork-token-missing')
  assert.equal(status(h.handle), 'failed')
})

test('start：connect 失败 → failed', async () => {
  const h = makeHarness({ running: true })
  const originalFactory = h.handle.createClient
  h.handle.createClient = (opts) => {
    const client = originalFactory(opts)
    client.failConnect = true
    return client
  }
  await assert.rejects(h.handle.start(), /connect failed/)
  assert.equal(status(h.handle), 'failed')
})

test('start 幂等：重复调用只 spawn/connect 一次', async () => {
  const h = makeHarness({ spawnOptions: { homeDir: 'H' } })
  const p1 = h.handle.start()
  const p2 = h.handle.start()
  await Promise.all([p1, p2])
  assert.equal(h.state.spawnCalls, 1)
  assert.equal(h.clients.length, 1)
  await h.handle.stop()
})

test('崩溃重连：用新端口/新 token 重建 client；等待中的命令恢复', async () => {
  const h = makeHarness({ running: true })
  await h.handle.start()
  const firstClient = h.clients[0]

  // 进程崩溃
  h.state.running = false
  h.eventSource.emit('fang/fork-crashed', { forkId: 'task_1', kind: 'crash' })
  await sleep(20)
  assert.equal(status(h.handle), 'reconnecting')
  assert.equal(firstClient.disconnects, 1, '崩溃时旧 client 断开')

  const pending = h.handle.ping()
  // Forker 重启：新 pid/token/port，随后广播 started
  h.state.running = true
  h.state.pid = 222
  h.state.token = 'adapter-token-2'
  h.state.url = 'http://127.0.0.1:18001/?token=web-token-2'
  await sleep(20)
  h.eventSource.emit('fang/fork-started', { forkId: 'task_1', pid: 222, port: 18001 })

  const result = await pending
  assert.equal(result.ok, true)
  assert.equal(status(h.handle), 'running')
  assert.equal(h.clients.length, 2)
  assert.equal(h.clients[1].opts.adapterToken, 'adapter-token-2')
  assert.match(h.clients[1].opts.url, /token=web-token-2/)
  assert.equal(h.handle.taskMeta.pid, 222)

  const kinds = h.taskEvents.map((e) => e.kind)
  assert.ok(kinds.includes('crashed'))
  assert.ok(kinds.includes('restarting'))
  assert.ok(kinds.includes('reconnected'))
  await h.handle.stop()
})

test('崩溃后重启超时 → failed，命令 reject task-failed', async () => {
  const h = makeHarness({ running: true, restartTimeoutMs: 40 })
  await h.handle.start()
  h.state.running = false
  h.eventSource.emit('fang/fork-crashed', { forkId: 'task_1', kind: 'crash' })
  await sleep(120)
  assert.equal(status(h.handle), 'failed')
  await assert.rejects(h.handle.ping(), (error) => error.code === 'task-failed')
})

test('stop：断开 client、forker.stop；幂等', async () => {
  const h = makeHarness({ running: true })
  await h.handle.start()
  await h.handle.stop()
  assert.equal(status(h.handle), 'stopped')
  assert.equal(h.clients[0].disconnects, 1)
  assert.equal(h.state.stopCalls, 1)
  await h.handle.stop()
  assert.equal(h.state.stopCalls, 1)
})

test('stop 时等待中的命令被 reject（task-stopping）', async () => {
  const h = makeHarness({ running: true })
  await h.handle.start()
  h.state.running = false
  h.eventSource.emit('fang/fork-crashed', { forkId: 'task_1', kind: 'crash' })
  await sleep(20)
  assert.equal(status(h.handle), 'reconnecting')
  const pending = h.handle.ping()
  await h.handle.stop()
  await assert.rejects(pending, (error) => error.code === 'task-stopping')
  assert.equal(status(h.handle), 'stopped')
})

test('recycle：stop + reap（删除 fork home）', async () => {
  const h = makeHarness({ running: true })
  await h.handle.start()
  const result = await h.handle.recycle()
  assert.equal(result.ok, true)
  assert.equal(h.state.stopCalls, 1)
  assert.equal(h.state.reapCalls, 1)
  assert.equal(status(h.handle), 'stopped')
})

test('SSE 断开不改变 TaskHandle 状态（进程仍在）', async () => {
  const h = makeHarness({ running: true })
  await h.handle.start()
  h.clients[0].emitDisconnect({ reason: 'network', retryable: true })
  assert.equal(status(h.handle), 'running')
  await h.handle.stop()
})

test('client 的 onReconnect 转发为 task 事件 reconnected', async () => {
  const h = makeHarness({ running: true })
  await h.handle.start()
  h.clients[0].emitReconnect({ resetCursor: true, reason: 'session-changed' })
  assert.ok(h.taskEvents.some((e) => e.kind === 'reconnected' && e.resetCursor === true))
  await h.handle.stop()
})

test('事件聚合：client SSE 事件转发给 onEvent，handler 异常隔离', async () => {
  const h = makeHarness({ running: true })
  await h.handle.start()
  const seen = []
  h.handle.onEvent(() => {
    throw new Error('handler-boom')
  })
  h.handle.onEvent((envelope) => seen.push(envelope.event.kind))
  h.clients[0].emitEvent({ cursor: '1', event: { kind: 'approval-requested' } })
  assert.deepEqual(seen, ['approval-requested'])
  await h.handle.stop()
})

test('命令代理：op/payload 透传，9 个便捷方法映射到 ADAPTER_OP', async () => {
  const h = makeHarness({ running: true })
  await h.handle.start()
  await h.handle.ping({ n: 1 })
  await h.handle.flushBuffer({ strictMs: 5 })
  await h.handle.approvalDecide({ id: 'a1', outcome: 'approve' })
  assert.deepEqual(h.clients[0].commands.map((c) => c.op), ['ping', 'flush-buffer', 'approval-decide'])
  assert.deepEqual(h.clients[0].commands[0].payload, { n: 1 })
  await h.handle.stop()
})

test('未启动 / 已停止时命令 fail-closed', async () => {
  const h = makeHarness({ running: true })
  await assert.rejects(h.handle.ping(), (error) => error.code === 'task-not-started')
  await h.handle.start()
  await h.handle.stop()
  await assert.rejects(h.handle.ping(), (error) => error.code === 'task-stopped')
})

test('dispose：释放订阅与 client，不杀 fork', async () => {
  const h = makeHarness({ running: true })
  await h.handle.start()
  await h.handle.dispose()
  assert.equal(status(h.handle), 'stopped')
  assert.equal(h.clients[0].disconnects, 1)
  assert.equal(h.state.stopCalls, 0, 'dispose 不调用 forker.stop')
  h.eventSource.emit('fang/fork-crashed', { forkId: 'task_1', kind: 'crash' })
  await sleep(20)
  assert.equal(status(h.handle), 'stopped')
})

// ── v2.7.3：事件驱动的重启结果（fail-fast / 非终态继续等 / taskId 过滤）────────

test('v2.7.3 事件：terminal restart-failed 立即 failed（不等 restartTimeoutMs）', async () => {
  const h = makeHarness({ running: true, restartTimeoutMs: 5000 })
  await h.handle.start()
  h.state.running = false
  h.eventSource.emit('fang/fork-crashed', { forkId: 'task_1', kind: 'crash' })
  await sleep(20)
  assert.equal(status(h.handle), 'reconnecting')

  const t0 = Date.now()
  h.eventSource.emit('fang/fork-restart-failed', { forkId: 'task_1', error: 'port-exhausted', terminal: true })
  await sleep(30)
  assert.equal(status(h.handle), 'failed')
  assert.ok(Date.now() - t0 < 1000, 'must fail fast instead of waiting restartTimeoutMs')
  assert.ok(h.taskEvents.some((e) => e.kind === 'failed'))

  await h.handle.stop()
  h.eventSource.emit('fang/fork-restart-failed', { forkId: 'task_1', error: 'late', terminal: true })
  await sleep(10)
  assert.equal(status(h.handle), 'stopped')
})

test('v2.7.3 事件：非 terminal restart-failed 不误判终态，后续 fork-started 恢复', async () => {
  const h = makeHarness({ running: true, restartTimeoutMs: 5000 })
  await h.handle.start()
  h.state.running = false
  h.eventSource.emit('fang/fork-crashed', { forkId: 'task_1', kind: 'crash' })
  await sleep(20)
  assert.equal(status(h.handle), 'reconnecting')

  h.eventSource.emit('fang/fork-restart-failed', { forkId: 'task_1', error: 'spawn-error', terminal: false })
  await sleep(20)
  assert.equal(status(h.handle), 'reconnecting', 'non-terminal failure must keep waiting')

  h.state.running = true
  h.state.pid = 222
  h.state.token = 'adapter-token-2'
  h.state.url = 'http://127.0.0.1:18001/?token=web-token-2'
  h.eventSource.emit('fang/fork-started', { forkId: 'task_1', pid: 222, port: 18001 })
  await sleep(30)
  assert.equal(status(h.handle), 'running')
  assert.equal(h.clients.length, 2, 'a new client is built for the restarted fork')
  await h.handle.stop()
})

test('v2.7.3 事件：taskId 不匹配的 restart-failed 被忽略', async () => {
  const h = makeHarness({ running: true, restartTimeoutMs: 5000 })
  await h.handle.start()
  h.state.running = false
  h.eventSource.emit('fang/fork-crashed', { forkId: 'task_1', kind: 'crash' })
  await sleep(20)
  assert.equal(status(h.handle), 'reconnecting')

  h.eventSource.emit('fang/fork-restart-failed', { forkId: 'task_other', error: 'x', terminal: true })
  await sleep(20)
  assert.equal(status(h.handle), 'reconnecting')
  await h.handle.stop()
})
