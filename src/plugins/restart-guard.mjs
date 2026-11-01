// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// fang-restart-guard — 2.6 红线守卫：**只拦母体重启**
//
// 硬边界（CONTRACTS §1.2 / §1.3）：
//   * 只服务母体重启；分身重启 = forker.reap() + 重新 fork()，不经过本插件。
//   * v1.0.0 只做「决策 + 审计 + 审批」，**不执行**进程退出/重启（allowProcessRestart 默认 false，
//     即便为 true 也不真退：执行阶段仅记录状态后回到 idle，把执行权留给外部 supervisor 契约）。
//   * 单飞状态机 idle → collecting → awaiting → executing → idle；并发请求的第二个直接 busy 拒绝。
//   * 决策矩阵移植自 dsh-hot-update/packages/restart-guard/index.js 的 classifyRisk/findGrant/decide
//     （policy.mode = 授权模式 manual|temp|auto，与 policy() 里的守卫层 mode=observe|enforce 不是同一个字段）。
//   * needs-approval 时通过 ctx.get(SERVICE.approver)?.request(...) 走审批；审批服务缺失或抛错 => fail-closed。
import { AUDIT, EXIT, GUARD_STATE, RISK, SERVICE, bus, newId, riskAtLeast, z } from '../kernel/index.mjs'
import { roleGate } from '../kernel/index.mjs'

export const name = 'fang-restart-guard'
export const inject = []

const DEFAULTS = Object.freeze({
  mode: 'observe',
  authMode: 'manual',
  strictRedLine: true,
  approvalTimeoutMs: 300000,
  allowProcessRestart: false,
  autoPromoteAfterHours: 24,
})

export const Config = z.object({
  mode: z.union(['observe', 'enforce']).default('observe')
    .description('守卫执行层：observe 只决策不执行；enforce 预留给外部 supervisor（v1.0.0 仍不真退出进程）'),
  authMode: z.union(['manual', 'temp', 'auto']).default('manual')
    .description('授权模式：manual 逐次询问 / temp 临时授权 / auto 非红自动放行（决策矩阵的 policy.mode）'),
  strictRedLine: z.boolean().default(true)
    .description('红灯是否必须人工确认'),
  approvalTimeoutMs: z.number().min(1000).max(86400000).default(300000)
    .description('审批等待上限（毫秒）；审批服务本身也会收到 ttlMs'),
  allowProcessRestart: z.boolean().default(false)
    .description('是否允许真正执行进程重启（默认 false；v1.0.0 无论取值都不执行，仅记录）'),
  autoPromoteAfterHours: z.union([6, 12, 24]).default(24)
    .description('保留字段（bundle 配置兼容）：自动晋升归属编排器/晋升流程，本插件不消费'),
})

