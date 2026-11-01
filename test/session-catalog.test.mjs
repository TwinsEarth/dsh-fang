// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T10 — 母体只读会话目录插件单测（角色门禁 / 服务 / 3 条 HTTP 路由 / 只读性）。
// 全部 fixture 建在 mkdtemp 里（不写真实 $DSH_HOME）：zstd 现场压缩多帧 session 日志。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import {
  makeCtx, makeWebServerStub, makeReq, makeRes, tmpDir,
} from './helpers.mjs'
import { SERVICE, digestTree } from '../src/kernel/index.mjs'
import { encodeWorkspaceKey } from '../src/lib/session-format.mjs'
import * as sessionCatalog from '../src/plugins/session-catalog.mjs'

const SERVICE_KEY = SERVICE.sessionCatalog // 'fangSessionCatalog'

const WS_GPT = { id: 'ws-gpt', path: 'E:\\workspace', title: 'GPT' }
const WS_DSH = { id: 'ws-dsh', path: 'E:\\DSH', title: 'DSH' }
const UUID_A = '11111111-2222-4333-8444-555555555555'
const UUID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const UUID_C = 'cccccccc-dddd-4eee-8fff-000000000000'
const SESSION_A = `session-${UUID_A}`
const SESSION_B = UUID_B
const SESSION_C = `session-${UUID_C}`
const HEADER_TIME = 1793501043176

function headerLine(sessionId, extra = {}) {
  return JSON.stringify({
    type: 'session',
    version: 4,
    id: sessionId,
    createdAt: HEADER_TIME,
    cwd: 'E:\\workspace',
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
    ...extra,
  })
}

/** 造一个临时 $DSH_HOME（sessions/ + storages/workspace.json 由测试决定）。 */
function makeHome() {
  const home = tmpDir('fang-t10-cat-')
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
  fs.mkdirSync(path.join(home, 'storages'), { recursive: true })
  return home
}

function writeIndex(home, { workspaces = [], archived = [], pinned = [] } = {}) {
  const doc = {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      defaultWorkspaceId: workspaces[0]?.id ?? null,
      workspaceIds: workspaces.map((w) => w.id),
      archivedSessionIds: archived,
      pinnedSessionIds: pinned,
    },
    tables: {
      workspaces: Object.fromEntries(workspaces.map((w) => [w.id, {
        path: w.path, title: w.title, sessionIds: w.sessionIds ?? [],
        createdAt: '2026-10-16T05:35:00.313Z', updatedAt: '2026-11-01T02:44:03.199Z',
      }])),
    },
  }
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify(doc, null, 2))
}

/** 写一个多帧 zstd 会话日志；frames 数组里第一帧通常是 session 头。 */
function addSession(home, workspacePath, sessionId, frames, mtimeMs = 1000) {
  const file = path.join(home, 'sessions', encodeWorkspaceKey(workspacePath), sessionId, 'session.v4.jsonl.zstd')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.concat(frames.map((frame) => zlib.zstdCompressSync(Buffer.from(String(frame), 'utf8')))))
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs))
  return file
}

/** 在 env 指定的 $DSH_HOME 下 apply（同步段内改 env，之后恢复）。 */
function applyCatalog({ home, role = 'mother', config = {}, services = {}, webServer = true } = {}) {
  const childServices = { ...services }
  const ws = webServer ? makeWebServerStub() : null
  if (ws) childServices.webServer = ws
  const ctx = makeCtx({ services: childServices })
  const savedHome = process.env.DSH_HOME
  const savedRole = process.env.DSH_FANG_ROLE
  process.env.DSH_HOME = home
  delete process.env.DSH_FANG_ROLE
  if (role !== 'mother') process.env.DSH_FANG_ROLE = role
  let service
  try {
    service = sessionCatalog.apply(ctx, config)
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    if (savedRole === undefined) delete process.env.DSH_FANG_ROLE
    else process.env.DSH_FANG_ROLE = savedRole
  }
  return { ctx, ws, service }
}

