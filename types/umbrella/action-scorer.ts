// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// ActionScorer（TS 参考实现）— 对应运行时 `src/lib/umbrella.mjs` 的 `baseLight` +
// `effectiveLight`。动作评分**不缓存**：args 的语义等价性不可判定
// （`git status` vs `git status > log.txt` 同一前缀不同副作用）。
//
// 规则表按危险度排序、先命中先返回；每条命中都带 `matchedRule`，供审计回答
// 「为什么这个动作被放行/被拦截」。与设计稿的两处刻意偏离：
//   1. `dsh-lifecycle` 先于 `destructive-command`（宿主动作要委托 restart-guard，
//      而不是变成"问用户"）；
//   2. 补了「缓冲区内写 → 蓝」「只读 shell → 蓝」两条设计稿没有的规则。

import { isWithin, normalizePath, resolvePath } from './paths.js'
import type {
  ActionAssessment,
  ActionEvidence,
  ActionMode,
  ActionPolicy,
  ActionPolicyInput,
  ActionScope,
  ActionTarget,
  BaseLightResult,
  Clock,
  DecisionOutcome,
  FloorTable,
  GradeBasis,
  GradeResolveInput,
  Light,
  PluginGrade,
} from './types.js'
import { LIGHT_RANK } from './types.js'

const DEFAULT_CLOCK: Clock = { now: () => Date.now() }

/** 内置凭据路径模式（正则可替换；默认值见 types/README.md）。 */
export const DEFAULT_CREDENTIAL_PATTERNS: readonly string[] = [
  String.raw`(^|[/\\])\.ssh([/\\]|$)`,
  String.raw`(^|[/\\])id_(rsa|ed25519|ecdsa|dsa)(\.|$)`,
  String.raw`(^|[/\\])\.aws([/\\](credentials|config))?`,
  String.raw`(^|[/\\])\.gnupg([/\\]|$)`,
  String.raw`(^|[/\\])\.netrc$`,
  String.raw`(^|[/\\])\.git-credentials$`,
  String.raw`(^|[/\\])\.kube([/\\]config)?`,
  String.raw`(^|[/\\])\.docker[/\\]config\.json$`,
  String.raw`(^|[/\\])config[/\\](SAM|SECURITY|SYSTEM)(\s|$)`,
  String.raw`(^|[/\\])Login Data$`,
]

/** 内置破坏性命令模式。 */
export const DEFAULT_DESTRUCTIVE_PATTERNS: readonly string[] = [
  String.raw`\brm\s+(-[a-z]*[rf][a-z]*\s+)+`,
  String.raw`\bRemove-Item\b.*-(Recurse|Force)`,
  String.raw`\bdel\s+/[fsq]`,
  String.raw`\brmdir\s+/s`,
  String.raw`\bmkfs(\.|\s)`,
  String.raw`\bdd\s+if=`,
  String.raw`\bchmod\s+777\b`,
  String.raw`\bchmod\s+-R\b`,
  String.raw`\bgit\s+push\b.*--force`,
  String.raw`\bgit\s+reset\s+--hard`,
  String.raw`\bgit\s+clean\s+-[a-z]*[dfx]`,
  String.raw`\bDROP\s+(TABLE|DATABASE)\b`,
  String.raw`\bformat\s+[a-z]:`,
  String.raw`\btaskkill\b`,
  String.raw`(^|[;&|]\s*)kill\s+(-[a-z]+\s+)*\d`,
  String.raw`\b(takeown|icacls)\b`,
  String.raw`\breg\s+delete\b`,
]

/** 内置 DSH 生命周期命令模式：命中即红，并在决策层委托 restart-guard。 */
export const DEFAULT_LIFECYCLE_PATTERNS: readonly string[] = [
  String.raw`\bdsh\b.*\b(restart|kill|stop|shutdown)\b`,
  String.raw`\btaskkill\b.*\/im\s+dsh`,
  String.raw`\bStop-Process\b`,
]

export const DEFAULT_LIFECYCLE_TOOLS: readonly string[] = ['restart', 'supervisor', 'kill-process', 'dsh-restart']

