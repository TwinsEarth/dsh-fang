// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.8 contract test — every plugin that owns /fang/api/* must use the same
// Host/Origin/token gate as orchestrator, and method errors must not precede auth.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { makeCtx, makeWebServerStub, makeReq, makeRes, TEST_AUTH_TOKEN } from './helpers.mjs'
import * as sessionBridge from '../src/plugins/session-bridge.mjs'
import * as sessionSync from '../src/plugins/session-sync.mjs'
import * as sessionRouter from '../src/plugins/session-router.mjs'

async function withHome(fn) {
  const saved = process.env.DSH_HOME
  const savedRole = process.env.DSH_FANG_ROLE
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-http-contract-'))
  process.env.DSH_HOME = home
  delete process.env.DSH_FANG_ROLE
  try {
    return await fn(home)
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    if (savedRole === undefined) delete process.env.DSH_FANG_ROLE
    else process.env.DSH_FANG_ROLE = savedRole
    fs.rmSync(home, { recursive: true, force: true })
  }
}

function applyPlugin(plugin, config = {}) {
  const ws = makeWebServerStub()
  const ctx = makeCtx({ services: { webServer: ws } })
  plugin.apply(ctx, { authToken: TEST_AUTH_TOKEN, ...config })
  return { ctx, ws }
}

function exact(ws, method, routePath) {
  const route = ws.find(method, routePath)
  assert.ok(route, `${method} ${routePath} must be registered`)
  return route.handler
}

async function call(handler, { url = '/', method = 'GET', token = TEST_AUTH_TOKEN, host = '127.0.0.1:1', origin = undefined } = {}) {
  const req = makeReq(undefined, method)
  req.url = url
  req.headers.host = host
  if (origin !== undefined) req.headers.origin = origin
  if (token === null) delete req.headers['x-fang-auth']
  else req.headers['x-fang-auth'] = token
  const res = makeRes()
  await handler(req, res)
  return res
}

for (const [label, plugin, routePath] of [
  ['session-bridge', sessionBridge, '/fang/api/bridge/status'],
  ['session-sync', sessionSync, '/fang/api/sync/status'],
  ['session-router', sessionRouter, '/fang/api/route'],
]) {
  test(`${label}: HTTP route uses the shared Host/Origin/token gate`, () => withHome(async () => {
    const { ctx, ws } = applyPlugin(plugin)
    if (label === 'session-bridge') {
      const shared = ws.routes.filter((r) => r.path === '/fang/api/bridge/sessions')
      assert.equal(shared.length, 1, 'GET+POST /bridge/sessions must share one path registration')
      assert.equal(shared[0].method, 'GET,POST')
    }
    const handler = exact(ws, 'GET', routePath)

    const ok = await call(handler, { url: routePath })
    assert.equal(ok.statusCode, 200, `${label} with token → 200`)

    const noToken = await call(handler, { url: routePath, token: null })
    assert.equal(noToken.statusCode, 401, `${label} without token → 401`)
    assert.equal(noToken.json().code, 'unauthorized')

    const badHost = await call(handler, { url: routePath, host: 'evil.example' })
    assert.equal(badHost.statusCode, 403, `${label} bad Host → 403`)
    assert.equal(badHost.json().code, 'bad-host')

    const badOrigin = await call(handler, { url: routePath, origin: 'https://evil.example' })
    assert.equal(badOrigin.statusCode, 403, `${label} cross-origin → 403`)
    assert.equal(badOrigin.json().code, 'bad-origin')

    const wrongMethod = await call(handler, { url: routePath, method: 'POST', token: null })
    assert.equal(wrongMethod.statusCode, 401, `${label} auth precedes method`)
    const wrongMethodAuthed = await call(handler, { url: routePath, method: 'POST' })
    assert.equal(wrongMethodAuthed.statusCode, 405)
    assert.equal(wrongMethodAuthed.headers.allow, 'GET')
    ctx.dispose()
  }))
}
