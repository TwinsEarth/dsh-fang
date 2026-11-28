// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildProcessTableScript, evaluateMemoryGuard, memoryGuardDefaults, parsePowerShellJson, parseProcessCreationDate, readProcessIdentity, readProcessTable, selectProcessTree, sumProcessTree } from '../src/lib/memory-guard.mjs'

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
  assert.equal(memoryGuardDefaults().singleActiveFork, false)
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

test('CIM CreationDate parses ISO, WMI /Date(ms)/ and numeric epoch', () => {
  const iso = Date.UTC(2026, 10, 25, 2, 0, 0)
  assert.equal(parseProcessCreationDate('2026-11-25T02:00:00.000Z'), iso)
  assert.equal(parseProcessCreationDate(`/Date(${iso})/`), iso)
  assert.equal(parseProcessCreationDate(String(iso)), iso)
  assert.equal(parseProcessCreationDate(''), null)
  assert.equal(parseProcessCreationDate('not-a-date'), null)
})


test('readProcessIdentity matches platform support (Windows row, non-Windows null)', async () => {
  const identity = await readProcessIdentity(process.pid)
  assert.equal(identity.ok, true)
  if (process.platform === 'win32') {
    assert.equal(identity.supported, true)
    assert.ok(identity.row, 'Windows should return an identity row')
  } else {
    assert.equal(identity.supported, false)
    assert.equal(identity.row, null)
  }
})

test('lite process table query omits identity-only fields', () => {
  const script = buildProcessTableScript({ detailed: false })
  assert.match(script, /Get-CimInstance Win32_Process/)
  assert.match(script, /WorkingSetSize,PageFileUsage/)
  assert.doesNotMatch(script, /CommandLine/)
  assert.doesNotMatch(script, /CreationDate/)
})

test('full process table query keeps identity fields for orphan cleanup', () => {
  const script = buildProcessTableScript({ detailed: true })
  assert.match(script, /CommandLine/)
  assert.match(script, /CreationDate/)
})

test('process table JSON survives PowerShell warnings before an array', () => {
  const output = 'WARNING: something on stdout\n[{"ProcessId":1,"Name":"node"},{"ProcessId":2,"Name":"pwsh"}]\n'
  assert.deepEqual(parsePowerShellJson(output), [
    { ProcessId: 1, Name: 'node' },
    { ProcessId: 2, Name: 'pwsh' },
  ])
  assert.deepEqual(parsePowerShellJson('warning\n{"ProcessId":3}'), { ProcessId: 3 })
  assert.equal(parsePowerShellJson(''), null)
})

test('readProcessTable reuses a cached lite snapshot on Windows', async () => {
  if (process.platform !== 'win32') return
  const first = await readProcessTable({ detailed: false, cacheMs: 1000 })
  const second = await readProcessTable({ detailed: false, cacheMs: 1000 })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.cached, true)
  assert.equal(second.rows.length, first.rows.length)
})
