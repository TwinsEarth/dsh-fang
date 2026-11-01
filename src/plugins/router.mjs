// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang v2 Router — 母体初判（decide）+ 分身复核（confirm）+ 容器兜底执行入口（runInContainer）。
//
// 决策来源（v1 契约 5.6 保留，v2 契约 5.3 增量）：
//   1. assessment.veto === true（dsh.hotReload === false 的 E 级否决）→ deny（终局，不可被复核推翻）
//   2. 不可信来源：
//        - 需要子进程（needsChildProcess）→ deny（容器内没有真实进程执行体）
//        - 容器可用 → container
//        - 容器不可用 → deny + 原因（fail-closed）
//   3. 可信来源：
//        - 有裸写残留（未申报/申报无效的写）→ container（容器可用）；否则 deny + 原因
//        - 已申报写 或 无写 → sandbox（真实开发环境，不升红）
//   * 评分本身只作 advisory 透传（veto 除外）：A 级不可信 ⚠ 仍然进容器，E 级可信仍然 sandbox。
//
// v2 增量：
//   * apply 首行 roleGate('router')：router 在 mother 与 fork 都激活，但 basis.role / basis.environment 如实标注。
//   * decide() = 母体初判：静态 quickScan（从 assessment.signals 取能力证据；调用方也可以直接给 code 现场扫）
//     + 来源可信度 + 能力需求 → RouteDecision（basis 带 role/environment/grade/source）。
//   * confirm() = 分身复核：用分身的 assessment 与分身的容器可用性重算一次建议，再与母体 decision 取
//     max(rank)；rank = sandbox(1) < container(2) < deny(3)，**只升不降**；母体 deny 原样返回（不可推翻）。
//     分身评分是**单向升级**信号：fork grade E → deny；fork grade D 或比母体 basis.grade 更差 → 至少 container。
//     复核只能把路由抬高，任何输入都不会把 container 降回 sandbox。
//   * containerAvailable() 返回 {ok, state:'disabled'|'unavailable'|'ready', reason}（v1 只有 {ok,reason}）。
//     Config.container.enabled 默认 false → state='disabled'；显式断言 containerAvailable=true 时 state='ready'/reason='configured'。
//   * runInContainer() 懒加载 `../lib/container/index.mjs`（T8 提供）。模块不存在 / enabled=false / 宿主不可用
//     一律返回 {ok:false, state, reason, stdout:'', stderr:'', exitCode:null, writes:[]} 且**绝不抛出**。
//
// 降级点（如实声明，见 docs/t6-report.md）：
//   * containerAvailable() 是同步方法（契约签名），ESM 懒加载只能是异步的：探测结果缓存在 probeCache，
//     apply 时异步预热（container.enabled=true 才预热），真正执行/探针走 async probeContainer()。
//     在预热完成前，enabled 的实例返回 state='unavailable', reason='not-probed'（fail-closed，不假装 ready）。
//   * v1 的 Config.containerAvailable=true 是“操作者断言”，保留为路由可用（state='ready'），但真正
//     runInContainer 仍要求 ../lib/container 模块存在，否则如实返回 unavailable。
import { AUDIT, CONTAINER, ROLE, ROUTE, SERVICE, z, roleGate } from '../kernel/index.mjs'
import { scanSource, importsToSignals } from './imports.mjs'

export const name = 'fang-router'
export const inject = []

/** 路由秩：只允许 confirm 往上抬。 */
const RANK = { [ROUTE.SANDBOX]: 1, [ROUTE.CONTAINER]: 2, [ROUTE.DENY]: 3 }
const GRADE_RANK = { A: 1, B: 2, C: 3, D: 4, E: 5 }
const CONTAINER_STATES = new Set([CONTAINER.DISABLED, CONTAINER.UNAVAILABLE, CONTAINER.READY])

