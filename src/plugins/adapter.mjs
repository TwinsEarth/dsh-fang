// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// fang-adapter — 分身侧的跨进程桥（v2.0.0 第 11 行，契约：docs/CONTRACTS-V2.md §5.1、
// docs/PROTOCOL-V2.md §2/§3）。
//
// 母体与分身是两个独立 DSH 进程，不能共享 Cordis ctx/bus。本插件把分身内部的服务
// （scorer/router/healer/approver/hotReloader/buffer/auditor）暴露为 5 个 HTTP 端点，
// 由母体侧 `src/lib/remote.mjs` 调用：
//
//   GET  /fang/adapter/hello       握手：role / taskId / version / capabilities
//   GET  /fang/adapter/status      服务表 + 缓冲三态 + 待批数 + 审计头
//   GET  /fang/adapter/approvals   分身本地待审批项
//   GET  /fang/adapter/audit       审计尾部（?limit=n）
//   POST /fang/adapter/command     控制命令 {op, payload}
//
// 硬约束：
//   * 只部署在分身：apply 首行 roleGate('adapter')，mother 角色下不注册服务/路由；
//   * 处理器与 service 方法**共用同一实现**，HTTP 只做方法校验与状态码映射；
//   * 所有依赖服务通过 `ctx.get(SERVICE.x)` 可选获取，缺失显式降级为
//     `{ok:false, code:'service-unavailable'}`，绝不假装成功、绝不抛出；
//   * read-plugin 只读「本分身 buffer/<pluginId>」内的文本文件，拒绝路径逃逸/UNC/盘符/
//     `..`，单文件 ≤1MB、总量 ≤2MB，二进制（含 NUL）拒绝；
//   * archive = flush buffer + 归档标记（进程 kill 由母体 Forker 执行，绝不自杀）。
import fs from 'node:fs'
import path from 'node:path'

import {
  z,
  roleGate,
  resolveFangLayout,
  SERVICE,
  ADAPTER_OP,
  ADAPTER_ROUTE,
  AUDIT,
  FANG_VERSION,
  bus,
  exists,
  iso,
  nowMs,
} from '../kernel/index.mjs'

export const name = 'fang-adapter'
export const inject = []

/** 单文件 / 单次 read-plugin 总量的硬上限（契约 §5.1、PROTOCOL-V2 §3）。 */
export const MAX_FILE_BYTES = 1024 * 1024
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024

/** forkId 的环境变量来源（forker 用 DSH_FANG_TASK_ID 注入分身身份）。 */
const TASK_ID_ENVS = ['DSH_FANG_TASK_ID', 'DSH_FANG_FORK_ID', 'DSH_FANG_FORK', 'FANG_TASK_ID']

const DEFAULTS = Object.freeze({
  prefix: '/fang',
  taskId: '',
  auditLimit: 500,
  commandTimeoutMs: 10000,
})

export const Config = z.object({
  prefix: z.string().default('/fang')
    .description('HTTP 路由前缀（与母体 Remote 的 prefix 一致）'),
  taskId: z.string().default('')
    .description('任务 id；留空 = 环境变量 DSH_FANG_TASK_ID / forkId'),
  auditLimit: z.number().min(1).max(100000).default(500)
    .description('单次审计拉取上限（HTTP ?limit= 会被夹在此值内）'),
  commandTimeoutMs: z.number().min(1).max(600000).default(10000)
    .description('单条控制命令的硬超时（毫秒）；超时返回 code=timeout，不阻塞 HTTP'),
})

