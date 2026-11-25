// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v3.1.35：契约 1.1 回流接口的验收项（交接文档 §6 的 1–5 条）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CAPABILITIES,
  METHODS as CONTRACT_METHODS,
  RELAY_LIMITS,
  createContractServer,
  createRelayStore,
  relayHandlers,
} from '../src/contract/index.js'

function makeServer() {
  const store = createRelayStore({ peerLabel: 'dsh-fang-bundle', role: 'mother', instanceId: 'fang-test' })
  const server = createContractServer({
    role: 'mother',
    instanceId: 'fang-test',
    handlers: {
      ...relayHandlers(store),
      [CONTRACT_METHODS.ORCHESTRATOR_STATUS]: async () => ({ ok: true, marker: 'status-1.0' }),
    },
  })
  // invoke 接受完整信封：{ protocol, protocolVersion, id, method, params }
  const call = (method, params) => server.invoke({
    protocol: 'fang-master',
    protocolVersion: 1,
    id: `req_${method}_${Math.random().toString(36).slice(2, 10)}`,
    method,
    params,
  })
  return { store, server, call }
}

function event(id, overrides = {}) {
  return { id, type: 'cost:event', at: 1794553384711, payload: { kind: 'ledger', savedTokens: 12 }, ...overrides }
}

test('relay: hello advertises both relay methods and the event-relay capability', async () => {
  const { call } = makeServer()
  const hello = (await call(CONTRACT_METHODS.HELLO, {})).result
  assert.ok(hello.methods.includes('fang.relay.publish'), 'must advertise fang.relay.publish')
  assert.ok(hello.methods.includes('fang.relay.status'), 'must advertise fang.relay.status')
  assert.ok((hello.capabilities ?? []).includes('event-relay'), 'must advertise the event-relay capability')
  assert.ok(Array.isArray(CAPABILITIES), 'capability list comes from the vendored constants')
})

test('relay: re-delivering the same event.id is idempotent (accepted 0 / duplicates 1)', async () => {
  const { call, store } = makeServer()
  const first = await call('fang.relay.publish', { batchId: 'relay-1', events: [event('e-1')] })
  assert.equal(first.ok, true, JSON.stringify(first.error ?? null))
  assert.equal(first.result.accepted, 1)
  assert.equal(first.result.duplicates, 0)
  const cursorAfterFirst = first.result.cursor

  const second = await call('fang.relay.publish', { batchId: 'relay-1', events: [event('e-1')] })
  assert.equal(second.ok, true)
  assert.equal(second.result.accepted, 0)
  assert.equal(second.result.duplicates, 1)
  assert.equal(second.result.cursor, cursorAfterFirst, 'cursor must not go backwards')
  assert.equal(store.status().peer, 'dsh-fang-bundle')
})

test('relay: over-limit batches are protocol errors, never silently truncated', async () => {
  const { call } = makeServer()
  const tooMany = Array.from({ length: RELAY_LIMITS.maxBatch + 1 }, (_, i) => event(`bulk-${i}`))
  const many = await call('fang.relay.publish', { batchId: 'relay-too-many', events: tooMany })
  assert.equal(many.ok, false, 'over-limit batch must fail')
  assert.match(String(many.error?.code ?? ''), /relay-events-invalid/)

  const big = event('huge', { payload: { blob: 'x'.repeat(RELAY_LIMITS.maxEventBytes + 1024) } })
  const oversized = await call('fang.relay.publish', { batchId: 'relay-big', events: [big] })
  assert.equal(oversized.ok, false, 'oversized event must fail')
  assert.match(String(oversized.error?.code ?? ''), /relay-events-invalid/)

  const empty = await call('fang.relay.publish', { batchId: 'relay-empty', events: [] })
  assert.equal(empty.ok, false, 'empty batch must be rejected')
})

test('relay: status reports the self-declared peer label', async () => {
  const { call } = makeServer()
  const status = await call('fang.relay.status', {})
  assert.equal(status.ok, true, JSON.stringify(status.error ?? null))
  assert.equal(status.result.peer, 'dsh-fang-bundle', "peer must be the bundle's own label, not contract-server")
  assert.equal(typeof status.result.cursor, 'number')
})

test('relay: 1.0 method behaviour is untouched', async () => {
  const { call } = makeServer()
  const out = await call(CONTRACT_METHODS.ORCHESTRATOR_STATUS, {})
  assert.equal(out.ok, true)
  assert.equal(out.result.ok, true)
  assert.equal(out.result.marker, 'status-1.0', 'existing handler must be called unchanged')
})
