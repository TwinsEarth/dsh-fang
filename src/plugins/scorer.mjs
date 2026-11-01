// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang v2 评分子插件 — 静态 A–E 评分 + 环境阈值（契约：docs/CONTRACTS-V2.md 5.4）。
//
// 评分数学与 v1 完全一致（移植自 `dsh-hot-update/packages/score-guard/index.js`）：
//   * D1–D6 维度权重（DIM_WEIGHT）
//   * 信号族 → 维度映射（SIGNAL_DIM），同族信号按 family 去重（dedupeByFamily）
//   * C3 服务宽限：<9 个服务且不含 sessions/registry/loader 时权重归零
//   * 分档 A/B/C/D/E（分档上界由 thresholds 决定；**母体默认 = v1 的 20/40/60/80**）
//   * degraded（入口扫描有 tokenizer warning）时 A、B 一律降 C
//   * `pkg.dsh.hotReload === false` → E veto（S=100，直接否决）
//
// v2 增量：
//   * apply 首行 roleGate('scorer')：scorer 在 mother 与 fork 都激活。
//   * Config.thresholds{mother,fork}：母体 20/40/60/80（= v1），分身更宽 25/45/65/85。
//   * scoreSource/scoreDir/scoreIntent 支持 opts.environment（缺省 = 本实例部署角色 resolveRole），
//     每个返回值都带 basis{environment, thresholds:{a,b,c,d}, note:'本评分基于 <environment> 阈值'}。
//   * 同一份源码在母体/分身阈值下可以落到不同 grade（S 落在两条分档上界之间时），分叉真实存在。
//
// import 层扫描器在 `./imports.mjs`（零依赖手写 tokenizer）。本插件只做 import 层近似：
// 不做调用层（exec/spawn 的实际调用点）分析，这一局限在 coverage='import-only' 与 t6-report.md 中如实声明。
import fs from 'node:fs'
import path from 'node:path'
import { SERVICE, AUDIT, ROLE, z, readJson, roleGate } from '../kernel/index.mjs'
import { scanSource, importsToSignals } from './imports.mjs'

export const name = 'fang-scorer'
export const inject = []

/** 分档上界：A ≤ a，B ≤ b，C ≤ c，D ≤ d，E > d。母体 = v1 原样；分身更宽。 */
export const BAND_DEFAULTS = {
  mother: { a: 20, b: 40, c: 60, d: 80 },
  fork: { a: 25, b: 45, c: 65, d: 85 },
}

/** v1 分值/分档的别名（scoreScan 缺省仍按母体阈值）。 */
export const DEFAULT_THRESHOLDS = BAND_DEFAULTS

const bandSchema = (defaults) => z.object({
  a: z.number().default(defaults.a),
  b: z.number().default(defaults.b),
  c: z.number().default(defaults.c),
  d: z.number().default(defaults.d),
}).default({})

export const Config = z.object({
  allowlist: z.array(z.string()).default([])
    .description('额外允许的依赖名（v1.0.0 只记录在 policy，评分本身不消费；healer 的 G5 会读同一配置）'),
  thresholds: z.object({
    mother: bandSchema(BAND_DEFAULTS.mother)
      .description('母体分档上界（默认 = v1：20/40/60/80）'),
    fork: bandSchema(BAND_DEFAULTS.fork)
      .description('分身分档上界（默认更宽：25/45/65/85）'),
  }).default({}),
})

/** 维度权重（与参考实现完全一致）。 */
export const DIM_WEIGHT = { D1: 28, D2: 22, D3: 18, D4: 14, D5: 10, D6: 8 }

/** 信号族 → 维度（与参考实现完全一致）。 */
export const SIGNAL_DIM = {
  S1: 'D1', S2: 'D1', S3: 'D1', S4: 'D1', S5: 'D1', S7: 'D1',
  S6: 'D5', C2: 'D4', C3: 'D2', C4: 'D2', C5: 'D4',
}

export const ENVIRONMENTS = [ROLE.MOTHER, ROLE.FORK]

/** 信号 id 的族名：'S1-child_process' → 'S1'。 */
export function familyOf(id) {
  return String(id ?? '').split('-')[0]
}

/** 同族只保留第一个信号（族内取最大风险由维度聚合负责）。 */
export function dedupeByFamily(signals) {
  const seen = new Set()
  const out = []
  for (const s of signals ?? []) {
    const f = familyOf(s?.id)
    if (seen.has(f)) continue
    seen.add(f)
    out.push(s)
  }
  return out
}

