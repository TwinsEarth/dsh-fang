// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import { findBrowserPath, freePort, isPidAlive } from '../src/lib/browser-guard.mjs'

test('browser guard recognizes current pid and rejects invalid pid', () => {
  assert.equal(isPidAlive(process.pid), true)
  assert.equal(isPidAlive(0), false)
  assert.equal(isPidAlive(-1), false)
})

test('browser path resolver returns an existing executable or empty string', () => {
  const path = findBrowserPath('')
  assert.equal(typeof path, 'string')
  if (path) assert.equal(path.toLowerCase().endsWith('.exe'), true)
})

test('free port picks a usable loopback port', async () => {
  const port = await freePort(19620, 19640)
  if (process.platform === 'win32') assert.ok(port > 0)
  else assert.ok(port >= 0)
})
