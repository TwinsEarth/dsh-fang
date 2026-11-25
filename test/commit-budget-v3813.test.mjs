// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.8.13 closure tests: maxForks hard limit, fork commit host reserve,
// sidecar spawn-time provisional PID, and advisory pagefile semantics.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { makeCtx, makeWebServerStub, TEST_AUTH_TOKEN } from './helpers.mjs'
import { SERVICE } from '../src/kernel/index.mjs'
import * as orchestrator from '../src/plugins/orchestrator.mjs'
import { evaluateForkCommitBudget, resolveForkCommitBudget } from '../src/lib/commit-budget.mjs'

test('v3.8.13: resolveForkCommitBudget keeps 40% share and 4 GB host reserve', () => {
  const shareBound = resolveForkCommitBudget({ commitLimitMB: 32768, share: 0.4, reserveMB: 4096 })
  assert.equal(shareBound.ok, true)
  assert.equal(shareBound.limitMB, Math.round(32768 * 0.4), '32 GB host: 40% is the smaller ceiling')

  const shareBound8 = resolveForkCommitBudget({ commitLimitMB: 8192, share: 0.4, reserveMB: 4096 })
  assert.equal(shareBound8.ok, true)
  assert.equal(shareBound8.limitMB, 3277, '8 GB host: 40% is still the smaller ceiling')

  const verySmall = resolveForkCommitBudget({ commitLimitMB: 5000, share: 0.4, reserveMB: 4096 })
  assert.equal(verySmall.limitMB, 904, '5 GB host: only 904 MB remains above the reserve')

  const exhausted = resolveForkCommitBudget({ commitLimitMB: 3000, share: 0.4, reserveMB: 4096 })
  assert.equal(exhausted.ok, false)
  assert.equal(exhausted.limitMB, 0)
  assert.equal(exhausted.reason, 'host-reserve-consumes-limit')
})

test('v3.8.13: evaluateForkCommitBudget flags aggregate overage and remaining reserve', () => {
  const ok = evaluateForkCommitBudget({ commitLimitMB: 8192, forkTotalMB: 3000, share: 0.4, reserveMB: 4096 })
  assert.equal(ok.ok, true)
  assert.equal(ok.over, false)
  assert.equal(ok.remainingMB, 277)

  const over = evaluateForkCommitBudget({ commitLimitMB: 8192, forkTotalMB: 3500, share: 0.4, reserveMB: 4096 })
  assert.equal(over.over, true)
  assert.equal(over.remainingMB, 0)
})

test('v3.8.13: Config accepts legacy maxForks>1 but defaults to 1; apply clamps', () => {
  assert.equal(orchestrator.Config({}).maxForks, 1)
  assert.equal(orchestrator.Config({ maxForks: 1 }).maxForks, 1)
  // Legacy profile patches may still say 8; rejecting them makes the whole
  // plugin invalid. Accept at the schema boundary, then clamp in apply().
  assert.equal(orchestrator.Config({ maxForks: 8 }).maxForks, 8)
})

test('v3.8.13: production apply ignores maxForks/allowMultiFork and reports limit 1', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-v3813-max-'))
  const ctx = makeCtx({ services: { [SERVICE.forker]: { async spawn() { throw new Error('no-spawn') }, status() { return { running: false } }, list() { return [] } }, webServer: makeWebServerStub() } })
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      routes: { enabled: false },
      authToken: TEST_AUTH_TOKEN,
      allowMultiFork: true,
      maxForks: 8,
    })
    const svc = ctx.get(SERVICE.orchestrator)
    assert.equal(svc.status().tasks.max, 1)
  } finally {
    try { ctx.dispose() } catch { /* ignore */ }
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('v3.8.13: orchestrator wires reserve into config, pre-spawn gate, 5s tick, and memory watchdog', () => {
  const source = fs.readFileSync(new URL('../src/plugins/orchestrator.mjs', import.meta.url), 'utf8')
  assert.match(source, /forkCommitHostReserveMB: z\.number\(\)[\s\S]{0,120}default\(HOST_COMMIT_RESERVE_MB_DEFAULT\)/)
  assert.match(source, /source: 'create-fork', failClosed: true/)
  assert.match(source, /source: 'host-watchdog-5s'/)
  assert.match(source, /reserveMB: cfg\.forkCommitHostReserveMB/)
  assert.match(source, /forkCommitLimitMB: budget\.limitMB/)
})

test('v3.8.13: every spawn path records a provisional PID timestamp before CIM', () => {
  const source = fs.readFileSync(new URL('../src/plugins/orchestrator.mjs', import.meta.url), 'utf8')
  const assignments = source.match(/task\.pidStartedAt = Number\(started\.pid\) > 0 \? nowMs\(\) : null/g) ?? []
  assert.equal(assignments.length, 3, 'create/restore/autostart must all stamp the PID immediately')
  assert.match(source, /pidStartedAtSource = Number\(started\.pid\) > 0 \? 'spawn-provisional' : null/)
  assert.match(source, /const provisionalStartedAt = Number\(task\?\.pidStartedAt\)/)
  assert.match(source, /task\.pidStartedAtSource = task\.pidStartedAt \? 'spawn-provisional' : null/)
})

test('v3.8.13: pagefile absence is advisory and cannot force Safe Mode', async () => {
  const low = orchestrator.decidePagefileBootPolicy({ ok: true, hasPageFile: false, pageFileMB: 0, commitFreeMB: 1024, physicalFreeMB: 1024 })
  assert.equal(low.safeMode, false)
  assert.equal(low.advisory, 'pagefile-missing')
  assert.equal(low.reason, 'pagefile-missing-low-free')
  assert.equal(orchestrator.pagefileRequiresSafeMode({ ok: true, hasPageFile: false, pageFileMB: 0 }), false)
  assert.equal(orchestrator.Config({}).memoryMinFreeMB, 3000)
})
