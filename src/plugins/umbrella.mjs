// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang v2.7.6 fang-umbrella — 「保护伞」：一个证据管道，两个评分出口。
//
//   ├─ 插件评分：A/B/C/D/E（交给 fang-scorer 的 import 层扫描，按入口 mtime 缓存）
//   └─ 动作评分：green/blue/yellow/red（每次动作重算）+ 等级下限抬高
//
// 这个插件自己**不扫源码**：静态证据的唯一来源是 `SERVICE.scorer`，缺它就失败往坏里判
// （E + degraded），绝不假装安全。纯逻辑在 `src/lib/umbrella.mjs`，契约见 docs/UMBRELLA.md。
import { AUDIT, SERVICE, roleGate, z } from '../kernel/index.mjs'
import {
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

  const umbrella = createUmbrella({
    scorer: scorerAdapter(),
    policy: policyNow,
    floorTable: cfg.gradeFloorTable,
    cacheSize: cfg.cacheSize,
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

    /** 只算基础灯色（不考虑插件等级）。 */
    baseLight(evidence = {}) {
      return umbrella.baseLight(evidence)
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
