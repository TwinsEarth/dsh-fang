// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// dsh-Fang 保护伞（Umbrella）· TypeScript 参考实现的类型层（v2.7.7）
//
// 这是运行时 `src/lib/umbrella.mjs` + `src/plugins/umbrella.mjs` 的**可编译镜像**：
// 语义以 .mjs 为准，TS 版把文件系统/时钟/审计等副作用全部收进注入端口，
// 因此不 import 任何 node: 内建模块，`tsc --strict` 即可编译（见 types/README.md）。

/** 四色灯。green = 无副作用，blue = 受控副作用，yellow = 需确认，red = 危险。 */
export type Light = 'green' | 'blue' | 'yellow' | 'red'

/** 静态风险等级：A 最安全，E 否决。 */
export type PluginGrade = 'A' | 'B' | 'C' | 'D' | 'E'

/** 决策出口。 */
export type Decision = 'allow' | 'mark' | 'ask' | 'delegate' | 'deny'

export type Severity = 'normal' | 'critical'

/** 动作灯色所用等级的来源，写进审计供追溯。 */
export type GradeBasis =
  | 'explicit-grade'
  | 'assessment'
  | 'evidence'
  | 'cached-plugin-grade'
  | 'unscored-fail-closed'

export type ActionMode = 'read' | 'write' | 'exec' | 'network' | 'import' | 'unknown'

export type ActionScope = 'session' | 'system' | 'process'

/** 动作规则类别（与 .mjs 的 ACTION_CATEGORIES 一致）。 */
export type ActionCategory =
  | 'lifecycle'
  | 'destructive'
  | 'credential'
  | 'network'
  | 'import'
  | 'write'
  | 'exec'
  | 'read'
  | 'fallback'

export const LIGHT = {
  GREEN: 'green',
  BLUE: 'blue',
  YELLOW: 'yellow',
  RED: 'red',
} as const satisfies Record<string, Light>

/** 灯色严重度：数值越大越危险。 */
export const LIGHT_RANK: Readonly<Record<Light, number>> = {
  green: 1,
  blue: 2,
  yellow: 3,
  red: 4,
}

export interface FloorTable {
  readonly A: Light
  readonly B: Light
  readonly C: Light
  readonly D: Light
  readonly E: Light
}

/**
 * 默认下限表（设计稿 §3.3 原样）：A/B 绿、C 蓝、D 黄、E 红。
 *
 * 与「插件自身颜色」（A 绿 / B 蓝 / C 黄 / D、E 红）回答的是两个不同问题：
 * 前者是「等级插件跑动作时灯色下限」，后者是「插件在面板上显示什么颜色」。
 * 二者在 B 级上必然不同，这是刻意的；偏好一致的部署用 `strict` 表。
 */
export const GRADE_FLOOR: FloorTable = { A: 'green', B: 'green', C: 'blue', D: 'yellow', E: 'red' }

/** 与内核 GRADE_COLOR 完全一致的下限表。 */
export const GRADE_FLOOR_STRICT: FloorTable = { A: 'green', B: 'blue', C: 'yellow', D: 'red', E: 'red' }

export type FloorTableName = 'umbrella' | 'strict' | 'custom'

export interface FloorSelection {
  readonly name: FloorTableName
  readonly table: FloorTable
  /** 传入未知表名时为 true：回退默认表，但不假装用的是调用方要的表。 */
  readonly degraded: boolean
}

export const FLOOR_TABLES: Readonly<Record<'umbrella' | 'strict', FloorTable>> = {
  umbrella: GRADE_FLOOR,
  strict: GRADE_FLOOR_STRICT,
}

export const DEFAULT_FLOOR_TABLE: FloorTableName = 'umbrella'

export interface ActionTarget {
  readonly kind: 'path' | 'url' | 'command' | 'pid' | 'none'
  readonly value: string
}

