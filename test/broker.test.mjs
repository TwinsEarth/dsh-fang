// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Broker } from '../src/lib/broker.mjs'

const broker = () => new Broker(Buffer.from('test-secret'))

test('capability resolves for its scoped fork session', () => {
  const b = broker()
  const token = b.issue({ role: 'fork', root: 'sessions', op: 'write', forkId: 'f1' })
  const out = b.resolve({ token, root: 'sessions', op: 'write', forkId: 'f1', ownerForkId: 'f1' })
  assert.equal(out.ok, true)
  assert.equal(b.audit.length, 1)
})

test('capability cannot be reused for another fork', () => {
  const b = broker()
  const token = b.issue({ role: 'fork', root: 'sessions', op: 'write', forkId: 'f1' })
  assert.equal(b.resolve({ token, root: 'sessions', op: 'write', forkId: 'f2', ownerForkId: 'f2' }).reason, 'wrong-fork')
})

test('capability cannot escalate op or root', () => {
  const b = broker()
  const read = b.issue({ role: 'mother', root: 'mirror', op: 'read' })
  assert.equal(b.resolve({ token: read, root: 'mirror', op: 'write' }).reason, 'capability-mismatch')
  const sessionToken = b.issue({ role: 'fork', root: 'sessions', op: 'read', forkId: 'f1' })
  assert.equal(b.resolve({ token: sessionToken, root: 'mirror', op: 'read' }).reason, 'capability-mismatch')
})

test('tampered or expired token is rejected', () => {
  const b = broker()
  const token = b.issue({ role: 'fork', root: 'sessions', op: 'read', forkId: 'f1', ttlMs: -1 })
  assert.equal(b.resolve({ token, root: 'sessions', op: 'read' }).reason, 'bad-capability')
  const good = b.issue({ role: 'fork', root: 'sessions', op: 'read', forkId: 'f1' })
  assert.equal(b.resolve({ token: good.slice(0, -2) + 'xx', root: 'sessions', op: 'read' }).reason, 'bad-capability')
})

test('path traversal denied and audited', () => {
  const b = broker()
  const token = b.issue({ role: 'fork', root: 'sessions', op: 'read', forkId: 'f1' })
  const out = b.resolve({ token, root: 'sessions', op: 'read', forkId: 'f1', ownerForkId: 'f1', path: '../mirror' })
  assert.equal(out.ok, false)
  assert.equal(b.audit.at(-1).ok, false)
})
