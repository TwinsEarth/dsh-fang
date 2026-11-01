// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// ForkClient 单测（契约：docs/FORK-CLIENT.md）：
//   commandId 幂等、inflight 追踪、command-done 匹配、超时兜底、
//   SSE 断开保留 / session 变化清空 / 主动断开清空、事件隔离。
import test from 'node:test'
import assert from 'node:assert/strict'

import { ForkClient, createForkClient } from '../src/lib/fork-client.mjs'

const tick = () => new Promise((resolve) => setImmediate(resolve))

/** 可编程的假传输层：记录 commands 调用、可手动 emit SSE 事件。 */
function makeTransport({ connectResult = { ok: true } } = {}) {
  const listeners = { event: new Set(), reconnect: new Set(), disconnect: new Set() }
  const state = {
    connectResult,
    commandsImpl: null,
    calls: [],
    lastState: { sessionId: 's-1', lastCursor: '0' },
    lastCursor: '0',
    stops: 0,
  }
  const transport = {
    get lastState() {
      return state.lastState
    },
    get lastCursor() {
      return state.lastCursor
    },
    get calls() {
      return state.calls
    },
    get stops() {
      return state.stops
    },
    setCommandsImpl(fn) {
      state.commandsImpl = fn
      return transport
    },
    setLastState(value) {
      state.lastState = value
    },
    setLastCursor(value) {
      state.lastCursor = String(value)
    },
    async connect() {
      return state.connectResult
    },
    async stop() {
      state.stops += 1
    },
    async commands(envelope) {
      state.calls.push(envelope)
      if (typeof state.commandsImpl === 'function') return state.commandsImpl(envelope)
      return { ok: true, status: 200, data: { ok: true, op: envelope.op, result: null, commandId: envelope.commandId } }
    },
    onEvent(fn) {
      listeners.event.add(fn)
      return () => listeners.event.delete(fn)
    },
    onReconnect(fn) {
      listeners.reconnect.add(fn)
      return () => listeners.reconnect.delete(fn)
    },
    onDisconnect(fn) {
      listeners.disconnect.add(fn)
      return () => listeners.disconnect.delete(fn)
    },
    emitEvent(event) {
      for (const fn of [...listeners.event]) fn({ cursor: '1', sessionId: 's-1', at: 1, event })
    },
    emitReconnect(payload) {
      for (const fn of [...listeners.reconnect]) fn(payload)
    },
    emitDisconnect(payload) {
      for (const fn of [...listeners.disconnect]) fn(payload)
    },
  }
  return transport
}

const accepted = (trackingId) => async (envelope) => ({
  ok: true,
  status: 202,
  data: { ok: true, status: 'accepted', trackingId, commandId: envelope.commandId, op: envelope.op, async: true },
})

test('同步命令直通：POST completed → 返回结果；同 commandId 命中缓存不重复 POST', async () => {
  const transport = makeTransport().setCommandsImpl(async () => ({
    ok: true,
    status: 200,
    data: { ok: true, op: 'ping', result: { pong: true }, commandId: 'cmd_1' },
  }))
  const client = createForkClient({ transport, asynchronousTimeoutMs: 1000 })
  await client.connect()

  const first = await client.command('ping', {}, { commandId: 'cmd_1' })
  assert.deepEqual(first.result, { pong: true })
  assert.equal(transport.calls.length, 1)
  assert.equal(client.getInflightCount(), 0)
  assert.deepEqual(transport.calls[0], { commandId: 'cmd_1', op: 'ping', payload: {} }, '同步命令不带 async 标记')

  const again = await client.command('ping', {}, { commandId: 'cmd_1' })
  assert.deepEqual(again, first)
  assert.equal(transport.calls.length, 1, 'completed 命中不得重复 POST')
  await client.disconnect()
})

test('异步命令：202 accepted → 等 command-done → 缓存终态结果', async () => {
  const transport = makeTransport().setCommandsImpl(accepted('t-1'))
  const client = createForkClient({ transport, asynchronousTimeoutMs: 1000 })
  await client.connect()

  const pending = client.command('status', {}, { commandId: 'cmd_async', async: true })
  await tick()
  assert.equal(client.getInflightCount(), 1, '等待 command-done 期间 inflight 必须存在')
  assert.equal(transport.calls[0].async, true)

  transport.emitEvent({ kind: 'command-done', trackingId: 't-1', op: 'status', result: { ok: true, op: 'status', result: { x: 1 } } })
  const out = await pending
  assert.equal(out.result.x, 1)
  assert.equal(client.getInflightCount(), 0)

  const replay = await client.command('status', {}, { commandId: 'cmd_async', async: true })
  assert.deepEqual(replay, out, '异步命令缓存的是终态结果，不是 accepted')
  assert.equal(transport.calls.length, 1)
  await client.disconnect()
})

