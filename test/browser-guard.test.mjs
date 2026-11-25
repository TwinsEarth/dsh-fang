// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildPriorityTreeScript, findBrowserPath, freePort, isLoweredPriorityClass, isPidAlive, lowerProcessPriority, summarizePriorityRows } from '../src/lib/browser-guard.mjs'

const orchestrator = fs.readFileSync(new URL('../src/plugins/orchestrator.mjs', import.meta.url), 'utf8')

test('browser guard recognizes current pid and rejects invalid pid', () => {
  assert.equal(isPidAlive(process.pid), true)
  assert.equal(isPidAlive(0), false)
  assert.equal(isPidAlive(-1), false)
})

test('priority summary counts root, lowered children, skipped and missing rows', () => {
  const rows = [
    { Id: 100, Name: 'msedge.exe', Exists: true, Before: 'Normal', After: 'BelowNormal', Changed: true, Skipped: false, Error: null },
    { Id: 101, Name: 'msedge.exe', Exists: true, Before: 'BelowNormal', After: 'BelowNormal', Changed: false, Skipped: true, Error: null },
    { Id: 102, Name: 'msedge.exe', Exists: false, Before: '', After: '', Changed: false, Skipped: false, Error: 'not-found' },
    { Id: 103, Name: 'msedge.exe', Exists: true, Before: 'High', After: 'High', Changed: false, Skipped: false, Error: 'access-denied' },
  ]
  const summary = summarizePriorityRows(rows, 100)
  assert.equal(summary.ok, true)
  assert.equal(summary.partial, true)
  assert.equal(summary.count, 4)
  assert.equal(summary.lowered, 2)
  assert.equal(summary.changed, 1)
  assert.equal(summary.alreadyLow, 1)
  assert.equal(summary.missing, 1)
  assert.equal(summary.failed, 1)
  assert.equal(summary.notLowered, 1)
  assert.equal(summary.rootOnly, false)
})

test('priority summary fails closed when the root is missing', () => {
  const summary = summarizePriorityRows([{ Id: 200, Exists: false, Error: 'not-found' }], 200)
  assert.equal(summary.ok, false)
  assert.equal(summary.partial, false)
  assert.equal(summary.error, 'root-not-found')
  assert.equal(summary.missing, 1)
})

test('priority tree script enumerates descendants and samples before/after', () => {
  const script = buildPriorityTreeScript(4321)
  assert.match(script, /\$root = 4321/)
  assert.match(script, /Get-CimInstance Win32_Process/)
  assert.match(script, /ParentProcessId/)
  assert.match(script, /System\.Collections\.Generic\.Stack\[int\]/)
  assert.match(script, /PriorityClass/)
  assert.match(script, /BelowNormal/)
  assert.match(script, /Before=\$before/)
  assert.match(script, /After=\$after/)
})

test('priority classes below normal are recognized case-insensitively', () => {
  assert.equal(isLoweredPriorityClass('BelowNormal'), true)
  assert.equal(isLoweredPriorityClass('IDLE'), true)
  assert.equal(isLoweredPriorityClass('Normal'), false)
  assert.equal(isLoweredPriorityClass('AboveNormal'), false)
})

test('non-Windows priority lowering is explicitly unsupported', async () => {
  if (process.platform === 'win32') return
  assert.deepEqual(await lowerProcessPriority(process.pid), { ok: false, error: 'unsupported' })
})

test('browser launch stores the sampled priority summary and audits it', () => {
  assert.match(orchestrator, /task\.browser = \{[\s\S]{0,240}priority/)
  assert.match(orchestrator, /fork-browser-priority-failed/)
  assert.match(orchestrator, /fork-browser-priority-partial/)
  assert.match(orchestrator, /fork-browser-priority'/)
})

test('browser path resolver returns an existing executable or empty string', () => {
  const path = findBrowserPath('')
  assert.equal(typeof path, 'string')
  if (path) assert.equal(path.toLowerCase().endsWith('.exe'), true)
})

test('browser path resolver fails closed on an explicit stale path', () => {
  assert.equal(findBrowserPath('Z:\\no-such-fang-browser\\msedge.exe'), '')
})

test('free port picks a usable loopback port', async () => {
  const port = await freePort(19620, 19640)
  if (process.platform === 'win32') assert.ok(port > 0)
  else assert.ok(port >= 0)
})