function standardHome() {
  const home = makeHome()
  const base = 1793500000000
  writeIndex(home, { workspaces: [WS_GPT], archived: [SESSION_A], pinned: [SESSION_B] })
  addSession(home, WS_GPT.path, SESSION_A, [
    `${headerLine(SESSION_A)}\n`,
    `${JSON.stringify({ type: 'event', seq: 0, data: { text: 'older session' } })}\n`,
  ], base + 1000)
  addSession(home, WS_GPT.path, SESSION_B, [
    `${headerLine(SESSION_B, { agentPreset: 'coder' })}\n`,
    `${JSON.stringify({ type: 'event', seq: 0, data: { text: 'newer session' } })}\n`,
  ], base + 5000)
  // 未在 workspace.json 登记的工作区目录（本机 DSH 常见）：仍应可列出，但标 unknown
  addSession(home, WS_DSH.path, SESSION_C, [`${headerLine(SESSION_C, { cwd: 'E:\\DSH', agentPreset: 'standard' })}\n`], base + 3000)
  return home
}

function findHandler(ws, method, routePath) {
  const route = ws.find(method, routePath)
  assert.ok(route, `route ${method} ${routePath} must be registered`)
  return route.handler
}

function getReq(url) {
  const req = makeReq(undefined, 'GET')
  req.url = url
  return req
}

// ── 角色门禁与模块形状 ──────────────────────────────────────────────────────

