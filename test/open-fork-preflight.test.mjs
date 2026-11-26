// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { makeCtx, makeWebServerStub, makeReq, makeRes, TEST_AUTH_TOKEN } from './helpers.mjs'
import { SERVICE } from '../src/kernel/index.mjs'
import * as orchestrator from '../src/plugins/orchestrator.mjs'

function makeFakeForker(port) {
  const live = new Set()
  let spawnCount = 0
  const calls = { spawn: [] }
  return {
    calls,
    clear() { live.clear() },
    async provision(args) {
      const profileDir = path.join(args.homeDir, 'profiles', args.profile)
      fs.mkdirSync(profileDir, { recursive: true })
      const src = String(args.profileTemplate || '')
      for (const name of ['package.json', 'cordis.patch.yml']) {
        try { if (src) fs.copyFileSync(path.join(src, name), path.join(profileDir, name)) } catch { /* optional */ }
      }
      if (!fs.existsSync(path.join(profileDir, 'package.json')) || !fs.existsSync(path.join(profileDir, 'cordis.patch.yml'))) {
        fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
          name: 'fork-test', private: true, type: 'module',
          dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@twinsearth/fang-dsh-plugin'] } },
          dependencies: { '@twinsearth/fang-dsh-plugin': '3.8.4' },
        }, null, 2))
        fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n')
      }
      fs.mkdirSync(path.join(profileDir, 'node_modules', '@twinsearth', 'fang-dsh-plugin'), { recursive: true })
      return { ok: true, homeDir: args.homeDir, profileDir }
    },
    async spawn(args) {
      calls.spawn.push(args)
      spawnCount += 1
      if (spawnCount > 1) throw new Error('spawn-boom')
      live.add(args.forkId)
      return {
        ok: true,
        pid: 6001,
        port,
        url: `http://127.0.0.1:${port}/?token=old`,
        token: 'old',
      }
    },
    async stop(forkId) { live.delete(forkId); return { ok: true, forkId, killed: true } },
    alive(forkId) { return live.has(forkId) },
    status(forkId) {
      return {
        running: live.has(forkId),
        pid: live.has(forkId) ? 6001 : null,
        port: live.has(forkId) ? port : null,
        url: live.has(forkId) ? `http://127.0.0.1:${port}/?token=old` : null,
      }
    },
    list() { return [] },
    logs() { return '' },
  }
}

function listenOnEphemeral() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

