// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang v2.0.0 — 2.4 审批子插件（T3/T9）
//
// 职责（四件能力，契约见 docs/CONTRACTS.md §5.7 与 §6；v2 增量见 CONTRACTS-V2.md §5.7）：
//   1) 待批队列：request() 返回 Promise，只有 decide() 或 TTL 到期（fail-closed → 'timeout'）才 resolve；
//   2) 多代快照：snapshot() 把目录内容复制到 <dataDir>/snapshots/<tag>/A（新）与 /B、/C…（历史代），
//      对复制出的内容做内容寻址 sha256 digest；rollback() 用快照覆盖回目标目录并校验 digest；
//   1a) 崩溃 journal：dsh-approval-journal.jsonl 只增记录 request/settled/orphaned；
//      重启后未 settled 的 request 只标记 orphaned，绝不复活已死的 Promise；
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
//   * 快照保留 snapshotGenerations 代（默认 3，A 最新）；不跟随 junction（copyTree 只重建链接）；
//   * monitor 为单点采样（不做内部定时 getter 轮询），轮询由调用方/CLI 决定；
//   * requestPromotion/requestRestart 只在 mother scope 接受；fork 调用立即 denied/by:'scope'。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
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
  readJsonl,
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
  snapshotGenerations: z.number().min(2).max(10).default(3)
    .description('每个 tag 保留的快照代数（A 最新，依次 B/C…；默认 3）'),
  fileBridgePollMs: z.number().min(10).default(300)
    .description('文件桥（command/answer json）轮询间隔（毫秒）'),
  bridgeAclCheck: z.boolean().default(true)
    .description('启动时校验 dataDir ACL；不通过则停用文件桥'),
  bridgeSecret: z.string().default('')
    .description('可选文件桥 HMAC 密钥；设置后 command/answer 必须带 signature'),
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
  snapshotGenerations: 3,
  fileBridgePollMs: 300,
  bridgeAclCheck: true,
  bridgeSecret: '',
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
/** 崩溃 journal：request/settled/orphaned 生命周期只增日志，供重启恢复未结请求。 */
const JOURNAL_FILE = 'dsh-approval-journal.jsonl'

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
    snapshotGenerations: Math.max(2, Math.min(10, Math.floor(Number(input.snapshotGenerations) || DEFAULTS.snapshotGenerations))),
    fileBridgePollMs: positiveNumber(input.fileBridgePollMs, DEFAULTS.fileBridgePollMs),
    bridgeAclCheck: input.bridgeAclCheck === undefined ? DEFAULTS.bridgeAclCheck : input.bridgeAclCheck !== false,
    bridgeSecret: typeof input.bridgeSecret === 'string' ? input.bridgeSecret : DEFAULTS.bridgeSecret,
    role: input.role === 'fork' ? 'fork' : 'mother',
  }
}

/** tag 会被用作目录名（可能来自 CLI），必须挡掉路径穿越字符。 */
function safeTag(raw) {
  const s = String(raw ?? '').trim()
  const cleaned = s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[.]+/, '').slice(0, 64)
  const base = cleaned || 'snap'
  // Distinct raw tags must not collapse onto one directory (a/b vs a_b).
  if (base === s) return base
  return `${base.slice(0, 55)}-${sha256(s).slice(0, 8)}`
}

/** 内容寻址 digest：按相对路径排序后对 (rel\0contentHash) 串做 sha256，跨平台稳定。 */
function digestOf(dir) {
  const tree = digestTree(dir)
  const keys = Object.keys(tree).sort()
  const lines = keys.map(rel => `${rel}\u0000${tree[rel]}`)
  return { digest: sha256(lines.join('\n')), files: keys.length }
}

