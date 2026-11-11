// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T5 — Adapter（分身侧跨进程桥）单测（契约：docs/CONTRACTS-V2.md §1/§5.1、PROTOCOL-V2.md §3）。
//
// 覆盖：角色门禁（mother 不注册服务/路由，fork 才注册）、模块形状、5 条 exact 路由与
// Config.prefix、HTTP 方法校验 405 / 400 / 409、GET status/approvals/audit、POST command、
// 9 条命令的全部降级分支、read-plugin 的路径逃逸/二进制/单文件与总量上限、
// route-confirm 自动补 assessment、archive flush+审计+事件、命令超时。
// 不 spawn 真实进程、不开真实 socket：HTTP 处理器直接调用 `webServer.find(...).handler`。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'

import { makeCtx, makeWebServerStub, makeReq, makeRes, tmpDir } from './helpers.mjs'
import {
  SERVICE, ADAPTER_OP, ADAPTER_ROUTE, AUDIT, FANG_VERSION, ADAPTER_PROTOCOL_VERSION,
} from '../src/kernel/index.mjs'
import * as adapterModule from '../src/plugins/adapter.mjs'

const ADAPTER_SERVICE = SERVICE.adapter // 'fangAdapter'
const PREFIX = '/fang'
const routePath = (suffix) => `${PREFIX}${suffix}`

const ENV_KEYS = ['DSH_FANG_ROLE', 'DSH_FANG_TASK_ID', 'DSH_FANG_FORK_ID', 'DSH_FANG_FORK', 'FANG_TASK_ID']

