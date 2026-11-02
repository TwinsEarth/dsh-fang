// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// dsh-Fang 保护伞 — 分层规则注册表的 TypeScript 参考实现（v2.8.5）。
//
// 镜像运行时 `src/lib/rule-registry.mjs` 的 v2.8.x 语义：
//   * 内置规则 + YAML 层（基线 → 项目 → 环境，后层按 id 覆盖前层）；
//   * 声明式 matcher / evidence 编译（9 种 matcher、3 种 evidence，不能写任意 JS）；
//   * 硬规则锁定（hard-deny / non-negotiable：不可关闭、不可降低灯色）；
//   * `inherit: false` 严格模式（只保留硬规则 + fallback，从该层重新叠加）；
//   * 事务化：失败层的 layers / effective / status 全部回滚，`revertedToLayerIndex` 指明回退目标。
//
// 本文件不 import 任何 `node:` 内建模块。

import type {
  ActionCategory, ActionContext, ActionEvidence, ActionRule, Light, RuleEvidence,
} from './types.js'
import { ACTION_CATEGORIES, DEFAULT_ACTION_RULES, assertActionRule } from './action-scorer.js'
import type { RuleConfig, RuleOverride } from './rule-config.js'
import { DEFAULT_RULE_PRIORITIES, isSafePatternSource } from './rule-config.js'

export const NON_NEGOTIABLE_TAGS = Object.freeze(['hard-deny', 'non-negotiable'])

export function isLockedRule(rule: ActionRule | null | undefined): boolean {
  return Array.isArray(rule?.tags) && rule.tags.some((tag) => NON_NEGOTIABLE_TAGS.includes(tag))
}

const LIGHT_RANK: Readonly<Record<Light, number>> = { green: 1, blue: 2, yellow: 3, red: 4 }

export interface StrictModeInfo {
  readonly activatedAt: number
  readonly layerIndex: number
  readonly preservedHardRules: readonly string[]
  readonly preservedFallback: readonly string[]
  readonly discardedRuleCount: number
}

export interface RuleLayerRecord {
  readonly index: number
  readonly inherit: boolean
  readonly version: number | null
  readonly rules: number
  readonly errors: number
}

export interface RuleRegistryStatus {
  readonly source: 'builtin' | 'layered' | 'strict-replaced'
  readonly appliedAt: number | null
  readonly warnings: readonly string[]
  readonly errors: readonly string[]
  readonly configVersion: number | null
  readonly layers: number
  readonly strictMode: StrictModeInfo | null
  readonly ruleCount: number
}

export interface ApplyResult {
  readonly applied: boolean
  readonly ruleCount: number
  readonly warnings: readonly string[]
  readonly errors: readonly string[]
  readonly source: 'builtin' | 'layered' | 'strict-replaced'
  readonly strictMode: StrictModeInfo | null
  readonly layers: readonly RuleLayerRecord[]
  /** 失败时：回退目标层索引（-1 = 内置全集） */
  readonly revertedToLayerIndex?: number
}

export interface RuleRegistryOptions {
  readonly priorities?: Readonly<Record<string, number>>
}

interface Table {
  byId: Map<string, ActionRule>
  priorities: Record<string, number>
  locked: Set<string>
  preserved: readonly ActionRule[]
}

interface RebuildOutput {
  readonly applied: boolean
  readonly sorted: readonly ActionRule[]
  readonly warnings: readonly string[]
  readonly errors: readonly string[]
  readonly source: 'builtin' | 'layered' | 'strict-replaced'
  readonly strictMode: StrictModeInfo | null
  readonly layerRecords: readonly RuleLayerRecord[]
  readonly table: Table
  readonly startIndex: number
}

function hostMatches(host: string, pattern: string): boolean {
  const p = String(pattern).toLowerCase()
  const h = String(host).toLowerCase()
  if (p.startsWith('*.')) return h.endsWith(p.slice(1))
  return h === p
}

