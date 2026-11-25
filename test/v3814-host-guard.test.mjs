// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  HOST_HEAP_DEFAULTS,
  SESSION_FOOTPRINT_DEFAULTS,
  evaluateHostHeap,
  evaluateSessionFootprint,
  resolveHostHeapLimits,
} from '../src/lib/host-pressure.mjs'
import { scanSessionFootprint, summarizeSessionRoot } from '../src/lib/session-footprint.mjs'
import { mapMemoryProbe } from '../src/lib/memory-guard.mjs'

const root = path.resolve(import.meta.dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const orchestrator = read('src/plugins/orchestrator.mjs')
const memoryGuard = read('src/lib/memory-guard.mjs')

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fang-v3814-'))
}

function putSession(home, workspace, sessionId, bytes) {
  const dir = path.join(home, 'sessions', workspace, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(bytes, 7))
}

test('v3.8.14 heap thresholds: absolute defaults and small V8 limit clamp', () => {
  const normal = resolveHostHeapLimits({}, 4096)
  assert.deepEqual({ warn: normal.warnMB, critical: normal.criticalMB, emergency: normal.emergencyMB }, {
    warn: 1024, critical: 1536, emergency: 2048,
  })
  assert.equal(normal.emergencyStreak, HOST_HEAP_DEFAULTS.emergencyStreak)

  const small = resolveHostHeapLimits({}, 512)
  assert.ok(small.warnMB < small.criticalMB && small.criticalMB < small.emergencyMB)
  assert.ok(small.emergencyMB < 512, 'must leave head-room below the V8 limit')
  assert.ok(small.warnMB <= Math.round(512 * 0.65))

  const tiny = resolveHostHeapLimits({}, 10)
  assert.ok(tiny.warnMB > 0)
  assert.ok(tiny.warnMB < tiny.criticalMB && tiny.criticalMB < tiny.emergencyMB)
  assert.ok(tiny.emergencyMB < 10)
})

test('v3.8.14 host heap levels map to warn/critical/emergency', () => {
  const limits = resolveHostHeapLimits({ hostJsHeapWarnMB: 512, hostJsHeapCriticalMB: 768, hostJsHeapEmergencyMB: 1024 }, 4096)
  assert.equal(evaluateHostHeap({ heapUsedMB: 400, heapLimitMB: 4096 }, limits).level, 'ok')
  assert.equal(evaluateHostHeap({ heapUsedMB: 600, heapLimitMB: 4096 }, limits).level, 'warn')
  assert.equal(evaluateHostHeap({ heapUsedMB: 800, heapLimitMB: 4096 }, limits).level, 'critical')
  assert.equal(evaluateHostHeap({ heapUsedMB: 1100, heapLimitMB: 4096 }, limits).level, 'emergency')
  assert.equal(evaluateHostHeap({}, limits).skipped, 'no-heap-metric')
})

test('v3.8.14 session footprint uses total and largest file independently', () => {
  const thresholds = { ...SESSION_FOOTPRINT_DEFAULTS }
  const total = evaluateSessionFootprint({ bytes: 5000 * 1024 * 1024, files: 3, largestBytes: 10 * 1024 * 1024 }, thresholds)
  assert.equal(total.level, 'emergency')
  assert.equal(total.gate, false)
  assert.equal(total.totalGate, true)

  const single = evaluateSessionFootprint({ bytes: 200 * 1024 * 1024, files: 3, largestBytes: 40 * 1024 * 1024 }, thresholds)
  assert.equal(single.level, 'critical')
  assert.equal(single.gate, false)

  const fileEmergency = evaluateSessionFootprint({ bytes: 200 * 1024 * 1024, files: 3, largestBytes: 70 * 1024 * 1024 }, thresholds)
  assert.equal(fileEmergency.level, 'emergency')
  assert.equal(fileEmergency.gate, true)

  const warn = evaluateSessionFootprint({ bytes: 60 * 1024 * 1024, files: 3, largestBytes: 20 * 1024 * 1024 }, thresholds)
  assert.equal(warn.level, 'warn')
  assert.equal(warn.gate, false)

  const ok = evaluateSessionFootprint({ bytes: 16 * 1024 * 1024, files: 3, largestBytes: 10 * 1024 * 1024 }, thresholds)
  assert.equal(ok.level, 'ok')
})

test('v3.8.14 session footprint scanner stats host and task homes without reading logs', () => {
  const host = tempHome()
  const task = tempHome()
  try {
    putSession(host, '--E-DSH--', 'session-11111111-1111-1111-1111-111111111111', 1024 * 1024)
    putSession(task, '--E-DSH--', 'session-22222222-2222-2222-2222-222222222222', 2 * 1024 * 1024)
    const out = scanSessionFootprint([
      { label: 'host', homeDir: host },
      { label: 'task:t1', taskId: 't1', homeDir: task },
    ])
    assert.equal(out.ok, true)
    assert.equal(out.files, 2)
    assert.equal(out.bytes, 3 * 1024 * 1024)
    assert.equal(out.largestBytes, 2 * 1024 * 1024)
    assert.equal(out.roots.length, 2)
    assert.equal(out.top.length, 2)
    assert.equal(out.top[0].bytes, 2 * 1024 * 1024)
    assert.match(out.top[0].file, /session\.v4\.jsonl\.zstd$/)
  } finally {
    fs.rmSync(host, { recursive: true, force: true })
    fs.rmSync(task, { recursive: true, force: true })
  }
})