export const Config = z.object({
  containerAvailable: z.boolean().default(false)
    .description('操作者断言容器执行体可用（v1 兼容；state=ready/reason=configured）'),
  trustedPlugins: z.array(z.string()).default([])
    .description('受信插件名单（名字或包名；命中即视为可信来源）'),
  container: z.object({
    enabled: z.boolean().default(false)
      .description('P5 容器分支：true 才懒加载 ../lib/container/index.mjs 并探测 AppContainer 执行体'),
    powershellPath: z.string().default('powershell.exe'),
    timeoutMs: z.number().default(30000),
  }).default({}),
})

const TRUSTED_TOKENS = new Set(['trusted', 'first-party', 'local', 'official', 'mother'])
const UNTRUSTED_TOKENS = new Set(['untrusted', 'third-party', 'external'])

/** 角色/环境名归一化。 */
export function normalizeEnvironment(value, fallback = ROLE.MOTHER) {
  const v = String(value ?? '').toLowerCase()
  return v === ROLE.MOTHER || v === ROLE.FORK ? v : fallback
}

/** 来源描述归一化：字符串 | 对象 → {trusted, declaredWrites, bareWrites, name, via}。 */
export function normalizeSource(source, trustedPlugins = []) {
  const list = Array.isArray(trustedPlugins) ? trustedPlugins.map(String) : []

  if (typeof source === 'string') {
    const raw = source.trim()
    const low = raw.toLowerCase()
    const listed = list.some(n => n === raw || n.toLowerCase() === low)
    if (listed) return { name: raw, trusted: true, declaredWrites: false, bareWrites: false, via: 'trustedPlugins' }
    if (TRUSTED_TOKENS.has(low)) return { name: raw, trusted: true, declaredWrites: false, bareWrites: false, via: 'trust-token' }
    return { name: raw, trusted: false, declaredWrites: false, bareWrites: false, via: UNTRUSTED_TOKENS.has(low) ? 'untrusted-token' : 'unlisted-untrusted' }
  }

  if (!source || typeof source !== 'object') {
    return { name: null, trusted: false, declaredWrites: false, bareWrites: false, via: 'missing-untrusted' }
  }

  const rawName = source.name ?? source.plugin ?? source.id
  const name = typeof rawName === 'string' && rawName.trim() !== '' ? rawName : null
  const token = String(source.trust ?? source.trustLevel ?? source.origin ?? source.kind ?? '').toLowerCase()
  const trusted = source.trusted === true
    || TRUSTED_TOKENS.has(token)
    || (name !== null && list.includes(name))
    || (typeof source.id === 'string' && list.includes(source.id))
  const via = source.trusted === true
    ? (typeof source.via === 'string' && source.via !== '' ? source.via : 'explicit')
    : TRUSTED_TOKENS.has(token) ? 'trust-token'
      : (name !== null && list.includes(name)) ? 'trustedPlugins'
        : 'untrusted'

  // 申报制（见《申报制落地-未申报不许装载.md》）：path + 非空 reason 才算申报。
  const declaredRaw = source.declaredWrites ?? source.writesDeclared ?? source.declared
  let declaredWrites = false
  let invalidDeclaration = false
  if (Array.isArray(declaredRaw)) {
    declaredWrites = declaredRaw.some(d => d && typeof d.path === 'string' && String(d.reason ?? '').trim() !== '')
    invalidDeclaration = declaredRaw.length > 0 && !declaredWrites
  } else {
    declaredWrites = declaredRaw === true
  }

  const bareRaw = source.bareWrites ?? source.bareWrite ?? source.hasBareWrites ?? source.undeclaredWrites
  let bareWrites
  if (Array.isArray(bareRaw)) bareWrites = bareRaw.length > 0
  else if (typeof bareRaw === 'number') bareWrites = bareRaw > 0
  else bareWrites = bareRaw === true
  // 申报无效（有写但 reason 全空）视为未申报残留 → 走容器（fail-closed）。
  if (invalidDeclaration) bareWrites = true

  return { name, trusted, declaredWrites, bareWrites, via }
}

/**
 * decide() 的来源视图：`source` 是可信度权威（字符串/对象），`plugin` 只补充身份与申报/能力证据。
 * 两者都给时 source 决定 trusted，plugin 补充 name/declaredWrites/bareWrites。
 */
