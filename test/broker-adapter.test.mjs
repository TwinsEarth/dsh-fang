// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Broker } from '../src/lib/broker.mjs'
import { checkReadCapability, denialToHttp, issueReadCapability, resolveIdentity } from '../src/lib/broker-adapter.mjs'

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

test('resolveIdentity maps missing token to 401', () => {
  const out = resolveIdentity({ headers: {}, url: '/' }, () => ({ role: 'mother' }))
  assert.equal(out.ok, false)
  assert.equal(denialToHttp(out).status, 401)
})

test('resolveIdentity maps unknown token to 401 and denied identity to 403', () => {
  const unknown = resolveIdentity({ headers: { 'x-fang-auth': 't' }, url: '/' }, () => null)
  assert.equal(denialToHttp(unknown).status, 401)
  const denied = resolveIdentity({ headers: { authorization: 'Bearer t' }, url: '/' }, () => ({ denied: true, reason: 'wrong-essence' }))
  const http = denialToHttp(denied)
  assert.equal(http.status, 403)
  assert.equal(http.body.reason, 'wrong-essence')
})

test('resolveIdentity reads x-fang-auth and query token', () => {
  const h = resolveIdentity({ headers: { 'x-fang-auth': 'a' }, url: '/' }, () => ({ role: 'fork', forkId: 'f1' }))
  assert.equal(h.ok, true)
  assert.equal(h.forkId, 'f1')
  const q = resolveIdentity({ headers: {}, url: '/x?token=b' }, () => ({ role: 'essence', essenceId: 'e1' }))
  assert.equal(q.ok, true)
  assert.equal(q.essenceId, 'e1')
})