/** 纯字符串路径包含判断（参考实现不依赖 node:path；Windows 下大小写不敏感）。 */
function pathInside(child: string, parent: string): boolean {
  if (parent.length === 0) return false
  const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const c = normalize(child)
  const p = normalize(parent)
  return c === p || c.startsWith(`${p}/`)
}

function compilePatterns(
  list: readonly { readonly re: string }[] | undefined,
  errors: string[],
  label: string,
  rejectUnsafeRegex: boolean,
): RegExp[] {
  if (list === undefined) return []
  const compiled: RegExp[] = []
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index]
    if (entry === undefined) continue
    if (rejectUnsafeRegex && !isSafePatternSource(entry.re)) {
      errors.push(`${label}[${index}]: unsafe regex rejected (possible ReDoS)`)
      continue
    }
    try {
      compiled.push(new RegExp(entry.re, 'i'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`${label}[${index}]: invalid regex (${message})`)
    }
  }
  return compiled
}

/** 编译声明式规则；errors 非空时 rule 可能仍可用（调用方按 failOnInvalidPattern 决定）。 */
export function compileDeclarativeRule(entry: RuleOverride, options: { readonly rejectUnsafeRegex?: boolean } = {}): { rule: ActionRule | null; errors: string[] } {
  const rejectUnsafeRegex = options.rejectUnsafeRegex !== false
  if (entry.match === undefined) return { rule: null, errors: [`rules.${entry.id}: not a declarative rule`] }
  const errors: string[] = []
  const match = entry.match
  const matchErrors: string[] = []
  const pathPatterns = compilePatterns(match.patterns, matchErrors, `rules.${entry.id}.match.patterns`, rejectUnsafeRegex)
  const commandPatterns = compilePatterns(match.patterns, matchErrors, `rules.${entry.id}.match.patterns`, rejectUnsafeRegex)
  errors.push(...matchErrors)
  const contextCandidates = (ctx: ActionContext): string[] =>
    [ctx.targetPath, ...ctx.writeTargets, ...ctx.readTargets].filter((value): value is string => typeof value === 'string')

  let matchFn: ((evidence: ActionEvidence, context: ActionContext) => boolean) | null = null
  switch (match.kind) {
    case 'command-pattern':
      matchFn = (_evidence, ctx) => commandPatterns.some((re) => re.test(ctx.commandText))
      break
    case 'path-pattern': {
      const scope = match.scope ?? 'all'
      matchFn = (_evidence, ctx) => {
        const candidates = scope === 'target'
          ? (ctx.targetPath === null ? [] : [ctx.targetPath])
          : scope === 'read' ? [...ctx.readTargets]
            : scope === 'write' ? [...ctx.writeTargets]
              : contextCandidates(ctx)
        return candidates.some((candidate) => pathPatterns.some((re) => re.test(candidate)))
      }
      break
    }
    case 'path-outside': {
      const checkAllowPaths = match.checkAllowPaths !== false
      matchFn = (_evidence, ctx) => {
        const targetPath = ctx.targetPath
        if (targetPath === null) return false
        const root = match.root === '$bufferRoot' ? ctx.policy.bufferRoot
          : match.root === '$productionRoot' ? ctx.policy.productionRoot
            : match.literal ?? null
        if (root === null) return false
        if (pathInside(targetPath, root)) return false
        if (checkAllowPaths && ctx.policy.allowPaths.some((allowed) => pathInside(targetPath, allowed))) return false
        return true
      }
      break
    }
    case 'url-host-in': {
      const hosts = match.hosts ?? []
      matchFn = (_evidence, ctx) => ctx.url !== null && hosts.some((host) => hostMatches(ctx.url?.host ?? '', host))
      break
    }
    case 'url-host-not-in': {
      const hosts = match.hosts ?? []
      matchFn = (_evidence, ctx) => ctx.url !== null && !hosts.some((host) => hostMatches(ctx.url?.host ?? '', host))
      break
    }
    case 'tool-in': {
      const tools = new Set(match.tools ?? [])
      matchFn = (evidence) => tools.has(String(evidence.tool))
      break
    }
    case 'pid-equal': {
      const pid = match.pid
      matchFn = (_evidence, ctx) => (pid === '$currentPid' ? ctx.targetPid !== null : ctx.targetPid === pid)
      break
    }
    case 'always':
      matchFn = () => true
      break
    case 'never':
      matchFn = () => false
      break
    default:
      errors.push(`rules.${entry.id}.match.kind: unsupported "${String((match as { kind: string }).kind)}"`)
  }

  const evidenceKind = entry.evidence?.kind
  let evidenceFn: ((evidence: ActionEvidence, context: ActionContext) => RuleEvidence) | null = null
  switch (evidenceKind) {
    case 'pattern-match': {
      const all = [...commandPatterns, ...pathPatterns]
      evidenceFn = (_evidence, ctx) => {
        const patternIds: string[] = []
        for (const re of all) {
          if (re.test(ctx.commandText) || (ctx.targetPath !== null && re.test(ctx.targetPath)) || ctx.writeTargets.some((target) => re.test(target))) {
            patternIds.push(re.source)
          }
        }
        return { matchedPattern: patternIds[0] ?? 'declarative-pattern', patternIds }
      }
      break
    }
    case 'list-match':
      evidenceFn = (_evidence, ctx) => ({
        matchedPattern: 'declarative-list',
        writeTargets: [...ctx.writeTargets],
        readTargets: [...ctx.readTargets],
      })
      break
    case 'static': {
      const payload = entry.evidence?.payload ?? {}
      evidenceFn = () => ({ ...payload })
      break
    }
    default:
      errors.push(`rules.${entry.id}.evidence.kind: unsupported "${String(evidenceKind)}"`)
  }
  if (matchFn === null || evidenceFn === null) return { rule: null, errors }
  if (entry.light === undefined || entry.reason === undefined || entry.category === undefined) {
    errors.push(`rules.${entry.id}: declarative rule requires light/reason/category`)
    return { rule: null, errors }
  }
  if (!ACTION_CATEGORIES.includes(entry.category)) {
    errors.push(`rules.${entry.id}.category: unknown "${String(entry.category)}"`)
    return { rule: null, errors }
  }
  const rule: ActionRule = {
    id: entry.id,
    category: entry.category as ActionCategory,
    light: entry.light,
    reason: entry.reason,
    tags: entry.tags ?? [],
    match: matchFn,
    evidence: evidenceFn,
  }
  return { rule, errors }
}