export function mergeSourceInput(plugin, source, trustedPlugins = []) {
  const hasExplicit = source !== undefined && source !== null
  const explicit = hasExplicit ? normalizeSource(source, trustedPlugins) : null
  const fromPlugin = plugin !== undefined && plugin !== null
    ? normalizeSource(plugin, trustedPlugins)
    : null
  if (explicit && fromPlugin) {
    return {
      // plugin 是身份（name），source 是可信度权威（trusted/via）；申报/裸写证据取并集。
      name: fromPlugin.name ?? explicit.name,
      trusted: explicit.trusted,
      via: explicit.via,
      declaredWrites: explicit.declaredWrites || fromPlugin.declaredWrites,
      bareWrites: explicit.bareWrites || fromPlugin.bareWrites,
    }
  }
  return explicit ?? fromPlugin ?? normalizeSource(null, trustedPlugins)
}

/** 容器可用性归一化：单次输入 > 探针。 */
export function resolveContainer(input = {}, probe) {
  const explicit = input?.containerAvailable
  if (typeof explicit === 'boolean') {
    return { ok: explicit, reason: explicit ? 'caller-asserted' : 'caller-denied' }
  }
  if (explicit && typeof explicit === 'object' && typeof explicit.ok === 'boolean') {
    const out = { ok: explicit.ok, reason: explicit.reason ?? (explicit.ok ? 'caller-asserted' : 'caller-denied') }
    if (CONTAINER_STATES.has(explicit.state)) out.state = explicit.state
    return out
  }
  const probed = typeof probe === 'function' ? probe() : { ok: false, state: CONTAINER.UNAVAILABLE, reason: 'no-probe' }
  return probed && typeof probed === 'object' ? probed : { ok: false, state: CONTAINER.UNAVAILABLE, reason: 'no-probe' }
}

/** assessment.signals 里的 S1 族 → 需要子进程执行体。 */
function assessmentNeedsChild(assessment) {
  const signals = Array.isArray(assessment?.signals) ? assessment.signals : []
  return signals.some(s => String(s?.id ?? '').split('-')[0] === 'S1')
}

/**
 * 静态 quickScan（母体初判的“静态部分”，可独立测试）：
 *   * capabilities 来自 assessment.signals 的 S1–S4 族，以及 plugin.capabilities/plugin.needs 的申报；
 *   * 调用方给了 code（源码文本）时现场跑 import 层扫描器，不依赖 scorer 已评分。
 * 不做调用层分析（与 scorer 的 import-only 局限一致）。
 */
export function quickScan({ plugin = null, assessment = null, source = null, code = null } = {}) {
  const signals = []
  const warnings = []
  let scanned = false

  if (typeof code === 'string' && code.trim() !== '') {
    try {
      const scan = scanSource(code)
      const mapped = importsToSignals(scan, {})
      signals.push(...mapped.signals)
      warnings.push(...scan.warnings.map(w => w.reason ?? 'warning'))
      scanned = true
    } catch (e) {
      warnings.push(`scan-error:${e?.message ?? e}`)
    }
  }
  const assessmentSignals = Array.isArray(assessment?.signals) ? assessment.signals : []
  if (assessmentSignals.length > 0) {
    signals.push(...assessmentSignals)
    scanned = true
  }
  const declared = [
    ...(Array.isArray(plugin?.capabilities) ? plugin.capabilities : []),
    ...(Array.isArray(plugin?.needs) ? plugin.needs : []),
    ...(Array.isArray(source?.capabilities) ? source.capabilities : []),
  ].map(v => String(v ?? '').toLowerCase())

  const caps = new Set()
  for (const sig of signals) {
    const fam = String(sig?.id ?? '').split('-')[0]
    if (fam === 'S1') caps.add('child-process')
    else if (fam === 'S2') caps.add('network')
    else if (fam === 'S3') caps.add('fs')
    else if (fam === 'S4') caps.add('vm')
  }
  const declaresChild = declared.some(c => c === 'child-process' || c === 'childprocess' || c === 'child_process')
    || plugin?.needsChildProcess === true
  if (declaresChild) caps.add('child-process')

  return {
    grade: typeof assessment?.grade === 'string' ? assessment.grade : null,
    veto: assessment?.veto === true,
    signals: signals.length,
    capabilities: [...caps].sort(),
    needsChildProcess: caps.has('child-process'),
    coverage: scanned ? 'import-only' : 'none',
    warnings,
  }
}

