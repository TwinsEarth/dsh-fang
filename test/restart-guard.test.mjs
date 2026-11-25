// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T4 — fangRestart / restart-guard（CONTRACTS §5.9）
// 覆盖：决策矩阵（blue/yellow/red）、单飞状态机、awaiting→审批、fail-closed、
//       审计 + bus 事件、impact 降级、policy/state 的 observe|enforce 与 manual|temp|auto 分离。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { makeCtx } from './helpers.mjs'
import { AUDIT, EXIT, GUARD_STATE, SERVICE } from '../src/kernel/index.mjs'
import { bus } from '../src/kernel/core.mjs'
import {
  buildExecutionReceipt,
  digestOf,
  readApprovalManifest,
  verifyApprovalManifest,
} from '../src/lib/restart-contract.mjs'
import {
  Config,
  apply,
  classifyRisk,
  decide,
  findGrant,
  inject,
  name as pluginName,
} from '../src/plugins/restart-guard.mjs'

const TOPIC_REQUESTED = 'fang/restart-requested'
const TOPIC_RESOLVED = 'fang/restart-resolved'
const TOPIC_APPROVED = 'fang/restart-approved'

function makeAuditor() {
  const records = []
  return {
    records,
    append(kind, data) {
      const rec = { kind, data, seq: records.length + 1 }
      records.push(rec)
      return rec
    },
    kinds: () => records.map(r => r.kind),
  }
}

/** Controllable approver stub: request() returns a promise the test resolves explicitly. */
function makeApprover(mode = 'manual') {
  const calls = []
  const queue = []
  return {
    calls,
    pendingCount: () => queue.length,
    request(spec) {
      calls.push(spec)
      if (mode === 'manual') return new Promise(resolve => queue.push(resolve))
      if (mode === 'throw-sync') throw new Error('approver exploded')
      if (mode === 'throw-rejected') return Promise.reject(new Error('approver rejected'))
      if (mode === 'approve') return Promise.resolve({ id: 'apr_a', outcome: 'approved', by: 'tester' })
      if (mode === 'deny') return Promise.resolve({ id: 'apr_d', outcome: 'denied', by: 'tester' })
      if (mode === 'timeout') return Promise.resolve({ id: 'apr_t', outcome: 'timeout', by: 'tester' })
      throw new Error(`unknown approver mode ${mode}`)
    },
    resolveNext(value) {
      const resolve = queue.shift()
      assert.ok(resolve, 'no approval request waiting to be resolved')
      resolve(value)
    },
  }
}