/** 动作证据：调用方（工具执行管道）构造，保护伞不猜工具语义之外的任何东西。 */
export interface ActionEvidence {
  readonly tool: string
  readonly args?: Readonly<Record<string, unknown>>
  readonly target?: ActionTarget
  readonly scope?: ActionScope
  readonly pluginId?: string
  readonly pluginGrade?: PluginGrade
  readonly mode?: ActionMode
}

/** 策略输入：模式用正则源码字符串（可跨进程配置），相对路径按 root 解析。 */
export interface ActionPolicyInput {
  readonly root?: string
  readonly bufferRoot?: string | null
  readonly productionRoot?: string | null
  readonly allowPaths?: readonly string[]
  readonly networkAllowlist?: readonly string[]
  readonly credentialPatterns?: readonly string[]
  readonly destructivePatterns?: readonly string[]
  readonly lifecyclePatterns?: readonly string[]
  readonly lifecycleTools?: readonly string[]
  readonly readOnlyExecPatterns?: readonly string[]
}

/** 归一化后的策略：路径已解析、模式已编译。 */
export interface ActionPolicy {
  readonly root: string
  readonly bufferRoot: string | null
  readonly productionRoot: string | null
  readonly allowPaths: readonly string[]
  readonly networkAllowlist: readonly string[]
  readonly credentialPatterns: readonly RegExp[]
  readonly destructivePatterns: readonly RegExp[]
  readonly lifecyclePatterns: readonly RegExp[]
  readonly lifecycleTools: readonly string[]
  readonly readOnlyExecPatterns: readonly RegExp[]
  /** Windows 语义（大小写不敏感路径比较）。宿主按 process.platform 注入。 */
  readonly caseInsensitive: boolean
}

export interface BaseLightResult {
  readonly light: Light
  readonly matchedRule: string
  readonly category: ActionCategory
  readonly tags: readonly string[]
  readonly lifecycle: boolean
  readonly credential: boolean
  readonly target: ActionTarget
  readonly path: string | null
  readonly reason: string
  readonly evidence: RuleEvidence
}

/** 规则证据：结构化的「为什么匹配」，进审计。 */
export interface RuleEvidence {
  readonly matchedPattern?: string
  readonly targets?: readonly string[]
  readonly path?: string | null
  readonly host?: string | null
  readonly url?: string
  readonly [key: string]: unknown
}

/** 动作解析上下文：一次解析，15 条规则共享。 */
export interface ActionContext {
  readonly mode: ActionMode
  readonly target: ActionTarget
  readonly commandText: string
  readonly targetPath: string | null
  readonly url: { readonly raw: string; readonly host: string; readonly hostPort: string } | null
  readonly targetPid: number | null
  readonly writeTargets: readonly string[]
  readonly readTargets: readonly string[]
  /** shell 语法解析失败（未闭合引号/heredoc 等）：规则必须 fail-closed 判黄，不许猜。 */
  readonly parseFailed: boolean
  readonly parseError: string | null
  /** heredoc 正文段数（正文不参与重定向解析）。 */
  readonly heredocs: number
  /** 跳过的目标说明，如 `>-dynamic-target`。 */
  readonly warnings: readonly string[]
  readonly policy: ActionPolicy
}

/** 声明式动作规则：id / category / light / reason / tags / match / evidence。 */
export interface ActionRule {
  readonly id: string
  readonly category: ActionCategory
  readonly light: Light
  readonly reason: string
  readonly tags: readonly string[]
  readonly match: (evidence: ActionEvidence, context: ActionContext) => boolean
  readonly evidence: (evidence: ActionEvidence, context: ActionContext) => RuleEvidence
}

export interface RulePlacement {
  readonly before?: string
  readonly after?: string
}

export interface ActionRuleSet {
  readonly rules: readonly ActionRule[]
  ids(): readonly string[]
  register(rule: ActionRule, placement: RulePlacement): ActionRule
  override(id: string, patch: Partial<Omit<ActionRule, 'id'>>): ActionRule
  remove(id: string): boolean
  reset(): void
  find(evidence: ActionEvidence, context: ActionContext): ActionRule | null
}

