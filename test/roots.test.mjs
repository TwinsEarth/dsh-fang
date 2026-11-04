import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ROLES, ROOTS, canAccess } from '../src/lib/roots.mjs'

test('coordinator owns all three roots', () => {
  for (const root of Object.values(ROOTS)) assert.equal(canAccess({ role: ROLES.COORDINATOR, root, op: 'write' }), true)
})

test('mother is read-only on mirror and denied elsewhere', () => {
  assert.equal(canAccess({ role: ROLES.MOTHER, root: ROOTS.MIRROR, op: 'read' }), true)
  assert.equal(canAccess({ role: ROLES.MOTHER, root: ROOTS.MIRROR, op: 'write' }), false)
  assert.equal(canAccess({ role: ROLES.MOTHER, root: ROOTS.ESSENCE, op: 'read' }), false)
  assert.equal(canAccess({ role: ROLES.MOTHER, root: ROOTS.SESSIONS, op: 'read' }), false)
})

test('essence reads mirror and writes only its own essence dir', () => {
  assert.equal(canAccess({ role: ROLES.ESSENCE, root: ROOTS.MIRROR, op: 'read' }), true)
  assert.equal(canAccess({ role: ROLES.ESSENCE, root: ROOTS.ESSENCE, op: 'write', essenceId: 'e1', ownerEssenceId: 'e1' }), true)
  assert.equal(canAccess({ role: ROLES.ESSENCE, root: ROOTS.ESSENCE, op: 'write', essenceId: 'e2', ownerEssenceId: 'e1' }), false)
  assert.equal(canAccess({ role: ROLES.ESSENCE, root: ROOTS.SESSIONS, op: 'read' }), false)
})

test('fork reads its essence and writes only its own session', () => {
  assert.equal(canAccess({ role: ROLES.FORK, root: ROOTS.MIRROR, op: 'read' }), false)
  assert.equal(canAccess({ role: ROLES.FORK, root: ROOTS.ESSENCE, op: 'read', essenceId: 'e1', ownerEssenceId: 'e1' }), true)
  assert.equal(canAccess({ role: ROLES.FORK, root: ROOTS.ESSENCE, op: 'write' }), false)
  assert.equal(canAccess({ role: ROLES.FORK, root: ROOTS.SESSIONS, op: 'write', forkId: 'f1', ownerForkId: 'f1' }), true)
  assert.equal(canAccess({ role: ROLES.FORK, root: ROOTS.SESSIONS, op: 'write', forkId: 'f2', ownerForkId: 'f1' }), false)
})

test('path traversal and null bytes fail closed', () => {
  assert.equal(canAccess({ role: ROLES.FORK, root: ROOTS.SESSIONS, op: 'read', path: '../mirror' }), false)
  assert.equal(canAccess({ role: ROLES.FORK, root: ROOTS.SESSIONS, op: 'read', path: 'a\0b' }), false)
})
