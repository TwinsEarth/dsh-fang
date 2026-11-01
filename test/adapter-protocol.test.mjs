// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// Adapter v3 协议库单测（契约：docs/PROTOCOL-V3.md §3/§6/§7/§8）。
// 只测纯函数：cursor 编解码、环形缓冲、幂等缓存、版本协商、SSE 帧、命令信封。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ADAPTER_PROTOCOL_MIN,
  ADAPTER_PROTOCOL_VERSION,
} from '../src/kernel/types.mjs'
import {
  CommandCache,
  DEFAULT_EVENT_CAPACITY,
  EventLog,
  RECONNECT_DEFAULTS,
  SSE_RETRY_FRAME,
  adapterError,
  createSseParser,
  formatCursor,
  negotiateProtocol,
  newCommandId,
  normalizeCommandEnvelope,
  parseBearer,
  parseCursor,
  sseComment,
  sseFrame,
  statusForAdapterError,
} from '../src/lib/adapter-protocol.mjs'

const envelopeOf = (event) => ({
  cursor: '1', sessionId: 's-test', at: 1700000000000, event,
})

test('1) cursor: uint64 十进制字符串 ↔ bigint，非法输入一律 null', () => {
  assert.equal(parseCursor('0'), 0n)
  assert.equal(parseCursor('42'), 42n)
  assert.equal(parseCursor(7), 7n)
  assert.equal(parseCursor(7n), 7n)
  assert.equal(parseCursor('18446744073709551615'), 18446744073709551615n, 'uint64 上界合法')
  assert.equal(parseCursor('18446744073709551616'), null, '超过 uint64 非法')

  for (const bad of ['', ' ', '-1', '1.5', '01', '0x10', 'abc', null, undefined, {}, [], 3.14, -1, NaN, Infinity]) {
    assert.equal(parseCursor(bad), null, `非法 cursor 必须返回 null: ${String(bad)}`)
  }

  assert.equal(formatCursor(0n), '0')
  assert.equal(formatCursor(42n), '42')
  assert.equal(formatCursor(9), '9')
  assert.equal(formatCursor(-3n), '0', '负数兜底为 0')
})

test('2) EventLog: 单调 cursor、容量裁剪、lastCursor/nextCursor', () => {
  const log = new EventLog({ capacity: 3, sessionId: 's-1', now: () => 100 })
  assert.equal(log.size, 0)
  assert.equal(log.lastCursor, '0', '空缓冲 lastCursor = 0')

  const a = log.append({ kind: 'state-changed' })
  assert.deepEqual(a, { cursor: '1', sessionId: 's-1', at: 100, event: { kind: 'state-changed' } })
  assert.equal(log.lastCursor, '1')
  assert.equal(log.nextCursor, '2')
  assert.equal(log.append({ kind: 'x' }).cursor, '2')
  assert.equal(log.append({ kind: 'y' }).cursor, '3')
  assert.equal(log.nextCursor, '4')

  // capacity=3：第 4 条挤掉最旧的 cursor=1
  log.append({ kind: 'z' })
  assert.equal(log.size, 3)
  assert.deepEqual(log.since('0').events.map((e) => e.cursor), ['2', '3', '4'])
})

test('3) EventLog.since: 从头/续传/gap/超前/非法 cursor', () => {
  const log = new EventLog({ capacity: 5, sessionId: 's-2' })
  for (let i = 1; i <= 5; i += 1) log.append({ kind: 'k', i })

  const all = log.since('0')
  assert.equal(all.ok, true)
  assert.equal(all.gap, false)
  assert.deepEqual(all.events.map((e) => e.cursor), ['1', '2', '3', '4', '5'])

  const tail = log.since('4')
  assert.deepEqual(tail.events.map((e) => e.cursor), ['5'])
  assert.equal(tail.gap, false, 'cursor=4 之后仍在缓冲内，不报 gap')

  const atOldest = log.since('1')
  assert.deepEqual(atOldest.events.map((e) => e.cursor), ['2', '3', '4', '5'])

  assert.equal(log.since('5').events.length, 0, '追平后没有新事件')

  const ahead = log.since('99')
  assert.equal(ahead.gap, true)
  assert.equal(ahead.reason, 'cursor-ahead')

  const invalid = log.since('nope')
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'cursor-invalid')
  assert.deepEqual(invalid.events, [])

  // 打断点：capacity=2 后最旧是 4，cursor=1 追不上 → gap
  const small = new EventLog({ capacity: 2 })
  for (let i = 1; i <= 5; i += 1) small.append({ kind: 'k', i })
  const gap = small.since('1')
  assert.equal(gap.gap, true, 'cursor 早于最旧一条必须 gap')
  assert.deepEqual(gap.events.map((e) => e.cursor), ['4', '5'])

  // 边界：cursor = oldest-1 仍然追得上（不报 gap）
  const edge = new EventLog({ capacity: 2 })
  for (let i = 1; i <= 3; i += 1) edge.append({ kind: 'k', i })
  assert.equal(edge.since('1').gap, false, 'cursor=oldest-1 恰好没有丢事件')
  assert.deepEqual(edge.since('1').events.map((e) => e.cursor), ['2', '3'])
  assert.equal(edge.since('0').gap, true, 'cursor=0 时最旧=2，已丢 1 条 → gap')

  assert.equal(DEFAULT_EVENT_CAPACITY, 1000)
})

