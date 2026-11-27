// SPDX-License-Identifier: AGPL-3.0-or-later
// P3 structural smoke: the fallback compose row, the package root, and the
// independent watchdog sidecar. These are entry/exit surfaces that are easy to
// break without a direct test even when the plugin modules themselves are green.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { Config as ComposeConfig, _modules as composeModules, apply as applyCompose } from '../src/compose.mjs'
import * as root from '../src/index.mjs'
import * as orchestrator from '../src/plugins/orchestrator.mjs'

test('compose Config validates nested child configs and keeps the 17-row map', () => {
  assert.ok(ComposeConfig)
  assert.throws(() => ComposeConfig({ forker: { maxForks: 101 } }), /maxForks|100/)
  assert.equal(typeof applyCompose, 'function')
  assert.deepEqual(Object.keys(composeModules).sort(), [
    'adapter', 'approver', 'auditor', 'bufferKeeper', 'decisionCenter', 'forker', 'healer',
    'hotReloader', 'orchestrator', 'restartGuard', 'router', 'scorer', 'sessionBridge',
    'sessionCatalog', 'sessionRouter', 'sessionSync', 'umbrella',
  ].sort())
  for (const mod of Object.values(composeModules)) assert.equal(typeof mod.apply, 'function')
})

test('package root re-exports the orchestrator entry', () => {
  assert.equal(root.name, orchestrator.name)
  assert.equal(root.Config, orchestrator.Config)
  assert.equal(root.apply, orchestrator.apply)
  assert.deepEqual(root.inject, orchestrator.inject)
})

test('watchdog-sidecar exits on host stop and reports skipped targets without identity', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-sidecar-'))
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } })
  const file = path.join(dir, 'watchdog.json')
  fs.writeFileSync(file, JSON.stringify({
    hostPid: 999999,
    stop: true,
    targets: [{ pid: 999999, kind: 'fork', taskId: 'fake-task' }],
  }))
  const script = path.join(import.meta.dirname, '..', 'src', 'lib', 'watchdog-sidecar.mjs')
  const result = spawnSync(process.execPath, [script, file], { timeout: 10_000, windowsHide: true })
  assert.equal(result.status, 0, String(result.stderr ?? ''))
  const out = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(out.stop, true)
  assert.equal(out.stopReason, 'host-clean-stop')
  assert.ok(out.stoppedAt)
  assert.equal(out.skipped.length, 1)
  assert.equal(out.skipped[0].error, 'target-identity-missing')
})
