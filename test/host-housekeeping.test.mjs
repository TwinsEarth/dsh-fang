// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { cleanupWatchdogFiles, pruneHostCrashHistory } from '../src/lib/host-housekeeping.mjs'

test('host crash history is capped and expired entries are dropped', () => {
  const now = 1_700_000_000_000
  const day = 24 * 60 * 60 * 1000
  const crashes = Array.from({ length: 60 }, (_, i) => ({ at: now - i * 60_000, n: i }))
  crashes.push({ at: now - 40 * day, n: 'expired' })
  const out = pruneHostCrashHistory(crashes, { now, maxEntries: 50, retentionDays: 30 })
  assert.equal(out.input, 61)
  assert.equal(out.expired, 1)
  assert.equal(out.dropped, 10)
  assert.equal(out.crashes.length, 50)
  assert.equal(out.crashes[0].n, 49)
  assert.equal(out.crashes.at(-1).n, 0)
  assert.equal(out.changed, true)
})

test('watchdog cleanup keeps current and live files and recycles old dead files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-watchdog-'))
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const write = (pid, at) => {
    const file = path.join(root, `watchdog-${pid}.json`)
    fs.writeFileSync(file, JSON.stringify({ hostPid: pid, at: new Date(at).toISOString(), clean: false }))
  }
  const current = process.pid
  write(current, now)
  write(1, now - 10 * day)
  write(2, now - 60_000)
  write(4, now - 30_000)
  write(3, now - 30 * day) // live PID must not be moved
  const out = cleanupWatchdogFiles({
    dataDir: root,
    currentPid: current,
    maxFiles: 1,
    retentionDays: 7,
    minAgeMs: 0,
    now,
    isPidAlive: (pid) => pid === 3,
  })
  assert.equal(out.ok, true)
  assert.equal(out.moved, 2)
  assert.equal(out.kept, 1)
  assert.ok(fs.existsSync(path.join(root, `watchdog-${current}.json`)))
  assert.ok(fs.existsSync(path.join(root, 'watchdog-3.json')))
  assert.equal(fs.existsSync(path.join(root, 'watchdog-2.json')), false)
  assert.ok(fs.existsSync(path.join(root, 'watchdog-4.json')))
  assert.equal(fs.existsSync(path.join(root, 'watchdog-1.json')), false)
  const recycled = fs.readdirSync(out.recycleDir)
  assert.equal(recycled.length, 2)
  fs.rmSync(root, { recursive: true, force: true })
})

test('watchdog maxFiles=0 still keeps the current host file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-watchdog-zero-'))
  const current = process.pid
  fs.writeFileSync(path.join(root, `watchdog-${current}.json`), '{}')
  fs.writeFileSync(path.join(root, 'watchdog-8.json'), JSON.stringify({ hostPid: 8, at: new Date().toISOString() }))
  const out = cleanupWatchdogFiles({ dataDir: root, currentPid: current, maxFiles: 0, retentionDays: 7, minAgeMs: 0, isPidAlive: () => false })
  assert.equal(out.moved, 1)
  assert.equal(out.kept, 0)
  assert.ok(fs.existsSync(path.join(root, `watchdog-${current}.json`)))
  fs.rmSync(root, { recursive: true, force: true })
})

test('watchdog cleanup is a no-op when all dead files are within cap and retention', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-watchdog-ok-'))
  const current = process.pid
  fs.writeFileSync(path.join(root, `watchdog-${current}.json`), '{}')
  fs.writeFileSync(path.join(root, 'watchdog-9.json'), JSON.stringify({ hostPid: 9, at: new Date().toISOString() }))
  const out = cleanupWatchdogFiles({ dataDir: root, currentPid: current, maxFiles: 5, retentionDays: 7, minAgeMs: 0, isPidAlive: () => false })
  assert.equal(out.moved, 0)
  assert.equal(out.kept, 1)
  fs.rmSync(root, { recursive: true, force: true })
})
