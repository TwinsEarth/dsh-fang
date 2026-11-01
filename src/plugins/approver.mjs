// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang v2.0.0 — 2.4 审批子插件（T3/T9）
//
// 职责（四件能力，契约见 docs/CONTRACTS.md §5.7 与 §6；v2 增量见 CONTRACTS-V2.md §5.7）：
//   1) 待批队列：request() 返回 Promise，只有 decide() 或 TTL 到期（fail-closed → 'timeout'）才 resolve；
//   2) A/B 双备：snapshot() 把目录内容复制到 <dataDir>/snapshots/<tag>/A（新）与 /B（上一代），
//      对复制出的内容做内容寻址 sha256 digest；rollback() 用快照覆盖回目标目录并校验 digest；
//   3) 监控：monitor({label,value,threshold}) 采样，越阈值返回 alert:true 并留痕；
//   4) 回滚 + 保留文件桥：dataDir 下的 command/answer/pending/status json 供 CLI 驱动（轮询式）。
//
// v2.0.0（双侧语义，CONTRACTS-V2.md §1/§5.7）：
//   * apply 首行 roleGate('approver')；approver 在 mother/fork 两侧都激活，service.scope 给出实际角色；
//   * mother 侧只处理晋升/重启：requestPromotion() / requestRestart() 是固定红灯的语义化包装；
//   * summary({remotes}) 并发汇总本地待批 + 各分身 fetchApprovals()，单个 remote 失败不阻塞；
//   * fork 侧仍用通用 request()/decide() 处理任务内黄/红灯动作（v1 行为不变）。
//
// 硬约束：
//   * strictRedLine=true 时 risk==='red' 必须显式 decide()，authMode='auto' 不能绕过（fail-closed）；
//   * 所有落盘走 kernel fsx（writeJsonAtomic / appendJsonl / copyTree / removeTree / ensureDir）；
//   * 定时器与轮询监听全部登记在 ctx.effect 上，dispose 时清理，未决请求按 timeout 结算；
//   * 决策后 emit kernel bus 'fang/approval-decided' 并 append 审计（auditor 可能未装载 → 静默容错）。
//
// 明确降级（NOT ESTABLISHED）：
//   * authMode='timed' 的 grants（限时授权/临时授权）未实现，按 manual 处理（fail-closed）；
//   * 快照只保留一代 B（A=最新，B=上一次），不做多代历史；不跟随 junction（copyTree 只重建链接）；
//   * monitor 为单点采样（不做内部定时 getter 轮询），轮询由调用方/CLI 决定；
//   * requestPromotion/requestRestart 不做"仅母体可调用"的硬拒绝（语义约定，非门禁）。
import path from 'node:path'
import {
  AUDIT,
  SERVICE,
  appendJsonl,
  bus,
  copyTree,
  digestTree,
  ensureDir,
  exists,
  iso,
  newId,
  nowMs,
  readTextSafe,
  removeTree,
  resolveFangLayout,
  roleGate,
  sha256,
  writeJsonAtomic,
  z,
} from '../kernel/index.mjs'

export const name = 'fang-approver'
/** 审批对 auditor 是软依赖（审计器可能晚于/未装载）：不写 inject，读的时候 safeGet + 可选链。 */
export const inject = []

export const Config = z.object({
  dataRoot: z.string().default('')
    .description('Fang 数据根目录；留空 = resolveFangLayout() 的默认 $DSH_HOME/fang/<profile>'),
  defaultTtlMs: z.number().min(100).default(300000)
    .description('待批项默认 TTL（毫秒）；到期 fail-closed 记为 timeout'),
  remindAt: z.number().min(0).max(1).default(0.5)
    .description('在 TTL 的这个比例处标记提醒（0–1；只落状态，不自动放行）'),
  authMode: z.union([z.const('manual'), z.const('auto'), z.const('timed')]).default('manual')
    .description('manual 全人工 / auto 非红自动放行（stricted 红仍人工）/ timed 未实现，按 manual'),
  strictRedLine: z.boolean().default(true)
    .description('红灯必须人工显式 decide；即使 authMode=auto'),
  backupRoot: z.string().default('')
    .description('快照根目录；留空 = <dataDir>/snapshots（默认布局）'),
  fileBridgePollMs: z.number().min(10).default(300)
    .description('文件桥（command/answer json）轮询间隔（毫秒）'),
  role: z.union([z.const('mother'), z.const('fork')]).default('mother')
    .description('部署角色（v2 §1）；DSH_FANG_ROLE 环境变量优先级更高（forker 启动分身时注入）'),
}).description('dsh-Fang 审批子插件配置（契约 §5.7）')

