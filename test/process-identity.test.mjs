// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import { hashCommandLine, matchesProcessIdentity } from '../src/lib/process-identity.mjs'

const NOW = Date.UTC(2026, 10, 25, 2, 0, 0)
const ROW = {
  pid: 4321,
  ppid: 1,
  name: 'node.exe',
  createdAt: NOW,
  commandLine: '"C:\\Program Files\\node.exe" dsh.mjs --profile fang-abc123 --port 43121 --no-open',
}

test('command line hash is stable and distinguishes different argv', () => {
  assert.equal(hashCommandLine(ROW.commandLine), hashCommandLine(ROW.commandLine))
  assert.notEqual(hashCommandLine(ROW.commandLine), hashCommandLine(ROW.commandLine.replace('43121', '43122')))
})

test('exact CreationDate + CommandLine hash matches the original process', () => {
  const expected = {
    pid: ROW.pid,
    taskId: 'tk-1',
    profile: 'fang-abc123',
    port: 43121,
    startedAt: NOW,
    commandLineHash: hashCommandLine(ROW.commandLine),
  }
  assert.deepEqual(matchesProcessIdentity(ROW, expected), { ok: true, reason: 'matched' })
})

test('PID recycling with a different command line is rejected before taskkill', () => {
  const recycled = { ...ROW, commandLine: '"C:\\Program Files\\node.exe" other-service.mjs --profile fang-abc123 --port 43121' }
  const expected = { pid: ROW.pid, startedAt: NOW, commandLineHash: hashCommandLine(ROW.commandLine) }
  const result = matchesProcessIdentity(recycled, expected)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'command-line-changed')
})

test('PID recycling with a later CreationDate is rejected even if argv looks similar', () => {
  const recycled = { ...ROW, createdAt: NOW + 10 * 60_000 }
  const expected = { pid: ROW.pid, startedAt: NOW, commandLineHash: hashCommandLine(ROW.commandLine) }
  const result = matchesProcessIdentity(recycled, expected)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'creation-time-mismatch')
})

test('missing CreationDate fails closed when a start time was recorded', () => {
  const result = matchesProcessIdentity({ ...ROW, createdAt: null }, { pid: ROW.pid, startedAt: NOW, commandLineHash: hashCommandLine(ROW.commandLine) })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-creation-time')
})

test('wrong PID is rejected', () => {
  const result = matchesProcessIdentity({ ...ROW, pid: 9999 }, { pid: ROW.pid })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'pid-mismatch')
})

test('legacy tasks require exact profile and --port token, not profile alone', () => {
  const expected = { pid: ROW.pid, taskId: 'tk-1', profile: 'fang-abc123', port: 43121 }
  assert.equal(matchesProcessIdentity(ROW, expected).ok, true)
  const profileOnly = { ...ROW, commandLine: 'dsh.mjs --profile fang-abc123 --port 43110' }
  const result = matchesProcessIdentity(profileOnly, expected)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'command-line-token-mismatch')
})

test('legacy tasks accept the task marker when the port token is absent', () => {
  const expected = { pid: ROW.pid, taskId: 'tk-1', profile: 'fang-abc123', port: 43121 }
  const markerRow = { ...ROW, commandLine: 'dsh.mjs --profile fang-abc123 --fork-task tk-1' }
  assert.equal(matchesProcessIdentity(markerRow, expected).ok, true)
})

test('--port token must not match a longer port number', () => {
  const expected = { pid: ROW.pid, taskId: 'tk-1', profile: 'fang-abc123', port: 4312 }
  const result = matchesProcessIdentity(ROW, expected)
  assert.equal(result.ok, false)
})

test('explicit tokens support browser watchdog targets without a hash', () => {
  const browserRow = {
    pid: 5555,
    createdAt: NOW,
    commandLine: '"C:\\Edge\\msedge.exe" --user-data-dir=C:\\Fang\\home\\browser-profile --remote-debugging-port=43122 --no-first-run',
  }
  const expected = {
    pid: 5555,
    startedAt: NOW,
    tokens: ['--user-data-dir=C:\\Fang\\home\\browser-profile', '--remote-debugging-port=43122'],
  }
  assert.equal(matchesProcessIdentity(browserRow, expected).ok, true)
  const missing = matchesProcessIdentity({ ...browserRow, commandLine: 'msedge.exe --user-data-dir=C:\\Other --remote-debugging-port=43122' }, expected)
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'command-line-token-mismatch')
})
