// SPDX-License-Identifier: AGPL-3.0-or-later
// 2026-11-22：宿主 fs.watch EPERM 不得变成 uncaughtException 杀死 DSH host。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { installWatchGuard, uninstallWatchGuard, watchGuardInstalled } from '../src/lib/watch-guard.mjs'

test('watch guard downgrades fs.watch error events instead of crashing the host', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-watch-guard-'))
  const warnings = []
  try {
    const installed = installWatchGuard({ logger: { warn: (line) => warnings.push(String(line)) } })
    assert.equal(installed.ok, true)
    assert.equal(watchGuardInstalled(), true)
    const watcher = fs.watch(root)
    assert.doesNotThrow(() => watcher.emit('error', Object.assign(new Error('EPERM: operation not permitted, watch'), { code: 'EPERM' })))
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /downgraded: EPERM/)
    watcher.close()
  } finally {
    uninstallWatchGuard()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
