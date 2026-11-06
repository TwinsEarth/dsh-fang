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

import { makeCtx, makeWebServerStub, makeReq, makeRes, TEST_AUTH_TOKEN } from './helpers.mjs'
import { SERVICE, FANG_VERSION } from '../src/kernel/index.mjs'
import * as orchestrator from '../src/plugins/orchestrator.mjs'
import { encodeWorkspaceKey } from '../src/lib/session-format.mjs'

const hasRemote = await import('../src/lib/remote.mjs').then(() => true).catch(() => false)
const skipNoRemote = hasRemote ? {} : { skip: 'src/lib/remote.mjs not delivered yet (T5)' }

function makeFakeForker(overrides = {}) {
  const calls = { provision: [], spawn: [], stop: [], reap: [] }
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
    async stop(forkId) {
      calls.stop.push(forkId)
      live.delete(forkId)
      return { ok: true, forkId, killed: true }
    },
    alive(forkId) { return live.has(forkId) },
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
    authToken: TEST_AUTH_TOKEN,
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
  assert.equal(svc.version, FANG_VERSION)
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
  assert.equal(out.url.includes('token='), false, 'v3.0.5/B4：createTask 返回/持久化 URL 不含 token')
  const list = svc.listTasks()
  assert.equal(list.length, 1)
  assert.equal(list[0].title, '开发 dsh-foo')
  assert.equal(list[0].status, 'running', 'reachable-but-adapter-down → running, not ready')
  // v3.0.7/S1：动作可用性与 blocks 由服务端给出
  assert.equal(typeof list[0].actions?.open?.enabled, 'boolean')
  assert.equal(typeof list[0].actions?.rename?.enabled, 'boolean')
  assert.equal(typeof list[0].actions?.delete?.enabled, 'boolean')
  assert.ok(Array.isArray(list[0].blocks))
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

test('orchestrator: archiveTask stops the fork and keeps the home (no reap)', skipNoRemote, async () => {
  const adapter = await makeAdapterServer()
  try {
    const { ctx, svc, forker, dataRoot } = await boot({ forker: makeFakeForker({ url: adapter.url, port: adapter.port }) })
    const created = await svc.createTask({ title: '归档任务' })
    const archived = await svc.archiveTask(created.taskId)
    assert.equal(archived.ok, true)
    assert.equal(archived.archived, true)
    assert.equal(archived.stopped, true)
    assert.equal(archived.homeKept, true)
    assert.ok(adapter.state.commands.some(c => c.op === 'archive'), 'fork received archive command')
    assert.deepEqual(forker.calls.stop, [created.taskId])
    assert.deepEqual(forker.calls.reap, [], 'archive must keep the home for read/restore')
    const tasks = svc.listTasks()
    assert.equal(tasks.length, 1, 'archived task stays in the archive list')
    assert.equal(tasks[0].status, 'archived')
    assert.ok(tasks[0].archivedAt > 0)
    assert.equal(tasks[0].url, null)
    cleanup(ctx, dataRoot)
  } finally { await adapter.close() }
})

test('orchestrator: archiveTask reports stop-failed instead of pretending success', skipNoRemote, async () => {
  const adapter = await makeAdapterServer()
  try {
    const forker = makeFakeForker({ url: adapter.url, port: adapter.port })
    forker.stop = async () => ({ ok: true, killed: true })
    forker.alive = () => true
    const { ctx, svc, dataRoot } = await boot({ forker, config: { archiveStopTimeoutMs: 120 } })
    const created = await svc.createTask({ title: '停不掉的任务' })
    const archived = await svc.archiveTask(created.taskId)
    assert.equal(archived.ok, false)
    assert.equal(archived.error, 'stop-failed')
    const task = svc.listTasks().find(t => t.taskId === created.taskId)
    assert.ok(task, 'task must not disappear when stop fails')
    assert.notEqual(task.status, 'archived')
    cleanup(ctx, dataRoot)
  } finally { await adapter.close() }
})

test('orchestrator: restoreTask re-spawns the archived home and updates url/token', skipNoRemote, async () => {
  const adapter = await makeAdapterServer()
  try {
    const { ctx, svc, forker, dataRoot } = await boot({ forker: makeFakeForker({ url: adapter.url, port: adapter.port }) })
    const created = await svc.createTask({ title: '可还原任务' })
    await svc.archiveTask(created.taskId)
    const restored = await svc.restoreTask(created.taskId)
    assert.equal(restored.ok, true)
    assert.equal(restored.restored, true)
    assert.equal(forker.calls.spawn.length, 2, 'restore must spawn again')
    assert.equal(forker.calls.spawn[1].homeDir, created.homeDir)
    assert.equal(forker.calls.spawn[1].profile, forker.calls.spawn[0].profile)
    const task = svc.listTasks().find(t => t.taskId === created.taskId)
    assert.ok(task)
    assert.notEqual(task.status, 'archived')
    assert.equal(task.archivedAt, null)
    assert.equal(task.url.includes('token='), false, 'v3.0.5/B4：列表 URL 不含 token')
    cleanup(ctx, dataRoot)
  } finally { await adapter.close() }
})

test('orchestrator: deleteArchivedTask reaps the home and removes the record', skipNoRemote, async () => {
  const adapter = await makeAdapterServer()
  try {
    const { ctx, svc, forker, dataRoot } = await boot({ forker: makeFakeForker({ url: adapter.url, port: adapter.port }) })
    const created = await svc.createTask({ title: '待删除存档' })
    await svc.archiveTask(created.taskId)
    const deleted = await svc.deleteArchivedTask(created.taskId)
    assert.equal(deleted.ok, true)
    assert.deepEqual(forker.calls.reap, [created.taskId])
    assert.equal(svc.listTasks().some(t => t.taskId === created.taskId), false)
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

test('orchestrator: POST /fang/api/essence/capture 从母体 profile 生成元主', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-capture-'))
  const motherProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-mother-'))
  const previousProfileDir = process.env.DSH_PROFILE_DIR
  delete process.env.DSH_PROFILE_DIR
  // 母体模板必须“真的装了本 bundle”才会被 templateDir() 选中，否则测试会落到机器上的真实 profile。
  fs.mkdirSync(path.join(motherProfile, 'node_modules', '@local', 'dsh-fang'), { recursive: true })
  fs.writeFileSync(path.join(motherProfile, 'package.json'), JSON.stringify({
    name: 'desktop',
    private: true,
    dsh: { profile: { bundles: ['@dsh/base', '@dsh/web-app'] } },
    dependencies: { '@dsh/base': '^1.0.0' },
  }), 'utf8')
  fs.writeFileSync(path.join(motherProfile, 'cordis.patch.yml'),
    '- insert:\n    - id: my-plugin\n      name: "@x/my-plugin"\n', 'utf8')
  const ctx = makeCtx({ services: { [SERVICE.forker]: makeFakeForker(), webServer } })
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      profileTemplate: motherProfile,
      adapterTimeoutMs: 100,
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const handler = webServer.find('POST', '/fang/api/essence/capture').handler
    const res = makeRes()
    await handler(makeReq({ name: '克隆元主' }, 'POST'), res)
    const body = res.json()
    assert.equal(res.statusCode, 200)
    assert.equal(body.ok, true)
    assert.equal(body.meta.name, '克隆元主')
    assert.equal(body.captured.patchEntries, 1)
    assert.equal(body.captured.bundles, 2)
    assert.equal(body.captured.credentialsCopied, false)
    assert.equal(body.status, 'ready')
    // 未给名字时用 profile 名称兜底，而不是失败
    const unnamed = makeRes()
    await handler(makeReq({}, 'POST'), unnamed)
    assert.equal(unnamed.statusCode, 200)
    assert.match(String(unnamed.json()?.meta?.name), /元主$/)
  } finally {
    cleanup(ctx, dataRoot)
    fs.rmSync(motherProfile, { recursive: true, force: true })
    if (previousProfileDir === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previousProfileDir
  }
})

test('orchestrator: GET /fang/api/connection 返回带进程 token 的地址', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-conn-'))
  const ctx = makeCtx({
    services: {
      [SERVICE.forker]: makeFakeForker(),
      webServer,
      webApp: { getAdvertisedUrl: () => 'http://127.0.0.1:9999' },
      connection: { authenticatedUrl: (base) => `${base}/?token=host-process-token` },
    },
  })
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const handler = webServer.find('GET', '/fang/api/connection').handler
    const res = makeRes()
    await handler(makeReq(undefined, 'GET'), res)
    const body = res.json()
    assert.equal(res.statusCode, 200)
    assert.equal(body.ok, true)
    assert.equal(body.advertisedUrl, 'http://127.0.0.1:9999')
    assert.equal(body.url, 'http://127.0.0.1:9999/?token=host-process-token')
    assert.equal(body.tokenized, true)
  } finally {
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: clone-profile → essence stale → sync 全链路', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-upgrade-'))
  const motherProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-mother-up-'))
  const previousProfileDir = process.env.DSH_PROFILE_DIR
  delete process.env.DSH_PROFILE_DIR
  fs.mkdirSync(path.join(motherProfile, 'node_modules', '@local', 'dsh-fang'), { recursive: true })
  fs.writeFileSync(path.join(motherProfile, 'package.json'), JSON.stringify({
    name: 'desktop', version: '9.9.9', dependencies: {},
  }), 'utf8')
  fs.writeFileSync(path.join(motherProfile, 'cordis.patch.yml'), '- id: ui-theme\n  config: {}\n', 'utf8')
  const ctx = makeCtx({ services: { [SERVICE.forker]: makeFakeForker(), webServer } })
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      profileTemplate: motherProfile,
      adapterTimeoutMs: 100,
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const clone = makeRes()
    await webServer.find('POST', '/fang/api/mirror/clone-profile').handler(makeReq({}, 'POST'), clone)
    assert.equal(clone.statusCode, 200)
    assert.equal(clone.json().ok, true)
    assert.equal(clone.json().version, '9.9.9')
    assert.ok(clone.json().files.includes('package.json'))
    const mirrorProfile = path.join(dataRoot, 'mirror', 'active', 'profile')
    assert.equal(fs.existsSync(path.join(mirrorProfile, 'cordis.patch.yml')), true)

    const list = makeRes()
    await webServer.find('GET', '/fang/api/essence/list').handler(makeReq(undefined, 'GET'), list)
    const before = list.json()
    assert.ok(String(before.mirrorFingerprint).length > 0)
    const official = before.essences.find((item) => item.id === 'essence-official-dev')
    assert.equal(official.stale, true, '镜像变化后官方元主必须标记为待同步')

    const sync = makeRes()
    await webServer.find('POST', '/fang/api/essence/sync').handler(makeReq({}, 'POST'), sync)
    assert.equal(sync.statusCode, 200)
    assert.equal(sync.json().ok, true)
    assert.equal(sync.json().mode, 'all')

    const list2 = makeRes()
    await webServer.find('GET', '/fang/api/essence/list').handler(makeReq(undefined, 'GET'), list2)
    assert.equal(list2.json().staleCount, 0, '同步后不应再有 stale 元主')
  } finally {
    cleanup(ctx, dataRoot)
    fs.rmSync(motherProfile, { recursive: true, force: true })
    if (previousProfileDir === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previousProfileDir
  }
})