/**
 * 分层规则注册表（与运行时逐语义对齐）：
 * 内置规则为底，YAML 层按顺序叠加；`inherit:false` 层丢弃之前的可调规则；
 * 失败层不提交（事务化），`revertedToLayerIndex` 指明回退目标。
 */
export class RuleRegistry {
  private readonly builtin: readonly ActionRule[]
  private readonly defaultPriorities: Readonly<Record<string, number>>
  private effective: ActionRule[]
  private layers: RuleConfig[] = []
  private status: RuleRegistryStatus
  private readonly builtinById: Map<string, ActionRule>

  constructor(builtinRules: readonly ActionRule[] = DEFAULT_ACTION_RULES, options: RuleRegistryOptions = {}) {
    this.builtin = [...builtinRules]
    this.defaultPriorities = { ...DEFAULT_RULE_PRIORITIES, ...(options.priorities ?? {}) }
    this.builtinById = new Map(this.builtin.map((rule) => [rule.id, rule]))
    this.effective = this.sortTable(new Map(this.builtin.map((rule) => [rule.id, rule])), { ...this.defaultPriorities })
    this.status = {
      source: 'builtin', appliedAt: null, warnings: [], errors: [], configVersion: null, layers: 0, strictMode: null,
      ruleCount: this.effective.length,
    }
  }

