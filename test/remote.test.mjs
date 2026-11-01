// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T5 — Remote 客户端单测（契约：docs/CONTRACTS-V2.md §5.2、PROTOCOL-V2.md §4）。
//
// 覆盖：withToken/extractToken 的幂等与编码、createRemote 的 URL 拼接/方法/token/limit/
// 命令信封、成功/超时/网络错误/非 JSON/405/无 fetch/循环 payload（永不抛出）、
// classifyRemoteFailure 的五类分类。全部用注入的假 fetch，不开真实 socket。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  withToken,
  extractToken,
  createRemote,
  classifyRemoteFailure,
  REMOTE_FAILURE_KIND,
} from '../src/lib/remote.mjs'

const BASE = 'http://127.0.0.1:58904'

/** 一个 Response 形状的假对象（与 fetch 返回值同构）。 */
function fakeResponse({ status = 200, body = {}, text = undefined } = {}) {
  const payload = text !== undefined ? String(text) : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    async text() {
      return payload
    },
    async json() {
      return body
    },
  }
}

/** 记录调用的假 fetch：responder(url, init) 决定返回/抛错。 */
function makeFetch(responder) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return responder(url, init)
  }
  impl.calls = calls
  return impl
}

const parsed = (url) => new URL(url)

test('withToken: append / replace / idempotent / hash preserved', () => {
  assert.equal(withToken(`${BASE}/`, 'abc'), `${BASE}/?token=abc`)
  assert.equal(withToken(`${BASE}/?token=old`, 'new'), `${BASE}/?token=new`)
  assert.equal(withToken(`${BASE}/?token=same`, 'same'), `${BASE}/?token=same`, 'idempotent')
  assert.equal(withToken(`${BASE}/?a=1&token=old&b=2`, 'new'), `${BASE}/?a=1&token=new&b=2`, 'replace in place')
  assert.equal(withToken(`${BASE}/?a=1`, 't k'), `${BASE}/?a=1&token=t%20k`, 'encoded')
  assert.equal(withToken(`${BASE}/?a=1#frag`, 'tok'), `${BASE}/?a=1&token=tok#frag`, 'hash stays last')
  assert.equal(withToken(`${BASE}/?`, 'tok'), `${BASE}/?token=tok`, 'trailing ? is not duplicated')
  assert.equal(withToken(`${BASE}/?a=1`, ''), `${BASE}/?a=1`, 'no token → untouched')
  assert.equal(withToken(`${BASE}/?token=a&token=b`, 'z'), `${BASE}/?token=z`, 'duplicate tokens collapse')
  assert.equal(withToken(undefined, undefined), '', 'undefined inputs are safe')
})

test('extractToken: plain / mixed params / encoded / missing', () => {
  assert.equal(extractToken('http://h:1/?token=abc'), 'abc')
  assert.equal(extractToken('http://h:1/?a=1&token=t%20k&b=2'), 't k')
  assert.equal(extractToken('http://h:1/fang/x?token=xyz#f'), 'xyz')
  assert.equal(extractToken('http://h:1/'), '')
  assert.equal(extractToken('http://h:1/?tok=1'), '')
  assert.equal(extractToken(undefined), '')
  assert.equal(extractToken(withToken(`${BASE}/?a=1`, 'rt')), 'rt', 'roundtrip with withToken')
})

test('hello(): GET /fang/adapter/hello with token; ok envelope', async () => {
  const fetchImpl = makeFetch(() => fakeResponse({
    body: { ok: true, role: 'fork', taskId: 'task_1', version: '2.0.0', capabilities: ['ping'] },
  }))
  const remote = createRemote({ url: `${BASE}/`, token: 'tok', fetchImpl })
  const out = await remote.hello()

  assert.equal(out.ok, true)
  assert.equal(out.status, 200)
  assert.equal(out.data.role, 'fork')
  assert.equal(out.data.taskId, 'task_1')
  assert.equal(fetchImpl.calls.length, 1)
  const { url, init } = fetchImpl.calls[0]
  assert.equal(init.method, 'GET')
  assert.equal(parsed(url).pathname, '/fang/adapter/hello')
  assert.equal(parsed(url).searchParams.get('token'), 'tok')
  assert.equal(init.body, undefined)
  assert.ok(init.signal, 'timeout must pass an AbortSignal')
})

test('status/approvals/audit: paths, methods and limit query', async () => {
  const responses = {
    '/fang/adapter/status': { ok: true, taskId: 't', role: 'fork', audit: { records: 3 } },
    '/fang/adapter/approvals': { ok: true, items: [{ id: 'a1' }] },
    '/fang/adapter/audit': { ok: true, records: [{ kind: 'boot' }] },
  }
  const fetchImpl = makeFetch((url) => fakeResponse({ body: responses[parsed(url).pathname] ?? {} }))
  const remote = createRemote({ url: `${BASE}/?token=tok`, fetchImpl })

  const status = await remote.status()
  assert.equal(status.ok, true)
  assert.equal(status.data.audit.records, 3)
  assert.equal(parsed(fetchImpl.calls[0].url).pathname, '/fang/adapter/status')
  assert.equal(fetchImpl.calls[0].init.method, 'GET')

  const approvals = await remote.approvals()
  assert.equal(approvals.ok, true)
  assert.equal(approvals.data.items.length, 1)

  const audit = await remote.audit({ limit: 7 })
  assert.equal(audit.ok, true)
  const auditUrl = parsed(fetchImpl.calls[2].url)
  assert.equal(auditUrl.pathname, '/fang/adapter/audit')
  assert.equal(auditUrl.searchParams.get('limit'), '7')
  assert.equal(auditUrl.searchParams.get('token'), 'tok', 'token preserved on query requests')

  await remote.audit()
  assert.equal(parsed(fetchImpl.calls[3].url).searchParams.get('limit'), '100', 'audit default limit is 100')
})

