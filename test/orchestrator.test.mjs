// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// orchestrator v2 单测：任务语义（create/status/promote/archive）+ 跨进程 Adapter 协议
// + 角色门禁 + v1 兼容别名。用假 forker 与一个本地 HTTP Adapter 桩，不 spawn 任何真实进程。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import zlib from 'node:zlib'

import { makeCtx, makeWebServerStub, makeReq, makeRes } from './helpers.mjs'
import { SERVICE } from '../src/kernel/index.mjs'
import * as orchestrator from '../src/plugins/orchestrator.mjs'
import { encodeWorkspaceKey } from '../src/lib/session-format.mjs'

const hasRemote = await import('../src/lib/remote.mjs').then(() => true).catch(() => false)
const skipNoRemote = hasRemote ? {} : { skip: 'src/lib/remote.mjs not delivered yet (T5)' }

function makeFakeForker(overrides = {}) {
  const calls = { provision: [], spawn: [], reap: [] }
  const live = new Set()
  let counter = 0
  const fake = {
    calls,
    async provision(args) {
      calls.provision.push(args)
      fs.mkdirSync(path.join(args.homeDir, 'profiles', args.profile), { recursive: true })
      // The orchestrator now refuses forks whose profile cannot resolve this bundle,
      // so the fake forker must materialize the marker (real forker junctions it).
      fs.mkdirSync(path.join(args.homeDir, 'profiles', args.profile, 'node_modules', '@local', 'dsh-fang'), { recursive: true })
      return { ok: true, homeDir: args.homeDir, profileDir: path.join(args.homeDir, 'profiles', args.profile) }
    },
    async spawn(args) {
      calls.spawn.push(args)
      live.add(args.forkId)
      counter += 1
      const port = overrides.port ?? 18000 + counter
      const url = overrides.url ?? `http://127.0.0.1:${port}/?token=tok`
      return { ok: true, pid: 6000 + counter, port, url, token: 'tok' }
    },
    async reap(forkId) {
      calls.reap.push(forkId)
      live.delete(forkId)
      return { ok: true, removed: true }
    },
    status(forkId) { return { running: live.has(forkId), pid: live.has(forkId) ? 6001 : null } },
    list() { return [...live].map(forkId => ({ forkId, running: true })) },
    logs() { return '' },
    ...overrides,
  }
  return fake
}