/**
 * 纯决策函数（decide/confirm 的数学部分，可独立测试）。
 * @returns {{route:'sandbox'|'container'|'deny', reason:string, needsApproval:boolean,
 *   grade:string|null, veto:boolean, source:object, container:object, basis:object}}
 */
export function decidePure(input = {}, { config = {}, probe, role = ROLE.MOTHER, environment = null } = {}) {
  const safeInput = input && typeof input === 'object' ? input : {}
  const assessment = safeInput.assessment && typeof safeInput.assessment === 'object' ? safeInput.assessment : null
  const src = normalizeSource(safeInput.source, config?.trustedPlugins ?? [])
  const needsChild = safeInput.needsChildProcess === true || assessmentNeedsChild(assessment)
  const container = resolveContainer(safeInput, probe)
  const veto = assessment?.veto === true
  const roleName = normalizeEnvironment(role)
  const envName = normalizeEnvironment(environment ?? roleName)
  const grade = typeof assessment?.grade === 'string' ? assessment.grade : null

  const sourceSummary = {
    trusted: src.trusted,
    name: src.name,
    declaredWrites: src.declaredWrites,
    bareWrites: src.bareWrites,
    via: src.via,
    needsChildProcess: needsChild,
  }
  const containerView = {
    ok: container?.ok === true,
    reason: String(container?.reason ?? (container?.ok === true ? 'ok' : 'unavailable')),
  }
  if (CONTAINER_STATES.has(container?.state)) containerView.state = container.state

  const base = {
    grade,
    veto,
    source: sourceSummary,
    container: containerView,
    basis: { role: roleName, environment: envName, grade, source: sourceSummary },
  }

  // 1) 静态硬否决：dsh.hotReload === false。终局，任何路线都不放行。
  if (veto) {
    const why = Array.isArray(assessment?.reasons) && assessment.reasons.length > 0 ? assessment.reasons.join(',') : 'hotReload-false'
    return { route: ROUTE.DENY, reason: `veto:${why}`, needsApproval: false, ...base }
  }

  // 2) 不可信来源
  if (!src.trusted) {
    if (needsChild) {
      return { route: ROUTE.DENY, reason: 'untrusted-needs-child-process', needsApproval: false, ...base }
    }
    if (containerView.ok) {
      return { route: ROUTE.CONTAINER, reason: 'untrusted-source', needsApproval: true, ...base }
    }
    return { route: ROUTE.DENY, reason: `container-unavailable:${containerView.reason}`, needsApproval: false, ...base }
  }

  // 3) 可信来源
  if (src.bareWrites) {
    if (containerView.ok) {
      return { route: ROUTE.CONTAINER, reason: 'trusted-bare-writes', needsApproval: true, ...base }
    }
    return { route: ROUTE.DENY, reason: `container-unavailable:${containerView.reason}`, needsApproval: false, ...base }
  }
  return {
    route: ROUTE.SANDBOX,
    reason: src.declaredWrites ? 'trusted-declared-writes' : 'trusted-clean',
    needsApproval: false,
    ...base,
  }
}

/** confirm 的证据来源：母体 decision 里透传的来源视图（v2 basis.source，v1 退化到 decision.source）。 */
export function evidenceFrom(decision) {
  const summary = decision?.basis?.source ?? decision?.source ?? null
  if (!summary || typeof summary !== 'object') return null
  const name = typeof summary.name === 'string' && summary.name.trim() !== '' ? summary.name : null
  return {
    name,
    trusted: summary.trusted === true,
    declaredWrites: summary.declaredWrites === true,
    bareWrites: summary.bareWrites === true,
    needsChildProcess: summary.needsChildProcess === true,
  }
}