const DEFAULTS = Object.freeze({
  dataRoot: '',
  defaultTtlMs: 300000,
  remindAt: 0.5,
  authMode: 'manual',
  strictRedLine: true,
  backupRoot: '',
  fileBridgePollMs: 300,
  role: 'mother',
})

/** 契约 §5.7 只允许这两种人工结论；'timeout' 由 TTL/卸载路径给出。 */
const DECIDABLE_OUTCOMES = Object.freeze(['approved', 'denied'])
const RISK_VALUES = Object.freeze(['blue', 'yellow', 'red'])
const AUTH_MODES = Object.freeze(['manual', 'auto', 'timed'])

const EVENT_APPROVAL_DECIDED = 'fang/approval-decided'
/** kernel types.mjs 里的键名是 `SNapshot_CREATED`（历史拼写），用字符串访问避免抄错。 */
const AUDIT_SNAPSHOT_CREATED = AUDIT['SNapshot_CREATED']

/** 文件桥文件名（保留 dsh-hot-update/packages/approval 的命名，便于 CLI 平滑迁移）。 */
const BRIDGE = Object.freeze({
  command: 'dsh-approval-command.json',
  answer: 'dsh-approval-answer.json',
  pending: 'dsh-approval-pending.json',
  status: 'dsh-approval-status.json',
})
/** 决策流水（appendJsonl，只增不改；status() 的 decisions 计数从内存历史来）。 */
const DECISIONS_FILE = 'dsh-approval-decisions.jsonl'

function clamp01(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return DEFAULTS.remindAt
  return Math.min(1, Math.max(0, v))
}

function positiveNumber(n, fallback) {
  const v = Number(n)
  return Number.isFinite(v) && v > 0 ? v : fallback
}

/** 归一化 config：测试/宿主都可能绕过 schemastery 直接传裸对象，这里不抛错、全量兜底。 */
function normalizeConfig(config) {
  const input = config && typeof config === 'object' ? config : {}
  return {
    dataRoot: typeof input.dataRoot === 'string' ? input.dataRoot : DEFAULTS.dataRoot,
    defaultTtlMs: positiveNumber(input.defaultTtlMs, DEFAULTS.defaultTtlMs),
    remindAt: clamp01(input.remindAt ?? DEFAULTS.remindAt),
    authMode: AUTH_MODES.includes(String(input.authMode)) ? String(input.authMode) : DEFAULTS.authMode,
    strictRedLine: input.strictRedLine === undefined ? DEFAULTS.strictRedLine : input.strictRedLine !== false,
    backupRoot: typeof input.backupRoot === 'string' ? input.backupRoot : DEFAULTS.backupRoot,
    fileBridgePollMs: positiveNumber(input.fileBridgePollMs, DEFAULTS.fileBridgePollMs),
    role: input.role === 'fork' ? 'fork' : 'mother',
  }
}

/** tag 会被用作目录名（可能来自 CLI），必须挡掉路径穿越字符。 */
function safeTag(raw) {
  const s = String(raw ?? '').trim()
  const cleaned = s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[.]+/, '').slice(0, 64)
  return cleaned || 'snap'
}

/** 内容寻址 digest：按相对路径排序后对 (rel\0contentHash) 串做 sha256，跨平台稳定。 */
function digestOf(dir) {
  const tree = digestTree(dir)
  const keys = Object.keys(tree).sort()
  const lines = keys.map(rel => `${rel}\u0000${tree[rel]}`)
  return { digest: sha256(lines.join('\n')), files: keys.length }
}

function normalizeThreshold(threshold) {
  if (typeof threshold === 'number') {
    return Number.isFinite(threshold) ? { op: '>', value: threshold } : null
  }
  if (threshold && typeof threshold === 'object') {
    const value = Number(threshold.value)
    if (!Number.isFinite(value)) return null
    const op = ['>', '>=', '<', '<='].includes(String(threshold.op)) ? String(threshold.op) : '>'
    return { op, value }
  }
  return null
}

function thresholdHit(value, threshold) {
  if (!threshold) return false
  if (threshold.op === '>') return value > threshold.value
  if (threshold.op === '>=') return value >= threshold.value
  if (threshold.op === '<') return value < threshold.value
  return value <= threshold.value
}

