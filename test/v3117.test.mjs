// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v3.1.17：identity 诊断字段、会话映射透传、annotated tag 钩子兼容。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { apply as applyAdapter } from '../src/plugins/adapter.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

function fakeCtx(role = 'fork') {
  const services = new Map()
  const routes = []
  const webServer = {
    register(entry) { routes.push(entry); return () => {} },
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) { return services.get(name) ?? null },
    provide(name, value) { services.set(name, value); return () => {} },
    effect(fn) { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
    inject(names, fn) { if (Array.isArray(names) && names.includes('webServer')) fn({ get: (n) => (n === 'webServer' ? webServer : null) }) },
    on() { return () => {} },
    emit() {},
  }
  return { ctx, services, routes }
}

test('identity: surface/clientLoaded are exposed without leaking taskId or token', () => {
  const source = read('src/plugins/adapter.mjs')
  assert.match(source, /surface: 'web-adapter'/)
  assert.match(source, /clientLoaded: clientReported/)
  assert.match(source, /clientReportedAt: clientReportedAt \|\| null/)
  // identity 载荷不得把 taskId/sessionId/token 作为字段输出（taskId 仅用于内部推导 kind）
  const identityBlock = source.slice(source.indexOf('const identity = () => ({'), source.indexOf('const approvals'))
  assert.equal(/\btaskId:/.test(identityBlock), false, 'identity must not expose taskId as a field')
  assert.equal(/\bsessionId:/.test(identityBlock), false, 'identity must not expose sessionId as a field')
  assert.equal(/\btoken:/i.test(identityBlock), false, 'identity must not expose token as a field')
})

test('client-report: route is registered and reports only a timestamp', () => {
  const previousRole = process.env.DSH_FANG_ROLE
  process.env.DSH_FANG_ROLE = 'fork'
  const { ctx, routes } = fakeCtx('fork')
  const service = applyAdapter(ctx, { prefix: '/fang', taskId: 'rt-test' })
  if (previousRole === undefined) delete process.env.DSH_FANG_ROLE
  else process.env.DSH_FANG_ROLE = previousRole
  const paths = routes.map((route) => route.path)
  assert.ok(paths.includes('/fang/adapter/identity'), 'identity route registered')
  assert.ok(paths.includes('/fang/adapter/client-report'), 'client report route registered')
  assert.equal(typeof service.reportClient, 'function')
  const first = service.reportClient()
  assert.equal(first.ok, true)
  assert.equal(typeof first.at, 'number')
  const identity = service.identity()
  assert.equal(identity.clientLoaded, true)
  assert.equal(identity.surface, 'web-adapter')
  assert.equal(typeof identity.clientReportedAt, 'number')
})

test('session-catalog: sessionKey/ticketId are echoed back for 3_Sessions alignment', () => {
  const source = read('src/plugins/session-catalog.mjs')
  assert.match(source, /const sessionKey = typeof opts\.sessionKey/)
  assert.match(source, /const ticketId = typeof opts\.ticketId/)
  assert.match(source, /\.\.\.\(sessionKey \? \{ sessionKey \} : \{\}\)/)
  assert.match(source, /\.\.\.\(ticketId \? \{ ticketId \} : \{\}\)/)
})

test('badge: client has brand mount, body fallback and 3 retries', () => {
  const client = read('client.js')
  assert.match(client, /function mountWebRoleBadge/)
  assert.match(client, /placeFallback/)
  assert.match(client, /tries >= 3/, 'falls back after 3 retries')
  assert.match(client, /fang-web-role--fallback/, 'fallback marker class')
  assert.match(client, /fang\/adapter\/client-report/, 'client reports its own load')
  assert.equal(/'position: 'fixed'/.test(client), false)
  assert.match(client, /el\.style\.position = 'fixed'/)
})

test('hook: annotated version tags are peeled before the main-first-parent check', () => {
  const hook = read('.githooks/pre-push')
  assert.match(hook, /\^\{commit\}/, 'hook peels tag objects to commits')
  assert.match(hook, /guard_sha/)
  const guard = read('tools/git/guard-main.mjs')
  assert.match(guard, /isVersionTag/)
  assert.match(guard, /commitSha/)
})