test('open-fork: stale pid + port owned by another process returns a step error, never handler-threw', async () => {
  const blocker = await listenOnEphemeral()
  const occupiedPort = blocker.address().port
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-open-preflight-'))
  const forker = makeFakeForker(occupiedPort)
  const webServer = makeWebServerStub()
  const ctx = makeCtx({ services: { [SERVICE.forker]: forker, webServer } })
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      adapterTimeoutMs: 100,
      adapterPollMs: 10,
      memoryGuard: false,
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const svc = ctx.get(SERVICE.orchestrator)
    // The open route calls these methods directly; they must live on the
    // orchestrator service, not on the separate mirror service object.
    for (const method of ['openManagedBrowser', 'closeManagedBrowser', 'probeMemory', 'safeModeStatus', 'resetSafeMode']) {
      assert.equal(typeof svc[method], 'function', `service.${method} must be callable`)
    }
    const created = await svc.createTask({ title: 'stale-open' })
    assert.equal(created.ok, true)
    assert.equal(created.ok, true)
    // Simulate the reported three-way conflict: task/fang-meta still say pid 6001
    // + the old port, but the process is gone and the port is now foreign.
    fs.writeFileSync(path.join(created.homeDir, 'fang-meta.json'), JSON.stringify({
      version: 1, status: 'running', pid: 6001, port: occupiedPort,
      url: `http://127.0.0.1:${occupiedPort}/?token=old`, profile: 'old-profile',
    }, null, 2), 'utf8')
    forker.clear()
    const route = webServer.find('POST', '/fang/api/tasks/open')
    assert.ok(route, 'open route must be registered')
    const res = makeRes()
    await route.handler(makeReq({ taskId: created.taskId }, 'POST'), res)
    const body = res.json()

    assert.notEqual(body.error, 'handler-threw', 'the unified catch must not hide the real step')
    assert.equal(body.step, 'spawn')
    assert.equal(body.error, 'spawn-threw')
    assert.match(String(body.detail), /spawn-boom/)

    const task = svc.listTasks().find((row) => row.taskId === created.taskId)
    assert.ok(task)
    assert.equal(task.port, null, 'stale foreign port must be cleared from the task')
    assert.equal(task.pid, null, 'stale pid must be cleared from the task')
    assert.equal(task.url, null)
    assert.equal(forker.calls.spawn.length, 2)
    assert.equal(forker.calls.spawn[1].port, undefined, 'restore must never ask for the occupied port')
    const meta = JSON.parse(fs.readFileSync(path.join(created.homeDir, 'fang-meta.json'), 'utf8'))
    assert.equal(meta.status, 'failed')
    assert.equal(meta.pid, null, 'fang-meta must not keep the dead pid')
    assert.equal(meta.port, null, 'fang-meta must not keep the foreign port')
    assert.equal(meta.url, null, 'fang-meta must not keep the mother URL')
  } finally {
    try { ctx.dispose() } catch { /* ignore */ }
    blocker.closeAllConnections?.()
    try { blocker.close() } catch { /* already closed */ }
    blocker.unref?.()
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('failed task with no port but stale fang-meta is repaired on listTasks', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-stale-meta-'))
  const forker = makeFakeForker(0)
  const webServer = makeWebServerStub()
  const ctx = makeCtx({ services: { [SERVICE.forker]: forker, webServer } })
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      memoryGuard: false,
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const svc = ctx.get(SERVICE.orchestrator)
    const created = await svc.createTask({ title: 'stale-meta-only' })
    assert.equal(created.ok, true)
    // Reported shape: task row is failed with pid/port null, while fang-meta still
    // claims it owns a now-foreign port.
    forker.clear()
    const metaFile = path.join(created.homeDir, 'fang-meta.json')
    fs.writeFileSync(metaFile, JSON.stringify({
      version: 1, status: 'running', pid: 19444, port: 18000,
      url: 'http://127.0.0.1:18000/?token=old', profile: 'old-profile',
    }, null, 2), 'utf8')
    const task = svc.listTasks().find((row) => row.taskId === created.taskId)
    assert.ok(task)
    assert.equal(task.status, 'failed')
    assert.equal(task.pid, null)
    assert.equal(task.port, null)
    assert.equal(task.url, null)
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
    assert.equal(meta.status, 'failed')
    assert.equal(meta.pid, null)
    assert.equal(meta.port, null)
    assert.equal(meta.url, null)
  } finally {
    try { ctx.dispose() } catch { /* ignore */ }
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('handler-threw response carries route, method, requestId and audit record', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-handler-threw-'))
  const webServer = makeWebServerStub()
  const ctx = makeCtx({ services: { webServer } })
  const events = []
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      memoryGuard: false,
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    ctx.on('fang/audit', (event) => events.push(event))
    const svc = ctx.get(SERVICE.orchestrator)
    svc.archiveTask = async () => { throw new Error('archive-route-boom') }
    const route = webServer.find('POST', '/fang/api/tasks/archive')
    assert.ok(route?.handler)
    const res = makeRes()
    await route.handler(makeReq({}, 'POST'), res)
    const body = res.json()
    assert.equal(res.statusCode, 500)
    assert.equal(body.error, 'handler-threw')
    assert.equal(body.route, '/fang/api/tasks/archive')
    assert.equal(body.method, 'POST')
    assert.match(String(body.requestId), /^req_/)
    assert.equal(body.detail, 'archive-route-boom')
    const audit = events.find((event) => event.kind === 'http-handler-threw')
    assert.ok(audit, 'handler failure must be audited')
    assert.equal(audit.data.route ?? audit.data.path, '/fang/api/tasks/archive')
    assert.equal(audit.data.method, 'POST')
    assert.equal(audit.data.requestId, body.requestId)
    assert.match(String(audit.data.stack), /archive-route-boom/)
  } finally {
    try { ctx.dispose() } catch { /* ignore */ }
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('stale task pid/port is cleared even when fang-meta already says stopped', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-stale-task-'))
  const forker = makeFakeForker(0)
  const webServer = makeWebServerStub()
  const ctx = makeCtx({ services: { [SERVICE.forker]: forker, webServer } })
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      memoryGuard: false,
      routes: { enabled: true, prefix: '/fang' },
      authToken: TEST_AUTH_TOKEN,
    })
    const svc = ctx.get(SERVICE.orchestrator)
    const created = await svc.createTask({ title: 'stale-task-only' })
    assert.equal(created.ok, true)
    forker.clear()
    const metaFile = path.join(created.homeDir, 'fang-meta.json')
    fs.writeFileSync(metaFile, JSON.stringify({
      version: 1, status: 'stopped', pid: null, port: null, url: null,
      profile: 'fang-stale-task-only',
    }, null, 2), 'utf8')
    const task = svc.listTasks().find((row) => row.taskId === created.taskId)
    assert.ok(task)
    assert.equal(task.pid, null)
    assert.equal(task.port, null)
    assert.equal(task.url, null)
    assert.equal(task.health.adapter, 'pending')
    const raw = JSON.parse(fs.readFileSync(path.join(dataRoot, 'tasks.json'), 'utf8'))
    const stored = (raw.forks ?? []).find((row) => row.taskId === created.taskId)
    assert.ok(stored)
    assert.equal(stored.pid, null, 'tasks.json must not keep the dead pid')
    assert.equal(stored.port, null, 'tasks.json must not keep the stale port')
    assert.equal(stored.url, null, 'tasks.json must not keep the stale url')
  } finally {
    try { ctx.dispose() } catch { /* ignore */ }
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
})