  get rules(): readonly ActionRule[] { return [...this.effective] }
  ids(): readonly string[] { return this.effective.map((rule) => rule.id) }
  layerCount(): number { return this.layers.length }
  priorities(): Readonly<Record<string, number>> { return { ...this.defaultPriorities } }
  getStatus(): RuleRegistryStatus { return { ...this.status, ruleCount: this.effective.length } }

  find(evidence: ActionEvidence, context: ActionContext): ActionRule | null {
    return this.effective.find((rule) => rule.match(evidence, context))
      ?? this.effective[this.effective.length - 1]
      ?? null
  }

  register(rule: ActionRule, placement: { before?: string; after?: string }): ActionRule {
    assertActionRule(rule)
    if (this.effective.some((existing) => existing.id === rule.id)) {
      throw new Error(`action rule already registered: ${rule.id}（覆盖请用 override()）`)
    }
    const before = placement.before === undefined ? -1 : this.effective.findIndex((existing) => existing.id === placement.before)
    const after = placement.after === undefined ? -1 : this.effective.findIndex((existing) => existing.id === placement.after)
    const next = [...this.effective]
    if (before >= 0) next.splice(before, 0, rule)
    else if (after >= 0) next.splice(after + 1, 0, rule)
    else throw new Error(`action rule ${rule.id}: register() requires before/after naming an existing rule`)
    this.effective = next
    return rule
  }

  override(id: string, patch: Partial<Omit<ActionRule, 'id'>>): ActionRule {
    const index = this.effective.findIndex((existing) => existing.id === id)
    if (index < 0) throw new Error(`action rule not found: ${id}`)
    const current = this.effective[index]
    if (current === undefined) throw new Error(`action rule not found: ${id}`)
    const merged = assertActionRule({ ...current, ...patch, id })
    this.effective = [...this.effective.slice(0, index), merged, ...this.effective.slice(index + 1)]
    return merged
  }

  remove(id: string): boolean {
    const index = this.effective.findIndex((existing) => existing.id === id)
    if (index < 0) return false
    this.effective = [...this.effective.slice(0, index), ...this.effective.slice(index + 1)]
    return true
  }

  reset(): ActionRule[] { return this.resetToBuiltin() }

  resetToBuiltin(): ActionRule[] {
    this.layers = []
    this.effective = this.sortTable(new Map(this.builtin.map((rule) => [rule.id, rule])), { ...this.defaultPriorities })
    this.status = {
      source: 'builtin', appliedAt: Date.now(), warnings: [], errors: [], configVersion: null, layers: 0, strictMode: null,
      ruleCount: this.effective.length,
    }
    return [...this.effective]
  }

  /** 用一份配置替换所有层（v2.8.0 单文件语义）；失败时恢复上一层状态。 */
  applyConfig(config: RuleConfig): ApplyResult {
    const saved = { layers: this.layers, effective: this.effective, status: this.status }
    this.layers = []
    const out = this.rebuild([config])
    if (!out.applied) {
      this.layers = saved.layers
      this.effective = saved.effective
      this.status = saved.status
      return this.toResult(out, saved.layers.length - 1)
    }
    this.layers = [config]
    this.commit(out)
    return this.toResult(out)
  }

  /** 追加一层（基线 → 项目 → 环境）；失败时回滚到上一次成功状态。 */
  applyLayer(config: RuleConfig): ApplyResult {
    const candidate = [...this.layers, config]
    const out = this.rebuild(candidate)
    if (!out.applied) {
      return this.toResult(out, this.layers.length - 1)
    }
    this.layers = candidate
    this.commit(out)
    return this.toResult(out)
  }

