// SPDX-License-Identifier: AGPL-3.0-or-later
// Safe Mode pagefile gate — pure regression tests. The Windows probe is
// exercised separately; these cases simulate its output shape so CI can never
// regress to "checkbox only".
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { makeCtx, makeWebServerStub, TEST_AUTH_TOKEN } from './helpers.mjs'
import { SERVICE } from '../src/kernel/index.mjs'
import * as orchestrator from '../src/plugins/orchestrator.mjs'
import { evaluateSafeModeReset, pagefileRequiresSafeMode } from '../src/plugins/orchestrator.mjs'

const healthy = {
  ok: true,
  supported: true,
  hasPageFile: true,
  pageFileMB: 8192,
  commitLimitMB: 32768,
  commitFreeMB: 12000,
}

test('v3.8.13: Safe Mode reset treats a missing pagefile as advisory, not a hard block', () => {
  const out = evaluateSafeModeReset({ ...healthy, hasPageFile: false, pageFileMB: 0 }, { hostCriticalFreeMB: 4096 })
  assert.equal(out.ok, true)
  assert.equal(out.pagefileMissing, true)
  assert.equal(out.advisory, 'pagefile-missing')
})

test('Safe Mode reset refuses Commit below hostCriticalFreeMB', () => {
  const out = evaluateSafeModeReset({ ...healthy, commitFreeMB: 2000 }, { hostCriticalFreeMB: 4096 })
  assert.equal(out.ok, false)
  assert.equal(out.error, 'commit-low')
  assert.equal(out.minFreeMB, 4096)
})

test('Safe Mode reset allows only a real pagefile plus Commit at/above critical threshold', () => {
  assert.equal(evaluateSafeModeReset(healthy, { hostCriticalFreeMB: 4096 }).ok, true)
  assert.equal(evaluateSafeModeReset({ ...healthy, commitFreeMB: 4096 }, { hostCriticalFreeMB: 4096 }).ok, true)
  assert.equal(evaluateSafeModeReset({ ...healthy, commitFreeMB: 4095 }, { hostCriticalFreeMB: 4096 }).ok, false)
})

test('v3.8.13: boot precheck never forces Safe Mode for an empty Win32_PageFileUsage', () => {
  assert.equal(pagefileRequiresSafeMode({ ok: true, supported: true, hasPageFile: false, pageFileMB: 0 }), false)
  assert.equal(pagefileRequiresSafeMode({ ok: true, supported: true, hasPageFile: true, pageFileMB: 0 }), false)
  assert.equal(pagefileRequiresSafeMode(healthy), false)
  assert.equal(pagefileRequiresSafeMode({ ok: false, error: 'memory-probe-threw' }), false)
})

test('orchestrator wires advisory boot gate before autostart and uses hostCritical threshold', () => {
  const source = fs.readFileSync(new URL('../src/plugins/orchestrator.mjs', import.meta.url), 'utf8')
  assert.match(source, /pagefile-missing-advisory/)
  assert.match(source, /async autostartForks\(input = \{\}\) \{[\s\S]{0,500}await bootPagefileGate[\s\S]{0,300}if \(safeMode\)/)
  assert.match(source, /hostCriticalFreeMB: cfg\.hostCriticalFreeMB/)
})

test('Safe Mode blocks autostart before any fork/browser spawn', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-safe-pagefile-'))
  const webServer = makeWebServerStub()
  const calls = { spawn: 0 }
  const forker = {
    async spawn() { calls.spawn += 1; throw new Error('must-not-spawn') },
    status() { return { running: false } },
    async provision() { return { ok: false, error: 'must-not-provision' } },
    async stop() { return { ok: true } },
    list() { return [] },
    logs() { return '' },
  }
  const ctx = makeCtx({ services: { [SERVICE.forker]: forker, webServer } })
  try {
    fs.writeFileSync(path.join(dataRoot, 'safe-mode.json'), JSON.stringify({ safeMode: true, reason: 'pagefile-missing' }, null, 2))
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      memoryGuard: false,
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const svc = ctx.get(SERVICE.orchestrator)
    assert.equal(svc.safeModeStatus().safeMode, true)
    const out = await svc.autostartForks()
    assert.equal(out.ok, false)
    assert.equal(out.error, 'safe-mode')
    assert.equal(calls.spawn, 0, 'autostart must never spawn while Safe Mode is active')
  } finally {
    try { ctx.dispose() } catch { /* ignore */ }
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
})
