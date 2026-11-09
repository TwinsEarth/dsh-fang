// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// fang-restart-guard — 2.6 红线守卫：**只拦母体重启**
//
// 硬边界（CONTRACTS §1.2 / §1.3）：
//   * 只服务母体重启；分身重启 = forker.reap() + 重新 fork()，不经过本插件。
//   * v3.1.x 默认「决策 + 审计 + 审批 + 授权清单」，**不退出**进程。
//     只有三重门禁同时满足时才把执行权交出去：mode==='enforce' ∧ allowProcessRestart===true
//     ∧ 外部 supervisor 在位（FANG_RESTART_SUPERVISOR 环境变量，或 watchdog 写的
//     <stateDir>/supervisor.present 且 execute===true、未过期、写入进程存活）。
//     三者缺一：只写清单、execution.executed 恒 false，进程继续运行。
//     契约见 src/lib/restart-contract.mjs 与 docs/RESTART-SUPERVISOR-CONTRACT.md。
//   * 单飞状态机 idle → collecting → awaiting → executing → idle；并发请求的第二个直接 busy 拒绝。
//   * 决策矩阵移植自 dsh-hot-update/packages/restart-guard/index.js 的 classifyRisk/findGrant/decide
//     （policy.mode = 授权模式 manual|temp|auto，与 policy() 里的守卫层 mode=observe|enforce 不是同一个字段）。
//   * needs-approval 时通过 ctx.get(SERVICE.approver)?.request(...) 走审批；审批服务缺失或抛错 => fail-closed。
import path from 'node:path'
import fs from 'node:fs'
import { AUDIT, EXIT, GUARD_STATE, RISK, SERVICE, bus, newId, newUuid, riskAtLeast, z } from '../kernel/index.mjs'
import {
  appendJsonl,
  ensureDir,
  readJson,
  readTextSafe,
  resolveFangLayout,
  writeJsonAtomic,
} from '../kernel/index.mjs'
import { roleGate } from '../kernel/index.mjs'
import {
  APPROVAL_KIND,
  CONTRACT_VERSION,
  EXECUTION_KIND,
  LATEST_KIND,
  approvalDir,
  approvalFile,
  buildApprovalManifest,
  executionDir,
  inspectApproval,
  latestApprovalFile,
  listApprovalIds,
  pruneRestartState,
  receiptFile,
  reconcileRestartState,
  resolveHmacSecret,
  summarizeApproval,
  summarizeApprovalCounts,
} from '../lib/restart-contract.mjs'

export const name = 'fang-restart-guard'
export const inject = []

const DEFAULTS = Object.freeze({
  mode: 'observe',
  authMode: 'manual',
  strictRedLine: true,
  approvalTimeoutMs: 300000,
  allowProcessRestart: false,
  autoPromoteAfterHours: 24,
  dataRoot: '',
  manifestTtlMs: 60000,
})

export const Config = z.object({
  mode: z.union(['observe', 'enforce']).default('observe')
    .description('守卫执行层：observe 只决策不退出；enforce 是与 allowProcessRestart + supervisor 在位 共同组成的三重门禁'),
  authMode: z.union(['manual', 'temp', 'auto']).default('manual')
    .description('授权模式：manual 逐次询问 / temp 临时授权 / auto 非红自动放行（决策矩阵的 policy.mode）'),
  strictRedLine: z.boolean().default(true)
    .description('红灯是否必须人工确认'),
  approvalTimeoutMs: z.number().min(1000).max(86400000).default(300000)
    .description('审批等待上限（毫秒）；审批服务本身也会收到 ttlMs'),
  allowProcessRestart: z.boolean().default(false)
    .description('第二把钥匙：默认 false。只有 enforce + true + supervisor 在位时才在批准后 exit(75) 交接执行权'),
  autoPromoteAfterHours: z.union([6, 12, 24]).default(24)
    .description('保留字段（bundle 配置兼容）：自动晋升归属编排器/晋升流程，本插件不消费'),
  dataRoot: z.string().default('')
    .description('Fang 数据根目录；留空 = resolveFangLayout() 默认。状态存 <dataDir>/restart/state.json'),
  manifestTtlMs: z.number().min(1000).max(900000).default(60000)
    .description('授权清单（supervisor 契约）的有效期（毫秒）；过期清单不能再被执行'),
})

export const RISK_VALUES = [RISK.BLUE, RISK.YELLOW, RISK.RED]
const RANK = { blue: 1, yellow: 2, red: 3 }
const REQUESTED_TOPIC = 'fang/restart-requested'
const RESOLVED_TOPIC = 'fang/restart-resolved'
const APPROVED_TOPIC = 'fang/restart-approved'

const errText = (e) => String(e?.message ?? e)
const safeGet = (ctx, key) => { try { return ctx.get(key) } catch { return undefined } }
const isRisk = (v) => typeof v === 'string' && Object.prototype.hasOwnProperty.call(RANK, v)

// ───────────────────────── 决策矩阵（与参考实现同构，parity 守住） ─────────────────────────
/** 风险分级：origin/scope/级联灯色 → blue|yellow|red；没有 digests 时升一级（看不见内容就不许判蓝）。 */
export function classifyRisk(input = {}) {
  let raw
  if (input.origin === 'supervisor' || input.origin === 'cron') raw = RISK.RED
  else if (String(input.origin ?? '').startsWith('cli:kill')) raw = RISK.RED
  else if (input.originLight === 'red') raw = RISK.RED
  else if (input.scope === 'system' || input.scope === 'process') raw = RISK.RED
  else if (input.scope === 'session') raw = RISK.YELLOW
  else if (input.origin === 'cli' || input.origin === 'user-quit') raw = RISK.YELLOW
  else if (input.originLight === 'yellow') raw = RISK.YELLOW
  else raw = RISK.BLUE
  if ((input.digests ?? []).length > 0) return raw
  return raw === RISK.BLUE ? RISK.YELLOW : RISK.RED
}

