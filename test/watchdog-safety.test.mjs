// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('watchdog sidecar never boots a second DSH host via process.execPath', () => {
  const source = fs.readFileSync(new URL('../src/plugins/orchestrator.mjs', import.meta.url), 'utf8')
  assert.equal(source.includes('spawn(process.execPath'), false)
  assert.equal(source.includes('watchdog-sidecar-unavailable'), true)
  assert.equal(source.includes('dependencies'), true)
})