test('异步命令超时：reject command-timeout、清 inflight、缓存移除可重试', async () => {
  const transport = makeTransport().setCommandsImpl(accepted('t-timeout'))
  const client = createForkClient({ transport, asynchronousTimeoutMs: 25 })
  await client.connect()

  await assert.rejects(
    client.command('status', {}, { commandId: 'cmd_timeout', async: true }),
    (error) => error.code === 'command-timeout',
  )
  assert.equal(client.getInflightCount(), 0)
  assert.equal(client.hasCachedCommand('cmd_timeout'), false, '超时必须移除缓存，重试才能重新执行')

  const retry = client.command('status', {}, { commandId: 'cmd_timeout', async: true })
  await tick()
  assert.equal(transport.calls.length, 2, '同一 commandId 重试应重新 POST')
  transport.emitEvent({ kind: 'command-done', trackingId: 't-timeout', op: 'status', result: { ok: true } })
  await retry
  await client.disconnect()
})

test('传输层失败不缓存：抛错后同一 commandId 重试会重新执行', async () => {
  let calls = 0
  const transport = makeTransport().setCommandsImpl(async () => {
    calls += 1
    if (calls === 1) {
      return { ok: false, status: 500, error: 'handler-threw', data: { ok: false, code: 'handler-threw' } }
    }
    return { ok: true, status: 200, data: { ok: true, op: 'ping', result: 'retry-ok' } }
  })
  const client = createForkClient({ transport, asynchronousTimeoutMs: 1000 })
  await client.connect()

  await assert.rejects(client.command('ping', {}, { commandId: 'cmd_err' }), (error) => error.code === 'handler-threw')
  assert.equal(client.hasCachedCommand('cmd_err'), false)
  const ok = await client.command('ping', {}, { commandId: 'cmd_err' })
  assert.equal(ok.result, 'retry-ok')
  assert.equal(calls, 2)
  await client.disconnect()
})

test('SSE 断开保留 inflight（等 cursor 补发），command-done 到达后 resolve', async () => {
  const transport = makeTransport().setCommandsImpl(accepted('t-reconnect'))
  const client = createForkClient({ transport, asynchronousTimeoutMs: 1000 })
  await client.connect()

  const pending = client.command('status', {}, { commandId: 'cmd_reconnect', async: true })
  await tick()
  transport.emitDisconnect({ reason: 'sse-closed', retryable: true })
  assert.equal(client.getInflightCount(), 1, '网络抖动不得清空 inflight')

  transport.emitEvent({ kind: 'command-done', trackingId: 't-reconnect', op: 'status', result: { ok: true } })
  await pending
  assert.equal(client.getInflightCount(), 0)
  await client.disconnect()
})

test('session 变化（resetCursor=true）→ inflight 全部 reject', async () => {
  const transport = makeTransport().setCommandsImpl(accepted('t-session'))
  const client = createForkClient({ transport, asynchronousTimeoutMs: 1000 })
  await client.connect()

  const pending = client.command('status', {}, { commandId: 'cmd_session', async: true })
  await tick()
  assert.equal(client.getInflightCount(), 1)
  transport.emitReconnect({ resetCursor: true, reason: 'session-changed' })
  await assert.rejects(pending, /session-changed/)
  assert.equal(client.getInflightCount(), 0, '分身重启后旧 command-done 不会再来')
  await client.disconnect()
})

test('主动 disconnect：reject 所有 inflight，并停止传输层（幂等）', async () => {
  const transport = makeTransport().setCommandsImpl(accepted('t-disc'))
  const client = createForkClient({ transport, asynchronousTimeoutMs: 1000 })
  await client.connect()

  const pending = client.command('status', {}, { commandId: 'cmd_disc', async: true })
  await tick()
  assert.equal(client.getInflightCount(), 1)
  await client.disconnect()
  await assert.rejects(pending, /client disconnected/)
  assert.equal(client.getInflightCount(), 0)
  assert.equal(transport.stops, 1)

  await client.disconnect() // 幂等
  assert.equal(transport.stops, 1)
})

