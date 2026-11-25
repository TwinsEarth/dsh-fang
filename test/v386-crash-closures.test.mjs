// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  evaluateForkHealth,
  countSessionEvents,
  inspectForkSessionHealth,
  probeForkHealth,
} from '../src/lib/fork-health.mjs'
import {
  buildEmptySessionFrames,
  encodeSessionLog,
} from '../src/lib/fork-sessions.mjs'
import {
  classifyBrowserExit,
  selectExtraPageTargets,
} from '../src/lib/browser-guard.mjs'
import { evaluateCrashLoop } from '../src/lib/fork-supervisor.mjs'
import {
  evaluatePagefileSingleFork,
  isCommitLimitNearRam,
  isPagefileMissing,
} from '../src/lib/memory-guard.mjs'

function makeSessionHome(frames = buildEmptySessionFrames({ sessionId: 's1', createdAt: 1, cwd: '/tmp/ws' })) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-v386-health-'))
  const file = path.join(root, 'sessions', 'ws', 's1', 'session.v4.jsonl.zstd')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, encodeSessionLog(frames))
  return root
}

test('v3.8.6: pagefile evidence covers PagingFiles={} and CommitLimit≈RAM', () => {
  assert.equal(isCommitLimitNearRam(1024, 1000), true)
  assert.equal(isCommitLimitNearRam(1100, 1000), true)
  assert.equal(isCommitLimitNearRam(2000, 1000), false)
  assert.equal(isPagefileMissing({ ok: true, supported: true, hasPageFile: true, pageFileMB: 1024, pagingFilesEmpty: true }), true)
  assert.equal(isPagefileMissing({ ok: true, supported: true, hasPageFile: true, pageFileMB: 1024, commitLimitNearRam: true }), true)
  assert.equal(isPagefileMissing({ ok: true, supported: true, hasPageFile: true, pageFileMB: 1024, pagingFilesEmpty: false, commitLimitNearRam: false }), false)
})

test('v3.8.13: no-pagefile policy is advisory and never refuses a fork', () => {
  const memory = { ok: true, supported: true, hasPageFile: false, pageFileMB: 0 }
  assert.equal(evaluatePagefileSingleFork(memory, { activeForks: 0 }).ok, true)
  assert.equal(evaluatePagefileSingleFork(memory, { activeForks: 0 }).limited, true)
  assert.equal(evaluatePagefileSingleFork(memory, { activeForks: 1 }).ok, true)
  assert.equal(evaluatePagefileSingleFork(memory, { activeForks: 1 }).advisory, 'pagefile-missing')
  assert.equal(evaluatePagefileSingleFork({ ok: true, supported: true, hasPageFile: true, pageFileMB: 1024 }, { activeForks: 1 }).ok, true)
})

test('v3.8.6: session health scans event count and enforces the event budget', async () => {
  const home = makeSessionHome()
  try {
    const health = await inspectForkSessionHealth(home, { maxSessionMB: 1, maxEvents: 100 })
    assert.equal(health.ok, true)
    assert.equal(health.sessions, 1)
    assert.equal(health.events, 5)
    assert.equal(health.truncated, false)
    const count = await countSessionEvents(path.join(home, 'sessions', 'ws', 's1', 'session.v4.jsonl.zstd'), { maxEvents: 2 })
    assert.equal(count.truncated, true)
    assert.equal(count.events, 3)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('v3.8.6: health gate fails on adapter, oversized session, or unavailable endpoint', async () => {
  const home = makeSessionHome()
  try {
    const session = await inspectForkSessionHealth(home, { maxSessionMB: 1, maxEvents: 100 })
    assert.equal(evaluateForkHealth({ session, adapter: { ok: true }, http: { ok: true, data: { ok: true } } }).ok, true)
    assert.equal(evaluateForkHealth({ session, adapter: { ok: false, error: 'handshaking' }, http: { ok: true } }).error, 'fork-adapter-unavailable')
    const oversized = evaluateForkHealth({
      session: { ...session, largestBytes: 2 * 1024 * 1024 }, adapter: { ok: true }, http: { ok: true },
      limits: { maxSessionMB: 1, maxEvents: 100 },
    })
    assert.equal(oversized.error, 'fork-health-session-too-large')
    const noEndpoint = evaluateForkHealth({ session, adapter: { ok: true }, http: { ok: false, error: 'health-timeout' } })
    assert.equal(noEndpoint.error, 'fork-health-endpoint-unavailable')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('v3.8.6: health probe falls back from 404 to /api/health', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/fang/api/health') {
      res.statusCode = 404
      res.end('missing')
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, role: 'fork', session: { events: 5 } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = server.address().port
    const out = await probeForkHealth(port, { path: '/fang/api/health', fallbackPaths: ['/api/health'] })
    assert.equal(out.ok, true)
    assert.equal(out.path, '/api/health')
    assert.equal(out.data.role, 'fork')
    assert.equal(out.probes.length, 2)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('v3.8.6: browser exit normalizes 0xE0000008 and extra app pages are selectable', () => {
  const oom = classifyBrowserExit(0xE0000008)
  assert.equal(oom.oom, true)
  assert.equal(oom.kind, 'oom')
  assert.equal(oom.hex, '0xE0000008')
  const signed = classifyBrowserExit(-536870904)
  assert.equal(signed.oom, true)
  assert.equal(classifyBrowserExit(0).kind, 'normal')
  assert.equal(classifyBrowserExit(null, 'SIGKILL').kind, 'signal')
  const extras = selectExtraPageTargets([
    { id: 'blank', type: 'page', url: 'about:blank' },
    { id: 'a', type: 'page', url: 'http://127.0.0.1:1/app' },
    { id: 'b', type: 'page', url: 'http://127.0.0.1:1/extra' },
    { id: 'c', type: 'page', url: 'devtools://devtools/bundled/inspector.html' },
  ], 1)
  assert.equal(extras.length, 2)
  assert.deepEqual(extras.map((row) => row.id), ['b', 'blank'])
})

test('v3.8.6: 10-minute crash window trips at 2 and prunes older crashes', () => {
  const now = 1_000_000
  const trip = evaluateCrashLoop([now - 9 * 60_000, now - 8 * 60_000], now, { windowMs: 10 * 60_000, threshold: 2 })
  assert.equal(trip.tripped, true)
  assert.equal(trip.count, 2)
  const single = evaluateCrashLoop([now - 11 * 60_000, now - 8 * 60_000], now, { windowMs: 10 * 60_000, threshold: 2 })
  assert.equal(single.tripped, false)
  assert.equal(single.count, 1)
})