test('orchestrator: 元主 backup / restore / import 三条路由', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-bri-'))
  const ctx = makeCtx({ services: { [SERVICE.forker]: makeFakeForker(), webServer } })
  const call = async (method, routePath, body) => {
    const res = makeRes()
    const handler = webServer.find(method, routePath).handler
    await handler(makeReq(body, method), res)
    return res
  }
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const mirror = ctx.get(SERVICE.mirror)
    const created = mirror.createEssence({ name: '路由测试元主' })
    const essenceId = created.id

    // 1) backup：生成 essences/<id>/Backup，重复调用仍只有一份
    const first = await call('POST', '/fang/api/essence/backup', { essenceId })
    assert.equal(first.statusCode, 200)
    assert.equal(first.json().ok, true)
    const backupDir = path.join(dataRoot, 'essences', essenceId, 'Backup')
    assert.equal(fs.existsSync(backupDir), true)
    await call('POST', '/fang/api/essence/backup', { essenceId })
    const backups = fs.readdirSync(path.join(dataRoot, 'essences', essenceId)).filter((name) => name === 'Backup')
    assert.equal(backups.length, 1, '只保留一份备份')

    // 2) restore：有备份 → 200 restored
    const restored = await call('POST', '/fang/api/essence/restore', { essenceId })
    assert.equal(restored.statusCode, 200)
    assert.equal(restored.json().ok, true)
    assert.equal(restored.json().restored, true)

    // 2b) restore：没有备份的元主 → 400 backup-failed detail backup-missing
    const noBackup = mirror.createEssence({ name: '无备份元主' })
    const missing = await call('POST', '/fang/api/essence/restore', { essenceId: noBackup.id })
    assert.equal(missing.statusCode, 400)
    assert.equal(missing.json().error, 'restore-failed')
    assert.match(String(missing.json().detail), /backup-missing/)

    // 3) import：整包 → 新元主
    const bundle = mirror.downloadEssence(essenceId, { full: true })
    assert.equal(bundle.full, true)
    const imported = await call('POST', '/fang/api/essence/import', { bundle })
    assert.equal(imported.statusCode, 200)
    const importedBody = imported.json()
    assert.equal(importedBody.ok, true)
    assert.notEqual(importedBody.essence.id, essenceId)
    assert.ok(importedBody.files > 0)

    // 3b) import：空包 → 400 import-failed
    const empty = await call('POST', '/fang/api/essence/import', { bundle: { files: [] } })
    assert.equal(empty.statusCode, 400)
    assert.equal(empty.json().error, 'import-failed')
  } finally {
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: 元主运行态路由对未知元主返回 400（不假装启动）', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-rt-'))
  const ctx = makeCtx({ services: { [SERVICE.forker]: makeFakeForker(), webServer } })
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const handler = webServer.find('POST', '/fang/api/essence/runtime').handler
    const res = makeRes()
    await handler(makeReq({ action: 'start', essenceId: 'essence-does-not-exist' }, 'POST'), res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error, 'runtime-failed')
    assert.match(String(res.json().detail), /unknown-essence/)
  } finally {
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: HTTP routes cover tasks v2 + forks v1 and the panel renders v2', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-http2-'))
  const ctx = makeCtx({ services: { [SERVICE.forker]: makeFakeForker(), webServer } })
  orchestrator.apply(ctx, {
    dataRoot, forksRoot: path.join(dataRoot, 'forks'),
    adapterTimeoutMs: 100, routes: { enabled: true, prefix: '/fang' },
    authToken: TEST_AUTH_TOKEN,
  })
  const paths = webServer.paths()
  for (const p of [
    '/fang/api/status', '/fang/api/tasks', '/fang/api/tasks/create',
    '/fang/api/tasks/status', '/fang/api/tasks/archive', '/fang/api/tasks/restore',
    '/fang/api/tasks/archive/delete', '/fang/api/tasks/promote',
    '/fang/api/forks', '/fang/api/forks/create', '/fang/api/reap', '/fang/api/promote',
    '/fang/api/mother-link', '/fang/api/mother-link/probe',
    '/fang/api/mirror/status', '/fang/api/mirror/backup', '/fang/api/mirror/restore',
    '/fang/api/mirror/backup/delete', '/fang/api/mirror/backup-interval', '/fang/api/mirror/upgrade',
    '/fang/api/mirror/preferences', '/fang/api/mirror/preferences/set',
    '/fang/api/mirror/recompute-status', '/fang/api/compat', '/fang/api/compat/check',
    '/fang/api/essence/list', '/fang/api/auth-token', '/fang/api/tasks/open-url',
    '/fang/api/essence/create', '/fang/api/essence/rename', '/fang/api/essence/archive',
    '/fang/api/essence/delete', '/fang/api/essence/copy', '/fang/api/essence/default',
    '/fang/api/essence/capture', '/fang/api/essence/sync', '/fang/api/essence/runtime', '/fang/api/essence/download', '/fang/api/tasks/rename', '/fang/api/tasks/copy',
    '/fang/api/tasks/download',
  ]) {
    assert.ok(paths.includes(p), `route ${p} must be registered`)
  }

  const linkDescribe = makeRes()
  await webServer.find('GET', '/fang/api/mother-link').handler(makeReq(undefined, 'GET'), linkDescribe)
  assert.equal(linkDescribe.statusCode, 200)
  const described = linkDescribe.json()
  assert.equal(described.role, 'mother')
  assert.equal(described.motherApiBase, '/fang/api')
  assert.match(described.probe.path, /mother-link\/probe$/)
  assert.ok(described.sharedConfig && typeof described.sharedConfig === 'object')

  const linkProbe = makeRes()
  await webServer.find('POST', '/fang/api/mother-link/probe').handler(makeReq({ target: '' }, 'POST'), linkProbe)
  assert.equal(linkProbe.statusCode, 200)
  assert.equal(linkProbe.json().ok, false)
  assert.equal(linkProbe.json().error, 'target-empty')

  // v2.11.0 母体镜像路由
  const mirrorStatus = makeRes()
  await webServer.find('GET', '/fang/api/mirror/status').handler(makeReq(undefined, 'GET'), mirrorStatus)
  assert.equal(mirrorStatus.statusCode, 200)
  const mirrorBody = mirrorStatus.json()
  assert.equal(mirrorBody.ok, true)
  assert.equal(typeof mirrorBody.currentVersion, 'string')
  assert.ok(Array.isArray(mirrorBody.backups))
  // v3.0.1 条件 GET：ETag → 304 无 body
  assert.match(String(mirrorStatus.headers.ETag ?? ''), /^"[0-9a-f]{24}"$/)
  assert.equal(mirrorStatus.headers['Cache-Control'], 'no-cache, must-revalidate')

  const condReq = makeReq(undefined, 'GET')
  condReq.headers = { ...condReq.headers, 'if-none-match': mirrorStatus.headers.ETag }
  const notModified = makeRes()
  await webServer.find('GET', '/fang/api/mirror/status').handler(condReq, notModified)
  assert.equal(notModified.statusCode, 304)
  assert.equal(notModified.body, '')
  assert.equal(notModified.headers.ETag, mirrorStatus.headers.ETag)

  const forced = makeRes()
  await webServer.find('GET', '/fang/api/mirror/status')
    .handler(makeReq(undefined, 'GET'), forced)
  assert.equal(forced.statusCode, 200)

  const mirrorBackup = makeRes()
  await webServer.find('POST', '/fang/api/mirror/backup')
    .handler(makeReq({ bucket: 'restore', label: '测试恢复点' }, 'POST'), mirrorBackup)
  assert.equal(mirrorBackup.statusCode, 200)
  assert.equal(mirrorBackup.json().ok, true)
  assert.equal(mirrorBackup.json().entry.bucket, 'restore')

  const mirrorInterval = makeRes()
  await webServer.find('POST', '/fang/api/mirror/backup-interval')
    .handler(makeReq({ hours: 8 }, 'POST'), mirrorInterval)
  assert.equal(mirrorInterval.statusCode, 400)
  assert.equal(mirrorInterval.json().ok, false)

  const mirrorUpgrade = makeRes()
  await webServer.find('POST', '/fang/api/mirror/upgrade').handler(makeReq({}, 'POST'), mirrorUpgrade)
  assert.equal(mirrorUpgrade.statusCode, 409)
  assert.equal(mirrorUpgrade.json().ok, false)
  assert.equal(mirrorUpgrade.json().reason, 'official-source-unavailable')

  // v3.0.8 镜像偏好（交互超时 15/30/60s）
  const preferencesGet = makeRes()
  await webServer.find('GET', '/fang/api/mirror/preferences')
    .handler(makeReq(undefined, 'GET'), preferencesGet)
  assert.equal(preferencesGet.statusCode, 200)
  assert.equal(preferencesGet.json().activeIdleTimeoutMs, 30_000)

  const preferencesInvalid = makeRes()
  await webServer.find('POST', '/fang/api/mirror/preferences/set')
    .handler(makeReq({ activeIdleTimeoutMs: 1_000 }, 'POST'), preferencesInvalid)
  assert.equal(preferencesInvalid.statusCode, 400)

  const preferencesOk = makeRes()
  await webServer.find('POST', '/fang/api/mirror/preferences/set')
    .handler(makeReq({ activeIdleTimeoutMs: 15_000 }, 'POST'), preferencesOk)
  assert.equal(preferencesOk.statusCode, 200)
  assert.equal(preferencesOk.json().activeIdleTimeoutMs, 15_000)

  // v3.0.3 重算状态 + compat 门禁
  const recomputeStatus = makeRes()
  await webServer.find('GET', '/fang/api/mirror/recompute-status')
    .handler(makeReq(undefined, 'GET'), recomputeStatus)
  assert.equal(recomputeStatus.statusCode, 200)
  assert.equal(typeof recomputeStatus.json().running, 'boolean')

  const compatStatus = makeRes()
  await webServer.find('GET', '/fang/api/compat').handler(makeReq(undefined, 'GET'), compatStatus)
  assert.equal(compatStatus.statusCode, 200)
  assert.equal(typeof compatStatus.json().subPluginsEnabled, 'boolean')

  const compatCheck = makeRes()
  await webServer.find('POST', '/fang/api/compat/check').handler(makeReq({}, 'POST'), compatCheck)
  assert.ok(compatCheck.statusCode === 200 || compatCheck.statusCode === 409)
  assert.equal(typeof compatCheck.json().ok, 'boolean')

  // v3.0.4 原身列表 + 官方推荐原身 ID
  const essenceList = makeRes()
  await webServer.find('GET', '/fang/api/essence/list').handler(makeReq(undefined, 'GET'), essenceList)
  assert.equal(essenceList.statusCode, 200)
  const essenceBody = essenceList.json()
  assert.equal(essenceBody.officialId, 'essence-official-dev')
  assert.ok(Array.isArray(essenceBody.essences))
  assert.equal(essenceBody.capacity.slots, 7)
  assert.equal(typeof essenceBody.defaultId, 'string')

  // v3.0.6：create → rename → list 契约
  const createdEssence = makeRes()
  await webServer.find('POST', '/fang/api/essence/create')
    .handler(makeReq({ name: '契约元主', tier: 'vip100' }, 'POST'), createdEssence)
  assert.equal(createdEssence.statusCode, 200)
  const createdId = createdEssence.json().essence.id
  assert.ok(createdId)

  const renamedEssence = makeRes()
  await webServer.find('POST', '/fang/api/essence/rename')
    .handler(makeReq({ essenceId: createdId, name: '契约元主改名' }, 'POST'), renamedEssence)
  assert.equal(renamedEssence.statusCode, 200)
  assert.equal(renamedEssence.json().essence.name, '契约元主改名')

  const essenceList2 = makeRes()
  await webServer.find('GET', '/fang/api/essence/list').handler(makeReq(undefined, 'GET'), essenceList2)
  const listed = essenceList2.json().essences.find(item => item.id === createdId)
  assert.ok(listed)
  assert.equal(typeof listed.pluginCount, 'number')
  assert.equal(listed.locked, false)

  const status = makeRes()
  await webServer.find('GET', '/fang/api/status').handler(makeReq(undefined, 'GET'), status)
  assert.equal(status.statusCode, 200)
  assert.equal(status.json().version, FANG_VERSION)

  const wrongMethod = makeRes()
  await webServer.find('GET', '/fang/api/status').handler(makeReq(undefined, 'POST'), wrongMethod)
  assert.equal(wrongMethod.statusCode, 405)
  ctx.dispose()
  fs.rmSync(dataRoot, { recursive: true, force: true })
})

