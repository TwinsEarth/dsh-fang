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
// v2.6.1 起叠加 v3 接口（契约：docs/PROTOCOL-V3.md §4，向后兼容，旧端点全部保留）：
//
//   GET  /fang/adapter/version     协议版本协商（protocol / sessionId / capabilities）
//   GET  /fang/adapter/health      轻量健康检查（Forker.waitReady / 存活探测）
//   GET  /fang/adapter/state       完整状态快照（带 lastCursor，幂等）
//   GET  /fang/adapter/events      SSE 事件流（?since=<cursor>&session=<sid>）
//   POST /fang/adapter/commands    幂等命令信封 {commandId, op, payload, async}
//
// 认证（v3）：Forker spawn 时生成随机 token 经 env `DSH_ADAPTER_TOKEN` 注入，母体每次
// 请求带 `Authorization: Bearer <token>`；token 不落盘、不写 URL。未注入时退化为
// v2 语义（交由 DSH web 的 ?token= 守卫），以便旧分身/旧母体平滑共存。
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
import { randomBytes, timingSafeEqual } from 'node:crypto'

import {
  z,
  roleGate,
  resolveFangLayout,
  SERVICE,
  ADAPTER_OP,
  ADAPTER_ROUTE,
  ADAPTER_EVENT,
  ADAPTER_PROTOCOL_MIN,
  ADAPTER_PROTOCOL_VERSION,
  AUDIT,
  FANG_VERSION,
  bus,
  exists,
  iso,
  newId,
  nowMs,
  sampleResources,
  totalResources,
} from '../kernel/index.mjs'
import { authErrorBody, checkRequestAuth } from '../lib/http-auth.mjs'
import {
  CommandCache,
  EventLog,
  SSE_HEARTBEAT_MS,
  SSE_RETRY_FRAME,
  normalizeCommandEnvelope,
  parseBearer,
  parseCursor,
  sseComment,
  sseFrame,
  statusForAdapterError,
} from '../lib/adapter-protocol.mjs'

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
  token: '',
  eventCapacity: 1000,
  commandCacheSize: 500,
  heartbeatMs: 5000,
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
  token: z.string().default('')
    .description('v3 Bearer token；留空 = 环境变量 DSH_ADAPTER_TOKEN（Forker spawn 时注入）'),
  eventCapacity: z.number().min(1).max(100000).default(1000)
    .description('SSE 事件环形缓冲容量（母体断线后可续传的事件数）'),
  commandCacheSize: z.number().min(1).max(10000).default(500)
    .description('命令幂等缓存容量（LRU，按 commandId）'),
  heartbeatMs: z.number().min(1000).max(60000).default(5000)
    .description('SSE 心跳 + 待审批 diff 周期（毫秒）'),
  allowLegacyNoToken: z.boolean().default(false)
    .description('v3.0.5：fork 角色无 DSH_ADAPTER_TOKEN 时是否允许 v2 兼容（默认 fail-closed）'),
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

/**
 * 角色 → Web 端身份 kind（纯函数，便于测试）。
 * 母体 = mother；元宝运行态 = essence（DSH_FANG_ESSENCE 或 rt- forkId）；
 * 其余 fork 实例 = 任务分身。
 * @param {{role?:string, taskId?:string, essence?:boolean}} [input]
 * @returns {'mother'|'essence'|'fork'}
 */