/** 只读 shell 前缀白名单（还必须不含写重定向才算只读）。 */
export const READ_ONLY_EXEC_PATTERNS: readonly string[] = [
  String.raw`^\s*(dir|ls|cat|type|head|tail|wc|pwd|where|which|echo|node\s+--version|node\s+-v)\b`,
  String.raw`^\s*Get-(Content|ChildItem|Item|Location|Command|Process)\b`,
  String.raw`^\s*git\s+(status|log|diff|show|branch|rev-parse)\b`,
  String.raw`^\s*npm\s+(ls|view)\b`,
]

/** 工具名 → 动作模式；未登记工具一律 'unknown'（→ 黄）。 */
export const TOOL_MODE: Readonly<Record<string, ActionMode>> = {
  read: 'read',
  grep: 'read',
  glob: 'read',
  ls: 'read',
  stat: 'read',
  list: 'read',
  write: 'write',
  edit: 'write',
  'multi-edit': 'write',
  append: 'write',
  patch: 'write',
  apply_patch: 'write',
  bash: 'exec',
  bash_pwsh: 'exec',
  pwsh: 'exec',
  powershell: 'exec',
  shell: 'exec',
  exec: 'exec',
  fetch: 'network',
  web_fetch: 'network',
  web_search: 'network',
  http: 'network',
  request: 'network',
  import: 'import',
  require: 'import',
  'dynamic-import': 'import',
}

const WRITE_REDIRECT_RE = /(^|[^>])>{1,2}(?!&)/

const REASON_TEXT: Readonly<Record<string, string>> = {
  'destructive-command': '命令命中破坏性模式（不可逆）',
  'dsh-lifecycle': 'DSH 生命周期动作，交给 restart-guard',
  'credential-access': '命中凭据路径，硬拒绝',
  'network-egress': '外连未在允许列表',
  'network-allowlisted': '外连命中允许列表',
  'dynamic-import': '动态加载未评分模块',
  'write-in-buffer': '写落在沙箱缓冲区内',
  'write-in-allowlist': '写命中允许列表',
  'write-production': '写落在生产区',
  'write-outside-buffer': '写越出沙箱',
  'exec-read-only': '只读 shell 命令（无重定向）',
  'exec-side-effect': 'shell 命令有副作用，不在只读白名单',
  'read-in-buffer': '沙箱内只读',
  'read-outside-buffer': '沙箱外只读',
  'unknown-tool': '未登记的工具，保守判黄',
}

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

function stringList(value: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(value)) return []
  return value.map((v) => String(v)).filter((v) => v.length > 0)
}

function toPatterns(value: readonly string[] | undefined, fallback: readonly string[]): readonly RegExp[] {
  // 显式空数组 = 「一条规则都不要」；只有缺省才回退内置值。
  const sources = value === undefined ? fallback : value
  const out: RegExp[] = []
  for (const source of sources) {
    try {
      out.push(new RegExp(String(source), 'i'))
    } catch {
      // 写错的正则不得让保护伞失效：跳过，并在文档里如实说明「无效模式被忽略」。
    }
  }
  return out
}

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  if (text.length === 0) return false
  for (const pattern of patterns) {
    // 每次匹配前重置 lastIndex，避免带 g/y 标志的调用方正则留下状态。
    pattern.lastIndex = 0
    if (pattern.test(text)) return true
  }
  return false
}