export interface ActionAssessment {
  readonly light: Light
  readonly baseLight: Light
  readonly gradeFloor: Light
  readonly raised: boolean
  readonly pluginGrade: PluginGrade
  readonly gradeBasis: GradeBasis
  readonly matchedRule: string
  readonly category: ActionCategory
  readonly tags: readonly string[]
  readonly lifecycle: boolean
  readonly credential: boolean
  readonly reason: string
  readonly evidence: RuleEvidence
  readonly tool: string
  readonly target: ActionTarget
  readonly path: string | null
  readonly durationMs: number
  readonly fromCache: false
}

export interface GradeResolveInput {
  readonly grade?: PluginGrade
  readonly assessment?: { readonly grade: PluginGrade }
  readonly pluginId?: string
}

export interface DecisionOutcome {
  readonly decision: Decision
  readonly severity: Severity
  readonly reason: string
  readonly originLight?: Light
  readonly target?: 'restartGuard'
  readonly elevated?: boolean
}

export interface DecisionRecord {
  readonly kind: 'umbrella-decision'
  readonly at: number
  readonly tool: string | null
  readonly target: { readonly kind: string; readonly value: string } | null
  readonly pluginId: string | null
  readonly pluginGrade: PluginGrade
  readonly gradeBasis: GradeBasis
  readonly baseLight: Light
  readonly light: Light
  readonly matchedRule: string
  readonly category: ActionCategory
  readonly evidence: RuleEvidence
  readonly decision: Decision
  readonly severity: Severity
  readonly durationMs: number
}

export interface DecisionResult extends ActionAssessment {
  readonly decision: Decision
  readonly severity: Severity
  readonly decisionRecord: DecisionRecord
}

/** `fangScorer` 服务面（只声明保护伞会调用的部分）。 */
export interface ScorerAssessment {
  readonly grade?: string
  readonly S?: number
  readonly color?: string
  readonly veto?: boolean
  readonly degraded?: boolean
  readonly signals?: readonly { readonly id: string; readonly weight: number }[]
  readonly reasons?: readonly string[]
  readonly basis?: Readonly<Record<string, unknown>> | null
  readonly dir?: string | null
  readonly entry?: string | null
}

export interface ScorerPort {
  scoreSource?(
    source: string,
    pkg: Readonly<Record<string, unknown>>,
    opts: { readonly environment: string },
  ): ScorerAssessment | null | undefined
  scoreDir?(
    dir: string,
    manifest: unknown,
    opts: { readonly environment: string },
  ): ScorerAssessment | null | undefined
}

export interface StaticSignal {
  readonly id: string
  readonly weight: number
}

export interface PluginAssessment {
  readonly pluginId: string
  readonly version: string
  readonly grade: PluginGrade
  readonly score: number
  readonly color: string
  readonly veto: boolean
  readonly degraded: boolean
  readonly signals: readonly StaticSignal[]
  readonly reasons: readonly string[]
  readonly basis: Readonly<Record<string, unknown>> | null
  readonly entry: string | null
  readonly dir: string | null
  readonly cachedAt: number
  readonly fingerprint: string | null
  readonly durationMs: number
  readonly fromCache: boolean
}

export interface PluginAssessmentInput {
  readonly pluginId?: string
  readonly dir?: string
  readonly source?: string
  readonly pkg?: Readonly<Record<string, unknown>>
  readonly version?: string
  readonly manifest?: unknown
  readonly refresh?: boolean
  readonly environment?: string
}

export interface CacheStats {
  readonly hits: number
  readonly misses: number
  readonly evictions: number
  readonly invalidations: number
  readonly pluginScans: number
  readonly size: number
  readonly capacity: number
}

/** 文件系统端口：参考实现不直接 import node:fs，由宿主注入。 */
export interface FingerprintPort {
  /** 入口文件的 mtimeMs 字符串；文件不存在时返回 null（视为 stale）。 */
  fileMtime(file: string): string | null
  /** 内容哈希（Node 下用 sha1）；inline 源码用它做指纹。 */
  hash(text: string): string
}

export interface Clock {
  now(): number
}
