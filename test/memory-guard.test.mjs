// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateMemoryGuard, memoryGuardDefaults, selectProcessTree, sumProcessTree } from '../src/lib/memory-guard.mjs'

test('memory guard refuses when Windows CommitFree is below threshold', () => {
  const memory = { ok: true, supported: true, commitLimitMB: 32476, commitFreeMB: 1024 }
  const low = evaluateMemoryGuard(memory, { minFreeMB: 4096 })
  assert.equal(low.ok, false)
  assert.equal(low.error, 'memory-low')
  assert.equal(low.commitFreeMB, 1024)
  const high = evaluateMemoryGuard({ ...memory, commitFreeMB: 8192 }, { minFreeMB: 4096 })
  assert.equal(high.ok, true)
})

test('memory guard skips unsupported platform but defaults are safe', () => {
  assert.equal(evaluateMemoryGuard({ ok: true, supported: false }).ok, true)
  assert.equal(memoryGuardDefaults().minFreeMB, 4096)
  assert.equal(memoryGuardDefaults().singleActiveFork, true)
})

test('process tree selection includes descendants, not siblings', () => {
  const rows = [
    { pid: 10, ppid: 1, commitMB: 100, workingSetMB: 50 },
    { pid: 11, ppid: 10, commitMB: 200, workingSetMB: 100 },
    { pid: 12, ppid: 11, commitMB: 300, workingSetMB: 150 },
    { pid: 20, ppid: 1, commitMB: 999, workingSetMB: 999 },
  ]
  const tree = selectProcessTree(rows, 10)
  assert.deepEqual(tree.map((row) => row.pid).sort((a, b) => a - b), [10, 11, 12])
  const total = sumProcessTree(tree)
  assert.equal(total.count, 3)
  assert.equal(total.workingSetMB, 300)
  assert.equal(total.commitMB, 600)
  assert.deepEqual([...total.pids].sort((a, b) => a - b), [10, 11, 12])
})