export const RISK_VALUES = [RISK.BLUE, RISK.YELLOW, RISK.RED]
const RANK = { blue: 1, yellow: 2, red: 3 }
const REQUESTED_TOPIC = 'fang/restart-requested'
const RESOLVED_TOPIC = 'fang/restart-resolved'

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
  const log = (level, msg) => { try { ctx.logger?.[level]?.(`[fang-restart-guard] ${msg}`) } catch { /* 日志不许破状态机 */ } }

  /** 单飞状态机：pending 只描述「正在处理的唯一请求」。 */
  const machine = { state: GUARD_STATE.IDLE, pending: null }
  const timers = new Set()

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

  /** 显式 risk（编排器会传 red）优先；缺省时走 classifyRisk 矩阵。 */
  const normalizeRisk = (input = {}) => (isRisk(input.risk) ? input.risk : classifyRisk(input))

  /** 审批等待的兜底计时器：审批服务永不 resolve 时也要回到 idle，不许把状态机卡死。 */
  const withDeadline = (promise, ms) => new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => finish(resolve, { outcome: 'timeout', by: 'guard-timeout', at: Date.now() }), Math.max(1, Number(ms) || 1))
    if (typeof timer.unref === 'function') timer.unref()
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
    return wasPending
  }

  /** executing 阶段：v1.0.0 只记录状态（不退出/不重启），随后回 idle。 */
  const finishApproved = (req, { decision, by = null, outcome, approvalId = null, t0 }) => {
    machine.state = GUARD_STATE.EXECUTING
    if (machine.pending) machine.pending.phase = GUARD_STATE.EXECUTING
    const execution = {
      executed: false,
      reason: 'v1.0.0-decision-only',
      guardMode: cfg.mode,
      allowProcessRestart: cfg.allowProcessRestart === true,
      plannedExitCode: EXIT.RESTART, // 与 forker.classifyExit 的 restart-request 契约对齐；本插件不真退出
    }
    const result = {
      id: req.id, outcome, decision, risk: req.risk, by, approvalId,
      requestedAt: req.requestedAt, execution, ms: Date.now() - t0,
    }
    audit(AUDIT.RESTART_RESOLVED, {
      id: req.id, outcome, decision, risk: req.risk, reason: req.reason, scope: req.scope,
      origin: req.origin, by, approvalId, execution, guardMode: cfg.mode, ms: result.ms,
    })
    emit(RESOLVED_TOPIC, { id: req.id, outcome })
    release()
    return result
  }

  const finishDenied = (req, reason, outcome, extra = {}) => {
    const result = {
      id: req.id, outcome, decision: 'needs-approval', risk: req.risk,
      reason, by: extra.by ?? null, approvalId: extra.approvalId ?? null, ms: extra.ms ?? 0,
      ...(extra.error ? { error: extra.error } : {}),
    }
    audit(AUDIT.RESTART_RESOLVED, {
      id: req.id, outcome, decision: 'needs-approval', risk: req.risk, reason: req.reason,
      scope: req.scope, origin: req.origin, deniedReason: reason,
      by: result.by, approvalId: result.approvalId, guardMode: cfg.mode,
      ...(extra.error ? { error: extra.error } : {}),
    })
    emit(RESOLVED_TOPIC, { id: req.id, outcome })
    release()
    return result
  }

  /**
   * request({reason, risk, scope, origin, digests?, forcedApproval?, impact?})
   *   -> Promise<{id, outcome:'approved'|'denied'|'timeout'|'auto-allow', decision, risk, ...}>
   * 单飞：非 idle 时第二个请求直接 {outcome:'denied', reason:'busy'}（不排队）。
   */
  const request = async (input = {}) => {
    const t0 = Date.now()
    const risk = normalizeRisk(input)
    const reason = String(input.reason ?? 'unspecified')
    const scope = String(input.scope ?? 'mother')
    const origin = String(input.origin ?? 'unknown')

    if (machine.state !== GUARD_STATE.IDLE) {
      // 准入层拒绝：不占用状态机，但仍留一对审计以证明发生过竞争。
      const busyId = newId('rst')
      audit(AUDIT.RESTART_REQUESTED, {
        id: busyId, risk, reason, scope, origin, phase: 'rejected-busy',
        activeState: machine.state, activeId: machine.pending?.id ?? null,
      })
      audit(AUDIT.RESTART_RESOLVED, { id: busyId, outcome: 'denied', deniedReason: 'busy', risk })
      return { id: busyId, outcome: 'denied', reason: 'busy', decision: 'needs-approval', risk, activeState: machine.state }
    }

    // 单飞认领：在这行之后任何并发 request 都会看到非 idle（async 体在首个 await 前同步执行）。
    machine.state = GUARD_STATE.COLLECTING
    const req = {
      id: newId('rst'),
      risk, reason, scope, origin,
      digests: Array.isArray(input.digests) ? input.digests.map(String) : [],
      forcedApproval: input.forcedApproval === true,
      requestedAt: t0,
      deadlineAt: t0 + cfg.approvalTimeoutMs,
    }
    const impactReport = input.impact ?? impact()
    machine.pending = { id: req.id, risk: req.risk, reason, scope, origin, phase: GUARD_STATE.COLLECTING, since: t0 }

    audit(AUDIT.RESTART_REQUESTED, {
      id: req.id, risk: req.risk, reason, scope, origin, digests: req.digests,
      forcedApproval: req.forcedApproval, guardMode: cfg.mode, authMode: cfg.authMode,
      strictRedLine: cfg.strictRedLine, impact: impactReport,
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
    const approver = safeGet(ctx, SERVICE.approver)
    if (!approver || typeof approver.request !== 'function') {
      return finishDenied(req, 'approver-unavailable', 'denied', { ms: Date.now() - t0 })
    }

    let answer
    try {
      answer = await withDeadline(approver.request({
        kind: 'restart',
        risk: req.risk,
        title: `母体重启：${reason}`,
        detail: `origin=${origin} scope=${scope} risk=${req.risk} guardMode=${cfg.mode}`,
        impact: impactReport,
        ttlMs: cfg.approvalTimeoutMs,
      }), cfg.approvalTimeoutMs)
    } catch (e) {
      return finishDenied(req, 'approver-error', 'denied', { error: errText(e), ms: Date.now() - t0 })
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

  const state = () => ({
    state: machine.state,
    pending: machine.pending ? { ...machine.pending } : null,
    mode: cfg.mode, // 守卫执行层 observe|enforce
    authMode: cfg.authMode, // 决策矩阵授权模式 manual|temp|auto
    strictRedLine: cfg.strictRedLine,
    allowProcessRestart: cfg.allowProcessRestart === true,
    restartExitCode: EXIT.RESTART,
  })

  const policy = () => ({
    mode: cfg.mode, // observe|enforce（守卫执行层，不是决策矩阵的授权模式）
    authMode: cfg.authMode, // manual|temp|auto
    strictRedLine: cfg.strictRedLine,
    approvalTimeoutMs: cfg.approvalTimeoutMs,
    allowProcessRestart: cfg.allowProcessRestart === true,
    restartExitCode: EXIT.RESTART,
  })

  const service = { request, decideOnly, state, impact, policy }
  ctx.effect(() => ctx.provide(SERVICE.restart, service))

  // 定时器清理：审批兜底计时器必须随插件卸载一起清掉。
  ctx.effect(() => () => {
    for (const t of timers) clearTimeout(t)
    timers.clear()
    machine.state = GUARD_STATE.IDLE
    machine.pending = null
  })

  return service
}
