// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as orchestratorModule from '../src/plugins/orchestrator.mjs'
import { makeCtx, makeReq, makeRes, makeWebServerStub, TEST_AUTH_TOKEN } from './helpers.mjs'

const root = path.resolve(import.meta.dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const orchestrator = read('src/plugins/orchestrator.mjs')
const peMachine = (file) => {
  const bytes = fs.readFileSync(path.join(root, file))
  assert.equal(bytes.subarray(0, 2).toString('ascii'), 'MZ')
  const pe = bytes.readUInt32LE(0x3c)
  assert.equal(bytes.subarray(pe, pe + 4).toString('hex'), '50450000')
  return { machine: bytes.readUInt16LE(pe + 4), size: bytes.length }
}
const sidecar = read('src/lib/watchdog-sidecar.mjs')
const adapter = read('src/plugins/adapter.mjs')
const forker = read('src/plugins/forker.mjs')
const browserGuard = read('src/lib/browser-guard.mjs')
const jobObject = read('src/lib/job-object.mjs')
const jobHostC = read('native/win32/fang-job-host.c')

test('v3.9.4 measure 1: host self Private/RSS + CommitFree every 15 s, even with no forks', () => {
  assert.match(orchestrator, /setInterval\(\(\) => \{ void hostWatchdogTick\(\) \}, HOST_WATCHDOG_INTERVAL_MS\)/)
  assert.match(orchestrator, /HOST_WATCHDOG_INTERVAL_MS = 15000/)
  assert.match(orchestrator, /const hostWatchdogTick = async \(\) => \{[\s\S]*?hostWatchdogTick/)
  const body = orchestrator.slice(orchestrator.indexOf('const hostWatchdogTick'), orchestrator.indexOf('const cleanupOrphanForks'))
  assert.equal(/const active = \[\.\.\.tasks\.values/.test(body), false, 'no active-child early return')
  assert.match(body, /rememberMemory\(await readSystemMemory\(\)\)/)
  assert.match(body, /selfRssMB/)
  assert.match(body, /selfPrivateMB/)
  assert.match(body, /commitFreeMB/)
})

test('v3.8.10 measure 2: emergency closes admission before browsers, forks, then quarantines', () => {
  const start = orchestrator.indexOf('const hostEmergency = async')
  const end = orchestrator.indexOf('const diagnosticLogOptions', start)
  const body = orchestrator.slice(start, end)
  const admission = body.indexOf('hostAdmissionClosed = true')
  const browser = body.indexOf('closeTaskBrowser(task, `host-panic:${reason}`)')
  const fork = body.indexOf('quarantineTask(task, `host-panic:${reason}`')
  assert.ok(admission > 0 && browser > admission && fork > browser)
  assert.match(body, /safeMode = true[\s\S]*safeModeReason = `host-emergency:\$\{reason\}`/)
  assert.match(orchestrator, /const ensureHostAdmission = async[\s\S]{0,300}hostAdmissionClosed/)
  assert.match(orchestrator, /async createTask[\s\S]{0,300}ensureHostAdmission/)
  assert.match(orchestrator, /async syncTaskOnOpen[\s\S]{0,300}ensureHostAdmission/)
  assert.match(orchestrator, /const launchTaskBrowser = async[\s\S]{0,160}ensureHostAdmission/)
})

test('v3.8.10 measure 3: independent sidecar detects host exit and heartbeat stall', () => {
  assert.match(sidecar, /function heartbeatState\(data\)/)
  assert.match(sidecar, /hostStuckMs/)
  assert.match(sidecar, /host-heartbeat-stale/)
  assert.match(sidecar, /host-exit/)
  assert.match(sidecar, /for \(const target of targets\)[\s\S]*killTree\(target\)/)
  assert.match(orchestrator, /watchdogHostStuckMs: z\.number\(\)\.min\(15000\)\.max\(600000\)\.default\(60000\)/)
  assert.match(orchestrator, /hostStuckMs: Number\(cfg\.watchdogHostStuckMs\)/)
})

test('v3.8.10 measure 4: fork and browser are both wrapped by a Windows Job', () => {
  assert.match(forker, /buildJobHostArgs\(\{/)
  assert.match(forker, /memoryMb: cfg\.jobProcessMemoryMB, totalMemoryMb: cfg\.jobTotalMemoryMB/)
  assert.match(browserGuard, /buildJobHostArgs/)
  assert.match(jobObject, /job-process-memory-mb/)
  assert.match(jobObject, /job-memory-mb/)
  assert.match(jobHostC, /JOB_OBJECT_LIMIT_PROCESS_MEMORY/)
  assert.match(jobHostC, /JOB_OBJECT_LIMIT_JOB_MEMORY/)
  assert.match(orchestrator, /browserJobProcessMemoryMB/)
  assert.match(orchestrator, /browserJobTotalMemoryMB/)
  assert.match(browserGuard, /job-object-unavailable/)
  assert.deepEqual(peMachine('native/win32/fang-job-host.exe'), { machine: 0x8664, size: 82944 })
  assert.deepEqual(peMachine('native/win32/fang-job-host-arm64.exe'), { machine: 0xaa64, size: 54784 })
})

test('v3.9.4 measure 5: maxForks defaults to 8, hard cap 62', () => {
  assert.match(orchestrator, /maxForks: z\.number\(\)\.min\(1\)\.max\(HARD_MAX_FORKS\)\.default\(DEFAULT_MAX_FORKS\)/)
  assert.match(orchestrator, /const effectiveMaxForks = \(\) => \{?[\s\S]{0,80}HARD_MAX_FORKS/)
  assert.match(forker, /maxForks: 8/)
  assert.match(forker, /allowMultiFork: true/)
})

test('v3.8.10 measure 6: fork/browser tree is lowered, host not lowered', () => {
  assert.match(browserGuard, /PriorityClass = '\$\{targetClass\}'/)
  assert.match(browserGuard, /lowerProcessPriority/)
  assert.match(orchestrator, /void lowerProcessPriority\(task\.pid, \{ priorityClass: processPriorityClass \}\)/)
  // No code path lowers the DSH host's own priority.
  assert.equal(/lowerProcessPriority\(process\.pid\)/.test(orchestrator), false)
})

test('v3.9.4 measure 7/8: crash loop enters Safe Mode and never auto-restores', () => {
  assert.match(orchestrator, /recent\.length >= 2/)
  assert.match(orchestrator, /safeModeReason = 'crash-loop-10m'/)
  assert.match(orchestrator, /hostAdmissionClosed = true/)
  assert.match(orchestrator, /autostart-refused/)
  assert.match(orchestrator, /const timer = setInterval\(\(\) => \{ void hostWatchdogTick\(\) \}, HOST_WATCHDOG_INTERVAL_MS\)/)
  // No code calls restoreTask/startTask from boot or watchdog.
  const autoRestore = orchestrator.match(/setTimeout\([^)]*restoreTask|setInterval\([^)]*restoreTask/g) ?? []
  assert.equal(autoRestore.length, 0)
})

test('v3.8.10 measure 9: Panic closes all browser/forks and clears live identity', () => {
  assert.match(orchestrator, /panic: async \(\) => hostEmergency\('manual-panic', \{ safe: true, allTasks: true \}\)/)
  assert.match(orchestrator, /POST.*api\/panic|route\('POST', `\$\{prefix\}\/api\/panic`/)
  assert.match(orchestrator, /task\.pid = null[\s\S]{0,160}task\.port = null[\s\S]{0,160}task\.url = null[\s\S]{0,160}task\.token = ''/)
  assert.match(orchestrator, /task\.quarantined = \{ reason, at: nowMs\(\), tokenRevoked: true \}/)
})

test('v3.8.13 measure 10: aggregate fork commit 40% plus a 4 GB host reserve', () => {
  assert.match(orchestrator, /forkCommitShareLimit: z\.number\(\)[\s\S]{0,100}default\(FORK_COMMIT_SHARE_DEFAULT\)/)
  assert.match(orchestrator, /forkCommitHostReserveMB: z\.number\(\)[\s\S]{0,120}default\(HOST_COMMIT_RESERVE_MB_DEFAULT\)/)
  assert.match(orchestrator, /hostCriticalFreeMB: z\.number\(\)[\s\S]{0,100}default\(SAFE_MODE_AUTO_CLEAR_COMMIT_MB\)/)
  assert.match(orchestrator, /hostEmergencyFreeMB: z\.number\(\)[\s\S]{0,100}default\(2048\)/)
  assert.match(orchestrator, /evaluateForkCommitBudget\(\{/)
  assert.match(orchestrator, /!budget\.ok \|\| share > emergency/)
  assert.match(orchestrator, /hostEmergency\('fork-commit-share'/)
})

test('v3.8.10 formal flush uses only confirmed fork APIs, not invented /api/session endpoints', () => {
  const start = orchestrator.indexOf('const flushForkSession = async')
  const end = orchestrator.indexOf('const closeTaskBrowser', start)
  const body = orchestrator.slice(start, end)
  assert.equal(body.includes('/api/session/flush'), false)
  assert.equal(body.includes('/api/session/save'), false)
  assert.equal(body.includes('/api/sessions/flush'), false)
  assert.match(body, /source: 'configured'/)
  assert.match(body, /source: 'health-capability'/)
  assert.match(body, /source: 'adapter-route'/)
  assert.match(body, /if \(result\.saved === true\) return \{ \.\.\.last, verified: true, unsupported: false \}/)
  assert.match(body, /unsupported: true/)
})

test('v3.8.10 adapter registers the flush route that the orchestrator calls', () => {
  assert.match(adapter, /route\('POST', `\$\{prefix\}\$\{ADAPTER_ROUTE\.FLUSH_SESSION\}`/)
  assert.match(adapter, /Function\(.*flushSessions|=> flushSessions\(payload\)/)
  assert.match(adapter, /if \(failed\.length === 0\)|const saved = failed\.length === 0/)
  assert.match(adapter, /saved: true/)
})

test('v3.8.10 emergency latch is observable and refuses a new fork immediately', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-v3810-'))
  const webServer = makeWebServerStub()
  const ctx = makeCtx({ services: { webServer } })
  try {
    orchestratorModule.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
      maxForks: 1,
    })
    const panic = webServer.find('POST', '/fang/api/panic')
    const create = webServer.find('POST', '/fang/api/tasks/create')
    const safe = webServer.find('GET', '/fang/api/safe-mode')
    assert.ok(panic?.handler, 'panic route must be registered')
    assert.ok(create?.handler, 'create route must be registered')
    assert.ok(safe?.handler, 'safe-mode route must be registered')

    const panicRes = makeRes()
    await panic.handler(makeReq({}, 'POST'), panicRes)
    assert.equal(panicRes.statusCode, 200)

    const safeRes = makeRes()
    await safe.handler(makeReq({}, 'GET'), safeRes)
    assert.equal(safeRes.statusCode, 200)
    assert.equal(safeRes.json()?.admissionClosed, true)

    const createRes = makeRes()
    await create.handler(makeReq({}, 'POST'), createRes)
    assert.equal(createRes.statusCode, 409)
    assert.equal(createRes.json()?.error, 'host-admission-closed')
  } finally {
    try { ctx.dispose() } catch { /* ignore */ }
    try { fs.rmSync(dataRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})