  clearLayers(): ApplyResult {
    const out = this.rebuild([])
    this.layers = []
    this.commit(out)
    return this.toResult(out)
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private priorityBase(rule: ActionRule, priorities: Readonly<Record<string, number>>): number {
    const explicit = priorities[rule.id]
    if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit
    const index = this.builtin.findIndex((candidate) => candidate.id === rule.id)
    return index >= 0 ? index * 10 : 5000
  }

  private sortTable(byId: Map<string, ActionRule>, priorities: Readonly<Record<string, number>>): ActionRule[] {
    return [...byId.values()]
      .map((rule, index) => ({ rule, index }))
      .sort((left, right) => {
        const diff = this.priorityBase(left.rule, priorities) - this.priorityBase(right.rule, priorities)
        return diff !== 0 ? diff : left.index - right.index
      })
      .map(({ rule }) => rule)
  }

  private buildTable(strictMode: boolean): Table {
    const priorities: Record<string, number> = { ...this.defaultPriorities }
    if (strictMode) {
      const preserved = this.builtin.filter((rule) => isLockedRule(rule) || rule.category === 'fallback')
      const byId = new Map(preserved.map((rule) => [rule.id, rule]))
      for (const id of Object.keys(priorities)) if (!byId.has(id)) delete priorities[id]
      const locked = new Set(preserved.filter((rule) => isLockedRule(rule)).map((rule) => rule.id))
      return { byId, priorities, locked, preserved }
    }
    return {
      byId: new Map(this.builtin.map((rule) => [rule.id, rule])),
      priorities,
      locked: new Set(),
      preserved: [],
    }
  }

  private applyLayerToMap(
    layer: RuleConfig,
    table: Table,
    warnings: string[],
    layerErrors: string[],
  ): boolean {
    let lockViolation = false
    const { byId, priorities, locked } = table
    for (const entry of layer.rules) {
      if (entry.match !== undefined) {
        if (byId.has(entry.id)) warnings.push(`declarative rule "${entry.id}" shadows an existing rule`)
        const compiled = compileDeclarativeRule(entry, { rejectUnsafeRegex: layer.settings.rejectUnsafeRegex })
        layerErrors.push(...compiled.errors)
        if (compiled.rule !== null) {
          try {
            assertActionRule(compiled.rule)
            byId.set(compiled.rule.id, compiled.rule)
            if (entry.priority !== undefined) priorities[compiled.rule.id] = entry.priority
            if (isLockedRule(compiled.rule)) locked.add(compiled.rule.id)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            layerErrors.push(`rules.${entry.id}: ${message}`)
          }
        }
        continue
      }

      const base = byId.get(entry.id) ?? this.builtinById.get(entry.id)
      if (base === undefined) {
        const message = `unknown rule id "${entry.id}"`
        if (layer.settings.failOnUnknownRule) layerErrors.push(message)
        else warnings.push(message)
        continue
      }

      if (isLockedRule(base) || locked.has(base.id)) {
        if (entry.enabled === false) {
          layerErrors.push(`rule "${entry.id}" is non-negotiable and cannot be disabled`)
          lockViolation = true
          continue
        }
        if (entry.light !== undefined && !(LIGHT_RANK[entry.light] >= LIGHT_RANK[base.light])) {
          layerErrors.push(`rule "${entry.id}" is non-negotiable; light cannot be lowered from ${base.light} to ${entry.light}`)
          lockViolation = true
          continue
        }
      }

      if (entry.enabled === false) {
        byId.delete(entry.id)
        locked.delete(entry.id)
        continue
      }

      const patternErrors: string[] = []
      const pathPatterns = entry.pathPatterns === undefined
        ? []
        : compilePatterns(entry.pathPatterns, patternErrors, `rules.${entry.id}.pathPatterns`, layer.settings.rejectUnsafeRegex)
      const commandPatterns = entry.commandPatterns === undefined
        ? []
        : compilePatterns(entry.commandPatterns, patternErrors, `rules.${entry.id}.commandPatterns`, layer.settings.rejectUnsafeRegex)
      layerErrors.push(...patternErrors)
      const originalMatch = base.match
      const merged: ActionRule = {
        id: entry.id,
        category: entry.category ?? base.category,
        light: entry.light ?? base.light,
        reason: entry.reason ?? base.reason,
        tags: entry.tags ?? base.tags,
        match: (evidence, context) => {
          if (originalMatch(evidence, context)) return true
          if (commandPatterns.some((re) => re.test(context.commandText))) return true
          const candidates = [context.targetPath, ...context.writeTargets, ...context.readTargets]
            .filter((value): value is string => typeof value === 'string')
          return candidates.some((candidate) => pathPatterns.some((re) => re.test(candidate)))
        },
        evidence: base.evidence,
      }
      assertActionRule(merged)
      byId.set(entry.id, merged)
      if (entry.priority !== undefined) priorities[entry.id] = entry.priority
      if (isLockedRule(merged)) locked.add(entry.id)
    }
    return lockViolation
  }

  private rebuild(layerList: readonly RuleConfig[]): RebuildOutput & { effectiveSnapshot: readonly ActionRule[]; statusSnapshot: RuleRegistryStatus } {
    const warnings: string[] = []
    const errors: string[] = []
    const layerRecords: RuleLayerRecord[] = []
    let startIndex = 0
    for (let index = layerList.length - 1; index >= 0; index -= 1) {
      if (layerList[index]?.inherit === false) { startIndex = index; break }
    }
    const strictMode = startIndex > 0 || (layerList.length > 0 && layerList[0]?.inherit === false)
    const table = this.buildTable(strictMode)
    let strictModeInfo: StrictModeInfo | null = null
    if (strictMode) {
      strictModeInfo = {
        activatedAt: Date.now(),
        layerIndex: startIndex,
        preservedHardRules: table.preserved.filter((rule) => isLockedRule(rule)).map((rule) => rule.id),
        preservedFallback: table.preserved.filter((rule) => rule.category === 'fallback').map((rule) => rule.id),
        discardedRuleCount: this.builtin.length - table.preserved.length,
      }
    }
    let fatal = false
    for (let layerIndex = startIndex; layerIndex < layerList.length; layerIndex += 1) {
      const layer = layerList[layerIndex]
      if (layer === undefined) continue
      const layerErrors: string[] = []
      const lockViolation = this.applyLayerToMap(layer, table, warnings, layerErrors)
      errors.push(...layerErrors)
      if (lockViolation) fatal = true
      if (layer.settings.failOnInvalidPattern && layerErrors.length > 0) fatal = true
      if (layer.settings.failOnUnknownRule && layerErrors.some((message) => message.startsWith('unknown rule id'))) fatal = true
      layerRecords.push({ index: layerIndex, inherit: layer.inherit, version: layer.version, rules: layer.rules.length, errors: layerErrors.length })
    }
    const sorted = this.sortTable(table.byId, table.priorities)
    if (!sorted.some((rule) => rule.category === 'fallback')) {
      warnings.push('fallback rule missing after rebuild')
      fatal = true
    }
    const source: 'builtin' | 'layered' | 'strict-replaced' = strictMode ? 'strict-replaced' : (layerList.length > 0 ? 'layered' : 'builtin')
    return {
      applied: !fatal,
      sorted,
      warnings,
      errors,
      source,
      strictMode: strictModeInfo,
      layerRecords,
      table,
      startIndex,
      effectiveSnapshot: this.effective,
      statusSnapshot: this.status,
    }
  }

  private commit(out: RebuildOutput): void {
    this.effective = [...out.sorted]
    this.status = {
      source: out.source,
      appliedAt: Date.now(),
      warnings: [...out.warnings],
      errors: [...out.errors],
      configVersion: this.layers.at(-1)?.version ?? null,
      layers: this.layers.length,
      strictMode: out.strictMode,
      ruleCount: this.effective.length,
    }
  }

  private toResult(out: RebuildOutput, revertedToLayerIndex?: number): ApplyResult {
    const base = {
      applied: out.applied,
      ruleCount: out.applied ? out.sorted.length : this.effective.length,
      warnings: out.warnings,
      errors: out.errors,
      source: out.source,
      strictMode: out.strictMode,
      layers: out.layerRecords,
    }
    return revertedToLayerIndex === undefined ? base : { ...base, revertedToLayerIndex }
  }
}
