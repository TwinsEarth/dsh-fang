// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { Config } from '../src/plugins/orchestrator.mjs'
import * as orchestrator from '../src/plugins/orchestrator.mjs'
import { buildJobHostArgs } from '../src/lib/job-object.mjs'
import { launchManagedBrowser } from '../src/lib/browser-guard.mjs'
import { makeCtx, makeReq, makeRes, makeWebServerStub, TEST_AUTH_TOKEN } from './helpers.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fang-v388-'))

test('v3.8.8 config: maxForks defaults to 1 and multi-fork is explicit', () => {
  const cfg = Config({})
  assert.equal(cfg.maxForks, 1)
  assert.equal(cfg.allowMultiFork, false)
  assert.equal(cfg.browserJobObject, true)
  assert.equal(cfg.forkCommitWarnShare, 0.3)
  assert.equal(cfg.forkCommitSevereShare, 0.35)
  assert.equal(cfg.forkCommitShareLimit, 0.4)
  assert.equal(cfg.hostWarnFreeMB, 8192)
  assert.equal(cfg.hostCriticalFreeMB, 4096)
  assert.equal(cfg.hostEmergencyFreeMB, 2048)
})

test('v3.8.8 job helper argv carries process and total memory limits', () => {
  const home = tmp()
  const args = buildJobHostArgs({
    spec: { command: 'C:\\Edge\\msedge.exe', args: ['--app=http://127.0.0.1:1'], shell: false },
    forkId: 'browser-task_1',
    homeDir: home,
    heartbeatFile: 'C:\\data\\watchdog-1.heartbeat',
    hostPid: 1,
    memoryMb: 2048,
    totalMemoryMb: 4096,
  })
  assert.ok(args.includes('--job-process-memory-mb'))
  assert.ok(args.includes('--job-memory-mb'))
  assert.equal(args[args.indexOf('--job-process-memory-mb') + 1], '2048')
  assert.equal(args[args.indexOf('--job-memory-mb') + 1], '4096')
})

test('v3.8.8 browser launch fails closed when the Job helper is missing', async () => {
  const dir = tmp()
  const exe = path.join(dir, 'fake-browser')
  fs.writeFileSync(exe, '')
  const out = await launchManagedBrowser({
    exe,
    url: 'http://127.0.0.1:1/',
    profileDir: path.join(dir, 'profile'),
    logDir: path.join(dir, 'logs'),
    port: 1,
    jobObject: { enabled: true, helperPath: '', homeDir: dir },
  })
  assert.equal(out.ok, false)
  assert.equal(out.error, 'job-object-unavailable')
})