test('command()/ping(): POST JSON {op,payload}', async () => {
  const fetchImpl = makeFetch(() => fakeResponse({ body: { ok: true, op: 'read-plugin', result: { files: { 'a.js': 'x' } } } }))
  const remote = createRemote({ url: `${BASE}/`, token: 'tok', fetchImpl })

  const read = await remote.command('read-plugin', { pluginId: 'plug' })
  assert.equal(read.ok, true)
  assert.equal(read.data.result.files['a.js'], 'x')

  const { url, init } = fetchImpl.calls[0]
  assert.equal(init.method, 'POST')
  assert.equal(parsed(url).pathname, '/fang/adapter/command')
  assert.equal(init.headers['content-type'], 'application/json; charset=utf-8')
  assert.deepEqual(JSON.parse(init.body), { op: 'read-plugin', payload: { pluginId: 'plug' } })

  // 对象形式（{op,payload}）的容错
  await remote.command({ op: 'flush-buffer', payload: { strictMs: 10 } })
  assert.deepEqual(JSON.parse(fetchImpl.calls[1].init.body), { op: 'flush-buffer', payload: { strictMs: 10 } })

  const ping = await remote.ping()
  assert.equal(ping.ok, true)
  assert.deepEqual(JSON.parse(fetchImpl.calls[2].init.body), { op: 'ping', payload: {} })
})

test('createRemote: token precedence (option > URL) and custom prefix', async () => {
  const fetchImpl = makeFetch(() => fakeResponse({ body: { ok: true } }))

  // token 省略 → 从 URL 提取；URL 里原有 token 不会被丢弃
  const fromUrl = createRemote({ url: `${BASE}/?token=url-token`, fetchImpl })
  await fromUrl.hello()
  assert.equal(parsed(fetchImpl.calls[0].url).searchParams.get('token'), 'url-token')

  // 显式 token → 替换 URL 里的旧 token（不出现两个 token 参数）
  const replaced = createRemote({ url: `${BASE}/?token=old`, token: 'new-token', fetchImpl })
  await replaced.hello()
  const replacedUrl = fetchImpl.calls[1].url
  assert.equal(parsed(replacedUrl).searchParams.get('token'), 'new-token')
  assert.equal(parsed(replacedUrl).searchParams.getAll('token').length, 1)

  const custom = createRemote({ url: `${BASE}/`, token: 't', prefix: 'x/', fetchImpl })
  await custom.status()
  assert.equal(parsed(fetchImpl.calls[2].url).pathname, '/x/adapter/status')
})

test('http failure: 405 → {ok:false, kind:http, status:405}', async () => {
  const fetchImpl = makeFetch(() => fakeResponse({
    status: 405,
    body: { ok: false, code: 'method-not-allowed', error: 'method-not-allowed' },
  }))
  const remote = createRemote({ url: `${BASE}/`, token: 'tok', fetchImpl })
  const out = await remote.command('ping', {})

  assert.equal(out.ok, false)
  assert.equal(out.status, 405)
  assert.equal(out.kind, REMOTE_FAILURE_KIND.HTTP)
  assert.equal(out.error, 'method-not-allowed')
  assert.equal(out.data.code, 'method-not-allowed')
})

test('non-JSON 2xx body → {ok:false, kind:json}', async () => {
  const fetchImpl = makeFetch(() => ({
    ok: true,
    status: 200,
    async text() {
      return '<html>not json</html>'
    },
  }))
  const remote = createRemote({ url: `${BASE}/`, token: 'tok', fetchImpl })
  const out = await remote.status()

  assert.equal(out.ok, false)
  assert.equal(out.status, 200)
  assert.equal(out.kind, REMOTE_FAILURE_KIND.JSON)
  assert.match(out.error, /json/i)
})

test('response with only json() is still accepted', async () => {
  const fetchImpl = makeFetch(() => ({
    ok: true,
    status: 200,
    async json() {
      return { ok: true, role: 'fork' }
    },
  }))
  const out = await createRemote({ url: `${BASE}/`, token: 'tok', fetchImpl }).hello()
  assert.equal(out.ok, true)
  assert.equal(out.data.role, 'fork')
})