/** URL → { host, hostPort }；不依赖 URL 全局对象，坏 URL 返回 null。 */
export function hostOfUrl(url: string): { host: string; hostPort: string } | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)/i.exec(url.trim())
  if (match === null) return null
  const scheme = String(match[1]).toLowerCase()
  const authority = String(match[2])
  const hostPart = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority
  let host = hostPart
  let port = ''
  const colon = hostPart.lastIndexOf(':')
  if (colon > 0 && !hostPart.includes(']')) {
    host = hostPart.slice(0, colon)
    port = hostPart.slice(colon + 1)
  }
  if (host.length === 0) return null
  const defaultPort = scheme === 'https' ? '443' : scheme === 'http' ? '80' : ''
  const effectivePort = port.length > 0 ? port : defaultPort
  return {
    host: host.toLowerCase(),
    hostPort: effectivePort.length > 0 ? `${host.toLowerCase()}:${effectivePort}` : host.toLowerCase(),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 证据归一化
// ─────────────────────────────────────────────────────────────────────────────

export function modeOf(evidence: ActionEvidence): ActionMode {
  const explicit = String(evidence.mode ?? '').trim().toLowerCase()
  if (explicit.length > 0) {
    return explicit === 'read' || explicit === 'write' || explicit === 'exec' || explicit === 'network' || explicit === 'import'
      ? explicit
      : 'unknown'
  }
  const tool = String(evidence.tool ?? '').trim().toLowerCase()
  return TOOL_MODE[tool] ?? 'unknown'
}

export function scopeOf(evidence: ActionEvidence): ActionScope | null {
  const scope = evidence.scope ?? (evidence.args?.['scope'] as ActionScope | undefined)
  return scope === 'session' || scope === 'system' || scope === 'process' ? scope : null
}

function stringArg(args: Readonly<Record<string, unknown>> | undefined, keys: readonly string[]): string {
  if (args === undefined) return ''
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) return value
    if (Array.isArray(value) && value.length > 0) return value.map((v) => String(v)).join(' ')
  }
  return ''
}

/** 目标归一化：显式 target 优先，否则从 args 推导。 */
export function targetOf(evidence: ActionEvidence): ActionTarget {
  const declared = evidence.target
  const args = evidence.args
  const declaredValue = declared !== undefined && typeof declared.value === 'string' ? declared.value : ''
  const command = declaredValue.length > 0 ? declaredValue : stringArg(args, ['command', 'cmd', 'script', 'argv'])
  const url = stringArg(args, ['url', 'uri', 'href'])
  const path = declaredValue.length > 0 ? declaredValue : stringArg(args, ['path', 'file', 'filePath', 'target', 'cwd', 'dir'])
  const kind = declared?.kind
  if (kind === 'url' || (declaredValue.length === 0 && url.length > 0)) return { kind: 'url', value: url.length > 0 ? url : declaredValue }
  if (kind === 'command' || (declaredValue.length === 0 && command.length > 0)) {
    return { kind: 'command', value: command }
  }
  if (kind === 'pid') return { kind: 'pid', value: declaredValue.length > 0 ? declaredValue : String(args?.['pid'] ?? '') }
  if (kind === 'path' || path.length > 0) return { kind: 'path', value: path }
  if (declaredValue.length > 0) return { kind: kind ?? 'path', value: declaredValue }
  return { kind: 'none', value: '' }
}

/** 命令文本：优先 target.kind === 'command'，其次 args.command。 */
export function commandTextOf(evidence: ActionEvidence): string {
  const target = targetOf(evidence)
  if (target.kind === 'command') return target.value
  return stringArg(evidence.args, ['command', 'cmd', 'script'])
}

/** 把证据里的路径目标解析成绝对路径（相对路径按 policy.root）。 */
export function evidencePathOf(evidence: ActionEvidence, policy: ActionPolicy): string | null {
  const target = targetOf(evidence)
  if (target.kind !== 'path') return null
  return resolvePath(target.value, policy.root, policy.caseInsensitive)
}

// ─────────────────────────────────────────────────────────────────────────────
// 策略归一化
// ─────────────────────────────────────────────────────────────────────────────