/** 临时授权（temp 模式）：scope/target/maxRisk/digests 全部匹配且未过期才算数。 */
export function findGrant(grants, req, now = Date.now()) {
  return (grants ?? []).find(g =>
    g.expiresAt > now &&
    g.scope === req.scope &&
    (g.target === undefined || g.target === req.target) &&
    RANK[g.maxRisk] >= RANK[req.risk] &&
    (req.digests ?? []).every(d => (g.digests ?? []).includes(d)))
}

/** 决策：forcedApproval 一票否决 → 授权模式（policy.mode=manual|temp|auto）→ strictRedLine。 */
export function decide(req, policy = {}, now = Date.now()) {
  if (req.forcedApproval) return 'needs-approval'
  if (policy.mode === 'manual') return req.risk === RISK.BLUE ? 'auto-allow' : 'needs-approval'
  if (policy.mode === 'temp') {
    if (req.risk === RISK.BLUE) return 'auto-allow'
    return findGrant(policy.grants, req, now) ? 'auto-allow' : 'needs-approval'
  }
  if (!riskAtLeast(req.risk, RISK.RED)) return 'auto-allow' // blue / yellow
  return policy.strictRedLine ? 'needs-approval' : 'auto-allow'
}

export function apply(ctx, config) {
  const gate = roleGate('restartGuard', { cfgRole: config?.role, logger: ctx.logger })
  // v2 deployment matrix: this plugin is not deployed in this role — register nothing.
  if (!gate.active) return
  let validated
  try { validated = Config(config ?? {}) } catch (e) {
    throw new Error(`[fang-restart-guard] config invalid: ${errText(e).replace(/^\$\./, '')}`)
  }
  const cfg = { ...DEFAULTS, ...validated }
  /** 决策矩阵用授权策略；注意它的 mode 是 manual|temp|auto（不是守卫层 observe|enforce）。 */
  const authPolicy = { mode: cfg.authMode, grants: [], strictRedLine: cfg.strictRedLine, approvalTimeoutMs: cfg.approvalTimeoutMs }
  const tempEffectiveManual = cfg.authMode === 'temp' && authPolicy.grants.length === 0
  const log = (level, msg) => { try { ctx.logger?.[level]?.(`[fang-restart-guard] ${msg}`) } catch { /* 日志不许破状态机 */ } }
  if (tempEffectiveManual) log('warn', 'authMode=temp has no grants; effective mode is manual (temp-effective-manual)')
  if (cfg.strictRedLine === false) log('warn', 'strictRedLine=false: red requests may be auto-allowed in auto mode')

  /** 单飞状态机：pending 只描述「正在处理的唯一请求」。 */
  const machine = { state: GUARD_STATE.IDLE, pending: null }
  const timers = new Set()
  /** Set while awaiting an approval; dispose() calls it so the outer request settles. */
  let abortActiveApproval = null

  const layout = resolveFangLayout({ dataRoot: cfg.dataRoot })
  const stateDir = path.join(layout.dataDir, 'restart')
  const stateFile = path.join(stateDir, 'state.json')
  // supervisor 契约落盘目录（详见 src/lib/restart-contract.mjs 与 docs/RESTART-SUPERVISOR-CONTRACT.md）
  const approvedDir = approvalDir(stateDir)
  const executedDir = executionDir(stateDir)
  const instanceId = newUuid()
  const pidFile = layout.pidFile
  const supervisorMarkerFile = path.join(stateDir, 'supervisor.present')
  const bootStateFile = path.join(stateDir, 'boot-state.json')
  const crashLedgerFile = path.join(stateDir, 'runtime-crash.jsonl')
  const SUPERVISOR_MARKER_TTL_MS = 60000
  const pidAlive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
  }

  // 运行时崩溃账本：只监听 uncaughtExceptionMonitor（不改变宿主退出行为），记录后供下次启动/
  // launcher 判断“上次是不是启动期崩溃”。真正的 apply/import 硬失败仍由宿主决定是否退出。
  const previousBoot = readJson(bootStateFile, null)
  const lastUncleanBoot = previousBoot
    && (previousBoot.state === 'booting' || previousBoot.state === 'crashed')
    && Number(previousBoot.pid) !== process.pid
    && !pidAlive(Number(previousBoot.pid))
    ? { state: String(previousBoot.state), pid: Number(previousBoot.pid) || null, at: Number(previousBoot.at) || 0, error: previousBoot.error ?? null }
    : null
  const writeBootState = (state, extra = {}) => {
    try {
      ensureDir(stateDir)
      writeJsonAtomic(bootStateFile, { state, pid: process.pid, at: Date.now(), ...extra })
    } catch { /* boot state must never break boot */ }
  }
  writeBootState('booting', lastUncleanBoot ? { previous: lastUncleanBoot } : {})
  const bootTimer = setTimeout(() => writeBootState('running'), 10000)
  bootTimer.unref?.()
  const onUncaughtException = (error, origin) => {
    try {
      appendJsonl(crashLedgerFile, {
        at: Date.now(), pid: process.pid, origin: String(origin ?? 'uncaughtException'),
        message: String(error?.message ?? error).slice(0, 500),
        stack: String(error?.stack ?? '').slice(0, 4000),
      })
    } catch { /* crash ledger must never throw */ }
    writeBootState('crashed', { error: String(error?.message ?? error).slice(0, 500), origin: String(origin ?? '') })
  }
  process.on('uncaughtExceptionMonitor', onUncaughtException)
  ctx.effect(() => () => {
    try { clearTimeout(bootTimer) } catch { /* ignore */ }
    try { process.off('uncaughtExceptionMonitor', onUncaughtException) } catch { /* ignore */ }
    writeBootState('clean')
  })
  /** 母体 pid 文件：外部看护（watchdog）用它判断「哪个宿主死了」。 */
  const writeHostPid = () => {
    try {
      ensureDir(path.dirname(pidFile))
      writeJsonAtomic(pidFile, { version: 1, pid: process.pid, role: gate.role, at: Date.now() })
    } catch (error) {
      log('warn', `pid file write failed: ${errText(error)}`)
    }
  }
  const clearHostPid = () => {
    try {
      const raw = readJson(pidFile, null)
      if (raw && Number(raw.pid) === process.pid) fs.unlinkSync(pidFile)
    } catch { /* pid 文件清理失败不影响退出 */ }
  }
  /**
   * 外部看护是否在位。只认两种可信来源：
   *   1) 环境变量 FANG_RESTART_SUPERVISOR（由用户/启动脚本显式设置）；
   *   2) <stateDir>/supervisor.present，且 execute===true、未过 TTL、写入进程仍存活。
   * 幽灵 marker（watchdog 崩溃）不会被当成 supervisor。
   */
  const detectSupervisor = () => {
    const envValue = String(process.env.FANG_RESTART_SUPERVISOR ?? '').trim()
    if (envValue) return { present: true, via: 'env', id: envValue }
    const marker = readJson(supervisorMarkerFile, null)
    if (!marker || marker.execute !== true) return { present: false, via: null, id: null }
    const at = Number(marker.at)
    if (!Number.isFinite(at) || Date.now() - at > SUPERVISOR_MARKER_TTL_MS) return { present: false, via: null, id: null }
    if (!pidAlive(Number(marker.pid))) return { present: false, via: null, id: null }
    return { present: true, via: 'file', id: String(marker.supervisor ?? 'watchdog') }
  }
  /** 三重门禁：enforce ∧ allowProcessRestart ∧ supervisor 在位，才允许把执行权交出去。 */
  const executionArmed = () => {
    const supervisor = detectSupervisor()
    return {
      armed: cfg.mode === 'enforce' && cfg.allowProcessRestart === true && supervisor.present === true,
      supervisor,
      mode: cfg.mode,
      allowProcessRestart: cfg.allowProcessRestart === true,
    }
  }
  writeHostPid()
  /** 本进程最近一次成功写出的授权清单（仅供 state() 展示，不是执行依据）。 */
  let lastManifest = null
  let lastInterrupted = null
  const persistState = (extra = {}) => {
    try {
      ensureDir(stateDir)
      writeJsonAtomic(stateFile, {
        version: 1,
        state: machine.state,
        pending: machine.pending ? { ...machine.pending } : null,
        at: Date.now(),
        ...(lastInterrupted ? { lastInterrupted } : {}),
        ...extra,
      })
    } catch (error) {
      log('warn', `state persist failed: ${errText(error)}`)
    }
  }
  const readState = () => {
    const raw = readTextSafe(stateFile, '')
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  }

  const audit = (kind, data) => {
    try {
      const auditor = safeGet(ctx, SERVICE.auditor)
      if (auditor && typeof auditor.append === 'function') return auditor.append(kind, data) ?? null
    } catch (e) {
      log('warn', `audit ${kind} degraded: ${errText(e)}`)
    }
    return null
  }
  const emit = (topic, payload) => {
    try { return bus.emit(topic, payload) } catch (e) { log('warn', `emit ${topic} failed: ${errText(e)}`); return 0 }
  }

  // 清单签名 key（env 优先；否则 stateDir/restart-hmac.key，0600，首次生成）。
  const hmac = resolveHmacSecret(stateDir)
  if (!hmac.ok) log('warn', `manifest HMAC unavailable (${hmac.reason}); manifests remain digest-only`)
  const hmacSecret = hmac.ok ? hmac.secret : null
  const inspectOptions = (now = Date.now()) => ({ now, hmacSecret, requireSignature: hmacSecret !== null })

  // 启动对账 + 旧清单 prune：不信任「上次进程还活着」的残留状态。
  try {
    const reconciled = reconcileRestartState(stateDir, { hmacSecret })
    if (reconciled.checked > 0) {
      log('info', `startup reconcile: checked=${reconciled.checked} armed=${reconciled.counts.armed} executed=${reconciled.counts.executed} stale=${reconciled.counts.stale} invalid=${reconciled.counts.invalid}`)
      audit('restart-reconcile', { checked: reconciled.checked, counts: reconciled.counts, hmac: hmac.ok ? hmac.source : 'unavailable' })
    }
    const pruned = pruneRestartState(stateDir, { hmacSecret })
    if (pruned.removed.length > 0) {
      log('info', `startup prune: removed ${pruned.removed.length} old manifest(s)`)
      audit('restart-manifest-pruned', { removed: pruned.removed, kept: pruned.kept })
    }
  } catch (error) {
    log('warn', `startup reconcile/prune failed: ${errText(error)}`)
  }

  // Crash/interrupted recovery: the old Promise no longer exists. Mark it interrupted,
  // pair the audit trail, and never pretend the request is still pending.
  const previousState = readState()
  if (previousState && previousState.state && previousState.state !== GUARD_STATE.IDLE) {
    const old = previousState.pending ?? {}
    const interruptedId = String(old.id ?? newId('rst'))
    const interruptedRisk = isRisk(old.risk) ? old.risk : RISK.RED
    lastInterrupted = {
      id: interruptedId,
      risk: interruptedRisk,
      previousState: previousState.state,
      previousPhase: old.phase ?? null,
      approvalId: old.approvalId ?? null,
      at: Date.now(),
    }
    audit(AUDIT.RESTART_RESOLVED, {
      id: interruptedId,
      outcome: 'interrupted',
      decision: 'needs-approval',
      risk: interruptedRisk,
      reason: String(old.reason ?? 'process-restarted'),
      deniedReason: 'process-restarted',
      by: 'restart',
      approvalId: old.approvalId ?? null,
      previousState: previousState.state,
      previousPhase: old.phase ?? null,
    })
    emit(RESOLVED_TOPIC, {
      id: interruptedId,
      outcome: 'interrupted',
      reason: String(old.reason ?? 'process-restarted'),
      risk: interruptedRisk,
      deniedReason: 'process-restarted',
      approvalId: old.approvalId ?? null,
    })
    persistState()
  }

  /**
   * 影响面：从 forker.list() 与 buffer.state() 收集；服务缺失/抛错一律降级为空（绝不因收集失败拒绝请求）。
   * pendingPromotes 来自 approver.pending() 里的 promote 工单；activeSessions 在 v1.0.0 没有可读会话服务 → 0。
   */
  const impact = () => {
    const report = { activeForks: [], pendingPromotes: [], dirtyBuffers: [], activeSessions: 0 }

    const forker = safeGet(ctx, SERVICE.forker)
    if (forker && typeof forker.list === 'function') {
      try {
        const list = forker.list() ?? []
        report.activeForks = list
          .filter(f => f && (f.running === true || f.status === 'running'))
          .map(f => String(f.forkId))
      } catch (e) { log('warn', `impact forker degraded: ${errText(e)}`) }
    }

    const buffer = safeGet(ctx, SERVICE.buffer)
    if (buffer && typeof buffer.state === 'function') {
      try {
        const st = buffer.state() ?? {}
        report.dirtyBuffers = Array.isArray(st.pending) ? st.pending.map(String) : []
      } catch (e) { log('warn', `impact buffer degraded: ${errText(e)}`) }
    }

    const approver = safeGet(ctx, SERVICE.approver)
    if (approver && typeof approver.pending === 'function') {
      try {
        const items = approver.pending() ?? []
        report.pendingPromotes = items
          .filter(i => String(i?.kind ?? '').includes('promote'))
          .map(i => String(i?.id ?? ''))
      } catch (e) { log('warn', `impact approver degraded: ${errText(e)}`) }
    }

    return report
  }

  /** 显式 risk 只能提高风险，不能压过 classifyRisk；低报不再能绕过升级。 */
  const normalizeRisk = (input = {}) => {
    const classified = classifyRisk(input)
    if (!isRisk(input.risk)) return classified
    return RANK[input.risk] > RANK[classified] ? input.risk : classified
  }

  /** 审批等待的兜底计时器：审批服务永不 resolve 时也要回到 idle，不许把状态机卡死。 */
  const withDeadline = (promise, ms) => new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => finish(resolve, { outcome: 'timeout', by: 'guard-timeout', at: Date.now() }), Math.max(1, Number(ms) || 1))
    timers.add(timer)
    function finish(fn, value) {
      if (settled) return
      settled = true
      timers.delete(timer)
      clearTimeout(timer)
      fn(value)
    }
    Promise.resolve(promise).then(v => finish(resolve, v), e => finish(reject, e))
  })

  const release = () => {
    machine.state = GUARD_STATE.IDLE
    const wasPending = machine.pending
    machine.pending = null
    persistState()
    return wasPending
  }

  /**
   * 组装并原子落盘授权清单（supervisor 契约的阶段 1）。
   * 这是「批准」唯一的外化凭据：没有清单 = supervisor 不得执行。
   */
  const writeApprovalManifest = (req, { by, outcome, approvalId, approvedAt }) => {
    const manifest = buildApprovalManifest({
      id: req.id,
      risk: req.risk,
      outcome,
      approvalId,
      approvedBy: by,
      reason: req.reason,
      scope: req.scope,
      origin: req.origin,
      digests: req.digests,
      impactSource: req.impactSource ?? null,
      requestedAt: req.requestedAt,
      approvedAt,
      ttlMs: cfg.manifestTtlMs,
      hmacSecret,
      guard: {
        mode: cfg.mode,
        authMode: cfg.authMode,
        strictRedLine: cfg.strictRedLine,
        allowProcessRestart: cfg.allowProcessRestart,
        pid: process.pid,
        instanceId,
      },
    })
    const file = approvalFile(stateDir, manifest.id)
    writeJsonAtomic(file, manifest)
    // latest.json 只是给外部入口的便利指针，不是执行依据；清单本身才是。
    try {
      writeJsonAtomic(latestApprovalFile(stateDir), {
        version: CONTRACT_VERSION,
        kind: LATEST_KIND,
        id: manifest.id,
        file: path.basename(file),
        digest: manifest.digest,
        approvedAt: manifest.approvedAt,
        expiresAt: manifest.expiresAt,
        at: Date.now(),
      })
    } catch (error) {
      log('warn', `latest approval pointer write failed: ${errText(error)}`)
    }
    return manifest
  }

  /**
   * executing 阶段：默认只记录状态（不退出/不重启）。
   * 批准必须落盘授权清单；写不进去 => fail-closed，按拒绝处理。
   * 三重门禁（enforce + allowProcessRestart + supervisor 在位）齐了才把执行权交出去：
   * 清单/审计/事件落盘后 exit(75)，由 watchdog 拉起新宿主并写回执。
   */
  const finishApproved = (req, { decision, by = null, outcome, approvalId = null, t0 }) => {
    const approvedAt = Date.now()
    let manifest
    try {
      manifest = writeApprovalManifest(req, { by, outcome, approvalId, approvedAt })
    } catch (error) {
      // 契约层失败：不能对外声称存在一份可执行的批准。
      return finishDenied(req, 'manifest-write-failed', 'denied', {
        by, approvalId, error: errText(error), ms: Date.now() - t0,
      })
    }
    machine.state = GUARD_STATE.EXECUTING
    if (machine.pending) machine.pending.phase = GUARD_STATE.EXECUTING
    const gateState = executionArmed()
    const handoff = gateState.armed === true
    persistState(handoff ? {
      handoff: { to: 'supervisor', via: gateState.supervisor.via, at: Date.now(), exitCode: EXIT.RESTART },
    } : {})
    const execution = {
      executed: false,
      reason: handoff ? 'supervisor-handoff' : 'v3.1.x-decision-only',
      guardMode: cfg.mode,
      allowProcessRestart: cfg.allowProcessRestart === true,
      plannedExitCode: EXIT.RESTART, // 与 forker.classifyExit 的 restart-request 契约对齐
      manifestDigest: manifest.digest,
      manifestExpiresAt: manifest.expiresAt,
      handoff: handoff ? {
        requested: true, to: 'supervisor', via: gateState.supervisor.via,
        id: gateState.supervisor.id, exitCode: EXIT.RESTART,
      } : null,
    }
    const authorization = {
      contractVersion: CONTRACT_VERSION,
      manifestId: manifest.id,
      nonce: manifest.nonce,
      digest: manifest.digest,
      expiresAt: manifest.expiresAt,
      manifestPath: approvalFile(stateDir, manifest.id),
      receiptPath: receiptFile(stateDir, manifest.id),
    }
    lastManifest = {
      id: manifest.id, digest: manifest.digest, expiresAt: manifest.expiresAt, path: authorization.manifestPath,
    }
    const result = {
      id: req.id, outcome, decision, risk: req.risk, by, approvalId,
      impactSource: req.impactSource ?? null,
      requestedAt: req.requestedAt, execution, authorization, ms: Date.now() - t0,
    }
    audit(AUDIT.RESTART_RESOLVED, {
      id: req.id, outcome, decision, risk: req.risk, reason: req.reason, scope: req.scope,
      origin: req.origin, by, approvalId, execution, guardMode: cfg.mode,
      impactSource: req.impactSource ?? null, ms: result.ms,
      manifestDigest: manifest.digest, manifestExpiresAt: manifest.expiresAt,
      manifestPath: authorization.manifestPath,
      handoff: handoff ? { to: 'supervisor', via: gateState.supervisor.via, exitCode: EXIT.RESTART } : null,
    })
    emit(RESOLVED_TOPIC, { id: req.id, outcome, reason: req.reason, risk: req.risk, approvalId })
    // Supervisor contract: this event is advisory only. Durability lives in the manifest;
    // a supervisor must verify the manifest and write an execution receipt with
    // execution.executed === true before a restart counts as executed.
    if (outcome === 'approved' || outcome === 'auto-allow') {
      emit(APPROVED_TOPIC, {
        id: req.id, outcome, decision, risk: req.risk, reason: req.reason,
        scope: req.scope, origin: req.origin, approvalId,
        impactSource: req.impactSource ?? null, execution, authorization,
        handoff: execution.handoff,
      })
    }
    if (handoff) {
      // 三重门禁齐了才走到这里：清单/审计/事件已经落盘，交执行权给外部 supervisor。
      // 25ms 让调用方 Promise 结算、审计行 flush；之后宿主退出码 75，由 watchdog 拉起。
      log('warn', `restart ${req.id} approved and armed; handing off to supervisor (${gateState.supervisor.via}); exit(${EXIT.RESTART})`)
      const exitTimer = setTimeout(() => {
        process.exitCode = EXIT.RESTART
        process.exit(EXIT.RESTART)
      }, 25)
      timers.add(exitTimer)
    } else {
      release()
    }
    return result
  }

  const finishDenied = (req, reason, outcome, extra = {}) => {
    const result = {
      id: req.id, outcome, decision: 'needs-approval', risk: req.risk,
      reason, by: extra.by ?? null, approvalId: extra.approvalId ?? null, ms: extra.ms ?? 0,
      impactSource: req.impactSource ?? null,
      ...(extra.error ? { error: extra.error } : {}),
    }
    audit(AUDIT.RESTART_RESOLVED, {
      id: req.id, outcome, decision: 'needs-approval', risk: req.risk, reason: req.reason,
      scope: req.scope, origin: req.origin, deniedReason: reason,
      by: result.by, approvalId: result.approvalId, guardMode: cfg.mode,
      impactSource: req.impactSource ?? null,
      ...(extra.error ? { error: extra.error } : {}),
    })
    emit(RESOLVED_TOPIC, {
      id: req.id, outcome, reason: req.reason, risk: req.risk,
      deniedReason: reason, approvalId: extra.approvalId ?? null,
    })
    release()
    return result
  }

  /**
   * request({reason, risk, scope, origin, digests?, forcedApproval?, impact?})
   *   -> Promise<{id, outcome:'approved'|'denied'|'timeout'|'auto-allow', decision, risk, ...}>
   * 单飞：非 idle 时第二个请求直接 {outcome:'denied', reason:'busy'}（不排队）。
   */
  const request = async (rawInput = {}) => {
    const input = rawInput && typeof rawInput === 'object' ? rawInput : {}
    const t0 = Date.now()
    const risk = normalizeRisk(input)
    const reason = String(input.reason ?? 'unspecified')
    const scope = String(input.scope ?? 'mother')
    const origin = String(input.origin ?? 'unknown')
    if (machine.state !== GUARD_STATE.IDLE) {
      const busyId = newId('rst')
      const activeId = machine.pending?.id ?? null
      const activeSince = machine.pending?.since ?? null
      const retryAfterMs = Number.isFinite(machine.pending?.deadlineAt)
        ? Math.max(0, machine.pending.deadlineAt - Date.now())
        : null
      audit(AUDIT.RESTART_REQUESTED, {
        id: busyId, risk, reason, scope, origin, phase: 'rejected-busy',
        activeState: machine.state, activeId, activeSince, retryAfterMs,
      })
      audit(AUDIT.RESTART_RESOLVED, {
        id: busyId, outcome: 'denied', deniedReason: 'busy', risk,
        activeId, activeState: machine.state, retryAfterMs,
      })
      return {
        id: busyId, outcome: 'denied', reason: 'busy', decision: 'needs-approval', risk,
        activeId, activeState: machine.state, retryAfterMs, retryable: true,
      }
    }
    // 单飞认领：在这行之后任何并发 request 都会看到非 idle（async 体在首个 await 前同步执行）。
    machine.state = GUARD_STATE.COLLECTING
    let impactFromCaller = false
    let impactSource = 'service'
    const req = {
      id: newId('rst'),
      risk, reason, scope, origin,
      digests: Array.isArray(input.digests) ? input.digests.map(String) : [],
      forcedApproval: input.forcedApproval === true,
      impactSource,
      requestedAt: t0,
      deadlineAt: t0 + cfg.approvalTimeoutMs,
    }
    let impactReport
    try {
      impactFromCaller = input.impact !== undefined && input.impact !== null
      impactSource = impactFromCaller ? 'caller' : 'service'
      req.impactSource = impactSource
      impactReport = impactFromCaller ? input.impact : impact()
    } catch (e) {
      // A throwing caller-supplied impact getter must not leave the guard stuck in COLLECTING.
      return finishDenied(req, 'impact-failed', 'denied', { error: errText(e), ms: Date.now() - t0 })
    }
    machine.pending = {
      id: req.id, risk: req.risk, reason, scope, origin,
      phase: GUARD_STATE.COLLECTING, since: t0,
      deadlineAt: req.deadlineAt, approvalId: null,
    }
    persistState()

    audit(AUDIT.RESTART_REQUESTED, {
      id: req.id, risk: req.risk, reason, scope, origin, digests: req.digests,
      forcedApproval: req.forcedApproval, guardMode: cfg.mode, authMode: cfg.authMode,
      strictRedLine: cfg.strictRedLine, tempEffectiveManual,
      impactSource, impact: impactReport,
    })
    emit(REQUESTED_TOPIC, { id: req.id, risk: req.risk })

    let decision
    try {
      decision = decide(req, authPolicy, Date.now())
    } catch (e) {
      return finishDenied(req, 'internal-error', 'denied', { error: errText(e), ms: Date.now() - t0 })
    }

    if (decision === 'auto-allow') {
      return finishApproved(req, { decision, outcome: 'auto-allow', by: 'policy', t0 })
    }

    // needs-approval：进入 awaiting，走审批服务；服务缺失/抛错 => fail-closed。
    machine.state = GUARD_STATE.AWAITING
    if (machine.pending) machine.pending.phase = GUARD_STATE.AWAITING
    persistState()
    const approver = safeGet(ctx, SERVICE.approver)
    if (!approver || typeof approver.request !== 'function') {
      return finishDenied(req, 'approver-unavailable', 'denied', { ms: Date.now() - t0 })
    }

    let answer
    let aborted = false
    const abortPromise = new Promise((resolve) => {
      abortActiveApproval = () => { aborted = true; resolve({ outcome: 'guard-disposed' }) }
    })
    try {
      answer = await Promise.race([
        withDeadline(approver.request({
          kind: 'restart',
          risk: req.risk,
          title: `母体重启：${reason}`,
          detail: `origin=${origin} scope=${scope} risk=${req.risk} guardMode=${cfg.mode}`,
          impact: impactReport,
          impactSource,
          ttlMs: cfg.approvalTimeoutMs,
        }), cfg.approvalTimeoutMs),
        abortPromise,
      ])
    } catch (e) {
      return finishDenied(req, 'approver-error', 'denied', { error: errText(e), ms: Date.now() - t0 })
    } finally {
      abortActiveApproval = null
    }
    if (aborted) {
      return finishDenied(req, 'guard-disposed', 'denied', { ms: Date.now() - t0 })
    }

    const outcome = answer?.outcome ?? 'timeout'
    const approvalId = answer?.id ?? null
    const by = answer?.by ?? null
    if (outcome === 'approved') {
      return finishApproved(req, { decision, by, outcome: 'approved', approvalId, t0 })
    }
    if (outcome === 'timeout') {
      return finishDenied(req, 'approval-timeout', 'timeout', { approvalId, by, ms: Date.now() - t0 })
    }
    return finishDenied(req, 'approval-denied', 'denied', { approvalId, by, ms: Date.now() - t0 })
  }

  /** 只决策、不进状态机、不审计（给其它插件做预检/面板用）。 */
  const decideOnly = (input = {}) => {
    const risk = normalizeRisk(input)
    const req = {
      ...input,
      risk,
      digests: Array.isArray(input.digests) ? input.digests.map(String) : [],
      forcedApproval: input.forcedApproval === true,
    }
    return { decision: decide(req, authPolicy, Date.now()), risk }
  }

  const state = () => {
    const supervisor = detectSupervisor()
    const gateState = executionArmed()
    return {
      state: machine.state,
      pending: machine.pending ? { ...machine.pending } : null,
      mode: cfg.mode, // 守卫执行层 observe|enforce
      authMode: cfg.authMode, // 决策矩阵授权模式 manual|temp|auto
      strictRedLine: cfg.strictRedLine,
      redLineAutoAllowed: cfg.strictRedLine === false,
      tempEffectiveManual,
      grants: authPolicy.grants.length,
      allowProcessRestart: cfg.allowProcessRestart === true,
      restartExitCode: EXIT.RESTART,
      stateFile,
      pidFile,
      lastInterrupted,
      // supervisor 契约（只读展示）：清单目录、回执目录、最近一次授权
      contractVersion: CONTRACT_VERSION,
      manifestTtlMs: cfg.manifestTtlMs,
      approvalDir: approvedDir,
      executionDir: executedDir,
      lastManifest,
      supervisorPresent: supervisor.present === true,
      supervisor,
      executionArmed: gateState.armed === true,
      execution: { executed: false, decisionOnly: true },
    }
  }

  const policy = () => {
    const supervisor = detectSupervisor()
    const gateState = executionArmed()
    return {
      mode: cfg.mode, // observe|enforce（守卫执行层，不是决策矩阵的授权模式）
      authMode: cfg.authMode, // manual|temp|auto
      strictRedLine: cfg.strictRedLine,
      redLineAutoAllowed: cfg.strictRedLine === false,
      tempEffectiveManual,
      grants: authPolicy.grants.length,
      approvalTimeoutMs: cfg.approvalTimeoutMs,
      allowProcessRestart: cfg.allowProcessRestart === true,
      restartExitCode: EXIT.RESTART,
      decisionOnly: true,
      manifestTtlMs: cfg.manifestTtlMs,
      supervisorPresent: supervisor.present === true,
      supervisor,
      executionArmed: gateState.armed === true,
    }
  }

  /**
   * supervisor 契约（阶段 1 授权清单 / 阶段 2 执行回执）。
   * 默认决策层不退出；三重门禁齐了才 exit(75) 交接给外部 watchdog。
   * 任何「已执行」结论只认回执 execution.executed === true。
   */
  const executionContract = () => {
    const gateState = executionArmed()
    return {
      version: CONTRACT_VERSION,
      decisionOnly: true,
      guardExecuted: false,
      plannedExitCode: EXIT.RESTART,
      manifestTtlMs: cfg.manifestTtlMs,
      supervisorPresent: gateState.supervisor.present === true,
      executionArmed: gateState.armed === true,
      approval: {
        kind: APPROVAL_KIND,
        dir: approvedDir,
        pattern: '<requestId>.json',
        latest: latestApprovalFile(stateDir),
      },
      receipt: {
        kind: EXECUTION_KIND,
        dir: executedDir,
        pattern: '<requestId>.json',
      },
      supervisor: {
        armedWhen: [
          'manifest.guard.mode === "enforce"',
          'manifest.guard.allowProcessRestart === true',
        ],
        handoffWhen: [
          'config.mode === "enforce"',
          'config.allowProcessRestart === true',
          'supervisor present (FANG_RESTART_SUPERVISOR env or live <stateDir>/supervisor.present with execute === true)',
        ],
        handoff: 'guard writes the manifest + audit, then exits 75; watchdog relaunches and writes the receipt',
        mayExecuteWhen: [
          'manifest digest valid (sha256 over canonical body)',
          'manifest not expired (expiresAt > now)',
          'manifest.execution.executed === false (the guard never restarts by itself)',
          'manifest.execution.decisionOnly === true',
          'manifest is armed (guard.mode=enforce and allowProcessRestart=true)',
          'no execution receipt exists for this request id',
        ],
        mustWriteReceipt: true,
        receiptRequirements: [
          'receipt.execution.executed === true',
          'receipt.nonce equals manifest.nonce',
          'receipt.manifestDigest equals manifest.digest',
        ],
      },
      rule: '「已执行」只认回执里的 execution.executed === true；授权清单里恒为 false。',
      note: gateState.armed
        ? 'armed: the next approved restart writes the manifest and exits 75 for the supervisor to relaunch.'
        : 'disarmed: decision-only. No supervisor handoff happens until enforce + allowProcessRestart + supervisorPresent are all true.',
    }
  }

  /** 只读：列出最近的授权清单摘要（含状态：authorized/executed/stale/invalid）。 */
  const approvals = ({ limit = 50, now = Date.now() } = {}) => {
    const max = Math.min(200, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 50))
    const rows = listApprovalIds(stateDir)
      .map(id => summarizeApproval(inspectApproval(stateDir, id, inspectOptions(now))))
      .sort((a, b) => (b.approvedAt ?? 0) - (a.approvedAt ?? 0))
    return {
      contractVersion: CONTRACT_VERSION,
      items: rows.slice(0, max),
      counts: summarizeApprovalCounts(rows),
    }
  }

  /** 只读：单份授权的完整检查（清单 + 回执 + 校验结果），不写盘、不审计。 */
  const executionStatus = (id, { now = Date.now() } = {}) => inspectApproval(stateDir, id, inspectOptions(now))

  /** 只读：当前这份授权是否可以交给 supervisor 执行（唯一放行语义）。 */
  const verifyApproval = (id, { now = Date.now() } = {}) => {
    const inspected = inspectApproval(stateDir, id, inspectOptions(now))
    return {
      id,
      found: inspected.found,
      ok: inspected.authorized === true,
      reason: inspected.blockedReason ?? null,
      expired: inspected.expired,
      digestValid: inspected.manifestVerification?.digestValid === true,
      armed: inspected.armed === true,
      authorized: inspected.authorized === true,
      executed: inspected.executed === true,
      stale: inspected.stale === true,
      receiptState: inspected.receiptState,
    }
  }

  /**
   * 启动自检（只读）：让 UI/CLI 在重启前看到“重启契约是否健康”。
   * block 级问题意味着“现在不可能安全重启”；warn 表示可重启但会降级（如无 HMAC）。
   */
  const selfCheck = () => {
    const findings = []
    const add = (code, level, detail = '') => findings.push({ code, level, detail })
    try {
      fs.accessSync(stateDir, fs.constants.R_OK | fs.constants.W_OK)
      add('state-dir-writable', 'ok', stateDir)
    } catch (error) {
      add('state-dir-not-writable', 'block', String(error?.message ?? error))
    }
    const stateFile = path.join(stateDir, 'state.json')
    const rawState = readJson(stateFile, null)
    if (rawState !== null && (typeof rawState !== 'object' || Array.isArray(rawState))) {
      add('state-json-invalid', 'warn', stateFile)
    }
    if (!hmac.ok) add('hmac-unavailable', 'warn', String(hmac.reason ?? 'unavailable'))
    else add('hmac-available', 'ok', String(hmac.source ?? 'available'))

    const approvalIds = (() => { try { return listApprovalIds(stateDir) } catch (error) { add('approvals-unreadable', 'warn', String(error?.message ?? error)); return [] } })()
    let armed = 0
    let executed = 0
    let invalid = 0
    for (const id of approvalIds) {
      try {
        const inspected = inspectApproval(stateDir, id, inspectOptions())
        if (!inspected?.ok) invalid += 1
        else if (inspected.state === 'executed') executed += 1
        else if (inspected.state === 'armed') armed += 1
      } catch (error) {
        invalid += 1
        add('approval-inspect-failed', 'warn', `${id}: ${String(error?.message ?? error).slice(0, 160)}`)
      }
    }
    if (invalid > 0) add('approval-manifests-invalid', 'warn', `${invalid}/${approvalIds.length}`)
    add('approvals-summary', 'ok', `total=${approvalIds.length} armed=${armed} executed=${executed} invalid=${invalid}`)

    const marker = (() => { try { return readJson(supervisorMarkerFile, null) } catch { return null } })()
    if (marker && marker.execute === true) {
      const at = Number(marker.at)
      const fresh = Number.isFinite(at) && Date.now() - at <= SUPERVISOR_MARKER_TTL_MS
      const alive = pidAlive(Number(marker.pid))
      add('supervisor-marker', fresh && alive ? 'ok' : 'warn', `pid=${marker.pid ?? 'n/a'} fresh=${fresh} alive=${alive}`)
    } else {
      add('supervisor-marker', 'warn', 'absent')
    }
    const pidDoc = (() => { try { return readJson(pidFile, null) } catch { return null } })()
    if (pidDoc && Number(pidDoc.pid) !== process.pid && pidAlive(Number(pidDoc.pid))) {
      add('pid-file-foreign-live', 'warn', `pid=${pidDoc.pid}`)
    }
    if (lastUncleanBoot) add('unclean-boot', 'warn', `${lastUncleanBoot.state} pid=${lastUncleanBoot.pid ?? 'n/a'}`)
    let crashCount = 0
    try {
      const raw = readTextSafe(crashLedgerFile, '')
      crashCount = raw.split(/\r?\n/).filter((line) => line.trim()).length
    } catch { /* ignore */ }
    if (crashCount > 0) add('runtime-crash-ledger', 'warn', `${crashCount} record(s)`)
    const block = findings.filter((finding) => finding.level === 'block').length
    const warn = findings.filter((finding) => finding.level === 'warn').length
    return {
      ok: block === 0, block, warn, at: Date.now(),
      stateDir, hmac: hmac.ok ? { source: hmac.source } : { unavailable: hmac.reason ?? 'unavailable' },
      approvals: { total: approvalIds.length, armed, executed, invalid },
      findings,
    }
  }

  const service = {
    request, decideOnly, state, impact, policy, executionContract, approvals, executionStatus, verifyApproval, selfCheck,
    runtimeGuard: () => ({
      lastUncleanBoot,
      bootStateFile,
      crashLedgerFile,
      bootState: readJson(bootStateFile, null),
    }),
  }
  ctx.effect(() => ctx.provide(SERVICE.restart, service))

  // 定时器清理：审批兜底计时器必须随插件卸载一起清掉；退出交接触发器一并取消（fail-safe：不退出）。
  ctx.effect(() => () => {
    try { abortActiveApproval?.() } catch { /* dispose must not throw */ }
    abortActiveApproval = null
    for (const t of timers) clearTimeout(t)
    timers.clear()
    machine.state = GUARD_STATE.IDLE
    machine.pending = null
    persistState({ disposed: true })
    clearHostPid()
  })

  return service
}