test('stale command-done 静默忽略（debug 记录），不抛错', async () => {
  const logs = []
  const transport = makeTransport()
  const client = createForkClient({
    transport,
    asynchronousTimeoutMs: 1000,
    logger: { debug: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
  })
  await client.connect()
  transport.emitEvent({ kind: 'command-done', trackingId: 'nope', result: { ok: true } })
  assert.equal(client.getInflightCount(), 0)
  assert.ok(logs.some((line) => String(line[0]).includes('stale command-done')))
  await client.disconnect()
})

test('重复 trackingId：第二个 wait 直接 reject duplicate-tracking-id', async () => {
  const transport = makeTransport().setCommandsImpl(accepted('dup-tracking'))
  const client = createForkClient({ transport, asynchronousTimeoutMs: 1000 })
  await client.connect()

  const first = client.command('status', {}, { commandId: 'cmd_dup1', async: true })
  await tick()
  const second = client.command('status', {}, { commandId: 'cmd_dup2', async: true })
  await assert.rejects(second, (error) => error.code === 'duplicate-tracking-id')

  transport.emitEvent({ kind: 'command-done', trackingId: 'dup-tracking', op: 'status', result: { ok: true } })
  await first
  await client.disconnect()
})

test('事件扇出：handler 抛错隔离、state-changed 更新快照、回调都可取消', async () => {
  const transport = makeTransport()
  const client = createForkClient({ transport })
  await client.connect()

  const seen = []
  const offOne = client.onEvent(() => {
    throw new Error('handler-boom')
  })
  client.onEvent((envelope) => seen.push(envelope.event.kind))
  transport.emitEvent({ kind: 'approval-requested', approval: { approvalId: 'a1' } })
  assert.deepEqual(seen, ['approval-requested'], '第一个 handler 抛错不得影响第二个')

  transport.emitEvent({ kind: 'state-changed', snapshot: { sessionId: 's-2' } })
  assert.equal(client.getState().sessionId, 's-2')

  offOne()
  const reconnects = []
  const offReconnect = client.onReconnect((payload) => reconnects.push(payload))
  transport.emitReconnect({ resetCursor: false, reason: 'resumed' })
  assert.equal(reconnects.length, 1)
  offReconnect()

  let disconnected = 0
  client.onDisconnect(() => { disconnected += 1 })
  transport.emitDisconnect({ reason: 'network' })
  assert.equal(disconnected, 1)
  await client.disconnect()
})

test('connect 失败抛出带 code/fatal 的错误；未 connect 不能发命令', async () => {
  const failing = makeTransport({ connectResult: { ok: false, code: 'protocol-too-new', fatal: true } })
  const badClient = createForkClient({ transport: failing })
  await assert.rejects(badClient.connect(), (error) => error.code === 'protocol-too-new' && error.fatal === true)

  const transport = makeTransport()
  const client = createForkClient({ transport })
  await assert.rejects(client.command('ping'), /not connected|not-connected|commandId/)
  await client.disconnect()
})

test('参数边界：空 commandId / 空 op 直接 reject；nextCommandId 唯一', async () => {
  const transport = makeTransport()
  const client = createForkClient({ transport })
  await client.connect()

  await assert.rejects(client.commandWithId('', 'ping'), (error) => error.code === 'bad-command-id')
  await assert.rejects(client.runCommand('cmd_x', ''), (error) => error.code === 'missing-op')

  const a = client.nextCommandId()
  const b = client.nextCommandId()
  assert.notEqual(a, b)
  assert.match(a, /^cmd_\d+_[a-z0-9]+$/)
  await client.disconnect()
})

test('ForkClient 暴露 9 个 dsh-Fang op 的便捷方法（都走 runCommand/缓存）', async () => {
  const transport = makeTransport().setCommandsImpl(async (envelope) => ({
    ok: true,
    status: 200,
    data: { ok: true, op: envelope.op, result: { seen: envelope.payload }, commandId: envelope.commandId },
  }))
  const client = createForkClient({ transport })
  await client.connect()

  const calls = [
    client.ping({ n: 1 }),
    client.status(),
    client.flushBuffer({ strictMs: 10 }),
    client.scorePlugin({ pluginId: 'p' }),
    client.readPlugin({ pluginId: 'p' }),
    client.routeConfirm({ pluginId: 'p' }),
    client.approvals(),
    client.approvalDecide({ id: 'a1', outcome: 'approve' }),
    client.archive({}),
  ]
  const outs = await Promise.all(calls)
  assert.equal(outs.length, 9)
  assert.deepEqual(transport.calls.map((c) => c.op), [
    'ping', 'status', 'flush-buffer', 'score-plugin', 'read-plugin',
    'route-confirm', 'approvals', 'approval-decide', 'archive',
  ])
  assert.deepEqual(transport.calls[0].payload, { n: 1 })
  await client.disconnect()
})
