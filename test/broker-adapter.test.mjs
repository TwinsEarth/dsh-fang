// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Broker } from '../src/lib/broker.mjs'
import { checkReadCapability, issueReadCapability } from '../src/lib/broker-adapter.mjs'

test('adapter issues read-only capability for its essence', () => {
  const broker = new Broker('secret')
  const token = issueReadCapability(broker, { role: 'essence', essenceId: 'e1' }, 'essence')
  assert.equal(checkReadCapability(broker, token, { root: 'essence', essenceId: 'e1', ownerEssenceId: 'e1' }).ok, true)
})

test('adapter cannot issue write or mirror access', () => {
  const broker = new Broker('secret')
  assert.throws(() => issueReadCapability(broker, { role: 'fork', forkId: 'f1' }, 'mirror'), /read-root-not-allowed/)
  const token = issueReadCapability(broker, { role: 'fork', forkId: 'f1' }, 'sessions')
  const out = checkReadCapability(broker, token, { root: 'sessions', forkId: 'f1', ownerForkId: 'f1', path: '../mirror' })
  assert.equal(out.ok, false)
})

test('adapter rejects foreign fork scope', () => {
  const broker = new Broker('secret')
  const token = issueReadCapability(broker, { role: 'fork', forkId: 'f1' }, 'sessions')
  assert.equal(checkReadCapability(broker, token, { root: 'sessions', forkId: 'f1', ownerForkId: 'f2' }).reason, 'wrong-fork')
})
