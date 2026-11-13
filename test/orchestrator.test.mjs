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
import { SERVICE, FANG_VERSION, bus, resolveFangLayout } from '../src/kernel/index.mjs'
import * as orchestrator from '../src/plugins/orchestrator.mjs'
import { BranchStore } from '../src/lib/branch-store.mjs'
import { EssenceManager } from '../src/lib/essence.mjs'
import { MirrorManager } from '../src/lib/mirror.mjs'
import { readForkSupervisionSettings } from '../src/lib/fork-supervision-settings.mjs'
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
      // 真实 forker 的 spawn 必须有 homeDir/profile：测试桩也照此拒绝，避免假绿。
      if (!args.homeDir || !args.profile) return { ok: false, error: 'no-home-dir' }
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
        if (op === 'approvals') {
          state.approvalsCalls = (state.approvalsCalls ?? 0) + 1
          if (opts.failApprovals) return send(500, { ok: false, op, error: 'approvals-down' })
          return send(200, { ok: true, op, result: { items: opts.approvals ?? [] } })
        }
        if (op === 'approval-decide') {
          state.approvalDecisions = state.approvalDecisions ?? []
          state.approvalDecisions.push(body.payload ?? {})
          if (opts.failApprovalDecide) return send(409, { ok: false, op, result: { ok: false, code: 'conflict', error: 'stale' } })
          return send(200, { ok: true, op, result: { ok: true, id: body.payload?.id, outcome: body.payload?.outcome } })
        }
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
  // 显式 dataRoot 时不得自动跳到 FANG_HOME 默认目录（否则测试/独立部署会写进真实 D 盘）
  assert.equal(st.layout.dataDir, dataRoot)
  assert.equal(st.layout.essenceRoot, path.join(dataRoot, 'essences'))
  assert.equal(st.layout.forkHomesDir, path.join(dataRoot, 'forks'))
  assert.equal(st.layout.runtimeRoot, path.join(dataRoot, 'runtime'))
  assert.deepEqual(st.forks.list, [], 'v1 compat view')
  assert.equal(st.commercial.backup, false)
  assert.equal(st.services.forker, true)
  assert.equal(st.services.adapter, false, 'mother has no adapter service')
  assert.equal(st.restart.available, false, 'no restart-guard service => unavailable, never faked')
  cleanup(ctx, dataRoot)
})

/** Read-only restart-guard stub used by the status/route contract tests. */
function makeRestartGuardStub(overrides = {}) {
  return {
    state: () => ({
      state: 'idle', pending: null, mode: 'enforce', authMode: 'auto',
      strictRedLine: false, redLineAutoAllowed: true, allowProcessRestart: true,
      tempEffectiveManual: false, contractVersion: 1, manifestTtlMs: 60000,
      execution: { executed: false, decisionOnly: true }, ...overrides.state,
    }),
    policy: () => ({
      mode: 'enforce', authMode: 'auto', strictRedLine: false, redLineAutoAllowed: true,
      allowProcessRestart: true, decisionOnly: true, manifestTtlMs: 60000,
      tempEffectiveManual: false, ...overrides.policy,
    }),
    executionContract: () => ({
      version: 1, decisionOnly: true, guardExecuted: false, plannedExitCode: 75,
      approval: { kind: 'fang-restart-approval', dir: 'approved' },
      receipt: { kind: 'fang-restart-execution', dir: 'executed' },
      supervisor: { armedWhen: [], mayExecuteWhen: [], receiptRequirements: [] },
      rule: '「已执行」只认回执 execution.executed === true',
      note: 'decision-only',
    }),
    approvals: () => ({
      contractVersion: 1,
      items: [{ id: 'rst_1', state: 'authorized' }],
      counts: { total: 1, authorized: 1, executed: 0, stale: 0, notArmed: 0, invalid: 0 },
    }),
  }
}

test('orchestrator: status exposes a read-only restart-guard summary for the client', async () => {
  const { ctx, svc, dataRoot } = await boot({ extraServices: { [SERVICE.restart]: makeRestartGuardStub() } })
  try {
    const st = svc.status()
    assert.equal(st.restart.available, true)
    assert.equal(st.restart.state, 'idle')
    assert.equal(st.restart.mode, 'enforce')
    assert.equal(st.restart.authMode, 'auto')
    assert.equal(st.restart.strictRedLine, false)
    assert.equal(st.restart.redLineAutoAllowed, true, 'client renders the 红灯自动放行 warning from this flag')
    assert.equal(st.restart.allowProcessRestart, true)
    assert.equal(st.restart.decisionOnly, true, 'the HTTP/UI surface never claims execution')
    assert.equal(st.restart.contractVersion, 1)
    assert.deepEqual(st.restart.approvals, {
      total: 1, authorized: 1, executed: 0, stale: 0, notArmed: 0, invalid: 0,
    })
  } finally {
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: GET /fang/api/restart is a read-only view of the supervisor contract', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-restart-http-'))
  const ctx = makeCtx({
    services: {
      [SERVICE.forker]: makeFakeForker(),
      webServer,
      [SERVICE.restart]: makeRestartGuardStub(),
    },
  })
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const route = webServer.find('GET', '/fang/api/restart')
    assert.ok(route, 'GET /fang/api/restart must be registered')
    const res = makeRes()
    await route.handler(makeReq(undefined, 'GET'), res)
    const body = res.json()
    assert.equal(res.statusCode, 200)
    assert.equal(body.ok, true)
    assert.equal(body.available, true)
    assert.equal(body.state.state, 'idle')
    assert.equal(body.policy.mode, 'enforce')
    assert.equal(body.policy.redLineAutoAllowed, true)
    assert.equal(body.contract.decisionOnly, true)
    assert.equal(body.contract.guardExecuted, false)
    assert.equal(body.approvals.counts.authorized, 1)
    assert.equal(body.executed, false, 'the route must never claim any execution')
  } finally {
    cleanup(ctx, dataRoot)
  }
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
    assert.equal(scorerCalls[0].opts.deep, true, 'mother promotion should use deep coverage')
    assert.equal(approver.requests.length, 1)
    assert.equal(approver.requests[0].pluginId, 'plug')
    assert.equal(routerCalls[0].source, 'mother')
    const target = path.join(dataRoot, 'promoted', 'plug', 'index.js')
    assert.equal(fs.existsSync(target), true, 'plugin copied into mother staging')
    cleanup(ctx, dataRoot)
  } finally { await adapter.close() }
})

