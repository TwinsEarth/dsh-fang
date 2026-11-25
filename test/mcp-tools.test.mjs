// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HIGH_RISK_TOOLS, OpStore, listTools } from '../tools/mcp/tools.mjs'

test('exposes 8 default tools and hides 4 high-risk tools', () => {
  const names = listTools().map((tool) => tool.name)
  assert.equal(names.length, 8)
  for (const risky of HIGH_RISK_TOOLS) assert.equal(names.includes(risky), false)
  assert.equal(listTools({ includeHighRisk: true }).length, 12)
})

test('idempotencyKey returns the same opId', () => {
  const store = new OpStore()
  const first = store.start('derive', { idempotencyKey: 'k1' }, () => null)
  const second = store.start('derive', { idempotencyKey: 'k1' }, () => null)
  assert.equal(first.opId, second.opId)
  assert.equal(second.deduped, true)
})

test('op completes and get returns the result', async () => {
  const store = new OpStore()
  const { opId } = store.start('derive', {}, async () => ({ taskId: 't1' }))
  await new Promise((resolve) => setImmediate(resolve))
  const out = store.get(opId)
  assert.equal(out.state, 'completed')
  assert.equal(out.result.taskId, 't1')
})

test('abandon does not pretend to cancel a running op', () => {
  const store = new OpStore()
  const { opId } = store.start('derive', {}, () => new Promise(() => {}))
  const out = store.abandon(opId)
  assert.equal(out.abandoned, true)
  assert.equal(out.state, 'running')
})

test('running op times out without hanging', () => {
  let now = 1_000
  const store = new OpStore({ clock: () => now, timeoutMs: 1_000 })
  const { opId } = store.start('derive', {}, () => new Promise(() => {}))
  now += 5_000
  assert.equal(store.get(opId).state, 'timeout')
})