/** 环境名归一化：只接受 mother/fork，其它回退。 */
export function normalizeEnvironment(value, fallback = ROLE.MOTHER) {
  const v = String(value ?? '').toLowerCase()
  return v === ROLE.MOTHER || v === ROLE.FORK ? v : fallback
}

/** opts（对象 | 字符串 | 空）→ 评分环境。 */
export function environmentOf(opts, fallback = ROLE.MOTHER) {
  if (typeof opts === 'string') return normalizeEnvironment(opts, fallback)
  if (opts && typeof opts === 'object') return normalizeEnvironment(opts.environment, fallback)
  return normalizeEnvironment(undefined, fallback)
}

/** 单个分档表归一化（缺字段回退到 fallback）。 */
export function normalizeBands(input, fallback = BAND_DEFAULTS.mother) {
  const base = fallback && typeof fallback === 'object' ? fallback : BAND_DEFAULTS.mother
  const src = input && typeof input === 'object' ? input : {}
  const num = (k) => (typeof src[k] === 'number' && Number.isFinite(src[k]) ? src[k] : base[k])
  return { a: num('a'), b: num('b'), c: num('c'), d: num('d') }
}

/** 完整 {mother,fork} 阈值配置归一化。 */
export function normalizeThresholds(input) {
  const src = input && typeof input === 'object' ? input : {}
  return {
    mother: normalizeBands(src.mother, BAND_DEFAULTS.mother),
    fork: normalizeBands(src.fork, BAND_DEFAULTS.fork),
  }
}

export function defaultBands(environment = ROLE.MOTHER) {
  return environment === ROLE.FORK ? { ...BAND_DEFAULTS.fork } : { ...BAND_DEFAULTS.mother }
}

/**
 * 取某环境的分档表。thresholds 既可以是完整的 {mother,fork}，也可以是单张 {a,b,c,d}。
 */
export function resolveBands(environment, thresholds = null) {
  const env = normalizeEnvironment(environment)
  const t = thresholds && typeof thresholds === 'object' ? thresholds : {}
  const flat = ['a', 'b', 'c', 'd'].some(k => typeof t[k] === 'number')
  if (flat) return normalizeBands(t, defaultBands(env))
  return normalizeBands(env === ROLE.FORK ? t.fork : t.mother, defaultBands(env))
}

/** 分值 → 等级（分档上界来自 thresholds）。 */
export function gradeOf(S, bands = BAND_DEFAULTS.mother) {
  const b = normalizeBands(bands, BAND_DEFAULTS.mother)
  const s = Number.isFinite(Number(S)) ? Number(S) : 0
  return s <= b.a ? 'A' : s <= b.b ? 'B' : s <= b.c ? 'C' : s <= b.d ? 'D' : 'E'
}

/** 评分依据注解（契约 5.4）。 */
export function basisOf(environment, bands = null) {
  const env = normalizeEnvironment(environment)
  const thresholds = bands === null ? defaultBands(env) : resolveBands(env, bands)
  return { environment: env, thresholds, note: `本评分基于 ${env} 阈值` }
}

/**
 * 纯评分：信号 → {grade, S, veto, degraded, perDim, reasons}。
 * 与参考实现 scoreScan 同构；第三参数是分档表（缺省 = 母体 v1 分档，所以 v1 数值行为不变）。
 */
