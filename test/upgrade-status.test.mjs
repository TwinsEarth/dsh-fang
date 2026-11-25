// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildUpgradeStatus } from '../src/lib/upgrade-status.mjs'

test('returns the read-only status shape', () => {
  const out = buildUpgradeStatus({
    version: '3.0.7',
    mirror: { current: '3.0.7', latest: '3.0.8', lastBackupAt: 123, backupIntervalHours: 12 },
    essences: [{ id: 'e1', name: '元主一', status: 'ready', stale: true, token: 'secret', path: 'C:/x' }],
  })
  assert.equal(out.ok, true)
  assert.equal(out.version, '3.0.7')
  assert.equal(out.mother.updateAvailable, true)
  assert.equal(out.mother.backupIntervalHours, 12)
  assert.deepEqual(out.essences, [{ id: 'e1', name: '元主一', status: 'ready', stale: true }])
  assert.equal(out.operation, null)
})

test('empty data keeps 200-friendly nulls', () => {
  const out = buildUpgradeStatus({})
  assert.equal(out.mother.current, null)
  assert.equal(out.mother.latest, null)
  assert.equal(out.mother.updateAvailable, false)
  assert.deepEqual(out.essences, [])
})

test('never leaks token/path/plugin fields', () => {
  const out = buildUpgradeStatus({ mirror: { current: 'a', token: 't', path: 'p' }, essences: [{ id: 'e', token: 't', path: 'p', plugins: ['x'] }] })
  const text = JSON.stringify(out)
  assert.equal(text.includes('token'), false)
  assert.equal(text.includes('path'), false)
  assert.equal(text.includes('plugins'), false)
})
