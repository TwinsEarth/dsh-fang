// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// Umbrella 门面（TS 参考实现）— 对应运行时 `createUmbrella()`（src/lib/umbrella.mjs）。
// 两个评分出口在这里合流：PluginScorer 出等级，ActionScorer 出灯色，
// 门面负责「取等级 → 抬高灯色 → 决策 → 审计」这条主线的最后一公里。

import { ActionScorer, decide } from './action-scorer.js'
import type { AssessOptions } from './action-scorer.js'
import { PluginScorer } from './plugin-scorer.js'
import { DEFAULT_FLOOR_TABLE, FLOOR_TABLES, GRADE_FLOOR } from './types.js'
import type {
  ActionAssessment,
  ActionEvidence,
  ActionPolicy,
  ActionPolicyInput,
  CacheStats,
  Clock,
  DecisionRecord,
  DecisionResult,
  FingerprintPort,
  FloorTable,
  FloorTableName,
  Light,
  PluginAssessment,
  PluginAssessmentInput,
  PluginGrade,
  ScorerPort,
} from './types.js'

const DEFAULT_CLOCK: Clock = { now: () => Date.now() }

export interface FloorResolution {
  readonly name: FloorTableName
  readonly table: FloorTable
  /** 传入未知表名时为 true：回退默认表，但不假装用的是调用方要的表。 */
  readonly degraded: boolean
}

/** 下限表解析：接受表名或表对象；未知表名回退默认并标 degraded。 */
export function resolveFloorTable(table?: string | FloorTable): FloorResolution {
  if (typeof table === 'string') {
    const key = table.trim().toLowerCase()
    if (key === 'umbrella' || key === 'strict') {
      const preset = FLOOR_TABLES[key]
      return { name: key, table: preset, degraded: false }
    }
    return { name: DEFAULT_FLOOR_TABLE, table: GRADE_FLOOR, degraded: true }
  }
  if (table !== undefined) {
    const custom: FloorTable = {
      A: table.A,
      B: table.B,
      C: table.C,
      D: table.D,
      E: table.E,
    }
    return { name: 'custom', table: custom, degraded: false }
  }
  return { name: DEFAULT_FLOOR_TABLE, table: GRADE_FLOOR, degraded: false }
}

export interface UmbrellaOptions {
  /** `fangScorer` 服务；null 表示没有静态证据源（一律 E + degraded）。 */
  readonly scorer: ScorerPort | null
  /** mtime / hash 端口（Node 下用 node:fs / node:crypto 实现）。 */
  readonly fingerprints: FingerprintPort
  /** 策略可以是函数：buffer-keeper 的 root 是 start({dir}) 之后才知道的。 */
  readonly policy: ActionPolicyInput | (() => ActionPolicyInput)
  /** 'umbrella'（默认）| 'strict' | 自定义表。 */
  readonly floors?: string | FloorTable
  /** Windows 语义路径比较；Node 宿主传 process.platform === 'win32'。 */
  readonly caseInsensitive?: boolean
  readonly cacheCapacity?: number
  readonly clock?: Clock
  /** 一次 decideAction 一条审计记录；抛错不影响决策。 */
  readonly audit?: (record: DecisionRecord) => void
}

export interface UmbrellaDecisionOptions extends AssessOptions {
  /** 证据里没有 pluginId 时，由调用方显式给出。 */
  readonly pluginId?: string
}

export class Umbrella {
  private readonly pluginScorer: PluginScorer
  private readonly actionScorer: ActionScorer
  private readonly auditHook: ((record: DecisionRecord) => void) | undefined
  private readonly clock: Clock

  readonly floorTable: FloorTableName
  readonly floors: FloorTable
  readonly floorDegraded: boolean

  constructor(options: UmbrellaOptions) {
    const floor = resolveFloorTable(options.floors)
    this.floorTable = floor.name
    this.floors = floor.table
    this.floorDegraded = floor.degraded
    this.clock = options.clock ?? DEFAULT_CLOCK
    this.auditHook = options.audit
    this.pluginScorer = new PluginScorer({
      scorer: options.scorer,
      fingerprints: options.fingerprints,
      ...(options.cacheCapacity === undefined ? {} : { cacheCapacity: options.cacheCapacity }),
      clock: this.clock,
    })
    this.actionScorer = new ActionScorer({
      policy: options.policy,
      floors: this.floors,
      caseInsensitive: options.caseInsensitive ?? false,
      clock: this.clock,
    })
  }

