// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// B 契约委托：白名单 / 错误码 / 限额 / 超时 / 审计纯函数单测。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_READ_ALLOW,
  DELEGATE_ERROR,
  capabilityCatalog,
  checkDelegation,
  delegationAuditRecord,
  exceedPayloadLimit,
  normalizeDelegationConfig,
  runDelegated,
} from '../src/lib/contract-delegation.mjs'

test('normalizeDelegationConfig: defaults are read-only allowlist + 64KiB/5s', () => {
  const cfg = normalizeDelegationConfig()
  assert.equal(cfg.enabled, true)
  assert.deepEqual(cfg.allow, [...DEFAULT_READ_ALLOW])
  assert.equal(cfg.maxPayloadBytes, 64 * 1024)
  assert.equal(cfg.readTimeoutMs, 5000)
  assert.equal(cfg.writeTimeoutMs, 30000)
  assert.ok(cfg.allow.includes('fang.session.list'))
  assert.ok(!cfg.allow.includes('fang.fork.spawn'), 'write-ish legacy methods are not delegated by default')
})

test('normalizeDelegationConfig: explicit allow overrides and unknown values clamp to defaults', () => {
  const cfg = normalizeDelegationConfig({ allow: ['fang.orchestrator.status', 'fang.orchestrator.status', ' '], maxPayloadBytes: -1, readTimeoutMs: 1 })
  assert.deepEqual(cfg.allow, ['fang.orchestrator.status'])
  assert.equal(cfg.maxPayloadBytes, 64 * 1024)
  assert.equal(cfg.readTimeoutMs, 5000)
})

test('capabilityCatalog: only allowlisted descriptors are advertised', () => {
  const catalog = capabilityCatalog(['fang.session.list'])
  assert.deepEqual(catalog.map((c) => c.method), ['fang.session.list'])
  assert.equal(catalog[0].kind, 'read')
  assert.equal(catalog[0].approval, 'none')
  const none = capabilityCatalog([])
  assert.deepEqual(none, [])
})

test('checkDelegation: disabled → contract-unavailable, not listed → contract-unsupported, listed → ok', () => {
  const disabled = checkDelegation({ method: 'fang.session.list', config: { enabled: false } })
  assert.equal(disabled.ok, false)
  assert.equal(disabled.error, DELEGATE_ERROR.UNAVAILABLE)

  const unsupported = checkDelegation({ method: 'fang.fork.spawn', config: {} })
  assert.equal(unsupported.ok, false)
  assert.equal(unsupported.error, DELEGATE_ERROR.UNSUPPORTED)

  const ok = checkDelegation({ method: 'fang.session.list', config: {} })
  assert.equal(ok.ok, true)
  assert.equal(ok.descriptor.method, 'fang.session.list')

  const bootstrap = checkDelegation({ method: 'fang.capability.list', config: { allow: [] } })
  assert.equal(bootstrap.ok, true)
})

test('exceedPayloadLimit: default 64KiB boundary', () => {
  assert.equal(exceedPayloadLimit({ pad: 'x'.repeat(1000) }), false)
  assert.equal(exceedPayloadLimit({ pad: 'x'.repeat(70 * 1024) }), true)
  assert.equal(exceedPayloadLimit(null), false)
})

test('runDelegated: resolves value + latency; timeout maps to contract-timeout; throws keep codes', async () => {
  const ok = await runDelegated(async () => ({ ok: true }), { timeoutMs: 1000 })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.value, { ok: true })
  assert.ok(ok.latencyMs >= 0)

  const timedOut = await runDelegated(() => new Promise((resolve) => setTimeout(resolve, 200)), { timeoutMs: 20 })
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.error, DELEGATE_ERROR.TIMEOUT)

  const failed = await runDelegated(async () => { const e = new Error('nope'); e.code = 'handler-threw'; throw e }, { timeoutMs: 1000 })
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'handler-threw')
})

test('delegationAuditRecord: capability/source/outcome/latency shape', () => {
  assert.deepEqual(delegationAuditRecord({ method: 'fang.session.list', source: 'fork-1', outcome: 'ok', latencyMs: 12.4 }), {
    capability: 'fang.session.list', source: 'fork-1', outcome: 'ok', error: null, latencyMs: 12,
  })
  assert.equal(delegationAuditRecord({ method: 'x', outcome: 'rejected', error: 'contract-unsupported' }).error, 'contract-unsupported')
})