/** 容器错误归类（永不抛）。 */
function classifyContainerError(err) {
  const code = String(err?.code ?? '')
  const message = String(err?.message ?? err ?? '')
  if (code === 'CONTAINER_MODULE_INVALID') return { state: CONTAINER.UNAVAILABLE, reason: 'container-module-invalid' }
  if (code === 'ERR_MODULE_NOT_FOUND' || /cannot find (module|package)/i.test(message)) {
    return { state: CONTAINER.UNAVAILABLE, reason: 'container-module-missing' }
  }
  return { state: CONTAINER.UNAVAILABLE, reason: `container-module-load-failed:${message}` }
}

function stateOf(avail, host = null) {
  const raw = avail?.state ?? host?.state
  if (CONTAINER_STATES.has(raw)) return raw
  return avail?.ok === true ? CONTAINER.READY : CONTAINER.UNAVAILABLE
}

function readAvailable(host) {
  try {
    const avail = typeof host?.available === 'function' ? host.available() : null
    if (avail && typeof avail === 'object') return avail
    return { ok: host?.state === CONTAINER.READY, state: host?.state, reason: host?.state ?? 'no-probe' }
  } catch (e) {
    return { ok: false, state: CONTAINER.UNAVAILABLE, reason: `container-probe-failed:${e?.message ?? e}` }
  }
}

// ─────────────────────── 容器模块懒加载（进程级缓存的只有“模块”本身） ───────────────────────
let containerModuleLoader = () => import('../lib/container/index.mjs')
let containerModulePromise = null

async function loadContainerModule() {
  if (!containerModulePromise) {
    containerModulePromise = Promise.resolve()
      .then(() => containerModuleLoader())
      .catch((e) => {
        containerModulePromise = null // 下次重试（T8 模块可能在运行时才落地）
        throw e
      })
  }
  return containerModulePromise
}

// ─────────────────────────────── plugin ───────────────────────────────