test('orchestrator: atomicReplaceDir swaps in a verified tree and removes the old target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-atomic-'))
  try {
    const source = path.join(root, 'source')
    const target = path.join(root, 'target')
    fs.mkdirSync(source, { recursive: true })
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(source, 'new.txt'), 'new', 'utf8')
    fs.writeFileSync(path.join(target, 'old.txt'), 'old', 'utf8')
    const out = orchestrator.atomicReplaceDir(source, target)
    assert.equal(typeof out.digest, 'string')
    assert.equal(fs.readFileSync(path.join(target, 'new.txt'), 'utf8'), 'new')
    assert.equal(fs.existsSync(path.join(target, 'old.txt')), false)
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith('target')), ['target'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('orchestrator: promoteTask aborts before touching target when snapshot fails', async () => {
  const adapter = await makeAdapterServer()
  const approver = {
    async requestPromotion() { return { id: 'apr_p', outcome: 'approved', by: 'tester' } },
    async snapshot() { return { ok: false, error: 'snapshot-unavailable' } },
  }
  const scorer = { scoreDir() { return { grade: 'B', S: 30, color: 'blue' } } }
  try {
    const { ctx, svc, dataRoot } = await boot({
      forker: makeFakeForker({ url: adapter.url, port: adapter.port }),
      extraServices: { [SERVICE.approver]: approver, [SERVICE.scorer]: scorer },
    })
    try {
      const created = await svc.createTask({ title: 'snapshot target' })
      assert.equal(created.ok, true, JSON.stringify(created))
      const target = path.join(dataRoot, 'promoted', 'plug')
      fs.mkdirSync(target, { recursive: true })
      fs.writeFileSync(path.join(target, 'old.txt'), 'old', 'utf8')
      const out = await svc.promoteTask(created.taskId, 'plug')
      assert.equal(out.ok, false)
      assert.equal(out.error, 'snapshot-failed')
      assert.equal(fs.readFileSync(path.join(target, 'old.txt'), 'utf8'), 'old', 'target must remain untouched')
      assert.equal(fs.existsSync(path.join(dataRoot, 'work', `${created.taskId}-plug`)), false, 'staging workDir must be removed')
    } finally {
      cleanup(ctx, dataRoot)
    }
  } finally {
    await adapter.close()
  }
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

test('orchestrator: GET /essence/detail 返回设置/插件/运行态摘要（无凭据）', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-detail-'))
  const ctx = makeCtx({ services: { [SERVICE.forker]: makeFakeForker(), webServer } })
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const mirror = ctx.get(SERVICE.mirror)
    const essence = mirror.createEssence({ name: '详情元主' })
    const handler = webServer.find('GET', '/fang/api/essence/detail').handler
    const req = makeReq(undefined, 'GET')
    req.url = `/fang/api/essence/detail?essenceId=${essence.id}`
    const res = makeRes()
    await handler(req, res)
    const body = res.json()
    assert.equal(res.statusCode, 200)
    assert.equal(body.ok, true)
    assert.equal(body.meta.id, essence.id)
    assert.ok(Array.isArray(body.overlay.patchEntries))
    assert.ok(Array.isArray(body.overlay.settings))
    assert.equal(typeof body.backup, 'boolean')
    assert.equal(JSON.stringify(body).includes('credentials'), false, '详情不得泄露凭据')

    const badReq = makeReq(undefined, 'GET')
    badReq.url = '/fang/api/essence/detail?essenceId=essence-nope'
    const badRes = makeRes()
    await handler(badReq, badRes)
    assert.equal(badRes.statusCode, 400)
    assert.equal(badRes.json().error, 'detail-failed')
  } finally {
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: 空白母体与自动同步间隔偏好', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-blank-'))
  const ctx = makeCtx({ services: { [SERVICE.forker]: makeFakeForker(), webServer } })
  const call = async (routePath, body) => {
    const res = makeRes()
    await webServer.find('POST', routePath).handler(makeReq(body, 'POST'), res)
    return res
  }
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const blank = await call('/fang/api/mirror/blank', {})
    assert.equal(blank.statusCode, 200, JSON.stringify(blank.json()))
    assert.equal(blank.json().version, 'blank')
    assert.equal(fs.existsSync(path.join(dataRoot, 'mirror', 'active', 'profile')), true)

    const prefs = await call('/fang/api/mirror/preferences/set', { syncIntervalHours: '6' })
    assert.equal(prefs.statusCode, 200)
    assert.equal(prefs.json().syncIntervalHours, '6')

    const status = ctx.get(SERVICE.mirror).status()
    assert.equal(status.preferences.syncIntervalHours, '6')
    assert.equal(status.preferences.backupIntervalHours, undefined)
  } finally {
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: createTask({essenceId}) 用原身 merged 作模板，归档原身拒绝派生', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-essfork-'))
  const forker = makeFakeForker()
  const ctx = makeCtx({ services: { [SERVICE.forker]: forker, webServer } })
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const mirror = ctx.get(SERVICE.mirror)
    const svc = ctx.get(SERVICE.orchestrator)
    const essence = mirror.createEssence({ name: '分身来源原身', defaultPatchEntries: [{ id: 'p1', name: '@x/p1' }] })
    const essenceRoot = path.join(dataRoot, 'essences', essence.id)
    const overlayFile = path.join(essenceRoot, 'overlay', 'cordis.patch.yml')
    const beforeStat = fs.statSync(overlayFile)
    const beforeBytes = fs.readFileSync(overlayFile, 'utf8')

    const out = await svc.createTask({ title: '从原身派生', essenceId: essence.id })
    assert.equal(out.ok, true)
    const provision = forker.calls.provision.at(-1)
    assert.match(String(provision.profileTemplate), /essences[\\/]essence-.*[\\/]merged[\\/]profile$/s)
    assert.equal(provision.cleanTemplate, false, '从原身派生必须关闭 clean template，配置才真的来自原身')
    assert.match(String(provision.nodeModulesSource ?? ''), /node_modules$/)
    assert.equal(fs.readFileSync(overlayFile, 'utf8'), beforeBytes, '派生不得改写原身 overlay')
    assert.equal(fs.statSync(overlayFile).mtimeMs, beforeStat.mtimeMs, '派生不得触碰原身文件 mtime')

    const task = svc.listTasks().find((item) => item.taskId === out.taskId)
    assert.equal(task.essenceId, essence.id, '任务必须记录来源原身')

    mirror.archiveEssence(essence.id, true)
    const archived = await svc.createTask({ title: '冻结原身派生', essenceId: essence.id })
    assert.equal(archived.ok, false)
    assert.equal(archived.error, 'essence-archived')
  } finally {
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: 分身配置可重置回来源原身（生产数据不动）', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-reset-'))
  const forker = makeFakeForker()
  const ctx = makeCtx({ services: { [SERVICE.forker]: forker, webServer } })
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const mirror = ctx.get(SERVICE.mirror)
    const svc = ctx.get(SERVICE.orchestrator)
    const essence = mirror.createEssence({ name: '重置来源', defaultPatchEntries: [{ id: 'p1', name: '@x/p1' }] })
    const out = await svc.createTask({ title: '可重置分身', essenceId: essence.id })
    assert.equal(out.ok, true)
    const task = svc.listTasks().find((item) => item.taskId === out.taskId)
    const profileDir = path.join(task.homeDir, 'profiles', task.profile)
    fs.writeFileSync(path.join(profileDir, 'package.json'), '{"name":"tampered"}', 'utf8')
    fs.mkdirSync(path.join(task.homeDir, 'sessions', 'ws', 'session-x'), { recursive: true })
    fs.writeFileSync(path.join(task.homeDir, 'sessions', 'ws', 'session-x', 'session.v4.jsonl.zstd'), 'prod', 'utf8')

    const reset = await svc.resetForkConfig(task.taskId)
    assert.equal(reset.ok, true)
    const pkgText = fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')
    assert.notEqual(JSON.parse(pkgText).name, 'tampered', '配置必须回到原身版本')
    assert.equal(fs.existsSync(path.join(task.homeDir, 'sessions', 'ws', 'session-x', 'session.v4.jsonl.zstd')), true, '生产数据不得被重置清掉')
  } finally {
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: 元主进行中会话配额（默认 10，超出拒绝再开实例）', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-squota-'))
  const ctx = makeCtx({ services: { [SERVICE.forker]: makeFakeForker(), webServer } })
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const mirror = ctx.get(SERVICE.mirror)
    const essence = mirror.createEssence({ name: '配额元主', tier: 'free' })
    const sessionsHome = path.join(dataRoot, 'runtime', essence.id, 'home', 'sessions', '--ws--')
    for (let index = 0; index < 10; index += 1) {
      fs.mkdirSync(path.join(sessionsHome, `session-${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`), { recursive: true })
    }
    const listed = mirror.listEssences().essences.find((item) => item.id === essence.id)
    assert.equal(listed.sessions.used, 10)
    assert.equal(listed.sessions.limit, 10)
    assert.equal(listed.sessions.over, true)
    assert.equal(listed.quota.sessions.used, 10, '设计稿字段 quota.sessions 必须存在')
    assert.equal(listed.quota.sessions.limit, 10)
    await assert.rejects(() => mirror.startEssenceRuntime(essence.id), /session-quota-exceeded/)
    const detail = mirror.essenceDetail(essence.id)
    assert.equal(detail.sessions.used, 10)
  } finally {
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: 会话护栏 1..3（运行中拒绝；停止态隔离超过 3 的多余会话）', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-single-'))
  const ctx = makeCtx({ services: { [SERVICE.forker]: makeFakeForker(), webServer } })
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const svc = ctx.get(SERVICE.orchestrator)
    const out = await svc.createTask({ title: '单会话分身' })
    assert.equal(out.ok, true)
    const task = svc.listTasks().find((item) => item.taskId === out.taskId)
    // v3.1.34：上限是 3 —— 造 5 个会话，护栏后应只剩 3 个（空的 isolation 由空会话下限保证）
    const sessionsRoot = path.join(task.homeDir, 'sessions', '--ws--')
    for (let i = 1; i <= 5; i += 1) {
      fs.mkdirSync(path.join(sessionsRoot, `session-0000000${i}-1111-4111-8111-11111111111${i}`), { recursive: true })
    }

    const runningGuard = svc.enforceSingleSession(task.taskId)
    assert.equal(runningGuard.ok, false)
    assert.equal(runningGuard.error, 'task-running')

    await svc.archiveTask(task.taskId)
    const stoppedGuard = svc.enforceSingleSession(task.taskId)
    assert.equal(stoppedGuard.ok, true)
    assert.ok(stoppedGuard.quarantined.length >= 1, '超过 3 个的会话必须被隔离')
    const guarded = fs.readdirSync(sessionsRoot).filter((name) => fs.statSync(path.join(sessionsRoot, name)).isDirectory())
    assert.ok(guarded.length <= 3, `最多保留 3 个会话，实际 ${guarded.length}`)
    assert.equal(fs.existsSync(path.join(task.homeDir, 'quarantine-sessions')), true)

    // #7：同一分身、同一会话可派生多个分支
    const store = new BranchStore(dataRoot)
    assert.equal(store.load(task.taskId).sessionId, stoppedGuard.kept, '分支库必须绑定到真实会话')
    store.create(task.taskId, { branchId: 'exp-1' })
    store.create(task.taskId, { branchId: 'exp-2' })
    const listed = store.list(task.taskId)
    assert.equal(listed.branches.length, 3, 'main + 两条新分支')
    store.activate(task.taskId, 'exp-2')
    assert.equal(store.list(task.taskId).activeBranchId, 'exp-2')
  } finally {
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: 复制元主时带走沙盒会话（运行态 sessions）', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-copysess-'))
  const ctx = makeCtx({ services: { [SERVICE.forker]: makeFakeForker(), webServer } })
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const mirror = ctx.get(SERVICE.mirror)
    const source = mirror.createEssence({ name: '带会话的源元主' })
    const srcForkId = source.id
    const srcSessionFile = path.join(dataRoot, 'runtime', srcForkId, 'home', 'sessions', '--ws--', '11111111-1111-4111-8111-111111111111', 'session.v4.jsonl.zstd')
    fs.mkdirSync(path.dirname(srcSessionFile), { recursive: true })
    fs.writeFileSync(srcSessionFile, 'conversation', 'utf8')

    const copied = mirror.copyEssence(source.id, '带会话的副本')
    assert.notEqual(copied.id, source.id)
    assert.ok(copied.copy.sessionsCopied >= 1, '沙盒会话必须被复制')
    const dstForkId = copied.id
    assert.equal(
      fs.existsSync(path.join(dataRoot, 'runtime', dstForkId, 'home', 'sessions', '--ws--', '11111111-1111-4111-8111-111111111111', 'session.v4.jsonl.zstd')),
      true,
      '副本的运行态 sessions 必须可见',
    )
  } finally {
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: 删除原身不删会话；分身保留且不能再派生；母体不可删', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-del-'))
  const ctx = makeCtx({ services: { [SERVICE.forker]: makeFakeForker(), webServer } })
  const call = async (method, routePath, body) => {
    const res = makeRes()
    const req = makeReq(body, method)
    req.url = routePath
    await webServer.find(method, routePath.split('?')[0]).handler(req, res)
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
    const svc = ctx.get(SERVICE.orchestrator)
    const essence = mirror.createEssence({ name: '将被删除的原身' })
    const task = await svc.createTask({ title: '原身的旧分身', essenceId: essence.id })
    assert.equal(task.ok, true)
    // 旧布局运行态会话在 essences/<id>/runtime/home 下
    const legacySession = path.join(dataRoot, 'essences', essence.id, 'runtime', 'home', 'sessions', '--ws--', '11111111-1111-4111-8111-111111111111', 'session.v4.jsonl.zstd')
    fs.mkdirSync(path.dirname(legacySession), { recursive: true })
    fs.writeFileSync(legacySession, 'conversation', 'utf8')

    mirror.archiveEssence(essence.id, true)
    const deleted = mirror.deleteEssence(essence.id)
    assert.equal(deleted.removed, true)
    assert.equal(fs.existsSync(path.join(dataRoot, 'essences', essence.id)), false, '配置/插件目录删除')
    assert.equal(
      fs.existsSync(path.join(dataRoot, 'runtime', essence.id, 'home', 'sessions', '--ws--', '11111111-1111-4111-8111-111111111111', 'session.v4.jsonl.zstd')),
      true,
      '运行态会话必须保留',
    )

    const blocked = await svc.createTask({ title: '从已删原身派生', essenceId: essence.id })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.error, 'essence-deleted')

    const survivor = svc.listTasks().find((item) => item.taskId === task.taskId)
    assert.ok(survivor, '已派生分身不受影响')
    assert.equal(survivor.essenceDeleted, true, '分身必须标记“原身已删除”')

    const mother = await call('POST', '/fang/api/mother/delete', {})
    assert.equal(mother.statusCode, 403)
    assert.equal(mother.json().error, 'mother-immutable')
  } finally {
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: 打开元主必须带着 homeDir/profile 调 spawn（回归：no-home-dir）', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-rt-guard-'))
  const forker = makeFakeForker()
  const ctx = makeCtx({ services: { [SERVICE.forker]: forker, webServer } })
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const mirror = ctx.get(SERVICE.mirror)
    const essence = mirror.createEssence({ name: '运行态回归' })
    const started = await mirror.startEssenceRuntime(essence.id)
    assert.equal(started.ok, true)
    const runtimeProvision = forker.calls.provision.at(-1)
    assert.equal(runtimeProvision.cleanTemplate, false, '元主运行态必须继承 merge profile，而不是 clean template')
    assert.match(String(runtimeProvision.nodeModulesSource ?? ''), /node_modules$/)
    const lastSpawn = forker.calls.spawn.at(-1)
    assert.ok(lastSpawn, '必须调用 spawn')
    assert.ok(String(lastSpawn.homeDir ?? '').length > 0, 'spawn 必须显式带 homeDir')
    assert.equal(lastSpawn.profile, 'essence-runtime')
    assert.equal(started.sandboxHome, lastSpawn.homeDir)
    const running = mirror.listEssences().essences.find((item) => item.id === essence.id)
    assert.equal(running.runtime.running, true, '运行中必须暴露 runtime.running=true（用于显示「停止」）')
    mirror.stopEssenceRuntime(essence.id)
    const stopped = mirror.listEssences().essences.find((item) => item.id === essence.id)
    assert.equal(stopped.runtime.running, false, '停止后运行态必须回到 false（用于显示「打开」）')
  } finally {
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: 方案B 分支会话不被单会话守卫隔离；激活切换 active 分支', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-branch-b-'))
  const ctx = makeCtx({ services: { [SERVICE.forker]: makeFakeForker(), webServer } })
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const svc = ctx.get(SERVICE.orchestrator)
    const out = await svc.createTask({ title: '多分支分身' })
    const task = svc.listTasks().find((item) => item.taskId === out.taskId)
    const sessionsRoot = path.join(task.homeDir, 'sessions', '--ws--')
    fs.mkdirSync(path.join(sessionsRoot, '11111111-1111-4111-8111-111111111111'), { recursive: true })
    fs.mkdirSync(path.join(sessionsRoot, '22222222-2222-4222-8222-222222222222'), { recursive: true })

    const store = new BranchStore(dataRoot)
    store.bindSession(task.taskId, '11111111-1111-4111-8111-111111111111')
    store.create(task.taskId, { branchId: 'b1', sessionId: '22222222-2222-4222-8222-222222222222' })

    await svc.archiveTask(task.taskId)
    const guard = svc.enforceSingleSession(task.taskId)
    assert.equal(guard.ok, true)
    assert.equal(guard.quarantined.length, 0, '登记过的分支会话不得被隔离')

    const res = makeRes()
    await webServer.find('POST', '/fang/api/tasks/branches/activate').handler(makeReq({ taskId: task.taskId, branchId: 'b1' }, 'POST'), res)
    assert.equal(res.statusCode, 200)
    const view = svc.listTasks().find((item) => item.taskId === task.taskId)
    assert.equal(view.branch.activeBranchId, 'b1')
  } finally {
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: 默认元宝（计划/创建/快速派生默认使用它）', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-default-'))
  const pluginManager = {
    async listPlugins() {
      return [
        { id: 'p-2xray', name: '@twinsearth/dsh-2xray' },
        { id: 'p-market', name: 'dshmarket' },
      ]
    },
  }
  const forker = makeFakeForker()
  const ctx = makeCtx({ services: { [SERVICE.forker]: forker, webServer, pluginManager } })
  const motherProfile = path.join(dataRoot, 'mother-profile')
  fs.mkdirSync(path.join(motherProfile, 'node_modules', '@local', 'dsh-fang'), { recursive: true })
  fs.writeFileSync(path.join(motherProfile, 'package.json'), JSON.stringify({ name: 'mother-probe', private: true }), 'utf8')
  fs.writeFileSync(path.join(motherProfile, 'cordis.patch.yml'), [
    '- id: ui-settings',
    '  name: "@deepseek-ai/dsh-client-ui-settings"',
    '  config:',
    '    enabled: true',
    '',
  ].join('\n'), 'utf8')
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      profileTemplate: motherProfile,
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const mirror = ctx.get(SERVICE.mirror)
    const svc = ctx.get(SERVICE.orchestrator)
    const preset = await mirror.defaultPreset()
    assert.equal(preset.plan.groups.length, 2)
    assert.equal(preset.plan.groups[0].plugins.find((item) => item.spec === '@twinsearth/dsh-2xray').installed, true)
    assert.equal(preset.plan.groups[1].plugins.find((item) => item.spec === 'dshmarket').installed, true)

    const dry = await mirror.ensureDefaultEssence({ apply: false })
    assert.equal(dry.dryRun, true)
    const made = await mirror.ensureDefaultEssence({ apply: true })
    assert.equal(made.created, true)
    const meta = mirror.listEssences().essences.find((item) => item.id === made.essenceId)
    assert.equal(meta.name, '默认元宝')
    assert.equal(made.mode, 'copy-local', '默认走“复制本机插件&设置”，不安装/不改母体')
    const marker = JSON.parse(fs.readFileSync(path.join(dataRoot, 'essences', made.essenceId, 'default-preset.json'), 'utf8'))
    assert.equal(marker.mode, 'copy-local')
    assert.equal(marker.source, motherProfile)
    const overlay = fs.readFileSync(path.join(dataRoot, 'essences', made.essenceId, 'overlay', 'cordis.patch.yml'), 'utf8')
    assert.match(overlay, /ui-settings/, '本机插件/设置状态必须被复制进默认元宝')
    const credDir = path.join(dataRoot, 'essences', made.essenceId, 'overlay', 'credentials')
    const credFiles = fs.existsSync(credDir) ? fs.readdirSync(credDir).length : 0
    assert.equal(credFiles, 0, '不得复制任何凭据/Token 文件（允许空目录）')
    assert.equal(fs.existsSync(path.join(dataRoot, 'essences', made.essenceId, 'runtime')), false, '不得复制运行数据/会话')

    const task = await svc.createTask({ title: '小白快速分身' })
    assert.equal(task.ok, true)
    const provision = forker.calls.provision.at(-1)
    assert.match(String(provision.profileTemplate), /merged[\\/]profile$/s, '快速派生必须用默认元宝作模板')
  } finally {
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: 元主栏“派生”= essenceId 模板 + 复制一个现有会话进分身', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-derive-'))
  const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-derive-src-'))
  const workspaceKey = '--E-GPT--'
  const sessionId = '44444444-4444-4444-8444-444444444444'
  fs.mkdirSync(path.join(sessionsRoot, workspaceKey, sessionId), { recursive: true })
  fs.writeFileSync(path.join(sessionsRoot, workspaceKey, sessionId, 'session.v4.jsonl.zstd'), 'session', 'utf8')
  const catalog = {
    listSessions: () => ({
      sessionsRoot,
      sessions: [{ sessionId, workspaceKey, archived: false, title: '要复制的会话' }],
    }),
  }
  const forker = makeFakeForker()
  const ctx = makeCtx({ services: { [SERVICE.forker]: forker, webServer, fangSessionCatalog: catalog } })
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const mirror = ctx.get(SERVICE.mirror)
    const svc = ctx.get(SERVICE.orchestrator)
    const essence = mirror.createEssence({ name: '派生模板元主' })
    const out = await svc.createTask({ title: '派生带会话', essenceId: essence.id, importSession: { sessionId } })
    assert.equal(out.ok, true)
    const task = svc.listTasks().find((item) => item.taskId === out.taskId)
    assert.equal(task.essenceId, essence.id)
    assert.equal(task.importedSession?.ok, true)
    assert.equal(
      fs.existsSync(path.join(task.homeDir, 'sessions', workspaceKey, sessionId, 'session.v4.jsonl.zstd')),
      true,
      '选中的会话必须被复制进分身沙箱',
    )
    const provision = forker.calls.provision.at(-1)
    assert.match(String(provision.profileTemplate), /merged[\\/]profile$/s)
  } finally {
    cleanup(ctx, dataRoot)
    fs.rmSync(sessionsRoot, { recursive: true, force: true })
  }
})