  /** 归一化后的策略（bufferRoot 等会随注入函数实时变化）。 */
  get policy(): ActionPolicy {
    return this.actionScorer.policy
  }

  /** 插件评分（静态）：缓存命中只校验指纹，不重扫。 */
  assessPlugin(input: PluginAssessmentInput = {}): PluginAssessment {
    return this.pluginScorer.assess(input)
  }

  /**
   * 批量评分：同步映射（与运行时 .mjs 一致）。
   * 设计稿写成 `Promise.all`，本仓库的评分门面是同步的——同步能保证调用方
   * 在动作发生前拿到等级，不会出现「异步评分还没回来就先放行」的窗口。
   */
  assessPluginsBatch(inputs: readonly PluginAssessmentInput[]): readonly PluginAssessment[] {
    return inputs.map((input) => this.pluginScorer.assess(input))
  }

  /** 动作评分（动态）：基础灯色 + 等级下限，只升不降。 */
  assessAction(evidence: ActionEvidence, options: AssessOptions = {}): ActionAssessment {
    return this.actionScorer.assess(evidence, this.withCachedGrade(evidence, options))
  }

  /** 动作评分 + 决策矩阵 + 一条 `umbrella-decision` 审计。 */
  decideAction(evidence: ActionEvidence, options: UmbrellaDecisionOptions = {}): DecisionResult {
    const started = this.clock.now()
    const assessment = this.assessAction(evidence, options)
    const decision = decide(assessment)
    const pluginId = options.pluginId ?? evidence.pluginId ?? null
    const record: DecisionRecord = {
      kind: 'umbrella-decision',
      at: this.clock.now(),
      tool: assessment.tool.length > 0 ? assessment.tool : null,
      target: assessment.target.kind === 'none' ? null : { kind: assessment.target.kind, value: assessment.target.value },
      pluginId,
      pluginGrade: assessment.pluginGrade,
      gradeBasis: assessment.gradeBasis,
      baseLight: assessment.baseLight,
      light: assessment.light,
      matchedRule: assessment.matchedRule,
      category: assessment.category,
      evidence: assessment.evidence,
      decision: decision.decision,
      severity: decision.severity,
      durationMs: Math.max(0, this.clock.now() - started),
    }
    this.emitAudit(record)
    return { ...assessment, decision: decision.decision, severity: decision.severity, decisionRecord: record }
  }

  baseLight(evidence: ActionEvidence): ReturnType<ActionScorer['baseLight']> {
    return this.actionScorer.baseLight(evidence)
  }

  gradeFloor(grade: PluginGrade): Light {
    return this.actionScorer.gradeFloor(grade)
  }

  effectiveLight(base: Light, grade: PluginGrade): ReturnType<ActionScorer['effectiveLight']> {
    return this.actionScorer.effectiveLight(base, grade)
  }

  cachedGrade(pluginId: string): PluginGrade | null {
    return this.pluginScorer.cachedGrade(pluginId)
  }

  cacheStats(): CacheStats {
    return this.pluginScorer.cacheStats()
  }

  invalidate(pluginIdOrKey: string): number {
    return this.pluginScorer.invalidate(pluginIdOrKey)
  }

  clearCache(): number {
    return this.pluginScorer.clear()
  }

  private withCachedGrade(evidence: ActionEvidence, options: AssessOptions): AssessOptions {
    if (options.cachedGrade !== undefined) return options
    if (options.grade !== undefined || options.assessment !== undefined) return options
    if (evidence.pluginGrade !== undefined) return options
    const pluginId = options.pluginId ?? evidence.pluginId
    if (pluginId === undefined) return options
    const grade = this.pluginScorer.cachedGrade(pluginId)
    return grade === null ? options : { ...options, cachedGrade: grade }
  }

  private emitAudit(record: DecisionRecord): void {
    const hook = this.auditHook
    if (hook === undefined) return
    try {
      hook(record)
    } catch {
      // 审计失败不得影响决策（与运行时 .mjs 一致）
    }
  }
}