export function apply(ctx, config) {
  // v2 §1：角色门禁必须是 apply 的第一件事；未部署到该角色时不注册服务/定时器/文件桥。
  const gate = roleGate('approver', {
    cfgRole: config && typeof config === 'object' ? config.role : '',
    logger: ctx.logger,
  })
  if (!gate.active) return null
  const scope = gate.role
  const cfg = normalizeConfig(config)
  const layout = resolveFangLayout({ dataRoot: cfg.dataRoot })
  const dataDir = layout.dataDir
  const snapshotsRoot = cfg.backupRoot ? path.resolve(cfg.backupRoot) : layout.snapshotsDir
  const bridgePaths = {
    command: path.join(dataDir, BRIDGE.command),
    answer: path.join(dataDir, BRIDGE.answer),
    pending: path.join(dataDir, BRIDGE.pending),
    status: path.join(dataDir, BRIDGE.status),
  }
  const decisionsFile = path.join(dataDir, DECISIONS_FILE)

  /** id → item（结案后保留一小段用于幂等判定，超过上限再修剪）。 */
  const queue = new Map()
  /** 决策历史（后 10 条同时写进 status 文件；全量追加 decisions.jsonl）。 */
  const decisions = []
  /** tag → {tag, A:{dir,digest,at,files}, B:{...}|null} */
  const snapshots = new Map()
  /** label → {label, samples:[{at,value}], min, max, last, alerts:[], threshold} */
  const monitors = new Map()
  /** 所有 TTL/提醒定时器，dispose 时统一清理。 */
  const timers = new Set()
  let disposed = false
  /** 发生过任何业务动作才允许落盘 —— `apply(makeCtx())` 本身不产生任何 profile 写入。 */
  let touched = false

  // ───────── 基础设施：日志 / 审计 / 状态落盘 ─────────

  const logger = (level, message) => {
    try { ctx.logger?.[level]?.(message) } catch { /* logger 不可用不打断审批 */ }
  }
  const safeGet = (key) => {
    try { return ctx.get(key) } catch { return undefined }
  }
  /** 审计器可能未装载：不 throw、不阻塞决策。 */
  const audit = (kind, data) => {
    try {
      const auditor = safeGet(SERVICE.auditor)
      if (auditor && typeof auditor.append === 'function') auditor.append(kind, data)
    } catch (e) {
      logger('debug', `[fang-approver] audit skipped: ${String(e?.message ?? e)}`)
    }
  }

  const publicItem = (item) => ({
    id: item.id,
    kind: item.kind,
    risk: item.risk,
    title: item.title,
    detail: item.detail,
    impact: item.impact,
    taskId: item.taskId ?? null,
    pluginId: item.pluginId ?? null,
    createdAt: item.createdAt,
    deadlineAt: item.deadlineAt,
    state: item.state,
    reminded: item.reminded === true,
  })

  const monitorView = (rec, { sampleLimit = 20 } = {}) => ({
    label: rec.label,
    samples: rec.samples.length,
    last: rec.last,
    min: rec.min,
    max: rec.max,
    threshold: rec.threshold ? { ...rec.threshold } : null,
    alerts: rec.alerts.slice(-5),
    recent: rec.samples.slice(-sampleLimit),
  })

  const snapshotView = (rec, { short = false } = {}) => {
    const fmt = (slot) => slot
      ? { digest: short ? slot.digest.slice(0, 16) : slot.digest, at: slot.at, files: slot.files }
      : null
    return { tag: rec.tag, A: fmt(rec.A), B: fmt(rec.B) }
  }

  const pendingItems = () => [...queue.values()].filter(item => item.state === 'pending').map(publicItem)

  /** 把状态同步到 dataDir 的 pending/status 文件（文件桥）。任何异常都只记日志。 */
  const persist = () => {
    if (!touched) return // apply 本身不落盘，避免污染 profile
    const at = iso()
    const pending = pendingItems()
    const decided = decisions.slice(-10)
    const statusDoc = {
      at,
      dataDir,
      snapshotsRoot,
      counts: {
        pending: pending.length,
        snapshots: snapshots.size,
        monitors: monitors.size,
        decisions: decisions.length,
      },
      pending,
      decided,
      snapshots: [...snapshots.values()].map(rec => snapshotView(rec, { short: true })),
      monitors: [...monitors.values()].map(rec => monitorView(rec, { sampleLimit: 5 })),
      policy: { authMode: cfg.authMode, strictRedLine: cfg.strictRedLine, defaultTtlMs: cfg.defaultTtlMs },
    }
    try { writeJsonAtomic(bridgePaths.status, statusDoc) } catch (e) {
      logger('warn', `[fang-approver] status write failed: ${String(e?.message ?? e)}`)
    }
    try { writeJsonAtomic(bridgePaths.pending, pending) } catch (e) {
      logger('warn', `[fang-approver] pending write failed: ${String(e?.message ?? e)}`)
    }
  }

  const recordDecision = (item, outcome, by, note) => {
    const record = {
      id: item.id,
      kind: item.kind,
      risk: item.risk,
      title: item.title,
      taskId: item.taskId ?? null,
      pluginId: item.pluginId ?? null,
      outcome,
      by,
      note,
      at: iso(),
    }
    decisions.push(record)
    if (decisions.length > 500) decisions.splice(0, decisions.length - 500)
    try { appendJsonl(decisionsFile, record) } catch (e) {
      logger('debug', `[fang-approver] decisions append failed: ${String(e?.message ?? e)}`)
    }
    return record
  }

  const clearItemTimers = (item) => {
    for (const timer of item.timers) {
      clearTimeout(timer)
      timers.delete(timer)
    }
    item.timers.clear()
  }

  const pruneQueue = () => {
    if (queue.size <= 256) return
    for (const [id, item] of queue) {
      if (item.state !== 'pending') queue.delete(id)
      if (queue.size <= 128) break
    }
  }

  /**
   * 唯一结案路径：改状态 → 记录 → resolve Promise → emit bus → 审计 → 落盘。
   * outcome ∈ {'approved','denied','timeout'}。
   */
  const settle = (item, outcome, by, note = null) => {
    if (!item || item.state !== 'pending') return null
    item.state = outcome
    item.by = by ?? null
    item.note = note
    item.resolvedAt = nowMs()
    clearItemTimers(item)
    const result = { id: item.id, outcome, by: item.by, at: iso() }
    recordDecision(item, outcome, item.by, note)
    try { item.resolve(result) } catch (e) {
      logger('debug', `[fang-approver] resolve failed: ${String(e?.message ?? e)}`)
    }
    try { bus.emit(EVENT_APPROVAL_DECIDED, { id: item.id, outcome }) } catch { /* listener 容错 */ }
    audit(AUDIT.APPROVAL_DECIDED, {
      id: item.id,
      kind: item.kind,
      risk: item.risk,
      title: item.title,
      taskId: item.taskId ?? null,
      pluginId: item.pluginId ?? null,
      outcome,
      by: item.by,
      note,
    })
    pruneQueue()
    persist()
    return result
  }

  // ───────── 1) 待批队列 ─────────

  /**
   * 契约 §5.7：request({kind, risk, title, detail, impact?, ttlMs?})
   *   -> Promise<{id, outcome:'approved'|'denied'|'timeout', by, at}>
   * authMode='auto' 时非红（或 strictRedLine=false）立即以 by:'auto' 放行；红灯在 strictRedLine
   * 下永远进队列，等待显式 decide() 或 TTL 到期（timeout，fail-closed）。
   */
  const request = (input = {}) => {
    const raw = input && typeof input === 'object' ? input : {}
    const id = newId('apr')
    if (disposed) {
      return Promise.resolve({ id, outcome: 'timeout', by: 'unload', at: iso() })
    }
    // 未知风险按红处理（fail-closed）；未知 kind 记 unknown。
    const risk = RISK_VALUES.includes(String(raw.risk)) ? String(raw.risk) : 'red'
    const ttl = positiveNumber(raw.ttlMs, cfg.defaultTtlMs)
    const createdAt = nowMs()

    let resolveDeferred
    const promise = new Promise((resolve) => { resolveDeferred = resolve })
    const item = {
      id,
      kind: String(raw.kind ?? 'unknown'),
      risk,
      title: String(raw.title ?? ''),
      detail: String(raw.detail ?? ''),
      impact: raw.impact ?? null,
      // v2：母体侧把审批对回任务/插件（可选；v1 调用方不传则为 null）。
      taskId: raw.taskId === undefined || raw.taskId === null ? null : String(raw.taskId),
      pluginId: raw.pluginId === undefined || raw.pluginId === null ? null : String(raw.pluginId),
      createdAt,
      deadlineAt: createdAt + ttl,
      ttlMs: ttl,
      state: 'pending',
      by: null,
      note: null,
      reminded: false,
      resolve: resolveDeferred,
      timers: new Set(),
    }
    touched = true
    queue.set(id, item)
    audit(AUDIT.APPROVAL_REQUESTED, {
      id,
      kind: item.kind,
      risk,
      title: item.title,
      detail: item.detail,
      impact: item.impact,
      taskId: item.taskId,
      pluginId: item.pluginId,
      ttlMs: ttl,
      deadlineAt: item.deadlineAt,
      authMode: cfg.authMode,
    })

    const autoBypass = cfg.authMode === 'auto' && (risk !== 'red' || cfg.strictRedLine === false)
    if (autoBypass) {
      settle(item, 'approved', 'auto', 'auto-mode')
      return promise
    }

    // TTL 到期：fail-closed 记为 timeout。
    const expiryTimer = setTimeout(() => {
      timers.delete(expiryTimer)
      const current = queue.get(id)
      if (current && current.state === 'pending') settle(current, 'timeout', 'ttl', 'ttl-expired')
    }, ttl)
    item.timers.add(expiryTimer)
    timers.add(expiryTimer)

    // 过半 TTL 标记提醒（只落状态，绝不自动放行）。
    const remindMs = ttl * clamp01(cfg.remindAt)
    if (remindMs > 0 && remindMs < ttl) {
      const remindTimer = setTimeout(() => {
        timers.delete(remindTimer)
        const current = queue.get(id)
        if (current && current.state === 'pending' && !current.reminded) {
          current.reminded = true
          current.remindedAt = nowMs()
          persist()
        }
      }, remindMs)
      item.timers.add(remindTimer)
      timers.add(remindTimer)
    }

    persist()
    return promise
  }

  /** 契约：pending() -> item[] */
  const pending = () => pendingItems()

  /** 契约：decide(id, 'approved'|'denied', {by, note}) -> {ok} */
  const decide = (id, outcome, options = {}) => {
    const key = String(id ?? '')
    if (!DECIDABLE_OUTCOMES.includes(outcome)) {
      return { ok: false, reason: 'bad-outcome', id: key, allowed: [...DECIDABLE_OUTCOMES] }
    }
    const item = queue.get(key)
    if (!item) return { ok: false, reason: 'not-found', id: key }
    if (item.state !== 'pending') return { ok: false, reason: 'not-pending', id: key, state: item.state }
    const by = String(options?.by ?? 'api')
    const note = options?.note === undefined || options?.note === null ? null : String(options.note)
    const result = settle(item, outcome, by, note)
    return { ok: true, id: key, outcome: result.outcome, by: result.by, at: result.at }
  }

  // ───────── 1b) v2 双侧语义：母体侧的语义化入口（promotion / restart） ─────────

  /**
   * v2 §5.7 母体语义：晋升审批 == request({kind:'promotion', risk:'red'})。
   * risk 固定红灯（晋升母体不可降级），pluginId/taskId 透传到 pending()/summary()。
   */
  const requestPromotion = (input = {}) => {
    const raw = input && typeof input === 'object' ? input : {}
    const pluginId = raw.pluginId === undefined || raw.pluginId === null ? '' : String(raw.pluginId).trim()
    const detail = raw.detail === undefined || raw.detail === null
      ? (pluginId ? `promote ${pluginId}` : 'promotion')
      : String(raw.detail)
    return request({
      kind: 'promotion',
      risk: 'red',
      title: raw.title === undefined || raw.title === null
        ? (pluginId ? `晋升 ${pluginId}` : '晋升审批')
        : String(raw.title),
      detail,
      impact: raw.impact ?? null,
      ttlMs: raw.ttlMs,
      pluginId: pluginId || null,
      taskId: raw.taskId,
    })
  }

  /** v2 §5.7 母体语义：母体重启审批 == request({kind:'restart', risk:'red'})；risk 由服务强制红灯。 */
  const requestRestart = (input = {}) => {
    const raw = input && typeof input === 'object' ? input : {}
    const reason = raw.reason === undefined || raw.reason === null ? '' : String(raw.reason)
    const detail = raw.detail === undefined || raw.detail === null ? reason : String(raw.detail)
    return request({
      kind: 'restart',
      risk: 'red',
      title: raw.title === undefined || raw.title === null
        ? (reason ? `母体重启：${reason}` : '母体重启')
        : String(raw.title),
      detail,
      impact: raw.impact ?? null,
      ttlMs: raw.ttlMs,
      pluginId: raw.pluginId,
      taskId: raw.taskId,
    })
  }

  // ───────── 1c) v2 汇总：本地待批 + 各分身待批（并发、单点失败不阻塞） ─────────

  /** 兼容 remote 的多种返回形状：{items} / {data:{items}} / {data:[...]} / 裸数组。 */
  const remoteItemsOf = (result) => {
    if (Array.isArray(result)) return result
    if (!result || typeof result !== 'object') return []
    if (Array.isArray(result.items)) return result.items
    if (result.data && Array.isArray(result.data.items)) return result.data.items
    if (Array.isArray(result.data)) return result.data
    return []
  }

  const fetchRemoteApprovals = async (remote) => {
    const taskId = remote && remote.taskId !== undefined && remote.taskId !== null ? String(remote.taskId) : null
    if (!remote || typeof remote.fetchApprovals !== 'function') {
      return { taskId, ok: false, items: [], error: 'fetchApprovals-unavailable' }
    }
    try {
      const result = await remote.fetchApprovals()
      if (result && result.ok === false) {
        return { taskId, ok: false, items: [], error: String(result.error ?? result.reason ?? 'remote-failed') }
      }
      return { taskId, ok: true, items: remoteItemsOf(result) }
    } catch (e) {
      return { taskId, ok: false, items: [], error: String(e?.message ?? e) }
    }
  }

  /**
   * v2 §5.7：汇总本地待批 + 所有分身的待批。
   * remotes = [{taskId, fetchApprovals: async () => ({ok, items})}]
   * 单个 remote 抛错 / 返回 ok:false 只记在该条目上（ok:false + error），不阻塞其他 remote。
   * 返回 { ok:true, scope, local, remote, total, failed }：
   *   ok=true 表示"汇总完成"；failed 是降级的 remote 数；total 只统计成功 remote 的 items。
   */
  const summary = async (options = {}) => {
    const remotes = Array.isArray(options?.remotes) ? options.remotes : []
    const local = pending()
    const remote = await Promise.all(remotes.map(fetchRemoteApprovals))
    const failed = remote.filter(entry => entry.ok === false).length
    const total = local.length + remote.reduce((sum, entry) => sum + (entry.ok ? entry.items.length : 0), 0)
    return { ok: true, scope, local, remote, total, failed, degraded: failed > 0 }
  }

  // ───────── 2) A/B 双备 ─────────

  /**
   * 契约：snapshot({tag, dir}) -> {tag, A:{digest,at}, B:null|{digest,at}}
   * A = 本次快照（当前内容），B = 上一次快照（上一代）。落盘位置：
   *   <snapshotsRoot>/<tag>/A 和 <snapshotsRoot>/<tag>/B
   */
  const snapshot = (options = {}) => {
    const sourceDir = options?.dir ? path.resolve(String(options.dir)) : ''
    if (!sourceDir || !exists(sourceDir)) {
      return { ok: false, reason: 'dir-not-found', dir: sourceDir || null }
    }
    const tag = safeTag(options?.tag ?? path.basename(sourceDir))
    const baseDir = path.join(snapshotsRoot, tag)
    const aDir = path.join(baseDir, 'A')
    const bDir = path.join(baseDir, 'B')
    const previous = snapshots.get(tag) ?? null
    touched = true
    try {
      ensureDir(baseDir)
      // 旧 A 滚到 B（只保留一代）；否则上一代就被新快照覆盖丢弃。
      if (previous?.A && exists(aDir)) {
        removeTree(bDir)
        copyTree(aDir, bDir)
        removeTree(aDir)
      }
      copyTree(sourceDir, aDir)
      const { digest, files } = digestOf(aDir)
      const record = {
        tag,
        A: { dir: aDir, digest, at: nowMs(), files },
        B: previous?.A
          ? { dir: bDir, digest: previous.A.digest, at: previous.A.at, files: previous.A.files }
          : null,
      }
      snapshots.set(tag, record)
      audit(AUDIT_SNAPSHOT_CREATED, { tag, dir: sourceDir, digest, files, hasB: record.B !== null })
      persist()
      return {
        tag,
        A: { digest: record.A.digest, at: record.A.at },
        B: record.B ? { digest: record.B.digest, at: record.B.at } : null,
      }
    } catch (e) {
      logger('warn', `[fang-approver] snapshot failed: ${String(e?.message ?? e)}`)
      return { ok: false, reason: 'snapshot-failed', tag, error: String(e?.message ?? e) }
    }
  }

  /**
   * 契约：rollback({tag, dir}) -> {ok, restored}
   * 默认从 A（最近一次快照）恢复；可传 to:'B' 恢复上一代。恢复后重算 digest 并校验。
   */
  const rollback = (options = {}) => {
    const rawTag = String(options?.tag ?? '').trim()
    if (!rawTag) return { ok: false, reason: 'no-tag' }
    const tag = safeTag(rawTag)
    const record = snapshots.get(tag)
    if (!record) return { ok: false, reason: 'no-snapshot', tag }
    const targetDir = options?.dir ? path.resolve(String(options.dir)) : ''
    if (!targetDir) return { ok: false, reason: 'no-target-dir', tag }
    const slotName = String(options?.to ?? 'A').toUpperCase() === 'B' ? 'B' : 'A'
    const slot = record[slotName]
    if (!slot || !exists(slot.dir)) return { ok: false, reason: 'slot-empty', tag, slot: slotName }
    touched = true
    try {
      removeTree(targetDir)
      ensureDir(targetDir)
      copyTree(slot.dir, targetDir)
      const { digest, files } = digestOf(targetDir)
      const matched = digest === slot.digest
      const restored = { tag, slot: slotName, dir: targetDir, digest, files, expected: slot.digest, matches: matched, at: iso() }
      if (!matched) {
        audit(AUDIT.ROLLBACK, { tag, slot: slotName, dir: targetDir, digest, expected: slot.digest, ok: false, reason: 'digest-mismatch' })
        persist()
        return { ok: false, reason: 'digest-mismatch', tag, slot: slotName, restored }
      }
      audit(AUDIT.ROLLBACK, { tag, slot: slotName, dir: targetDir, digest, files, ok: true })
      persist()
      return { ok: true, restored }
    } catch (e) {
      const error = String(e?.message ?? e)
      logger('warn', `[fang-approver] rollback failed: ${error}`)
      audit(AUDIT.ROLLBACK, { tag, slot: slotName, dir: targetDir, ok: false, error })
      return { ok: false, reason: 'restore-failed', tag, slot: slotName, error }
    }
  }

  // ───────── 3) 监控 ─────────

  /** 契约：monitor({label, value, threshold}) -> {ok, alert:boolean}。threshold 支持数字或 {op,value}。 */
  const monitor = (input = {}) => {
    const label = String(input?.label ?? '').trim() || 'monitor'
    const rawValue = input?.value
    const value = Number(rawValue)
    if (rawValue === null || rawValue === undefined || !Number.isFinite(value)) {
      return { ok: false, reason: 'bad-value', label }
    }
    touched = true
    const threshold = normalizeThreshold(input?.threshold)
    const record = monitors.get(label) ?? {
      label,
      samples: [],
      min: null,
      max: null,
      last: null,
      alerts: [],
      threshold: null,
    }
    if (threshold) record.threshold = threshold
    record.last = value
    record.samples.push({ at: nowMs(), value })
    while (record.samples.length > 240) record.samples.shift()
    record.min = record.min === null ? value : Math.min(record.min, value)
    record.max = record.max === null ? value : Math.max(record.max, value)
    const alert = thresholdHit(value, record.threshold)
    if (alert) {
      record.alerts.push({ at: nowMs(), value, threshold: { ...record.threshold } })
      if (record.alerts.length > 100) record.alerts.shift()
      logger('warn', `[fang-approver] monitor alert: ${label}=${value} ${record.threshold.op} ${record.threshold.value}`)
    }
    monitors.set(label, record)
    persist()
    return {
      ok: true,
      alert,
      label,
      value,
      threshold: record.threshold ? { ...record.threshold } : null,
      samples: record.samples.length,
      min: record.min,
      max: record.max,
      alerts: record.alerts.length,
    }
  }

  // ───────── 4) 汇总状态 + 文件桥 ─────────

  /** 契约：status() -> {pending, snapshots, monitors, decisions}（计数 + 明细兄弟字段）。 */
  const status = () => ({
    scope,
    pending: pendingItems().length,
    snapshots: snapshots.size,
    monitors: monitors.size,
    decisions: decisions.length,
    pendingItems: pendingItems(),
    snapshotsList: [...snapshots.values()].map(rec => snapshotView(rec)),
    monitorsList: [...monitors.values()].map(rec => monitorView(rec)),
    lastDecisions: decisions.slice(-10),
    policy: { authMode: cfg.authMode, strictRedLine: cfg.strictRedLine, defaultTtlMs: cfg.defaultTtlMs },
    dataDir,
    snapshotsRoot,
  })

  const bridgeOutcome = (incoming) => {
    if (incoming?.outcome === 'approved' || incoming?.outcome === 'denied') return incoming.outcome
    return incoming?.decision === 'approve' ? 'approved' : 'denied'
  }

  const runBridgeCommand = (command) => {
    if (!command || typeof command !== 'object') return
    const action = String(command.action ?? '')
    if (action === 'request') { void request(command); return }
    if (action === 'promotion') { void requestPromotion(command); return }
    if (action === 'restart') { void requestRestart(command); return }
    if (action === 'decide' || action === 'answer') {
      decide(command.id, bridgeOutcome(command), { by: String(command.by ?? 'file'), note: command.note })
      return
    }
    if (action === 'snapshot') { snapshot(command); return }
    if (action === 'rollback') { rollback(command); return }
    if (action === 'monitor' || action === 'sample') { monitor(command); return }
    if (action === 'status') { persist(); return }
  }

  /** command 文件：读取后立即消费（先删再执行，避免重复执行）。 */
  const pollCommandFile = () => {
    const raw = readTextSafe(bridgePaths.command, '')
    if (!raw) return
    removeTree(bridgePaths.command)
    let command = null
    try { command = JSON.parse(String(raw).replace(/^\uFEFF/, '')) } catch {
      logger('warn', '[fang-approver] command file is not valid JSON; ignored')
      return
    }
    try { runBridgeCommand(command) } catch (e) {
      logger('warn', `[fang-approver] bridge command failed: ${String(e?.message ?? e)}`)
    }
  }

  /** answer 文件：兼容老 CLI 的 {id, decision:'approve'|'deny'} 写法。 */
  const pollAnswerFile = () => {
    const raw = readTextSafe(bridgePaths.answer, '')
    if (!raw) return
    let answer = null
    try { answer = JSON.parse(String(raw).replace(/^\uFEFF/, '')) } catch { return }
    const id = String(answer?.id ?? '')
    const item = queue.get(id)
    if (!item || item.state !== 'pending') return
    decide(id, bridgeOutcome(answer), { by: String(answer?.by ?? 'file'), note: answer?.note })
    removeTree(bridgePaths.answer)
  }

  const service = {
    scope,
    request,
    pending,
    decide,
    requestPromotion,
    requestRestart,
    summary,
    snapshot,
    rollback,
    monitor,
    status,
    /** 只读辅助：单条查询（结算后仍可查到最后状态）。 */
    get: (id) => {
      const item = queue.get(String(id ?? ''))
      return item ? publicItem(item) : null
    },
    /** 文件桥路径，供 tools/fangctl.mjs 之类的 CLI 对齐（而不是自己拼路径）。 */
    paths: Object.freeze({ ...bridgePaths, decisions: decisionsFile, dataDir, snapshotsRoot }),
    config: Object.freeze({ ...cfg }),
  }

  // ───────── 生命周期：服务注册 / 文件桥轮询 / 清理 ─────────

  ctx.effect(() => ctx.provide(SERVICE.approver, service))

  ctx.effect(() => {
    const pollMs = Math.max(10, Math.round(cfg.fileBridgePollMs))
    const timer = setInterval(() => {
      try { pollCommandFile() } catch (e) {
        logger('debug', `[fang-approver] command poll failed: ${String(e?.message ?? e)}`)
      }
      try { pollAnswerFile() } catch (e) {
        logger('debug', `[fang-approver] answer poll failed: ${String(e?.message ?? e)}`)
      }
    }, pollMs)
    return () => clearInterval(timer)
  })

  // 卸载：清定时器，未决请求全部按 timeout / by:'unload' 结算（fail-closed，避免悬挂 Promise）。
  ctx.effect(() => () => {
    disposed = true
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    for (const item of queue.values()) {
      if (item.state !== 'pending') continue
      item.state = 'timeout'
      item.by = 'unload'
      item.note = 'plugin-unloaded'
      item.resolvedAt = nowMs()
      clearItemTimers(item)
      const result = { id: item.id, outcome: 'timeout', by: 'unload', at: iso() }
      recordDecision(item, 'timeout', 'unload', 'plugin-unloaded')
      try { item.resolve(result) } catch { /* ignore */ }
      try { bus.emit(EVENT_APPROVAL_DECIDED, { id: item.id, outcome: 'timeout' }) } catch { /* ignore */ }
      audit(AUDIT.APPROVAL_DECIDED, {
        id: item.id,
        kind: item.kind,
        risk: item.risk,
        title: item.title,
        taskId: item.taskId ?? null,
        pluginId: item.pluginId ?? null,
        outcome: 'timeout',
        by: 'unload',
        note: 'plugin-unloaded',
      })
    }
    persist()
  })
}

/** 供测试/诊断使用的纯函数导出（不影响插件契约）。 */
export const _internals = { digestOf, safeTag, normalizeThreshold, thresholdHit, normalizeConfig }
