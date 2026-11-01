// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang v2.7.6 fang-umbrella — 「保护伞」：一个证据管道，两个评分出口。
//
//   ├─ 插件评分：A/B/C/D/E（交给 fang-scorer 的 import 层扫描，按入口 mtime 缓存）
//   └─ 动作评分：green/blue/yellow/red（每次动作重算）+ 等级下限抬高
//
// 这个插件自己**不扫源码**：静态证据的唯一来源是 `SERVICE.scorer`，缺它就失败往坏里判
// （E + degraded），绝不假装安全。纯逻辑在 `src/lib/umbrella.mjs`，契约见 docs/UMBRELLA.md。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AUDIT, SERVICE, roleGate, z } from '../kernel/index.mjs'
import {
  DEFAULT_ACTION_RULES,
  DEFAULT_FLOOR_TABLE,
  DECISION,
  GRADE_FLOOR,
  GRADE_FLOOR_STRICT,
  LIGHT,
  SEVERITY,
  createUmbrella,
  normalizeGrade,
  normalizeLight,
} from '../lib/umbrella.mjs'
import {
  createRuleRegistry,
  isLockedRule,
  loadRuleConfigFile,
  watchRuleConfigFile,
} from '../lib/rule-registry.mjs'

export const name = 'fang-umbrella'
export const inject = []

export const Config = z.object({
  bufferRoot: z.string().default('')
    .description('沙箱缓冲区根目录（空 = 取 buffer-keeper 的实时 dir）'),
  productionRoot: z.string().default('')
    .description('生产区根目录；越界写命中它时单列为 write-production（仍是黄灯）'),
  allowPaths: z.array(z.string()).default([])
    .description('允许写入的路径前缀（相对路径按本实例 cwd 解析）'),
  networkAllowlist: z.array(z.string()).default([])
    .description('外连允许列表：host、host:port、*.suffix 或 URL 前缀'),
  credentialPatterns: z.array(z.string()).default([])
    .description('凭据路径正则（空 = 内置默认；传非空数组 = 完全替换）'),
  destructivePatterns: z.array(z.string()).default([])
    .description('破坏性命令正则（空 = 内置默认；传非空数组 = 完全替换）'),
  lifecyclePatterns: z.array(z.string()).default([])
    .description('DSH 生命周期命令正则（空 = 内置默认）'),
  lifecycleTools: z.array(z.string()).default([])
    .description('视为生命周期的工具名（空 = 内置默认）'),
  gradeFloorTable: z.string().default(DEFAULT_FLOOR_TABLE)
    .description('动作灯色下限表：umbrella（默认）| strict（与 GRADE_COLOR 对齐）；未知值回退 umbrella 并标记 degraded'),
  cacheSize: z.natural().default(200)
    .description('插件评分缓存容量（LRU，按入口文件 mtime 失效）'),
  auditDecisions: z.boolean().default(true)
    .description('每次 decideAction 落一条 umbrella-decision 审计'),
  baselineFile: z.string().default('')
    .description('推荐基线配置路径（空 = 随包 defaults/umbrella-rules.yaml；":none:" = 不加载基线）'),
  envRulesFile: z.string().default('')
    .description('环境级规则配置路径（空 = 读 UMBRELLA_RULES_PATH；CI/部署注入用）'),
  rulesFile: z.string().default('')
    .description('YAML 规则配置文件路径（空 = 只用内置规则；相对路径按本实例 cwd 解析）'),
  rulesWatch: z.boolean().default(true)
    .description('监听 rulesFile 变化并热加载（失败保留上一次有效规则）'),
  rulesDebounceMs: z.natural().default(200)
    .description('热加载防抖窗口（毫秒）'),
})

function safeGet(ctx, key) {
  try { return ctx?.get?.(key) } catch { return undefined }
}

/** 空数组 = 用内置默认；非空数组 = 调用方完全接管。 */
function patternsOrUndefined(value) {
  return Array.isArray(value) && value.length > 0 ? value.map(String) : undefined
}

