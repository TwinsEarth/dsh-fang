// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BROWSER_AUTO_CLOSE_DEFAULTS, effectiveBrowserAutoCloseLimits, evaluateBrowserAutoClose } from '../src/lib/browser-auto-close.mjs'
import { classifyCloseReason } from '../src/lib/browser-close-reason.mjs'
import { decideIdleClose } from '../src/lib/fork-activity.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const read = (name) => fs.readFileSync(path.join(root, '..', name), 'utf8')

test('v3.8.9 thresholds are hard ceilings: adaptive may tighten, never loosen', () => {
  const wide = effectiveBrowserAutoCloseLimits(
    { browserMemoryLimitMB: 2048, browserHeapLimitMB: 1536, browserDomNodeLimit: 200000, hostCriticalFreeMB: 4096 },
    { browserMemoryLimitMB: 4096, browserHeapLimitMB: 3072 },
  )
  assert.equal(wide.treeCommitMB, 2048)
  assert.equal(wide.jsHeapMB, 1536)
  assert.equal(wide.domNodes, 200000)
  assert.equal(wide.hostCommitFreeMB, 4096)

  const strict = effectiveBrowserAutoCloseLimits(
    { browserMemoryLimitMB: 2048, browserHeapLimitMB: 1536 },
    { browserMemoryLimitMB: 1024, browserHeapLimitMB: 768 },
  )
  assert.equal(strict.treeCommitMB, 1024)
  assert.equal(strict.jsHeapMB, 768)
})

test('v3.8.9 browser tree commit at 2 GB closes browser then fork', () => {
  const decision = evaluateBrowserAutoClose({ commitMB: 2048 })
  assert.equal(decision.close, true)
  assert.equal(decision.reason, 'browser-memory-limit')
  assert.equal(decision.scope, 'task')
  assert.equal(classifyCloseReason(decision.reason), 'browser-oom')
  assert.equal(evaluateBrowserAutoClose({ commitMB: 2047 }).close, false)
})

test('v3.8.9 JS heap at 1.5 GB and DOM at 200k close browser then fork', () => {
  const heap = evaluateBrowserAutoClose({ commitMB: 900, heapMB: 1536, nodeCount: 10000 })
  assert.equal(heap.close, true)
  assert.equal(heap.reason, 'browser-heap-limit')
  assert.equal(heap.scope, 'task')
  assert.equal(classifyCloseReason(heap.reason), 'browser-heap')

  const dom = evaluateBrowserAutoClose({ commitMB: 900, heapMB: 400, nodeCount: 200000 })
  assert.equal(dom.close, true)
  assert.equal(dom.reason, 'browser-dom-limit')
  assert.equal(dom.scope, 'task')
  assert.equal(classifyCloseReason(dom.reason), 'dom-limit')

  // CDP failure must not turn a missing sample into a fake 0-node pass or close.
  assert.equal(evaluateBrowserAutoClose({ cdpOk: false, heapMB: 1536, nodeCount: 200000 }).close, false)
})

test('v3.8.9 host CommitFree below 4 GB closes browser only and preserves fork home', () => {
  const low = evaluateBrowserAutoClose({ commitMB: 700, heapMB: 300, nodeCount: 1000, hostCommitFreeMB: 4095 })
  assert.equal(low.close, true)
  assert.equal(low.reason, 'host-commit-low-browser-memory-limit')
  assert.equal(low.scope, 'browser')
  assert.equal(classifyCloseReason(low.reason), 'host-memory')
  assert.equal(evaluateBrowserAutoClose({ hostCommitFreeMB: 4096 }).close, false)
  assert.equal(evaluateBrowserAutoClose({ autoClose: false, hostCommitFreeMB: 100 }).close, false)
})

test('close reason taxonomy keeps capacity, idle, host pressure and browser limits distinct', () => {
  assert.equal(classifyCloseReason('max-open-fork-browsers'), 'capacity')
  assert.equal(classifyCloseReason('idle-hidden'), 'idle')
  assert.equal(classifyCloseReason('turn-ended-idle'), 'idle')
  assert.equal(classifyCloseReason('host-commit-low-browser-memory-limit'), 'host-memory')
  assert.equal(classifyCloseReason('host-panic:commit-free-critical'), 'host-panic')
  assert.equal(classifyCloseReason('browser-memory-limit'), 'browser-oom')
  assert.equal(classifyCloseReason('browser-heap-limit'), 'browser-heap')
  assert.equal(classifyCloseReason('browser-dom-limit'), 'dom-limit')
})

test('v3.8.9 idle close requires hidden page and no running turn', () => {
  const t0 = 1_700_000_000_000
  const base = { ok: true, lastActivityAt: t0, turnRunning: false, sessionId: 's' }
  const close = decideIdleClose(base, { hiddenSince: t0, now: t0 + 11 * 60_000, idleMinutes: 10, onlyWhenIdle: true })
  assert.equal(close.close, true)
  assert.equal(close.reason, 'turn-ended-idle')

  const running = decideIdleClose({ ...base, turnRunning: true }, { hiddenSince: t0, now: t0 + 11 * 60_000, idleMinutes: 10, onlyWhenIdle: true })
  assert.equal(running.close, false)
  assert.equal(running.reason, 'turn-running')

  const recent = decideIdleClose(base, { hiddenSince: t0, now: t0 + 9 * 60_000, idleMinutes: 10, onlyWhenIdle: true })
  assert.equal(recent.close, false)
  assert.equal(recent.reason, 'recent-activity')
})