test('4) EventLog: 非对象事件也安全；capacity 非法值兜底', () => {
  const log = new EventLog({ capacity: 0 })
  assert.equal(log.capacity, DEFAULT_EVENT_CAPACITY)
  const out = log.append('not-an-object')
  assert.equal(out.event.kind, 'error')
  assert.equal(log.since(0).events.length, 1)
})

test('5) CommandCache: 同一 commandId 重放第一次结果、LRU 淘汰、容量', () => {
  const cache = new CommandCache({ capacity: 2 })
  assert.equal(cache.get('cmd_a'), null)

  const first = { ok: true, op: 'ping', result: { pong: true } }
  cache.set('cmd_a', first)
  assert.equal(cache.has('cmd_a'), true)
  assert.deepEqual(cache.get('cmd_a'), first, '重复 commandId 返回缓存结果')

  cache.set('cmd_b', { ok: true, op: 'status' })
  cache.set('cmd_c', { ok: true, op: 'audit' }) // 淘汰 cmd_a
  assert.equal(cache.has('cmd_a'), false, 'LRU 淘汰最旧')
  assert.equal(cache.size, 2)

  cache.get('cmd_b') // 刷新 cmd_b 的 LRU 位置
  cache.set('cmd_d', { ok: true, op: 'approvals' }) // 淘汰 cmd_c
  assert.equal(cache.has('cmd_b'), true)
  assert.equal(cache.has('cmd_c'), false)

  assert.equal(cache.set('', { ok: true }), null, '空 commandId 不入缓存')
  cache.clear()
  assert.equal(cache.size, 0)
})

test('6) negotiateProtocol: 版本区间内通过，过旧/过新/非法拒绝', () => {
  assert.equal(ADAPTER_PROTOCOL_VERSION, 3)
  assert.equal(ADAPTER_PROTOCOL_MIN, 1)

  assert.deepEqual(negotiateProtocol(3), { ok: true, protocol: 3, min: 1, max: 3 })
  assert.deepEqual(negotiateProtocol('3'), { ok: true, protocol: 3, min: 1, max: 3 }, '字符串版本也接受')

  const tooNew = negotiateProtocol(4)
  assert.equal(tooNew.ok, false)
  assert.equal(tooNew.reason, 'protocol-too-new')

  const tooOld = negotiateProtocol(0.5)
  assert.equal(tooOld.ok, false)
  assert.equal(tooOld.reason, 'protocol-invalid')

  const older = negotiateProtocol(1, { min: 2, max: 3 })
  assert.equal(older.ok, false)
  assert.equal(older.reason, 'protocol-too-old')

  for (const bad of [undefined, null, 'x', NaN, {}, []]) {
    assert.equal(negotiateProtocol(bad).ok, false)
  }
})

test('7) parseBearer: 大小写/空格容错，非 Bearer 一律空串', () => {
  assert.equal(parseBearer('Bearer abc123'), 'abc123')
  assert.equal(parseBearer('bearer   abc123  '), 'abc123')
  assert.equal(parseBearer('BEARER tok'), 'tok')
  assert.equal(parseBearer('Basic abc'), '')
  assert.equal(parseBearer('Bearer'), '')
  assert.equal(parseBearer('Bearer a b'), '')
  assert.equal(parseBearer(''), '')
  assert.equal(parseBearer(undefined), '')
})