/** 临时改 env 执行 fn（同步段内），结束后恢复，避免污染同进程其它测试。 */
function withEnv(patch, fn) {
  const saved = {}
  for (const key of Object.keys(patch)) {
    saved[key] = process.env[key]
    if (patch[key] === undefined) delete process.env[key]
    else process.env[key] = patch[key]
  }
  try {
    return fn()
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

/** 按角色 apply（env 优先于任何配置），返回 {ctx, ws, service}。 */
function applyWithRole(role, config = {}, services = {}, { webServer = true, env = {} } = {}) {
  const childServices = { ...services }
  const ws = webServer ? makeWebServerStub() : null
  if (ws) childServices.webServer = ws
  const ctx = makeCtx({ services: childServices })
  const patch = { DSH_FANG_ROLE: role, ...env }
  const service = withEnv(patch, () => adapterModule.apply(ctx, config))
  return { ctx, ws, service }
}

const applyAsFork = (config = {}, services = {}, opts = {}) => applyWithRole('fork', { allowLegacyNoToken: true, ...config }, services, opts)

// ── 服务桩（形状对齐 kernel SERVICE 的真实实现）──────────────────────────────

function makeBuffer({ dir = '', flushResult = { state: 'settled', flushed: ['a.js'], timedOut: false }, flushImpl = null, stateResult = null } = {}) {
  const calls = { flush: [] }
  return {
    calls,
    get dir() { return dir },
    state() {
      if (stateResult) return stateResult
      return { state: 'settled', dir, pending: [], mode: 'watch' }
    },
    async flush(opts = {}) {
      calls.flush.push(opts)
      if (flushImpl) return flushImpl(opts)
      return typeof flushResult === 'function' ? flushResult(opts) : flushResult
    },
  }
}

function makeApprover({ items = [], decide = null } = {}) {
  const calls = { decide: [], pending: 0 }
  return {
    calls,
    pending() {
      calls.pending += 1
      return items.map((item) => ({ ...item }))
    },
    decide(id, outcome, options) {
      calls.decide.push({ id, outcome, options })
      if (decide) return decide(id, outcome, options)
      return { ok: true, id, outcome, by: options?.by ?? 'api', at: 'T0' }
    },
  }
}

function makeAuditor(records = []) {
  const calls = { append: [], read: [] }
  return {
    calls,
    append(kind, data) {
      calls.append.push({ kind, data })
      return { kind, seq: calls.append.length }
    },
    read(opts = {}) {
      calls.read.push(opts)
      const limit = opts.limit === undefined ? 100 : Number(opts.limit)
      if (limit <= 0) return []
      return records.slice(-limit)
    },
  }
}

function makeScorer(factory = (dir) => ({ grade: 'B', S: 30, color: 'blue', veto: false, reasons: [], signals: [] })) {
  const calls = { scoreDir: [] }
  return {
    calls,
    scoreDir(dir, manifest, opts) {
      calls.scoreDir.push({ dir, manifest, opts })
      return { ...factory(dir), dir }
    },
  }
}

function makeRouter(confirm = (input) => ({ route: input?.decision?.route ?? 'sandbox', escalated: true })) {
  const calls = { confirm: [] }
  return {
    calls,
    confirm(input) {
      calls.confirm.push(input)
      return confirm(input)
    },
  }
}

function makeAllServices({ dir = '', auditorRecords = [] } = {}) {
  return {
    [SERVICE.buffer]: makeBuffer({ dir }),
    [SERVICE.approver]: makeApprover({ items: [{ id: 'a1' }, { id: 'a2' }] }),
    [SERVICE.auditor]: makeAuditor(auditorRecords),
    [SERVICE.scorer]: makeScorer(),
    [SERVICE.umbrella]: { decideAction: () => ({ decision: 'ask' }), assessAction: () => ({ light: 'yellow' }) },
    [SERVICE.router]: makeRouter(),
    [SERVICE.healer]: { gates: () => ({ pass: true, gates: [] }) },
    [SERVICE.hotReloader]: { swap: async () => ({ ok: true }) },
  }
}

function writePlugin(root, pluginId, files) {
  const dir = path.join(root, pluginId)
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  return dir
}

function findHandler(ws, method, suffix) {
  const route = ws.find(method, routePath(suffix))
  assert.ok(route, `route ${method} ${routePath(suffix)} must be registered`)
  return route.handler
}

/** 发一个"原始 body"的请求（用于非法 JSON/超大 body 分支）。 */
function makeRawReq(rawBody, method = 'POST', url = undefined) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.destroy = () => {}
  process.nextTick(() => {
    req.emit('data', Buffer.from(rawBody))
    req.emit('end')
  })
  return req
}

function getReq(url = undefined) {
  const req = makeReq(undefined, 'GET')
  req.url = url
  return req
}

/** SSE 用的假响应：记录 writeHead/write/end，close 事件由测试手动 emit 或 ctx.dispose 触发。 */
function makeSseRes() {
  const res = new EventEmitter()
  res.statusCode = 0
  res.headers = {}
  res.chunks = []
  res.writableEnded = false
  res.headersSent = false
  res.writeHead = (code, headers) => {
    res.statusCode = code
    res.headersSent = true
    Object.assign(res.headers, headers ?? {})
  }
  res.write = (chunk) => {
    res.chunks.push(String(chunk))
    return true
  }
  res.end = (chunk) => {
    if (chunk !== undefined && chunk !== null) res.chunks.push(String(chunk))
    res.writableEnded = true
  }
  res.body = () => res.chunks.join('')
  res.json = () => {
    try {
      return JSON.parse(res.body())
    } catch {
      return null
    }
  }
  return res
}

// ── 角色门禁与形状 ───────────────────────────────────────────────────────────

test('roleGate: mother 角色下不注册服务、不注册路由（apply 直接 return）', () => {
  const ws = makeWebServerStub()
  const ctx = makeCtx({ services: { webServer: ws } })
  withEnv({ DSH_FANG_ROLE: undefined, DSH_FANG_TASK_ID: undefined }, () => {
    const returned = adapterModule.apply(ctx, {})
    assert.equal(returned, undefined, 'mother 下 apply 必须直接返回')
  })
  assert.equal(ctx.get(ADAPTER_SERVICE), undefined, 'mother 下不得提供 fangAdapter 服务')
  assert.equal(ws.routes.length, 0, 'mother 下不得注册任何路由')
  ctx.dispose()
})

test('fork 角色: 服务/路由/形状符合 CONTRACTS-V2 §5.1', () => {
  const { ctx, ws, service } = applyAsFork({ taskId: 'task_shape' })
  assert.ok(service, 'fork 下必须注册 fangAdapter')
  assert.equal(ctx.get(ADAPTER_SERVICE), service)
  assert.equal(service.role, 'fork')
  assert.equal(service.taskId, 'task_shape')
  for (const method of [
    'hello', 'status', 'approvals', 'audit', 'command',
    'commands', 'versionInfo', 'health', 'state', 'eventsSince', 'lastCursor',
  ]) {
    assert.equal(typeof service[method], 'function', `service.${method} 必须是函数`)
  }
  assert.equal(service.protocol, ADAPTER_PROTOCOL_VERSION)
  assert.match(service.sessionId, /^s-[0-9a-f]{16}$/, '每次进程启动一个 sessionId')

  assert.deepEqual(ws.paths(), [
    routePath(ADAPTER_ROUTE.IDENTITY),
    routePath(ADAPTER_ROUTE.CLIENT_REPORT),
    routePath(ADAPTER_ROUTE.HELLO),
    routePath(ADAPTER_ROUTE.STATUS),
    routePath(ADAPTER_ROUTE.APPROVALS),
    routePath(ADAPTER_ROUTE.AUDIT),
    routePath(ADAPTER_ROUTE.COMMAND),
    routePath(ADAPTER_ROUTE.VERSION),
    routePath(ADAPTER_ROUTE.HEALTH),
    routePath(ADAPTER_ROUTE.STATE),
    routePath(ADAPTER_ROUTE.COMMANDS),
    routePath(ADAPTER_ROUTE.EVENTS),
  ], '12 条路由 = identity + client-report + v2 五条 + v3 五条，顺序与 ADAPTER_ROUTE 常量一致')
  assert.deepEqual(service.routes, ws.paths(), 'service.routes 暴露已注册路径（测试用）')
  for (const route of ws.routes) assert.equal(route.kind, 'exact')

  assert.equal(adapterModule.name, 'fang-adapter')
  assert.ok(Array.isArray(adapterModule.inject))
  assert.equal(typeof adapterModule.Config, 'function')
  const defaults = adapterModule.Config({})
  assert.equal(defaults.prefix, '/fang')
  assert.equal(defaults.taskId, '')
  assert.equal(defaults.auditLimit, 500)
  assert.equal(defaults.commandTimeoutMs, 10000)
  assert.equal(defaults.token, '')
  assert.equal(defaults.eventCapacity, 1000)
  assert.equal(defaults.commandCacheSize, 500)
  assert.equal(defaults.heartbeatMs, 5000)
  assert.equal(adapterModule._internals.MAX_FILE_BYTES, 1024 * 1024)
  assert.equal(adapterModule._internals.MAX_TOTAL_BYTES, 2 * 1024 * 1024)
  assert.equal(adapterModule._internals.ADAPTER_PROTOCOL_VERSION, ADAPTER_PROTOCOL_VERSION)
  ctx.dispose()
})

test('hello(): role/taskId/version/capabilities；taskId 取 environ / 配置优先', async () => {
  const fromConfig = applyAsFork({ taskId: 'task_cfg' })
  const hello = fromConfig.service.hello()
  assert.equal(hello.ok, true)
  assert.equal(hello.role, 'fork')
  assert.equal(hello.taskId, 'task_cfg')
  assert.equal(hello.version, FANG_VERSION)
  assert.ok(Array.isArray(hello.capabilities))
  for (const op of Object.values(ADAPTER_OP)) assert.ok(hello.capabilities.includes(op), `capabilities 应含 ${op}`)
  fromConfig.ctx.dispose()

  const fromEnv = applyAsFork({}, {}, { env: { DSH_FANG_TASK_ID: 'task_env' } })
  assert.equal(fromEnv.service.taskId, 'task_env', '缺省取 env DSH_FANG_TASK_ID')
  assert.equal(fromEnv.service.hello().taskId, 'task_env')
  fromEnv.ctx.dispose()

  const configWins = applyAsFork({ taskId: 'task_cfg2' }, {}, { env: { DSH_FANG_TASK_ID: 'task_env2' } })
  assert.equal(configWins.service.taskId, 'task_cfg2', '显式配置优先于环境变量')
  configWins.ctx.dispose()
})

test('Config.prefix 生效（与母体 Remote.prefix 对齐）', () => {
  const { ctx, ws } = applyAsFork({ prefix: '/x/' })
  assert.deepEqual(ws.paths(), [
    '/x/adapter/identity', '/x/adapter/client-report', '/x/adapter/hello', '/x/adapter/status', '/x/adapter/approvals', '/x/adapter/audit', '/x/adapter/command',
    '/x/adapter/version', '/x/adapter/health', '/x/adapter/state', '/x/adapter/commands', '/x/adapter/events',
  ])
  ctx.dispose()
})

test('webServer 缺失时 service 仍可用，routes 为空（不抛）', () => {
  const { ctx, service } = applyAsFork({}, {}, { webServer: false })
  assert.ok(service)
  assert.deepEqual(service.routes, [])
  assert.equal(service.hello().ok, true)
  ctx.dispose()
})

test('dispose 后服务被释放', () => {
  const { ctx } = applyAsFork({})
  assert.ok(ctx.get(ADAPTER_SERVICE))
  ctx.dispose()
  assert.equal(ctx.get(ADAPTER_SERVICE), undefined)
})

// ── HTTP 层：方法校验 / GET / POST ───────────────────────────────────────────

test('HTTP 方法错误 → 405（GET 路由收到 POST、POST 路由收到 GET）', async () => {
  const { ctx, ws } = applyAsFork({})
  const helloHandler = findHandler(ws, 'GET', ADAPTER_ROUTE.HELLO)
  const res = makeRes()
  await helloHandler(makeReq(undefined, 'POST'), res)
  assert.equal(res.statusCode, 405)
  assert.equal(res.json().ok, false)
  assert.equal(res.json().code, 'method-not-allowed')
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')

  const commandHandler = findHandler(ws, 'POST', ADAPTER_ROUTE.COMMAND)
  const res2 = makeRes()
  await commandHandler(makeReq(undefined, 'GET'), res2)
  assert.equal(res2.statusCode, 405)
  assert.equal(res2.json().code, 'method-not-allowed')
  ctx.dispose()
})

test('HTTP GET status: 200 + 服务表/缓冲三态/待批数/审计头', async () => {
  const root = tmpDir('fang-t5-status-')
  try {
    const services = makeAllServices({ dir: root, auditorRecords: [{ kind: 'boot', seq: 1, hash: 'h1' }, { kind: 'route', seq: 2, hash: 'h2' }] })
    const { ctx, ws, service } = applyAsFork({ taskId: 'task_http' }, services)
    await service.command({ op: ADAPTER_OP.PING }) // 让 uptime 有一点跨度

    const handler = findHandler(ws, 'GET', ADAPTER_ROUTE.STATUS)
    const res = makeRes()
    await handler(getReq(routePath(ADAPTER_ROUTE.STATUS)), res)

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.equal(body.role, 'fork')
    assert.equal(body.taskId, 'task_http')
    for (const key of ['scorer', 'umbrella', 'router', 'healer', 'approver', 'hotReloader', 'buffer', 'auditor', 'adapter']) {
      assert.equal(body.services[key], true, `services.${key} 应为 true`)
    }
    assert.equal(body.services.adapter, true)
    assert.equal(body.buffer.state, 'settled')
    assert.deepEqual(body.buffer.pending, [])
    assert.equal(body.buffer.dir, root)
    assert.equal(body.approvals.pending, 2)
    assert.equal(body.audit.records, 2)
    assert.equal(body.audit.head, 'h2')
    assert.equal(typeof body.startedAt, 'number')
    assert.ok(body.startedAt > 0)
    ctx.dispose()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('HTTP GET status: 依赖全缺时显式降级（不 pretend）', async () => {
  const { ctx, ws } = applyAsFork({})
  const handler = findHandler(ws, 'GET', ADAPTER_ROUTE.STATUS)
  const res = makeRes()
  await handler(getReq(), res)
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.services.scorer, false)
  assert.equal(body.services.buffer, false)
  assert.equal(body.buffer.state, 'unavailable')
  assert.equal(body.approvals.pending, 0)
  assert.equal(body.audit.records, 0)
  assert.equal(body.audit.head, null)
  ctx.dispose()
})

test('HTTP GET audit: ?limit 生效且被 Config.auditLimit 夹紧；缺 auditor → 409', async () => {
  const records = Array.from({ length: 10 }, (_, i) => ({ kind: 'r', seq: i + 1, hash: `h${i + 1}` }))
  const auditor = makeAuditor(records)
  const { ctx, ws } = applyAsFork({ auditLimit: 3 }, { [SERVICE.auditor]: auditor })

  const handler = findHandler(ws, 'GET', ADAPTER_ROUTE.AUDIT)
  const res = makeRes()
  await handler(getReq(`${routePath(ADAPTER_ROUTE.AUDIT)}?limit=9&token=t`), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
  assert.equal(res.json().records.length, 3, 'auditLimit=3 夹紧 ?limit=9')
  assert.deepEqual(auditor.calls.read.at(-1), { limit: 3 })

  const resDefault = makeRes()
  await handler(getReq(), resDefault)
  assert.equal(resDefault.json().records.length, 3, '没有 ?limit 时默认 100 也被夹紧到 3')
  assert.deepEqual(auditor.calls.read.at(-1), { limit: 3 })
  ctx.dispose()

  const missing = applyAsFork({})
  const resMissing = makeRes()
  await findHandler(missing.ws, 'GET', ADAPTER_ROUTE.AUDIT)(getReq(), resMissing)
  assert.equal(resMissing.statusCode, 409)
  assert.equal(resMissing.json().code, 'service-unavailable')
  assert.deepEqual(resMissing.json().records, [])
  missing.ctx.dispose()
})

test('HTTP GET approvals: 200 items；缺 approver → 409 降级', async () => {
  const { ctx, ws } = applyAsFork({}, { [SERVICE.approver]: makeApprover({ items: [{ id: 'a1' }, { id: 'a2' }] }) })
  const res = makeRes()
  await findHandler(ws, 'GET', ADAPTER_ROUTE.APPROVALS)(getReq(), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
  assert.equal(res.json().items.length, 2)
  ctx.dispose()

  const missing = applyAsFork({})
  const resMissing = makeRes()
  await findHandler(missing.ws, 'GET', ADAPTER_ROUTE.APPROVALS)(getReq(), resMissing)
  assert.equal(resMissing.statusCode, 409)
  assert.equal(resMissing.json().code, 'service-unavailable')
  assert.deepEqual(resMissing.json().items, [])
  missing.ctx.dispose()
})

test('HTTP POST command: 200 成功 / 400 非法 JSON / 400 unknown-op / 400 missing-op', async () => {
  const { ctx, ws } = applyAsFork({ taskId: 'task_http_cmd' })
  const handler = findHandler(ws, 'POST', ADAPTER_ROUTE.COMMAND)

  const okRes = makeRes()
  await handler(makeReq({ op: 'ping' }, 'POST'), okRes)
  assert.equal(okRes.statusCode, 200)
  assert.equal(okRes.json().ok, true)
  assert.equal(okRes.json().op, 'ping')
  assert.equal(okRes.json().result.pong, true)
  assert.equal(okRes.json().result.taskId, 'task_http_cmd')

  const badJson = makeRes()
  await handler(makeRawReq('{not json'), badJson)
  assert.equal(badJson.statusCode, 400)
  assert.equal(badJson.json().code, 'bad-request')

  const unknown = makeRes()
  await handler(makeReq({ op: 'launch-missiles' }, 'POST'), unknown)
  assert.equal(unknown.statusCode, 400)
  assert.equal(unknown.json().code, 'unknown-op')
  assert.equal(unknown.json().ok, false)

  const missingOp = makeRes()
  await handler(makeReq({}, 'POST'), missingOp)
  assert.equal(missingOp.statusCode, 400)
  assert.equal(missingOp.json().code, 'bad-request')
  ctx.dispose()
})

test('HTTP POST command: 命令失败映射 409 / 500', async () => {
  const { ctx, ws } = applyAsFork({})
  const handler = findHandler(ws, 'POST', ADAPTER_ROUTE.COMMAND)

  const notAvailable = makeRes()
  await handler(makeReq({ op: ADAPTER_OP.FLUSH_BUFFER }, 'POST'), notAvailable)
  assert.equal(notAvailable.statusCode, 409)
  assert.equal(notAvailable.json().code, 'service-unavailable')

  const throwing = makeRes()
  await handler(makeReq({ op: ADAPTER_OP.SCORE_PLUGIN, payload: { pluginId: 'plug' } }, 'POST'), throwing)
  assert.equal(throwing.statusCode, 409, '缺 scorer 时 score-plugin 降级 409')
  assert.equal(throwing.json().code, 'service-unavailable')
  ctx.dispose()
})

// ── command 层：各 op 分支与降级 ────────────────────────────────────────────

test('command ping/status/flush-buffer', async () => {
  const root = tmpDir('fang-t5-flush-')
  try {
    const buffer = makeBuffer({ dir: root, flushResult: { state: 'settled', flushed: ['index.js'], timedOut: false } })
    const { ctx, service } = applyAsFork({}, { [SERVICE.buffer]: buffer })

    const ping = await service.command({ op: ADAPTER_OP.PING })
    assert.equal(ping.ok, true)
    assert.equal(ping.op, 'ping')
    assert.equal(ping.result.pong, true)
    assert.equal(typeof ping.result.at, 'string')
    assert.equal(ping.result.taskId, service.taskId)

    const status = await service.command({ op: ADAPTER_OP.STATUS })
    assert.equal(status.ok, true)
    assert.equal(status.result.ok, true)
    assert.equal(status.result.role, 'fork')

    const flush = await service.command({ op: ADAPTER_OP.FLUSH_BUFFER })
    assert.equal(flush.ok, true)
    assert.deepEqual(flush.result.flushed, ['index.js'])
    assert.equal(buffer.calls.flush.length, 1)
    ctx.dispose()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('command flush-buffer: 缺 buffer → service-unavailable；flush 抛错 → handler-threw', async () => {
  const missing = applyAsFork({})
  const out = await missing.service.command({ op: ADAPTER_OP.FLUSH_BUFFER })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'service-unavailable')
  assert.equal(out.op, 'flush-buffer')
  missing.ctx.dispose()

  const throwing = applyAsFork({}, {
    [SERVICE.buffer]: makeBuffer({ flushImpl: () => { throw new Error('flush explode') } }),
  })
  const out2 = await throwing.service.command({ op: ADAPTER_OP.FLUSH_BUFFER })
  assert.equal(out2.ok, false)
  assert.equal(out2.code, 'handler-threw')
  assert.match(out2.error, /flush explode/)
  throwing.ctx.dispose()
})

test('command timeout: 悬挂的 flush 返回 code=timeout，不阻塞后续 ping', async () => {
  const hanging = makeBuffer({ flushImpl: () => new Promise(() => {}) })
  const { ctx, service } = applyAsFork({ commandTimeoutMs: 20 }, { [SERVICE.buffer]: hanging })
  const startedAt = Date.now()
  const out = await service.command({ op: ADAPTER_OP.FLUSH_BUFFER })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'timeout')
  assert.ok(Date.now() - startedAt < 2000)

  const ping = await service.command({ op: ADAPTER_OP.PING })
  assert.equal(ping.ok, true, '一条命令超时不影响后续命令')
  ctx.dispose()
})

test('command score-plugin: 成功 / 缺服务 / 缺 pluginId / 逃逸 / 不存在', async () => {
  const root = tmpDir('fang-t5-score-')
  try {
    writePlugin(root, 'plug', {
      'package.json': '{"name":"plug","version":"1.0.0","type":"module"}',
      'index.js': 'export const name = "plug"\n',
    })
    const scorer = makeScorer(() => ({ grade: 'B', S: 30, color: 'blue', veto: false, reasons: [], signals: [] }))
    const { ctx, service } = applyAsFork({}, { [SERVICE.buffer]: makeBuffer({ dir: root }), [SERVICE.scorer]: scorer })

    const ok = await service.command({ op: ADAPTER_OP.SCORE_PLUGIN, payload: { pluginId: 'plug' } })
    assert.equal(ok.ok, true)
    assert.equal(ok.result.grade, 'B')
    assert.equal(ok.result.pluginId, 'plug')
    assert.equal(scorer.calls.scoreDir.length, 1)
    assert.equal(scorer.calls.scoreDir[0].dir, path.join(root, 'plug'))

    const noId = await service.command({ op: ADAPTER_OP.SCORE_PLUGIN, payload: {} })
    assert.equal(noId.ok, false)
    assert.equal(noId.code, 'bad-request')

    const escape = await service.command({ op: ADAPTER_OP.SCORE_PLUGIN, payload: { pluginId: '../plug' } })
    assert.equal(escape.ok, false)
    assert.equal(escape.code, 'path-escape')

    const missingPlugin = await service.command({ op: ADAPTER_OP.SCORE_PLUGIN, payload: { pluginId: 'nope' } })
    assert.equal(missingPlugin.ok, false)
    assert.equal(missingPlugin.code, 'plugin-not-found')
    ctx.dispose()

    const noScorer = applyAsFork({}, { [SERVICE.buffer]: makeBuffer({ dir: root }) })
    const degraded = await noScorer.service.command({ op: ADAPTER_OP.SCORE_PLUGIN, payload: { pluginId: 'plug' } })
    assert.equal(degraded.ok, false)
    assert.equal(degraded.code, 'service-unavailable')
    noScorer.ctx.dispose()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('command read-plugin: 成功返回 {files:{relPath:text}}，嵌套路径用 /', async () => {
  const root = tmpDir('fang-t5-read-')
  try {
    writePlugin(root, 'plug', {
      'package.json': '{"name":"plug"}',
      'index.js': 'export default 1\n',
      'lib/util.js': 'export const x = 2\n',
    })
    const { ctx, service } = applyAsFork({}, { [SERVICE.buffer]: makeBuffer({ dir: root }) })
    const out = await service.command({ op: ADAPTER_OP.READ_PLUGIN, payload: { pluginId: 'plug' } })

    assert.equal(out.ok, true)
    assert.equal(out.op, 'read-plugin')
    assert.equal(out.result.pluginId, 'plug')
    assert.deepEqual(Object.keys(out.result.files).sort(), ['index.js', 'lib/util.js', 'package.json'])
    assert.equal(out.result.files['lib/util.js'], 'export const x = 2\n')
    assert.equal(out.result.count, 3)
    assert.ok(out.result.bytes > 0)
    ctx.dispose()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('command read-plugin: 拒绝路径逃逸/盘符/UNC/..（含真实越界目录）', async () => {
  const root = tmpDir('fang-t5-escape-')
  try {
    const bufferRoot = path.join(root, 'buffer')
    writePlugin(bufferRoot, 'plug', { 'index.js': 'x' })
    fs.writeFileSync(path.join(root, 'secret.txt'), 'mother-secret')
    const { ctx, service } = applyAsFork({}, { [SERVICE.buffer]: makeBuffer({ dir: bufferRoot }) })

    const escapes = ['../secret.txt', '..\\secret.txt', 'a/../../secret.txt', '.', 'C:\\Windows\\win.ini', '\\\\server\\share\\x', '/etc/passwd']
    for (const pluginId of escapes) {
      const out = await service.command({ op: ADAPTER_OP.READ_PLUGIN, payload: { pluginId } })
      assert.equal(out.ok, false, `pluginId=${pluginId} 必须被拒绝`)
      assert.equal(out.code, 'path-escape', `pluginId=${pluginId} 应报 path-escape，实际 ${out.code}`)
      assert.equal(out.result.files, undefined, '逃逸不得返回任何文件内容')
    }

    const empty = await service.command({ op: ADAPTER_OP.READ_PLUGIN, payload: {} })
    assert.equal(empty.ok, false)
    assert.equal(empty.code, 'bad-request')

    const noBufferService = applyAsFork({})
    const unknownRoot = await noBufferService.service.command({ op: ADAPTER_OP.READ_PLUGIN, payload: { pluginId: 'plug' } })
    assert.equal(unknownRoot.ok, false)
    assert.ok(['plugin-not-found', 'not-configured'].includes(unknownRoot.code), `未知 root 应显式降级，实际 ${unknownRoot.code}`)
    noBufferService.ctx.dispose()
    ctx.dispose()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('command read-plugin: 二进制 / 单文件 >1MB / 总量 >2MB 全部拒绝', async () => {
  const root = tmpDir('fang-t5-limits-')
  try {
    writePlugin(root, 'binary', { 'index.js': 'x' })
    fs.writeFileSync(path.join(root, 'binary', 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
    writePlugin(root, 'big-file', { 'index.js': 'x' })
    fs.writeFileSync(path.join(root, 'big-file', 'huge.txt'), Buffer.alloc(1024 * 1024 + 1, 97))
    writePlugin(root, 'big-total', { 'index.js': 'x' })
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(root, 'big-total', `part${i}.txt`), Buffer.alloc(800 * 1024, 98))
    }
    const { ctx, service } = applyAsFork({}, { [SERVICE.buffer]: makeBuffer({ dir: root }) })

    const binary = await service.command({ op: ADAPTER_OP.READ_PLUGIN, payload: { pluginId: 'binary' } })
    assert.equal(binary.ok, false)
    assert.equal(binary.code, 'binary-file')
    assert.match(binary.error, /blob\.bin/)

    const bigFile = await service.command({ op: ADAPTER_OP.READ_PLUGIN, payload: { pluginId: 'big-file' } })
    assert.equal(bigFile.ok, false)
    assert.equal(bigFile.code, 'file-too-large')

    const bigTotal = await service.command({ op: ADAPTER_OP.READ_PLUGIN, payload: { pluginId: 'big-total' } })
    assert.equal(bigTotal.ok, false)
    assert.equal(bigTotal.code, 'total-too-large')
    ctx.dispose()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('command route-confirm: 转发 Router.confirm（可只给 pluginId，自动补 assessment）', async () => {
  const root = tmpDir('fang-t5-route-')
  try {
    writePlugin(root, 'plug', {
      'package.json': '{"name":"plug","type":"module"}',
      'index.js': 'export default 1\n',
    })
    const router = makeRouter((input) => ({
      route: input?.decision?.route ?? 'sandbox',
      escalated: Boolean(input?.assessment),
      basis: { forkAssessment: input?.assessment?.grade ?? null },
    }))
    const scorer = makeScorer(() => ({ grade: 'C', S: 50, color: 'yellow', veto: false, reasons: [], signals: [] }))
    const { ctx, service } = applyAsFork({}, {
      [SERVICE.buffer]: makeBuffer({ dir: root }),
      [SERVICE.router]: router,
      [SERVICE.scorer]: scorer,
    })

    const out = await service.command({
      op: ADAPTER_OP.ROUTE_CONFIRM,
      payload: { decision: { route: 'sandbox', reason: 'trusted' }, pluginId: 'plug' },
    })
    assert.equal(out.ok, true)
    assert.equal(out.result.route, 'sandbox')
    assert.equal(out.result.escalated, true)
    assert.equal(router.calls.confirm.length, 1)
    assert.equal(router.calls.confirm[0].decision.route, 'sandbox')
    assert.equal(router.calls.confirm[0].assessment.grade, 'C', 'payload 没给 assessment 时用分身 Scorer 现算')
    ctx.dispose()

    const noRouter = applyAsFork({}, { [SERVICE.buffer]: makeBuffer({ dir: root }) })
    const degraded = await noRouter.service.command({ op: ADAPTER_OP.ROUTE_CONFIRM, payload: { decision: {} } })
    assert.equal(degraded.ok, false)
    assert.equal(degraded.code, 'service-unavailable')
    noRouter.ctx.dispose()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('command approvals/approval-decide: 决策归一化 / 参数校验 / 缺服务', async () => {
  const approver = makeApprover({
    items: [{ id: 'a1' }, { id: 'a2' }],
    decide: (id, outcome, options) => ({ ok: true, id, outcome, by: options?.by, at: 'T1' }),
  })
  const { ctx, service } = applyAsFork({}, { [SERVICE.approver]: approver })

  const list = await service.command({ op: ADAPTER_OP.APPROVALS })
  assert.equal(list.ok, true)
  assert.equal(list.result.items.length, 2)

  const approved = await service.command({ op: ADAPTER_OP.APPROVAL_DECIDE, payload: { id: 'a1', decision: 'approve', by: 'mother' } })
  assert.equal(approved.ok, true)
  assert.equal(approved.result.outcome, 'approved')
  assert.equal(approver.calls.decide[0].outcome, 'approved')
  assert.equal(approver.calls.decide[0].options.by, 'mother')

  const denied = await service.command({ op: ADAPTER_OP.APPROVAL_DECIDE, payload: { id: 'a2', outcome: 'denied', note: 'nope' } })
  assert.equal(denied.ok, true)
  assert.equal(approver.calls.decide[1].outcome, 'denied')
  assert.equal(approver.calls.decide[1].options.note, 'nope')

  const badOutcome = await service.command({ op: ADAPTER_OP.APPROVAL_DECIDE, payload: { id: 'a1', decision: 'maybe' } })
  assert.equal(badOutcome.ok, false)
  assert.equal(badOutcome.code, 'bad-request')

  const missingId = await service.command({ op: ADAPTER_OP.APPROVAL_DECIDE, payload: { decision: 'approve' } })
  assert.equal(missingId.ok, false)
  assert.equal(missingId.code, 'bad-request')

  const noApprover = applyAsFork({})
  const degraded = await noApprover.service.command({ op: ADAPTER_OP.APPROVAL_DECIDE, payload: { id: 'x', decision: 'approve' } })
  assert.equal(degraded.ok, false)
  assert.equal(degraded.code, 'service-unavailable')
  noApprover.ctx.dispose()
  ctx.dispose()

  const notFoundApprover = makeApprover({ decide: () => ({ ok: false, reason: 'not-found' }) })
  const notFound = applyAsFork({}, { [SERVICE.approver]: notFoundApprover })
  const refused = await notFound.service.command({ op: ADAPTER_OP.APPROVAL_DECIDE, payload: { id: 'ghost', decision: 'approve' } })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'not-found')
  notFound.ctx.dispose()
})

test('command archive: flush + 审计 + 事件 + 幂等；缺 buffer → service-unavailable', async () => {
  const root = tmpDir('fang-t5-archive-')
  try {
    const buffer = makeBuffer({ dir: root, flushResult: { state: 'settled', flushed: ['index.js'], timedOut: false } })
    const auditor = makeAuditor([])
    const { ctx, service } = applyAsFork({ taskId: 'task_arch' }, { [SERVICE.buffer]: buffer, [SERVICE.auditor]: auditor })
    const events = []
    ctx.on('fang/task-archived', (payload) => events.push(payload))

    const first = await service.command({ op: ADAPTER_OP.ARCHIVE })
    assert.equal(first.ok, true)
    assert.equal(first.result.archived, true)
    assert.deepEqual(first.result.flushed, ['index.js'])
    assert.equal(buffer.calls.flush.length, 1)
    assert.equal(auditor.calls.append.length, 1)
    assert.equal(auditor.calls.append[0].kind, AUDIT.TASK_ARCHIVED)
    assert.equal(auditor.calls.append[0].data.taskId, 'task_arch')
    assert.equal(events.length, 1)
    assert.equal(events[0].taskId, 'task_arch')
    assert.equal(service.status().archived, true)

    const second = await service.command({ op: ADAPTER_OP.ARCHIVE })
    assert.equal(second.ok, true, 'archive 必须可重复调用（幂等）')
    assert.equal(buffer.calls.flush.length, 2)
    ctx.dispose()

    const noBuffer = applyAsFork({})
    const degraded = await noBuffer.service.command({ op: ADAPTER_OP.ARCHIVE })
    assert.equal(degraded.ok, false)
    assert.equal(degraded.code, 'service-unavailable')
    noBuffer.ctx.dispose()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('service.audit(): limit 夹紧 / 缺 auditor 降级；approvals() 缺服务降级', async () => {
  const records = Array.from({ length: 12 }, (_, i) => ({ kind: 'r', seq: i + 1 }))
  const auditor = makeAuditor(records)
  const { ctx, service } = applyAsFork({ auditLimit: 5 }, { [SERVICE.auditor]: auditor })

  const tail = service.audit({ limit: 3 })
  assert.equal(tail.ok, true)
  assert.equal(tail.records.length, 3)
  assert.deepEqual(auditor.calls.read.at(-1), { limit: 3 })

  const clamped = service.audit({ limit: 100 })
  assert.equal(clamped.records.length, 5, 'auditLimit 夹紧上限')

  const zero = service.audit({ limit: 0 })
  assert.deepEqual(zero.records, [])
  ctx.dispose()

  const degraded = applyAsFork({})
  const auditOut = degraded.service.audit({})
  assert.equal(auditOut.ok, false)
  assert.equal(auditOut.code, 'service-unavailable')
  assert.deepEqual(auditOut.records, [])
  const approvalsOut = degraded.service.approvals()
  assert.equal(approvalsOut.ok, false)
  assert.equal(approvalsOut.code, 'service-unavailable')
  assert.deepEqual(approvalsOut.items, [])
  degraded.ctx.dispose()
})

test('未知命令返回 unknown-op 且带 op；ping 结果含 taskId/uptime', async () => {
  const { ctx, service } = applyAsFork({ taskId: 'task_unknown' })
  const out = await service.command({ op: 'nope', payload: {} })
  assert.equal(out.ok, false)
  assert.equal(out.op, 'nope')
  assert.equal(out.code, 'unknown-op')
  assert.match(out.error, /unknown-op/)

  const ping = await service.command({ op: 'ping' })
  assert.equal(ping.result.taskId, 'task_unknown')
  assert.equal(typeof ping.result.uptimeMs, 'number')
  assert.ok(ping.result.uptimeMs >= 0)
  ctx.dispose()
})

// ── v3：协议版本 / 快照 / 认证 / SSE / 幂等命令（docs/PROTOCOL-V3.md）──────────

test('v3: GET version/health/state 快照（协议号/sessionId/lastCursor/指标）', async () => {
  const { ctx, ws, service } = applyAsFork({ taskId: 'task_v3_snapshot' })

  const versionRes = makeRes()
  await findHandler(ws, 'GET', ADAPTER_ROUTE.VERSION)(getReq(), versionRes)
  assert.equal(versionRes.statusCode, 200)
  const versionBody = versionRes.json()
  assert.equal(versionBody.ok, true)
  assert.equal(versionBody.protocol, ADAPTER_PROTOCOL_VERSION)
  assert.equal(versionBody.minProtocol, 1)
  assert.equal(versionBody.sessionId, service.sessionId)
  assert.equal(versionBody.taskId, 'task_v3_snapshot')
  assert.equal(versionBody.capabilities.length, Object.values(ADAPTER_OP).length)

  const healthRes = makeRes()
  await findHandler(ws, 'GET', ADAPTER_ROUTE.HEALTH)(getReq(), healthRes)
  assert.equal(healthRes.statusCode, 200)
  const healthBody = healthRes.json()
  assert.equal(healthBody.ok, true)
  assert.equal(healthBody.status, 'running')
  assert.equal(healthBody.protocol, ADAPTER_PROTOCOL_VERSION)
  assert.equal(healthBody.pid, process.pid)

  const stateRes = makeRes()
  await findHandler(ws, 'GET', ADAPTER_ROUTE.STATE)(getReq(), stateRes)
  assert.equal(stateRes.statusCode, 200)
  const snapshot = stateRes.json()
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.sessionId, service.sessionId)
  assert.equal(snapshot.protocolVersion, ADAPTER_PROTOCOL_VERSION)
  assert.equal(snapshot.status, 'running')
  assert.equal(snapshot.lastCursor, '0')
  assert.ok(Array.isArray(snapshot.plugins))
  assert.ok(snapshot.plugins.some((p) => p.pluginId === 'adapter' && p.state === 'active'))
  assert.equal(typeof snapshot.metrics.rssBytes, 'number')
  assert.equal(typeof snapshot.metrics.handleCount, 'number')
  assert.equal(snapshot.buffer.state, 'unavailable')
  assert.deepEqual(snapshot.approvals, [])

  // hello 也补了 protocol/sessionId（v2 客户端忽略未知字段，前向兼容）
  const helloBody = service.hello()
  assert.equal(helloBody.protocol, ADAPTER_PROTOCOL_VERSION)
  assert.equal(helloBody.sessionId, service.sessionId)
  ctx.dispose()
})

test('v3: 审批 diff → approval-requested / approval-resolved 事件（不重复）', () => {
  const approver = makeApprover({ items: [{ id: 'a1', action: 'install dep', light: 'yellow' }] })
  const { ctx, service } = applyAsFork({}, { [SERVICE.approver]: approver })

  const snapshot = service.state()
  assert.equal(snapshot.approvals.length, 1)
  assert.equal(snapshot.approvals[0].approvalId, 'a1')
  assert.equal(snapshot.approvals[0].action, 'install dep')
  assert.equal(snapshot.approvals[0].light, 'yellow')

  const first = service.eventsSince('0')
  assert.equal(first.ok, true)
  assert.equal(first.events.length, 1)
  assert.equal(first.events[0].event.kind, 'approval-requested')
  assert.equal(first.events[0].cursor, '1')
  assert.equal(first.events[0].sessionId, service.sessionId)
  assert.equal(first.lastCursor, '1')

  service.state() // 同一批待办再次拉快照，不得重复发 requested
  assert.equal(service.eventsSince('1').events.length, 0)

  ctx.emit('fang/approval-decided', { id: 'a1', outcome: 'denied' })
  const second = service.eventsSince('1')
  assert.equal(second.events.length, 1)
  assert.deepEqual(second.events[0].event, { kind: 'approval-resolved', approvalId: 'a1', verdict: 'reject' })
  ctx.dispose()
})

test('v3: SSE events 路由（回放/session-changed/cursor-invalid/cursor-expired/关闭清理）', async () => {
  const { ctx, ws, service } = applyAsFork({ taskId: 'task_sse', eventCapacity: 2 })
  const eventsHandler = findHandler(ws, 'GET', ADAPTER_ROUTE.EVENTS)

  // 3 条事件 + capacity=2 → 环形缓冲只剩 cursor 2、3
  for (const n of [1, 2, 3]) await service.commands({ commandId: `cmd_ping_${n}`, op: ADAPTER_OP.PING })
  assert.equal(service.lastCursor(), '3')

  const res = makeSseRes()
  await eventsHandler(getReq(`${routePath(ADAPTER_ROUTE.EVENTS)}?since=2&session=${service.sessionId}`), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8')
  assert.equal(res.headers['cache-control'], 'no-store, no-transform')
  const body = res.body()
  assert.ok(body.includes('retry: 2000'))
  assert.ok(body.includes(': connected'))
  assert.ok(body.includes('id: 3'), 'since=2 只回放 cursor=3')
  assert.ok(!body.includes('id: 2'), 'cursor 之前的旧事件不回放')
  res.emit('close')
  assert.equal(res.writableEnded, true, 'close 时清理长连接')

  const expired = makeSseRes()
  await eventsHandler(getReq(`${routePath(ADAPTER_ROUTE.EVENTS)}?since=0`), expired)
  assert.equal(expired.statusCode, 410)
  assert.equal(expired.json().code, 'cursor-expired')
  assert.equal(expired.json().lastCursor, '3')

  const wrongSession = makeSseRes()
  await eventsHandler(getReq(`${routePath(ADAPTER_ROUTE.EVENTS)}?since=0&session=s-dead`), wrongSession)
  assert.equal(wrongSession.statusCode, 409)
  assert.equal(wrongSession.json().code, 'session-changed')

  const badCursor = makeSseRes()
  await eventsHandler(getReq(`${routePath(ADAPTER_ROUTE.EVENTS)}?since=abc`), badCursor)
  assert.equal(badCursor.statusCode, 400)
  assert.equal(badCursor.json().code, 'cursor-invalid')
  ctx.dispose()
})

test('v3: POST commands 幂等（同 commandId 只执行一次）+ 202 异步 + 参数校验', async () => {
  const root = tmpDir('fang-v3-cmd-')
  try {
    const buffer = makeBuffer({ dir: root, flushResult: { state: 'settled', flushed: ['index.js'], timedOut: false } })
    const { ctx, ws } = applyAsFork({ taskId: 'task_v3_cmd' }, { [SERVICE.buffer]: buffer })
    const handler = findHandler(ws, 'POST', ADAPTER_ROUTE.COMMANDS)

    const first = makeRes()
    await handler(makeReq({ commandId: 'cmd_flush_1', op: ADAPTER_OP.FLUSH_BUFFER }, 'POST'), first)
    assert.equal(first.statusCode, 200)
    assert.equal(first.json().ok, true)
    assert.equal(first.json().commandId, 'cmd_flush_1')
    assert.equal(buffer.calls.flush.length, 1)

    const replay = makeRes()
    await handler(makeReq({ commandId: 'cmd_flush_1', op: ADAPTER_OP.FLUSH_BUFFER }, 'POST'), replay)
    assert.equal(replay.statusCode, 200)
    assert.equal(replay.json().deduplicated, true)
    assert.equal(buffer.calls.flush.length, 1, '同 commandId 必须重放，不得重复执行')

    const accepted = makeRes()
    await handler(makeReq({ commandId: 'cmd_async_1', op: ADAPTER_OP.PING, async: true }, 'POST'), accepted)
    assert.equal(accepted.statusCode, 202)
    assert.equal(accepted.json().status, 'accepted')
    assert.equal(accepted.json().trackingId, 'cmd_async_1')
    await new Promise((resolve) => setTimeout(resolve, 25))

    const missing = makeRes()
    await handler(makeReq({ op: '' }, 'POST'), missing)
    assert.equal(missing.statusCode, 400)
    assert.equal(missing.json().code, 'missing-op')

    const badId = makeRes()
    await handler(makeReq({ commandId: 'bad id', op: ADAPTER_OP.PING }, 'POST'), badId)
    assert.equal(badId.statusCode, 400)
    assert.equal(badId.json().code, 'command-id-invalid')
    ctx.dispose()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('v3: 同一 commandId 并发提交 → in-flight 合并，只执行一次（CommandCache.run）', async () => {
  const root = tmpDir('fang-v3-concurrent-')
  try {
    const gate = { resolve: null }
    const buffer = makeBuffer({
      dir: root,
      flushImpl: () => new Promise((resolve) => {
        gate.resolve = () => resolve({ state: 'settled', flushed: ['x.js'], timedOut: false })
      }),
    })
    const { ctx, service } = applyAsFork({ taskId: 'task_conc' }, { [SERVICE.buffer]: buffer })

    const p1 = service.commands({ commandId: 'cmd_conc_1', op: ADAPTER_OP.FLUSH_BUFFER })
    const p2 = service.commands({ commandId: 'cmd_conc_1', op: ADAPTER_OP.FLUSH_BUFFER })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(buffer.calls.flush.length, 1, '同一 commandId 并发提交只能执行一次')
    gate.resolve()
    const [first, second] = await Promise.all([p1, p2])
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(first.deduplicated, undefined, '第一个调用是真实执行，不带 deduplicated')
    assert.equal(second.deduplicated, true, '并发等待者拿到同一次执行的结果')

    const later = await service.commands({ commandId: 'cmd_conc_1', op: ADAPTER_OP.FLUSH_BUFFER })
    assert.equal(later.deduplicated, true, '完成后再次提交走 completed 重放')
    assert.equal(buffer.calls.flush.length, 1)
    ctx.dispose()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('v3: Bearer 认证（env 注入时强制；未注入时 v2 兼容放行）', async () => {
  const secured = applyWithRole('fork', {}, {}, { env: { DSH_ADAPTER_TOKEN: 'tok-v3-secret-0123456789abcdef' } })
  assert.equal(secured.service.authEnabled, true)
  const stateHandler = findHandler(secured.ws, 'GET', ADAPTER_ROUTE.STATE)

  const noAuth = makeRes()
  await stateHandler(getReq(), noAuth)
  assert.equal(noAuth.statusCode, 401)
  assert.equal(noAuth.json().code, 'unauthorized')

  const wrong = makeRes()
  const reqWrong = getReq()
  reqWrong.headers = { authorization: 'Bearer wrong-token-0123456789abcdef00' }
  await stateHandler(reqWrong, wrong)
  assert.equal(wrong.statusCode, 401, '长度相同也必须是恒定时间比较后拒绝')

  const okRes = makeRes()
  const reqOk = getReq()
  reqOk.headers = { authorization: 'Bearer tok-v3-secret-0123456789abcdef' }
  await stateHandler(reqOk, okRes)
  assert.equal(okRes.statusCode, 200)
  assert.equal(okRes.json().ok, true)
  secured.ctx.dispose()

  const legacy = applyAsFork({ allowLegacyNoToken: false })
  assert.equal(legacy.service.authEnabled, false, '无 env token = authEnabled false')
  const legacyRes = makeRes()
  await findHandler(legacy.ws, 'GET', ADAPTER_ROUTE.STATE)(getReq(), legacyRes)
  assert.equal(legacyRes.statusCode, 401, 'v3.0.5/B2：fork 无 token 默认 fail-closed')
  assert.equal(legacyRes.json().code, 'unauthorized')
  legacy.ctx.dispose()

  const legacyAllowed = applyAsFork({})
  assert.equal(legacyAllowed.service.authEnabled, false)
  const allowedRes = makeRes()
  await findHandler(legacyAllowed.ws, 'GET', ADAPTER_ROUTE.STATE)(getReq(), allowedRes)
  assert.equal(allowedRes.statusCode, 200, '显式 allowLegacyNoToken 时才允许 v2 兼容')
  legacyAllowed.ctx.dispose()

  // Adapter perimeter must match /fang/api/*: loopback Host, Origin/CSRF, JSON writes,
  // and auth-before-method (401 not 405).
  const token = 'tok-perimeter-0123456789abcdef0123456789'
  const secured2 = applyWithRole('fork', {}, {}, { env: { DSH_ADAPTER_TOKEN: token } })
  const state = findHandler(secured2.ws, 'GET', ADAPTER_ROUTE.STATE)

  const badHostReq = getReq()
  badHostReq.headers = { host: 'evil.example', authorization: `Bearer ${token}` }
  const badHostRes = makeRes()
  await state(badHostReq, badHostRes)
  assert.equal(badHostRes.statusCode, 403)
  assert.equal(badHostRes.json().code, 'bad-host')

  const badOriginReq = getReq()
  badOriginReq.headers = { host: '127.0.0.1:1', origin: 'https://evil.example', authorization: `Bearer ${token}` }
  const badOriginRes = makeRes()
  await state(badOriginReq, badOriginRes)
  assert.equal(badOriginRes.statusCode, 403)
  assert.equal(badOriginRes.json().code, 'bad-origin')

  const postNoAuth = getReq()
  postNoAuth.method = 'POST'
  postNoAuth.headers = { host: '127.0.0.1:1' }
  const postNoAuthRes = makeRes()
  await state(postNoAuth, postNoAuthRes)
  assert.equal(postNoAuthRes.statusCode, 401, 'auth 必须先于 method 判定')

  const wrongMethodReq = getReq()
  wrongMethodReq.method = 'POST'
  wrongMethodReq.headers = { host: '127.0.0.1:1', authorization: `Bearer ${token}` }
  const wrongMethodRes = makeRes()
  await state(wrongMethodReq, wrongMethodRes)
  assert.equal(wrongMethodRes.statusCode, 405)
  assert.equal(wrongMethodRes.headers.allow, 'GET')

  const commands = findHandler(secured2.ws, 'POST', ADAPTER_ROUTE.COMMANDS)
  const textReq = makeReq({}, 'POST')
  textReq.headers = {
    host: '127.0.0.1:1', authorization: `Bearer ${token}`, 'content-type': 'text/plain',
  }
  const textRes = makeRes()
  await commands(textReq, textRes)
  assert.equal(textRes.statusCode, 415)
  assert.equal(textRes.json().code, 'content-type-required')
  secured2.ctx.dispose()
})

// ── v2.6.8：外部注册命令（registerCommand）与 413 body 上限 ──────────────────

test('v4: registerCommand 同步命令（200 + commandId 幂等 + disposer 后 unknown-op）', async () => {
  const { ctx, ws, service } = applyAsFork({ taskId: 'task_reg' })
  const calls = []
  const dispose = service.registerCommand('demo-echo', async (payload, execCtx) => {
    calls.push({ payload, commandId: execCtx.commandId, trackingId: execCtx.trackingId })
    return { status: 'completed', result: { echo: payload.value ?? null } }
  })
  const handler = findHandler(ws, 'POST', ADAPTER_ROUTE.COMMANDS)

  const first = makeRes()
  await handler(makeReq({ commandId: 'cmd_reg_1', op: 'demo-echo', payload: { value: 42 } }, 'POST'), first)
  assert.equal(first.statusCode, 200)
  assert.equal(first.json().status, 'completed')
  assert.deepEqual(first.json().result, { echo: 42 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].commandId, 'cmd_reg_1')
  assert.equal(calls[0].trackingId, 'track_cmd_reg_1')

  const second = makeRes()
  await handler(makeReq({ commandId: 'cmd_reg_1', op: 'demo-echo', payload: { value: 42 } }, 'POST'), second)
  assert.equal(second.statusCode, 200)
  assert.equal(second.json().deduplicated, true)
  assert.equal(calls.length, 1, '同 commandId 不得重复执行')

  dispose()
  const gone = makeRes()
  await handler(makeReq({ commandId: 'cmd_reg_2', op: 'demo-echo', payload: {} }, 'POST'), gone)
  assert.equal(gone.statusCode, 400)
  assert.equal(gone.json().code, 'unknown-op')
  ctx.dispose()
})

test('v4: registerCommand 异步命令（202 + command-done SSE + 重试同一 trackingId）', async () => {
  const { ctx, ws, service } = applyAsFork({ taskId: 'task_reg_async' })
  const dispose = service.registerCommand('demo-load', async (payload, execCtx) => {
    setTimeout(() => {
      execCtx.emit({
        kind: 'command-done',
        trackingId: execCtx.trackingId,
        op: 'demo-load',
        result: { ok: true, op: 'demo-load', result: { loaded: payload.pluginId } },
      })
    }, 15)
    return { status: 'accepted', trackingId: execCtx.trackingId }
  })
  const handler = findHandler(ws, 'POST', ADAPTER_ROUTE.COMMANDS)

  const accepted = makeRes()
  await handler(makeReq({ commandId: 'cmd_reg_async', op: 'demo-load', payload: { pluginId: 'p1' } }, 'POST'), accepted)
  assert.equal(accepted.statusCode, 202)
  assert.equal(accepted.json().status, 'accepted')
  assert.equal(accepted.json().trackingId, 'track_cmd_reg_async')

  await new Promise((resolve) => setTimeout(resolve, 35))
  const events = service.eventsSince('0')
  const done = events.events.find((entry) => entry.event.kind === 'command-done')
  assert.ok(done, '异步命令必须通过 EventLog 推 command-done')
  assert.equal(done.event.trackingId, 'track_cmd_reg_async')
  assert.deepEqual(done.event.result.result, { loaded: 'p1' })

  const retry = makeRes()
  await handler(makeReq({ commandId: 'cmd_reg_async', op: 'demo-load', payload: { pluginId: 'p1' } }, 'POST'), retry)
  assert.equal(retry.statusCode, 202)
  assert.equal(retry.json().deduplicated, true)
  assert.equal(retry.json().trackingId, 'track_cmd_reg_async', '重试必须拿到同一个 trackingId')

  dispose()
  ctx.dispose()
})

test('v4: registerCommand 不允许覆盖内置 op；rejected 结果映射为失败信封', async () => {
  const { ctx, service } = applyAsFork({})
  assert.throws(
    () => service.registerCommand(ADAPTER_OP.PING, () => ({})),
    /cannot override built-in op/,
  )
  const dispose = service.registerCommand('demo-reject', async () => ({
    status: 'rejected',
    code: 'bad-request',
    message: 'not allowed',
  }))
  const out = await service.commands({ commandId: 'cmd_rej', op: 'demo-reject' })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'bad-request')
  assert.equal(out.error, 'not allowed')
  dispose()
  ctx.dispose()
})

test('v4: 请求体超过 1MB → 413 body-too-large（executor 不被调用）', async () => {
  const { ctx, ws, service } = applyAsFork({})
  let called = 0
  service.registerCommand('demo-big', async () => {
    called += 1
    return { status: 'completed', result: {} }
  })
  const handler = findHandler(ws, 'POST', ADAPTER_ROUTE.COMMANDS)
  const big = `{"commandId":"cmd_big","op":"demo-big","payload":"${'a'.repeat(1_000_100)}"}`
  const res = makeRes()
  await handler(makeRawReq(big), res)
  assert.equal(res.statusCode, 413)
  assert.equal(res.json().code, 'body-too-large')
  assert.equal(called, 0)
  ctx.dispose()
})

test('纯函数：normalizePrefix / resolveInside 的边界', () => {
  const { normalizePrefix, resolveInside } = adapterModule._internals
  assert.equal(normalizePrefix(''), '/fang')
  assert.equal(normalizePrefix('fang'), '/fang')
  assert.equal(normalizePrefix('/fang/'), '/fang')
  assert.equal(normalizePrefix('/a/b//'), '/a/b')
  assert.equal(normalizePrefix('\\x'), '/x')

  const root = path.resolve('root-buffer')
  assert.equal(resolveInside(root, 'plug').dir, path.join(root, 'plug'))
  assert.equal(resolveInside(root, 'plug/sub').dir, path.join(root, 'plug', 'sub'))
  assert.equal(resolveInside(root, '..').ok, false)
  assert.equal(resolveInside(root, '../x').ok, false)
  assert.equal(resolveInside(root, '').ok, false)
  assert.equal(resolveInside(root, '.').ok, false)
  assert.equal(resolveInside(root, '\\server\\x').ok, false)
  assert.equal(resolveInside(root, 'C:\\x').ok, false)
})

test('adapter: decision-ingest command forwards to decision-center service', async () => {
  const submitted = []
  const center = {
    submit: async (payload) => {
      submitted.push(payload)
      if (!payload?.title) return { ok: false, reason: 'title-required' }
      return { ok: true, ticket: { id: 'dec_adapter_1' }, merged: false }
    },
  }
  const { ctx, service } = applyAsFork({ taskId: 'task_decision' }, { [SERVICE.decisionCenter]: center })
  try {
    const out = await service.command({ op: ADAPTER_OP.DECISION_INGEST, payload: { level: 'yellow', title: 'from adapter', context: 'x', options: [{ value: 'a', label: 'A' }] } })
    assert.equal(out.ok, true)
    assert.equal(out.result.ticket.id, 'dec_adapter_1')
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0].producer, 'adapter')
    assert.equal(submitted[0].title, 'from adapter')

    const missing = await service.command({ op: ADAPTER_OP.DECISION_INGEST })
    assert.equal(missing.ok, false)
    assert.equal(missing.result.reason, 'title-required')
  } finally {
    ctx.dispose()
  }
})