export function scoreScan(signals, pkg = {}, bands = BAND_DEFAULTS.mother) {
  const thresholds = resolveBands(ROLE.MOTHER, bands)
  if (pkg?.dsh?.hotReload === false) {
    return { grade: 'E', S: 100, veto: true, degraded: false, perDim: {}, reasons: ['hotReload-false'] }
  }

  const reasons = []
  const uniq = dedupeByFamily(signals)
  const perDim = {}

  for (const s of uniq) {
    let weight = Number(s?.weight ?? 0)
    const fam = familyOf(s?.id)

    // C3 服务宽限：少数非核心服务不算危险面，权重归零。
    if (fam === 'C3') {
      const services = Array.isArray(s?.evidence?.services) ? s.evidence.services : []
      const core = services.some(x => ['sessions', 'registry', 'loader'].includes(x))
      weight = (services.length > 8 || core) ? weight : 0
      if (weight <= 0) {
        reasons.push(`${s?.id}:C3-service-grace`)
        continue
      }
    }
    if (!(weight > 0)) continue

    const dim = SIGNAL_DIM[fam] ?? 'D1'
    const sev = Math.min(5, Math.round((weight / 30) * 5))
    if (sev <= 0) continue
    perDim[dim] = Math.max(perDim[dim] ?? 0, sev)
    reasons.push(`${s.id}→${dim}(w=${weight},sev=${sev})`)
  }

  let S = 0
  for (const [dim, sev] of Object.entries(perDim)) S += ((DIM_WEIGHT[dim] ?? 0) * sev) / 5
  S = Math.round(S)

  let grade = gradeOf(S, thresholds)

  const degraded = Number(pkg?.__parseErrors ?? 0) > 0
  if (degraded) {
    reasons.push(`degraded:${pkg.__parseErrors}-parse-warning(s)`)
    // 证据不全时不给 A/B：降 C。
    if (grade === 'A' || grade === 'B') grade = 'C'
  }
  return { grade, S, veto: false, degraded, perDim, reasons }
}

/** 等级 → 动作灯色。B 级已可能含单一危险能力（child_process 单独 28 分 = B），不能判绿。 */
export function gradeToColor(grade) {
  return grade === 'A' ? 'green'
    : grade === 'B' ? 'blue'
    : grade === 'C' ? 'yellow'
    : 'red'
}

/**
 * 入口候选顺序（评分与 healer 共用）：manifest.entry → exports["."] → module → main
 * → index.js → lib/index.js → plugin.js。
 */
export function entryCandidates(pkg, manifest = null) {
  const out = []
  const push = (v) => { if (typeof v === 'string' && v.length > 0) out.push(v) }
  push(manifest?.entry)
  const exp = pkg?.exports
  if (typeof exp === 'string') push(exp)
  else if (exp && typeof exp === 'object') {
    const dot = exp['.']
    if (typeof dot === 'string') push(dot)
    else if (dot && typeof dot === 'object') {
      push(dot.import)
      push(dot.default)
    }
  }
  push(pkg?.module)
  push(pkg?.main)
  push('index.js')
  push('lib/index.js')
  push('plugin.js')
  return out
}

/** 对一段源码评分（纯函数，basis 注解由这里统一生成）。 */
function scoreSourceImpl(source, pkg = {}, opts = {}) {
  const environment = environmentOf(opts, ROLE.MOTHER)
  const bands = resolveBands(environment, opts && typeof opts === 'object' ? opts.thresholds : null)
  const basis = basisOf(environment, bands)
  const text = typeof source === 'string' ? source : ''

  let scan
  try {
    scan = scanSource(text)
  } catch (e) {
    return {
      grade: 'E', S: 100, color: 'red', veto: false, degraded: true,
      signals: [], reasons: [`scan-error:${e?.message ?? e}`],
      coverage: 'none', imports: 0, warnings: 0, error: 'scan-error',
      basis,
    }
  }
  const mapped = importsToSignals(scan, pkg)
  const scored = scoreScan(mapped.signals, { ...(pkg ?? {}), __parseErrors: scan.warnings.length }, bands)
  return {
    grade: scored.grade,
    S: scored.S,
    color: gradeToColor(scored.grade),
    veto: scored.veto,
    degraded: scored.degraded,
    signals: mapped.signals.map(s => ({ id: s.id, weight: s.weight })),
    reasons: scored.reasons,
    // 附加证据（契约允许附加字段，编排器/UI 可直接用）
    perDim: scored.perDim,
    coverage: mapped.coverage,
    imports: scan.imports.length,
    warnings: scan.warnings.length,
    basis,
  }
}

function scoreIntentImpl(intent = {}, opts = {}) {
  const environment = environmentOf(opts, ROLE.MOTHER)
  const bands = resolveBands(environment, opts && typeof opts === 'object' ? opts.thresholds : null)
  const notes = []
  let light
  if (intent.scope === 'system' || intent.scope === 'process') {
    light = 'red'
    notes.push('system-scope')
  } else if (intent.originLight) {
    light = intent.originLight
    notes.push('inherited-originLight')
  } else if (intent.scope === 'session') {
    light = 'yellow'
    notes.push('session-scope')
  } else if (Array.isArray(intent.digests) && intent.digests.length > 0) {
    light = 'blue'
    notes.push('digest-bound')
  } else {
    light = 'yellow'
    notes.push('unbound-digest')
  }
  return { light, notes, basis: basisOf(environment, bands) }
}

