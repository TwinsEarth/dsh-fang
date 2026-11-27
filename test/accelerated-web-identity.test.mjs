// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.9.9: the experimental accelerated web sidecar must never taskkill or reuse
// a persisted PID without a capture-time identity match.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ACCELERATED_STATE_FILE,
  acceleratedWebStatus,
  startAcceleratedWeb,
  stopAcceleratedWeb,
} from '../src/lib/accelerated-web.mjs'

function tempState(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-accel-'))
  fs.writeFileSync(path.join(dir, ACCELERATED_STATE_FILE), JSON.stringify({
    pid: 4242,
    port: 18080,
    profile: 'accel-test',
    running: true,
    ...overrides,
  }))
  return dir
}

function identity(commandLine, overrides = {}) {
  return async (pid) => ({ ok: true, row: { pid, commandLine, createdAt: 1_700_000_000_000, ...overrides } })
}

test('accelerated stop refuses a mismatched PID and never calls taskkill', async () => {
  const dir = tempState()
  const calls = []
  const execFileImpl = (...args) => { calls.push(args); args.at(-1)?.() }
  const out = await stopAcceleratedWeb({
    dataDir: dir,
    execFileImpl,
    readIdentityImpl: identity('node cli.mjs --profile other --port 18080'),
  })
  assert.equal(out.ok, false)
  assert.equal(out.error, 'accelerated-identity-mismatch')
  assert.equal(calls.length, 0)
})

test('accelerated stop taskkills only a matching capture-time identity', async () => {
  const dir = tempState()
  const calls = []
  const execFileImpl = (...args) => { calls.push(args); args.at(-1)?.() }
  const out = await stopAcceleratedWeb({
    dataDir: dir,
    execFileImpl,
    readIdentityImpl: identity('node cli.mjs --profile accel-test --port 18080'),
  })
  assert.equal(out.ok, true)
  assert.equal(out.stopped, true)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0][1], ['/PID', '4242', '/T', '/F'])
})

test('accelerated status does not report a mismatched PID as running', async () => {
  const dir = tempState()
  const out = await acceleratedWebStatus({
    dataDir: dir,
    readIdentityImpl: identity('node cli.mjs --profile other --port 18080'),
    fetchImpl: async () => ({ ok: true, status: 200 }),
  })
  assert.equal(out.running, false)
  assert.equal(out.state.identityOk, false)
  assert.match(out.state.identityError, /token-mismatch|command-line/)
})

test('accelerated start reuses only a matching live sidecar', async () => {
  const dir = tempState()
  const out = await startAcceleratedWeb({
    dataDir: dir,
    readIdentityImpl: identity('node cli.mjs --profile accel-test --port 18080'),
    fetchImpl: async () => ({ ok: true, status: 200 }),
  })
  assert.equal(out.ok, true)
  assert.equal(out.already, true)
  assert.equal(out.pid, 4242)
})