test('8) normalizeCommandEnvelope: op/payload/async/commandId 校验与嵌套命令', () => {
  const flat = normalizeCommandEnvelope({ commandId: 'cmd_1', op: 'ping', payload: { a: 1 } })
  assert.deepEqual(flat, { ok: true, commandId: 'cmd_1', op: 'ping', payload: { a: 1 }, async: false })

  const asyncCmd = normalizeCommandEnvelope({ op: 'flush-buffer', async: true })
  assert.equal(asyncCmd.async, true)

  const payloadAsync = normalizeCommandEnvelope({ op: 'flush-buffer', payload: { async: true } })
  assert.equal(payloadAsync.async, true)

  const nested = normalizeCommandEnvelope({ commandId: 'cmd_2', command: { kind: 'status', payload: {} } })
  assert.equal(nested.ok, true)
  assert.equal(nested.op, 'status')

  const noOp = normalizeCommandEnvelope({ commandId: 'cmd_3' })
  assert.equal(noOp.ok, false)
  assert.equal(noOp.code, 'missing-op')

  const badId = normalizeCommandEnvelope({ commandId: 'has space', op: 'ping' })
  assert.equal(badId.ok, false)
  assert.equal(badId.code, 'command-id-invalid')

  assert.equal(normalizeCommandEnvelope(null).ok, false, 'null 输入不抛')
})

test('9) 错误码 → HTTP 状态码映射（PROTOCOL-V3 §8）', () => {
  assert.equal(statusForAdapterError('bad-request'), 400)
  assert.equal(statusForAdapterError('cursor-invalid'), 400)
  assert.equal(statusForAdapterError('unauthorized'), 401)
  assert.equal(statusForAdapterError('not-found'), 404)
  assert.equal(statusForAdapterError('session-changed'), 409)
  assert.equal(statusForAdapterError('state-conflict'), 409)
  assert.equal(statusForAdapterError('cursor-expired'), 410)
  assert.equal(statusForAdapterError('handler-threw'), 500)
  assert.equal(statusForAdapterError('not-ready'), 503)
  assert.equal(statusForAdapterError('unregistered-code'), 500, '未登记 = 500，不假装成功')

  const failure = adapterError('bad-request', 'pluginId-required', { op: 'read-plugin' })
  assert.deepEqual(failure, { ok: false, code: 'bad-request', error: 'pluginId-required', op: 'read-plugin' })
})

test('10) SSE 帧编解码：id/event/data、注释心跳、跨 chunk 半帧、flush 残留', () => {
  const envelope = envelopeOf({ kind: 'command', op: 'ping', ok: true })
  const frame = sseFrame(envelope)
  assert.match(frame, /^id: 1\nevent: adapter\ndata: \{/)
  assert.ok(frame.endsWith('\n\n'))

  assert.equal(sseComment(), ': heartbeat\n\n')
  assert.equal(SSE_RETRY_FRAME, 'retry: 2000\n\n')

  const parser = createSseParser()
  // 一次给三条（含注释），再故意把第 4 条劈成两半
  const stream = sseComment('connected') + frame + sseFrame(envelopeOf({ kind: 'audit' }))
  const frames = parser.push(stream)
  assert.equal(frames.length, 2)
  assert.deepEqual(frames.map((f) => f.event), ['adapter', 'adapter'])
  assert.equal(frames[0].id, '1')
  assert.deepEqual(JSON.parse(frames[0].data).event, { kind: 'command', op: 'ping', ok: true })

  const fourth = sseFrame({ cursor: '3', sessionId: 's-test', at: 1, event: { kind: 'state-changed' } })
  const cut = Math.floor(fourth.length / 2)
  assert.deepEqual(parser.push(fourth.slice(0, cut)), [], '半帧不产出')
  const rest = parser.push(fourth.slice(cut))
  assert.equal(rest.length, 1)
  assert.equal(rest[0].id, '3')

  // 流结束但缓冲里还有半帧 → flush 也解析（容错），纯注释/空块不产出
  const tailParser = createSseParser()
  tailParser.push('id: 9\ndata: {"x":1}')
  const flushed = tailParser.flush()
  assert.equal(flushed.length, 1)
  assert.equal(flushed[0].id, '9')
  assert.deepEqual(tailParser.flush(), [], 'flush 幂等（第二次为空）')

  const commentOnly = createSseParser()
  assert.deepEqual(commentOnly.push(': heartbeat\n\n'), [])
  assert.equal(RECONNECT_DEFAULTS.baseMs, 500)
  assert.equal(RECONNECT_DEFAULTS.maxMs, 8000)
})

test('11) newCommandId: 唯一、可被 commandId 正则接受', () => {
  const a = newCommandId()
  const b = newCommandId()
  assert.notEqual(a, b)
  assert.match(a, /^cmd_[A-Za-z0-9._:-]+$/)
  assert.equal(normalizeCommandEnvelope({ commandId: a, op: 'ping' }).ok, true)
})