test('v3.8.8 browser is wired through the Job helper, not a bare spawn', () => {
  const source = read('src/lib/browser-guard.mjs')
  assert.match(source, /buildJobHostArgs, jobObjectPaths, jobObjectSummary, readJobReady/)
  assert.match(source, /jobObject\?\.enabled === true/)
  assert.match(source, /spawn\(helperPath, helperArgs/)
  assert.match(source, /readJobReady\(jobPaths\.readyFile\)/)
  assert.match(source, /fs\.rmSync\(jobPaths\.readyFile, \{ force: true \}\)/)
  assert.match(source, /job-object-launch-failed/)
  assert.match(source, /helperPid/)
  assert.match(source, /jobObject: useJob/)
})

test('v3.8.8 orchestrator passes Job config, tiers aggregate commit, and exposes panic route', () => {
  const source = read('src/plugins/orchestrator.mjs')
  assert.match(source, /resolveJobHostPath\(\{ packageRoot: FANG_ROOT \}\)/)
  assert.match(source, /browserJobObject: z\.boolean\(\)/)
  assert.match(source, /browserJobProcessMemoryMB/)
  assert.match(source, /browserJobTotalMemoryMB/)
  assert.match(source, /effectiveMaxForks/)
  assert.match(source, /forkCommitWarnShare: z\.number/)
  assert.match(source, /forkCommitSevereShare: z\.number/)
  assert.match(source, /fork-commit-share-warning/)
  assert.match(source, /fork-commit-share-severe/)
  assert.match(source, /forkCommitShareLimit/)
  assert.match(source, /hostEmergencyFreeMB/)
  assert.match(source, /commit-free-emergency/)
  assert.match(source, /host-crashes\.jsonl/)
  assert.match(source, /event: 'host-crash'/)
  assert.match(source, /metrics: previousMetrics/)
  assert.match(source, /route\('POST', `\$\{prefix\}\/api\/panic`/)
  assert.match(source, /allTasks: true/)
  assert.match(source, /hostMetrics: lastHostMetrics/)
})

test('v3.8.8 sidecar sees the fork PID immediately after spawn', () => {
  const source = read('src/plugins/orchestrator.mjs')
  assert.match(source, /spawnPidPoll = setInterval/)
  assert.match(source, /syncTaskMeta\(task, \{ pid: task\.pid, port: task\.port \?\? null \}\)/)
  assert.match(source, /writeWatchdog\(\)/)
  const forker = read('src/plugins/forker.mjs')
  assert.match(forker, /rec\.pid = child\.pid \?\? null[\s\S]{0,300}writeForkMetaOf\(rec\)/)
  assert.match(forker, /allowMultiFork: z\.boolean\(\)\.default\(false\)/)
  assert.match(forker, /cfg\.allowMultiFork === true/)
})

test('v3.8.8 host crash counter prunes >10m and writes JSONL with metrics', () => {
  const dataRoot = tmp()
  const oldAt = Date.now() - 15 * 60_000
  const metrics = {
    commitFreeMB: 5004,
    selfRssMB: 812,
    selfPrivateMB: 503,
    forkCommitMB: 620,
    browserCommitMB: 1450,
    totalCommitMB: 2070,
    processCount: 133,
  }
  fs.writeFileSync(path.join(dataRoot, 'host-state.json'), JSON.stringify({
    pid: 999999, clean: false, startedAt: new Date(oldAt).toISOString(), lastMetrics: metrics,
  }))
  fs.writeFileSync(path.join(dataRoot, 'host-crashes.json'), JSON.stringify({
    crashes: [{ at: oldAt, reason: 'old-crash' }],
    cap: 50, retentionDays: 30,
  }))
  const ctx = makeCtx()
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      routes: { enabled: false },
      authToken: 'test-token',
      allowMultiFork: true,
      maxForks: 8,
    })
    const counter = JSON.parse(fs.readFileSync(path.join(dataRoot, 'host-crashes.json'), 'utf8'))
    assert.equal(counter.crashes.some((item) => item.reason === 'old-crash'), false, '>10m record must be pruned')
    assert.equal(counter.crashes.length, 1)
    assert.equal(counter.crashes[0].reason, 'unclean-shutdown')
    const lines = fs.readFileSync(path.join(dataRoot, 'host-crashes.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    const crash = lines.find((item) => item.event === 'host-crash')
    assert.ok(crash)
    assert.equal(crash.commitFreeMB, 5004)
    assert.equal(crash.selfRssMB, 812)
    assert.equal(crash.processCount, 133)
    assert.equal(crash.forkCommitMB, 620)
    assert.equal(crash.browserCommitMB, 1450)
  } finally {
    try { ctx.dispose() } catch { /* ignore */ }
    try { fs.rmSync(dataRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

test('v3.8.8 POST /fang/api/panic reaches hostEmergency and returns 200', async () => {
  const dataRoot = tmp()
  const webServer = makeWebServerStub()
  const ctx = makeCtx({ services: { webServer } })
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
      maxForks: 1,
    })
    const route = webServer.find('POST', '/fang/api/panic')
    assert.ok(route?.handler, 'panic route must be registered')
    const res = makeRes()
    await route.handler(makeReq({}, 'POST'), res)
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body?.ok, true)
    assert.equal(body?.mode, 'panic')
  } finally {
    try { ctx.dispose() } catch { /* ignore */ }
    try { fs.rmSync(dataRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

test('v3.8.8 mother RSS/private comes from the OS process, not heap guess', () => {
  const memory = read('src/lib/memory-guard.mjs')
  assert.match(memory, /SelfRssMB = if \(\$hp\)/)
  assert.match(memory, /SelfPrivateMB = if \(\$hp\)/)
  assert.match(memory, /PrivateMemorySize64/)
  const source = read('src/plugins/orchestrator.mjs')
  assert.match(source, /Number\(memory\.selfRssMB\)/)
  assert.match(source, /Number\(memory\.selfPrivateMB\)/)
})

test('v3.8.8 native helper source contains kernel memory limits', () => {
  const source = read('native/win32/fang-job-host.c')
  assert.match(source, /JOB_OBJECT_LIMIT_PROCESS_MEMORY/)
  assert.match(source, /JOB_OBJECT_LIMIT_JOB_MEMORY/)
  assert.match(source, /--job-process-memory-mb/)
  assert.match(source, /--job-memory-mb/)
})