test('v3.8.14 pagefile probe keeps every drive and reconciles commit limit', () => {
  const data = {
    CommitLimitOSMB: 20000,
    CommitFreeMB: 5000,
    PhysicalTotalMB: 16000,
    PhysicalFreeMB: 8000,
    PageFileDetails: [
      { Name: 'C:\\pagefile.sys', AllocatedBaseSize: 2048, CurrentUsage: 100 },
      { Name: 'D:\\pagefile.sys', AllocatedBaseSize: 4096, CurrentUsage: 200 },
    ],
    PageFileSettings: [
      { Name: 'C:\\pagefile.sys', InitialSize: 2048, MaximumSize: 4096 },
      { Name: 'D:\\pagefile.sys', InitialSize: 4096, MaximumSize: 8192 },
    ],
    PagingFiles: 'C:\\pagefile.sys 2048 4096;D:\\pagefile.sys 4096 8192',
    AutomaticManagedPagefile: false,
    SelfRssMB: 700,
    SelfPrivateMB: 800,
    Volumes: [
      { DeviceID: 'C:', SizeMB: 100000, FreeMB: 20000 },
      { DeviceID: 'D:', SizeMB: 200000, FreeMB: 50000 },
    ],
  }
    const out = mapMemoryProbe(data, { now: 123, systemDrive: 'C:' })
  assert.equal(out.pageFileMB, 6144)
  assert.equal(out.pageFileUsageMB, 300)
  assert.deepEqual(out.pageFileDrives, ['C:', 'D:'])
  assert.equal(out.pageFileOffSystemDrive, true)
  assert.equal(out.commitLimitOSMB, 20000)
  assert.equal(out.commitLimitDerivedMB, 22144)
  assert.equal(out.commitLimitMB, 22144)
  assert.equal(out.commitLimitSource, 'physical-plus-all-pagefiles')
  assert.equal(out.hasPageFile, true)
  assert.equal(out.volumes.length, 2)

  const cOnly = mapMemoryProbe({
    CommitLimitOSMB: 18048,
    PhysicalTotalMB: 16000,
    PageFileDetails: [{ Name: 'C:\\pagefile.sys', AllocatedBaseSize: 2048 }],
    PagingFiles: 'C:\\pagefile.sys 2048 4096',
  }, { systemDrive: 'C:' })
  assert.deepEqual(cOnly.pageFileDrives, ['C:'])
  assert.equal(cOnly.pageFileOffSystemDrive, false)
  assert.equal(cOnly.commitLimitMB, 18048)
  assert.equal(cOnly.commitLimitSource, 'os-total')

  // Exact shape observed on TOFUTURE: only D: has an active pagefile.
  const dOnly = mapMemoryProbe({
    CommitLimitOSMB: 44821,
    PhysicalTotalMB: 32476,
    PageFileDetails: [{ Name: 'D:\\pagefile.sys', AllocatedBaseSize: 12345, CurrentUsage: 58 }],
    PageFileSettings: [{ Name: 'd:\\pagefile.sys', InitialSize: 12345, MaximumSize: 23456 }],
    PagingFiles: 'd:\\pagefile.sys 12345 23456',
  }, { systemDrive: 'C:' })
  assert.deepEqual(dOnly.pageFileDrives, ['D:'])
  assert.equal(dOnly.pageFileOnSystemDrive, false)
  assert.equal(dOnly.pageFileOffSystemDrive, true)
  assert.equal(dOnly.commitLimitMB, 44821)
  assert.equal(dOnly.commitLimitSource, 'os-total')
})

test('v3.8.14 source wiring: host heap/session scan, gate, and all-drive probe', () => {
  assert.match(orchestrator, /hostJsHeapWarnMB: z\.number\(\)/)
  assert.match(orchestrator, /hostJsHeapEmergencyStreak: z\.number\(\)/)
  assert.match(orchestrator, /sessionFootprintEnabled: z\.boolean\(\)/)
  assert.match(orchestrator, /sessionFileCriticalMB: z\.number\(\)/)
  assert.match(orchestrator, /const sampleHostHeap = \(\) =>/)
  assert.match(orchestrator, /v8\.getHeapStatistics\(\)/)
  assert.match(orchestrator, /scanSessionFootprint\(/)
  assert.match(orchestrator, /host-js-heap-emergency/)
  assert.match(orchestrator, /session-footprint-emergency/)
  assert.match(orchestrator, /host-pressure-admission-refused/)
  assert.match(orchestrator, /const memoryGate = async \(action\) => \{\n    const pressure = currentPressureGate\(\)/)
  assert.match(memoryGuard, /Win32_PageFileSetting/)
  assert.match(memoryGuard, /Win32_LogicalDisk/)
  assert.match(memoryGuard, /PageFileDetails/)
  assert.match(memoryGuard, /CommitLimitDerivedMB/)

  const client = read('client.js')
  assert.match(client, /function renderHostPressureBanner\(S, app\)/)
  assert.match(client, /'data-zone': 'host-pressure-banner'/)
  assert.match(client, /host-js-heap-pressure/)
  assert.match(client, /session-footprint-pressure/)
})