function setup(t, { config = {}, services = {} } = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-restart-state-'))
  const ctx = makeCtx({ services })
  apply(ctx, { dataRoot, ...config })
  t.after(() => {
    try { ctx.dispose() } catch { /* ignore */ }
    try { fs.rmSync(dataRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  })
  return { ctx, guard: ctx.get(SERVICE.restart), dataRoot }
}

/** Watch the two contract bus topics; unsubscribe on test teardown. */
function watchEvents(t) {
  const requested = []
  const resolved = []
  const offRequested = bus.on(TOPIC_REQUESTED, e => requested.push(e))
  const offResolved = bus.on(TOPIC_RESOLVED, e => resolved.push(e))
  t.after(() => { offRequested(); offResolved() })
  return { requested, resolved }
}

test('restart-guard runtime guard: crash ledger records uncaughtExceptionMonitor', (t) => {
  const { guard, dataRoot } = setup(t)
  try {
    process.emit('uncaughtExceptionMonitor', new Error('plugin-apply-exploded'), 'uncaughtException')
    const ledger = path.join(dataRoot, 'restart', 'runtime-crash.jsonl')
    assert.equal(fs.existsSync(ledger), true)
    const record = JSON.parse(fs.readFileSync(ledger, 'utf8').trim().split('\n').pop())
    assert.equal(record.origin, 'uncaughtException')
    assert.match(record.message, /plugin-apply-exploded/)
    const checked = guard.selfCheck()
    assert.equal(checked.findings.some((finding) => finding.code === 'runtime-crash-ledger' && finding.level === 'warn'), true)
    const runtime = guard.runtimeGuard()
    assert.equal(runtime.bootState.state, 'crashed')
  } finally {
    // setup t.after disposes; monitor handler is removed there
  }
})

test('restart-guard runtime guard: previous booting state with dead pid is reported as unclean boot', (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-restart-unclean-'))
  const stateDir = path.join(dataRoot, 'restart')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'boot-state.json'), JSON.stringify({ state: 'booting', pid: 999999, at: Date.now() - 1000 }), 'utf8')
  const ctx = makeCtx()
  try {
    apply(ctx, { dataRoot })
    const guard = ctx.get(SERVICE.restart)
    assert.equal(guard.runtimeGuard().lastUncleanBoot.state, 'booting')
    assert.equal(guard.selfCheck().findings.some((finding) => finding.code === 'unclean-boot' && finding.level === 'warn'), true)
  } finally {
    try { ctx.dispose() } catch { /* ignore */ }
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('restart-guard selfCheck: reports health, HMAC and malformed approval manifests', (t) => {
  const { guard, dataRoot } = setup(t)
  assert.equal(typeof guard.selfCheck, 'function')
  const healthy = guard.selfCheck()
  assert.equal(healthy.ok, true)
  assert.equal(healthy.findings.some((finding) => finding.code === 'state-dir-writable' && finding.level === 'ok'), true)
  assert.equal(healthy.findings.some((finding) => finding.code === 'hmac-available' || finding.code === 'hmac-unavailable'), true)

  const approved = path.join(dataRoot, 'restart', 'approved')
  fs.mkdirSync(approved, { recursive: true })
  fs.writeFileSync(path.join(approved, 'rst_bad.json'), 'not-json{', 'utf8')
  const degraded = guard.selfCheck()
  assert.equal(degraded.ok, true, 'malformed stale approval is a warning, not a boot blocker')
  assert.equal(degraded.findings.some((finding) => finding.code === 'approval-manifests-invalid' && finding.level === 'warn'), true)
  assert.ok(degraded.approvals.total >= 1)
})

test('plugin shape: name/inject/Config/apply, service registration and contract defaults', async (t) => {
  assert.equal(pluginName, 'fang-restart-guard')
  assert.ok(Array.isArray(inject))
  assert.deepEqual(inject, [], 'restart-guard peeks at peer services via ctx.get, no hard inject')
  assert.equal(typeof Config, 'function')
  assert.equal(typeof apply, 'function')

  const defaults = Config({})
  assert.equal(defaults.mode, 'observe')
  assert.equal(defaults.authMode, 'manual')
  assert.equal(defaults.strictRedLine, true)
  assert.equal(defaults.approvalTimeoutMs, 300000)
  assert.equal(defaults.allowProcessRestart, false)
  assert.equal(defaults.autoPromoteAfterHours, 24)
  assert.equal(defaults.manifestTtlMs, 60000, 'supervisor approval manifests have a finite TTL')
  assert.throws(() => Config({ mode: 'bogus' }), /mode/)
  assert.throws(() => Config({ manifestTtlMs: 10 }), /manifestTtlMs/)
  assert.throws(() => apply(makeCtx(), { authMode: 'bogus' }), /config invalid/)

  const auditor = makeAuditor()
  const { guard } = setup(t, { services: { [SERVICE.auditor]: auditor } })
  assert.ok(guard, 'ctx.get(SERVICE.restart) must be registered')
  for (const fn of [
    'request', 'decideOnly', 'state', 'impact', 'policy',
    'executionContract', 'approvals', 'executionStatus', 'verifyApproval',
  ]) {
    assert.equal(typeof guard[fn], 'function', `${fn} must be a function`)
  }

  const state = guard.state()
  assert.equal(state.state, GUARD_STATE.IDLE)
  assert.equal(state.pending, null)
  assert.equal(state.mode, 'observe')
  assert.equal(state.authMode, 'manual')
  assert.equal(state.restartExitCode, EXIT.RESTART)
  assert.equal(state.execution.executed, false, 'state exposes the guard is decision-only')
  assert.equal(state.manifestTtlMs, 60000)

  const policy = guard.policy()
  assert.equal(policy.mode, 'observe', 'policy().mode is the guard layer (observe|enforce)')
  assert.equal(policy.authMode, 'manual', 'decision matrix authorization mode is authMode')
  assert.equal(policy.strictRedLine, true)
  assert.equal(policy.allowProcessRestart, false)
  assert.equal(policy.decisionOnly, true)

  const contract = guard.executionContract()
  assert.equal(contract.version, 1)
  assert.equal(contract.decisionOnly, true)
  assert.equal(contract.guardExecuted, false)
  assert.equal(contract.plannedExitCode, EXIT.RESTART)
  assert.equal(contract.approval.kind, 'fang-restart-approval')
  assert.equal(contract.receipt.kind, 'fang-restart-execution')
  assert.ok(contract.supervisor.mayExecuteWhen.some(x => x.includes('execution.executed === false')))
  assert.ok(contract.supervisor.receiptRequirements.includes('receipt.execution.executed === true'))
  assert.match(contract.rule, /execution\.executed === true/)

  assert.deepEqual(guard.impact(), {
    activeForks: [], pendingPromotes: [], dirtyBuffers: [], activeSessions: 0,
  })
  assert.deepEqual(guard.approvals(), {
    contractVersion: 1,
    items: [],
    counts: { total: 0, authorized: 0, executed: 0, stale: 0, notArmed: 0, invalid: 0 },
  })
  assert.equal(guard.executionStatus('rst_nope').found, false)
  assert.equal(guard.verifyApproval('rst_nope').ok, false)
})

test('decision matrix parity: classifyRisk blue/yellow/red and decide() modes', async () => {
  // classifyRisk: origin/scope/originLight drive the raw level; missing digests bumps it one level.
  assert.equal(classifyRisk({ origin: 'supervisor', digests: ['sha256:a'] }), 'red')
  assert.equal(classifyRisk({ origin: 'cron' }), 'red')
  assert.equal(classifyRisk({ origin: 'cli:kill-9', digests: ['sha256:a'] }), 'red')
  assert.equal(classifyRisk({ originLight: 'red', digests: ['sha256:a'] }), 'red')
  assert.equal(classifyRisk({ scope: 'system', digests: ['sha256:a'] }), 'red')
  assert.equal(classifyRisk({ scope: 'process', digests: ['sha256:a'] }), 'red')
  assert.equal(classifyRisk({ scope: 'session', digests: ['sha256:a'] }), 'yellow')
  assert.equal(classifyRisk({ origin: 'cli', digests: ['sha256:a'] }), 'yellow')
  assert.equal(classifyRisk({ originLight: 'yellow', digests: ['sha256:a'] }), 'yellow')
  assert.equal(classifyRisk({ origin: 'ui', scope: 'single', digests: ['sha256:a'] }), 'blue')
  assert.equal(classifyRisk({}), 'yellow', 'no digests => blue is bumped to yellow (unknown bytes are not safe)')
  assert.equal(classifyRisk({ scope: 'session' }), 'red', 'no digests => yellow is bumped to red')

  // decide(): manual / temp / auto (+ strictRedLine) and forcedApproval veto.
  const manual = { mode: 'manual' }
  assert.equal(decide({ risk: 'blue' }, manual), 'auto-allow')
  assert.equal(decide({ risk: 'yellow' }, manual), 'needs-approval')
  assert.equal(decide({ risk: 'red' }, manual), 'needs-approval')

  const auto = { mode: 'auto', strictRedLine: true }
  assert.equal(decide({ risk: 'blue' }, auto), 'auto-allow')
  assert.equal(decide({ risk: 'yellow' }, auto), 'auto-allow')
  assert.equal(decide({ risk: 'red' }, auto), 'needs-approval')
  assert.equal(decide({ risk: 'red' }, { mode: 'auto', strictRedLine: false }), 'auto-allow')

  const temp = { mode: 'temp', grants: [] }
  assert.equal(decide({ risk: 'blue', scope: 'session' }, temp), 'auto-allow')
  assert.equal(decide({ risk: 'yellow', scope: 'session', digests: ['d1'] }, temp), 'needs-approval')
  const req = { risk: 'yellow', scope: 'session', digests: ['d1'] }
  const grant = { scope: 'session', maxRisk: 'yellow', digests: ['d1'], expiresAt: Date.now() + 60000 }
  assert.ok(findGrant([grant], req, Date.now()))
  assert.equal(findGrant([grant], req, Date.now() + 120000), undefined, 'expired grant is ignored')
  assert.equal(decide(req, { mode: 'temp', grants: [grant] }, Date.now()), 'auto-allow')
  assert.equal(decide({ risk: 'red', scope: 'session', digests: ['d1'] }, { mode: 'temp', grants: [grant] }, Date.now()), 'needs-approval', 'grant maxRisk yellow cannot cover red')
  const redGrant = { ...grant, maxRisk: 'red' }
  assert.ok(findGrant([redGrant], { ...req, risk: 'red' }, Date.now()), 'a red grant covers a red request with matching digests')
  assert.equal(findGrant([redGrant], { ...req, risk: 'red', digests: ['d2'] }, Date.now()), undefined, 'digest mismatch must not match a grant')

  assert.equal(decide({ risk: 'blue', forcedApproval: true }, manual), 'needs-approval', 'forcedApproval always asks a human')
})

test('auto-allow blue request: audit + bus events, guard returns to idle', async (t) => {
  const auditor = makeAuditor()
  const { guard } = setup(t, { services: { [SERVICE.auditor]: auditor } })
  const events = watchEvents(t)

  const result = await guard.request({
    reason: 'hot update of a scoring plugin',
    risk: 'blue', scope: 'mother', origin: 'ui', digests: ['sha256:aaa'],
  })
  assert.equal(result.outcome, 'auto-allow')
  assert.equal(result.decision, 'auto-allow')
  assert.equal(result.risk, 'blue')
  assert.match(String(result.id), /^rst_/)
  assert.equal(result.execution.executed, false, 'v1.0.0 never executes a restart')
  assert.equal(result.execution.plannedExitCode, EXIT.RESTART)
  assert.equal(result.execution.allowProcessRestart, false)

  const state = guard.state()
  assert.equal(state.state, GUARD_STATE.IDLE)
  assert.equal(state.pending, null)

  assert.deepEqual(auditor.kinds(), [AUDIT.RESTART_REQUESTED, AUDIT.RESTART_RESOLVED])
  assert.equal(auditor.records[0].data.risk, 'blue')
  assert.equal(auditor.records[0].data.id, result.id)
  assert.equal(auditor.records[1].data.outcome, 'auto-allow')

  assert.equal(events.requested.length, 1)
  assert.deepEqual(events.requested[0], { id: result.id, risk: 'blue' })
  assert.equal(events.resolved.length, 1)
  assert.equal(events.resolved[0].id, result.id)
  assert.equal(events.resolved[0].outcome, 'auto-allow')
  assert.equal(events.resolved[0].reason, 'hot update of a scoring plugin')
  assert.equal(events.resolved[0].risk, 'blue')
})

test('awaiting → approver approves; single-flight rejects the concurrent second request as busy', async (t) => {
  const auditor = makeAuditor()
  const approver = makeApprover('manual')
  const { guard } = setup(t, { services: { [SERVICE.auditor]: auditor, [SERVICE.approver]: approver } })
  const events = watchEvents(t)

  const pending = guard.request({
    reason: 'mother restart', risk: 'yellow', scope: 'session', origin: 'cli', digests: ['sha256:bbb'],
  })
  // request() runs synchronously up to the approver await => state must already be awaiting
  const awaiting = guard.state()
  assert.equal(awaiting.state, GUARD_STATE.AWAITING)
  assert.ok(awaiting.pending, 'pending must describe the in-flight request')
  assert.equal(awaiting.pending.risk, 'yellow')
  assert.equal(approver.calls.length, 1)
  assert.equal(approver.calls[0].kind, 'restart')
  assert.equal(approver.calls[0].risk, 'yellow')
  assert.equal(approver.calls[0].ttlMs, 300000)
  assert.deepEqual(approver.calls[0].impact, { activeForks: [], pendingPromotes: [], dirtyBuffers: [], activeSessions: 0 })

  // single-flight: second concurrent request is denied without ever reaching the approver
  const second = await guard.request({ reason: 'duplicate', risk: 'red', scope: 'process', origin: 'supervisor', digests: ['sha256:ccc'] })
  assert.equal(second.outcome, 'denied')
  assert.equal(second.reason, 'busy')
  assert.equal(second.activeId, awaiting.pending.id)
  assert.equal(second.activeState, GUARD_STATE.AWAITING)
  assert.equal(typeof second.retryAfterMs, 'number')
  assert.equal(second.retryable, true)
  assert.equal(approver.calls.length, 1, 'busy request must not ask for a second approval')
  assert.equal(guard.state().state, GUARD_STATE.AWAITING, 'busy request must not clobber the in-flight guard')

  approver.resolveNext({ id: 'apr_1', outcome: 'approved', by: 'alice', at: Date.now() })
  const result = await pending
  assert.equal(result.outcome, 'approved')
  assert.equal(result.decision, 'needs-approval')
  assert.equal(result.risk, 'yellow')
  assert.equal(result.by, 'alice')
  assert.equal(result.approvalId, 'apr_1')
  assert.equal(result.execution.executed, false)
  assert.equal(guard.state().state, GUARD_STATE.IDLE)
  assert.equal(guard.state().pending, null)

  const resolved = auditor.records.filter(r => r.kind === AUDIT.RESTART_RESOLVED)
  assert.equal(resolved.at(-1).data.outcome, 'approved')
  assert.equal(auditor.records.filter(r => r.kind === AUDIT.RESTART_REQUESTED).length, 2, 'busy attempt is audited too')
  assert.equal(events.resolved.at(-1).id, result.id)
  assert.equal(events.resolved.at(-1).outcome, 'approved')
  assert.equal(events.resolved.at(-1).approvalId, 'apr_1')
})

test('approver denies / times out: outcome denied|timeout, guard back to idle', async (t) => {
  // denied
  {
    const approver = makeApprover('deny')
    const { guard } = setup(t, { services: { [SERVICE.approver]: approver } })
    const result = await guard.request({ reason: 'deny me', risk: 'red', scope: 'process', origin: 'supervisor', digests: ['d'] })
    assert.equal(result.outcome, 'denied')
    assert.equal(result.reason, 'approval-denied')
    assert.equal(result.decision, 'needs-approval')
    assert.equal(result.risk, 'red')
    assert.equal(guard.state().state, GUARD_STATE.IDLE)
  }
  // timeout reported by the approver service
  {
    const approver = makeApprover('timeout')
    const { guard } = setup(t, { services: { [SERVICE.approver]: approver } })
    const result = await guard.request({ reason: 'slow', risk: 'yellow', scope: 'session', origin: 'cli', digests: ['d'] })
    assert.equal(result.outcome, 'timeout')
    assert.equal(result.reason, 'approval-timeout')
    assert.equal(guard.state().state, GUARD_STATE.IDLE)
  }
})

test('approval watchdog: a stuck approver cannot deadlock the guard (fail-closed timeout)', async (t) => {
  const approver = makeApprover('manual') // never resolved by the test
  const { guard } = setup(t, { config: { approvalTimeoutMs: 1000 }, services: { [SERVICE.approver]: approver } })
  const started = Date.now()
  const result = await guard.request({ reason: 'stuck approval', risk: 'red', scope: 'process', origin: 'supervisor', digests: ['d'] })
  const elapsed = Date.now() - started
  assert.equal(result.outcome, 'timeout')
  assert.equal(result.reason, 'approval-timeout')
  assert.ok(elapsed >= 950 && elapsed < 5000, `watchdog should fire near 1000ms, took ${elapsed}ms`)
  assert.equal(guard.state().state, GUARD_STATE.IDLE)
  assert.equal(approver.pendingCount(), 1, 'approver promise is still pending, but the guard already failed closed')
})

test('fail-closed: no approver service => denied, decision-only failure is audited', async (t) => {
  const auditor = makeAuditor()
  const { guard } = setup(t, { services: { [SERVICE.auditor]: auditor } })
  const events = watchEvents(t)

  const result = await guard.request({
    reason: 'restart without an approver', risk: 'yellow', scope: 'session', origin: 'cli', digests: ['d'],
  })
  assert.equal(result.outcome, 'denied')
  assert.equal(result.reason, 'approver-unavailable')
  assert.equal(result.decision, 'needs-approval')
  assert.equal(guard.state().state, GUARD_STATE.IDLE)
  assert.equal(guard.state().pending, null)

  assert.deepEqual(auditor.kinds(), [AUDIT.RESTART_REQUESTED, AUDIT.RESTART_RESOLVED])
  assert.equal(auditor.records[1].data.deniedReason, 'approver-unavailable')
  assert.equal(events.resolved[0].id, result.id)
  assert.equal(events.resolved[0].outcome, 'denied')
  assert.equal(events.resolved[0].deniedReason, 'approver-unavailable')
})

test('fail-closed: approver throws (sync or rejected promise) => denied approver-error', async (t) => {
  {
    const approver = makeApprover('throw-sync')
    const { guard } = setup(t, { services: { [SERVICE.approver]: approver } })
    const result = await guard.request({ reason: 'sync throw', risk: 'red', scope: 'process', origin: 'supervisor', digests: ['d'] })
    assert.equal(result.outcome, 'denied')
    assert.equal(result.reason, 'approver-error')
    assert.match(result.error, /approver exploded/)
    assert.equal(guard.state().state, GUARD_STATE.IDLE)
  }
  {
    const approver = makeApprover('throw-rejected')
    const { guard } = setup(t, { services: { [SERVICE.approver]: approver } })
    const result = await guard.request({ reason: 'rejected promise', risk: 'red', scope: 'process', origin: 'supervisor', digests: ['d'] })
    assert.equal(result.outcome, 'denied')
    assert.equal(result.reason, 'approver-error')
    assert.match(result.error, /approver rejected/)
  }
})

test('impact() collects forker.list()/buffer.state()/approver.pending() and degrades to empty', async (t) => {
  const approver = {
    pending: () => [{ id: 'p1', kind: 'promote' }, { id: 'a1', kind: 'restart' }],
    request: () => Promise.resolve({ outcome: 'approved' }),
  }
  const forker = {
    list: () => [
      { forkId: 'f1', running: true, status: 'running' },
      { forkId: 'f2', running: false, status: 'stopped' },
      { forkId: 'f3', status: 'running' },
    ],
  }
  const buffer = { state: () => ({ state: 'writing', pending: ['src/a.mjs', 'src/b.mjs'] }) }
  const { guard } = setup(t, {
    services: { [SERVICE.forker]: forker, [SERVICE.buffer]: buffer, [SERVICE.approver]: approver },
  })
  assert.deepEqual(guard.impact(), {
    activeForks: ['f1', 'f3'],
    pendingPromotes: ['p1'],
    dirtyBuffers: ['src/a.mjs', 'src/b.mjs'],
    activeSessions: 0,
  })

  // all three peers broken => degrade to empty, never throw (impact collection must not block a restart decision)
  const broken = {
    list() { throw new Error('forker down') },
    state() { throw new Error('buffer down') },
    pending() { throw new Error('approver down') },
  }
  const { guard: guarded } = setup(t, {
    services: { [SERVICE.forker]: broken, [SERVICE.buffer]: broken, [SERVICE.approver]: broken },
  })
  assert.deepEqual(guarded.impact(), {
    activeForks: [], pendingPromotes: [], dirtyBuffers: [], activeSessions: 0,
  })
})

test('policy()/state() keep guard mode (observe|enforce) separate from authMode (manual|temp|auto)', async (t) => {
  const approver = makeApprover('approve')
  const { guard } = setup(t, {
    config: { mode: 'enforce', authMode: 'auto', strictRedLine: false, allowProcessRestart: true },
    services: { [SERVICE.approver]: approver },
  })
  const policy = guard.policy()
  assert.equal(policy.mode, 'enforce')
  assert.equal(policy.authMode, 'auto')
  assert.equal(policy.strictRedLine, false)
  assert.equal(policy.allowProcessRestart, true)
  assert.equal(guard.state().mode, 'enforce')
  assert.equal(guard.state().authMode, 'auto')

  // authMode=auto + strictRedLine=false => even red is auto-allowed by the matrix, still not executed
  const result = await guard.request({ reason: 'auto red', risk: 'red', scope: 'process', origin: 'supervisor', digests: ['d'] })
  assert.equal(result.outcome, 'auto-allow')
  assert.equal(result.execution.executed, false)
  assert.equal(result.execution.guardMode, 'enforce')
  assert.equal(result.execution.allowProcessRestart, true)
  assert.equal(approver.calls.length, 0, 'auto-allow must not ask the approver')
})

test('strict red line: authMode=auto with strictRedLine=true still requires human approval', async (t) => {
  const approver = makeApprover('approve')
  const { guard } = setup(t, {
    config: { authMode: 'auto', strictRedLine: true },
    services: { [SERVICE.approver]: approver },
  })
  const result = await guard.request({ reason: 'red under strict line', risk: 'red', scope: 'system', origin: 'cron', digests: ['d'] })
  assert.equal(result.outcome, 'approved')
  assert.equal(approver.calls.length, 1)
  assert.equal(approver.calls[0].risk, 'red')
  assert.equal(guard.state().state, GUARD_STATE.IDLE)
})

test('decideOnly() is side-effect free (no state machine, no audit, no approver)', async (t) => {
  const auditor = makeAuditor()
  const approver = makeApprover('manual')
  const { guard } = setup(t, { services: { [SERVICE.auditor]: auditor, [SERVICE.approver]: approver } })
  const before = auditor.records.length

  assert.deepEqual(guard.decideOnly({ risk: 'red', digests: ['d'] }), { decision: 'needs-approval', risk: 'red' })
  assert.deepEqual(guard.decideOnly({ origin: 'ui', digests: ['sha256:x'] }), { decision: 'auto-allow', risk: 'blue' })
  assert.deepEqual(guard.decideOnly({ scope: 'session', origin: 'cli' }), { decision: 'needs-approval', risk: 'red' })
  assert.equal(guard.state().state, GUARD_STATE.IDLE)
  assert.equal(guard.state().pending, null)
  assert.equal(auditor.records.length, before, 'decideOnly must not write audit records')
  assert.equal(approver.calls.length, 0)
})

test('throwing caller-supplied impact cannot strand the single-flight state machine', async (t) => {
  const auditor = makeAuditor()
  const { guard } = setup(t, { services: { [SERVICE.auditor]: auditor } })
  const bad = { reason: 'impact getter', risk: 'blue' }
  Object.defineProperty(bad, 'impact', { enumerable: true, get() { throw new Error('bad impact') } })
  const result = await guard.request(bad)
  assert.equal(result.outcome, 'denied')
  assert.equal(result.reason, 'impact-failed')
  assert.equal(guard.state().state, GUARD_STATE.IDLE)
  assert.equal(guard.state().pending, null)

  // null input must not throw and must leave the guard usable.
  const nullResult = await guard.request(null)
  assert.ok(nullResult && typeof nullResult === 'object')
  assert.equal(guard.state().state, GUARD_STATE.IDLE)
})

test('explicit risk cannot lower server-side classification', async (t) => {
  const approver = makeApprover('approve')
  const { guard } = setup(t, { services: { [SERVICE.approver]: approver } })
  const result = await guard.request({
    reason: 'user-declared blue', risk: 'blue', scope: 'process', origin: 'supervisor', digests: ['sha256:a'],
  })
  assert.equal(result.risk, 'red')
  assert.equal(approver.calls[0].risk, 'red')
})

test('impactSource distinguishes caller impact from service-collected impact', async (t) => {
  const auditor = makeAuditor()
  const approver = makeApprover('approve')
  const { guard } = setup(t, { services: { [SERVICE.auditor]: auditor, [SERVICE.approver]: approver } })
  await guard.request({
    reason: 'caller impact', risk: 'red', scope: 'process', origin: 'supervisor', digests: ['d'],
    impact: { activeForks: [], pendingPromotes: [], dirtyBuffers: [], activeSessions: 0 },
  })
  await guard.request({
    reason: 'service impact', risk: 'red', scope: 'process', origin: 'supervisor', digests: ['d'],
  })
  const requested = auditor.records.filter(r => r.kind === AUDIT.RESTART_REQUESTED)
  assert.equal(requested[0].data.impactSource, 'caller')
  assert.equal(requested[1].data.impactSource, 'service')
})

test('temp without grants is marked temp-effective-manual', (t) => {
  const { guard } = setup(t, { config: { authMode: 'temp' } })
  const state = guard.state()
  assert.equal(state.authMode, 'temp')
  assert.equal(state.tempEffectiveManual, true)
  assert.equal(state.grants, 0)
  assert.equal(guard.policy().tempEffectiveManual, true)
})

test('restart state survives restart as interrupted, not pending', (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-restart-crash-'))
  const approver = makeApprover('manual')
  const auditor = makeAuditor()
  const ctx1 = makeCtx({ services: { [SERVICE.approver]: approver, [SERVICE.auditor]: auditor } })
  let raw = ''
  try {
    apply(ctx1, { dataRoot })
    const guard1 = ctx1.get(SERVICE.restart)
    void guard1.request({ reason: 'crash me', risk: 'red', scope: 'process', origin: 'supervisor', digests: ['d'] })
    assert.equal(guard1.state().state, GUARD_STATE.AWAITING)
    raw = fs.readFileSync(guard1.state().stateFile, 'utf8')
  } finally {
    ctx1.dispose()
  }
  fs.mkdirSync(path.dirname(path.join(dataRoot, 'restart')), { recursive: true })
  // Restore the state file after dispose so this simulates a crash, not a graceful shutdown.
  fs.writeFileSync(path.join(dataRoot, 'restart', 'state.json'), raw)
  const auditor2 = makeAuditor()
  const ctx2 = makeCtx({ services: { [SERVICE.auditor]: auditor2 } })
  try {
    apply(ctx2, { dataRoot })
    const guard2 = ctx2.get(SERVICE.restart)
    assert.equal(guard2.state().state, GUARD_STATE.IDLE)
    assert.equal(guard2.state().pending, null)
    assert.ok(guard2.state().lastInterrupted)
    const resolved = auditor2.records.filter(r => r.kind === AUDIT.RESTART_RESOLVED)
    assert.equal(resolved[0].data.outcome, 'interrupted')
    assert.equal(resolved[0].data.by, 'restart')
  } finally {
    ctx2.dispose()
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('dispose settles an in-flight approval request instead of leaving the caller hanging', async (t) => {
  const approver = makeApprover('manual')
  const { guard, ctx } = setup(t, { services: { [SERVICE.approver]: approver } })
  const promise = guard.request({ reason: 'dispose-in-flight', risk: 'red', scope: 'process', origin: 'test' })
  assert.equal(guard.state().state, GUARD_STATE.AWAITING)
  ctx.dispose()
  // makeCtx.dispose() clears the module bus; subscribe again before the abort microtask lands.
  const late = []
  const off = bus.on(TOPIC_RESOLVED, (event) => late.push(event))
  const result = await promise
  off()
  assert.equal(result.outcome, 'denied')
  assert.equal(result.reason, 'guard-disposed')
  assert.equal(guard.state().state, GUARD_STATE.IDLE)
  const resolved = late.find((event) => event.id === result.id)
  assert.ok(resolved, 'resolved event must identify the request: ' + JSON.stringify(late))
  assert.equal(resolved.deniedReason, 'guard-disposed')
})

test('auditor missing is tolerated (decision still works), ctx disposal clears in-flight state', async (t) => {
  // no auditor service at all: request must not throw, state machine must still settle
  const approver = makeApprover('approve')
  const { guard } = setup(t, { services: { [SERVICE.approver]: approver } })
  const result = await guard.request({ reason: 'no auditor', risk: 'red', scope: 'process', origin: 'supervisor', digests: ['d'] })
  assert.equal(result.outcome, 'approved')
  assert.equal(guard.state().state, GUARD_STATE.IDLE)

  // in-flight request + disposal: watchdog timer cleared, machine reset, process left clean
  const stuck = makeApprover('manual')
  const { guard: guarded, ctx } = setup(t, { services: { [SERVICE.approver]: stuck } })
  void guarded.request({ reason: 'stuck in approval', risk: 'yellow', scope: 'session', origin: 'cli', digests: ['d'] })
  assert.equal(guarded.state().state, GUARD_STATE.AWAITING)
  ctx.dispose()
  assert.equal(guarded.state().state, GUARD_STATE.IDLE)
  assert.equal(guarded.state().pending, null)
})

// ───────────────────── supervisor 契约（阶段 1：授权清单） ─────────────────────

test('supervisor contract: auto-allow writes a durable approval manifest', async (t) => {
  const auditor = makeAuditor()
  const { guard, dataRoot } = setup(t, {
    config: { mode: 'enforce', allowProcessRestart: true },
    services: { [SERVICE.auditor]: auditor },
  })
  const approvedEvents = []
  const offApproved = bus.on(TOPIC_APPROVED, (e) => approvedEvents.push(e))
  t.after(offApproved)

  const result = await guard.request({
    reason: 'hot update of a scoring plugin', risk: 'blue', scope: 'mother', origin: 'ui', digests: ['sha256:aaa'],
  })
  assert.equal(result.outcome, 'auto-allow')
  assert.ok(result.authorization, 'approval result must carry the durable authorization')
  assert.equal(result.authorization.manifestId, result.id)
  assert.match(result.authorization.nonce, /^[0-9a-f]{64}$/)
  assert.match(result.authorization.digest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(result.execution.executed, false)
  assert.equal(result.execution.manifestDigest, result.authorization.digest)
  assert.equal(result.execution.manifestExpiresAt, result.authorization.expiresAt)

  const stateDir = path.join(dataRoot, 'restart')
  const manifest = readApprovalManifest(stateDir, result.id)
  assert.ok(manifest, 'manifest must exist on disk')
  assert.equal(manifest.kind, 'fang-restart-approval')
  assert.equal(manifest.risk, 'blue')
  assert.equal(manifest.outcome, 'auto-allow')
  assert.equal(manifest.execution.executed, false, 'guard never executes: phase-1 manifest says executed=false')
  assert.equal(manifest.execution.decisionOnly, true)
  assert.equal(manifest.execution.plannedExitCode, EXIT.RESTART)
  assert.equal(manifest.guard.decisionOnly, true)
  assert.equal(manifest.guard.mode, 'enforce')
  assert.equal(manifest.guard.allowProcessRestart, true)
  assert.equal(manifest.digest, result.authorization.digest)
  assert.equal(manifest.expiresAt - manifest.approvedAt, 60000, 'manifest TTL comes from config')
  assert.equal(verifyApprovalManifest(manifest, { now: manifest.approvedAt + 1 }).ok, true)

  assert.equal(approvedEvents.length, 1)
  assert.equal(approvedEvents[0].authorization.manifestId, result.id)
  assert.equal(approvedEvents[0].authorization.digest, manifest.digest)
  assert.equal(approvedEvents[0].execution.executed, false)
  assert.equal(approvedEvents[0].execution.plannedExitCode, EXIT.RESTART)

  // 只读状态 API：不改状态文件、不写审计
  const stateBefore = fs.readFileSync(guard.state().stateFile, 'utf8')
  const auditBefore = auditor.records.length
  const status = guard.executionStatus(result.id, { now: manifest.approvedAt + 1 })
  assert.equal(status.found, true)
  assert.equal(status.authorized, true)
  assert.equal(status.armed, true)
  assert.equal(status.executed, false)
  assert.equal(status.expired, false)
  assert.equal(status.manifest.digest, manifest.digest)
  const verified = guard.verifyApproval(result.id, { now: manifest.approvedAt + 1 })
  assert.equal(verified.ok, true)
  assert.equal(verified.reason, null)
  assert.equal(verified.armed, true)
  assert.equal(verified.digestValid, true)
  const list = guard.approvals({ now: manifest.approvedAt + 1 })
  assert.equal(list.items.length, 1)
  assert.equal(list.items[0].id, result.id)
  assert.equal(list.items[0].state, 'authorized')
  assert.equal(list.counts.authorized, 1)
  assert.equal(fs.readFileSync(guard.state().stateFile, 'utf8'), stateBefore, 'read APIs must not touch state')
  assert.equal(auditor.records.length, auditBefore, 'read APIs must not write audit')
  assert.equal(guard.state().lastManifest.id, result.id)
  assert.equal(guard.state().approvalDir, path.join(stateDir, 'approved'))
  assert.equal(guard.state().executionDir, path.join(stateDir, 'executed'))
})

test('supervisor contract: approved restart manifest carries approvalId/approvedBy', async (t) => {
  const auditor = makeAuditor()
  const approver = makeApprover('manual')
  const { guard, dataRoot } = setup(t, {
    config: { mode: 'enforce', allowProcessRestart: true },
    services: { [SERVICE.auditor]: auditor, [SERVICE.approver]: approver },
  })
  const pending = guard.request({
    reason: 'mother restart', risk: 'yellow', scope: 'session', origin: 'cli', digests: ['sha256:b'],
  })
  assert.equal(guard.state().state, GUARD_STATE.AWAITING)
  approver.resolveNext({ id: 'apr_9', outcome: 'approved', by: 'alice' })
  const result = await pending
  assert.equal(result.outcome, 'approved')
  assert.equal(result.approvalId, 'apr_9')
  assert.equal(result.by, 'alice')

  const manifest = readApprovalManifest(path.join(dataRoot, 'restart'), result.id)
  assert.equal(manifest.outcome, 'approved')
  assert.equal(manifest.approvalId, 'apr_9')
  assert.equal(manifest.approvedBy, 'alice')
  assert.equal(manifest.risk, 'yellow')
  assert.equal(manifest.execution.executed, false)

  const resolved = auditor.records.filter(r => r.kind === AUDIT.RESTART_RESOLVED).at(-1)
  assert.equal(resolved.data.manifestDigest, manifest.digest)
  assert.equal(resolved.data.manifestPath, result.authorization.manifestPath)
  assert.equal(resolved.data.manifestExpiresAt, manifest.expiresAt)
})

test('supervisor contract: expired or tampered manifests are never authorized', async (t) => {
  const { guard, dataRoot } = setup(t, { config: { mode: 'enforce', allowProcessRestart: true } })
  const result = await guard.request({
    reason: 'blue upgrade', risk: 'blue', scope: 'mother', origin: 'ui', digests: ['sha256:a'],
  })
  const stateDir = path.join(dataRoot, 'restart')
  const manifest = readApprovalManifest(stateDir, result.id)

  const atExpiry = manifest.expiresAt
  const expired = guard.executionStatus(result.id, { now: atExpiry })
  assert.equal(expired.expired, true)
  assert.equal(expired.stale, true)
  assert.equal(expired.authorized, false)
  const expiredVerify = guard.verifyApproval(result.id, { now: atExpiry })
  assert.equal(expiredVerify.ok, false)
  assert.equal(expiredVerify.reason, 'expired')
  assert.equal(guard.approvals({ now: atExpiry }).counts.stale, 1)

  // 篡改风险等级但不重算 digest => 不授权、不可执行
  const tampered = { ...manifest, risk: 'red' }
  fs.writeFileSync(result.authorization.manifestPath, JSON.stringify(tampered), 'utf8')
  const status = guard.executionStatus(result.id, { now: manifest.approvedAt + 1 })
  assert.equal(status.authorized, false)
  assert.equal(status.manifestVerification.reason, 'digest-mismatch')
  assert.equal(guard.verifyApproval(result.id, { now: manifest.approvedAt + 1 }).ok, false)
  const list = guard.approvals({ now: manifest.approvedAt + 1 })
  assert.equal(list.counts.authorized, 0)
  assert.equal(list.counts.invalid, 1)
})

test('supervisor contract: only a receipt with execution.executed===true proves execution', async (t) => {
  const { guard, dataRoot } = setup(t, { config: { mode: 'enforce', allowProcessRestart: true } })
  const result = await guard.request({
    reason: 'blue upgrade', risk: 'blue', scope: 'mother', origin: 'ui', digests: ['sha256:a'],
  })
  const stateDir = path.join(dataRoot, 'restart')
  const manifest = readApprovalManifest(stateDir, result.id)
  const receipt = buildExecutionReceipt({
    manifest, supervisorId: 'fang-supervisor-test', pid: 777, executedAt: manifest.approvedAt + 10,
  })
  fs.mkdirSync(path.dirname(result.authorization.receiptPath), { recursive: true })
  fs.writeFileSync(result.authorization.receiptPath, JSON.stringify(receipt), 'utf8')

  const status = guard.executionStatus(result.id)
  assert.equal(status.executed, true)
  assert.equal(status.authorized, false, 'executed approval must not be re-authorized')
  assert.equal(status.receiptState, 'executed')
  assert.equal(guard.verifyApproval(result.id).ok, false)
  assert.equal(guard.verifyApproval(result.id).reason, 'already-executed')
  const list = guard.approvals()
  assert.equal(list.counts.executed, 1)
  assert.equal(list.items[0].state, 'executed')

  // executed:false 的回执 => invalid-receipt：不算执行过，也不允许再执行（fail-closed）
  const fake = structuredClone(receipt)
  fake.execution.executed = false
  delete fake.digest
  fake.digest = digestOf(fake)
  fs.writeFileSync(result.authorization.receiptPath, JSON.stringify(fake), 'utf8')
  const invalid = guard.executionStatus(result.id)
  assert.equal(invalid.executed, false)
  assert.equal(invalid.authorized, false)
  assert.equal(invalid.receiptState, 'invalid')
  const invalidVerify = guard.verifyApproval(result.id)
  assert.equal(invalidVerify.ok, false)
  assert.equal(invalidVerify.reason, 'invalid-receipt')
})

test('supervisor contract: manifest write failure is fail-closed (denied, no approved event)', async (t) => {
  const auditor = makeAuditor()
  const approver = makeApprover('approve')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-restart-block-'))
  const blocker = path.join(root, 'blocker')
  fs.writeFileSync(blocker, 'not a directory', 'utf8')
  const dataRoot = path.join(blocker, 'nested')
  const ctx = makeCtx({ services: { [SERVICE.auditor]: auditor, [SERVICE.approver]: approver } })
  apply(ctx, { dataRoot })
  t.after(() => {
    try { ctx.dispose() } catch { /* ignore */ }
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  })
  const guard = ctx.get(SERVICE.restart)
  const approvedEvents = []
  const off = bus.on(TOPIC_APPROVED, (e) => approvedEvents.push(e))
  t.after(off)

  const result = await guard.request({
    reason: 'cannot persist manifest', risk: 'red', scope: 'process', origin: 'supervisor', digests: ['d'],
  })
  assert.equal(result.outcome, 'denied')
  assert.equal(result.reason, 'manifest-write-failed')
  assert.equal(guard.state().state, GUARD_STATE.IDLE)
  assert.equal(approvedEvents.length, 0, 'no approved event without a durable manifest')
  assert.equal(guard.approvals().items.length, 0)
  const resolved = auditor.records.filter(r => r.kind === AUDIT.RESTART_RESOLVED).at(-1)
  assert.equal(resolved.data.deniedReason, 'manifest-write-failed')
  assert.match(String(resolved.data.error), /ENOTDIR|ENOENT|EACCES|EPERM|not a directory/i)
})

test('supervisor contract: unarmed approvals are durable but never authorized', async (t) => {
  // 默认 observe + allowProcessRestart=false：清单照样落盘，但 supervisor 不得执行。
  const { guard, dataRoot } = setup(t)
  const result = await guard.request({
    reason: 'blue upgrade', risk: 'blue', scope: 'mother', origin: 'ui', digests: ['sha256:a'],
  })
  const stateDir = path.join(dataRoot, 'restart')
  const manifest = readApprovalManifest(stateDir, result.id)
  assert.equal(manifest.guard.mode, 'observe')
  assert.equal(manifest.guard.allowProcessRestart, false)
  const verified = guard.verifyApproval(result.id, { now: manifest.approvedAt + 1 })
  assert.equal(verified.ok, false, 'observe mode must never authorize execution')
  assert.equal(verified.reason, 'guard-not-enforce')
  assert.equal(verified.armed, false)
  assert.equal(verified.authorized, false)
  const status = guard.executionStatus(result.id, { now: manifest.approvedAt + 1 })
  assert.equal(status.armed, false)
  assert.equal(status.authorized, false)
  assert.equal(status.blockedReason, 'guard-not-enforce')
  const list = guard.approvals({ now: manifest.approvedAt + 1 })
  assert.equal(list.items[0].state, 'not-armed')
  assert.equal(list.counts.notArmed, 1)
  assert.equal(list.counts.authorized, 0)

  // enforce 但 allowProcessRestart=false：清单可执行性仍被第二把钥匙挡住。
  const second = setup(t, { config: { mode: 'enforce' } })
  const r2 = await second.guard.request({
    reason: 'blue upgrade 2', risk: 'blue', scope: 'mother', origin: 'ui', digests: ['sha256:a'],
  })
  const m2 = readApprovalManifest(path.join(second.dataRoot, 'restart'), r2.id)
  assert.equal(m2.guard.mode, 'enforce')
  assert.equal(m2.guard.allowProcessRestart, false)
  const v2 = second.guard.verifyApproval(r2.id, { now: m2.approvedAt + 1 })
  assert.equal(v2.ok, false)
  assert.equal(v2.reason, 'process-restart-disabled')
  assert.equal(v2.armed, false)
})

// ───────────────────── C 方案：watchdog 交接（三重门禁） ─────────────────────

const ROOT_DIR = path.join(import.meta.dirname, '..')

test('pid file lifecycle: mother writes <dataDir>/fang.pid and removes it on dispose', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-restart-pid-'))
  const ctx = makeCtx()
  try {
    apply(ctx, { dataRoot })
    const guard = ctx.get(SERVICE.restart)
    const pidFile = guard.state().pidFile
    assert.equal(pidFile, path.join(dataRoot, 'fang.pid'))
    assert.equal(fs.existsSync(pidFile), true, 'watchdog needs a durable host pid')
    const raw = JSON.parse(fs.readFileSync(pidFile, 'utf8'))
    assert.equal(raw.pid, process.pid)
    assert.equal(raw.role, 'mother')
    ctx.dispose()
    assert.equal(fs.existsSync(pidFile), false, 'graceful dispose removes its own pid file')
  } finally {
    try { ctx.dispose() } catch { /* already disposed */ }
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('supervisor detection: live + execute:true + fresh marker required; observe stays disarmed', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-restart-marker-'))
  const ctx = makeCtx()
  try {
    apply(ctx, { dataRoot })
    const guard = ctx.get(SERVICE.restart)
    assert.equal(guard.state().supervisorPresent, false)
    assert.equal(guard.state().executionArmed, false)

    const markerFile = path.join(dataRoot, 'restart', 'supervisor.present')
    fs.mkdirSync(path.dirname(markerFile), { recursive: true })
    const writeMarker = (extra = {}) => fs.writeFileSync(markerFile, JSON.stringify({
      version: 1, supervisor: 'test-watchdog', pid: process.pid, execute: true, at: Date.now(), ...extra,
    }), 'utf8')

    writeMarker({ pid: 2147483647 }) // 不可能存活的 pid
    assert.equal(guard.state().supervisorPresent, false, 'dead marker writer is not a supervisor')
    writeMarker({ at: Date.now() - 120000 })
    assert.equal(guard.state().supervisorPresent, false, 'stale marker is not a supervisor')
    writeMarker({ execute: false })
    assert.equal(guard.state().supervisorPresent, false, 'observe-only watchdog must not arm execution')

    writeMarker()
    assert.equal(guard.state().supervisorPresent, true)
    assert.equal(guard.state().executionArmed, false, 'observe mode is still disarmed even with a live supervisor')
    assert.equal(guard.policy().supervisorPresent, true)
    assert.equal(guard.policy().executionArmed, false)
    assert.equal(guard.executionContract().supervisorPresent, true)
    assert.equal(guard.executionContract().executionArmed, false)
    assert.match(guard.executionContract().note, /disarmed/)
  } finally {
    try { ctx.dispose() } catch { /* ignore */ }
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('triple gate: enforce + allowProcessRestart + live supervisor arms execution', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-restart-armed-'))
  const ctx = makeCtx()
  try {
    apply(ctx, { dataRoot, mode: 'enforce', allowProcessRestart: true })
    const guard = ctx.get(SERVICE.restart)
    const markerFile = path.join(dataRoot, 'restart', 'supervisor.present')
    fs.mkdirSync(path.dirname(markerFile), { recursive: true })
    fs.writeFileSync(markerFile, JSON.stringify({
      version: 1, supervisor: 'test-watchdog', pid: process.pid, execute: true, at: Date.now(),
    }), 'utf8')
    assert.equal(guard.state().executionArmed, true)
    assert.equal(guard.policy().executionArmed, true)
    assert.equal(guard.executionContract().executionArmed, true)
    assert.match(guard.executionContract().note, /armed/)
  } finally {
    try { ctx.dispose() } catch { /* ignore */ }
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
})

function runHandoffChild({ dataRoot, resultFile, withSupervisor, mode = 'enforce', allowProcessRestart = true }) {
  const markerFile = path.join(dataRoot, 'restart', 'supervisor.present')
  const script = `
import fs from 'node:fs'
import { makeCtx } from ${JSON.stringify(pathToFileURL(path.join(ROOT_DIR, 'test/helpers.mjs')).href)}
import * as guardPlugin from ${JSON.stringify(pathToFileURL(path.join(ROOT_DIR, 'src/plugins/restart-guard.mjs')).href)}
import { SERVICE } from ${JSON.stringify(pathToFileURL(path.join(ROOT_DIR, 'src/kernel/index.mjs')).href)}
const dataRoot = ${JSON.stringify(dataRoot)}
if (${JSON.stringify(withSupervisor)}) {
  fs.mkdirSync(${JSON.stringify(path.dirname(markerFile))}, { recursive: true })
  fs.writeFileSync(${JSON.stringify(markerFile)}, JSON.stringify({
    version: 1, supervisor: 'test-watchdog', pid: process.pid, execute: true, at: Date.now(),
  }))
}
const ctx = makeCtx()
guardPlugin.apply(ctx, { dataRoot, mode: ${JSON.stringify(mode)}, allowProcessRestart: ${JSON.stringify(allowProcessRestart)} })
const svc = ctx.get(SERVICE.restart)
const result = await svc.request({ reason: 'handoff', risk: 'blue', scope: 'mother', origin: 'ui', digests: ['sha256:a'] })
fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(result))
// armed: guard exits 75 first; disarmed: exit 0 after the result file is written.
setTimeout(() => { process.exit(0) }, 1500)
`
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT_DIR, encoding: 'utf8', timeout: 25000,
  })
}

test('triple gate handoff: armed + supervisor marker writes manifest then exits 75', { timeout: 30000 }, () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-restart-handoff-'))
  const resultFile = path.join(dataRoot, 'result.json')
  try {
    const child = runHandoffChild({ dataRoot, resultFile, withSupervisor: true })
    assert.equal(child.status, EXIT.RESTART, `child must exit 75 (stdout=${child.stdout} stderr=${child.stderr})`)
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    assert.equal(result.execution.handoff.to, 'supervisor')
    assert.equal(result.execution.handoff.via, 'file')
    assert.equal(result.execution.reason, 'supervisor-handoff')
    assert.equal(result.execution.executed, false, 'guard never claims execution; the receipt is the proof')
    assert.equal(result.execution.plannedExitCode, EXIT.RESTART)

    const manifest = readApprovalManifest(path.join(dataRoot, 'restart'), result.id)
    assert.ok(manifest, 'manifest must exist before the handoff')
    assert.equal(manifest.execution.executed, false)
    assert.equal(manifest.guard.pid, child.pid, 'manifest binds the host pid for the watchdog')
    assert.equal(verifyApprovalManifest(manifest, { now: manifest.approvedAt + 1 }).ok, true)

    const pidFile = JSON.parse(fs.readFileSync(path.join(dataRoot, 'fang.pid'), 'utf8'))
    assert.equal(pidFile.pid, child.pid, 'pid file must point at the exiting host, not the watchdog')
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('triple gate handoff: enforce + allowProcessRestart without supervisor never exits 75', { timeout: 30000 }, () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-restart-disarmed-'))
  const resultFile = path.join(dataRoot, 'result.json')
  try {
    const child = runHandoffChild({ dataRoot, resultFile, withSupervisor: false })
    assert.equal(child.status, 0, `disarmed guard must not exit 75 (stdout=${child.stdout} stderr=${child.stderr})`)
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    assert.equal(result.outcome, 'auto-allow')
    assert.equal(result.execution.executed, false)
    assert.equal(result.execution.handoff, null, 'no supervisor => no handoff')
    assert.equal(result.execution.reason, 'v3.1.x-decision-only')
    const manifest = readApprovalManifest(path.join(dataRoot, 'restart'), result.id)
    assert.ok(manifest, 'approval manifest is still durable while disarmed')
    assert.equal(manifest.execution.executed, false)
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
})
