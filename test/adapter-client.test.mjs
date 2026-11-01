// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// 母体侧 Adapter v3 客户端单测（docs/PROTOCOL-V3.md §5/§7/§9）。
// 注入假 fetch：不需要真实 socket，也不需要真正的分身进程。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createAdapterClient } from '../src/lib/adapter-client.mjs'
import { sseFrame } from '../src/lib/adapter-protocol.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const envelope = (cursor, event) => ({
  cursor: String(cursor),
  sessionId: 's-1',
  at: 1700000000000,
  event,
})

function jsonRes(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
  }
}

/** 一段立即收盘的 SSE 响应体。 */
function sseRes(frames, status = 200) {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
  return { ok: status >= 200 && status < 300, status, body }
}

test('connect: 版本协商 → 快照 → SSE，cursor 推进、事件/状态回调、Bearer 头', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const target = String(url)
    calls.push({ url: target, headers: init.headers ?? {} })
    if (target.includes('/adapter/version')) {
      return jsonRes({ ok: true, protocol: 3, sessionId: 's-1', version: '2.6.2' })
    }
    if (target.includes('/adapter/state')) {
      return jsonRes({ ok: true, sessionId: 's-1', lastCursor: '5', plugins: [] })
    }
    if (target.includes('/adapter/events')) {
      return sseRes([
        sseFrame(envelope(6, { kind: 'command', op: 'ping', ok: true })),
        sseFrame(envelope(7, { kind: 'approval-requested', approval: { approvalId: 'a1' } })),
      ])
    }
    throw new Error(`unexpected ${target}`)
  }

  const client = createAdapterClient({
    url: 'http://127.0.0.1:18000',
    token: 'web-token',
    adapterToken: 'adapter-token',
    fetchImpl,
    autoReconnect: false,
  })
  const events = []
  const states = []
  client.onEvent((e) => events.push(e))
  client.onState((s) => states.push(s))

  const connected = await client.connect()
  assert.equal(connected.ok, true)
  assert.equal(connected.protocol, 3)
  assert.equal(client.mode, 'streaming')
  assert.ok(Number(client.lastCursor) >= 5, '首帧快照的 cursor 已经生效')

  await client.pumpDone
  await sleep(10)
  assert.equal(client.lastCursor, '7')
  assert.equal(events.length, 2)
  assert.equal(events[0].event.kind, 'command')
  assert.equal(events[1].event.kind, 'approval-requested')
  assert.equal(states.length, 1)

  assert.equal(calls[0].headers.authorization, 'Bearer adapter-token', 'v3 请求带 Bearer')
  assert.ok(calls[0].url.includes('token=web-token'), 'DSH web token 仍走 ?token=')
  assert.ok(calls[2].url.includes('since=5'), '续流带 since=cursor')
  assert.ok(calls[2].url.includes('session=s-1'), '续流带 session')
  client.stop()
  assert.equal(client.mode, 'idle')
})

test('connect: 协议过新 → 拒绝并进入 failed（不拉快照、不订阅）', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return jsonRes({ ok: true, protocol: 99, sessionId: 's-1' })
  }
  const client = createAdapterClient({ url: 'http://x', fetchImpl, autoReconnect: false })
  const out = await client.connect()
  assert.equal(out.ok, false)
  assert.equal(out.code, 'protocol-too-new')
  assert.equal(client.mode, 'failed')
  assert.equal(calls, 1, '协商失败后不得继续请求快照/事件流')
  client.stop()
})

test('connect: 401 是致命失败（不重试，错误码可判定）', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ ok: false, code: 'unauthorized' }),
  })
  const client = createAdapterClient({
    url: 'http://x',
    fetchImpl,
    adapterToken: 'bad-token',
    reconnect: { baseMs: 1, maxMs: 2 },
  })
  const out = await client.connect()
  assert.equal(out.ok, false)
  assert.equal(out.fatal, true)
  assert.equal(out.code, 'unauthorized')
  assert.equal(client.mode, 'failed')
  assert.equal(client.lastError, 'unauthorized')
  client.stop()
})

