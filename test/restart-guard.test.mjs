// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T4 — fangRestart / restart-guard（CONTRACTS §5.9）
// 覆盖：决策矩阵（blue/yellow/red）、单飞状态机、awaiting→审批、fail-closed、
//       审计 + bus 事件、impact 降级、policy/state 的 observe|enforce 与 manual|temp|auto 分离。
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeCtx } from './helpers.mjs'
import { AUDIT, EXIT, GUARD_STATE, SERVICE } from '../src/kernel/index.mjs'
import { bus } from '../src/kernel/core.mjs'
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
  const ctx = makeCtx({ services })
  apply(ctx, config)
  t.after(() => { try { ctx.dispose() } catch { /* ignore */ } })
  return { ctx, guard: ctx.get(SERVICE.restart) }
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
  assert.throws(() => Config({ mode: 'bogus' }), /mode/)
  assert.throws(() => apply(makeCtx(), { authMode: 'bogus' }), /config invalid/)

  const auditor = makeAuditor()
  const { guard } = setup(t, { services: { [SERVICE.auditor]: auditor } })
  assert.ok(guard, 'ctx.get(SERVICE.restart) must be registered')
  for (const fn of ['request', 'decideOnly', 'state', 'impact', 'policy']) {
    assert.equal(typeof guard[fn], 'function', `${fn} must be a function`)
  }

  const state = guard.state()
  assert.equal(state.state, GUARD_STATE.IDLE)
  assert.equal(state.pending, null)
  assert.equal(state.mode, 'observe')
  assert.equal(state.authMode, 'manual')
  assert.equal(state.restartExitCode, EXIT.RESTART)

  const policy = guard.policy()
  assert.equal(policy.mode, 'observe', 'policy().mode is the guard layer (observe|enforce)')
  assert.equal(policy.authMode, 'manual', 'decision matrix authorization mode is authMode')
  assert.equal(policy.strictRedLine, true)
  assert.equal(policy.allowProcessRestart, false)

  assert.deepEqual(guard.impact(), {
    activeForks: [], pendingPromotes: [], dirtyBuffers: [], activeSessions: 0,
  })
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
    risk: 'blue', scope: 'session', origin: 'cli', digests: ['sha256:aaa'],
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
  assert.deepEqual(events.resolved[0], { id: result.id, outcome: 'auto-allow' })
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
  assert.deepEqual(events.resolved.at(-1), { id: result.id, outcome: 'approved' })
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
  assert.deepEqual(events.resolved, [{ id: result.id, outcome: 'denied' }])
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
