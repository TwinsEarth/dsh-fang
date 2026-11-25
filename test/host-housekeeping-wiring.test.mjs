// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src/plugins/orchestrator.mjs'), 'utf8')

test('orchestrator exposes P2#4/#5 config and wires the housekeeping module', () => {
  assert.match(source, /hostCrashMaxEntries: z\.number\(\)\.min\(10\)\.max\(1000\)\.default\(50\)/)
  assert.match(source, /hostCrashRetentionDays: z\.number\(\)\.min\(1\)\.max\(365\)\.default\(30\)/)
  assert.match(source, /watchdogRetentionDays: z\.number\(\)\.min\(1\)\.max\(365\)\.default\(7\)/)
  assert.match(source, /watchdogMaxFiles: z\.number\(\)\.min\(0\)\.max\(200\)\.default\(20\)/)
  assert.match(source, /pruneHostCrashHistory\(crashHistory,/)
  assert.match(source, /cleanupWatchdogFiles\(\{/)
  assert.match(source, /maxFiles: cfg\.watchdogMaxFiles/)
  assert.match(source, /retentionDays: cfg\.watchdogRetentionDays/)
  assert.match(source, /'recycle', 'watchdog'/)
})

test('crash-loop decision still uses the ten-minute window after the cap', () => {
  assert.match(source, /now - Number\(item\.at\) <= 10 \* 60_000/)
  assert.match(source, /recent\.length >= 2/)
})
