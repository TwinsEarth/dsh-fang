// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// bridge-client: descriptor validation + the four bridge calls against a fake loopback server.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { tmpDir } from './helpers.mjs'
import { createBridgeClient, readBridgeDescriptor, BRIDGE_CODE } from '../src/lib/bridge-client.mjs'

const TOKEN = 'a'.repeat(64)

async function fakeBridge() {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization })
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' })
    if (req.url === '/v1/sessions' && req.method === 'GET') return send(200, { items: [{ id: 'session-1', title: 'PC 会话' }] })
    if (req.url?.startsWith('/v1/sessions/session-1/events')) return send(200, { events: [{ seq: 1, type: 'user/message' }] })
    if (req.url === '/v1/sessions/session-1/messages' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => send(200, { accepted: true, requestId: 'req-1', echo: JSON.parse(body) }))
      return
    }
    if (req.url === '/v1/sessions' && req.method === 'POST') return send(201, { id: 'session-2', cwd: 'E:\\pc' })
    return send(404, { error: 'not found' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, seen, port: server.address().port }
}

function writeDescriptor(dir, overrides = {}) {
  const file = path.join(dir, 'desktop-bridge.json')
  fs.writeFileSync(file, JSON.stringify({ version: 1, address: '127.0.0.1', port: 1, token: TOKEN, pid: 1, ...overrides }))
  return file
}

test('bridge-client: descriptor validation is fail-closed (missing / non-loopback / bad token)', () => {
  const dir = tmpDir('fang-bridge-')
  try {
    const missing = readBridgeDescriptor({ file: path.join(dir, 'nope.json') })
    assert.equal(missing.ok, false)
    assert.equal(missing.code, BRIDGE_CODE.UNAVAILABLE)

    const lan = readBridgeDescriptor({ file: writeDescriptor(dir, { address: '192.168.1.2' }) })
    assert.equal(lan.ok, false)
    assert.equal(lan.code, BRIDGE_CODE.INVALID)

    const bad = readBridgeDescriptor({ file: writeDescriptor(dir, { token: 'short' }) })
    assert.equal(bad.ok, false)
    assert.equal(bad.code, BRIDGE_CODE.INVALID)

    const ok = readBridgeDescriptor({ file: writeDescriptor(dir, { port: 45678 }) })
    assert.equal(ok.ok, true)
    assert.equal(ok.info.port, 45678)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('bridge-client: list/events/send/create hit the documented endpoints and never leak the token', async () => {
  const dir = tmpDir('fang-bridge-')
  const { server, seen, port } = await fakeBridge()
  try {
    const file = writeDescriptor(dir, { port })
    const client = createBridgeClient({ file, timeoutMs: 5000 })
    const status = await client.status()
    assert.equal(status.ok, true)

    const list = await client.listSessions()
    assert.equal(list.ok, true)
    assert.equal(list.items[0].id, 'session-1')

    const events = await client.events('session-1', { limit: 5 })
    assert.equal(events.ok, true)
    assert.equal(events.events.length, 1)

    const sent = await client.send('session-1', 'hello PC')
    assert.equal(sent.ok, true)
    assert.equal(sent.accepted, true)
    assert.equal(sent.requestId, 'req-1')

    const created = await client.create({ cwd: 'E:\\pc', title: 't' })
    assert.equal(created.ok, true)

    assert.equal(seen.every((s) => s.auth === `Bearer ${TOKEN}`), true)

    const missing = await client.events('', {})
    assert.equal(missing.code, BRIDGE_CODE.INVALID_INPUT)

    const server404 = createBridgeClient({ file, timeoutMs: 5000 })
    const bad = await server404.events('session-404', {})
    assert.equal(bad.ok, false)
    assert.equal(bad.code, BRIDGE_CODE.HTTP)
    assert.equal(bad.status, 404)
    assert.equal(JSON.stringify(bad).includes(TOKEN), false, 'token must never appear in results')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('bridge-client: missing descriptor surfaces bridge-unavailable, not a thrown error', async () => {
  const client = createBridgeClient({ file: path.join(tmpDir('fang-bridge-'), 'missing.json'), timeoutMs: 2000 })
  const out = await client.listSessions()
  assert.equal(out.ok, false)
  assert.equal(out.code, BRIDGE_CODE.UNAVAILABLE)
})