test('timeout: AbortController aborts the fetch, returns kind=timeout and never throws', async () => {
  let sawAbort = false
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      sawAbort = true
      reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
    })
  })
  const remote = createRemote({ url: `${BASE}/`, token: 'tok', fetchImpl, timeoutMs: 25 })
  const startedAt = Date.now()
  const out = await remote.hello()

  assert.equal(out.ok, false)
  assert.equal(out.status, 0)
  assert.equal(out.kind, REMOTE_FAILURE_KIND.TIMEOUT)
  assert.equal(sawAbort, true, 'timeout must abort the in-flight request')
  assert.ok(Date.now() - startedAt < 2000, 'must not hang for the default timeout')
  assert.equal(typeof out.error, 'string')
})

test('network failure / missing fetch / sync throw never escape', async () => {
  const network = createRemote({
    url: `${BASE}/`,
    token: 'tok',
    fetchImpl: async () => {
      throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' })
    },
  })
  const down = await network.status()
  assert.equal(down.ok, false)
  assert.equal(down.kind, REMOTE_FAILURE_KIND.NETWORK)
  assert.equal(down.status, 0)

  const noFetch = createRemote({ url: `${BASE}/`, token: 'tok', fetchImpl: null })
  const missing = await noFetch.status()
  assert.equal(missing.ok, false)
  assert.equal(missing.error, 'no-fetch')
  assert.equal(missing.kind, REMOTE_FAILURE_KIND.NETWORK)

  const syncThrow = createRemote({
    url: `${BASE}/`,
    token: 'tok',
    fetchImpl: () => {
      throw new TypeError('boom')
    },
  })
  const thrown = await syncThrow.status()
  assert.equal(thrown.ok, false)
  assert.equal(thrown.kind, REMOTE_FAILURE_KIND.NETWORK)

  // 循环 payload：JSON.stringify 抛错也必须返回对象而不是抛
  const circular = {}
  circular.self = circular
  const firstCall = createRemote({ url: `${BASE}/`, token: 'tok', fetchImpl: async () => fakeResponse() })
  const serialized = await firstCall.command('ping', circular)
  assert.equal(serialized.ok, false)
  assert.equal(typeof serialized.error, 'string')
})

test('classifyRemoteFailure: timeout / json / http / network / unknown', () => {
  const timeout = classifyRemoteFailure(Object.assign(new Error('aborted'), { name: 'AbortError' }))
  assert.equal(timeout.kind, 'timeout')
  assert.equal(timeout.message, 'aborted')

  const byCode = classifyRemoteFailure(Object.assign(new Error('x'), { code: 'ABORT_ERR' }))
  assert.equal(byCode.kind, 'timeout')

  const json = classifyRemoteFailure(new SyntaxError('Unexpected token < in JSON'))
  assert.equal(json.kind, 'json')

  const http = classifyRemoteFailure(Object.assign(new Error('bad gateway'), { status: 502 }))
  assert.equal(http.kind, 'http')

  const network = classifyRemoteFailure(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }))
  assert.equal(network.kind, 'network')

  const unknown = classifyRemoteFailure(new Error('something odd'))
  assert.equal(unknown.kind, 'unknown')
  assert.equal(unknown.message, 'something odd')

  const nil = classifyRemoteFailure(undefined)
  assert.equal(nil.kind, 'unknown')
  assert.equal(typeof nil.message, 'string')
})

test('v3: version/health/state/commands 路径与 Bearer 头', async () => {
  const fetch = makeFetch(() => fakeResponse({ body: { ok: true } }))
  const remote = createRemote({ url: BASE, token: 't', adapterToken: 'a-tok', fetchImpl: fetch })

  await remote.version()
  await remote.health()
  await remote.state()
  await remote.commands({ commandId: 'cmd_1', op: 'ping' })

  assert.deepEqual(
    fetch.calls.map((call) => new URL(call.url).pathname),
    ['/fang/adapter/version', '/fang/adapter/health', '/fang/adapter/state', '/fang/adapter/commands'],
    'v3 四个 JSON 端点路径',
  )
  for (const call of fetch.calls) {
    assert.equal(call.init.headers.authorization, 'Bearer a-tok', '每个请求都带 v3 Bearer')
    assert.equal(new URL(call.url).searchParams.get('token'), 't', 'DSH web token 仍走 ?token=')
  }
  assert.deepEqual(JSON.parse(fetch.calls[3].init.body), { commandId: 'cmd_1', op: 'ping' })
})

test('v3: eventsUrl 带 since/session；无 adapterToken 时不发 Authorization（v2 兼容）', async () => {
  const fetch = makeFetch(() => fakeResponse({ body: { ok: true } }))
  const remote = createRemote({ url: BASE, token: 't', fetchImpl: fetch })

  const events = new URL(remote.eventsUrl({ since: '12', session: 's-1' }))
  assert.equal(events.pathname, '/fang/adapter/events')
  assert.equal(events.searchParams.get('since'), '12')
  assert.equal(events.searchParams.get('session'), 's-1')
  assert.equal(events.searchParams.get('token'), 't')
  assert.deepEqual(remote.authHeaders(), {})

  await remote.state()
  assert.equal(fetch.calls[0].init.headers, undefined, 'v2 兼容模式不发 Authorization')
})
