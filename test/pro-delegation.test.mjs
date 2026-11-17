// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// B-8 专业版激活链单测：① 开关 → ② 逐项 allow → ③ 每次调用审批票 → ④ 审计/限额。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PRO_CAPABILITY,
  PRO_DEFAULTS,
  PRO_STAGE,
  checkProGate,
  createProApprovalStore,
  normalizeProConfig,
  paramsDigest,
  proAuditRecord,
  providerMissingResult,
  runProCapability,
} from '../src/lib/pro-delegation.mjs'
import { createDelegationGate, DELEGATE_ERROR } from '../src/lib/contract-delegation.mjs'

test('B-8 config: pro is default off with per-item allow and explicit limits', () => {
  const pro = normalizeProConfig()
  assert.equal(pro.enabled, false)
  assert.deepEqual(pro.allow, [])
  assert.equal(pro.maxConcurrent, PRO_DEFAULTS.maxConcurrent)
  assert.equal(pro.timeoutMs, PRO_DEFAULTS.timeoutMs)
  assert.equal(pro.maxOutputBytes, PRO_DEFAULTS.maxOutputBytes)
  const enabled = normalizeProConfig({ enabled: true, allow: ['fang.code.run', 'fang.code.run', 'unknown.cap'], maxConcurrent: 99, timeoutMs: 50 })
  assert.equal(enabled.enabled, true)
  assert.deepEqual(enabled.allow, [PRO_CAPABILITY], 'allow only keeps registered pro capabilities, deduped')
  assert.equal(enabled.maxConcurrent, 8)
  assert.equal(enabled.timeoutMs, PRO_DEFAULTS.timeoutMs, 'invalid timeout falls back to default')
})

test('B-8 gate ①: disabled pro rejects with a readable stage (default off)', () => {
  const result = checkProGate({ method: PRO_CAPABILITY, config: { enabled: false, allow: [PRO_CAPABILITY] } })
  assert.equal(result.ok, false)
  assert.equal(result.code, DELEGATE_ERROR.UNSUPPORTED)
  assert.equal(result.stage, PRO_STAGE.DISABLED)
  assert.match(result.message, /default off/i)
})

test('B-8 gate ②: enabled but not explicitly allowed is rejected by name', () => {
  const result = checkProGate({ method: PRO_CAPABILITY, config: { enabled: true, allow: [] } })
  assert.equal(result.ok, false)
  assert.equal(result.stage, PRO_STAGE.NOT_ALLOWED)
  assert.match(result.message, /not activated/i)
})

test('B-8 gate ③: allowed capability requires a per-call approval ticket', () => {
  const missing = checkProGate({ method: PRO_CAPABILITY, config: { enabled: true, allow: [PRO_CAPABILITY] }, params: { code: 'x' } })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, DELEGATE_ERROR.APPROVAL_REQUIRED)
  assert.equal(missing.stage, PRO_STAGE.APPROVAL_REQUIRED)
  assert.match(missing.message, /approval ticket required/i)
  assert.equal(missing.digest, paramsDigest({ code: 'x' }))
  const passed = checkProGate({ method: PRO_CAPABILITY, config: { enabled: true, allow: [PRO_CAPABILITY] }, ticketId: 'pro_ticket_1', params: { code: 'x' } })
  assert.equal(passed.ok, true)
  assert.equal(passed.stage, 'approval-verified')
})

test('B-8 tickets: one-time, TTL-bound, capability/params-bound', () => {
  let clock = 1000
  const store = createProApprovalStore({ now: () => clock, idFactory: () => 'pro_fixed' })
  const issued = store.issue({ capability: PRO_CAPABILITY, ttlMs: 5000 })
  assert.equal(issued.ok, true)
  assert.equal(store.pendingCount(), 1)

  const wrongCapability = store.consume({ id: 'pro_fixed', capability: 'fang.other' })
  assert.equal(wrongCapability.ok, false)
  assert.equal(wrongCapability.reason, 'capability-mismatch')

  const first = store.consume({ id: 'pro_fixed', capability: PRO_CAPABILITY })
  assert.equal(first.ok, true)
  const replay = store.consume({ id: 'pro_fixed', capability: PRO_CAPABILITY })
  assert.equal(replay.ok, false)
  assert.equal(replay.reason, 'ticket-consumed')

  store.issue({ capability: PRO_CAPABILITY, ttlMs: 1000 })
  clock += 2000
  const expired = store.consume({ id: 'pro_fixed', capability: PRO_CAPABILITY })
  assert.equal(expired.ok, false)
  assert.equal(expired.reason, 'ticket-expired')
  assert.equal(store.pendingCount(), 0)
})

