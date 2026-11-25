// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertSafeArtifact, canAdopt, transition } from '../src/lib/reflow.mjs'

test('reflow follows seal → verify → quarantine/adopt', () => {
  let s = 'sealed'
  let r = transition(s, 'quarantine')
  assert.equal(r.ok, false)
  r = transition(s, 'adopt'); assert.equal(r.ok, false)
  s = 'verified'
  r = transition(s, 'quarantine'); assert.deepEqual(r, { ok: true, state: 'quarantine' })
  r = transition('verified', 'adopt'); assert.deepEqual(r, { ok: true, state: 'adopted' })
})

test('quarantine requires recover before adopt', () => {
  assert.equal(canAdopt('quarantine', { ok: true }).ok, false)
  assert.deepEqual(transition('quarantine', 'recover'), { ok: true, state: 'verified' })
})

test('credentials/config fields are rejected', () => {
  assert.throws(() => assertSafeArtifact({ session: { token: 'x' } }), /reflow-forbidden-field/)
  assert.throws(() => assertSafeArtifact({ config: { password: 'x' } }), /reflow-forbidden-field/)
  assert.equal(canAdopt('verified', { session: { id: 's1' } }).ok, true)
})

test('adopted is terminal', () => {
  assert.equal(transition('adopted', 'adopt').ok, false)
  assert.equal(transition('adopted', 'quarantine').ok, false)
})