test('orchestrator: 启动时加载已有 tasks.json 不触发 scanForkSessions TDZ', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-load-'))
  const seedTask = {
    forkId: 'task_seed_loaded', taskId: 'task_seed_loaded', title: '旧任务', profile: 'fang-seed',
    homeDir: path.join(dataRoot, 'forks', 'task_seed_loaded'), status: 'archived',
    createdAt: Date.now(), adapter: { ok: false, error: 'archived' },
  }
  fs.writeFileSync(path.join(dataRoot, 'tasks.json'), JSON.stringify([seedTask]), 'utf8')
  const ctx = makeCtx({ services: { [SERVICE.forker]: makeFakeForker(), webServer } })
  try {
    assert.doesNotThrow(() => orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      routes: { enabled: false },
      authToken: TEST_AUTH_TOKEN,
    }))
    const svc = ctx.get(SERVICE.orchestrator)
    const list = svc.listTasks()
    assert.equal(list.length, 1)
    assert.equal(list[0].taskId, 'task_seed_loaded')
    // v3.1.34：sessions 视图增加 1..3 边界信息（count/min/max/violation/belowFloor）。
    assert.deepEqual(list[0].sessions, { count: 0, min: 1, max: 3, violation: false, belowFloor: true })
  } finally {
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: resolveCliPath derives the CLI from the current install root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-cli-'))
  try {
    const cli = path.join(root, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
    fs.mkdirSync(path.dirname(cli), { recursive: true })
    fs.writeFileSync(cli, '@echo off\n', 'utf8')
    assert.equal(
      orchestrator.resolveCliPath('', {}, path.join(root, 'DeepSeek Harness.exe')),
      cli,
      'new install path must be derived instead of falling back to bare dsh',
    )
    assert.equal(
      orchestrator.resolveCliPath('', { DSH_CLI: cli }, path.join(root, 'unrelated.exe')),
      cli,
      'DSH_CLI remains authoritative',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
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

test('orchestrator: 打开元主运行时导入进行中会话（≤5，归档拒绝）', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-sess-'))
  const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-sess-src-'))
  const workspaceKey = '--E-GPT--'
  // 母体工作区索引（供导入合并使用），测试期间把 DSH_HOME 指到临时目录
  const previousDshHome = process.env.DSH_HOME
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-sess-home-'))
  fs.mkdirSync(path.join(dshHome, 'storages'), { recursive: true })
  fs.writeFileSync(path.join(dshHome, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: 'ws-1', workspaceIds: ['ws-1'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { 'ws-1': { path: 'E:\\GPT', title: 'GPT 工作区', sessionIds: ['11111111-1111-4111-8111-111111111111'] } } },
  }), 'utf8')
  process.env.DSH_HOME = dshHome
  const liveId = '11111111-1111-4111-8111-111111111111'
  const archivedId = '22222222-2222-4222-8222-222222222222'
  for (const id of [liveId, archivedId]) {
    fs.mkdirSync(path.join(sessionsRoot, workspaceKey, id), { recursive: true })
    fs.writeFileSync(path.join(sessionsRoot, workspaceKey, id, 'session.v4.jsonl.zstd'), 'x')
  }
  const catalog = {
    listSessions: () => ({
      sessionsRoot,
      sessions: [
        { sessionId: liveId, workspaceKey, archived: false, title: '进行中会话' },
        { sessionId: archivedId, workspaceKey, archived: true, title: '归档会话' },
        { sessionId: '33333333-3333-4333-8333-333333333333', workspaceKey: '..', archived: false, title: '越界会话' },
      ],
    }),
  }
  const ctx = makeCtx({ services: { [SERVICE.forker]: makeFakeForker(), webServer, fangSessionCatalog: catalog } })
  const call = async (body) => {
    const res = makeRes()
    await webServer.find('POST', '/fang/api/essence/runtime').handler(makeReq(body, 'POST'), res)
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
    const essence = mirror.createEssence({ name: '会话导入元主' })

    const ok = await call({ essenceId: essence.id, sessionIds: [liveId] })
    assert.equal(ok.statusCode, 200)
    assert.equal(ok.json().importedSessions.length, 1)
    const okBody = ok.json()
    assert.equal(
      fs.existsSync(path.join(okBody.sandboxHome, 'sessions', workspaceKey, liveId, 'session.v4.jsonl.zstd')),
      true,
      '会话目录必须复制进隔离 home',
    )
    assert.equal(
      okBody.sandboxHome.includes(`${path.sep}essences${path.sep}`),
      false,
      '运行态 home 不得落在原身文件夹内',
    )
    // 工作区索引合并：分组应显示工作区名，而不是 --E-GPT-- key
    const importedIndex = JSON.parse(fs.readFileSync(path.join(okBody.sandboxHome, 'storages', 'workspace.json'), 'utf8'))
    const workspaceRecord = importedIndex.tables.workspaces['ws-1']
    assert.equal(workspaceRecord.path, 'E:\\GPT')
    assert.equal(workspaceRecord.title, 'GPT 工作区')
    assert.ok(workspaceRecord.sessionIds.includes('11111111-1111-4111-8111-111111111111'))

    const archived = await call({ essenceId: essence.id, sessionIds: [archivedId] })
    assert.equal(archived.statusCode, 400)
    assert.match(String(archived.json().detail), /archived-session-not-importable/)

    const escaped = await call({ essenceId: essence.id, sessionIds: ['33333333-3333-4333-8333-333333333333'] })
    assert.equal(escaped.statusCode, 400)
    assert.match(String(escaped.json().detail), /invalid-workspace-key/)

    const tooMany = await call({
      essenceId: essence.id,
      sessionIds: ['a', 'b', 'c', 'd', 'e', 'f'],
    })
    assert.equal(tooMany.statusCode, 400)
    assert.match(String(tooMany.json().detail), /too-many-sessions/)
  } finally {
    cleanup(ctx, dataRoot)
    fs.rmSync(sessionsRoot, { recursive: true, force: true })
    fs.rmSync(dshHome, { recursive: true, force: true })
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
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

test('orchestrator: derive() is fail-closed without a session catalog, and requires exactly one session', skipNoRemote, async () => {
  const adapter = await makeAdapterServer()
  try {
    const { ctx, svc, dataRoot } = await boot({ forker: makeFakeForker({ url: adapter.url, port: adapter.port }) })
    const denied = await svc.derive({ sessionId: 'session-01234567-89ab-cdef-0123-456789abcdef' })
    assert.equal(denied.ok, false)
    assert.equal(denied.error, 'session-catalog-unavailable')
    // v3.1.30：派生分身必须导入一个进行中会话——不再允许无 sessionId 的空白派生。
    const plain = await svc.derive({ title: '纯 lineage' })
    assert.equal(plain.ok, false)
    assert.equal(plain.error, 'session-required')
    // 一次只能导入一个：多选直接拒绝，且不会创建任何任务。
    const multi = await svc.derive({ sessionIds: ['session-a', 'session-b'] })
    assert.equal(multi.ok, false)
    assert.equal(multi.error, 'session-multi-not-allowed')
    assert.equal(svc.listTasks().length, 0, 'rejected derives must not create tasks')
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

test('orchestrator: npm-installed @twinsearth/dsh-fang satisfies the fork bundle check', async () => {
  const forker = makeFakeForker()
  const realProvision = forker.provision.bind(forker)
  forker.provision = async (args) => {
    const out = await realProvision(args)
    const profileDir = path.join(args.homeDir, 'profiles', args.profile)
    fs.rmSync(path.join(profileDir, 'node_modules'), { recursive: true, force: true })
    fs.mkdirSync(path.join(profileDir, 'node_modules', '@twinsearth', 'dsh-fang'), { recursive: true })
    return out
  }
  const { ctx, svc, forker: f, dataRoot } = await boot({ forker })
  const out = await svc.createTask({ title: 'npm-installed' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(f.calls.reap.length, 0)
  assert.equal(f.calls.spawn.length, 1)
  cleanup(ctx, dataRoot)
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
  // v3.1.34：空白派生前会自动补一个空会话（下限 1），因此这里至少 1 个。
  assert.ok(out.sessions.length >= 1, 'must list at least the floor session')
  const target = out.sessions.find((session) => session.sessionId === sid)
  assert.ok(target, 'the written fork session must be listed')
  assert.equal(target.title, '分身内会话标题')
  assert.equal(target.titleSource, 'session/title')
  assert.match(target.preview, /分身内首条消息/)
  assert.equal(target.workspaceTitle, 'ForkWS')
  assert.equal((await svc.listForkSessions('task_nope')).error, 'unknown-task')
  cleanup(ctx, dataRoot)
})

test('orchestrator: requestMotherRestart treats auto-allow as an allowed decision', async () => {
  const restart = { request: async () => ({ id: 'rst_auto', outcome: 'auto-allow', decision: 'auto-allow' }) }
  const { ctx, svc, dataRoot } = await boot({ extraServices: { [SERVICE.restart]: restart } })
  try {
    const out = await svc.requestMotherRestart('policy-auto')
    assert.equal(out.ok, true)
    assert.equal(out.outcome, 'auto-allow')
  } finally {
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: approvals aggregate mother+fork and route fork decide', async () => {
  const adapter = await makeAdapterServer({
    approvals: [{ id: 'apr_shared', title: 'fork approval', risk: 'yellow', kind: 'promotion', createdAt: 1, deadlineAt: 3 }],
  })
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-approvals-fork-'))
  const motherApprover = {
    pending() {
      return [{ id: 'apr_shared', title: 'mother approval', risk: 'red', kind: 'restart', createdAt: 1, deadlineAt: 2 }]
    },
    decide() { return { ok: true, id: 'apr_shared', outcome: 'approved', by: 'tester' } },
  }
  const ctx = makeCtx({
    services: {
      [SERVICE.forker]: makeFakeForker({ url: adapter.url, port: adapter.port }),
      webServer,
      [SERVICE.approver]: motherApprover,
    },
  })
  const call = async (method, routePath, body) => {
    const res = makeRes()
    await webServer.find(method, routePath.split('?')[0]).handler(makeReq(body, method), res)
    return res
  }
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      adapterTimeoutMs: 2000,
      adapterPollMs: 20,
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const created = await ctx.get(SERVICE.orchestrator).createTask({ title: 'approval fork' })
    assert.equal(created.ok, true, JSON.stringify(created))
    const listed = await call('GET', '/fang/api/approvals')
    assert.equal(listed.statusCode, 200)
    const body = listed.json()
    assert.equal(body.degraded, false)
    assert.equal(body.items.length, 2)
    const same = body.items.filter((item) => item.approvalId === 'apr_shared')
    assert.equal(same.length, 2, 'same id from mother and fork must both survive')
    assert.deepEqual([...new Set(same.map((item) => item.source))].sort(), ['fork', 'mother'])
    assert.equal(same.find((item) => item.source === 'fork').taskId, created.taskId)

    const decided = await call('POST', '/fang/api/approvals/decide', {
      source: 'fork', taskId: created.taskId, approvalId: 'apr_shared', outcome: 'approved', by: 'tester',
    })
    assert.equal(decided.statusCode, 200)
    assert.equal(adapter.state.approvalDecisions.length, 1)
    assert.equal(adapter.state.approvalDecisions[0].id, 'apr_shared')
    assert.equal(adapter.state.approvalDecisions[0].outcome, 'approved')

    const unknown = await call('POST', '/fang/api/approvals/decide', {
      source: 'bogus', approvalId: 'apr_shared', outcome: 'approved',
    })
    assert.equal(unknown.statusCode, 400)
  } finally {
    cleanup(ctx, dataRoot)
    await adapter.close()
  }
})

test('orchestrator: decision-center list and resolve routes use the service', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-decision-route-'))
  const calls = []
  const restartCalls = []
  const listCalls = []
  const center = {
    actionHandlers: [],
    registerActionHandler(id, fn) { this.actionHandlers.push({ id, fn }); return () => { this.actionHandlers = this.actionHandlers.filter(item => item.id !== id) } },
    list(opts) { listCalls.push(opts ?? {}); return { items: [{ id: 'dec_1', level: 'red', status: 'pending' }], counts: { red: 1 }, total: 1, active: 1, rev: 5 } },
    get(id) { return id === 'dec_1' ? { id, level: 'red', status: 'pending' } : null },
    ingest(body) { calls.push({ ingest: body }); return { ok: true, ticket: { id: 'ext_1', level: 'yellow', title: body?.title } } },
    testAi(body) { calls.push({ aiTest: body }); return { ok: true, provider: 'deepseek', model: 'deepseek-flash', latencyMs: 12 } },
    advise(id) { calls.push({ aiAdvise: id }); return { ok: false, reason: 'ai-rate-limited', retryAfterMs: 2000 } },
    adviseStream(id, onDelta) { calls.push({ aiAdviseStream: id }); onDelta('he', 'he'); onDelta('llo', 'hello'); return Promise.resolve({ ok: true, advice: { summary: 'hello' }, ticket: { id } }) },
    abandonMany(ids, opts) { calls.push({ abandonMany: ids, opts }); return { ok: true, results: ids.map(id => ({ id, ok: true })) } },
    quotaStatus() { return { ok: true, total: 2, sessions: [{ sessionId: 's-a', count: 2 }], roles: [{ role: 'pm', count: 2 }], pending: { total: 1, red: 0, attentionPoints: 3 } } },
    forkAggregation() { return { ok: true, mother: { forkId: 'mother', total: 1 }, forks: [{ forkId: 'fork-a', total: 2, pending: 1 }] } },
    producerCatalog() { return { ok: true, version: 1, producers: [{ producer: 'PJM', kinds: ['pjm-timeout'] }] } },
    resolve(id, option, opts) { calls.push({ id, option, opts }); return { ok: true, ticket: { id, status: 'resolved', resolvedOption: option } } },
    abandon(id, opts) { calls.push({ id, abandon: true, opts }); return { ok: true, ticket: { id, status: 'abandoned' } } },
  }
  const ctx = makeCtx({ services: { [SERVICE.forker]: makeFakeForker(), webServer, [SERVICE.decisionCenter]: center, [SERVICE.restart]: { request: async (input) => { restartCalls.push(input); return { ok: true, requested: true } } } } })
  const call = async (method, routePath, body) => {
    const res = makeRes()
    const req = makeReq(body, method)
    req.url = routePath
    await webServer.find(method, routePath.split('?')[0]).handler(req, res)
    return res
  }
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const restartHandler = center.actionHandlers.find((item) => item.id === 'confirm_restart')
    assert.ok(restartHandler, 'orchestrator must register the confirm_restart action hook')
    const hooked = await restartHandler.fn({ ticket: { id: 'dec_1' }, payload: { reason: 'unit', risk: 'yellow' } })
    assert.equal(hooked.ok, true)
    assert.equal(restartCalls[0].origin, 'decision-center')
    assert.equal(restartCalls[0].reason, 'unit')
    const listed = await call('GET', '/fang/api/decisions')
    assert.equal(listed.statusCode, 200)
    assert.equal(listed.json().items[0].id, 'dec_1')

    // SSE：bus 事件 → 已鉴权流；ready 首帧 + ticket 帧。
    const eventsRoute = webServer.find('GET', '/fang/api/decisions/events')
    assert.ok(eventsRoute, 'GET /fang/api/decisions/events must be registered')
    const streamRes = {
      statusCode: 0, headers: {}, chunks: [], ended: false,
      writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers ?? {}) },
      flushHeaders() {}, write(chunk) { this.chunks.push(String(chunk)); return true },
      end() { this.ended = true }, on() {},
      get text() { return this.chunks.join('') },
    }
    const sseReq = makeReq(undefined, 'GET')
    await eventsRoute.handler(sseReq, streamRes)
    assert.equal(streamRes.statusCode, 200)
    assert.match(streamRes.headers['content-type'], /text\/event-stream/)
    assert.match(streamRes.text, /event: ready/)
    assert.match(streamRes.text, /"rev":5/)
    bus.emit('fang/decision-created', { id: 'dec_sse', level: 'red', status: 'pending', rev: 6 })
    assert.match(streamRes.text, /event: ticket/)
    assert.match(streamRes.text, /dec_sse/)
    assert.equal(streamRes.ended, false, 'stream stays open until the client disconnects')
    sseReq.emit('close')
    assert.equal(streamRes.ended, true, 'client disconnect closes the stream')

    const resolved = await call('POST', '/fang/api/decisions/resolve', { id: 'dec_1', option: 'yes', by: 'tester' })
    assert.equal(resolved.statusCode, 200)
    assert.deepEqual(calls[0], { id: 'dec_1', option: 'yes', opts: { by: 'tester', note: undefined } })

    // 外部生产者桥：POST /fang/api/decisions/ingest
    const ingested = await call('POST', '/fang/api/decisions/ingest', {
      producer: 'HarnessMM', kind: 'gdr', title: 'ingest from external', dedupeKey: 'hmm:1',
      options: [{ value: 'a', label: 'A' }],
    })
    assert.equal(ingested.statusCode, 200)
    assert.equal(ingested.json().ticket.id, 'ext_1')
    assert.equal(calls.find((item) => item.ingest)?.ingest.producer, 'HarnessMM')

    // 批量归档：POST /fang/api/decisions/abandon { ids } → abandonMany
    const archived = await call('POST', '/fang/api/decisions/abandon', { ids: ['dec_a', 'dec_b'], by: 'tester' })
    assert.equal(archived.statusCode, 200)
    assert.equal(archived.json().results.length, 2)
    assert.deepEqual(calls.find((item) => item.abandonMany)?.abandonMany, ['dec_a', 'dec_b'])

    // 测试连接：POST /fang/api/decisions/ai/test（不保存）
    const tested = await call('POST', '/fang/api/decisions/ai/test', {
      provider: 'deepseek', apiKey: 'test-key-0123456789',
    })
    assert.equal(tested.statusCode, 200)
    assert.equal(tested.json().ok, true)
    assert.equal(calls.find((item) => item.aiTest)?.aiTest.provider, 'deepseek')

    // AI 限流：429 + Retry-After 透传
    const limited = await call('POST', '/fang/api/decisions/ai/advise', { id: 'dec_1' })
    assert.equal(limited.statusCode, 429)
    assert.equal(limited.json().reason, 'ai-rate-limited')
    assert.equal(limited.headers['retry-after'], '2')

    // 配额统计：GET /fang/api/decisions/quota
    const quota = await call('GET', '/fang/api/decisions/quota')
    assert.equal(quota.statusCode, 200)
    assert.equal(quota.json().total, 2)
    assert.equal(quota.json().roles[0].role, 'pm')

    // includeArchived / since 透传
    const withArchived = await call('GET', '/fang/api/decisions?includeArchived=1&since=3')
    assert.equal(withArchived.statusCode, 200)
    assert.equal(listCalls.at(-1).includeArchived, true)
    assert.equal(listCalls.at(-1).since, 3)

    const forks = await call('GET', '/fang/api/decisions/forks')
    assert.equal(forks.statusCode, 200)
    assert.equal(forks.json().forks[0].forkId, 'fork-a')

    const producers = await call('GET', '/fang/api/decisions/producers')
    assert.equal(producers.statusCode, 200)
    assert.equal(producers.json().version, 1)
    assert.equal(producers.json().producers[0].producer, 'PJM')

    // AI 流式：POST /fang/api/decisions/ai/advise/stream → SSE start/delta/done
    const aiStreamRes = {
      statusCode: 0, headers: {}, body: '', ended: false,
      writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers ?? {}) },
      setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
      flushHeaders() {},
      write(chunk) { this.body += String(chunk); return true },
      end() { this.ended = true },
      on() {},
    }
    const aiStreamReq = makeReq({ id: 'dec_1' }, 'POST')
    aiStreamReq.url = '/fang/api/decisions/ai/advise/stream'
    await webServer.find('POST', '/fang/api/decisions/ai/advise/stream').handler(aiStreamReq, aiStreamRes)
    assert.equal(aiStreamRes.statusCode, 200)
    assert.match(aiStreamRes.headers['content-type'], /text\/event-stream/)
    assert.match(aiStreamRes.body, /event: start/)
    assert.match(aiStreamRes.body, /event: delta/)
    assert.match(aiStreamRes.body, /"delta":"he"/)
    assert.match(aiStreamRes.body, /event: done/)
    assert.equal(aiStreamRes.ended, true)

    // fork 轮询单票：GET /fang/api/decisions/item?id=...
    const item = await call('GET', '/fang/api/decisions/item?id=dec_1')
    assert.equal(item.statusCode, 200)
    assert.equal(item.json().ticket.id, 'dec_1')
    const missingItem = await call('GET', '/fang/api/decisions/item?id=missing')
    assert.equal(missingItem.statusCode, 404)
  } finally {
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: decision-center routes map 400/404/409 and parse includeArchived/since', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-decision-http-'))
  const listOptions = []
  const center = {
    list(options) { listOptions.push(options); return { items: [], counts: {}, total: 0, active: 0, rev: 9 } },
    resolve(id) {
      if (id === 'missing') return { ok: false, reason: 'not-found' }
      if (id === 'settled') return { ok: false, reason: 'not-pending' }
      return { ok: false, reason: 'unknown-option' }
    },
  }
  const ctx = makeCtx({ services: { [SERVICE.forker]: makeFakeForker(), webServer, [SERVICE.decisionCenter]: center } })
  const call = async (method, routePath, body, url) => {
    const res = makeRes()
    const req = makeReq(body, method)
    if (url) req.url = url
    await webServer.find(method, routePath).handler(req, res)
    return res
  }
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const listed = await call('GET', '/fang/api/decisions', undefined, '/fang/api/decisions?includeArchived=1&since=5')
    assert.equal(listed.statusCode, 200)
    assert.equal(listed.json().rev, 9)
    assert.deepEqual(listOptions[0], { includeArchived: true, since: 5 })

    const missing = await call('POST', '/fang/api/decisions/resolve', { id: 'missing' })
    assert.equal(missing.statusCode, 404)
    const settled = await call('POST', '/fang/api/decisions/resolve', { id: 'settled' })
    assert.equal(settled.statusCode, 409)
    const badOption = await call('POST', '/fang/api/decisions/resolve', { id: 'pending' })
    assert.equal(badOption.statusCode, 400)
  } finally {
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: approvals aggregate local pending and decide without faking success', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-approvals-route-'))
  const decisions = []
  const approver = {
    pending() {
      return [{ id: 'apr_1', title: 'promote', risk: 'red', kind: 'promotion', createdAt: 1, deadlineAt: 2 }]
    },
    decide(id, outcome, options) {
      decisions.push({ id, outcome, options })
      return id === 'apr_1'
        ? { ok: true, id, outcome, by: options.by }
        : { ok: false, reason: 'not-pending' }
    },
  }
  const ctx = makeCtx({ services: { [SERVICE.forker]: makeFakeForker(), webServer, [SERVICE.approver]: approver } })
  const call = async (method, routePath, body) => {
    const res = makeRes()
    await webServer.find(method, routePath.split('?')[0]).handler(makeReq(body, method), res)
    return res
  }
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const listed = await call('GET', '/fang/api/approvals')
    assert.equal(listed.statusCode, 200)
    const body = listed.json()
    assert.equal(body.ok, true)
    assert.equal(body.degraded, false)
    assert.equal(body.items.length, 1)
    assert.equal(body.items[0].source, 'mother')
    assert.equal(body.items[0].approvalId, 'apr_1')
    assert.equal(body.items[0].adapterOk, true)

    const approved = await call('POST', '/fang/api/approvals/decide', {
      source: 'mother', approvalId: 'apr_1', outcome: 'approved', by: 'tester',
    })
    assert.equal(approved.statusCode, 200)
    assert.equal(approved.json().outcome, 'approved')
    assert.equal(decisions.length, 1)
    assert.equal(decisions[0].options.by, 'tester')

    const stale = await call('POST', '/fang/api/approvals/decide', {
      source: 'mother', approvalId: 'apr_missing', outcome: 'denied',
    })
    assert.equal(stale.statusCode, 409)

    const bad = await call('POST', '/fang/api/approvals/decide', {
      source: 'mother', approvalId: 'apr_1', outcome: 'maybe',
    })
    assert.equal(bad.statusCode, 400)
  } finally {
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: autostartForks respawns stopped tasks, skips archived/running, exposes HTTP route', async () => {
  const webServer = makeWebServerStub()
  const forker = makeFakeForker()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-autostart-'))
  const ctx = makeCtx({ services: { [SERVICE.forker]: forker, webServer } })
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      adapterTimeoutMs: 100,
      adapterPollMs: 40,
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const svc = ctx.get(SERVICE.orchestrator)
    const a = await svc.createTask({ title: 'autostart-a' })
    const b = await svc.createTask({ title: 'autostart-b' })
    const archived = await svc.createTask({ title: 'autostart-archived' })
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    assert.equal(archived.ok, true)

    await forker.stop(a.taskId)
    await forker.stop(b.taskId)
    const arch = await svc.archiveTask(archived.taskId)
    assert.equal(arch.ok, true)
    await forker.stop(archived.taskId)

    const out = await svc.autostartForks()
    assert.equal(out.ok, true)
    assert.deepEqual(out.started.map(item => item.taskId).sort(), [a.taskId, b.taskId].sort())
    assert.ok(out.skipped.some(item => item.taskId === archived.taskId && item.reason === 'archived'))
    assert.equal(forker.status(a.taskId).running, true)
    assert.equal(forker.status(b.taskId).running, true)
    assert.equal(forker.status(archived.taskId).running, false, 'archived must stay stopped')

    // 第二次：已运行的不重复 spawn
    const spawnsBefore = forker.calls.spawn.length
    const again = await svc.autostartForks()
    assert.ok(again.skipped.some(item => item.taskId === a.taskId && item.reason === 'already-running'))
    assert.equal(forker.calls.spawn.length, spawnsBefore, 'running tasks must not be spawned twice')

    // HTTP 路由：POST /fang/api/forks/autostart
    const handler = webServer.find('POST', '/fang/api/forks/autostart')
    assert.ok(handler, 'POST /fang/api/forks/autostart must be registered')
    const res = makeRes()
    await handler.handler(makeReq({}, 'POST'), res)
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.ok(Array.isArray(body.started))
    assert.ok(Array.isArray(body.failed))
    assert.ok(Array.isArray(body.skipped))
  } finally {
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: fork supervision toggles persist and apply to the forker', async () => {
  const webServer = makeWebServerStub()
  const applied = []
  let fakeSupervise = false
  const forker = makeFakeForker({
    getSupervision() { return { enabled: fakeSupervise, configured: false, maxRestarts: 3 } },
    setSupervise(enabled) { applied.push(enabled); fakeSupervise = enabled; return { ok: true, enabled } },
  })
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-supervision-'))
  const ctx = makeCtx({ services: { [SERVICE.forker]: forker, webServer } })
  try {
    orchestrator.apply(ctx, { dataRoot, routes: { enabled: true, prefix: '/fang' }, authToken: TEST_AUTH_TOKEN })
    const svc = ctx.get(SERVICE.orchestrator)
    const out = svc.setForkSupervision({ autostartForks: false, supervise: true })
    assert.equal(out.ok, true)
    assert.equal(out.effective.autostartForks, false)
    assert.equal(out.effective.supervise, true)
    assert.deepEqual(applied, [true], 'forker.setSupervise must be called immediately')
    assert.equal(readForkSupervisionSettings(dataRoot).autostartForks, false)
    assert.equal(readForkSupervisionSettings(dataRoot).supervise, true)

    // HTTP：POST 应用 + GET 读取
    const post = makeRes()
    const req = makeReq({ autostartForks: true, supervise: false }, 'POST')
    req.url = '/fang/api/forks/supervision'
    await webServer.find('POST', '/fang/api/forks/supervision').handler(req, post)
    assert.equal(post.statusCode, 200, post.body)
    assert.equal(post.json().effective.autostartForks, true)
    assert.deepEqual(applied, [true, false])

    const get = makeRes()
    const getReq = makeReq(null, 'GET')
    getReq.url = '/fang/api/forks/supervision'
    await webServer.find('GET', '/fang/api/forks/supervision').handler(getReq, get)
    assert.equal(get.statusCode, 200, get.body)
    assert.equal(get.json().ok, true)
    assert.equal(get.json().persisted.autostartForks, true)
  } finally {
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: no duplicate exact route paths (host keys by path only)', () => {
  // DSH webServer.register keys exact routes by path; a second same-path registration
  // throws and silently drops every later route. Unit tests use a permissive stub, so
  // this source-level guard catches the class of bug e2e found (branches/composer lost).
  const source = fs.readFileSync(new URL('../src/plugins/orchestrator.mjs', import.meta.url), 'utf8')
  const paths = new Map()
  const add = (routePath, method) => {
    if (!paths.has(routePath)) paths.set(routePath, [])
    paths.get(routePath).push(method)
  }
  let match
  const one = /route\('(GET|POST|PUT|PATCH|DELETE)',\s*`\$\{prefix\}([^`]*)`/g
  while ((match = one.exec(source))) add(match[2], match[1])
  const both = /routeMethods\(`\$\{prefix\}([^`]*)`/g
  while ((match = both.exec(source))) add(match[1], 'GET+POST')
  const duplicates = [...paths.entries()].filter(([, methods]) => methods.length > 1)
  assert.deepEqual(duplicates, [], `duplicate exact routes: ${JSON.stringify(duplicates)}`)
})

test('orchestrator: decision HTTP routes map 400/404/409 correctly', async () => {
  const webServer = makeWebServerStub()
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-decision-status-'))
  const center = {
    list() { return { items: [], counts: {}, rev: 1 } },
    resolve(id, option) {
      if (id === 'missing') return { ok: false, reason: 'not-found' }
      if (id === 'bad') return { ok: false, reason: 'unknown-option' }
      return { ok: false, reason: 'not-pending' }
    },
    ingest(body) {
      if (!body?.title) return { ok: false, reason: 'title-required' }
      return { ok: false, reason: 'conflict' }
    },
  }
  const ctx = makeCtx({ services: { webServer, [SERVICE.forker]: makeFakeForker(), [SERVICE.decisionCenter]: center } })
  const call = async (method, routePath, body) => {
    const res = makeRes()
    const req = makeReq(body, method)
    req.url = routePath
    await webServer.find(method, routePath.split('?')[0]).handler(req, res)
    return res
  }
  try {
    orchestrator.apply(ctx, { dataRoot, authToken: TEST_AUTH_TOKEN })
    assert.equal((await call('POST', '/fang/api/decisions/resolve', { id: 'missing' })).statusCode, 404)
    assert.equal((await call('POST', '/fang/api/decisions/resolve', { id: 'bad', option: 'x' })).statusCode, 400)
    assert.equal((await call('POST', '/fang/api/decisions/resolve', { id: 'pending', option: 'x' })).statusCode, 409)
    assert.equal((await call('POST', '/fang/api/decisions/ingest', {})).statusCode, 400)
    assert.equal((await call('POST', '/fang/api/decisions/ingest', { title: 'x' })).statusCode, 409)
  } finally {
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: officialSourceUrl manifest adapter performs a real upgrade', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    async text() {
      return JSON.stringify({
        version: '9.9.9',
        files: {
          'package.json': JSON.stringify({ name: 'fake-profile', version: '9.9.9' }),
          'cordis.patch.yml': 'insert: []\n',
          'version.json': JSON.stringify({ version: '9.9.9' }),
        },
      })
    },
  })
  const submitted = []
  const center = {
    list() { return { items: [], counts: {}, rev: 1 } },
    submit(spec) { submitted.push(spec); return { ok: true, ticket: { id: 'dec_x' } } },
    ingest() { return { ok: true, ticket: { id: 'ext_x' } } },
  }
  const { ctx, dataRoot } = await boot({
    extraServices: { [SERVICE.decisionCenter]: center },
    config: {
      officialSourceUrl: 'http://127.0.0.1:9999',
      compatGate: async () => ({ ok: true, checkedAt: Date.now(), findings: [] }),
    },
  })
  try {
    const mirror = ctx.get(SERVICE.mirror)
    const check = await mirror.checkUpdate()
    assert.equal(check.latest, '9.9.9')
    assert.equal(check.available, true)
    const out = await mirror.upgrade({ autoBackup: false, autoRollback: false })
    assert.equal(out.ok, true)
    assert.equal(out.to, '9.9.9')
    assert.equal(out.reason, undefined)
    const active = path.join(dataRoot, 'mirror', 'active')
    assert.equal(fs.existsSync(path.join(active, 'package.json')), true)
    assert.equal(JSON.parse(fs.readFileSync(path.join(active, 'package.json'), 'utf8')).version, '9.9.9')
    // 升级成功 → 红色 restart ticket（action confirm_restart）
    const restartTicket = submitted.find((spec) => spec.level === 'red')
    assert.ok(restartTicket, 'successful upgrade must raise a red restart ticket')
    assert.match(String(restartTicket.title), /需重启宿主/)
    assert.equal(restartTicket.actions?.[0]?.id, 'confirm_restart')
  } finally {
    globalThis.fetch = originalFetch
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: fake officialSource + failing compat gate yields a compat decision ticket', async () => {
  const submitted = []
  const center = {
    list() { return { items: [], counts: {}, rev: 1 } },
    submit(spec) { submitted.push(spec); return { ok: true, ticket: { id: 'dec_compat_1' } } },
    ingest() { return { ok: true, ticket: { id: 'ext_x' } } },
  }
  const downloaded = []
  const officialSource = {
    getLatestVersion: () => '9.9.9',
    download: (version, staging) => {
      downloaded.push({ version, staging })
      fs.mkdirSync(staging, { recursive: true })
      fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({ name: 'fake-mirror', version }), 'utf8')
      fs.writeFileSync(path.join(staging, 'cordis.patch.yml'), 'insert: []\n', 'utf8')
    },
  }
  const { ctx, dataRoot } = await boot({
    extraServices: { [SERVICE.decisionCenter]: center },
    config: {
      officialSource,
      compatGate: async () => ({ ok: false, checkedAt: Date.now(), findings: [{ code: 'unit', severity: 'error', message: 'forced' }] }),
    },
  })
  try {
    const mirror = ctx.get(SERVICE.mirror)
    const out = await mirror.upgrade({ autoBackup: false, autoRollback: false })
    assert.equal(out.ok, true)
    assert.equal(out.to, '9.9.9')
    assert.equal(out.reason, 'compat-gate-failed')
    assert.equal(downloaded.length, 1)
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0].level, 'yellow')
    assert.match(String(submitted[0].title), /兼容门禁未通过/)
    assert.match(String(submitted[0].context), /findings=1/)
  } finally {
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: real EssenceManager conflicted/failed recompute raises a decision ticket', async () => {
  const submitted = []
  const center = {
    list() { return { items: [], counts: {}, rev: 1 } },
    submit(spec) { submitted.push(spec); return { ok: true, ticket: { id: 'dec_essence_real_1' } } },
    ingest() { return { ok: true, ticket: { id: 'ext_x' } } },
  }
  const { ctx, dataRoot } = await boot({ extraServices: { [SERVICE.decisionCenter]: center } })
  try {
    const mirror = ctx.get(SERVICE.mirror)
    const layout = resolveFangLayout({ dataRoot })
    const created = mirror.createEssence({ name: 'real-conflict' })
    assert.ok(created?.id, 'essence created')
    const root = path.join(layout.essenceRoot, created.id)
    // 真实冲突：镜像锁定 plugin，原身 overlay 试图禁用 → fatal LOCKED_PLUGIN_DISABLED
    const mirrorRoot = path.join(dataRoot, 'mirror')
    fs.mkdirSync(path.join(mirrorRoot, 'active', 'profile'), { recursive: true })
    fs.writeFileSync(path.join(mirrorRoot, 'mirror-locked.json'), JSON.stringify({ locked: ['locked-x'] }), 'utf8')
    fs.writeFileSync(path.join(mirrorRoot, 'active', 'profile', 'cordis.patch.yml'), 'insert:\n  - id: locked-x\n    disabled: false\n', 'utf8')
    fs.writeFileSync(path.join(root, 'overlay', 'cordis.patch.yml'), 'insert:\n  - id: locked-x\n    disabled: true\n', 'utf8')
    const metaFile = path.join(root, 'meta.json')
    fs.writeFileSync(metaFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(metaFile, 'utf8')), status: 'stale', lastMergedFingerprint: null }), 'utf8')
    // 真实失败：overlay 路径是文件 → loadOverlay ensureDir 抛错 → recomputeAll.failed
    const brokenRoot = path.join(layout.essenceRoot, 'essence-broken-test')
    fs.mkdirSync(brokenRoot, { recursive: true })
    fs.writeFileSync(path.join(brokenRoot, 'meta.json'), JSON.stringify({
      id: 'essence-broken-test', name: 'broken', tier: 'local', createdAt: 1, updatedAt: 1,
      status: 'stale', lastMergedFingerprint: null,
    }), 'utf8')
    fs.writeFileSync(path.join(brokenRoot, 'overlay'), 'not-a-directory', 'utf8')

    const out = await mirror.syncEssences({})
    assert.equal(out.ok, true)
    assert.ok(out.conflicted.includes(created.id), 'real conflict detected')
    assert.ok(out.failed.some((item) => item.id === 'essence-broken-test'), 'real failure detected')
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0].level, 'red', 'failed>0 => red')
    assert.match(String(submitted[0].title), /元主合并冲突/)
  } finally {
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: MirrorUpgrade failure/compat/throw map to decision tickets and stage events', async () => {
  const submitted = []
  const center = {
    list() { return { items: [], counts: {}, rev: 1 } },
    submit(spec) { submitted.push(spec); return { ok: true, ticket: { id: `dec_mirror_${submitted.length}` } } },
    ingest() { return { ok: true, ticket: { id: 'ext_x' } } },
  }
  const stages = []
  const onStage = (payload) => stages.push(payload)
  bus.on('fang/mirror-upgrade-stage', onStage)
  const original = MirrorManager.prototype.upgrade
  const { ctx, dataRoot } = await boot({ extraServices: { [SERVICE.decisionCenter]: center } })
  try {
    const mirror = ctx.get(SERVICE.mirror)

    // 1) 升级失败 → yellow ticket
    MirrorManager.prototype.upgrade = async ({ onProgress } = {}) => {
      onProgress?.('checking')
      onProgress?.('downloading')
      return { ok: false, from: '3.1.0', to: null, reason: 'download-failed', rolledBack: false }
    }
    const failed = await mirror.upgrade({})
    assert.equal(failed.ok, false)
    assert.ok(stages.some((item) => item.stage === 'checking'))
    assert.ok(stages.some((item) => item.stage === 'downloading'))
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0].level, 'yellow')
    assert.match(String(submitted[0].title), /镜像升级失败/)
    assert.equal(submitted[0].source.taskName, 'MirrorUpgrade')

    // 2) compat-gate-failed → yellow ticket
    MirrorManager.prototype.upgrade = async ({ onProgress } = {}) => {
      onProgress?.('done')
      return { ok: true, from: '3.1.0', to: '3.2.0', reason: 'compat-gate-failed', compat: { findings: [{ code: 'x' }, { code: 'y' }] } }
    }
    const compat = await mirror.upgrade({})
    assert.equal(compat.reason, 'compat-gate-failed')
    assert.equal(submitted.length, 2)
    assert.equal(submitted[1].level, 'yellow')
    assert.match(String(submitted[1].title), /兼容门禁未通过/)
    assert.match(String(submitted[1].context), /findings=2/)

    // 3) 升级抛错 → red ticket + rethrow
    MirrorManager.prototype.upgrade = async () => { throw new Error('boom-upgrade') }
    await assert.rejects(mirror.upgrade({}), /boom-upgrade/)
    assert.equal(submitted.length, 3)
    assert.equal(submitted[2].level, 'red')
    assert.match(String(submitted[2].context), /boom-upgrade/)
  } finally {
    MirrorManager.prototype.upgrade = original
    bus.off?.('fang/mirror-upgrade-stage', onStage)
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: EssenceManager conflicted/failed recompute raises a decision ticket', async () => {
  const submitted = []
  const center = {
    list() { return { items: [], counts: {}, rev: 1 } },
    submit(spec) { submitted.push(spec); return { ok: true, ticket: { id: 'dec_essence_1' } } },
    ingest() { return { ok: true, ticket: { id: 'ext_x' } } },
  }
  const original = EssenceManager.prototype.recomputeAll
  EssenceManager.prototype.recomputeAll = async () => ({ recomputed: 1, skipped: 0, conflicted: 2, failed: 1, aborted: false })
  const { ctx, dataRoot } = await boot({ extraServices: { [SERVICE.decisionCenter]: center } })
  try {
    const mirror = ctx.get(SERVICE.mirror)
    const out = await mirror.syncEssences({})
    assert.equal(out.ok, true)
    assert.equal(submitted.length, 1, 'conflicted/failed must produce exactly one ticket')
    const spec = submitted[0]
    assert.equal(spec.level, 'red', 'failed>0 => red')
    assert.equal(spec.actions[0].id, 'review')
    assert.match(String(spec.title), /元主合并冲突/)
    assert.equal(spec.source.taskName, 'EssenceManager')
  } finally {
    EssenceManager.prototype.recomputeAll = original
    cleanup(ctx, dataRoot)
  }
})

test('orchestrator: mirror upgrade failure raises a decision ticket instead of only logging', async () => {
  const submitted = []
  const center = {
    list() { return { items: [], counts: {}, rev: 1 } },
    submit(spec) { submitted.push(spec); return { ok: true, ticket: { id: 'dec_mirror_1' } } },
    ingest() { return { ok: true, ticket: { id: 'ext_x' } } },
  }
  const { ctx, svc, dataRoot } = await boot({ extraServices: { [SERVICE.decisionCenter]: center } })
  try {
    let out = null
    try {
      out = await ctx.get(SERVICE.mirror).upgrade({ autoBackup: false, autoRollback: false })
    } catch { /* 升级抛错也应先 ticket 再抛 */ }
    assert.ok(submitted.length >= 1, `upgrade failure/throw must produce a ticket (out=${JSON.stringify(out)})`)
    const spec = submitted[0]
    assert.match(String(spec.title), /升级/)
    assert.equal(spec.source?.roleTrusted, true)
    assert.equal(spec.source?.agentRole, 'system')
  } finally {
    cleanup(ctx, dataRoot)
  }
})