test('B-8 tickets: unknown and params-digest mismatch are rejected explicitly', () => {
  const digest = paramsDigest({ code: 'a' })
  const store = createProApprovalStore({ idFactory: () => 'pro_bound' })
  store.issue({ capability: PRO_CAPABILITY, digest })
  const wrongParams = store.consume({ id: 'pro_bound', capability: PRO_CAPABILITY, digest: paramsDigest({ code: 'b' }) })
  assert.equal(wrongParams.ok, false)
  assert.equal(wrongParams.reason, 'params-mismatch')
  const good = store.consume({ id: 'pro_bound', capability: PRO_CAPABILITY, digest })
  assert.equal(good.ok, true)
  const unknown = store.consume({ id: 'nope', capability: PRO_CAPABILITY })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.reason, 'unknown-ticket')
  assert.equal(unknown.stage, PRO_STAGE.APPROVAL_INVALID)
})

test('B-8 limits: pro concurrency gate rejects the second concurrent slot', async () => {
  const gate = createDelegationGate({ maxConcurrent: 1 })
  const [first, second] = await Promise.all([
    runProCapability({ execute: async () => ({ ok: true, value: { ok: true } }), timeoutMs: 1000, gate }),
    runProCapability({ execute: async () => ({ ok: true, value: { ok: true } }), timeoutMs: 1000, gate }),
  ])
  const results = [first, second]
  assert.equal(results.filter((item) => item.ok === true).length, 1)
  assert.equal(results.filter((item) => item.code === DELEGATE_ERROR.RATE_LIMITED).length, 1)
})

test('B-8 limits: timeout and output caps are enforced with readable codes', async () => {
  const slow = await runProCapability({ execute: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, value: {} }), 200)), timeoutMs: 50 })
  assert.equal(slow.ok, false)
  assert.equal(slow.code, DELEGATE_ERROR.TIMEOUT)
  assert.equal(slow.stage, PRO_STAGE.LIMIT_EXCEEDED)

  const big = await runProCapability({ execute: async () => ({ ok: true, value: { blob: 'x'.repeat(5000) } }), timeoutMs: 1000, maxOutputBytes: 1024 })
  assert.equal(big.ok, false)
  assert.equal(big.stage, PRO_STAGE.LIMIT_EXCEEDED)
  assert.match(big.message, /maxOutputBytes/)
})

test('B-8 provider: no code-runtime installed → explicit provider-missing (no side effect claim)', () => {
  const result = providerMissingResult(PRO_CAPABILITY)
  assert.equal(result.ok, false)
  assert.equal(result.code, DELEGATE_ERROR.UNAVAILABLE)
  assert.equal(result.stage, PRO_STAGE.PROVIDER_MISSING)
  assert.match(result.message, /no provider installed/i)
})

test('B-8 audit: stage/limits/approval-digest recorded, raw ticket never logged', () => {
  const record = proAuditRecord({ method: PRO_CAPABILITY, source: 'fork-1', outcome: 'error', stage: PRO_STAGE.PROVIDER_MISSING, ticketId: 'pro_secret_ticket', error: DELEGATE_ERROR.UNAVAILABLE, latencyMs: 12.6, limits: { timeoutMs: 30000, maxConcurrent: 1, maxOutputBytes: 65536 } })
  assert.equal(record.capability, PRO_CAPABILITY)
  assert.equal(record.stage, PRO_STAGE.PROVIDER_MISSING)
  assert.equal(record.error, DELEGATE_ERROR.UNAVAILABLE)
  assert.equal(record.latencyMs, 13)
  assert.equal(record.limits.timeoutMs, 30000)
  assert.ok(record.approval && record.approval !== 'pro_secret_ticket', 'ticket id must be hashed')
})