export function apply(ctx, config) {
  const gate = roleGate('router', { cfgRole: config?.role, logger: ctx.logger })
  // v2 部署矩阵：router 在 mother/fork 都激活；这里的 return 只是守住“未部署角色不得注册服务”的契约。
  if (!gate.active) return

  const cfg = Config(config ?? {})
  const normalized = {
    containerAvailable: cfg.containerAvailable === true,
    trustedPlugins: Array.isArray(cfg.trustedPlugins) ? cfg.trustedPlugins.map(String) : [],
    container: {
      enabled: cfg.container?.enabled === true,
      powershellPath: typeof cfg.container?.powershellPath === 'string' ? cfg.container.powershellPath : 'powershell.exe',
      timeoutMs: Number(cfg.container?.timeoutMs ?? 30000),
    },
  }
  const role = gate.role

  const safeGet = (key) => {
    try { return ctx?.get?.(key) } catch { return undefined }
  }
  const audit = (data) => {
    try { safeGet(SERVICE.auditor)?.append?.(AUDIT.ROUTE, { component: name, ...data }) } catch { /* 审计缺失不得影响路由 */ }
  }

  // ── 容器执行体：懒加载 + 可用性缓存（同步 API 只能读缓存，异步探测在 probeContainer/runInContainer 里刷新）──
  let containerHost = null
  let containerHostPromise = null
  let disposed = false
  let probeCache = { ok: false, state: CONTAINER.UNAVAILABLE, reason: 'not-probed' }

  async function createHostOnce() {
    const mod = await loadContainerModule()
    if (typeof mod?.createContainerHost !== 'function') {
      const err = new Error('container module does not export createContainerHost')
      err.code = 'CONTAINER_MODULE_INVALID'
      throw err
    }
    if (disposed) {
      const err = new Error('router disposed')
      err.code = 'ROUTER_DISPOSED'
      throw err
    }
    containerHost = mod.createContainerHost({
      powershellPath: normalized.container.powershellPath,
      timeoutMs: normalized.container.timeoutMs,
    })
    return containerHost
  }

  async function ensureContainerHost() {
    if (containerHost) return containerHost
    if (!containerHostPromise) {
      containerHostPromise = createHostOnce().catch((e) => {
        containerHostPromise = null // 失败后允许下一次重试
        throw e
      })
    }
    return containerHostPromise
  }

  function disposeContainerHost() {
    disposed = true
    containerHostPromise = null
    try { containerHost?.dispose?.() } catch { /* 容器宿主清理失败不得影响卸载 */ }
    containerHost = null
  }

  /** 同步可用性（契约 5.3）：disabled / unavailable / ready。 */
  function containerAvailable() {
    if (normalized.containerAvailable) {
      return { ok: true, state: CONTAINER.READY, reason: 'configured' }
    }
    if (!normalized.container.enabled) {
      return { ok: false, state: CONTAINER.DISABLED, reason: 'container-disabled' }
    }
    if (probeCache.ok && probeCache.state === CONTAINER.READY) {
      return { ok: true, state: CONTAINER.READY, reason: probeCache.reason }
    }
    return {
      ok: false,
      state: probeCache.state === CONTAINER.DISABLED ? CONTAINER.DISABLED : CONTAINER.UNAVAILABLE,
      reason: probeCache.reason ?? 'not-probed',
    }
  }

  /** 异步刷新容器可用性（apply 预热 / probeContainer / runInContainer 共用）。永不抛出。 */
  async function refreshContainer() {
    if (normalized.containerAvailable) {
      probeCache = { ok: true, state: CONTAINER.READY, reason: 'configured' }
      return containerAvailable()
    }
    if (!normalized.container.enabled) {
      probeCache = { ok: false, state: CONTAINER.DISABLED, reason: 'container-disabled' }
      return containerAvailable()
    }
    try {
      const host = await ensureContainerHost()
      const avail = readAvailable(host)
      const state = stateOf(avail, host)
      probeCache = {
        ok: avail?.ok === true && state === CONTAINER.READY,
        state,
        reason: String(avail?.reason ?? (state === CONTAINER.READY ? 'ready' : 'unavailable')),
      }
    } catch (e) {
      probeCache = { ok: false, ...classifyContainerError(e) }
    }
    return containerAvailable()
  }

  /** 容器内执行（契约 5.3）：{ok, stdout, stderr, exitCode, writes}，任何失败路径都不抛出。 */
  async function runInContainer(input = {}) {
    const req = input && typeof input === 'object' ? input : {}
    const code = typeof req.code === 'string' ? req.code : ''
    const env = req.env && typeof req.env === 'object' ? req.env : {}
    const declaredWrites = Array.isArray(req.declaredWrites) ? req.declaredWrites : []
    const empty = { stdout: '', stderr: '', exitCode: null, writes: [] }

    const enabled = normalized.container.enabled || normalized.containerAvailable
    if (!enabled) return { ok: false, state: CONTAINER.DISABLED, reason: 'container-disabled', ...empty }
    if (code.trim() === '') {
      return { ok: false, state: containerAvailable().state, reason: 'code-required', ...empty }
    }

    // 先确保宿主存在（懒加载；模块缺失在这里被归类，不抛）。
    try {
      await ensureContainerHost()
    } catch (e) {
      const classified = classifyContainerError(e)
      probeCache = { ok: false, ...classified }
      return { ok: false, ...classified, ...empty }
    }

    let avail = readAvailable(containerHost)
    let state = stateOf(avail, containerHost)
    if (!(avail?.ok === true && state === CONTAINER.READY) && normalized.container.enabled) {
      avail = await refreshContainer()
      state = avail.state
    }
    if (!containerHost || !(avail?.ok === true)) {
      const why = String(avail?.reason ?? 'container-unavailable')
      return { ok: false, state: state ?? CONTAINER.UNAVAILABLE, reason: why, ...empty }
    }

    try {
      const out = await containerHost.exec({
        code,
        env,
        declaredWrites,
        timeoutMs: normalized.container.timeoutMs,
      })
      probeCache = { ok: true, state: CONTAINER.READY, reason: probeCache.reason === 'not-probed' ? 'exec-ok' : probeCache.reason }
      return {
        ok: out?.ok === true,
        state: CONTAINER.READY,
        stdout: String(out?.stdout ?? ''),
        stderr: String(out?.stderr ?? ''),
        exitCode: typeof out?.exitCode === 'number' ? out.exitCode : (out?.exitCode ?? null),
        writes: Array.isArray(out?.writes) ? out.writes : [],
        ...(out?.ok === true ? {} : { reason: String(out?.reason ?? out?.error ?? 'exec-failed') }),
      }
    } catch (e) {
      return {
        ok: false,
        state: containerAvailable().state,
        reason: `container-exec-error:${e?.message ?? e}`,
        ...empty,
      }
    }
  }

  // ── 母体初判 ──────────────────────────────────────────────────────────
  function decide(input = {}) {
    const raw = input && typeof input === 'object' ? input : {}
    const qs = quickScan({ plugin: raw.plugin, assessment: raw.assessment, source: raw.source, code: raw.code })
    const sourceView = mergeSourceInput(raw.plugin, raw.source, normalized.trustedPlugins)
    const out = decidePure(
      { ...raw, source: sourceView, needsChildProcess: raw.needsChildProcess === true || qs.needsChildProcess },
      { config: normalized, probe: containerAvailable, role, environment: normalizeEnvironment(raw.environment, role) },
    )
    out.quickScan = qs
    audit({
      phase: 'decide',
      route: out.route,
      reason: out.reason,
      needsApproval: out.needsApproval,
      grade: out.grade,
      role,
      environment: out.basis.environment,
      sourceTrusted: out.source.trusted,
      sourceName: out.source.name,
      capabilities: qs.capabilities,
      container: out.container,
    })
    return out
  }

  // ── 分身复核 ──────────────────────────────────────────────────────────
  function confirm(input = {}) {
    const raw = input && typeof input === 'object' ? input : {}
    const decision = raw.decision && typeof raw.decision === 'object' ? raw.decision : null
    const environment = normalizeEnvironment(raw.environment, role)

    if (!decision || !RANK[decision.route]) {
      const out = {
        route: ROUTE.DENY,
        reason: `confirm:${decision ? 'invalid-decision-route' : 'missing-decision'}`,
        needsApproval: false,
        escalated: false,
        grade: null,
        basis: { role, environment, grade: null, source: null, escalated: false },
      }
      audit({ phase: 'confirm', route: out.route, reason: out.reason, escalated: false, role, environment })
      return out
    }

    // 母体 deny 是终局：原样返回 route/reason/needsApproval，只补复核环境的 basis 与 escalated:false。
    if (decision.route === ROUTE.DENY) {
      const out = {
        ...decision,
        escalated: false,
        basis: {
          ...(decision.basis ?? {}),
          role,
          environment,
          grade: decision.basis?.grade ?? decision.grade ?? null,
          escalated: false,
        },
      }
      audit({ phase: 'confirm', route: out.route, reason: out.reason, escalated: false, role, environment, from: decision.route })
      return out
    }

    const evidence = evidenceFrom(decision) ?? mergeSourceInput(raw.plugin, raw.source, normalized.trustedPlugins)
    const qs = quickScan({ plugin: raw.plugin, assessment: raw.assessment, source: evidence, code: raw.code })
    const forkAdvice = decidePure(
      {
        assessment: raw.assessment ?? null,
        source: evidence,
        needsChildProcess: evidence?.needsChildProcess === true || qs.needsChildProcess,
      },
      { config: normalized, probe: containerAvailable, role, environment },
    )

    // max(母体 decision, 分身建议)：只升不降。
    let route = decision.route
    const upgrades = []
    if ((RANK[forkAdvice.route] ?? 0) > (RANK[route] ?? 0)) {
      route = forkAdvice.route
      upgrades.push(forkAdvice.reason)
    }

    // 评分第二意见只做单向升级：E → deny；D 或“比母体更差” → 至少 container。
    const forkGrade = typeof raw.assessment?.grade === 'string' ? raw.assessment.grade : (forkAdvice.grade ?? null)
    const motherGrade = decision.basis?.grade ?? decision.grade ?? null
    if (route !== ROUTE.DENY && forkGrade === 'E') {
      route = ROUTE.DENY
      upgrades.push('fork-grade-E')
    } else if (route === ROUTE.SANDBOX && forkGrade) {
      const worseThanMother = motherGrade !== null
        && typeof GRADE_RANK[forkGrade] === 'number'
        && GRADE_RANK[forkGrade] > (GRADE_RANK[motherGrade] ?? 0)
      if (forkGrade === 'D' || worseThanMother) {
        route = ROUTE.CONTAINER
        upgrades.push(`fork-grade-worse:${motherGrade ?? 'unknown'}->${forkGrade}`)
      }
    }

    const escalated = route !== decision.route
    let needsApproval
    if (route === ROUTE.CONTAINER) needsApproval = true
    else if (route === ROUTE.DENY) needsApproval = false
    else needsApproval = decision.needsApproval === true
    if (escalated && route === ROUTE.DENY) needsApproval = false

    const grade = forkGrade ?? decision.basis?.grade ?? decision.grade ?? null
    const basis = {
      role,
      environment,
      grade,
      source: forkAdvice.basis?.source ?? decision.basis?.source ?? null,
      escalated,
      ...(decision.basis?.role ? { decidedBy: decision.basis.role } : {}),
    }
    const out = {
      route,
      reason: escalated ? `escalated:${decision.route}->${route}:${upgrades.join('|') || forkAdvice.reason}` : decision.reason,
      needsApproval,
      escalated,
      grade,
      veto: decision.veto === true || forkAdvice.veto === true,
      source: basis.source,
      container: forkAdvice.container,
      basis,
    }
    audit({
      phase: 'confirm',
      route: out.route,
      reason: out.reason,
      escalated,
      from: decision.route,
      role,
      environment,
      grade,
      container: out.container,
    })
    return out
  }

  const service = {
    role,
    policy: {
      role,
      environment: role,
      platform: process.platform,
      containerAvailable: normalized.containerAvailable,
      container: { ...normalized.container },
      trustedPlugins: normalized.trustedPlugins,
    },

    /** 容器执行体可用性（契约 5.3）：{ok, state, reason}。 */
    containerAvailable,

    /** 异步刷新容器可用性（补充方法，供 Orchestrator/Adapter 在需要确定性状态时调用）。 */
    async probeContainer() {
      return refreshContainer()
    },

    /** 母体初判（契约 5.3）：静态 quickScan + 来源可信度 + 能力需求。 */
    decide,

    /** 分身复核（契约 5.3）：只升不降；母体 deny 原样返回。 */
    confirm,

    /** 容器内执行（契约 5.3）：懒加载 T8 容器执行器，缺模块/禁用时降级返回，绝不抛。 */
    runInContainer,
  }

  ctx.effect(() => () => disposeContainerHost())
  // 预热探测：enabled 时才触发；异步失败已内部归类，不会产生未处理拒绝。
  if (normalized.container.enabled) {
    refreshContainer().catch(() => {})
  }
  ctx.effect(() => ctx.provide(SERVICE.router, service))
}

export const _internals = {
  normalizeSource,
  mergeSourceInput,
  resolveContainer,
  decidePure,
  quickScan,
  evidenceFrom,
  normalizeEnvironment,
  RANK,
  GRADE_RANK,
  /** 测试注入容器模块加载器（T8 模块可能尚未落地）；传 null 恢复真实懒加载。 */
  setContainerModuleLoader(fn) {
    containerModuleLoader = typeof fn === 'function' ? fn : () => import('../lib/container/index.mjs')
    containerModulePromise = null
  },
  resetContainerModuleLoader() {
    containerModuleLoader = () => import('../lib/container/index.mjs')
    containerModulePromise = null
  },
}