export function normalizePolicy(input: ActionPolicyInput = {}, caseInsensitive = false): ActionPolicy {
  const root = normalizePath(input.root ?? '.', caseInsensitive)
  const allowPaths: string[] = []
  for (const raw of input.allowPaths ?? []) {
    const resolved = resolvePath(String(raw), root, caseInsensitive)
    if (resolved !== null) allowPaths.push(resolved)
  }
  return {
    root,
    bufferRoot: input.bufferRoot === undefined || input.bufferRoot === null ? null : resolvePath(input.bufferRoot, root, caseInsensitive),
    productionRoot: input.productionRoot === undefined || input.productionRoot === null
      ? null
      : resolvePath(input.productionRoot, root, caseInsensitive),
    allowPaths,
    networkAllowlist: stringList(input.networkAllowlist),
    credentialPatterns: toPatterns(input.credentialPatterns, DEFAULT_CREDENTIAL_PATTERNS),
    destructivePatterns: toPatterns(input.destructivePatterns, DEFAULT_DESTRUCTIVE_PATTERNS),
    lifecyclePatterns: toPatterns(input.lifecyclePatterns, DEFAULT_LIFECYCLE_PATTERNS),
    lifecycleTools: input.lifecycleTools === undefined ? [...DEFAULT_LIFECYCLE_TOOLS] : stringList(input.lifecycleTools),
    readOnlyExecPatterns: toPatterns(input.readOnlyExecPatterns, READ_ONLY_EXEC_PATTERNS),
    caseInsensitive,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 15 条基础规则
// ─────────────────────────────────────────────────────────────────────────────

export function isDestructiveCommand(evidence: ActionEvidence, policy: ActionPolicy): boolean {
  const mode = modeOf(evidence)
  if (mode !== 'exec' && mode !== 'unknown') return false
  return matchesAny(policy.destructivePatterns, commandTextOf(evidence))
}

export function isDshLifecycleAction(evidence: ActionEvidence, policy: ActionPolicy): boolean {
  const scope = scopeOf(evidence)
  if (scope === 'system' || scope === 'process') return true
  const tool = String(evidence.tool ?? '').trim().toLowerCase()
  if (policy.lifecycleTools.some((name) => name.toLowerCase() === tool)) return true
  return matchesAny(policy.lifecyclePatterns, commandTextOf(evidence))
}

export function isCredentialAccess(evidence: ActionEvidence, policy: ActionPolicy): boolean {
  const target = targetOf(evidence)
  const text = [target.value, commandTextOf(evidence), stringArg(evidence.args, ['path'])]
    .filter((part) => part.length > 0)
    .join('\n')
  return matchesAny(policy.credentialPatterns, text)
}

export function isNetworkEgress(evidence: ActionEvidence): boolean {
  if (modeOf(evidence) === 'network') return true
  return targetOf(evidence).kind === 'url'
}

export function isDynamicImport(evidence: ActionEvidence): boolean {
  return modeOf(evidence) === 'import'
}

export function isReadOnly(evidence: ActionEvidence): boolean {
  return modeOf(evidence) === 'read'
}

export function networkAllowed(url: string, policy: ActionPolicy): boolean {
  const parsed = hostOfUrl(url)
  if (parsed === null) return false
  const raw = url.trim().toLowerCase()
  for (const entryRaw of policy.networkAllowlist) {
    const entry = entryRaw.trim().toLowerCase()
    if (entry.length === 0) continue
    if (entry === parsed.host || entry === parsed.hostPort) return true
    if (entry.startsWith('*.') && parsed.host.endsWith(entry.slice(1))) return true
    if (raw.startsWith(entry)) return true
  }
  return false
}

function execLooksReadOnly(evidence: ActionEvidence, policy: ActionPolicy): boolean {
  const text = commandTextOf(evidence)
  if (text.length === 0) return false
  if (WRITE_REDIRECT_RE.test(text)) return false
  return matchesAny(policy.readOnlyExecPatterns, text)
}

function inAllowList(absPath: string | null, policy: ActionPolicy): boolean {
  if (absPath === null) return false
  return policy.allowPaths.some((prefix) => isWithin(absPath, prefix, policy.caseInsensitive))
}

function makeResult(
  light: Light,
  matchedRule: string,
  extra: { readonly target: ActionTarget; readonly lifecycle?: boolean; readonly credential?: boolean; readonly path?: string | null },
): BaseLightResult {
  return {
    light,
    matchedRule,
    lifecycle: extra.lifecycle === true,
    credential: extra.credential === true,
    target: extra.target,
    path: extra.path ?? null,
    reason: REASON_TEXT[matchedRule] ?? matchedRule,
  }
}

/** 基础灯色：只看动作本身，不看插件等级。 */
export function baseLight(evidence: ActionEvidence, policy: ActionPolicy): BaseLightResult {
  const mode = modeOf(evidence)
  const target = targetOf(evidence)

  // 1) DSH 生命周期（先判：宿主动作走 restart-guard 的委托路径）
  if (isDshLifecycleAction(evidence, policy)) {
    return makeResult('red', 'dsh-lifecycle', { target, lifecycle: true })
  }
  // 2) 破坏性命令
  if (isDestructiveCommand(evidence, policy)) {
    return makeResult('red', 'destructive-command', { target })
  }
  // 3) 凭据访问：唯一硬拒绝的红灯
  if (isCredentialAccess(evidence, policy)) {
    return makeResult('red', 'credential-access', { target, credential: true })
  }
  // 4) 外连
  if (isNetworkEgress(evidence)) {
    return networkAllowed(target.value, policy)
      ? makeResult('blue', 'network-allowlisted', { target })
      : makeResult('yellow', 'network-egress', { target })
  }
  // 5) 动态加载未评分模块
  if (isDynamicImport(evidence)) {
    return makeResult('yellow', 'dynamic-import', { target })
  }
  // 6) 写：缓冲区内 / 允许列表内 → 蓝；生产区 / 越界 → 黄
  if (mode === 'write') {
    const abs = evidencePathOf(evidence, policy)
    if (policy.bufferRoot !== null && abs !== null && isWithin(abs, policy.bufferRoot, policy.caseInsensitive)) {
      return makeResult('blue', 'write-in-buffer', { target, path: abs })
    }
    if (inAllowList(abs, policy)) return makeResult('blue', 'write-in-allowlist', { target, path: abs })
    if (policy.productionRoot !== null && abs !== null && isWithin(abs, policy.productionRoot, policy.caseInsensitive)) {
      return makeResult('yellow', 'write-production', { target, path: abs })
    }
    return makeResult('yellow', 'write-outside-buffer', { target, path: abs })
  }
  // 7) shell：只读白名单 → 蓝；有副作用但落在缓冲区 → 蓝；其余 → 黄
  if (mode === 'exec') {
    if (execLooksReadOnly(evidence, policy)) return makeResult('blue', 'exec-read-only', { target })
    const abs = evidencePathOf(evidence, policy)
    if (policy.bufferRoot !== null && abs !== null && isWithin(abs, policy.bufferRoot, policy.caseInsensitive)) {
      return makeResult('blue', 'write-in-buffer', { target, path: abs })
    }
    return makeResult('yellow', 'exec-side-effect', { target, path: abs })
  }
  // 8) 只读
  if (isReadOnly(evidence)) {
    const abs = evidencePathOf(evidence, policy)
    if (policy.bufferRoot !== null && abs !== null && isWithin(abs, policy.bufferRoot, policy.caseInsensitive)) {
      return makeResult('green', 'read-in-buffer', { target, path: abs })
    }
    return makeResult('blue', 'read-outside-buffer', { target, path: abs })
  }
  // 9) 兜底：不认识的工具 = 行为不可预测 → 黄
  return makeResult('yellow', 'unknown-tool', { target })
}

// ─────────────────────────────────────────────────────────────────────────────
// 等级下限与决策矩阵
// ─────────────────────────────────────────────────────────────────────────────

export function rankOf(light: Light): number {
  return LIGHT_RANK[light]
}

export function maxLight(a: Light, b: Light): Light {
  return rankOf(a) >= rankOf(b) ? a : b
}

export function gradeFloorOf(grade: PluginGrade, table: FloorTable): Light {
  return table[grade]
}

export function effectiveLightOf(
  base: Light,
  grade: PluginGrade,
  table: FloorTable,
): { readonly light: Light; readonly baseLight: Light; readonly gradeFloor: Light; readonly pluginGrade: PluginGrade; readonly raised: boolean } {
  const floor = gradeFloorOf(grade, table)
  const light = maxLight(base, floor)
  return { light, baseLight: base, gradeFloor: floor, pluginGrade: grade, raised: rankOf(light) > rankOf(base) }
}

/** 灯色 + 动作类别 → 决策。纯函数，不读策略、不碰 IO。 */
export function decide(assessment: ActionAssessment): DecisionOutcome {
  const light = assessment.light
  const lifecycle = assessment.lifecycle || assessment.matchedRule === 'dsh-lifecycle'
  const credential = assessment.credential || assessment.matchedRule === 'credential-access'

  if (light === 'green') return { decision: 'allow', severity: 'normal', reason: 'green-light' }
  if (light === 'blue') return { decision: 'mark', severity: 'normal', reason: 'blue-light', elevated: true }
  if (light === 'yellow') {
    if (lifecycle) {
      return {
        decision: 'delegate',
        severity: 'normal',
        reason: 'lifecycle-yellow',
        originLight: 'yellow',
        target: 'restartGuard',
      }
    }
    return { decision: 'ask', severity: 'normal', reason: 'yellow-light' }
  }
  if (credential) return { decision: 'deny', severity: 'critical', reason: 'credential-access' }
  if (lifecycle) {
    return {
      decision: 'delegate',
      severity: 'critical',
      reason: 'lifecycle-red',
      originLight: 'red',
      target: 'restartGuard',
    }
  }
  return { decision: 'ask', severity: 'critical', reason: 'red-light' }
}

export interface AssessOptions extends GradeResolveInput {
  readonly cachedGrade?: PluginGrade | null
}

export interface ActionScorerOptions {
  /** 策略可以是函数：buffer-keeper 的 root 是 start({dir}) 之后才知道的。 */
  readonly policy: ActionPolicyInput | (() => ActionPolicyInput)
  readonly floors: FloorTable
  readonly caseInsensitive?: boolean
  readonly clock?: Clock
}

export class ActionScorer {
  private readonly policySource: () => ActionPolicyInput
  private readonly floors: FloorTable
  private readonly caseInsensitive: boolean
  private readonly clock: Clock
  private policyCache: { readonly stamp: string; readonly policy: ActionPolicy } | null = null

  constructor(options: ActionScorerOptions) {
    this.policySource = typeof options.policy === 'function' ? options.policy : () => options.policy as ActionPolicyInput
    this.floors = options.floors
    this.caseInsensitive = options.caseInsensitive ?? false
    this.clock = options.clock ?? DEFAULT_CLOCK
  }

  /** 当前归一化策略（按 JSON 指纹记忆，不每次重编译正则）。 */
  get policy(): ActionPolicy {
    const raw = this.policySource() ?? {}
    const stamp = JSON.stringify(raw)
    if (this.policyCache !== null && this.policyCache.stamp === stamp) return this.policyCache.policy
    const policy = normalizePolicy(raw, this.caseInsensitive)
    this.policyCache = { stamp, policy }
    return policy
  }

  baseLight(evidence: ActionEvidence): BaseLightResult {
    return baseLight(evidence, this.policy)
  }

  gradeFloor(grade: PluginGrade): Light {
    return gradeFloorOf(grade, this.floors)
  }

  effectiveLight(base: Light, grade: PluginGrade): ReturnType<typeof effectiveLightOf> {
    return effectiveLightOf(base, grade, this.floors)
  }

  /** 动作评分：基础灯色 + 等级下限（只抬不降）。每次调用都重算。 */
  assess(evidence: ActionEvidence, options: AssessOptions = {}): ActionAssessment {
    const started = this.clock.now()
    const base = baseLight(evidence, this.policy)
    const resolved = this.resolveGrade(evidence, options)
    const effective = effectiveLightOf(base.light, resolved.grade, this.floors)
    return {
      light: effective.light,
      baseLight: effective.baseLight,
      gradeFloor: effective.gradeFloor,
      raised: effective.raised,
      pluginGrade: effective.pluginGrade,
      gradeBasis: resolved.basis,
      matchedRule: base.matchedRule,
      lifecycle: base.lifecycle,
      credential: base.credential,
      reason: base.reason,
      tool: String(evidence.tool ?? ''),
      target: base.target,
      path: base.path,
      durationMs: Math.max(0, this.clock.now() - started),
      fromCache: false,
    }
  }

  private resolveGrade(evidence: ActionEvidence, options: AssessOptions): { readonly grade: PluginGrade; readonly basis: GradeBasis } {
    if (options.grade !== undefined) return { grade: options.grade, basis: 'explicit-grade' }
    if (options.assessment !== undefined) return { grade: options.assessment.grade, basis: 'assessment' }
    if (evidence.pluginGrade !== undefined) return { grade: evidence.pluginGrade, basis: 'evidence' }
    if (options.cachedGrade !== undefined && options.cachedGrade !== null) {
      return { grade: options.cachedGrade, basis: 'cached-plugin-grade' }
    }
    // 未评分：失败往坏里判
    return { grade: 'E', basis: 'unscored-fail-closed' }
  }
}
