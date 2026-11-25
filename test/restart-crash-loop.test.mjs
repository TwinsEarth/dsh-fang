// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v3.3.0 崩溃循环制动：restart-guard 只有人工解除后才重新允许交接执行权。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { makeCtx } from './helpers.mjs'
import { SERVICE } from '../src/kernel/index.mjs'
import { apply } from '../src/plugins/restart-guard.mjs'
import { clearCrashLoopSafeMode, detectCrashLoop, parseCrashLedgerText } from '../src/lib/restart-contract.mjs'
import { verifyChain } from '../src/kernel/ledger.mjs'

function temp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)) }
function rm(dir) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } }

test('crash loop detection: threshold inside the window, ignores stale/malformed rows', () => {
  const now = 1_800_000_000_000
  const records = [{ at: now - 5000 }, { at: now - 4000 }, { at: now - 3000 }]
  assert.equal(detectCrashLoop(records, { now }).active, true)
  assert.equal(detectCrashLoop(records, { now, threshold: 4 }).active, false)
  assert.equal(detectCrashLoop([{ at: now - 10 * 60_000 }], { now }).active, false)
  assert.deepEqual(parseCrashLedgerText('{"at":1}\nbroken\n{"at":2}\n').map((item) => item.at), [1, 2])
  assert.equal(detectCrashLoop('{"at":1}\nbroken\n', { now: 1 }).active, false)
})

test('restart guard: a crash loop disarms supervisor handoff until clearSafeMode archives the ledger', () => {
  const dataRoot = temp('fang-crash-loop-')
  const stateDir = path.join(dataRoot, 'restart')
  fs.mkdirSync(stateDir, { recursive: true })
  const now = Date.now()
  fs.writeFileSync(path.join(stateDir, 'runtime-crash.jsonl'),
    [now - 3000, now - 2000, now - 1000].map((at) => JSON.stringify({ at, origin: 'uncaughtException', message: 'boom' })).join('\n') + '\n')
  const previous = process.env.FANG_RESTART_SUPERVISOR
  process.env.FANG_RESTART_SUPERVISOR = 'test-watchdog'
  const ctx = makeCtx()
  try {
    apply(ctx, { dataRoot, mode: 'enforce', allowProcessRestart: true })
    const guard = ctx.get(SERVICE.restart)
    const policy = guard.policy()
    assert.equal(policy.safeMode.active, true)
    assert.equal(policy.safeMode.reason, 'crash-loop')
    assert.equal(policy.crashLoop.active, true)
    assert.equal(policy.executionArmed, false, 'crash loop must veto supervisor handoff')
    assert.equal(guard.selfCheck().findings.some((finding) => finding.code === 'safe-mode-active' && finding.level === 'block'), true)
    const cleared = guard.clearSafeMode({ by: 'tester', note: 'after investigating' })
    assert.equal(cleared.ok, true)
    assert.equal(cleared.cleared, true)
    assert.ok(cleared.archived && fs.existsSync(cleared.archived), 'crash ledger must be archived, not deleted')
    const after = guard.policy()
    assert.equal(after.safeMode.active, false)
    assert.equal(after.crashLoop.active, false)
    assert.equal(after.executionArmed, true, 'manual clear re-arms the gate (ledger archived)')
  } finally {
    try { ctx.dispose() } catch { /* ignore */ }
    if (previous === undefined) delete process.env.FANG_RESTART_SUPERVISOR
    else process.env.FANG_RESTART_SUPERVISOR = previous
    rm(dataRoot)
  }
})

test('offline clearCrashLoopSafeMode archives evidence and writes a chained audit record', () => {
  const dataDir = temp('fang-clear-safe-')
  try {
    fs.mkdirSync(path.join(dataDir, 'restart'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'restart', 'safe-mode.json'), JSON.stringify({ active: true, reason: 'crash-loop', at: Date.now() }))
    fs.writeFileSync(path.join(dataDir, 'restart', 'runtime-crash.jsonl'), JSON.stringify({ at: Date.now(), message: 'boom' }) + '\n')
    const result = clearCrashLoopSafeMode(dataDir, { by: 'tester', note: 'investigated' })
    assert.equal(result.ok, true)
    assert.equal(result.cleared, true)
    assert.ok(result.archived && fs.existsSync(result.archived), 'crash ledger archived, never deleted')
    const chain = verifyChain(path.join(dataDir, 'audit.jsonl'))
    assert.equal(chain.ok, true)
    assert.equal(chain.count, 1)
    const again = clearCrashLoopSafeMode(dataDir)
    assert.equal(again.ok, true)
    assert.equal(again.cleared, false)
  } finally { rm(dataDir) }
})

test('restart guard: below-threshold crashes stay warn-only, never safe mode', () => {
  const dataRoot = temp('fang-crash-one-')
  const stateDir = path.join(dataRoot, 'restart')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'runtime-crash.jsonl'), JSON.stringify({ at: Date.now() - 1000, message: 'one' }) + '\n')
  const ctx = makeCtx()
  try {
    apply(ctx, { dataRoot })
    const guard = ctx.get(SERVICE.restart)
    assert.equal(guard.policy().safeMode.active, false)
    assert.equal(guard.policy().crashLoop.active, false)
    assert.equal(guard.selfCheck().findings.some((finding) => finding.code === 'crash-loop'), false)
  } finally {
    try { ctx.dispose() } catch { /* ignore */ }
    rm(dataRoot)
  }
})
