// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang 2.8 — fang-auditor: the append-only chained ledger of the whole system.
//
// Every cross-plugin fact (fork started, promote committed, restart resolved, ...) is
// appended through this service, so the chain can be verified later:
//   hash_i = sha256( recursive-canonical(record_without_hash) + prevHash )
// A single edited/deleted/swapped line makes verify() fail at that index.
//
// bootCheck() is the startup admission gate (CONTRACTS.md §5.2): it looks at the tail
// left by the PREVIOUS run and reports
//   * unclean-boot        — the previous run's last record is not shutdown-graceful
//   * interrupted-in-guard— a restart was opened but never resolved
// This instance marks its own records with `inst`, so records written by this run can
// never be mistaken for the previous run's tail (and no timestamp-window heuristics are
// needed — those race when two runs happen within the same millisecond).
//
// v2.0.0 (CONTRACTS-V2.md §1/§5.7): the plugin is role-gated (matrix allows mother AND
// fork) and exposes `scope`. The mother does not share the fork's process/bus, so it
// pulls each fork's ledger over HTTP and merges it here:
//   aggregate({limit, sources}) -> {ok,total,records,sources}
//       local records get taskId:null, each fork's records get that source's taskId,
//       merged ascending by at (tie-break seq) and the newest `limit` are returned.
//   bootAudit()  — alias of bootCheck(), kept for the v2 vocabulary.
//   cloudSink()  — commercial backup/cloud hook placeholder ({ok:false,reason:'not-configured'}).
import path from 'node:path'
import {
  AUDIT,
  SERVICE,
  appendChained,
  ensureDir,
  iso,
  newId,
  nowMs,
  readTextSafe,
  resolveFangLayout,
  roleGate,
  verifyChain,
  z,
} from '../kernel/index.mjs'

export const name = 'fang-auditor'
export const inject = []

const DEFAULTS = {
  dataRoot: '',
  bootSelfCheck: true,
  ledgerFile: '',
  role: 'mother',
}

export const Config = z
  .object({
    dataRoot: z.string().default('').description('审计数据目录（空 = 默认 $DSH_HOME/fang/<profile>）'),
    bootSelfCheck: z.boolean().default(true).description('apply 时做一次只读启动自检（不写盘）'),
    ledgerFile: z.string().default('').description('显式账本路径（空 = dataDir/audit.jsonl）'),
    role: z
      .union([z.const('mother'), z.const('fork')])
      .default('mother')
      .description('部署角色（v2 §1）；DSH_FANG_ROLE 环境变量优先级更高（forker 启动分身时注入）'),
  })
  .description('fang-auditor 配置')

const msgOf = (e) => String(e && e.message ? e.message : e)

/** A restart was opened by the guard (requested or already committed). */
function isRestartOpen(rec) {
  if (!rec || typeof rec !== 'object') return false
  if (rec.kind === AUDIT.RESTART_REQUESTED || rec.kind === 'restart-committed') return true
  return rec.action === 'restart' && (rec.phase === 'requested' || rec.phase === 'committed')
}

/** A restart was closed (approved/denied/timeout all resolve to restart-resolved). */
function isRestartResolved(rec) {
  if (!rec || typeof rec !== 'object') return false
  return rec.kind === AUDIT.RESTART_RESOLVED || rec.action === 'restart-resolved'
}