const msgOf = (e) => String(e && e.message !== undefined ? e.message : e)

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** '/fang/'、'fang' → '/fang'；空值兜底 '/fang'（与 remote.normalizePrefix 同规则）。 */
export function normalizePrefix(prefix) {
  const raw = String(prefix ?? '/fang').trim().replace(/\\/g, '/')
  if (!raw) return '/fang'
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`
  const trimmed = withSlash.replace(/\/+$/, '')
  return trimmed || '/fang'
}

function resolveTaskId(cfg = {}) {
  const explicit = typeof cfg.taskId === 'string' ? cfg.taskId.trim() : ''
  if (explicit) return explicit
  for (const key of TASK_ID_ENVS) {
    const v = process.env?.[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/**
 * 把用户给的相对路径限制在 `root` 内（拒绝 `..`、绝对路径、盘符、UNC、空路径）。
 * @returns {{ok:true, dir:string} | {ok:false, code:string, error:string}}
 */
export function resolveInside(root, relative) {
  const base = String(root ?? '').trim()
  const raw = String(relative ?? '').trim()
  if (!raw) return { ok: false, code: 'bad-request', error: 'empty-path' }
  if (raw.includes('\0')) return { ok: false, code: 'path-escape', error: 'nul-byte-in-path' }
  if (/^[A-Za-z]:/.test(raw)) return { ok: false, code: 'path-escape', error: `absolute-path:${raw}` }
  if (raw.startsWith('\\\\') || raw.startsWith('//')) {
    return { ok: false, code: 'path-escape', error: `unc-path:${raw}` }
  }
  if (path.isAbsolute(raw)) return { ok: false, code: 'path-escape', error: `absolute-path:${raw}` }
  const segments = raw.replace(/\\/g, '/').split('/')
  if (segments.some((seg) => seg === '..')) {
    return { ok: false, code: 'path-escape', error: `parent-traversal:${raw}` }
  }
  const resolvedRoot = path.resolve(base)
  const target = path.resolve(resolvedRoot, raw)
  const rel = path.relative(resolvedRoot, target)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, code: 'path-escape', error: `escapes-buffer:${raw}` }
  }
  return { ok: true, dir: target }
}

/** 二进制启发式：前 8000 字节里出现 NUL 即判二进制（文本插件源码不会含 NUL）。 */
export function looksBinary(buf) {
  if (!buf || typeof buf.length !== 'number') return false
  const end = Math.min(buf.length, 8000)
  for (let i = 0; i < end; i++) if (buf[i] === 0) return true
  return false
}

/**
 * 递归读取一个插件目录为 `{relPath: text}`。不跟随 symlink/junction（防逃逸），
 * 文件按相对路径排序，失败时返回结构化错误而不是抛。
 */
function readPluginTree(dir) {
  const files = {}
  let bytes = 0
  const stack = [{ abs: dir, rel: '' }]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current.abs, { withFileTypes: true })
    } catch (e) {
      return { ok: false, code: 'read-failed', error: `readdir-failed:${msgOf(e)}`, rel: current.rel || null }
    }
    entries.sort((a, b) => String(a.name).localeCompare(String(b.name)))
    for (const entry of entries) {
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name
      const abs = path.join(current.abs, entry.name)
      if (entry.isSymbolicLink()) continue // 链接不跟随：junction 可以指向 buffer 之外
      if (entry.isDirectory()) {
        stack.push({ abs, rel })
        continue
      }
      if (!entry.isFile()) continue
      let stat
      try {
        stat = fs.statSync(abs)
      } catch {
        continue
      }
      if (stat.size > MAX_FILE_BYTES) {
        return {
          ok: false, code: 'file-too-large', file: rel, size: stat.size, limit: MAX_FILE_BYTES,
          error: `file-too-large:${rel} (${stat.size} > ${MAX_FILE_BYTES})`,
        }
      }
      if (bytes + stat.size > MAX_TOTAL_BYTES) {
        return {
          ok: false, code: 'total-too-large', file: rel, bytes: bytes + stat.size, limit: MAX_TOTAL_BYTES,
          error: `total-too-large:${bytes + stat.size} > ${MAX_TOTAL_BYTES}`,
        }
      }
      let buf
      try {
        buf = fs.readFileSync(abs)
      } catch (e) {
        return { ok: false, code: 'read-failed', error: `read-failed:${rel}:${msgOf(e)}`, file: rel }
      }
      if (looksBinary(buf)) {
        return { ok: false, code: 'binary-file', file: rel, error: `binary-file:${rel}` }
      }
      bytes += buf.length
      files[rel] = buf.toString('utf8')
    }
  }
  return { ok: true, files, count: Object.keys(files).length, bytes }
}

export function apply(ctx, config) {
  const gate = roleGate('adapter', { logger: ctx.logger })
  if (!gate.active) return

  // schemastery 的 Config({}) 负责填默认值；后面再叠一层裸对象，宿主/测试绕过 schema 也不炸。
  let configDefaults = {}
  try {
    configDefaults = Config({}) ?? {}
  } catch {
    configDefaults = {}
  }
  const cfg = { ...DEFAULTS, ...configDefaults, ...(config ?? {}) }

  const prefix = normalizePrefix(cfg.prefix)
  const taskId = resolveTaskId(cfg)
  const auditLimit = clampInt(cfg.auditLimit, 1, 100000, DEFAULTS.auditLimit)
  const commandTimeoutMs = clampInt(cfg.commandTimeoutMs, 1, 600000, DEFAULTS.commandTimeoutMs)
  const role = gate.role
  const startedAt = nowMs()

  let layout = null
  try {
    layout = resolveFangLayout()
  } catch {
    layout = null
  }

  let archivedAt = null

  // ── 基础设施（全部容错：任何依赖缺失都不得让 HTTP 处理器抛出）──────────────
  const safeGet = (key) => {
    try {
      return ctx.get(key)
    } catch {
      return undefined
    }
  }
  const hasService = (key, method) => {
    const svc = safeGet(key)
    if (!svc) return false
    return method ? typeof svc[method] === 'function' : true
  }
  const unavailable = () => ({ ok: false, code: 'service-unavailable', error: 'service-unavailable' })
  const badRequest = (error) => ({ ok: false, code: 'bad-request', error: String(error ?? 'bad-request') })
  const emit = (topic, payload) => {
    try {
      bus.emit(topic, payload)
    } catch {
      /* bus 只做通知，失败不影响命令 */
    }
  }
  const appendAudit = (kind, data) => {
    try {
      const auditor = safeGet(SERVICE.auditor)
      if (auditor && typeof auditor.append === 'function') auditor.append(kind, data)
    } catch {
      /* 审计失败不得阻塞控制面 */
    }
  }

  /** 本分身自己的 buffer 根目录：优先 BufferKeeper 真实目录，其次布局默认值。 */
  const bufferDir = () => {
    const buffer = safeGet(SERVICE.buffer)
    try {
      if (buffer && typeof buffer.dir === 'string' && buffer.dir) return path.resolve(buffer.dir)
    } catch {
      /* getter 抛错则继续降级 */
    }
    try {
      const state = buffer && typeof buffer.state === 'function' ? buffer.state() : null
      if (state && typeof state.dir === 'string' && state.dir) return path.resolve(state.dir)
    } catch {
      /* ignore */
    }
    const fallback = layout?.bufferDir
    return fallback ? path.resolve(fallback) : ''
  }

  const bufferView = () => {
    const buffer = safeGet(SERVICE.buffer)
    try {
      const state = buffer && typeof buffer.state === 'function' ? buffer.state() : null
      if (state && typeof state === 'object') {
        return {
          state: typeof state.state === 'string' ? state.state : 'unknown',
          pending: Array.isArray(state.pending) ? [...state.pending] : [],
          dir: typeof state.dir === 'string' ? state.dir : bufferDir(),
        }
      }
    } catch {
      /* ignore */
    }
    return { state: 'unavailable', pending: [], dir: bufferDir() }
  }

  /** null = approver 服务缺失；[] = 服务在但没有待办（两者语义不同）。 */
  const approvalItems = () => {
    const approver = safeGet(SERVICE.approver)
    if (!approver || typeof approver.pending !== 'function') return null
    try {
      const items = approver.pending()
      return Array.isArray(items) ? items : []
    } catch {
      return []
    }
  }

  const auditHead = () => {
    const auditor = safeGet(SERVICE.auditor)
    if (!auditor || typeof auditor.read !== 'function') {
      return { records: 0, head: null, degraded: 'service-unavailable' }
    }
    try {
      const records = auditor.read({ limit: Number.MAX_SAFE_INTEGER })
      const list = Array.isArray(records) ? records : []
      const last = list.length > 0 ? list[list.length - 1] : null
      let head = null
      if (last && typeof last === 'object') {
        if (typeof last.hash === 'string') head = last.hash
        else if (Number.isFinite(last.seq)) head = last.seq
      }
      return { records: list.length, head }
    } catch (e) {
      return { records: 0, head: null, degraded: `read-failed:${msgOf(e)}` }
    }
  }

  const servicesView = () => ({
    scorer: hasService(SERVICE.scorer),
    router: hasService(SERVICE.router),
    healer: hasService(SERVICE.healer),
    approver: hasService(SERVICE.approver),
    hotReloader: hasService(SERVICE.hotReloader),
    buffer: hasService(SERVICE.buffer),
    auditor: hasService(SERVICE.auditor),
    adapter: true,
  })

  // ── service 方法（HTTP 处理器与母体 Remote 共用同一实现）────────────────────

  const hello = () => ({
    ok: true,
    role,
    taskId,
    version: FANG_VERSION,
    capabilities: Object.values(ADAPTER_OP),
  })

  const status = () => {
    const items = approvalItems()
    return {
      ok: true,
      taskId,
      role,
      services: servicesView(),
      buffer: bufferView(),
      approvals: { pending: items ? items.length : 0 },
      audit: auditHead(),
      startedAt,
      archived: archivedAt !== null,
    }
  }

  const approvals = () => {
    const items = approvalItems()
    if (items === null) return { ok: false, code: 'service-unavailable', error: 'service-unavailable', items: [] }
    return { ok: true, items }
  }

  const audit = (options = {}) => {
    const opts = options && typeof options === 'object' ? options : {}
    let requested = 100
    if (opts.limit !== undefined && opts.limit !== null) {
      const n = Math.floor(Number(opts.limit))
      requested = Number.isFinite(n) ? n : 100
    }
    const limit = Math.min(Math.max(0, requested), auditLimit)
    const auditor = safeGet(SERVICE.auditor)
    if (!auditor || typeof auditor.read !== 'function') {
      return { ok: false, code: 'service-unavailable', error: 'service-unavailable', records: [] }
    }
    try {
      const records = auditor.read({ limit })
      return { ok: true, records: Array.isArray(records) ? records : [] }
    } catch (e) {
      return { ok: false, code: 'handler-threw', error: msgOf(e), records: [] }
    }
  }

  /** 读 buffer/<pluginId> 下的文本文件（契约 §5.1）。 */
  const readPlugin = (payload = {}) => {
    const pluginId = String(payload?.pluginId ?? '').trim()
    if (!pluginId) return badRequest('pluginId-required')
    const root = bufferDir()
    if (!root) return { ok: false, code: 'not-configured', error: 'buffer-root-unknown' }
    const resolved = resolveInside(root, pluginId)
    if (!resolved.ok) return resolved
    if (!exists(resolved.dir)) {
      return { ok: false, code: 'plugin-not-found', error: `plugin-not-found:${pluginId}`, pluginId }
    }
    let stat
    try {
      stat = fs.statSync(resolved.dir)
    } catch (e) {
      return { ok: false, code: 'plugin-not-found', error: `plugin-not-found:${msgOf(e)}`, pluginId }
    }
    if (!stat.isDirectory()) return badRequest(`not-a-directory:${pluginId}`)
    const tree = readPluginTree(resolved.dir)
    if (!tree.ok) return tree
    return { files: tree.files, count: tree.count, bytes: tree.bytes, pluginId }
  }

  /** 解析并（在需要时）补齐 route-confirm 的 assessment：payload 可只带 pluginId。 */
  const routeConfirmInput = (payload) => {
    const input = payload && typeof payload === 'object' ? { ...payload } : {}
    if (input.assessment || !input.pluginId) return input
    const scorer = safeGet(SERVICE.scorer)
    if (!scorer || typeof scorer.scoreDir !== 'function') return input
    const root = bufferDir()
    const resolved = root ? resolveInside(root, String(input.pluginId)) : { ok: false }
    if (!resolved.ok || !exists(resolved.dir)) return input
    try {
      input.assessment = scorer.scoreDir(resolved.dir)
    } catch {
      /* assessment 可缺省：Router.confirm 应自行降级 */
    }
    return input
  }

  const flushBuffer = async (payload) => {
    const buffer = safeGet(SERVICE.buffer)
    if (!buffer || typeof buffer.flush !== 'function') return unavailable()
    let opts = {}
    if (payload && typeof payload === 'object') {
      opts = payload.strictMs !== undefined ? { strictMs: payload.strictMs } : { ...payload }
    }
    const result = await buffer.flush(opts)
    if (result && typeof result === 'object') return result
    return { state: 'unknown', flushed: [], timedOut: false }
  }

  /**
   * 控制命令分发表。每个 handler 返回「结果对象」；返回 `{ok:false, code}` 时作为
   * 失败信封传播（依赖服务缺失 / 参数非法 / 路径逃逸…）。
   */
  const HANDLERS = new Map([
    [ADAPTER_OP.PING, () => ({ pong: true, at: iso(), pid: process.pid, taskId, uptimeMs: nowMs() - startedAt })],

    [ADAPTER_OP.STATUS, () => status()],

    [ADAPTER_OP.FLUSH_BUFFER, (payload) => flushBuffer(payload)],

    [ADAPTER_OP.SCORE_PLUGIN, (payload) => {
      const scorer = safeGet(SERVICE.scorer)
      if (!scorer || typeof scorer.scoreDir !== 'function') return unavailable()
      const pluginId = String(payload?.pluginId ?? '').trim()
      if (!pluginId) return badRequest('pluginId-required')
      const root = bufferDir()
      if (!root) return { ok: false, code: 'not-configured', error: 'buffer-root-unknown' }
      const resolved = resolveInside(root, pluginId)
      if (!resolved.ok) return resolved
      if (!exists(resolved.dir)) {
        return { ok: false, code: 'plugin-not-found', error: `plugin-not-found:${pluginId}`, pluginId }
      }
      try {
        const assessment = scorer.scoreDir(resolved.dir)
        return { ...(assessment && typeof assessment === 'object' ? assessment : {}), pluginId, dir: resolved.dir }
      } catch (e) {
        return { ok: false, code: 'handler-threw', error: `score-failed:${msgOf(e)}` }
      }
    }],

    [ADAPTER_OP.READ_PLUGIN, (payload) => readPlugin(payload)],

    [ADAPTER_OP.ROUTE_CONFIRM, async (payload) => {
      const router = safeGet(SERVICE.router)
      if (!router || typeof router.confirm !== 'function') return unavailable()
      const out = await router.confirm(routeConfirmInput(payload))
      return out && typeof out === 'object' ? out : { route: null }
    }],

    [ADAPTER_OP.APPROVALS, () => {
      const items = approvalItems()
      if (items === null) return unavailable()
      return { items }
    }],

    [ADAPTER_OP.APPROVAL_DECIDE, (payload) => {
      const approver = safeGet(SERVICE.approver)
      if (!approver || typeof approver.decide !== 'function') return unavailable()
      const id = String(payload?.id ?? payload?.approvalId ?? '').trim()
      if (!id) return badRequest('id-required')
      const raw = payload?.outcome ?? payload?.decision
      const outcome = raw === 'approve' ? 'approved' : raw === 'deny' ? 'denied' : String(raw ?? '')
      if (outcome !== 'approved' && outcome !== 'denied') {
        return badRequest(`bad-outcome:${String(raw ?? '')}`)
      }
      const options = {
        by: String(payload?.by ?? 'adapter'),
        note: payload?.note === undefined || payload?.note === null ? null : String(payload.note),
      }
      const decided = approver.decide(id, outcome, options)
      if (decided && decided.ok === false) {
        const code = decided.reason === 'not-found' ? 'not-found'
          : decided.reason === 'bad-outcome' ? 'bad-request' : 'conflict'
        return { ok: false, code, error: String(decided.reason ?? 'decide-failed'), decided }
      }
      return decided && typeof decided === 'object' ? decided : { ok: true, id, outcome }
    }],

    [ADAPTER_OP.ARCHIVE, async (payload) => {
      // archive 的语义是「flush + 归档标记」，buffer 是必需依赖；进程 kill 由母体做。
      const flushed = await flushBuffer(payload?.flushOpts ?? {})
      if (flushed && flushed.ok === false && flushed.code === 'service-unavailable') return flushed
      archivedAt = nowMs()
      appendAudit(AUDIT.TASK_ARCHIVED, {
        taskId,
        archivedAt: iso(archivedAt),
        flushed: Array.isArray(flushed?.flushed) ? flushed.flushed : [],
      })
      emit('fang/task-archived', { taskId })
      return {
        archived: true,
        archivedAt,
        flushed: Array.isArray(flushed?.flushed) ? flushed.flushed : [],
      }
    }],
  ])

  /** 给命令套一个硬超时：handler 悬挂时也返回 timeout，而不是让 HTTP 挂着。 */
  const withTimeout = (promise, timeoutMs) => {
    if (!(timeoutMs > 0)) return Promise.resolve(promise)
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve({ __timeout: true })
      }, timeoutMs)
      Promise.resolve(promise).then(
        (value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        },
        (err) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ ok: false, code: 'handler-threw', error: msgOf(err) })
        },
      )
    })
  }

  async function command(input = {}) {
    const request = input && typeof input === 'object' ? input : {}
    const op = String(request.op ?? '').trim()
    const payload = request.payload && typeof request.payload === 'object' ? request.payload : {}
    if (!op) {
      const envelope = { ok: false, op: '', error: 'missing-op', code: 'bad-request' }
      emit('fang/adapter-command', { op: '', ok: false, code: envelope.code })
      return envelope
    }
    const handler = HANDLERS.get(op)
    if (!handler) {
      const envelope = { ok: false, op, error: `unknown-op:${op}`, code: 'unknown-op' }
      emit('fang/adapter-command', { op, ok: false, code: envelope.code })
      return envelope
    }

    let raw
    try {
      raw = await withTimeout(handler(payload), commandTimeoutMs)
    } catch (e) {
      raw = { ok: false, code: 'handler-threw', error: msgOf(e) }
    }
    if (raw && typeof raw === 'object' && raw.__timeout === true) {
      const envelope = { ok: false, op, error: 'command-timeout', code: 'timeout' }
      emit('fang/adapter-command', { op, ok: false, code: envelope.code })
      return envelope
    }
    if (raw && typeof raw === 'object' && raw.ok === false) {
      const envelope = {
        ok: false,
        op,
        error: String(raw.error ?? raw.reason ?? 'command-failed'),
        code: String(raw.code ?? 'conflict'),
        result: raw,
      }
      emit('fang/adapter-command', { op, ok: false, code: envelope.code })
      return envelope
    }
    emit('fang/adapter-command', { op, ok: true, taskId })
    return { ok: true, op, result: raw === undefined ? null : raw }
  }

  const service = {
    role,
    taskId,
    version: FANG_VERSION,
    /** 已注册的 HTTP 路径（测试用；无 webServer 时为空数组）。 */
    routes: [],

    hello,
    status,
    approvals,
    audit,
    command,
  }

  ctx.effect(() => ctx.provide(SERVICE.adapter, service))

  // ── HTTP 路由（处理器与 service 共用上面的实现）────────────────────────────
  const json = (res, code, obj) => {
    try {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    } catch {
      /* 假 res / 已写头的 res 都不能把处理器打挂 */
    }
    try {
      res.end(JSON.stringify(obj))
    } catch {
      /* 同上 */
    }
  }

  /** HTTP 状态码映射（契约 §5.1：405/400/409/500）。 */
  const statusForCode = (code) => {
    switch (String(code ?? '')) {
      case 'bad-request':
      case 'unknown-op':
      case 'missing-op':
      case 'invalid-json':
      case 'path-escape':
      case 'file-too-large':
      case 'total-too-large':
      case 'binary-file':
      case 'body-too-large':
        return 400
      case 'service-unavailable':
      case 'not-found':
      case 'plugin-not-found':
      case 'not-configured':
      case 'conflict':
      case 'timeout':
      case 'not-pending':
        return 409
      case 'handler-threw':
        return 500
      default:
        return 500
    }
  }

  /** 读取 JSON 请求体；不抛，返回 {body} 或 {error}。 */
  const readJsonBody = (req) => new Promise((resolve) => {
    let raw = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      req.on('data', (chunk) => {
        if (settled) return
        raw += chunk
        if (raw.length > 1_000_000) {
          finish({ error: 'body-too-large' })
          try {
            req.destroy()
          } catch {
            /* ignore */
          }
        }
      })
      req.on('end', () => {
        if (settled) return
        if (!raw.trim()) return finish({ body: {} })
        try {
          finish({ body: JSON.parse(raw) })
        } catch {
          finish({ error: 'invalid-json' })
        }
      })
      req.on('error', () => finish({ error: 'request-error' }))
    } catch (e) {
      finish({ error: msgOf(e) })
    }
  })

  /** 从原始 req.url 解析 ?limit=（测试里 req.url 可能是 undefined，缺省走 100）。 */
  const parseLimit = (rawUrl) => {
    const s = String(rawUrl ?? '')
    const m = /[?&]limit=([^&#]+)/.exec(s)
    if (!m) return undefined
    const n = Math.floor(Number(decodeURIComponentSafe(m[1])))
    return Number.isFinite(n) ? n : undefined
  }
  const decodeURIComponentSafe = (value) => {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }

  const registerRoutes = (webServer) => {
    const route = (method, routePath, handler) => {
      webServer.register({
        kind: 'exact',
        path: routePath,
        handler: async (req, res) => {
          const actual = String(req?.method ?? 'GET').toUpperCase()
          if (actual !== method) {
            return json(res, 405, { ok: false, code: 'method-not-allowed', error: 'method-not-allowed', path: routePath })
          }
          try {
            return await handler(req, res)
          } catch (e) {
            return json(res, 500, { ok: false, code: 'handler-threw', error: msgOf(e) })
          }
        },
      })
      service.routes.push(routePath)
    }

    const sendResult = (res, out) => json(res, out && out.ok !== false ? 200 : statusForCode(out?.code), out)

    route('GET', `${prefix}${ADAPTER_ROUTE.HELLO}`, (req, res) => json(res, 200, hello()))

    route('GET', `${prefix}${ADAPTER_ROUTE.STATUS}`, (req, res) => json(res, 200, status()))

    route('GET', `${prefix}${ADAPTER_ROUTE.APPROVALS}`, (req, res) => sendResult(res, approvals()))

    route('GET', `${prefix}${ADAPTER_ROUTE.AUDIT}`, (req, res) => {
      const limit = parseLimit(req?.url)
      return sendResult(res, audit(limit === undefined ? {} : { limit }))
    })

    route('POST', `${prefix}${ADAPTER_ROUTE.COMMAND}`, async (req, res) => {
      const parsed = await readJsonBody(req)
      if (parsed.error) {
        return json(res, 400, { ok: false, code: 'bad-request', error: parsed.error })
      }
      const out = await command(parsed.body ?? {})
      return sendResult(res, out)
    })
  }

  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (child) => {
        let webServer = null
        try {
          webServer = child?.get?.('webServer') ?? child?.webServer ?? null
        } catch {
          webServer = null
        }
        if (!webServer || typeof webServer.register !== 'function') return
        registerRoutes(webServer)
      })
    }
  } catch {
    /* webServer 不可用只意味着没有 HTTP 控制面，service 仍可被进程内调用 */
  }

  return service
}

export const _internals = {
  DEFAULTS,
  TASK_ID_ENVS,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  resolveTaskId,
  readPluginTree,
  normalizePrefix,
  resolveInside,
}