export function identityKind({ role = 'fork', taskId = '', essence = false } = {}) {
  if (role === 'mother') return 'mother'
  return essence === true || String(taskId ?? '').startsWith('rt-') ? 'essence' : 'fork'
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
  const eventCapacity = clampInt(cfg.eventCapacity, 1, 100000, DEFAULTS.eventCapacity)
  const commandCacheSize = clampInt(cfg.commandCacheSize, 1, 10000, DEFAULTS.commandCacheSize)
  const heartbeatMs = clampInt(cfg.heartbeatMs, 1000, 60000, DEFAULTS.heartbeatMs)
  const role = gate.role
  const startedAt = nowMs()

  /**
   * v3 进程实例 id：只要进程重启就换一个。母体据此判断「对端是不是同一个分身」，
   * 避免把旧 cursor 用在新进程上（PROTOCOL-V3 §7.3）。
   */
  const sessionId = `s-${randomBytes(8).toString('hex')}`

  /**
   * Bearer token：显式配置 > env `DSH_ADAPTER_TOKEN`（Forker spawn 时注入，不落盘）。
   * 两者都没有 = v2 兼容模式：仍由 DSH web 自身的 ?token= 守卫，Adapter 不再加一层。
   */
  const adapterToken = (() => {
    const explicit = String(cfg.token ?? '').trim()
    if (explicit) return explicit
    const fromEnv = typeof process.env?.DSH_ADAPTER_TOKEN === 'string' ? process.env.DSH_ADAPTER_TOKEN.trim() : ''
    return fromEnv
  })()
  const expectedTokenBuf = adapterToken ? Buffer.from(adapterToken, 'utf8') : null
  // v3.0.5/B2：fork 角色无 token 时 fail-closed（v2 兼容仅限显式 allowLegacyNoToken）
  const isForkRole = role === 'fork'
  const legacyAllowed = !isForkRole || cfg.allowLegacyNoToken === true
  if (isForkRole && expectedTokenBuf === null && !legacyAllowed) {
    ctx.logger?.warn?.('[adapter] fork 角色未配置 DSH_ADAPTER_TOKEN，已按 fail-closed 拒绝控制面请求')
  }

  /** 恒定时间比较；长度不同直接 false（不泄露长度信息之外的任何东西）。 */
  const authorized = (req) => {
    if (!expectedTokenBuf) return legacyAllowed
    const got = parseBearer(req?.headers?.authorization ?? req?.headers?.Authorization)
    if (!got) return false
    const actual = Buffer.from(got, 'utf8')
    if (actual.length !== expectedTokenBuf.length) return false
    try {
      return timingSafeEqual(actual, expectedTokenBuf)
    } catch {
      return false
    }
  }

  // ── v3 状态同步基础设施：事件环形缓冲 + 订阅扇出 + 命令幂等缓存 ─────────────
  const eventLog = new EventLog({ capacity: eventCapacity, sessionId })
  const commandCache = new CommandCache({ capacity: commandCacheSize })
  const subscribers = new Set()
  const activeStreams = new Set()

  const publish = (event) => {
    let envelope = null
    try {
      envelope = eventLog.append(event)
    } catch {
      return null
    }
    for (const sink of subscribers) {
      try {
        sink(envelope)
      } catch {
        /* 单个 SSE 连接写失败不得影响其它连接与命令处理 */
      }
    }
    return envelope
  }

  const subscribe = (sink) => {
    if (typeof sink !== 'function') return () => {}
    subscribers.add(sink)
    return () => subscribers.delete(sink)
  }

  // 待审批 diff：审批项没有「requested」事件，靠 pending() 快照比对；决议有 bus 事件。
  const knownApprovals = new Map()
  const decidedOutcomes = new Map()

  const offApprovalDecided = (() => {
    try {
      if (typeof bus?.on !== 'function') return null
      return bus.on('fang/approval-decided', (payload) => {
        const id = String(payload?.id ?? payload?.approvalId ?? '').trim()
        if (!id) return
        const outcome = String(payload?.outcome ?? 'resolved')
        const verdict = outcome === 'approved' ? 'approve' : outcome === 'denied' ? 'reject' : outcome
        decidedOutcomes.set(id, verdict)
        if (knownApprovals.has(id)) {
          knownApprovals.delete(id)
          publish({ kind: ADAPTER_EVENT.APPROVAL_RESOLVED, approvalId: id, verdict })
        }
      })
    } catch {
      return null
    }
  })()
  if (typeof offApprovalDecided === 'function') {
    ctx.effect(() => () => {
      try {
        offApprovalDecided()
      } catch {
        /* ignore */
      }
    })
  }

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

  const orphanedApprovalItems = () => {
    const approver = safeGet(SERVICE.approver)
    if (!approver || typeof approver.orphaned !== 'function') return []
    try {
      const items = approver.orphaned()
      return Array.isArray(items) ? items : []
    } catch {
      return []
    }
  }

  const approvalItemsWithOrphans = () => {
    const pending = approvalItems()
    if (pending === null) return null
    return [...pending, ...orphanedApprovalItems()]
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
    umbrella: hasService(SERVICE.umbrella),
    router: hasService(SERVICE.router),
    healer: hasService(SERVICE.healer),
    approver: hasService(SERVICE.approver),
    hotReloader: hasService(SERVICE.hotReloader),
    buffer: hasService(SERVICE.buffer),
    auditor: hasService(SERVICE.auditor),
    adapter: true,
  })

  // ── v3 快照 / 健康 / 版本 / 审批 diff（docs/PROTOCOL-V3.md §5）─────────────
  const activeSessions = () => {
    const catalog = safeGet(SERVICE.sessionCatalog)
    if (!catalog || typeof catalog.list !== 'function') return null
    try {
      const list = catalog.list()
      return Array.isArray(list) ? list.length : null
    } catch {
      return null
    }
  }

  const metricsView = () => {
    let memory = null
    try {
      memory = process.memoryUsage()
    } catch {
      memory = null
    }
    let cpu = null
    try {
      const usage = process.cpuUsage()
      cpu = { userMs: Math.round(usage.user / 1000), systemMs: Math.round(usage.system / 1000) }
    } catch {
      cpu = null
    }
    return {
      rssBytes: memory?.rss ?? null,
      heapUsedBytes: memory?.heapUsed ?? null,
      handleCount: totalResources(sampleResources()),
      cpu,
      activeSessions: activeSessions(),
      pid: process.pid ?? null,
    }
  }

  /** 审批项归一化：不假设 approver.pending() 的字段全在（缺失就 null，不假装有值）。 */
  const approvalSummary = (item) => ({
    approvalId: String(item?.id ?? item?.approvalId ?? ''),
    action: String(item?.action ?? item?.summary ?? item?.reason ?? item?.title ?? ''),
    light: item?.light ?? item?.tone ?? item?.risk ?? null,
    createdAt: item?.createdAt ?? item?.at ?? null,
  })

  /** 待审批 diff → approval-requested / approval-resolved 事件（环形缓冲，SSE 顺序一致）。 */
  const syncApprovals = () => {
    const rawItems = approvalItems()
    const items = Array.isArray(rawItems) ? rawItems : []
    const seen = new Set()
    for (const item of items) {
      const summary = approvalSummary(item)
      if (!summary.approvalId) continue
      seen.add(summary.approvalId)
      if (knownApprovals.has(summary.approvalId)) continue
      knownApprovals.set(summary.approvalId, summary)
      publish({ kind: ADAPTER_EVENT.APPROVAL_REQUESTED, approval: summary })
    }
    for (const id of [...knownApprovals.keys()]) {
      if (seen.has(id)) continue
      knownApprovals.delete(id)
      const verdict = decidedOutcomes.get(id) ?? 'resolved'
      decidedOutcomes.delete(id)
      publish({ kind: ADAPTER_EVENT.APPROVAL_RESOLVED, approvalId: id, verdict })
    }
  }

  /** 完整状态快照：幂等、无 cursor 参数，母体 UI / 首帧同步用。 */
  const stateSnapshot = () => {
    const rawItems = approvalItems()
    const items = Array.isArray(rawItems) ? rawItems : []
    const buffer = bufferView()
    const audit = auditHead()
    const services = servicesView()
    return {
      ok: true,
      sessionId,
      protocolVersion: ADAPTER_PROTOCOL_VERSION,
      minProtocol: ADAPTER_PROTOCOL_MIN,
      version: FANG_VERSION,
      role,
      taskId,
      status: archivedAt !== null ? 'stopping' : 'running',
      uptimeMs: nowMs() - startedAt,
      at: nowMs(),
      metrics: metricsView(),
      services,
      plugins: Object.entries(services).map(([pluginId, present]) => ({
        pluginId,
        state: present ? 'active' : 'unavailable',
      })),
      approvals: items.map((item) => approvalSummary(item)),
      buffer: {
        state: buffer.state,
        pending: buffer.pending.length,
        dirtyFiles: buffer.pending.length,
        dir: buffer.dir,
      },
      audit: { records: audit.records, head: audit.head, degraded: audit.degraded ?? null },
      archived: archivedAt !== null,
      lastCursor: eventLog.lastCursor,
      nextCursor: eventLog.nextCursor,
    }
  }

  const versionInfo = () => ({
    ok: true,
    protocol: ADAPTER_PROTOCOL_VERSION,
    minProtocol: ADAPTER_PROTOCOL_MIN,
    version: FANG_VERSION,
    sessionId,
    taskId,
    role,
    capabilities: Object.values(ADAPTER_OP),
    at: iso(),
  })

  const health = () => ({
    ok: true,
    status: archivedAt !== null ? 'archived' : 'running',
    pid: process.pid ?? null,
    taskId,
    sessionId,
    protocol: ADAPTER_PROTOCOL_VERSION,
    uptimeMs: nowMs() - startedAt,
    archived: archivedAt !== null,
    at: iso(),
  })

  const state = () => {
    syncApprovals()
    return stateSnapshot()
  }

  /**
   * 事件续传：session 不匹配 → session-changed（母体重置 cursor）；
   * cursor 过期 → gap=true（HTTP 层回 410，母体回退到 state 快照）。
   */
  const eventsSince = (cursor, session) => {
    const sid = String(session ?? '').trim()
    if (sid && sid !== sessionId) {
      return { ok: false, code: 'session-changed', sessionId, events: [], gap: false }
    }
    const normalizedCursor = cursor === undefined || cursor === null || cursor === '' ? '0' : cursor
    const result = eventLog.since(normalizedCursor)
    if (!result.ok) return { ok: false, code: result.code, events: [], gap: false, sessionId }
    return {
      ok: true,
      events: result.events,
      gap: result.gap,
      reason: result.reason,
      lastCursor: result.lastCursor,
      nextCursor: result.nextCursor,
      sessionId,
    }
  }

  // ── service 方法（HTTP 处理器与母体 Remote 共用同一实现）────────────────────

  const hello = () => ({
    ok: true,
    role,
    taskId,    // Web 端身份徽标用：母体 / 元主（元宝运行态）/ 分身（任务）。
    // 元宝运行态由 orchestrator 注入 DSH_FANG_ESSENCE=1；旧运行态按 rt- 前缀兜底。
    kind: identityKind({ role, taskId, essence: typeof process !== 'undefined' && process.env?.DSH_FANG_ESSENCE === '1' }),
    version: FANG_VERSION,
    protocol: ADAPTER_PROTOCOL_VERSION,
    sessionId,
    capabilities: Object.values(ADAPTER_OP),
  })

  const status = () => {
    const items = approvalItems()
    return {
      ok: true,
      taskId,
      role,
      protocol: ADAPTER_PROTOCOL_VERSION,
      sessionId,
      lastCursor: eventLog.lastCursor,
      services: servicesView(),
      buffer: bufferView(),
      approvals: { pending: items ? items.length : 0 },
      audit: auditHead(),
      startedAt,
      archived: archivedAt !== null,
    }
  }

  // v3.1.14：Web 端拿不到 adapter Bearer token，身份探测走公开只读路由；
  // 只暴露 role/kind/version，不含 taskId/sessionId/token。
  const identity = () => ({
    ok: true,
    role,
    kind: identityKind({ role, taskId, essence: typeof process !== 'undefined' && process.env?.DSH_FANG_ESSENCE === '1' }),
    version: FANG_VERSION,
    protocol: ADAPTER_PROTOCOL_VERSION,
  })

  const approvals = () => {
    const items = approvalItemsWithOrphans()
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

    [ADAPTER_OP.DECISION_INGEST, async (payload) => {
      const center = safeGet(SERVICE.decisionCenter)
      if (!center || typeof center.submit !== 'function') return unavailable()
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return badRequest('payload-required')
      try {
        const out = await center.submit({ producer: 'adapter', ...payload })
        return out && typeof out === 'object' ? out : { ok: true }
      } catch (e) {
        return { ok: false, code: 'handler-threw', error: `decision-ingest-failed:${msgOf(e)}` }
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
      const items = approvalItemsWithOrphans()
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

    // 方案 A：物理分支。分身会话只存在分身自己的 DSH 进程里，母体侧够不到，
    // 所以在分身宿主内调用 sessions.fork，把子会话挂回同一分身。
    [ADAPTER_OP.FORK_SESSION, async (payload) => {
      const sessions = safeGet('sessions')
      if (!sessions || typeof sessions.fork !== 'function') {
        return { ok: false, code: 'sessions-service-unavailable', error: 'sessions.fork unavailable in this instance' }
      }
      const sourceSessionId = String(payload?.sessionId ?? '').trim()
      if (!sourceSessionId) return { ok: false, code: 'bad-session-id' }
      const boundary = payload?.boundary
      const childSessionId = String(payload?.childSessionId ?? '').trim()
      try {
        const child = childSessionId
          ? await sessions.fork(sourceSessionId, boundary, childSessionId)
          : await sessions.fork(sourceSessionId, boundary)
        const id = typeof child === 'string' ? child : (child?.id ?? child?.sessionId ?? childSessionId ?? null)
        appendAudit('fork-session', { sourceSessionId, childSessionId: id, boundary: boundary ?? null })
        return { ok: true, sourceSessionId, childSessionId: id }
      } catch (error) {
        return { ok: false, code: 'fork-failed', error: String(error?.message ?? error) }
      }
    }],
  ])

  /**
   * 外部插件注册的命令（v2.6.8）。与内置 HANDLERS 走同一条分派链：
   *   registerCommand(op, (payload, ctx) => result | {status:'accepted', trackingId})
   * - 返回普通对象 → 同步成功（HTTP 200）；
   * - 返回 {status:'accepted', trackingId} → HTTP 202，executor 自行异步执行，
   *   完成后必须通过 ctx.emit({kind:'command-done', trackingId, result}) 推送；
   * - 返回 {status:'completed'|'rejected'} → 按对应形状返回；
   * - 抛错 → handler-threw（fail-closed）。
   * 内置 op 不允许被覆盖（避免协议语义被第三方悄悄替换）。
   */
  const REGISTERED = new Map()

  const registerCommand = (op, executor) => {
    const kind = String(op ?? '').trim()
    if (!kind) throw new TypeError('registerCommand requires a non-empty op')
    if (typeof executor !== 'function') throw new TypeError('registerCommand requires a function')
    if (HANDLERS.has(kind)) throw new Error(`cannot override built-in op: ${kind}`)
    REGISTERED.set(kind, executor)
    emit('fang/adapter-command-registered', { op: kind })
    return () => {
      if (REGISTERED.get(kind) === executor) {
        REGISTERED.delete(kind)
        emit('fang/adapter-command-unregistered', { op: kind })
      }
    }
  }

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
    const builtin = HANDLERS.get(op)
    const registered = builtin ? null : REGISTERED.get(op)
    if (!builtin && !registered) {
      const envelope = { ok: false, op, error: `unknown-op:${op}`, code: 'unknown-op' }
      emit('fang/adapter-command', { op, ok: false, code: envelope.code })
      return envelope
    }

    let raw
    try {
      if (registered) {
        // 外部注册命令：executor 自己决定同步/异步，拿到 commandId/trackingId/emit 上下文。
        const execCtx = {
          commandId: String(request.commandId ?? '') || null,
          trackingId: String(request.trackingId ?? '') || (request.commandId ? `track_${String(request.commandId)}` : newId('cmd')),
          emit: (event) => publish(event),
          logger: {
            debug: (...args) => { try { ctx.logger?.debug?.(...args) } catch { /* ignore */ } },
            warn: (...args) => { try { ctx.logger?.warn?.(...args) } catch { /* ignore */ } },
          },
        }
        raw = await withTimeout(registered(payload, execCtx), commandTimeoutMs)
        if (raw && typeof raw === 'object' && raw.status === 'accepted') {
          const trackingId = String(raw.trackingId ?? execCtx.trackingId)
          const envelope = { ok: true, op, status: 'accepted', trackingId, commandId: execCtx.commandId, async: true }
          emit('fang/adapter-command', { op, ok: true, async: true, trackingId })
          return envelope
        }
        if (raw && typeof raw === 'object' && raw.status === 'completed') {
          raw = { ok: true, status: 'completed', result: raw.result === undefined ? null : raw.result }
        } else if (raw && typeof raw === 'object' && raw.status === 'rejected') {
          raw = { ok: false, code: String(raw.code ?? 'rejected'), error: String(raw.message ?? 'rejected') }
        }
      } else {
        raw = await withTimeout(builtin(payload), commandTimeoutMs)
      }
    } catch (e) {
      raw = { ok: false, code: 'handler-threw', error: msgOf(e) }
    }
    if (raw && typeof raw === 'object' && raw.__timeout === true) {
      const envelope = { ok: false, op, error: 'command-timeout', code: 'timeout' }
      emit('fang/adapter-command', { op, ok: false, code: envelope.code })
      return envelope
    }
    if (registered && raw && typeof raw === 'object' && raw.status === 'completed') {
      // 外部注册命令的 CommandResult 形状：保序返回 status/result，而不是塞进 result 字段。
      const envelope = { ok: true, op, status: 'completed', result: raw.result === undefined ? null : raw.result, commandId: String(request.commandId ?? '') || null }
      emit('fang/adapter-command', { op, ok: true })
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

  /**
   * v3 命令入口：commandId 幂等 + async 202。
   * 幂等由 `CommandCache.run()` 保证：
   *   * completed 命中 → 直接重放第一次的响应（不重复执行副作用）；
   *   * running 命中（同一 commandId 并发提交）→ 等待同一个 promise，不会执行两次；
   *   * 未命中 → 执行并把结果落缓存；fn 抛错（传输/编程错误）不缓存，允许重试。
   * async 语义：立刻返回 {status:'accepted', trackingId}，进度/结果走 SSE
   * 的 command-done 事件；accepted 本身也进缓存，重复提交返回同一个 trackingId。
   */
  async function commands(input = {}) {
    const normalized = normalizeCommandEnvelope(input)
    if (!normalized.ok) {
      return { ok: false, code: normalized.code, error: normalized.error, commandId: normalized.commandId ?? '' }
    }
    const { commandId, op, payload, async: isAsync } = normalized
    // 外部注册命令由 executor 自己决定同步/异步；通用 async 标志只作用于内置 op。
    const isRegistered = REGISTERED.has(op)

    // 无 commandId = 不幂等（兼容 v2 用法），直接执行。
    if (!commandId) {
      if (isAsync && !isRegistered) {
        const trackingId = newId('cmd')
        void Promise.resolve()
          .then(() => command({ op, payload }))
          .then((result) => publish({ kind: ADAPTER_EVENT.COMMAND_DONE, trackingId, op, result }))
          .catch((e) => publish({ kind: ADAPTER_EVENT.ERROR, code: 'handler-threw', message: msgOf(e), trackingId, op }))
        return { ok: true, status: 'accepted', trackingId, op, commandId: null, async: true }
      }
      const result = await command({ op, payload })
      if (result && result.status === 'accepted') return { ...result, commandId: null }
      publish({ kind: ADAPTER_EVENT.COMMAND, op, ok: result.ok !== false, code: result.code ?? null, commandId: null })
      return { ...result, commandId: null }
    }

    let executed = false
    const envelope = await commandCache.run(commandId, async () => {
      executed = true
      if (isAsync && !isRegistered) {
        return { ok: true, status: 'accepted', trackingId: commandId, op, commandId, async: true }
      }
      const result = await command({ op, payload, commandId })
      return { ...result, commandId }
    })

    if (executed) {
      if (envelope && envelope.status === 'accepted') {
        // 外部注册命令的 accepted：executor 负责异步执行并通过 ctx.emit 推 command-done，
        // 这里不再二次调度（否则会执行两遍）。
        return envelope
      }
      if (isAsync && !isRegistered) {
        // 内置异步命令：结果通过事件返回；缓存里保留 accepted（重放仍是同一个 trackingId）。
        void Promise.resolve()
          .then(() => command({ op, payload }))
          .then((result) => publish({ kind: ADAPTER_EVENT.COMMAND_DONE, trackingId: commandId, op, result }))
          .catch((e) => publish({ kind: ADAPTER_EVENT.ERROR, code: 'handler-threw', message: msgOf(e), trackingId: commandId, op }))
      } else {
        publish({ kind: ADAPTER_EVENT.COMMAND, op, ok: envelope.ok !== false, code: envelope.code ?? null, commandId })
      }
      return envelope
    }
    return { ...envelope, deduplicated: true }
  }

  const service = {
    role,
    taskId,
    version: FANG_VERSION,
    protocol: ADAPTER_PROTOCOL_VERSION,
    sessionId,
    /** 是否启用了 v3 Bearer 认证（false = v2 兼容模式）。 */
    authEnabled: expectedTokenBuf !== null,
    /** 已注册的 HTTP 路径（测试用；无 webServer 时为空数组）。 */
    routes: [],

    hello,
    status,
    approvals,
    audit,
    command,
    commands,
    registerCommand,
    registeredCommands: () => [...REGISTERED.keys()],
    versionInfo,
    health,
    state,
    eventsSince,
    lastCursor: () => eventLog.lastCursor,
  }

  ctx.effect(() => ctx.provide(SERVICE.adapter, service))

  // 插件卸载：关掉所有 SSE 长连接，清空订阅与幂等缓存（不留悬挂定时器/引用）。
  ctx.effect(() => () => {
    for (const close of [...activeStreams]) {
      try {
        close()
      } catch {
        /* ignore */
      }
    }
    subscribers.clear()
    commandCache.clear()
  })

  // ── HTTP 路由（处理器与 service 共用上面的实现）────────────────────────────
  const json = (res, code, obj) => {
    try {
      if (!res.headersSent) {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      }
    } catch {
      /* 假 res / 已写头的 res 都不能把处理器打挂 */
    }
    try {
      if (!res.writableEnded) res.end(JSON.stringify(obj))
    } catch {
      /* 同上 */
    }
  }

  /** 错误码 → HTTP 状态码：唯一来源是 kernel 的 ADAPTER_ERROR_STATUS（PROTOCOL-V3 §8）。 */
  const statusForCode = (code) => statusForAdapterError(code)

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

  /** 极简 query 解析（不依赖 URL 解析器，req.url 在测试里可能是 undefined）。 */
  const parseQuery = (rawUrl) => {
    const out = {}
    const text = String(rawUrl ?? '')
    const at = text.indexOf('?')
    if (at < 0) return out
    for (const pair of text.slice(at + 1).split('&')) {
      if (!pair) continue
      const eq = pair.indexOf('=')
      const key = decodeURIComponentSafe(eq < 0 ? pair : pair.slice(0, eq))
      const value = eq < 0 ? '' : decodeURIComponentSafe(pair.slice(eq + 1))
      if (!(key in out)) out[key] = value
    }
    return out
  }

  const registerRoutes = (webServer) => {
    // v3.1.14：浏览器无法持有 adapter Bearer token；身份探测必须是公开只读路由。
    // 服务端仍只监听 loopback，且返回值不含 taskId/token（见 identity()）。
    webServer.register({
      kind: 'exact',
      path: `${prefix}${ADAPTER_ROUTE.IDENTITY}`,
      method: 'GET',
      handler: (req, res) => json(res, 200, identity()),
    })
    try { service.routes.push(`${prefix}${ADAPTER_ROUTE.IDENTITY}`) } catch { /* fake ws */ }
    const route = (method, routePath, handler) => {
      webServer.register({
        kind: 'exact',
        path: routePath,
        method,
        handler: async (req, res) => {
          const actual = String(req?.method ?? 'GET').toUpperCase()
          // Same perimeter as /fang/api/*: loopback Host, Origin/Sec-Fetch-Site,
          // adapter Bearer token, JSON-only writes. Auth before method (401 not 405).
          const decision = checkRequestAuth(req, {
            token: adapterToken,
            // v2 compatibility (explicit allowLegacyNoToken) is the only case where
            // the token comparison is skipped; Host/Origin/CSRF still apply.
            publicRoute: adapterToken.length === 0 && legacyAllowed,
          })
          if (!decision.ok) {
            return json(res, decision.status, { ...authErrorBody(decision), path: routePath })
          }
          if (!['GET', 'HEAD', 'OPTIONS'].includes(actual)) {
            const contentType = String(req?.headers?.['content-type'] ?? '').toLowerCase()
            if (contentType && !contentType.includes('application/json')) {
              return json(res, 415, { ok: false, code: 'content-type-required', error: 'content-type-required', path: routePath })
            }
          }
          if (!authorized(req)) {
            return json(res, 401, { ok: false, code: 'unauthorized', error: 'unauthorized', path: routePath })
          }
          if (actual !== method) {
            try { res.setHeader?.('allow', method) } catch { /* fake res */ }
            return json(res, 405, { ok: false, code: 'method-not-allowed', error: 'method-not-allowed', path: routePath })
          }
          try {
            return await handler(req, res)
          } catch (e) {
            if (res?.headersSent) {
              try {
                res.end()
              } catch {
                /* ignore */
              }
              return undefined
            }
            return json(res, 500, { ok: false, code: 'handler-threw', error: msgOf(e) })
          }
        },
      })
      service.routes.push(routePath)
    }

    const sendResult = (res, out) => json(res, out && out.ok !== false ? 200 : statusForCode(out?.code), out)

    // ── v2 五条（PROTOCOL-V2 §3，保留）─────────────────────────────────────
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
        const code = parsed.error === 'body-too-large' ? 'body-too-large' : 'bad-request'
        return json(res, statusForCode(code), { ok: false, code, error: parsed.error })
      }
      const out = await command(parsed.body ?? {})
      return sendResult(res, out)
    })

    // ── v3 五条（PROTOCOL-V3 §4）──────────────────────────────────────────
    route('GET', `${prefix}${ADAPTER_ROUTE.VERSION}`, (req, res) => json(res, 200, versionInfo()))

    route('GET', `${prefix}${ADAPTER_ROUTE.HEALTH}`, (req, res) => json(res, 200, health()))

    route('GET', `${prefix}${ADAPTER_ROUTE.STATE}`, (req, res) => json(res, 200, state()))

    route('POST', `${prefix}${ADAPTER_ROUTE.COMMANDS}`, async (req, res) => {
      const parsed = await readJsonBody(req)
      if (parsed.error) {
        const code = parsed.error === 'body-too-large' ? 'body-too-large' : 'bad-request'
        return json(res, statusForCode(code), { ok: false, code, error: parsed.error })
      }
      const out = await commands(parsed.body ?? {})
      if (out && out.ok === false) return json(res, statusForCode(out.code), out)
      if (out && out.status === 'accepted') return json(res, 202, out)
      return json(res, 200, out)
    })

    /**
     * SSE 长连接：鉴权由 route 包装器统一处理；session 不匹配 = 409，cursor 过期 = 410。
     * 先回放环形缓冲，再挂订阅；心跳注释帧每 heartbeatMs 一次（同时驱动审批 diff）。
     */
    route('GET', `${prefix}${ADAPTER_ROUTE.EVENTS}`, async (req, res) => {
      const query = parseQuery(req?.url)
      const since = query.since
      const session = query.session
      if (session && session !== sessionId) {
        return json(res, 409, { ok: false, code: 'session-changed', error: 'session-changed', sessionId })
      }
      syncApprovals()
      const replay = eventsSince(since, session)
      if (replay.ok === false) return json(res, statusForCode(replay.code), replay)
      if (replay.gap) {
        return json(res, 410, {
          ok: false,
          code: 'cursor-expired',
          error: 'cursor-expired',
          sessionId,
          lastCursor: replay.lastCursor,
          nextCursor: replay.nextCursor,
        })
      }

      try {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
      } catch {
        /* 假 res 的 writeHead 也能工作；真实 res 这里不应抛 */
      }

      const write = (chunk) => {
        try {
          if (!res.writableEnded) res.write(chunk)
        } catch {
          /* 连接已断，等 close 回调清理 */
        }
      }

      write(SSE_RETRY_FRAME)
      write(sseComment('connected'))
      for (const envelope of replay.events) write(sseFrame(envelope))

      const off = subscribe((envelope) => write(sseFrame(envelope)))
      const heartbeat = setInterval(() => {
        syncApprovals()
        write(sseComment('heartbeat'))
      }, heartbeatMs)
      if (typeof heartbeat.unref === 'function') heartbeat.unref()

      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        off()
        activeStreams.delete(close)
        try {
          if (!res.writableEnded) res.end()
        } catch {
          /* ignore */
        }
      }
      activeStreams.add(close)
      try {
        req?.on?.('close', close)
        req?.on?.('aborted', close)
        res?.on?.('close', close)
        res?.on?.('error', close)
      } catch {
        /* ignore */
      }
      return undefined
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
  ADAPTER_PROTOCOL_VERSION,
  ADAPTER_PROTOCOL_MIN,
  resolveTaskId,
  readPluginTree,
  normalizePrefix,
  resolveInside,
}