export function apply(ctx, config) {
  // v2 §1：角色门禁必须是 apply 的第一件事；未部署到该角色时不注册服务/不自检。
  const gate = roleGate('auditor', {
    cfgRole: config && typeof config === 'object' ? config.role : '',
    logger: ctx.logger,
  })
  if (!gate.active) return null
  const scope = gate.role
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  let layout
  try {
    layout = resolveFangLayout({ dataRoot: cfg.dataRoot })
  } catch {
    layout = { dataDir: '', ledgerFile: path.resolve('audit.jsonl') }
  }
  const ledgerFile = cfg.ledgerFile ? path.resolve(cfg.ledgerFile) : layout.ledgerFile
  // Identity of THIS plugin instance: records carrying it are this run's own writes.
  const instanceId = newId('inst')
  let lastError = null
  let lastBoot = null
  // Fail-closed after a chain check failed: appending on top of a broken chain would
  // launder the tampering (the kernel appendChained only refuses an unparsable TAIL).
  let integrityBroken = false

  /** Tolerant JSONL read: bad lines are skipped here and reported by verify(). */
  const readAll = () => {
    const raw = readTextSafe(ledgerFile, '')
    const out = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const rec = JSON.parse(line)
        if (rec && typeof rec === 'object') out.push(rec)
      } catch {
        /* verify() reports the index; reading must not throw */
      }
    }
    return out
  }

  /**
   * Append one chained record. `at` and `seq` are filled automatically; `data` wins on
   * collision (so callers can record a fork's own pid via data.pid).
   * @returns {object|null} the appended record, or null when the ledger tail is unusable.
   */
  const append = (kind, data) => {
    if (typeof kind !== 'string' || !kind.trim()) return null
    if (integrityBroken) {
      lastError = 'ledger-integrity-broken: refusing to append on top of a broken chain'
      return null
    }
    try {
      ensureDir(path.dirname(ledgerFile))
      const body = {
        kind: kind.trim(),
        pid: process.pid,
        at: iso(nowMs()),
        ...(data ?? {}),
        inst: (data && data.inst) || instanceId,
      }
      const chain = appendChained(ledgerFile, body)
      lastError = null
      return { ...body, ...chain }
    } catch (e) {
      // An unparsable tail is deliberately NOT overwritten (that would hide tampering).
      lastError = msgOf(e)
      return null
    }
  }

  /** @returns {object[]} the newest `limit` records (default 100, 0 = none). */
  const read = (opts = {}) => {
    const recs = readAll()
    const rawLimit = opts == null ? 100 : opts.limit
    if (rawLimit === undefined || rawLimit === null) return recs.slice(-100)
    const limit = Math.max(0, Math.floor(Number(rawLimit) || 0))
    return limit === 0 ? [] : recs.slice(-limit)
  }

  /** Whole-chain verification; names the first bad record by its seq. */
  const verify = () => {
    const result = verifyChain(ledgerFile)
    integrityBroken = !result.ok
    const recs = readAll()
    const badIndex = Number.isInteger(result.badIndex) ? result.badIndex : null
    const badRec = badIndex !== null ? recs[badIndex] : null
    return {
      ok: !!result.ok,
      records: Number.isFinite(result.count) ? result.count : recs.length,
      firstBadSeq: result.ok ? null : (badRec && Number.isFinite(badRec.seq) ? badRec.seq : badIndex),
      badIndex,
      reason: result.reason ?? null,
      expected: result.expected,
      actual: result.actual,
    }
  }

  /**
   * Startup admission gate — read-only (CONTRACTS.md §5.2).
   * Only records not written by this instance AND carrying a parsable timestamp are
   * treated as "the previous run"; kernel boot-verify rows have no `at` and are skipped.
   * @returns {{ok:boolean, findings:{id:string, level:'warn'|'error', message:string, detail?:object}[], records:number}}
   */
  const bootCheck = () => {
    // Integrity is a precondition for appending; cache the verdict so a corrupt ledger
    // cannot be extended later in this run (bootCheck itself stays read-only).
    try {
      const chain = verifyChain(ledgerFile)
      integrityBroken = !chain.ok
    } catch {
      /* a read-only integrity probe must never throw out of bootCheck */
    }
    const recs = readAll()
    const previous = []
    for (const rec of recs) {
      if (!rec || typeof rec !== 'object') continue
      if (rec.inst !== undefined && rec.inst === instanceId) continue // this run's own writes
      if (!Number.isFinite(Date.parse(String(rec.at ?? '')))) continue // unstructured row (e.g. boot-verify)
      previous.push(rec)
    }
    const findings = []

    const last = previous.length ? previous[previous.length - 1] : null
    if (last) {
      const lastKind = last.kind ?? last.action ?? null
      if (lastKind !== AUDIT.SHUTDOWN_GRACEFUL) {
        findings.push({
          id: 'unclean-boot',
          level: 'warn',
          message: `上次运行未干净收尾：最后一条记录是 ${lastKind ?? 'unknown'}（缺少 shutdown-graceful）`,
          detail: { lastKind, seq: last.seq ?? null, at: last.at ?? null, pid: last.pid ?? null },
        })
      }
    }

    let lastOpen = -1
    for (let i = 0; i < previous.length; i++) if (isRestartOpen(previous[i])) lastOpen = i
    if (lastOpen >= 0 && !previous.slice(lastOpen + 1).some(isRestartResolved)) {
      const open = previous[lastOpen]
      findings.push({
        id: 'interrupted-in-guard',
        level: 'warn',
        message: '上次运行死在守卫中途：restart 已发起但始终没有 restart-resolved',
        detail: {
          requestId: open.requestId ?? null,
          kind: open.kind ?? null,
          at: open.at ?? null,
          seq: open.seq ?? null,
        },
      })
    }

    return { ok: findings.length === 0, findings, records: recs.length, previous: previous.length, pid: process.pid }
  }

  // ───────── v2 §5.7 汇总 / 商用钩子 ─────────

  const atMsOf = (rec) => {
    const ms = Date.parse(String(rec?.at ?? ''))
    return Number.isFinite(ms) ? ms : null
  }
  const seqOf = (rec) => {
    const n = Number(rec?.seq)
    return Number.isFinite(n) ? n : null
  }
  /** 合并多进程时间线：优先 at（不同进程的 seq 各自从 0 起，不可跨源比较），同刻退回 seq。 */
  const compareRecords = (a, b) => {
    const aAt = atMsOf(a)
    const bAt = atMsOf(b)
    if (aAt !== null && bAt !== null && aAt !== bAt) return aAt - bAt
    const aSeq = seqOf(a)
    const bSeq = seqOf(b)
    if (aSeq !== null && bSeq !== null && aSeq !== bSeq) return aSeq - bSeq
    return 0
  }
  const sourceTaskId = (source) => {
    const raw = source && typeof source === 'object' ? source.taskId : null
    return raw === undefined || raw === null ? null : String(raw)
  }

  /**
   * v2 §5.7：纯汇总（只读本进程账本 + 调用方拉来的分身记录；不写盘、不改链）。
   * 本地记录 taskId=null；每个 source 的记录强制打上该 source 的 taskId；
   * 按 at/seq 升序合并后返回最新 limit 条（与 read() 的"最新 N 条"语义一致）。
   */
  const aggregate = (options = {}) => {
    const rawLimit = options?.limit === undefined || options?.limit === null ? 200 : Number(options.limit)
    const limit = Number.isFinite(rawLimit) ? Math.max(0, Math.floor(rawLimit)) : 200
    const sources = Array.isArray(options?.sources) ? options.sources : []
    const merged = []
    for (const rec of readAll()) {
      if (rec && typeof rec === 'object') merged.push({ ...rec, taskId: null })
    }
    for (const source of sources) {
      const taskId = sourceTaskId(source)
      const records = Array.isArray(source?.records) ? source.records : []
      for (const rec of records) {
        if (rec && typeof rec === 'object') merged.push({ ...rec, taskId })
      }
    }
    merged.sort(compareRecords)
    const total = merged.length
    return {
      ok: true,
      scope,
      total,
      records: limit === 0 ? [] : merged.slice(-limit),
      sources: sources.map(sourceTaskId),
    }
  }

  /** 商用备份/云上传钩子占位（CONTRACTS-V2 §6：本期只留接入点，不实现传输）。 */
  const cloudSink = () => ({ ok: false, reason: 'not-configured' })

  const service = {
    scope,
    append,
    read,
    verify,
    bootCheck,
    /** v2 别名：bootCheck 的等价物（保留 v1 名称）。 */
    bootAudit: bootCheck,
    aggregate,
    cloudSink,
    get ledgerFile() {
      return ledgerFile
    },
    get instanceId() {
      return instanceId
    },
    get lastError() {
      return lastError
    },
    get lastBoot() {
      return lastBoot
    },
  }

  ctx.effect(() => ctx.provide(SERVICE.auditor, service))
  if (cfg.bootSelfCheck) {
    // Read-only: apply never writes the ledger. Findings stay on the service for the
    // orchestrator/UI to pick up; recording them is an explicit append() by the caller.
    try {
      lastBoot = bootCheck()
    } catch (e) {
      lastBoot = { ok: false, findings: [], records: 0, error: msgOf(e) }
    }
  }
  return service
}

export const _internals = { isRestartOpen, isRestartResolved, DEFAULTS }
