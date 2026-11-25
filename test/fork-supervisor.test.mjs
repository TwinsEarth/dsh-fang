// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// fork-supervisor: backoff bounds, restart policy, orphan reconciliation, meta round-trip, HTTP probe.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { tmpDir } from './helpers.mjs'
import {
  computeBackoff, planRestart, reconcileOrphans, writeForkMeta, readForkMeta, probeHttpAlive, SUPERVISION_DEFAULTS,
} from '../src/lib/fork-supervisor.mjs'

test('fork-supervisor: backoff is bounded, monotonic in attempt, and jitter is deterministic when injected', () => {
  const opts = { baseMs: 1000, maxMs: 30000, jitter: 0.2, random: () => 0.5 }
  assert.equal(computeBackoff(0, opts), 1000)
  assert.equal(computeBackoff(1, opts), 2000)
  assert.equal(computeBackoff(2, opts), 4000)
  assert.equal(computeBackoff(10, opts), 30000, 'capped at maxMs')
  const low = computeBackoff(1, { ...opts, random: () => 0 })
  const high = computeBackoff(1, { ...opts, random: () => 1 })
  assert.ok(low < 2000 && high > 2000, `jitter range ${low}..${high}`)
})

test('fork-supervisor: restart policy only restarts crashes of an already-ready fork', () => {
  const policy = { ...SUPERVISION_DEFAULTS, maxRestarts: 3 }
  assert.equal(planRestart({ kind: 'crash' }, { ready: true, restartCount: 0 }, policy).action, 'restart')
  assert.equal(planRestart({ kind: 'crash' }, { ready: true, restartCount: 3 }, policy).action, 'give-up')
  assert.equal(planRestart({ kind: 'crash' }, { ready: false }, policy).reason, 'never-ready')
  assert.equal(planRestart({ kind: 'crash' }, { ready: true, intentionalStop: true }, policy).action, 'ignore')
  assert.equal(planRestart({ kind: 'normal' }, { ready: true }, policy).reason, 'normal-exit')
})

test('fork-supervisor: orphan reconciliation marks dead pids crashed and keeps live ones', () => {
  const out = reconcileOrphans([
    { forkId: 'a', status: 'ready', pid: 11 },
    { forkId: 'b', status: 'running', pid: 22 },
    { forkId: 'c', status: 'ready', pid: null },
    { forkId: 'd', status: 'stopped', pid: 33 },
  ], (pid) => pid === 22)
  assert.deepEqual(out, [
    { forkId: 'a', action: 'mark-crashed', reason: 'pid-dead', pid: 11 },
    { forkId: 'b', action: 'keep', reason: 'pid-alive' },
    { forkId: 'c', action: 'mark-crashed', reason: 'no-pid' },
  ])
})

test('fork-supervisor: fang-meta.json round-trips atomically and unreadable files degrade to null', () => {
  const dir = tmpDir('fang-meta-')
  try {
    assert.equal(writeForkMeta(dir, { forkId: 'f1', status: 'running', pid: 123 }), true)
    const meta = readForkMeta(dir)
    assert.equal(meta.version, 1)
    assert.equal(meta.forkId, 'f1')
    assert.equal(meta.status, 'running')
    const files = fs.readdirSync(dir)
    assert.deepEqual(files, ['fang-meta.json'], 'no temp files left behind')
    fs.writeFileSync(path.join(dir, 'fang-meta.json'), '{not json')
    assert.equal(readForkMeta(dir), null)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('fork-supervisor: probeHttpAlive is true for any HTTP response and false for a closed port', async () => {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end('nope') })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    assert.equal(await probeHttpAlive(port, { timeoutMs: 1000 }), true, '404 still means listening')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  assert.equal(await probeHttpAlive(port, { timeoutMs: 300 }), false, 'closed port is not alive')
})