/** Restore a snapshot without deleting the live target first. */
function atomicRestoreDir(sourceDir, targetDir, expectedDigest) {
  const suffix = newId('rollback')
  const tmp = `${targetDir}.restore-${suffix}`
  const old = `${targetDir}.rollback-${suffix}`
  try {
    removeTree(tmp)
    removeTree(old)
    copyTree(sourceDir, tmp)
    const copied = digestOf(tmp)
    if (copied.digest !== expectedDigest) {
      removeTree(tmp)
      return { ok: false, reason: 'digest-mismatch', digest: copied.digest, files: copied.files }
    }
    const hadOld = exists(targetDir)
    if (hadOld) fs.renameSync(targetDir, old)
    try {
      fs.renameSync(tmp, targetDir)
    } catch (error) {
      if (hadOld && !exists(targetDir)) {
        try { fs.renameSync(old, targetDir) } catch { /* best effort restore */ }
      }
      throw error
    }
    if (hadOld) removeTree(old)
    return { ok: true, digest: copied.digest, files: copied.files }
  } catch (error) {
    removeTree(tmp)
    if (exists(old) && !exists(targetDir)) {
      try { fs.renameSync(old, targetDir) } catch { /* best effort restore */ }
    }
    throw error
  }
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

/**
 * Best-effort platform ACL check for the file-bridge directory. The bridge is a
 * local-only compatibility path; if the directory is writable by broad principals
 * we disable it rather than expose command execution to any local process.
 */
function checkBridgeAcl(dir) {
  try {
    const st = fs.statSync(dir)
    if (process.platform !== 'win32') {
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
        return { ok: false, reason: 'bridge-dir-not-owned' }
      }
      if ((st.mode & 0o022) !== 0) return { ok: false, reason: 'bridge-dir-group-or-world-writable' }
      return { ok: true, platform: 'posix', mode: st.mode & 0o777 }
    }
    const output = execFileSync('icacls', [dir], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    const dangerous = /(everyone|builtin\\users|authenticated users|interactive|iusr|iis_iusrs)/i
    const resolved = path.resolve(dir).toLowerCase()
    let checked = 0
    for (const rawLine of String(output).split(/\r?\n/)) {
      let line = rawLine.trim()
      if (!line) continue
      if (line.toLowerCase().startsWith(resolved)) line = line.slice(path.resolve(dir).length).trim()
      if (!line.includes(':')) continue
      checked += 1
      if (dangerous.test(line)) return { ok: false, reason: 'bridge-dir-world-accessible', detail: line }
    }
    if (checked === 0) return { ok: false, reason: 'bridge-acl-unreadable' }
    return { ok: true, platform: 'win32' }
  } catch (error) {
    return { ok: false, reason: 'bridge-acl-check-failed', error: String(error?.message ?? error) }
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function verifyBridgeSignature(payload, secret) {
  if (!secret) return true
  if (!payload || typeof payload !== 'object') return false
  const signature = String(payload.signature ?? '')
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false
  const copy = { ...payload }
  delete copy.signature
  const expected = crypto.createHmac('sha256', secret).update(stableStringify(copy)).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(signature.toLowerCase(), 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    return false
  }
}


  // v2 §1：角色门禁必须是 apply 的第一件事；未部署到该角色时不注册服务/定时器/文件桥。
export function apply(ctx, config) {
  // v2 role gate: must be the first thing apply does.
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
  const journalFile = path.join(dataDir, JOURNAL_FILE)
  const snapshotsIndexFile = path.join(snapshotsRoot, 'index.json')
  const bridgeSecret = String(process.env.FANG_BRIDGE_SECRET ?? cfg.bridgeSecret ?? '').trim()
  let bridgeAcl = null
  let bridgeSecurityChecked = false
  const ensureBridgeSecurity = () => {
    if (bridgeSecurityChecked) return bridgeAcl?.ok === true
    bridgeSecurityChecked = true
    if (!cfg.bridgeAclCheck) {
      bridgeAcl = { ok: true, skipped: true }
      return true
    }
    try { ensureDir(dataDir) } catch { /* check will fail closed below */ }
    bridgeAcl = checkBridgeAcl(dataDir)
    if (!bridgeAcl.ok) logger('warn', `[fang-approver] file bridge disabled: ${bridgeAcl.reason}`)
    return bridgeAcl.ok === true
  }

  /** id → item（结案后保留一小段用于幂等判定，超过上限再修剪）。 */
  const queue = new Map()
  /** 决策历史（后 10 条同时写进 status 文件；全量追加 decisions.jsonl）。 */
  const decisions = []
  /** tag → {tag, A:{dir,digest,at,files}, B:{...}|null} */
  const snapshots = new Map()
  /** label → {label, samples:[{at,value}], min, max, last, alerts:[], threshold} */
  const monitors = new Map()

  // Snapshot generation directories outlive the process, but digest metadata used to
  // live only in this Map. Persist it so rollback still works after a restart.
  const persistSnapshotIndex = () => {
    try {
      ensureDir(snapshotsRoot)
      writeJsonAtomic(snapshotsIndexFile, {
        version: 2,
        snapshots: [...snapshots.values()].map((record) => ({
          tag: record.tag,
          A: record.A ? { digest: record.A.digest, at: record.A.at, files: record.A.files } : null,
          B: record.B ? { digest: record.B.digest, at: record.B.at, files: record.B.files } : null,
          generations: (record.generations ?? []).map((generation) => ({
            slot: generation.slot, digest: generation.digest, at: generation.at, files: generation.files,
          })),
        })),
      })
    } catch (error) {
      logger('warn', `[fang-approver] snapshot index write failed: ${String(error?.message ?? error)}`)
    }
  }

  const loadSnapshotIndex = () => {
    const raw = readTextSafe(snapshotsIndexFile, '')
    if (!raw) return
    let parsed = null
    try { parsed = JSON.parse(raw) } catch { return }
    for (const entry of Array.isArray(parsed?.snapshots) ? parsed.snapshots : []) {
      const tag = safeTag(entry?.tag)
      const base = path.join(snapshotsRoot, tag)
      const slot = (name, explicitSource) => {
        const source = explicitSource ?? entry?.[name]
        if (!source || typeof source.digest !== 'string') return null
        const dir = path.join(base, name)
        if (!exists(dir)) return null
        return { slot: name, dir, digest: source.digest, at: Number(source.at) || 0, files: Number(source.files) || 0 }
      }
      let generations = []
      if (Array.isArray(entry?.generations)) {
        for (const rawGen of entry.generations) {
          const name = String(rawGen?.slot ?? '').toUpperCase()
          if (!/^[A-J]$/.test(name)) continue
          const loaded = slot(name, rawGen)
          if (loaded) generations.push(loaded)
        }
      }
      if (!generations.length) generations = [slot('A'), slot('B')].filter(Boolean)
      generations.sort((a, b) => a.slot.localeCompare(b.slot))
      const A = generations[0] ?? null
      if (!A) continue
      snapshots.set(tag, { tag, A, B: generations[1] ?? null, generations })
    }
  }
  loadSnapshotIndex()
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
    by: item.by ?? null,
    note: item.note ?? null,
    resolvedAt: item.resolvedAt ?? null,
    orphanedAt: item.orphanedAt ?? null,
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
  const orphanedItems = () => [...queue.values()].filter(item => item.state === 'orphaned').map(publicItem)

  /**
   * A previous process may have left pending.json behind. Those Promises died with
   * that process, so restoring them as "pending" would be a lie. Mark them orphaned,
   * keep them visible for the UI/CLI, and never resolve a Promise that no longer exists.
   */
  const recoverOrphaned = () => {
    const raw = readTextSafe(bridgePaths.pending, '')
    if (!raw) return
    let list = null
    try { list = JSON.parse(raw) } catch { return }
    let recovered = 0
    for (const entry of Array.isArray(list) ? list : []) {
      const id = String(entry?.id ?? '').trim()
      if (!id || queue.has(id)) continue
      const at = nowMs()
      const item = {
        id,
        kind: String(entry?.kind ?? 'unknown'),
        risk: RISK_VALUES.includes(String(entry?.risk)) ? String(entry.risk) : 'red',
        title: String(entry?.title ?? ''),
        detail: String(entry?.detail ?? ''),
        impact: entry?.impact ?? null,
        taskId: entry?.taskId === undefined || entry?.taskId === null ? null : String(entry.taskId),
        pluginId: entry?.pluginId === undefined || entry?.pluginId === null ? null : String(entry.pluginId),
        createdAt: Number(entry?.createdAt) || at,
        deadlineAt: Number(entry?.deadlineAt) || at,
        ttlMs: Number(entry?.ttlMs) || cfg.defaultTtlMs,
        state: 'orphaned',
        by: 'restart',
        note: 'process-restarted',
        reminded: entry?.reminded === true,
        resolvedAt: at,
        orphanedAt: at,
        resolve: null,
        timers: new Set(),
      }
      queue.set(id, item)
      touched = true
      recovered += 1
      audit('approval-interrupted', {
        id, kind: item.kind, risk: item.risk, title: item.title,
        taskId: item.taskId, pluginId: item.pluginId,
        previousState: 'pending', state: 'orphaned', by: 'restart',
      })
    }
    if (recovered > 0) persist()
  }

  // ───────── 1a) 崩溃 journal ─────────
  let journalWrites = 0
  const appendJournal = (entry) => {
    try {
      appendJsonl(journalFile, { at: iso(), ...entry })
      journalWrites += 1
    } catch (error) {
      logger('warn', `[fang-approver] journal append failed: ${String(error?.message ?? error)}`)
    }
  }

  /** Journal 里 request 未出现 settled/timeout → 进程在 pending 期间崩溃；恢复为 orphaned，绝不复活 Promise。 */
  const recoverJournal = () => {
    const entries = readJsonl(journalFile)
    if (!entries.length) return
    const requests = new Map()
    const terminal = new Set()
    for (const entry of entries) {
      const id = String(entry?.id ?? '').trim()
      if (!id) continue
      const type = String(entry?.type ?? '')
      if (type === 'request') requests.set(id, entry)
      else if (type === 'settled' || type === 'timeout' || type === 'orphaned') terminal.add(id)
    }
    let recovered = 0
    const at = nowMs()
    for (const [id, entry] of requests) {
      if (terminal.has(id) || queue.has(id)) continue
      const item = {
        id,
        kind: String(entry.kind ?? 'unknown'),
        risk: RISK_VALUES.includes(String(entry.risk)) ? String(entry.risk) : 'red',
        title: String(entry.title ?? ''),
        detail: String(entry.detail ?? ''),
        impact: entry.impact ?? null,
        taskId: entry.taskId === undefined || entry.taskId === null ? null : String(entry.taskId),
        pluginId: entry.pluginId === undefined || entry.pluginId === null ? null : String(entry.pluginId),
        createdAt: Number(entry.createdAt) || at,
        deadlineAt: Number(entry.deadlineAt) || at,
        ttlMs: Number(entry.ttlMs) || cfg.defaultTtlMs,
        state: 'orphaned',
        by: 'restart',
        note: 'process-restarted(journal)',
        reminded: entry.reminded === true,
        resolvedAt: at,
        orphanedAt: at,
        resolve: null,
        timers: new Set(),
      }
      queue.set(id, item)
      touched = true
      recovered += 1
      appendJournal({ type: 'orphaned', id, by: 'restart', source: 'journal' })
      audit('approval-interrupted', {
        id, kind: item.kind, risk: item.risk, title: item.title,
        taskId: item.taskId, pluginId: item.pluginId,
        previousState: 'pending', state: 'orphaned', by: 'restart', source: 'journal',
      })
    }
    if (recovered > 0) persist()
  }

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
        orphaned: orphanedItems().length,
        snapshots: snapshots.size,
        monitors: monitors.size,
        decisions: decisions.length,
      },
      pending,
      orphaned: orphanedItems(),
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
    appendJournal({ type: 'settled', id: item.id, outcome, by: item.by, note })
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
    const kind = String(raw.kind ?? 'unknown')
    const kindKey = kind.trim().toLowerCase()
    // Mother-only semantic kinds must be blocked at the generic request() layer too:
    // requestPromotion/requestRestart already gate themselves, but a caller can call
    // request({kind:'promotion'}) directly.
    if ((kindKey === 'promotion' || kindKey === 'restart') && scope !== 'mother') {
      const denied = { id, outcome: 'denied', by: 'scope', reason: 'mother-only', at: iso() }
      audit(AUDIT.APPROVAL_DECIDED, { id, kind, risk, outcome: 'denied', by: 'scope', reason: 'mother-only' })
      return Promise.resolve(denied)
    }
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
    appendJournal({
      type: 'request', id, kind: item.kind, risk, title: item.title,
      detail: item.detail, impact: item.impact, taskId: item.taskId, pluginId: item.pluginId,
      createdAt: item.createdAt, deadlineAt: item.deadlineAt, ttlMs: ttl,
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
    if (scope !== 'mother') {
      const denied = { id: newId('apr'), outcome: 'denied', by: 'scope', at: iso(), reason: 'mother-only' }
      audit(AUDIT.APPROVAL_DECIDED, { kind: 'promotion', outcome: 'denied', by: 'scope', reason: 'mother-only' })
      return Promise.resolve(denied)
    }
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
    if (scope !== 'mother') {
      const denied = { id: newId('apr'), outcome: 'denied', by: 'scope', at: iso(), reason: 'mother-only' }
      audit(AUDIT.APPROVAL_DECIDED, { kind: 'restart', outcome: 'denied', by: 'scope', reason: 'mother-only' })
      return Promise.resolve(denied)
    }
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
    return { ok: true, scope, local, remote, total, failed, degraded: failed > 0, complete: failed === 0 }
  }

  // ───────── 2) 多代快照（A 最新，B/C… 历史；默认 3 代）─────────

  const GENERATION_SLOTS = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'])
  const generationSlots = () => GENERATION_SLOTS.slice(0, cfg.snapshotGenerations)

  const publicGeneration = (generation) => generation
    ? { slot: generation.slot, digest: generation.digest, at: generation.at, files: generation.files }
    : null

  /**
   * 契约扩展：snapshot({tag, dir}) -> {tag, A, B, generations}
   * A = 本次快照（当前内容），B/C… = 历史代；保留代数由 snapshotGenerations 控制。
   * 落盘位置：<snapshotsRoot>/<tag>/A、/B、/C…
   */
  const snapshot = (options = {}) => {
    const sourceDir = options?.dir ? path.resolve(String(options.dir)) : ''
    if (!sourceDir || !exists(sourceDir)) {
      return { ok: false, reason: 'dir-not-found', dir: sourceDir || null }
    }
    const tag = safeTag(options?.tag ?? path.basename(sourceDir))
    const baseDir = path.join(snapshotsRoot, tag)
    const previous = snapshots.get(tag) ?? null
    const slots = generationSlots()
    const slotDir = (name) => path.join(baseDir, name)
    touched = true
    try {
      ensureDir(baseDir)
      // 先把新内容复制到 staging，成功后再轮换，避免 copy 失败破坏旧代。
      const staging = path.join(baseDir, `.staging-${newId('snap')}`)
      removeTree(staging)
      copyTree(sourceDir, staging)
      const { digest, files } = digestOf(staging)
      // 从最老一代往前轮换：删除最老，B→C…，A→B。
      for (let index = slots.length - 1; index >= 1; index -= 1) {
        removeTree(slotDir(slots[index]))
        if (exists(slotDir(slots[index - 1]))) fs.renameSync(slotDir(slots[index - 1]), slotDir(slots[index]))
      }
      removeTree(slotDir('A'))
      fs.renameSync(staging, slotDir('A'))
      const previousGenerations = Array.isArray(previous?.generations)
        ? previous.generations
        : [previous?.A, previous?.B].filter(Boolean)
      const generations = [
        { slot: 'A', dir: slotDir('A'), digest, at: nowMs(), files },
        ...previousGenerations.slice(0, slots.length - 1).map((generation, index) => ({
          slot: slots[index + 1], dir: slotDir(slots[index + 1]),
          digest: generation.digest, at: generation.at, files: generation.files,
        })),
      ]
      const record = {
        tag,
        A: generations[0],
        B: generations[1] ?? null,
        generations,
      }
      for (const generation of generations) record[generation.slot] = generation
      snapshots.set(tag, record)
      persistSnapshotIndex()
      audit(AUDIT_SNAPSHOT_CREATED, { tag, dir: sourceDir, digest, files, generations: generations.length })
      persist()
      return {
        tag,
        A: { digest: record.A.digest, at: record.A.at },
        B: record.B ? { digest: record.B.digest, at: record.B.at } : null,
        C: record.C ? { digest: record.C.digest, at: record.C.at } : null,
        generations: generations.map(publicGeneration),
      }
    } catch (e) {
      logger('warn', `[fang-approver] snapshot failed: ${String(e?.message ?? e)}`)
      return { ok: false, reason: 'snapshot-failed', tag, error: String(e?.message ?? e) }
    }
  }

  /**
   * 契约扩展：rollback({tag, dir, to?}) -> {ok, restored}
   * to 支持 A…J（默认 A）；恢复后重算 digest 并校验。
   */
  const rollback = (options = {}) => {
    const rawTag = String(options?.tag ?? '').trim()
    if (!rawTag) return { ok: false, reason: 'no-tag' }
    const tag = safeTag(rawTag)
    const record = snapshots.get(tag)
    if (!record) return { ok: false, reason: 'no-snapshot', tag }
    const targetDir = options?.dir ? path.resolve(String(options.dir)) : ''
    if (!targetDir) return { ok: false, reason: 'no-target-dir', tag }
    const requested = String(options?.to ?? 'A').toUpperCase()
    const slotName = /^[A-J]$/.test(requested) ? requested : 'A'
    const slot = record[slotName] ?? (record.generations ?? []).find((generation) => generation.slot === slotName) ?? null
    if (!slot || !exists(slot.dir)) return { ok: false, reason: 'slot-empty', tag, slot: slotName }
    touched = true
    try {
      const copy = atomicRestoreDir(slot.dir, targetDir, slot.digest)
      const restored = {
        tag, slot: slotName, dir: targetDir,
        digest: copy.digest, files: copy.files ?? null,
        expected: slot.digest, matches: copy.ok === true, at: iso(),
      }
      if (!copy.ok) {
        audit(AUDIT.ROLLBACK, { tag, slot: slotName, dir: targetDir, digest: copy.digest, expected: slot.digest, ok: false, reason: copy.reason })
        persist()
        return { ok: false, reason: copy.reason, tag, slot: slotName, restored }
      }
      audit(AUDIT.ROLLBACK, { tag, slot: slotName, dir: targetDir, digest: copy.digest, files: copy.files, ok: true })
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
    orphaned: orphanedItems().length,
    snapshots: snapshots.size,
    monitors: monitors.size,
    decisions: decisions.length,
    pendingItems: pendingItems(),
    snapshotsList: [...snapshots.values()].map(rec => snapshotView(rec)),
    orphanedList: orphanedItems(),
    monitorsList: [...monitors.values()].map(rec => monitorView(rec)),
    lastDecisions: decisions.slice(-10),
    policy: { authMode: cfg.authMode, strictRedLine: cfg.strictRedLine, defaultTtlMs: cfg.defaultTtlMs },
    bridge: { enabled: bridgeAcl ? bridgeAcl.ok === true : null, checked: bridgeSecurityChecked, acl: bridgeAcl, signed: bridgeSecret.length > 0 },
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
    if (!ensureBridgeSecurity()) return
    const raw = readTextSafe(bridgePaths.command, '')
    if (!raw) return
    removeTree(bridgePaths.command)
    let command = null
    try { command = JSON.parse(String(raw).replace(/^\uFEFF/, '')) } catch {
      logger('warn', '[fang-approver] command file is not valid JSON; ignored')
      return
    }
    if (!verifyBridgeSignature(command, bridgeSecret)) {
      logger('warn', '[fang-approver] command rejected: missing or invalid bridge signature')
      audit('approval-bridge-rejected', { bridge: 'command', reason: 'bad-signature' })
      return
    }
    try { runBridgeCommand(command) } catch (e) {
      logger('warn', `[fang-approver] bridge command failed: ${String(e?.message ?? e)}`)
    }
  }

  /** answer 文件：兼容老 CLI 的 {id, decision:'approve'|'deny'} 写法。 */
  const pollAnswerFile = () => {
    if (!ensureBridgeSecurity()) return
    const raw = readTextSafe(bridgePaths.answer, '')
    if (!raw) return
    let answer = null
    try { answer = JSON.parse(String(raw).replace(/^\uFEFF/, '')) } catch {
      logger('warn', '[fang-approver] answer file is not valid JSON; consumed')
      removeTree(bridgePaths.answer)
      return
    }
    if (!verifyBridgeSignature(answer, bridgeSecret)) {
      logger('warn', '[fang-approver] answer rejected: missing or invalid bridge signature')
      audit('approval-bridge-rejected', { bridge: 'answer', reason: 'bad-signature' })
      removeTree(bridgePaths.answer)
      return
    }
    const id = String(answer?.id ?? '')
    const item = queue.get(id)
    if (!item || item.state !== 'pending') {
      // Do not leave an unusable answer on disk for every 300ms poll.
      logger('warn', `[fang-approver] answer for unknown/non-pending item ${id || '(empty)'}; consumed`)
      removeTree(bridgePaths.answer)
      return
    }
    decide(id, bridgeOutcome(answer), { by: String(answer?.by ?? 'file'), note: answer?.note })
    removeTree(bridgePaths.answer)
  }

  recoverOrphaned()
  recoverJournal()

  const service = {
    scope,
    request,
    pending,
    orphaned: orphanedItems,
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