test('v3.8.9 managed browser close is CDP Browser.close, 3 s grace, then taskkill /T /F', () => {
  const source = read('src/lib/browser-guard.mjs')
  assert.match(source, /closeManagedBrowser\(\{ pid, port, graceMs = 3000, timeoutMs = 3000, identity = null \}\)/)
  assert.match(source, /identity\.tokens/)
  assert.match(source, /skipped: 'identity-required'/)
  assert.match(source, /skipped: 'pid-identity-mismatch'/)
  const start = source.indexOf('export async function closeManagedBrowser')
  const end = source.indexOf('\nasync function cdpTargets', start)
  const body = source.slice(start, end)
  const cdp = body.indexOf('browserCloseCdp(port)')
  const taskkill = body.indexOf("'taskkill.exe', ['/PID', String(value), '/T', '/F']")
  assert.ok(cdp > 0 && taskkill > cdp)
  assert.ok(body.indexOf('for (let i = 0; i < Math.ceil(Math.max(0, graceMs) / 100)', cdp) > cdp)
})

test('v3.8.9 close order is flush -> browser -> fork stop -> port/token revoke', () => {
  const source = read('src/plugins/orchestrator.mjs')
  const closeStart = source.indexOf('const closeTaskBrowser = async')
  const flush = source.indexOf('const forkFlush = await flushForkSession(task)', closeStart)
  const close = source.indexOf('await closeManagedBrowser({ pid: browser.pid', closeStart)
  const quarantine = source.indexOf('const quarantineTask = async')
  const stopFork = source.indexOf('forker()?.stop?.(task.taskId)', quarantine)
  const clearPort = source.indexOf('task.port = null', quarantine)
  const clearToken = source.indexOf("task.token = ''", quarantine)
  assert.ok(flush > closeStart && close > flush && stopFork > close && clearPort > stopFork && clearToken > clearPort)
})

test('v3.8.9 memoryGuard is persisted with reason/pid/metrics and unsaved force-kill flag', () => {
  const source = read('src/plugins/orchestrator.mjs')
  assert.match(source, /task\.memoryGuard = \{[\s\S]*reason,[\s\S]*at: nowMs\(\),[\s\S]*pid: browser\.pid,[\s\S]*metrics: browser\.last/)
  assert.match(source, /unsavedForceClose: !sessionSaved/)
  assert.match(source, /task\.browserClosed = \{[\s\S]*forkFlush: flushView,[\s\S]*saved: sessionSaved/)
})

test('v3.8.9 auto-close never deletes home and requires a manual reopen', () => {
  const orchestrator = read('src/plugins/orchestrator.mjs')
  const client = read('client.js')
  const closeStart = orchestrator.indexOf('const closeTaskBrowser = async')
  const closeEnd = orchestrator.indexOf('const quarantineTask = async')
  assert.equal(orchestrator.slice(closeStart, closeEnd).includes('removeTree'), false)
  assert.match(client, /task\.memoryGuard \? '重新打开' : '打开'/)
  assert.match(client, /必须手动重新打开，不会自动重开/)
  assert.match(client, /closeReasonCard\(task\.memoryGuard\)/)
  assert.match(client, /宿主内存压力关闭/)
  assert.match(client, /空闲关闭/)
  assert.match(client, /浏览器内存超限关闭/)
  assert.match(client, /浏览器 JS heap 超限关闭/)
  assert.doesNotMatch(client, /内存保护关闭/)
  assert.match(client, /'spawn-failed': '分身进程启动后立即退出/)
})

test('v3.8.9 orphan sweep runs at startup and every 5 minutes with PID identity checks', () => {
  const source = read('src/plugins/orchestrator.mjs')
  assert.match(source, /void cleanupOrphanForks\(\)/)
  assert.match(source, /setInterval\(\(\) => \{ void cleanupOrphanForks\(\) \}, Number\(cfg\.orphanSweepMinutes\) \* 60_000\)/)
  assert.match(source, /matchesProcessIdentity\(root, identity\)/)
  assert.match(source, /matchesProcessIdentity\(currentRoot, identity\)/)
  assert.match(source, /orphanSweepMinutes: z\.number\(\)\.min\(0\)\.max\(1440\)\.default\(5\)/)
})

test('v3.8.9 default config is autoClose=true with the requested ceilings', () => {
  assert.equal(BROWSER_AUTO_CLOSE_DEFAULTS.treeCommitMB, 2048)
  assert.equal(BROWSER_AUTO_CLOSE_DEFAULTS.jsHeapMB, 1536)
  assert.equal(BROWSER_AUTO_CLOSE_DEFAULTS.domNodes, 200000)
  assert.equal(BROWSER_AUTO_CLOSE_DEFAULTS.hostCommitFreeMB, 4096)
  const source = read('src/plugins/orchestrator.mjs')
  assert.match(source, /autoClose: z\.boolean\(\)\.default\(true\)/)
  assert.match(source, /browserMemoryLimitMB: z\.number\(\)[\s\S]*default\(2048\)/)
  assert.match(source, /browserHeapLimitMB: z\.number\(\)[\s\S]*default\(1536\)/)
  assert.match(source, /browserDomNodeLimit: z\.number\(\)[\s\S]*default\(200000\)/)
})
