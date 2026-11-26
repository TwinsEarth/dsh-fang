// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { buildJobHostArgs } from '../src/lib/job-object.mjs'

const root = path.resolve(import.meta.dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const orchestrator = read('src/plugins/orchestrator.mjs')
const browserGuard = read('src/lib/browser-guard.mjs')
const client = read('client.js')
const forker = read('src/plugins/forker.mjs')
const jobObject = read('src/lib/job-object.mjs')
const jobHostC = read('native/win32/fang-job-host.c')

test('v3.8.5: CDP sampling defaults to 15s and keeps precise metrics', () => {
  assert.match(orchestrator, /browserCdpSampleIntervalMs: z\.number\(\)\.min\(15000\)\.max\(600000\)\.default\(15000\)/)
  assert.match(orchestrator, /browserHeapLimitMB/)
  assert.match(orchestrator, /fork-browser-auto-close/)
  assert.match(browserGuard, /Performance\.getMetrics/)
  assert.match(browserGuard, /Memory\.getDOMCounters/)
  assert.match(browserGuard, /Runtime\.getHeapUsage/)
  assert.match(orchestrator, /heapLimitMB: autoCloseDecision\.limits\.jsHeapMB/)
  assert.match(orchestrator, /quarantineTask\(task, autoCloseDecision\.reason\)/)
})

test('v3.8.5: hidden-tab pause is opt-in and uses CDP lifecycle freeze/active', () => {
  assert.match(orchestrator, /pauseHiddenTab: z\.boolean\(\)\.default\(false\)/)
  assert.match(orchestrator, /visibility === 'hidden' \? 'frozen' : 'active'/)
  assert.match(orchestrator, /setManagedBrowserLifecycle\(browser\.port, desired\)/)
  assert.match(browserGuard, /Page\.setWebLifecycleState/)
  assert.match(browserGuard, /state === 'frozen' \? 'frozen' : 'active'/)
})

test('v3.8.5: mother panel renders only the active task in full, others as summaries', () => {
  assert.match(client, /activeTaskId: ''/)
  assert.match(client, /function renderForkSummary\(/)
  assert.match(client, /taskId !== String\(S\.activeTaskId\)/)
  assert.match(client, /String\(task\.taskId\) === String\(S\.activeTaskId\)/)
  assert.match(client, /app\.setActiveTask\(taskId\)/)
  assert.match(client, /切换为当前任务；只加载这一个任务的完整卡片/)
})

test('v3.8.5: client caches have hard caps and archive releases them', () => {
  assert.match(client, /const CACHE_LIMITS = Object\.freeze/)
  assert.match(client, /taskRows: 200/)
  assert.match(client, /motherSessions: 200/)
  assert.match(client, /forkSessionTasks: 16/)
  assert.match(client, /forkSessionItems: 80/)
  assert.match(client, /releaseTaskCache\(task\.taskId\)/)
  assert.match(client, /S\.forkSessions\.delete\(id\)/)
  assert.match(client, /clampCacheText\(detail\.logs, CACHE_LIMITS\.logChars\)/)
})

test('v3.8.5: Job Object helper carries process/job memory limits', () => {
  const args = buildJobHostArgs({
    spec: { command: 'node', args: ['worker.mjs'] },
    homeDir: path.join(root, '.tmp-job-home'),
    memoryMb: 2048,
    totalMemoryMb: 4096,
  })
  assert.ok(args.includes('--job-process-memory-mb'))
  assert.equal(args[args.indexOf('--job-process-memory-mb') + 1], '2048')
  assert.ok(args.includes('--job-memory-mb'))
  assert.equal(args[args.indexOf('--job-memory-mb') + 1], '4096')
  assert.match(forker, /jobProcessMemoryMB: z\.natural\(\)/)
  assert.match(forker, /jobTotalMemoryMB: z\.natural\(\)/)
  assert.match(forker, /memoryMb: cfg\.jobProcessMemoryMB/)
  assert.match(forker, /totalMemoryMb: cfg\.jobTotalMemoryMB/)
  assert.match(jobHostC, /JOB_OBJECT_LIMIT_PROCESS_MEMORY/)
  assert.match(jobHostC, /JOB_OBJECT_LIMIT_JOB_MEMORY/)
  assert.match(jobHostC, /ProcessMemoryLimit/)
  assert.match(jobHostC, /JobMemoryLimit/)
})