function safeGet(ctx, key) {
  try { return ctx?.get?.(key) } catch { return undefined }
}

export function apply(ctx, config) {
  const gate = roleGate('scorer', { cfgRole: config?.role, logger: ctx.logger })
  // v2 部署矩阵：scorer 在 mother 与 fork 都激活；这里只守住“未部署角色不得注册服务”。
  if (!gate.active) return

  const cfg = Config(config ?? {})
  const thresholds = normalizeThresholds(cfg.thresholds)
  // 本实例的部署环境：fork 进程（DSH_FANG_ROLE=fork）里缺省用更宽的分身阈值。
  const environment = gate.role
  const policy = {
    allowlist: Array.isArray(cfg.allowlist) ? cfg.allowlist.map(String) : [],
    environment,
    thresholds,
  }

  const audit = (kind, data) => {
    try { safeGet(ctx, SERVICE.auditor)?.append?.(kind, data) } catch { /* 审计缺失不得影响评分 */ }
  }

  /** opts.environment 优先；缺省用本实例部署环境。 */
  const settingsFor = (opts) => ({ environment: environmentOf(opts, environment), thresholds })

  const service = {
    policy,

    /** 本实例部署环境（mother|fork）。 */
    environment,

    /** 已归一化的 {mother,fork} 阈值（只读副本）。 */
    thresholds: { mother: { ...thresholds.mother }, fork: { ...thresholds.fork } },

    /** 查询某环境的分档表（补充方法）。 */
    thresholdsFor(environmentName) {
      return resolveBands(normalizeEnvironment(environmentName, environment), thresholds)
    },

    scoreSource(source, pkg = {}, opts = {}) {
      return scoreSourceImpl(source, pkg ?? {}, settingsFor(opts))
    },

    scoreDir(dir, manifest = null, opts = {}) {
      const settings = settingsFor(opts)
      const basis = basisOf(settings.environment, resolveBands(settings.environment, settings.thresholds))
      const abs = path.resolve(String(dir ?? ''))
      const pkg = readJson(path.join(abs, 'package.json'), null) ?? {}
      let src = null
      let entry = null
      for (const candidate of entryCandidates(pkg, manifest)) {
        const file = path.join(abs, candidate)
        try {
          const st = fs.statSync(file)
          if (!st.isFile()) continue
          src = fs.readFileSync(file, 'utf8')
          entry = candidate
          break
        } catch { /* 试下一个候选 */ }
      }
      if (src === null) {
        const missing = {
          grade: 'E', S: 100, color: 'red', veto: false, degraded: true,
          signals: [], reasons: ['no-entry-file'], perDim: {},
          coverage: 'none', imports: 0, warnings: 0, error: 'no-entry-file',
          dir: abs, entry: null, basis,
        }
        audit(AUDIT.SCORE, { component: name, dir: abs, grade: 'E', error: 'no-entry-file', environment: settings.environment })
        return missing
      }
      const scored = scoreSourceImpl(src, pkg, settings)
      const result = { ...scored, dir: abs, entry }
      audit(AUDIT.SCORE, {
        component: name,
        dir: abs,
        entry,
        grade: result.grade,
        S: result.S,
        veto: result.veto,
        degraded: result.degraded,
        environment: result.basis.environment,
        signals: result.signals.map(s => s.id),
      })
      return result
    },

    scoreIntent(intent = {}, opts = {}) {
      const settings = settingsFor(opts)
      const out = scoreIntentImpl(intent ?? {}, settings)
      audit(AUDIT.SCORE, {
        component: name,
        intent: out.light,
        scope: intent?.scope ?? null,
        environment: out.basis.environment,
      })
      return out
    },
  }

  ctx.effect(() => ctx.provide(SERVICE.scorer, service))
}

/** 供测试/其他插件直接使用的纯函数与常量（服务方法之外）。 */
export const _internals = {
  scoreScan,
  dedupeByFamily,
  gradeToColor,
  gradeOf,
  familyOf,
  entryCandidates,
  scoreSourceImpl,
  scoreIntentImpl,
  normalizeBands,
  normalizeThresholds,
  resolveBands,
  basisOf,
  environmentOf,
  normalizeEnvironment,
  BAND_DEFAULTS,
}
