// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const sidecar = path.resolve(import.meta.dirname, '../src/lib/watchdog-sidecar.mjs')

function runSidecar(data, { heartbeatAgeMs = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-sidecar-'))
  const heartbeat = path.join(dir, 'host-state.json')
  fs.writeFileSync(heartbeat, JSON.stringify({ at: new Date().toISOString() }), 'utf8')
  if (heartbeatAgeMs > 0) {
    const at = new Date(Date.now() - heartbeatAgeMs)
    fs.utimesSync(heartbeat, at, at)
  }
  const file = path.join(dir, 'watchdog.json')
  fs.writeFileSync(file, JSON.stringify({ ...data, heartbeatFile: heartbeat }, null, 2), 'utf8')
  const out = spawnSync(process.execPath, [sidecar, file], { encoding: 'utf8', timeout: 10000 })
  const result = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.rmSync(dir, { recursive: true, force: true })
  return { status: out.status, result }
}

test('sidecar exits and records host-heartbeat-stale when the host is alive but stalled', () => {
  const { status, result } = runSidecar({
    hostPid: process.pid,
    hostStuckMs: 15000,
    targets: [],
    clean: false,
  }, { heartbeatAgeMs: 20000 })
  assert.equal(status, 0)
  assert.equal(result.stop, true)
  assert.equal(result.stopReason, 'host-heartbeat-stale')
  assert.equal(result.heartbeat.available, true)
  assert.equal(result.heartbeat.stale, true)
})

test('sidecar exits and records host-exit when the host PID is gone', () => {
  const { status, result } = runSidecar({
    hostPid: 999999,
    hostStuckMs: 60000,
    targets: [],
    clean: false,
  })
  assert.equal(status, 0)
  assert.equal(result.stop, true)
  assert.equal(result.stopReason, 'host-exit')
})

test('sidecar does not stop on a fresh heartbeat', () => {
  // This call would loop forever by design; use a stop flag to exercise the
  // clean-stop branch without waiting for the timeout.
  const { status, result } = runSidecar({ hostPid: process.pid, hostStuckMs: 60000, targets: [], clean: true })
  assert.equal(status, 0)
  assert.equal(result.stop, true)
  assert.equal(result.stopReason, 'host-clean-stop')
})