/** A real HTTP server that behaves like the fork-side Adapter (contract §5.1). */
async function makeAdapterServer(opts = {}) {
  const state = { commands: [], hello: 0, status: 0 }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if (url.pathname.endsWith('/adapter/hello')) {
      state.hello += 1
      return send(200, { ok: true, role: 'fork', taskId: url.searchParams.get('taskId') ?? 't', version: '2.0.0', capabilities: [] })
    }
    if (url.pathname.endsWith('/adapter/status')) {
      state.status += 1
      return send(200, {
        ok: true, taskId: 't', role: 'fork', services: { scorer: true, hotReloader: true },
        buffer: { state: 'settled', pending: 0 }, approvals: { pending: 0 }, audit: { records: 3, head: 'abc' },
      })
    }
    if (url.pathname.endsWith('/adapter/command')) {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        let body = {}
        try { body = JSON.parse(raw) } catch { /* ignore */ }
        state.commands.push(body)
        const op = body.op
        if (op === 'read-plugin') {
          return send(200, {
            ok: true, op,
            result: {
              files: opts.files ?? {
                'index.js': 'export const name = "plug"',
                'package.json': '{"name":"plug","version":"1.0.0","type":"module"}',
              },
            },
          })
        }
        if (op === 'score-plugin') return send(200, { ok: true, op, result: opts.forkScore ?? { grade: 'B', S: 30, color: 'blue' } })
        if (op === 'archive') return send(200, { ok: true, op, result: { archived: true } })
        return send(200, { ok: true, op, result: {} })
      })
      return undefined
    }
    return send(404, { ok: false, error: 'not-found' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    url: `http://127.0.0.1:${port}/?token=tok`,
    port,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function boot({ forker = makeFakeForker(), extraServices = {}, config = {} } = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-orch2-'))
  const ctx = makeCtx({ services: { [SERVICE.forker]: forker, ...extraServices } })
  orchestrator.apply(ctx, {
    dataRoot,
    forksRoot: path.join(dataRoot, 'forks'),
    adapterTimeoutMs: 400,
    adapterPollMs: 40,
    routes: { enabled: false },
    ...config,
  })
  const svc = ctx.get(SERVICE.orchestrator)
  return { ctx, svc, forker, dataRoot }
}

function cleanup(ctx, dataRoot) {
  try { ctx.dispose() } catch { /* ignore */ }
  try { fs.rmSync(dataRoot, { recursive: true, force: true }) } catch { /* ignore */ }
}

test('orchestrator: registers service; status exposes tasks, forks compat, commercial flags', async () => {
  const { ctx, svc, dataRoot } = await boot()
  assert.ok(svc)
  assert.equal(svc.version, '2.3.1')
  assert.equal(svc.role, 'mother')
  const st = svc.status()
  assert.equal(st.tasks.total, 0)
  assert.equal(st.tasks.max, 8)
  assert.deepEqual(st.forks.list, [], 'v1 compat view')
  assert.equal(st.commercial.backup, false)
  assert.equal(st.services.forker, true)
  assert.equal(st.services.adapter, false, 'mother has no adapter service')
  cleanup(ctx, dataRoot)
})

test('orchestrator: role matrix — a fork never lets orchestrator activate', async () => {
  const previous = process.env.DSH_FANG_ROLE
  process.env.DSH_FANG_ROLE = 'fork'
  try {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-orch2-fork-'))
    const ctx = makeCtx()
    orchestrator.apply(ctx, { dataRoot, routes: { enabled: false } })
    assert.equal(ctx.get(SERVICE.orchestrator), undefined, 'orchestrator must not exist in fork role')
    ctx.dispose()
    fs.rmSync(dataRoot, { recursive: true, force: true })
  } finally {
    if (previous === undefined) delete process.env.DSH_FANG_ROLE
    else process.env.DSH_FANG_ROLE = previous
  }
})

test('orchestrator: createTask degrades honestly when the adapter never answers', async () => {
  const { ctx, svc, forker, dataRoot } = await boot({ forker: makeFakeForker({ url: 'http://127.0.0.1:1/?token=tok' }) })
  const out = await svc.createTask({ title: '开发 dsh-foo' })
  assert.equal(out.ok, true)
  assert.ok(out.taskId.startsWith('task_'))
  assert.equal(out.adapter.ok, false, 'no adapter server → adapter not ready')
  assert.equal(out.url.includes('?token='), true)
  const list = svc.listTasks()
  assert.equal(list.length, 1)
  assert.equal(list[0].title, '开发 dsh-foo')
  assert.equal(list[0].status, 'running', 'reachable-but-adapter-down → running, not ready')
  assert.equal(forker.calls.spawn.length, 1)
  assert.equal(forker.calls.spawn[0].env.DSH_FANG_ROLE, 'fork')
  assert.equal(forker.calls.spawn[0].env.DSH_FANG_TASK_ID, out.taskId)
  cleanup(ctx, dataRoot)
})

test('orchestrator: quota refuses the second task and v1 fork() stays an alias', async () => {
  const { ctx, svc, dataRoot } = await boot({ config: { maxForks: 1 } })
  const a = await svc.fork({ taskTitle: 'a' })
  assert.equal(a.ok, true, 'v1 alias works')
  assert.equal(svc.listForks().length, 1)
  const b = await svc.createTask({ title: 'b' })
  assert.equal(b.ok, false)
  assert.equal(b.error, 'quota-exceeded')
  cleanup(ctx, dataRoot)
})

test('orchestrator: adapter handshake makes the task ready', skipNoRemote, async () => {
  const adapter = await makeAdapterServer()
  try {
    const { ctx, svc, dataRoot } = await boot({ forker: makeFakeForker({ url: adapter.url, port: adapter.port }) })
    const out = await svc.createTask({ title: '握手任务' })
    assert.equal(out.ok, true)
    assert.equal(out.adapter.ok, true, `adapter should be ready (hello=${adapter.state.hello})`)
    assert.equal(out.adapter.version, '2.0.0')
    assert.ok(adapter.state.hello >= 1)
    assert.equal(svc.listTasks()[0].status, 'ready')
    cleanup(ctx, dataRoot)
  } finally { await adapter.close() }
})

test('orchestrator: getTaskStatus merges the fork-side adapter status', skipNoRemote, async () => {
  const adapter = await makeAdapterServer()
  try {
    const { ctx, svc, dataRoot } = await boot({ forker: makeFakeForker({ url: adapter.url, port: adapter.port }) })
    const created = await svc.createTask({ title: '状态任务' })
    const status = await svc.getTaskStatus(created.taskId)
    assert.equal(status.ok, true)
    assert.equal(status.adapter.ok, true)
    assert.equal(status.adapterStatus.services.hotReloader, true)
    assert.equal(status.adapterStatus.audit.records, 3)
    assert.equal((await svc.getTaskStatus('missing')).error, 'unknown-task')
    cleanup(ctx, dataRoot)
  } finally { await adapter.close() }
})

test('orchestrator: archiveTask asks the fork to flush, then reaps', skipNoRemote, async () => {
  const adapter = await makeAdapterServer()
  try {
    const { ctx, svc, forker, dataRoot } = await boot({ forker: makeFakeForker({ url: adapter.url, port: adapter.port }) })
    const created = await svc.createTask({ title: '归档任务' })
    const archived = await svc.archiveTask(created.taskId)
    assert.equal(archived.ok, true)
    assert.equal(archived.archived, true)
    assert.ok(adapter.state.commands.some(c => c.op === 'archive'), 'fork received archive command')
    assert.deepEqual(forker.calls.reap, [created.taskId])
    assert.deepEqual(svc.listTasks(), [])
    cleanup(ctx, dataRoot)
  } finally { await adapter.close() }
})

test('orchestrator: promoteTask is fail-closed without an adapter', async () => {
  const { ctx, svc, dataRoot } = await boot({ forker: makeFakeForker({ url: 'http://127.0.0.1:1/?token=tok' }) })
  const created = await svc.createTask({ title: 'x' })
  const out = await svc.promoteTask(created.taskId, 'plug')
  assert.equal(out.ok, false)
  assert.equal(out.error, 'adapter-unavailable')
  cleanup(ctx, dataRoot)
})

test('orchestrator: promoteTask re-scores with MOTHER thresholds and copies to staging', skipNoRemote, async () => {
  const adapter = await makeAdapterServer()
  try {
    const scorerCalls = []
    const scorer = {
      scoreDir(dir, manifest, opts) { scorerCalls.push({ dir, opts }); return { grade: 'B', S: 30, color: 'blue' } },
    }
    const approver = {
      requests: [],
      async requestPromotion(req) { this.requests.push(req); return { id: 'a1', outcome: 'approved' } },
      snapshot() { return { tag: 'plug', A: { digest: 'x' }, B: null } },
    }
    const routerCalls = []
    const router = { decide(input) { routerCalls.push(input); return { route: 'sandbox', reason: 'trusted', needsApproval: false } } }
    const { ctx, svc, dataRoot } = await boot({
      forker: makeFakeForker({ url: adapter.url, port: adapter.port }),
      extraServices: { [SERVICE.scorer]: scorer, [SERVICE.approver]: approver, [SERVICE.router]: router },
    })
    const created = await svc.createTask({ title: '提升任务' })
    const out = await svc.promoteTask(created.taskId, 'plug')
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.equal(out.outcome, 'approved')
    assert.ok(adapter.state.commands.some(c => c.op === 'read-plugin'), 'fetched source over the wire')
    assert.ok(adapter.state.commands.some(c => c.op === 'score-plugin'), 'asked the fork for its score')
    assert.equal(scorerCalls.length, 1)
    assert.equal(scorerCalls[0].opts.environment, 'mother', 'mother must re-score with mother thresholds')
    assert.equal(approver.requests.length, 1)
    assert.equal(approver.requests[0].pluginId, 'plug')
    assert.equal(routerCalls[0].source, 'mother')
    const target = path.join(dataRoot, 'promoted', 'plug', 'index.js')
    assert.equal(fs.existsSync(target), true, 'plugin copied into mother staging')
    cleanup(ctx, dataRoot)
  } finally { await adapter.close() }
})

test('orchestrator: promoteTask refuses low grade and non-sandbox routes', skipNoRemote, async () => {
  const adapter = await makeAdapterServer()
  try {
    const lowScorer = { scoreDir() { return { grade: 'D', S: 70, color: 'red' } } }
    const approver = { async requestPromotion() { return { outcome: 'approved' } } }
    const first = await boot({
      forker: makeFakeForker({ url: adapter.url, port: adapter.port }),
      extraServices: { [SERVICE.scorer]: lowScorer, [SERVICE.approver]: approver },
    })
    const created = await first.svc.createTask({ title: 'x' })
    const low = await first.svc.promoteTask(created.taskId, 'plug')
    assert.equal(low.ok, false)
    assert.equal(low.error, 'grade-too-low')
    cleanup(first.ctx, first.dataRoot)

    const containerRouter = { decide() { return { route: 'container', reason: 'bare-writes' } } }
    const okScorer = { scoreDir() { return { grade: 'B', S: 30 } } }
    const second = await boot({
      forker: makeFakeForker({ url: adapter.url, port: adapter.port }),
      extraServices: { [SERVICE.scorer]: okScorer, [SERVICE.approver]: approver, [SERVICE.router]: containerRouter },
    })
    const created2 = await second.svc.createTask({ title: 'y' })
    const refused = await second.svc.promoteTask(created2.taskId, 'plug')
    assert.equal(refused.ok, false)
    assert.equal(refused.error, 'route-refused')
    cleanup(second.ctx, second.dataRoot)
  } finally { await adapter.close() }
})

test('orchestrator: HTTP routes cover tasks v2 + forks v1 and the panel renders v2', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-http2-'))
  const ctx = makeCtx({ services: { [SERVICE.forker]: makeFakeForker(), webServer } })
  orchestrator.apply(ctx, {
    dataRoot, forksRoot: path.join(dataRoot, 'forks'),
    adapterTimeoutMs: 100, routes: { enabled: true, prefix: '/fang' },
  })
  const paths = webServer.paths()
  for (const p of [
    '/fang/panel', '/fang/api/status', '/fang/api/tasks', '/fang/api/tasks/create',
    '/fang/api/tasks/status', '/fang/api/tasks/archive', '/fang/api/tasks/promote',
    '/fang/api/forks', '/fang/api/forks/create', '/fang/api/reap', '/fang/api/promote',
  ]) {
    assert.ok(paths.includes(p), `route ${p} must be registered`)
  }

  const panel = makeRes()
  await webServer.find('GET', '/fang/panel').handler(makeReq(undefined, 'GET'), panel)
  assert.equal(panel.statusCode, 200)
  assert.match(panel.body, /dsh-Fang v2/)
  assert.match(panel.body, /派生新任务/)

  const status = makeRes()
  await webServer.find('GET', '/fang/api/status').handler(makeReq(undefined, 'GET'), status)
  assert.equal(status.statusCode, 200)
  assert.equal(status.json().version, '2.3.1')

  const wrongMethod = makeRes()
  await webServer.find('GET', '/fang/api/status').handler(makeReq(undefined, 'POST'), wrongMethod)
  assert.equal(wrongMethod.statusCode, 405)
  ctx.dispose()
  fs.rmSync(dataRoot, { recursive: true, force: true })
})

test('orchestrator: resolveInside rejects traversal and absolute plugin paths', () => {
  const base = 'C:\\tmp\\work'
  assert.equal(orchestrator.resolveInside(base, 'index.js') !== null, true)
  assert.equal(orchestrator.resolveInside(base, 'lib/a.js') !== null, true)
  assert.equal(orchestrator.resolveInside(base, '../escape.js'), null)
  assert.equal(orchestrator.resolveInside(base, 'C:\\evil.js'), null)
  assert.equal(orchestrator.resolveInside(base, '//server/share/x.js'), null)
  assert.equal(orchestrator.resolveInside(base, ''), null)
})

test('orchestrator: derive() asks the session catalog for a bounded seed and writes it into the fork home', skipNoRemote, async () => {
  const adapter = await makeAdapterServer()
  try {
    const digestCalls = []
    const catalog = {
      async digest(sessionId) {
        digestCalls.push(sessionId)
        return { ok: true, markdown: '# lineage\n\n- session: ' + sessionId, sha256: 'x' }
      },
    }
    const { ctx, svc, forker, dataRoot } = await boot({
      forker: makeFakeForker({ url: adapter.url, port: adapter.port }),
      extraServices: { [SERVICE.sessionCatalog]: catalog },
    })
    const out = await svc.derive({ sessionId: 'session-01234567-89ab-cdef-0123-456789abcdef', title: '从会话继续' })
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.equal(digestCalls.length, 1, 'catalog.digest called exactly once')
    assert.equal(out.derivedFrom.sessionId, 'session-01234567-89ab-cdef-0123-456789abcdef')
    const list = svc.listTasks()
    assert.equal(list.length, 1)
    assert.ok(list[0].seed, 'task view exposes the seed')
    assert.equal(list[0].seed.sessionId, 'session-01234567-89ab-cdef-0123-456789abcdef')
    const seedDir = path.join(list[0].homeDir, 'fang-seeds')
    const seedFiles = fs.existsSync(seedDir) ? fs.readdirSync(seedDir) : []
    assert.equal(seedFiles.length, 1, 'exactly one seed file written')
    const seedText = fs.readFileSync(path.join(seedDir, seedFiles[0]), 'utf8')
    assert.match(seedText, /# lineage/)
    // mother data untouched beyond its own dataDir: no sessions dir is created
    assert.equal(fs.existsSync(path.join(dataRoot, 'sessions')), false)
    cleanup(ctx, dataRoot)
  } finally { await adapter.close() }
})

test('orchestrator: derive() is fail-closed without a session catalog, and lineage-only needs no seed', skipNoRemote, async () => {
  const adapter = await makeAdapterServer()
  try {
    const { ctx, svc, dataRoot } = await boot({ forker: makeFakeForker({ url: adapter.url, port: adapter.port }) })
    const denied = await svc.derive({ sessionId: 'session-01234567-89ab-cdef-0123-456789abcdef' })
    assert.equal(denied.ok, false)
    assert.equal(denied.error, 'session-catalog-unavailable')
    const plain = await svc.derive({ title: '纯 lineage' })
    assert.equal(plain.ok, true)
    assert.equal(plain.derivedFrom, null)
    assert.equal(svc.listTasks()[0].seed, null)
    cleanup(ctx, dataRoot)
  } finally { await adapter.close() }
})

test('orchestrator: normalizeSeed bounds seed size and falls back to lineage markdown', () => {
  assert.equal(orchestrator.normalizeSeed(null), null)
  assert.equal(orchestrator.normalizeSeed({}), null)
  const lineage = orchestrator.normalizeSeed({ sessionId: 'session-x' })
  assert.match(lineage.markdown, /lineage-only/)
  const seeded = orchestrator.normalizeSeed({ sessionId: 's', markdown: '# hi' })
  assert.equal(seeded.markdown, '# hi')
  assert.throws(() => orchestrator.normalizeSeed({ markdown: 'x'.repeat(70 * 1024) }), /seed-too-large/)
})

test('orchestrator: template resolver prefers a profile that actually resolves the bundle', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-tpl-'))
  const good = path.join(dir, 'good-profile')
  const bad = path.join(dir, 'bad-profile')
  fs.mkdirSync(path.join(good, 'node_modules', '@local', 'dsh-fang'), { recursive: true })
  fs.mkdirSync(bad, { recursive: true })
  const prev = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = good
  try {
    const { ctx, svc, forker, dataRoot } = await boot({ config: { profileTemplate: bad } })
    const out = await svc.createTask({ title: 'tpl' })
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.equal(forker.calls.provision[0].profileTemplate, good, 'must skip the template without the bundle')
    cleanup(ctx, dataRoot)
  } finally {
    if (prev === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = prev
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('orchestrator: a fork that cannot resolve the bundle is reaped instead of becoming a zombie', async () => {
  const forker = makeFakeForker()
  const realProvision = forker.provision.bind(forker)
  forker.provision = async (args) => {
    const out = await realProvision(args)
    fs.rmSync(path.join(args.homeDir, 'profiles', args.profile, 'node_modules'), { recursive: true, force: true })
    return out
  }
  const { ctx, svc, forker: f, dataRoot } = await boot({ forker })
  const out = await svc.createTask({ title: 'zombie' })
  assert.equal(out.ok, false)
  assert.equal(out.error, 'fork-bundle-unavailable')
  assert.equal(f.calls.reap.length, 1, 'the broken fork must be reaped')
  assert.deepEqual(svc.listTasks(), [], 'the failed task must not stay registered')
  cleanup(ctx, dataRoot)
})

test('orchestrator: listForkSessions reads the fork-owned session log and extracts its title', async () => {
  const { ctx, svc, dataRoot } = await boot()
  await svc.createTask({ title: 'fork sessions' })
  const task = svc.listTasks()[0]
  const wsPath = 'E:\\fork-ws'
  const sid = 'session-22222222-3333-4444-8555-666666666666'
  const logDir = path.join(task.homeDir, 'sessions', encodeWorkspaceKey(wsPath), sid)
  fs.mkdirSync(logDir, { recursive: true })
  const frames = [
    JSON.stringify({ type: 'session', version: 4, id: sid, createdAt: 1793500000000, cwd: wsPath }) + '\n',
    JSON.stringify({ type: 'session/title', seq: 2, data: { title: '分身内会话标题', messageSeqs: [1] } }) + '\n',
    JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: '分身内首条消息' }] } }) + '\n',
  ]
  fs.writeFileSync(path.join(logDir, 'session.v4.jsonl.zstd'), Buffer.concat(frames.map((x) => zlib.zstdCompressSync(Buffer.from(x, 'utf8')))))
  fs.mkdirSync(path.join(task.homeDir, 'storages'), { recursive: true })
  fs.writeFileSync(path.join(task.homeDir, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { w1: { path: wsPath, title: 'ForkWS', sessionIds: [sid], createdAt: '2026-10-16T05:35:00.313Z', updatedAt: '2026-11-01T02:44:03.199Z' } } },
  }))
  const out = await svc.listForkSessions(task.taskId)
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.sessions.length, 1)
  assert.equal(out.sessions[0].title, '分身内会话标题')
  assert.equal(out.sessions[0].titleSource, 'session/title')
  assert.match(out.sessions[0].preview, /分身内首条消息/)
  assert.equal(out.sessions[0].workspaceTitle, 'ForkWS')
  assert.equal((await svc.listForkSessions('task_nope')).error, 'unknown-task')
  cleanup(ctx, dataRoot)
})