test('roleGate: fork 角色下不注册服务/路由；mother 才注册', () => {
  const home = standardHome()
  try {
    const asFork = applyCatalog({ home, role: 'fork' })
    assert.equal(asFork.service, undefined, 'fork 下 apply 必须直接 return')
    assert.equal(asFork.ctx.get(SERVICE_KEY), undefined)
    assert.equal(asFork.ws.routes.length, 0)
    asFork.ctx.dispose()

    const asMother = applyCatalog({ home, role: 'mother' })
    assert.ok(asMother.service, 'mother 下必须注册 fangSessionCatalog')
    assert.equal(asMother.ctx.get(SERVICE_KEY), asMother.service)
    assert.equal(asMother.service.role, 'mother')
    assert.equal(asMother.service.readOnly, true)

    assert.equal(sessionCatalog.name, 'fang-session-catalog')
    assert.ok(Array.isArray(sessionCatalog.inject))
    assert.equal(typeof sessionCatalog.Config, 'function')
    const defaults = sessionCatalog.Config({})
    assert.equal(defaults.prefix, '/fang')
    assert.equal(defaults.limit, 50)
    assert.equal(defaults.maxFileBytes, 262144)
    assert.equal(defaults.previewMaxChars, 2048)
    assert.equal(defaults.allowArchived, true)
    asMother.ctx.dispose()
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('模块声明不 import forker/approver，也不含写盘调用', () => {
  const source = fs.readFileSync(new URL('../src/plugins/session-catalog.mjs', import.meta.url), 'utf8')
  assert.equal(/from\s+['"][^'"]*forker/.test(source), false, '不得 import forker')
  assert.equal(/from\s+['"][^"]*approver/.test(source), false, '不得 import approver')
  for (const writeCall of ['writeFileSync', 'writeFile(', 'mkdirSync', 'ensureDir', 'appendFileSync', 'copyFileSync', 'rmSync', 'unlinkSync']) {
    assert.equal(source.includes(writeCall), false, `只读插件不得出现 ${writeCall}`)
  }
  assert.ok(source.includes("roleGate('sessionCatalog'"))
})

// ── service：status / listSessions ──────────────────────────────────────────

test('status: 只读自述 + 工作区/会话计数 + 路径来自 DSH_HOME', () => {
  const home = standardHome()
  try {
    const { ctx, service } = applyCatalog({ home })
    const status = service.status()
    assert.equal(status.ok, true)
    assert.equal(status.readOnly, true)
    assert.equal(status.role, 'mother')
    assert.equal(status.sessionsRoot, path.join(home, 'sessions'))
    assert.equal(status.storagesRoot, path.join(home, 'storages'))
    assert.equal(status.workspaceIndexOk, true)
    assert.equal(status.workspaceIndex, path.join(home, 'storages', 'workspace.json'))
    assert.equal(status.counts.sessions, 3)
    assert.equal(status.counts.archived, 1)
    assert.equal(status.counts.pinned, 1)
    assert.equal(status.counts.workspaces, 1)
    assert.equal(status.counts.workspaceDirs, 2, '已登记 + 未登记的两个 workspace 目录')
    assert.deepEqual(status.degraded, [])
    ctx.dispose()
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('listSessions: 默认隐藏归档、按 updatedAt 倒序、带归档/置顶/工作区元数据', () => {
  const home = standardHome()
  try {
    const { ctx, service } = applyCatalog({ home })
    const out = service.listSessions()
    assert.equal(out.ok, true)
    assert.equal(out.total, 2, '默认不含 archived')
    assert.deepEqual(out.sessions.map((s) => s.sessionId), [SESSION_B, SESSION_C], 'updatedAt: B(5000) > C(3000)')
    const b = out.sessions[0]
    assert.equal(b.workspaceId, WS_GPT.id)
    assert.equal(b.workspaceKey, encodeWorkspaceKey(WS_GPT.path))
    assert.equal(b.workspacePath, WS_GPT.path)
    assert.equal(b.workspaceTitle, 'GPT')
    assert.equal(b.workspaceKnown, true)
    assert.equal(b.pinned, true)
    assert.equal(b.bytes > 0, true)
    assert.equal(typeof b.updatedAt, 'number')
    assert.match(b.updatedAtIso, /^20\d\d-/)

    const c = out.sessions[1]
    assert.equal(c.workspaceId, null, '未登记工作区 → workspaceId=null')
    assert.equal(c.workspaceKnown, false)
    assert.equal(c.workspaceKey, encodeWorkspaceKey(WS_DSH.path))

    const archived = service.listSessions({ includeArchived: true })
    assert.equal(archived.total, 3)
    assert.equal(archived.sessions.some((s) => s.sessionId === SESSION_A && s.archived), true)
    ctx.dispose()
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('listSessions: limit 夹紧 / allowArchived=false 政策 / workspaceId 三种过滤', () => {
  const home = standardHome()
  try {
    const { ctx, service } = applyCatalog({ home, config: { limit: 1, allowArchived: false } })
    const limited = service.listSessions()
    assert.equal(limited.returned, 1)
    assert.equal(limited.limit, 1)
    const clamped = service.listSessions({ limit: 999 })
    assert.equal(clamped.limit, 500, '上限 500')
    const hidden = service.listSessions({ includeArchived: true })
    assert.equal(hidden.total, 2, 'allowArchived=false 时即使请求也不列归档')

    const byId = service.listSessions({ workspaceId: WS_GPT.id })
    assert.equal(byId.total, 1)
    assert.equal(byId.sessions[0].sessionId, SESSION_B)
    const byKey = service.listSessions({ workspaceId: encodeWorkspaceKey(WS_GPT.path) })
    assert.equal(byKey.total, 1)
    const byPath = service.listSessions({ workspaceId: WS_GPT.path })
    assert.equal(byPath.total, 1)
    const none = service.listSessions({ workspaceId: 'E:\\nowhere' })
    assert.equal(none.total, 0)
    assert.equal(none.ok, true)
    ctx.dispose()
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('status/listSessions: sessions 根缺失（全新环境）= 正常空态，ok:true + degraded', () => {
  const home = makeHome()
  try {
    fs.rmSync(path.join(home, 'sessions'), { recursive: true, force: true })
    const { ctx, service } = applyCatalog({ home })
    const status = service.status()
    assert.equal(status.ok, true, '根缺失不是服务错误')
    assert.equal(status.readable, false)
    assert.equal(status.counts.sessions, 0)
    assert.ok(status.degraded.includes('sessions-root-missing'))

    const list = service.listSessions()
    assert.equal(list.ok, true)
    assert.equal(list.readable, false)
    assert.deepEqual(list.sessions, [])
    assert.equal(list.total, 0)
    assert.equal(list.returned, 0)
    assert.ok(list.degraded.includes('sessions-root-missing'))

    // 根缺失时按 id 读一个会话：不存在 → not-found（HTTP 404），不是 sessions-root-missing/409
    const missing = service.getSession('ffffffff-ffff-4fff-8fff-ffffffffffff')
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'not-found')
    assert.ok(missing.degraded.includes('sessions-root-missing'))
    ctx.dispose()
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('HTTP GET /sessions: 全新 $DSH_HOME（无 sessions 目录）→ 200 空态 + degraded（Lead e2e 回归）', async () => {
  const home = makeHome()
  try {
    fs.rmSync(path.join(home, 'sessions'), { recursive: true, force: true })
    const { ctx, ws } = applyCatalog({ home })
    const handler = findHandler(ws, 'GET', '/fang/api/sessions')
    const res = makeRes()
    await handler(getReq('/fang/api/sessions'), res)

    assert.equal(res.statusCode, 200, '全新环境不该 409')
    const body = res.json()
    assert.equal(body.ok, true)
    assert.deepEqual(body.sessions, [])
    assert.equal(body.total, 0)
    assert.ok(Array.isArray(body.degraded))
    assert.ok(body.degraded.includes('sessions-root-missing'))
    ctx.dispose()
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// ── service：getSession / readHead / digest ─────────────────────────────────

test('getSession: 元数据来自索引+stat，header 来自第一帧（不解第二帧）', () => {
  const home = standardHome()
  try {
    const { ctx, service } = applyCatalog({ home })
    const out = service.getSession(SESSION_B)
    assert.equal(out.ok, true)
    assert.equal(out.session.sessionId, SESSION_B)
    assert.equal(out.session.workspaceTitle, 'GPT')
    assert.equal(out.session.createdAt, HEADER_TIME)
    assert.equal(out.session.sessionVersion, 4)
    assert.equal(out.session.cwd, 'E:\\workspace')
    assert.equal(out.session.agentPreset, 'coder')
    assert.equal(out.session.header.type, 'session')
    assert.equal(out.session.head.lines, 1, '只解第一帧：header 单行')
    assert.ok(out.session.head.bytesRead > 0)
    assert.ok(out.session.bytes > 0)
    assert.equal(typeof out.session.logFile, 'string')
    ctx.dispose()
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('getSession/readHead: 路径元字符一律 400 语义拒绝，未知 id → not-found', () => {
  const home = standardHome()
  try {
    const { ctx, service } = applyCatalog({ home })
    for (const bad of ['../x', 'a/b', 'C:\\Windows', '\\\\server\\share', 'session-../../x', 'x'.repeat(80), '']) {
      const out = service.getSession(bad)
      assert.equal(out.ok, false, `必须拒绝 ${bad}`)
      assert.equal(out.code, 'invalid-session-id')
      const head = service.readHead(bad)
      assert.equal(head.ok, false)
      assert.equal(head.code, 'invalid-session-id')
    }
    const missing = service.getSession('ffffffff-ffff-4fff-8fff-ffffffffffff')
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'not-found')
    ctx.dispose()
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('readHead: 只解第一帧、逐行脱敏、可配 lines 上限', () => {
  const home = makeHome()
  try {
    writeIndex(home, { workspaces: [WS_GPT] })
    const secret = 'sk-supersecret-1234567890'
    const firstFrame = [
      headerLine(SESSION_A),
      JSON.stringify({ type: 'event', seq: 1, data: { url: 'http://x/?token=topsecret123', path: 'E:\\work\\secret.txt', mail: 'dev@example.com' } }),
      JSON.stringify({ type: 'event', seq: 2, data: { api_key: secret } }),
    ].join('\n') + '\n'
    const frames = [firstFrame, `${JSON.stringify({ type: 'event', seq: 3, data: { text: 'second frame' } })}\n`]
    addSession(home, WS_GPT.path, SESSION_A, frames, 1793500001000)
    const { ctx, service } = applyCatalog({ home })

    const head = service.readHead(SESSION_A)
    assert.equal(head.ok, true)
    assert.ok(head.lines.length >= 2)
    const joined = head.lines.join('\n')
    assert.equal(head.lines.some((l) => l.includes('topsecret123')), false, 'token 不得泄漏')
    assert.equal(joined.includes('dev@example.com'), false, '邮箱不得泄漏')
    assert.equal(joined.includes('E:\\work\\secret.txt'), false, '绝对路径不得泄漏')
    assert.ok(head.redactions >= 3, `应有多次脱敏，实际 ${head.redactions}`)
    assert.ok(head.bytesRead > 0)
    assert.ok(head.degraded.includes('first-frame-only'), '多帧日志必须如实标记只读第一帧')

    const capped = service.readHead(SESSION_A, { maxLines: 1 })
    assert.equal(capped.lines.length, 1)
    assert.ok(capped.degraded.includes('line-limit'))
    ctx.dispose()
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('digest: ≤32KiB markdown（含脱敏预览）；超限 halt 不静默截断', () => {
  const home = makeHome()
  try {
    writeIndex(home, { workspaces: [WS_GPT] })
    const digestFrame = [
      headerLine(SESSION_A),
      JSON.stringify({ type: 'event', note: 'hello', token: 'digest-secret-xyz' }),
    ].join('\n') + '\n'
    addSession(home, WS_GPT.path, SESSION_A, [digestFrame, '{"type":"event","seq":9}\n'], 1793500001000)
    const { ctx, service } = applyCatalog({ home, config: { previewMaxChars: 2000 } })
    const out = service.digest(SESSION_A)
    assert.equal(out.ok, true)
    assert.equal(typeof out.digest, 'string')
    assert.ok(out.bytes > 0 && out.bytes <= 32 * 1024)
    assert.equal(out.limit, 32 * 1024)
    assert.ok(out.digest.includes(`# 会话 ${SESSION_A}`))
    assert.ok(out.digest.includes('工作区: GPT'))
    assert.ok(out.digest.includes('agentPreset: standard'))
    assert.equal(out.digest.includes('digest-secret-xyz'), false, 'digest 必须脱敏')
    assert.ok(out.digest.includes('<redacted>'))
    assert.equal(out.markdown, out.digest, 'orchestrator.derive() 读的是 digest.markdown')
    ctx.dispose()

    // 超限：previewMaxChars 放大 + 第一帧解出 ~50KB，markdown > 32KiB → halt
    const big = makeHome()
    try {
      writeIndex(big, { workspaces: [WS_GPT] })
      const hugeLine = JSON.stringify({ type: 'event', data: { text: 'a'.repeat(50000) } })
      addSession(big, WS_GPT.path, SESSION_A, [`${headerLine(SESSION_A)}\n${hugeLine}\n`, '{"type":"event","seq":9}\n'], 1793500001000)
      const bigCtx = applyCatalog({ home: big, config: { previewMaxChars: 60000 } })
      const tooLarge = bigCtx.service.digest(SESSION_A)
      assert.equal(tooLarge.ok, false)
      assert.equal(tooLarge.code, 'digest-too-large')
      assert.ok(tooLarge.bytes > 32 * 1024)
      assert.equal(tooLarge.limit, 32 * 1024)
      assert.equal(tooLarge.digest, undefined, '不得返回被截断的 digest')
      bigCtx.ctx.dispose()
    } finally {
      fs.rmSync(big, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// ── HTTP 路由 ───────────────────────────────────────────────────────────────

test('HTTP: 3 条 exact 路由 + 自定义 prefix', () => {
  const home = standardHome()
  try {
    const { ctx, ws, service } = applyCatalog({ home })
    assert.deepEqual(ws.paths(), [
      '/fang/api/sessions',
      '/fang/api/sessions/item',
      '/fang/api/sessions/head',
    ])
    assert.deepEqual(service.routes, ws.paths())
    for (const route of ws.routes) assert.equal(route.kind, 'exact')
    ctx.dispose()

    const custom = applyCatalog({ home, config: { prefix: '/x/' } })
    assert.deepEqual(custom.ws.paths(), [
      '/x/api/sessions',
      '/x/api/sessions/item',
      '/x/api/sessions/head',
    ])
    custom.ctx.dispose()
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('HTTP GET /sessions: 200 列表 / includeArchived / limit / workspaceId', async () => {
  const home = standardHome()
  try {
    const { ctx, ws } = applyCatalog({ home })
    const handler = findHandler(ws, 'GET', '/fang/api/sessions')

    const res = makeRes()
    await handler(getReq('/fang/api/sessions'), res)
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.equal(body.sessions.length, 2)
    assert.equal(body.includeArchived, false)

    const archivedRes = makeRes()
    await handler(getReq('/fang/api/sessions?includeArchived=1'), archivedRes)
    assert.equal(archivedRes.json().sessions.length, 3)

    const limitedRes = makeRes()
    await handler(getReq('/fang/api/sessions?limit=1'), limitedRes)
    assert.equal(limitedRes.json().returned, 1)
    assert.equal(limitedRes.json().limit, 1)

    const wsRes = makeRes()
    await handler(getReq(`/fang/api/sessions?workspaceId=${encodeURIComponent(WS_GPT.path)}`), wsRes)
    assert.equal(wsRes.json().sessions.length, 1)
    assert.equal(wsRes.json().sessions[0].sessionId, SESSION_B)
    ctx.dispose()
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('HTTP 405 / 400 / 404（以及根缺失的 200 空态）', async () => {
  const home = standardHome()
  try {
    const { ctx, ws } = applyCatalog({ home })

    const listHandler = findHandler(ws, 'GET', '/fang/api/sessions')
    const methodRes = makeRes()
    await listHandler(makeReq({}, 'POST'), methodRes)
    assert.equal(methodRes.statusCode, 405)
    assert.equal(methodRes.json().code, 'method-not-allowed')

    const itemHandler = findHandler(ws, 'GET', '/fang/api/sessions/item')
    const itemRes = makeRes()
    await itemHandler(getReq(`/fang/api/sessions/item?sessionId=${SESSION_B}`), itemRes)
    assert.equal(itemRes.statusCode, 200)
    assert.equal(itemRes.json().session.sessionId, SESSION_B)

    const missingId = makeRes()
    await itemHandler(getReq('/fang/api/sessions/item'), missingId)
    assert.equal(missingId.statusCode, 400)
    assert.equal(missingId.json().code, 'invalid-session-id')

    const traversal = makeRes()
    await itemHandler(getReq(`/fang/api/sessions/item?sessionId=${encodeURIComponent('../x')}`), traversal)
    assert.equal(traversal.statusCode, 400)
    assert.equal(traversal.json().code, 'invalid-session-id')
    assert.equal(traversal.json().session, undefined)

    const notFound = makeRes()
    await itemHandler(getReq('/fang/api/sessions/item?sessionId=ffffffff-ffff-4fff-8fff-ffffffffffff'), notFound)
    assert.equal(notFound.statusCode, 404)
    assert.equal(notFound.json().code, 'not-found')

    const headHandler = findHandler(ws, 'GET', '/fang/api/sessions/head')
    const headRes = makeRes()
    await headHandler(getReq(`/fang/api/sessions/head?sessionId=${SESSION_B}&lines=1`), headRes)
    assert.equal(headRes.statusCode, 200)
    assert.equal(headRes.json().sessionId, SESSION_B)
    assert.equal(headRes.json().lines.length, 1)

    const headBad = makeRes()
    await headHandler(getReq('/fang/api/sessions/head'), headBad)
    assert.equal(headBad.statusCode, 400)

    // 根缺失 = 200 空态（不是 409，也不是 500）
    fs.rmSync(path.join(home, 'sessions'), { recursive: true, force: true })
    const degraded = makeRes()
    await listHandler(getReq('/fang/api/sessions'), degraded)
    assert.equal(degraded.statusCode, 200)
    assert.equal(degraded.json().ok, true)
    assert.deepEqual(degraded.json().sessions, [])
    assert.ok(degraded.json().degraded.includes('sessions-root-missing'))
    ctx.dispose()
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// ── 只读性与审计 ────────────────────────────────────────────────────────────

test('只读：apply + 全部读取前后，$DSH_HOME 目录 digest 不变、无新文件', async () => {
  const home = standardHome()
  try {
    const before = digestTree(home)
    const beforeWorkspaceJson = fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8')
    const { ctx, ws, service } = applyCatalog({ home })

    service.status()
    service.listSessions({ includeArchived: true })
    service.getSession(SESSION_B)
    service.readHead(SESSION_A)
    service.digest(SESSION_B)
    const handler = findHandler(ws, 'GET', '/fang/api/sessions')
    await handler(getReq('/fang/api/sessions'), makeRes())
    await findHandler(ws, 'GET', '/fang/api/sessions/item')(getReq(`/fang/api/sessions/item?sessionId=${SESSION_A}`), makeRes())
    await findHandler(ws, 'GET', '/fang/api/sessions/head')(getReq(`/fang/api/sessions/head?sessionId=${SESSION_B}`), makeRes())

    const after = digestTree(home)
    assert.deepEqual(after, before, '只读插件不得改动 $DSH_HOME 内任何文件')
    assert.equal(fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'), beforeWorkspaceJson)
    ctx.dispose()
    assert.deepEqual(digestTree(home), before, 'dispose 也不得写盘')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('审计：session-listed/session-read 走 SERVICE.auditor 且缺失时静默容错', () => {
  const home = standardHome()
  try {
    const appended = []
    const auditor = { append(kind, data) { appended.push({ kind, data }) } }
    const { ctx, service } = applyCatalog({ home, services: { [SERVICE.auditor]: auditor } })

    service.listSessions()
    service.getSession(SESSION_B)
    service.readHead(SESSION_B)
    service.digest(SESSION_B)
    // digest = getSession + readHead 两条读审计；加上前面 3 条读 → 共 5 条 session-read
    assert.deepEqual(appended.map((a) => a.kind), [
      'session-listed', 'session-read', 'session-read', 'session-read', 'session-read', 'session-read',
    ])
    assert.equal(appended[0].data.count, 2)
    assert.equal(appended[1].data.op, 'get')
    assert.equal(appended[2].data.op, 'head')
    // digest 内部先 getSession 再 readHead，最后自己记 op:'digest'
    assert.equal(appended[3].data.op, 'get')
    assert.equal(appended[4].data.op, 'head')
    assert.equal(appended[5].data.op, 'digest')
    ctx.dispose()

    const noAuditor = applyCatalog({ home })
    assert.equal(noAuditor.service.listSessions().ok, true, 'auditor 缺失不得影响只读目录')
    assert.equal(noAuditor.service.getSession(SESSION_B).ok, true)
    noAuditor.ctx.dispose()
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('无 webServer 时 service 仍可用、routes 为空；dispose 释放服务', () => {
  const home = standardHome()
  try {
    const { ctx, service } = applyCatalog({ home, webServer: false })
    assert.ok(service)
    assert.deepEqual(service.routes, [])
    assert.equal(service.status().ok, true)
    assert.equal(ctx.get(SERVICE_KEY), service)
    ctx.dispose()
    assert.equal(ctx.get(SERVICE_KEY), undefined)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('workspace.json 缺失时：仍列出目录（unknown workspace），degraded 标记 index-not-found', () => {
  const home = makeHome()
  try {
    addSession(home, WS_GPT.path, SESSION_A, [`${headerLine(SESSION_A)}\n`], 1000)
    const { ctx, service } = applyCatalog({ home })
    const out = service.listSessions()
    assert.equal(out.ok, true)
    assert.equal(out.sessions.length, 1)
    assert.equal(out.sessions[0].workspaceId, null)
    assert.equal(out.sessions[0].workspaceKnown, false)
    assert.ok(out.degraded.includes('index-not-found'))
    assert.ok(service.status().degraded.includes('index-not-found'))
    ctx.dispose()
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('listSessions exposes native session titles from session/title events (with source + preview)', () => {
  const home = makeHome()
  try {
    writeIndex(home, { workspaces: [WS_GPT], archived: [], pinned: [] })
    addSession(home, WS_GPT.path, SESSION_B, [
      `${headerLine(SESSION_B)}\n`,
      `${JSON.stringify({ type: 'session/title', seq: 5, data: { title: '瓮城 UI 入口设计' } })}\n`,
      `${JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: '设计左侧导航' }] } })}\n`,
    ], 2000)
    const { ctx, service } = applyCatalog({ home })
    const list = service.listSessions()
    assert.equal(list.ok, true)
    assert.equal(list.sessions.length, 1)
    assert.equal(list.sessions[0].title, '瓮城 UI 入口设计')
    assert.equal(list.sessions[0].titleSource, 'session/title')
    assert.match(list.sessions[0].preview, /设计左侧导航/)
    // 再次读取走 mtime 缓存，标题保持一致
    assert.equal(service.listSessions().sessions[0].title, '瓮城 UI 入口设计')
    ctx.dispose()
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('listSessions falls back to the workspace title when the log has no title or user message', () => {
  const home = makeHome()
  try {
    writeIndex(home, { workspaces: [WS_GPT], archived: [], pinned: [] })
    addSession(home, WS_GPT.path, SESSION_A, [`${headerLine(SESSION_A)}\n`], 3000)
    const { ctx, service } = applyCatalog({ home })
    const item = service.listSessions().sessions[0]
    assert.equal(item.titleSource, 'workspace')
    assert.equal(item.title, 'GPT')
    ctx.dispose()
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('listSessions exposes the real createdAt from the session header, not the file mtime', () => {
  const home = makeHome()
  try {
    writeIndex(home, { workspaces: [WS_GPT], archived: [], pinned: [] })
    const file = addSession(home, WS_GPT.path, SESSION_B, [`${headerLine(SESSION_B)}\n`,
      `${JSON.stringify({ type: 'session/title', seq: 2, data: { title: '真实标题' } })}\n`,
      `${JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: '真实问题' }] } })}\n`,
    ], 999999999)
    const { ctx, service } = applyCatalog({ home })
    const item = service.listSessions().sessions[0]
    assert.equal(item.title, '真实标题')
    assert.equal(item.createdAt, HEADER_TIME, 'createdAt comes from the session header')
    assert.notEqual(item.createdAt, fs.statSync(file).mtimeMs, 'not the file mtime')
    assert.equal(item.empty, false)
    assert.equal(item.userMessages, 1)
    ctx.dispose()
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('seed() extracts the bounded transcript and refuses empty sessions', () => {
  const home = makeHome()
  try {
    writeIndex(home, { workspaces: [WS_GPT], archived: [], pinned: [] })
    addSession(home, WS_GPT.path, SESSION_A, [
      `${headerLine(SESSION_A)}\n`,
      `${JSON.stringify({ type: 'session/title', seq: 1, data: { title: '交接标题' } })}\n`,
      `${JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: '用户第一问' }] } })}\n`,
      `${JSON.stringify({ type: 'assistant/message', data: { content: [{ type: 'text', text: '助手第一答' }] } })}\n`,
    ], 5000)
    addSession(home, WS_GPT.path, SESSION_B, [`${headerLine(SESSION_B)}\n`], 6000)
    const { ctx, service } = applyCatalog({ home })
    const seeded = service.seed(SESSION_A)
    assert.equal(seeded.ok, true, JSON.stringify(seeded))
    assert.match(seeded.markdown, /# 会话交接：交接标题/)
    assert.match(seeded.markdown, /用户第一问/)
    assert.match(seeded.markdown, /助手第一答/)
    assert.equal(seeded.sourceFile, service.seed(SESSION_A).sourceFile, 'source file is stable')
    const empty = service.seed(SESSION_B)
    assert.equal(empty.ok, false)
    assert.equal(empty.code, 'session-empty')
    ctx.dispose()
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