export function apply(ctx, config) {
  const gate = roleGate('umbrella', { cfgRole: config?.role, logger: ctx.logger })
  if (!gate.active) return

  const cfg = Config(config ?? {})

  /** 评分服务按需取：loader 行序不保证 scorer 先于 umbrella 完成注册。 */
  const scorerAdapter = () => ({
    scoreSource(source, pkg, opts) {
      const scorer = safeGet(ctx, SERVICE.scorer)
      if (typeof scorer?.scoreSource !== 'function') return unavailable()
      return scorer.scoreSource(source, pkg, opts)
    },
    scoreDir(dir, manifest, opts) {
      const scorer = safeGet(ctx, SERVICE.scorer)
      if (typeof scorer?.scoreDir !== 'function') return unavailable()
      return scorer.scoreDir(dir, manifest, opts)
    },
  })

  /** buffer root 的实时来源：config → buffer-keeper.dir → buffer-keeper.config.root。 */
  const policyNow = () => {
    const configuredBuffer = String(cfg.bufferRoot ?? '').trim()
    const buffer = safeGet(ctx, SERVICE.buffer)
    const liveBuffer = typeof buffer?.dir === 'string' ? buffer.dir : ''
    const configBuffer = typeof buffer?.config?.root === 'string' ? buffer.config.root : ''
    return {
      bufferRoot: configuredBuffer || liveBuffer || configBuffer,
      productionRoot: String(cfg.productionRoot ?? '').trim(),
      allowPaths: cfg.allowPaths,
      networkAllowlist: cfg.networkAllowlist,
      credentialPatterns: patternsOrUndefined(cfg.credentialPatterns),
      destructivePatterns: patternsOrUndefined(cfg.destructivePatterns),
      lifecyclePatterns: patternsOrUndefined(cfg.lifecyclePatterns),
      lifecycleTools: Array.isArray(cfg.lifecycleTools) && cfg.lifecycleTools.length > 0
        ? cfg.lifecycleTools.map(String)
        : undefined,
    }
  }

  // ── 规则配置层（分三层叠加）：包内基线 → 项目级 rulesFile → 环境级 UMBRELLA_RULES_PATH ──
  // fail-safe：任一层的加载/应用失败都不影响已生效的层；事务化由 registry 负责。
  const ruleRegistry = createRuleRegistry(DEFAULT_ACTION_RULES)
  const baselinePath = (() => {
    const configured = String(cfg.baselineFile ?? '').trim()
    if (configured === ':none:') return ''
    if (configured.length > 0) return path.resolve(configured)
    try {
      return fileURLToPath(new URL('../../defaults/umbrella-rules.yaml', import.meta.url))
    } catch {
      return ''
    }
  })()
  const projectPath = String(cfg.rulesFile ?? '').trim()
  const projectFilePath = projectPath.length > 0 ? path.resolve(projectPath) : ''
  const envPath = String(cfg.envRulesFile ?? '').trim() || String(process.env.UMBRELLA_RULES_PATH ?? '').trim()
  const envFilePath = envPath.length > 0 ? path.resolve(envPath) : ''

  let ruleConfigStatus = {
    source: 'builtin',
    layers: [],
    ruleCount: ruleRegistry.ids().length,
    applied: false,
    warnings: [],
    errors: [],
    appliedAt: null,
    strictMode: null,
  }
  let lastStrictStamp = null

  const layerCandidates = [
    { name: 'baseline', file: baselinePath },
    { name: 'project', file: projectFilePath },
    { name: 'env', file: envFilePath },
  ].filter((layer) => layer.file.length > 0)

  const applyAllLayers = () => {
    ruleRegistry.clearLayers()
    const layerStatus = []
    const warnings = []
    const errors = []
    for (const layer of layerCandidates) {
      const loaded = loadRuleConfigFile(layer.file)
      if (loaded.errors.length > 0) {
        layerStatus.push({ name: layer.name, file: layer.file, applied: false, found: loaded.found, errors: loaded.errors })
        errors.push(...loaded.errors.map((e) => `${layer.name}: ${e}`))
        try { ctx.logger?.warn?.(`[umbrella] ${layer.name} rule config skipped: ${loaded.errors.join('; ')}`) } catch { /* ignore */ }
        continue
      }
      if (loaded.config === null) {
        layerStatus.push({ name: layer.name, file: layer.file, applied: false, found: loaded.found, errors: [] })
        continue
      }
      const applied = ruleRegistry.applyLayer(loaded.config)
      layerStatus.push({
        name: layer.name,
        file: layer.file,
        applied: applied.applied,
        found: true,
        ruleCount: applied.ruleCount,
        warnings: applied.warnings,
        errors: applied.errors,
      })
      warnings.push(...applied.warnings)
      errors.push(...applied.errors)
      if (!applied.applied) {
        try { ctx.logger?.warn?.(`[umbrella] ${layer.name} rule config rejected, keeping previous rules: ${applied.errors.join('; ')}`) } catch { /* ignore */ }
      }
    }
    const registryStatus = ruleRegistry.status()
    ruleConfigStatus = {
      source: registryStatus.source,
      layers: layerStatus,
      ruleCount: ruleRegistry.ids().length,
      applied: layerStatus.some((layer) => layer.applied === true),
      warnings,
      errors,
      appliedAt: Date.now(),
      strictMode: registryStatus.strictMode ?? null,
    }
    // 严格模式是重大配置行为：首次激活（或层/丢弃数变化）时落一条审计
    const strict = ruleConfigStatus.strictMode
    const stamp = strict === null ? null : `${strict.layerIndex}:${strict.discardedRuleCount}:${strict.preservedHardRules.join(',')}`
    if (stamp !== null && stamp !== lastStrictStamp) {
      lastStrictStamp = stamp
      try {
        safeGet(ctx, SERVICE.auditor)?.append?.(AUDIT.UMBRELLA_STRICT_MODE, {
          component: name,
          at: strict.activatedAt,
          layerIndex: strict.layerIndex,
          preservedHardRules: strict.preservedHardRules,
          preservedFallback: strict.preservedFallback ?? [],
          discardedRuleCount: strict.discardedRuleCount,
          layers: ruleConfigStatus.layers.map((layer) => ({ name: layer.name, applied: layer.applied })),
        })
      } catch { /* 审计缺失不影响决策 */ }
      try {
        ctx.logger?.info?.(`[umbrella] strict mode (inherit:false) active at layer ${strict.layerIndex}: preserved ${strict.preservedHardRules.length} hard rules, discarded ${strict.discardedRuleCount} adjustable rules`)
      } catch { /* logger 可选 */ }
    } else if (stamp === null) {
      lastStrictStamp = null
    }
    return ruleConfigStatus
  }

  applyAllLayers()

  let ruleWatcher = null
  const reloadRules = () => applyAllLayers()

  const watchedFile = projectFilePath || envFilePath || baselinePath
  if (watchedFile.length > 0 && cfg.rulesWatch) {
    ruleWatcher = watchRuleConfigFile(watchedFile, ruleRegistry, (result) => {
      ruleConfigStatus = {
        ...ruleConfigStatus,
        applied: result.applied === true,
        ruleCount: ruleRegistry.ids().length,
        warnings: result.warnings ?? ruleConfigStatus.warnings,
        errors: result.errors ?? [],
        appliedAt: Date.now(),
      }
    }, { debounceMs: cfg.rulesDebounceMs, logger: ctx.logger })
    ctx.effect(() => () => { try { ruleWatcher?.stop?.() } catch { /* ignore */ } })
  }

  const umbrella = createUmbrella({
    scorer: scorerAdapter(),
    policy: policyNow,
    floorTable: cfg.gradeFloorTable,
    cacheSize: cfg.cacheSize,
    registry: ruleRegistry,
    audit(record) {
      if (!cfg.auditDecisions) return
      try { safeGet(ctx, SERVICE.auditor)?.append?.(AUDIT.UMBRELLA_DECISION, record) } catch { /* 审计缺失不影响决策 */ }
    },
  })

  if (umbrella.floorDegraded) {
    try {
      ctx.logger?.warn?.(`[umbrella] unknown gradeFloorTable=${JSON.stringify(cfg.gradeFloorTable)}; fell back to "${DEFAULT_FLOOR_TABLE}"`)
    } catch { /* logger 可选 */ }
  }

  const service = {
    /** 本实例部署环境（mother | fork）——插件评分按它选阈值。 */
    environment: gate.role,

    get policy() {
      return umbrella.policy
    },

    floorTable: umbrella.floorTable,
    floorDegraded: umbrella.floorDegraded,
    floors: umbrella.grades,

    /** YAML 规则配置状态（来源 / 文件 / 是否应用 / 警告与错误）。 */
    ruleConfigStatus() {
      return { ...ruleConfigStatus, rules: ruleRegistry.ids() }
    },

    /** 立即重读 rulesFile（热加载的手动入口）。 */
    reloadRules() {
      return reloadRules()
    },

    /** 直接应用一份已解析的配置对象（测试/嵌入用）；失败保留旧规则。 */
    applyRuleConfig(config) {
      const applied = ruleRegistry.applyConfig(config)
      ruleConfigStatus = {
        ...ruleConfigStatus,
        applied: applied.applied,
        source: applied.applied ? 'yaml' : ruleConfigStatus.source,
        ruleCount: applied.ruleCount,
        warnings: applied.warnings,
        errors: applied.errors,
        appliedAt: Date.now(),
      }
      return applied
    },

    /** 规则注册表（只读视图 + 运行时注册/覆盖）。 */
    get ruleRegistry() {
      return ruleRegistry
    },

    /**
     * 插件评分（静态）。input: { pluginId?, dir?, manifest?, source?, pkg?, version?, environment?, refresh? }
     * 无 scorer / 扫描失败 → grade 'E' + degraded（失败往坏里判）。
     */
    assessPlugin(input = {}) {
      return umbrella.assessPlugin({ environment: gate.role, ...(input ?? {}) })
    },

    /** 动作评分（动态）：基础灯色 + 等级下限，返回 light/baseLight/gradeFloor/raised。 */
    assessAction(evidence = {}, opts = {}) {
      return umbrella.assessAction(evidence, opts ?? {})
    },

    /** 动作评分 + 决策矩阵 + 审计。 */
    decideAction(evidence = {}, opts = {}) {
      return umbrella.decideAction(evidence, opts ?? {})
    },

    /** 只算基础灯色（不考虑插件等级），带 matchedRule / category / tags / 结构化证据。 */
    baseLight(evidence = {}) {
      return umbrella.baseLight(evidence)
    },

    /** 面向 UI/审批的解释：规则 id、类别、tags、证据（为什么是这个灯色）。 */
    explain(evidence = {}) {
      const base = umbrella.baseLight(evidence)
      return {
        light: base.light,
        matchedRule: base.matchedRule,
        category: base.category,
        tags: base.tags,
        reason: base.reason,
        evidence: base.evidence,
        target: base.target,
      }
    },

    /** 规则表只读视图（数组顺序即优先级）。 */
    get rules() {
      return umbrella.rules
    },

    ruleIds() {
      return umbrella.ruleIds()
    },

    /** 动态注册/覆盖：形状不合法或插入位置不存在会立刻抛错，不会被静默忽略。 */
    registerRule(rule, opts) {
      return umbrella.registerRule(rule, opts)
    },

    overrideRule(id, patch) {
      return umbrella.overrideRule(id, patch)
    },

    removeRule(id) {
      return umbrella.removeRule(id)
    },

    resetRules() {
      return umbrella.resetRules()
    },

    gradeFloor(grade) {
      return umbrella.gradeFloor(grade)
    },

    effectiveLight(baseLightValue, grade) {
      return umbrella.effectiveLight(baseLightValue, grade)
    },

    cachedGrade(pluginId) {
      return umbrella.cachedGrade(pluginId)
    },

    cacheStats() {
      return umbrella.cacheStats()
    },

    invalidate(pluginId) {
      return umbrella.invalidate(pluginId)
    },

    clearCache() {
      return umbrella.clearCache()
    },
  }

  ctx.effect(() => ctx.provide(SERVICE.umbrella, service))
  return service
}

/** 评分服务不可用时给 createUmbrella 的失败形状（guard 见 lib 的 runScorer）。 */
function unavailable() {
  return {
    grade: 'E', S: 100, color: LIGHT.RED, veto: false, degraded: true,
    signals: [], reasons: ['scorer-unavailable'], basis: null,
  }
}

export const _internals = {
  DECISION,
  SEVERITY,
  LIGHT,
  GRADE_FLOOR,
  GRADE_FLOOR_STRICT,
  patternsOrUndefined,
  normalizeGrade,
  normalizeLight,
  unavailable,
}