test('orchestrator: branch/task-id 404 contract, traversal guard, and /fang/api catch-all', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-branch-http-'))
  const ctx = makeCtx({ services: { [SERVICE.forker]: makeFakeForker(), webServer } })
  orchestrator.apply(ctx, {
    dataRoot,
    forksRoot: path.join(dataRoot, 'forks'),
    adapterTimeoutMs: 100,
    adapterPollMs: 20,
    routes: { enabled: true, prefix: '/fang' },
    authToken: TEST_AUTH_TOKEN,
  })
  const svc = ctx.get(SERVICE.orchestrator)
  try {
    const created = await svc.createTask({ title: 'branch-contract' })
    assert.equal(created.ok, true, JSON.stringify(created))
    const taskId = created.taskId
    const call = async (method, path, body, token = TEST_AUTH_TOKEN) => {
      const req = body === undefined ? makeReq(undefined, method) : makeReq(body, method)
      req.url = path
      if (token === null) delete req.headers['x-fang-auth']
      else req.headers['x-fang-auth'] = token
      const res = makeRes()
      const route = method === 'GET'
        ? webServer.find('GET', path.split('?')[0])
        : webServer.find('POST', path.split('?')[0])
      assert.ok(route, `${method} ${path} must be registered`)
      await route.handler(req, res)
      return res
    }

    const branchRoutes = webServer.routes.filter((r) => r.path === '/fang/api/tasks/branches')
    assert.equal(branchRoutes.length, 1, 'GET+POST 同路径只能注册一条（webServer 以 path 为键）')
    assert.equal(branchRoutes[0].method, 'GET,POST')

    const unknown = await call('GET', '/fang/api/tasks/branches?taskId=missing-task')
    assert.equal(unknown.statusCode, 404)
    assert.equal(unknown.json().error, 'unknown-task')

    const traversal = await call('GET', '/fang/api/tasks/branches?taskId=' + encodeURIComponent('../../escape'))
    assert.equal(traversal.statusCode, 404)
    assert.equal(traversal.json().error, 'unknown-task')

    const listed = await call('GET', `/fang/api/tasks/branches?taskId=${taskId}`)
    assert.equal(listed.statusCode, 200)
    assert.equal(listed.json().activeBranchId, 'main')

    const createdBranch = await call('POST', '/fang/api/tasks/branches', { taskId, branchId: 'b1' })
    assert.equal(createdBranch.statusCode, 200)
    assert.equal(createdBranch.json().branch.branchId, 'b1')

    const duplicate = await call('POST', '/fang/api/tasks/branches', { taskId, branchId: 'b1' })
    assert.equal(duplicate.statusCode, 409)
    assert.equal(duplicate.json().error, 'branch-exists')

    const invalid = await call('POST', '/fang/api/tasks/branches', { taskId, branchId: '../escape' })
    assert.equal(invalid.statusCode, 400)
    assert.equal(invalid.json().error, 'invalid-branch-id')

    const activated = await call('POST', '/fang/api/tasks/branches/activate', { taskId, branchId: 'b1' })
    assert.equal(activated.statusCode, 200)
    assert.equal(activated.json().activeBranchId, 'b1')

    const sealed = await call('POST', '/fang/api/tasks/branches/status', { taskId, branchId: 'main', status: 'sealed' })
    assert.equal(sealed.statusCode, 200)
    assert.equal(sealed.json().branch.status, 'sealed')

    // Auth runs before method: a token-less POST must be 401, not 405.
    const noTokenPost = await call('POST', '/fang/api/tasks/branches', { taskId, branchId: 'b2' }, null)
    assert.equal(noTokenPost.statusCode, 401)
    assert.equal(noTokenPost.json().code, 'unauthorized')
    // Invoke the GET route's handler with POST and no token: auth must win (401).
    const statusGetRoute = webServer.find('GET', '/fang/api/status')
    assert.ok(statusGetRoute)
    const wrongMethodReq = makeReq({}, 'POST')
    delete wrongMethodReq.headers['x-fang-auth']
    const wrongMethod = makeRes()
    await statusGetRoute.handler(wrongMethodReq, wrongMethod)
    assert.equal(wrongMethod.statusCode, 401, 'token check precedes method check')

    // Prefix catch-all: unknown /fang/api/* is JSON 404 and still gated.
    const prefix = webServer.routes.find((r) => r.kind === 'prefix' && r.path === '/fang/api')
    assert.ok(prefix, 'prefix /fang/api must be registered')
    const unknownRes = makeRes()
    await prefix.handler(makeReq(undefined, 'GET'), unknownRes)
    assert.equal(unknownRes.statusCode, 404)
    assert.equal(unknownRes.json().code, 'not-found')
    const unknownNoToken = makeReq(undefined, 'GET')
    delete unknownNoToken.headers['x-fang-auth']
    const unknownNoTokenRes = makeRes()
    await prefix.handler(unknownNoToken, unknownNoTokenRes)
    assert.equal(unknownNoTokenRes.statusCode, 401)
  } finally {
    cleanup(ctx, dataRoot)
  }
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
    const seedCalls = []
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-seed-src-'))
    const srcFile = path.join(srcDir, 'session.v4.jsonl.zstd')
    fs.writeFileSync(srcFile, 'fake-zstd-bytes')
    const catalog = {
      async seed(sessionId) {
        seedCalls.push(sessionId)
        return {
          ok: true,
          markdown: '# lineage\n\n- session: ' + sessionId,
          sourceFile: srcFile,
          workspacePath: 'E:\\ws',
          workspaceTitle: 'WS',
          workspaceId: 'ws-1',
          createdAt: 1793500000000,
          sourceBytes: 16,
        }
      },
    }
    const { ctx, svc, forker, dataRoot } = await boot({
      forker: makeFakeForker({ url: adapter.url, port: adapter.port }),
      extraServices: { [SERVICE.sessionCatalog]: catalog },
    })
    const out = await svc.derive({ sessionId: 'session-01234567-89ab-cdef-0123-456789abcdef', title: '从会话继续' })
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.equal(seedCalls.length, 1, 'catalog.seed called exactly once')
    assert.equal(out.derivedFrom.sessionId, 'session-01234567-89ab-cdef-0123-456789abcdef')
    const list = svc.listTasks()
    assert.equal(list.length, 1)
    assert.ok(list[0].seed, 'task view exposes the seed')
    assert.equal(list[0].seed.sessionId, 'session-01234567-89ab-cdef-0123-456789abcdef')
    const seedDir = path.join(list[0].homeDir, 'fang-seeds')
    const seedFiles = fs.existsSync(seedDir) ? fs.readdirSync(seedDir) : []
    assert.equal(seedFiles.length, 1, 'exactly one seed file written')
    const imported = list[0].importedSession
    assert.equal(imported?.ok, true, JSON.stringify(imported))
    const destLog = path.join(list[0].homeDir, 'sessions', encodeWorkspaceKey('E:\\ws'), 'session-01234567-89ab-cdef-0123-456789abcdef', 'session.v4.jsonl.zstd')
    assert.equal(fs.existsSync(destLog), true, 'mother session log imported into the fork')
    const forkIndex = JSON.parse(fs.readFileSync(path.join(list[0].homeDir, 'storages', 'workspace.json'), 'utf8'))
    const entry = Object.values(forkIndex.tables.workspaces).find((w) => w.path === 'E:\\ws')
    assert.deepEqual(entry.sessionIds, ['session-01234567-89ab-cdef-0123-456789abcdef'])
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
