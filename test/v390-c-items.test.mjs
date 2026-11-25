// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const orchestrator = read('src/plugins/orchestrator.mjs')
const browserGuard = read('src/lib/browser-guard.mjs')
const client = read('client.js')

test('C1 host metrics persist every 5s', () => {
  assert.match(orchestrator, /export const HOST_STATE_WRITE_INTERVAL_MS = 5000/)
  assert.match(orchestrator, /setInterval\(writeHostHeartbeat, HOST_STATE_WRITE_INTERVAL_MS\)/)
})

test('C2 crash-loop window is configurable and flows to status/UI', () => {
  assert.match(orchestrator, /hostCrashWindowMinutes: z\.number\(\)\.min\(1\)\.max\(1440\)\.default\(10\)/)
  assert.match(orchestrator, /const hostCrashWindowMinutes = Math\.max\(1, Math\.min\(1440, Math\.round\(Number\(cfg\.hostCrashWindowMinutes\) \|\| 10\)\)\)/)
  assert.match(orchestrator, /crashPrune\.crashes\.filter\(\(item\) => now - Number\(item\.at\) <= hostCrashWindowMs\)/)
  assert.match(orchestrator, /windowMinutes: hostCrashWindowMinutes/)
  assert.match(orchestrator, /windowMinutes: hostCrashWindowMinutes,\n/)
  assert.match(client, /function safeModeReasonText\(reason, windowMinutes = 10\)/)
  assert.match(client, /const crashLoop = \/\^crash-loop-\(\\d\+\)m\$\/\.exec\(value\)/)
  assert.match(client, /safeModeReasonText\(S\.safeMode\.data\.reason, S\.safeMode\.data\.windowMinutes\)/)
  assert.match(client, /safeModeReasonText\(modal\.reason, modal\.windowMinutes\)/)
})

test('C3 allTasks sweeps archived tasks without demoting archive state', () => {
  assert.match(orchestrator, /if \(!allTasks && \(archived \|\| \(task\.status !== TASK_STATUS\.READY && task\.status !== TASK_STATUS\.RUNNING\)\)\) continue/)
  assert.match(orchestrator, /preserveArchived: archived/)
  assert.match(orchestrator, /archivedSwept \+= 1/)
  assert.match(orchestrator, /status: task\.status, pid: null, port: null, url: null, lastError: archived && preserveArchived/)
  assert.match(orchestrator, /if \(task\.status !== TASK_STATUS\.ARCHIVED\) task\.status = TASK_STATUS\.FAILED/)
})

test('C4 multi-fork confirmation exists in HTTP and UI but never lifts hard limit', () => {
  assert.match(orchestrator, /export const MULTI_FORK_CONFIRM_TOKEN = 'MULTI-FORK'/)
  assert.match(orchestrator, /multiForkStatus\(\)/)
  assert.match(orchestrator, /confirmMultiFork\(input = \{\}\)/)
  assert.match(orchestrator, /\/api\/forks\/multi-fork/)
  assert.match(orchestrator, /enabled: false,\n\s+hardLimit: HARD_MAX_FORKS/)
  assert.match(client, /async function confirmMultiFork\(\)/)
  assert.match(client, /\/fang\/api\/forks\/multi-fork/)
  assert.match(client, /expected: 'MULTI-FORK'/)
  assert.match(client, /confirmMultiFork,\n/)
  assert.match(client, /多开二次确认（仍限 1）/)
})

test('C5 process priority exposes an Idle tier through both launch and call sites', () => {
  assert.match(orchestrator, /processPriority: z\.union\(\[z\.const\('below-normal'\), z\.const\('idle'\)\]\)\.default\('below-normal'\)/)
  assert.match(orchestrator, /const processPriorityClass = cfg\.processPriority === 'idle' \? 'Idle' : 'BelowNormal'/)
  assert.match(orchestrator, /priorityClass: processPriorityClass,/)
  assert.equal((orchestrator.match(/lowerProcessPriority\(task\.pid, \{ priorityClass: processPriorityClass \}\)/g) || []).length, 3)
  assert.match(browserGuard, /PROCESS_PRIORITY_CLASSES/)
  assert.match(browserGuard, /normalizePriorityClass/)
  assert.match(browserGuard, /\$p\.PriorityClass = "\$\{targetClass\}"/)
})

test('C6 migration report call no longer depends on the app API surface', () => {
  assert.match(client, /onClick: \(\) => openMigrationReport\(\)/)
  assert.doesNotMatch(client, /app\.openMigrationReport\(\)/)
  assert.doesNotMatch(client, /typeof app\.openMigrationReport !== 'function'/)
  assert.match(client, /probeMemory, openPagefileHelp, openMigrationReport, openDiskHygiene/)
})