test('SSE 409 session-changed：重置 cursor、重拉快照并自动续流', async () => {
  let stateCalls = 0
  let eventCalls = 0
  const reconnects = []
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('/adapter/version')) return jsonRes({ ok: true, protocol: 3, sessionId: 's-1' })
    if (target.includes('/adapter/state')) {
      stateCalls += 1
      return jsonRes({ ok: true, sessionId: 's-2', lastCursor: stateCalls === 1 ? '5' : '9' })
    }
    if (target.includes('/adapter/events')) {
      eventCalls += 1
      if (eventCalls === 1) return jsonRes({ ok: false, code: 'session-changed' }, 409)
      return sseRes([sseFrame(envelope(10, { kind: 'command', ok: true }))])
    }
    throw new Error(`unexpected ${target}`)
  }

  const client = createAdapterClient({
    url: 'http://x',
    fetchImpl,
    reconnect: { baseMs: 1, maxMs: 2 },
  })
  client.onReconnect((e) => reconnects.push(e))

  const out = await client.connect()
  assert.equal(out.ok, false)
  assert.equal(out.code, 'session-changed')
  assert.equal(out.retryable, true)
  assert.equal(stateCalls, 2, '409 后必须重新拉快照')

  await sleep(40)
  assert.equal(client.sessionId, 's-2')
  assert.equal(client.lastCursor, '10')
  assert.ok(
    reconnects.some((r) => r.resetCursor === true && r.reason === 'session-changed'),
    'onReconnect 必须带 resetCursor 让编排器清缓存',
  )
  client.stop()
})

test('command: 网络失败后用同一 commandId 重试（服务端幂等）', async () => {
  const bodies = []
  let calls = 0
  const fetchImpl = async (url, init = {}) => {
    calls += 1
    bodies.push(JSON.parse(String(init.body)))
    if (calls === 1) throw new TypeError('fetch failed')
    return jsonRes({ ok: true, op: 'ping', commandId: bodies[0].commandId, deduplicated: true, result: { pong: true } })
  }

  const client = createAdapterClient({ url: 'http://x', fetchImpl, reconnect: { baseMs: 1, maxMs: 2 } })
  const out = await client.command('ping', {}, { commandId: 'cmd_retry_1' })
  assert.equal(out.ok, true)
  assert.equal(out.data.deduplicated, true)
  assert.equal(bodies.length, 2)
  assert.equal(bodies[0].commandId, 'cmd_retry_1')
  assert.deepEqual(bodies[1], bodies[0], '重试必须复用同一 commandId 与 payload')
  client.stop()
})

test('command: 非网络类失败不重试（例如 400 参数错误）', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return jsonRes({ ok: false, code: 'missing-op' }, 400)
  }
  const client = createAdapterClient({ url: 'http://x', fetchImpl })
  const out = await client.command('', {}, { commandId: 'cmd_bad_1' })
  assert.equal(out.ok, false)
  assert.equal(out.status, 400)
  assert.equal(calls, 1)
  client.stop()
})

// ── v2.7.4：三步 connect 的可观测性（version 信息 / 协议区间 / session 一致性）──

test('connect: version 信息与协议区间可观测（lastVersionInfo / protocolRange）', async () => {
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('/adapter/version')) {
      return jsonRes({ ok: true, protocol: 3, sessionId: 's-1', version: '2.7.4', minProtocol: 1 })
    }
    if (target.includes('/adapter/state')) return jsonRes({ ok: true, sessionId: 's-1', lastCursor: '0', plugins: [] })
    if (target.includes('/adapter/events')) return sseRes([])
    throw new Error(`unexpected ${target}`)
  }
  const client = createAdapterClient({ url: 'http://x', fetchImpl, autoReconnect: false })
  const connected = await client.connect()
  assert.equal(connected.ok, true)
  assert.equal(connected.version.version, '2.7.4', 'connect 结果携带 version 响应')
  assert.equal(client.lastVersionInfo.protocol, 3)
  assert.equal(client.lastVersionInfo.sessionId, 's-1')
  assert.equal(client.protocolRange.min, 1)
  assert.equal(client.protocolRange.max, 3)
  assert.equal(connected.sessionMismatch, null)
  client.stop()
})

test('connect: version/state 的 sessionId 不一致 → 记录 sessionMismatch，仍用 state 的 session 续流', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    const target = String(url)
    calls.push(target)
    if (target.includes('/adapter/version')) return jsonRes({ ok: true, protocol: 3, sessionId: 's-old' })
    if (target.includes('/adapter/state')) return jsonRes({ ok: true, sessionId: 's-new', lastCursor: '4', plugins: [] })
    if (target.includes('/adapter/events')) return sseRes([])
    throw new Error(`unexpected ${target}`)
  }
  const client = createAdapterClient({ url: 'http://x', fetchImpl, autoReconnect: false })
  const connected = await client.connect()
  assert.equal(connected.ok, true)
  assert.equal(connected.sessionId, 's-new', 'state 是最新真相')
  assert.equal(client.sessionId, 's-new')
  assert.equal(client.sessionMismatch.versionSession, 's-old')
  assert.equal(client.sessionMismatch.stateSession, 's-new')
  assert.ok(Number(client.sessionMismatch.at) > 0)
  const eventsUrl = calls.find((target) => target.includes('/adapter/events'))
  assert.ok(eventsUrl.includes('since=4'), 'SSE 用 state.lastCursor')
  assert.ok(eventsUrl.includes('session=s-new'), 'SSE 必须用 state 的 sessionId')
  client.stop()
})
