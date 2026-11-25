// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  parseNetstatEstablished, parseLsofOwners, findLsofPeer,
  parseProcNetTcp, requestPeerPorts, verifyPeerOwner,
} from '../src/lib/peer-owner.mjs'
import * as orchestrator from '../src/plugins/orchestrator.mjs'
import { makeCtx, makeWebServerStub, makeReq, makeRes, TEST_AUTH_TOKEN } from './helpers.mjs'

test('peer-owner: netstat rows separate host and peer directions', () => {
  const text = [
    '  TCP    127.0.0.1:5000    127.0.0.1:6000    ESTABLISHED    111',
    '  TCP    127.0.0.1:6000    127.0.0.1:5000    ESTABLISHED    222',
  ].join('\n')
  const rows = parseNetstatEstablished(text, 5000, 6000)
  assert.deepEqual(rows, [{ pid: 111, direction: 'host' }, { pid: 222, direction: 'peer' }])
})

test('peer-owner: lsof blocks expose the peer UID and PID', () => {
  const text = [
    'p111', 'cnode', 'u501', 'n127.0.0.1:5000->127.0.0.1:6000',
    'p222', 'cchrome', 'u502', 'n127.0.0.1:6000->127.0.0.1:5000',
  ].join('\n')
  assert.deepEqual(parseLsofOwners(text)[1], { pid: 222, uid: 502, name: '127.0.0.1:6000->127.0.0.1:5000' })
  assert.deepEqual(findLsofPeer(text, 5000, 6000), { pid: 222, uid: 502 })
})

test('peer-owner: /proc/net/tcp rows expose the peer socket UID', () => {
  const header = '  sl  local_address rem_address   st tx_queue:rx_queue tr:tm->when retrnsmt   uid  timeout inode'
  const text = [
    header,
    '   0: 0100007F:1388 0100007F:1770 01 00000000:00000000 00:00000000 00000000 501 0 1',
    '   1: 0100007F:1770 0100007F:1388 01 00000000:00000000 00:00000000 00000000 502 0 2',
  ].join('\n')
  const rows = parseProcNetTcp(text, 5000, 6000)
  assert.deepEqual(rows, [{ uid: 501, direction: 'host' }, { uid: 502, direction: 'peer' }])
})

test('peer-owner: missing socket or missing peer row fails closed', async () => {
  assert.deepEqual(requestPeerPorts({ socket: {} }), null)
  const noSocket = await verifyPeerOwner({ socket: {} })
  assert.equal(noSocket.ok, false)
  assert.equal(noSocket.error, 'peer-socket-unavailable')
  const noPeer = findLsofPeer('p1\ncnode\nu501\nn127.0.0.1:5000->127.0.0.1:6000\n', 5000, 6000)
  assert.equal(noPeer, null)
})

test('peer-owner: auth-token bootstrap denies a caller that is not the host owner', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-peer-owner-'))
  const webServer = makeWebServerStub()
  const ctx = makeCtx({ services: { webServer } })
  let calls = 0
  orchestrator.apply(ctx, {
    dataRoot,
    forksRoot: path.join(dataRoot, 'forks'),
    routes: { enabled: true, prefix: '/fang' },
    authToken: TEST_AUTH_TOKEN,
    peerOwnerVerifier: async () => { calls += 1; return { ok: false, error: 'not-host-owner' } },
  })
  const route = webServer.find('GET', '/fang/api/auth-token')
  const res = makeRes()
  await route.handler(makeReq(), res)
  assert.equal(calls, 1)
  assert.equal(res.statusCode, 403)
  assert.equal(res.json()?.code, 'not-host-owner')
  ctx.dispose()
  fs.rmSync(dataRoot, { recursive: true, force: true })
})

test('peer-owner: auth-token bootstrap allows the host owner', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-peer-owner-ok-'))
  const webServer = makeWebServerStub()
  const ctx = makeCtx({ services: { webServer } })
  orchestrator.apply(ctx, {
    dataRoot,
    forksRoot: path.join(dataRoot, 'forks'),
    routes: { enabled: true, prefix: '/fang' },
    authToken: TEST_AUTH_TOKEN,
    peerOwnerVerifier: async () => ({ ok: true, peerPid: 123 }),
  })
  const route = webServer.find('GET', '/fang/api/auth-token')
  const res = makeRes()
  await route.handler(makeReq(), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.json()?.token, TEST_AUTH_TOKEN)
  ctx.dispose()
  fs.rmSync(dataRoot, { recursive: true, force: true })
})
