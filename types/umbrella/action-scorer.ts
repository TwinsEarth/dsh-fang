// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// ActionScorer（TS 参考实现）— 与运行时 `src/lib/umbrella.mjs` 的声明式动作规则表一一对应。
//
// v2.7.8 起规则表从「硬编码 if 链」改为**声明式规则对象**：
//   { id, category, light, reason, tags, match(evidence, context), evidence(evidence, context) }
// 数组顺序即优先级，**首个命中胜出**（不是取最高灯色）：灯色是排他性的，
// 且凭据访问必须无条件压过「沙箱内只读」的绿规则。
//
// 每条规则都可独立喂证据、独立断言证据形状；证据进审计回答「为什么是这个灯色」。
// 动作评分**不缓存**：args 的语义等价性不可判定。
//
// 与 .mjs 的组织差异：TS 侧把证据归一化 / 上下文 / 规则表 / 评分器放在同一个模块，
// 避免 action-rules ↔ action-evidence 的循环 import；语义与 .mjs 完全一致。

import { isWithin, normalizePath, resolvePath } from './paths.js'
import type {
  ActionAssessment,
  ActionCategory,
  ActionContext,
  ActionEvidence,
  ActionMode,
  ActionPolicy,
  ActionPolicyInput,
  ActionRule,
  ActionRuleSet,
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
  RuleEvidence,
  RulePlacement,
} from './types.js'
import { LIGHT_RANK } from './types.js'

const DEFAULT_CLOCK: Clock = { now: () => Date.now() }

/** 内置凭据路径模式（可替换；传空数组 = 一条规则都不要）。 */
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
  String.raw`(^|[/\\])\.config[/\\]gcloud`,
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

/** 内置 DSH 生命周期命令模式。 */
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

/** 规则类别（与 .mjs 的 ACTION_CATEGORIES 一致）。 */
export const ACTION_CATEGORIES: readonly ActionCategory[] = [
  'lifecycle', 'destructive', 'credential', 'network', 'import', 'write', 'exec', 'read', 'fallback',
]

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
      // 写错的正则不得让保护伞失效：跳过（文档里写明「无效模式被忽略」）。
    }
  }
  return out
}

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  if (text.length === 0) return false
  for (const pattern of patterns) {
    pattern.lastIndex = 0
    if (pattern.test(text)) return true
  }
  return false
}

/** 命中的第一条模式源码（证据用），没有则 null。 */
export function firstPatternSource(patterns: readonly RegExp[], text: string): string | null {
  if (text.length === 0) return null
  for (const pattern of patterns) {
    pattern.lastIndex = 0
    if (pattern.test(text)) return pattern.source
  }
  return null
}

/** URL → { raw, host, hostPort }；不依赖 URL 全局对象，坏 URL 返回 null。 */
export function parseUrlParts(raw: unknown): { raw: string; host: string; hostPort: string } | null {
  const text = String(raw ?? '').trim()
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)/i.exec(text)
  if (match === null) return null
  const scheme = String(match[1]).toLowerCase()
  const authority = String(match[2])
  const hostPart = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority
  let host = hostPart
  let port = ''
  const colon = hostPart.lastIndexOf(':')
  if (colon > 0) {
    host = hostPart.slice(0, colon)
    port = hostPart.slice(colon + 1)
  }
  if (host.length === 0) return null
  const defaultPort = scheme === 'https' ? '443' : scheme === 'http' ? '80' : ''
  const effectivePort = port.length > 0 ? port : defaultPort
  return {
    raw: text,
    host: host.toLowerCase(),
    hostPort: effectivePort.length > 0 ? `${host.toLowerCase()}:${effectivePort}` : host.toLowerCase(),
  }
}

/** 旧名字保留（v2.7.7 的公共出口）。 */
export function hostOfUrl(url: string): { host: string; hostPort: string } | null {
  const parsed = parseUrlParts(url)
  return parsed === null ? null : { host: parsed.host, hostPort: parsed.hostPort }
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
  const raw = evidence.scope ?? (evidence.args?.['scope'] as ActionScope | undefined)
  const scope = String(raw ?? '').trim().toLowerCase()
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
  if (kind === 'command' || (declaredValue.length === 0 && command.length > 0)) return { kind: 'command', value: command }
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

function resolveMaybePath(value: string, policy: ActionPolicy): string | null {
  return resolvePath(value, policy.root, policy.caseInsensitive)
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
// 谓词（每条规则可单独复用/测试）
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
  const parsed = parseUrlParts(url)
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

export function execLooksReadOnly(evidence: ActionEvidence, policy: ActionPolicy): boolean {
  const text = commandTextOf(evidence)
  if (text.length === 0) return false
  if (WRITE_REDIRECT_RE.test(text)) return false
  return matchesAny(policy.readOnlyExecPatterns, text)
}

function inAllowList(absPath: string | null, policy: ActionPolicy): boolean {
  if (absPath === null) return false
  return policy.allowPaths.some((prefix) => isWithin(absPath, prefix, policy.caseInsensitive))
}

// ─────────────────────────────────────────────────────────────────────────────
// 规则上下文：命令 / 重定向 / 路径 / URL / PID 一次解析
// ─────────────────────────────────────────────────────────────────────────────

const WRITE_REDIRECT_CAPTURE_RE = /(?:^|[^>])>{1,2}\s*([^\s|;&<>]+)/g
const TEE_CAPTURE_RE = /\btee\b(?:\s+-a)?\s+([^\s|;&<>]+)/gi
const DD_CAPTURE_RE = /\bdd\b[^\n]*?\bof=([^\s]+)/gi
const PS_WRITE_CAPTURE_RE = /\b(?:Set-Content|Out-File)\b(?:\s+-(?:Path|FilePath))?\s+([^\s|;&<>]+)/gi
const READ_CMD_CAPTURE_RE = /(?:^|[|;&]\s*)(?:cat|less|head|tail|more|Get-Content|type)\s+([^\s|;&<>]+)/gi

/** 动态构造（$VAR / $(...) / 通配）的路径不静态解析：交给兜底规则判黄。 */
function isStaticToken(token: string): boolean {
  return token.length > 0 && token !== '&' && !/[$`*?]/.test(token)
}

/** 保守解析 shell 的写/读目标：只取字面量。 */
export function parseShellRedirects(
  commandText: string,
  policy: ActionPolicy,
): { writeTargets: readonly string[]; readTargets: readonly string[] } {
  const text = String(commandText ?? '')
  const writeTargets: string[] = []
  const readTargets: string[] = []
  if (text.length === 0) return { writeTargets, readTargets }
  const push = (list: string[], raw: string | undefined): void => {
    if (raw === undefined || !isStaticToken(raw)) return
    const abs = resolveMaybePath(raw, policy)
    if (abs !== null && !list.includes(abs)) list.push(abs)
  }
  for (const re of [WRITE_REDIRECT_CAPTURE_RE, TEE_CAPTURE_RE, DD_CAPTURE_RE, PS_WRITE_CAPTURE_RE]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) push(writeTargets, m[1])
  }
  READ_CMD_CAPTURE_RE.lastIndex = 0
  let r: RegExpExecArray | null
  while ((r = READ_CMD_CAPTURE_RE.exec(text)) !== null) push(readTargets, r[1])
  return { writeTargets, readTargets }
}

export function buildActionContext(evidence: ActionEvidence, policy: ActionPolicy): ActionContext {
  const mode = modeOf(evidence)
  const target = targetOf(evidence)
  const commandText = target.kind === 'command' ? target.value : stringArg(evidence.args, ['command', 'cmd', 'script'])
  const redirects = parseShellRedirects(commandText, policy)
  const targetPath = target.kind === 'path' ? resolveMaybePath(target.value, policy) : null
  const url = target.kind === 'url' ? parseUrlParts(target.value) : null
  const pid = target.kind === 'pid' ? Number(target.value) : null
  return {
    mode,
    target,
    commandText,
    targetPath,
    url,
    targetPid: pid !== null && Number.isFinite(pid) ? pid : null,
    writeTargets: redirects.writeTargets,
    readTargets: redirects.readTargets,
    policy,
  }
}

function writeTargetsOf(context: ActionContext): string[] {
  const out: string[] = []
  if (context.mode === 'write' && context.targetPath !== null) out.push(context.targetPath)
  for (const t of context.writeTargets) if (!out.includes(t)) out.push(t)
  return out
}

function readTargetsOf(context: ActionContext): string[] {
  const out: string[] = []
  if (context.mode === 'read' && context.targetPath !== null) out.push(context.targetPath)
  for (const t of context.readTargets) if (!out.includes(t)) out.push(t)
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 声明式规则表（与 .mjs 的 DEFAULT_ACTION_RULES 一一对应）
// ─────────────────────────────────────────────────────────────────────────────

const BUILTIN_RULES: ActionRule[] = [
  {
    id: 'dsh-lifecycle',
    category: 'lifecycle',
    light: 'red',
    reason: 'DSH 生命周期动作，交给 restart-guard',
    tags: ['hard-deny', 'delegate-to-restart-guard'],
    match: (evidence, context) => isDshLifecycleAction(evidence, context.policy),
    evidence: (evidence, context) => {
      const scope = scopeOf(evidence)
      const tool = String(evidence.tool ?? '').trim().toLowerCase()
      const lifecycleTools = context.policy.lifecycleTools.map((v) => v.toLowerCase())
      let matchedPattern = 'unknown'
      if (scope === 'system' || scope === 'process') matchedPattern = `scope:${scope}`
      else if (lifecycleTools.includes(tool)) matchedPattern = `tool:${tool}`
      else {
        const hit = firstPatternSource(context.policy.lifecyclePatterns, context.commandText)
        matchedPattern = hit === null ? 'pattern' : `pattern:${hit}`
      }
      return { matchedPattern, tool: String(evidence.tool ?? ''), targetPid: context.targetPid, commandSnippet: context.commandText.slice(0, 200) }
    },
  },
  {
    id: 'destructive-command',
    category: 'destructive',
    light: 'red',
    reason: '命令命中破坏性模式（不可逆）',
    tags: ['hard-deny'],
    match: (evidence, context) => isDestructiveCommand(evidence, context.policy),
    evidence: (_evidence, context) => {
      const hit = firstPatternSource(context.policy.destructivePatterns, context.commandText)
      return { matchedPattern: hit === null ? 'unknown' : `pattern:${hit}`, commandSnippet: context.commandText.slice(0, 200) }
    },
  },
  {
    id: 'credential-access',
    category: 'credential',
    light: 'red',
    reason: '命中凭据路径，硬拒绝',
    tags: ['hard-deny'],
    match: (evidence, context) => isCredentialAccess(evidence, context.policy),
    evidence: (evidence, context) => {
      const candidates: string[] = []
      if (context.targetPath !== null) candidates.push(context.targetPath)
      for (const p of [...context.readTargets, ...context.writeTargets]) candidates.push(p)
      const text = [context.target.value, context.commandText, stringArg(evidence.args, ['path'])]
        .filter((part) => part.length > 0)
        .join('\n')
      const hit = firstPatternSource(context.policy.credentialPatterns, text)
      const matchedPaths = candidates.filter((p) => firstPatternSource(context.policy.credentialPatterns, p) !== null)
      return { matchedPattern: hit === null ? 'unknown' : `pattern:${hit}`, paths: matchedPaths, target: context.target }
    },
  },
  {
    id: 'network-allowlisted',
    category: 'network',
    light: 'blue',
    reason: '外连命中允许列表',
    tags: ['allow-with-audit'],
    match: (evidence, context) => isNetworkEgress(evidence) && networkAllowed(context.target.value, context.policy),
    evidence: (_evidence, context) => ({
      matchedPattern: 'allowlisted-host',
      url: context.url?.raw ?? context.target.value,
      host: context.url?.host ?? null,
      allowlist: context.policy.networkAllowlist,
    }),
  },
  {
    id: 'network-egress',
    category: 'network',
    light: 'yellow',
    reason: '外连未在允许列表',
    tags: ['needs-approval'],
    match: (evidence, context) => isNetworkEgress(evidence) && !networkAllowed(context.target.value, context.policy),
    evidence: (_evidence, context) => ({
      matchedPattern: context.url === null ? 'unparsable-url' : 'non-allowlisted-host',
      url: context.target.value,
      host: context.url?.host ?? null,
      allowlist: context.policy.networkAllowlist,
    }),
  },
  {
    id: 'dynamic-import',
    category: 'import',
    light: 'yellow',
    reason: '动态加载未评分模块',
    tags: ['needs-approval'],
    match: (evidence) => isDynamicImport(evidence),
    evidence: (evidence, context) => ({
      matchedPattern: 'import-tool',
      tool: String(evidence.tool ?? ''),
      specifier: String(evidence.args?.['specifier'] ?? evidence.args?.['module'] ?? context.target.value ?? ''),
    }),
  },
  {
    id: 'write-in-buffer',
    category: 'write',
    light: 'blue',
    reason: '写落在沙箱缓冲区内',
    tags: ['allow-with-audit'],
    match: (_evidence, context) => {
      if (context.mode !== 'write' && context.mode !== 'exec') return false
      const root = context.policy.bufferRoot
      if (root === null) return false
      const targets = writeTargetsOf(context)
      return targets.length > 0 && targets.every((t) => isWithin(t, root, context.policy.caseInsensitive))
    },
    evidence: (_evidence, context) => ({ matchedPattern: 'in-buffer', targets: writeTargetsOf(context), bufferRoot: context.policy.bufferRoot }),
  },
  {
    id: 'write-in-allowlist',
    category: 'write',
    light: 'blue',
    reason: '写命中允许列表',
    tags: ['allow-with-audit'],
    match: (_evidence, context) => {
      if (context.mode !== 'write') return false
      const targets = writeTargetsOf(context)
      return targets.length > 0 && targets.every((t) => inAllowList(t, context.policy))
    },
    evidence: (_evidence, context) => ({ matchedPattern: 'in-allowlist', targets: writeTargetsOf(context), allowPaths: context.policy.allowPaths }),
  },
  {
    id: 'write-production',
    category: 'write',
    light: 'yellow',
    reason: '写落在生产区',
    tags: ['needs-approval'],
    match: (_evidence, context) => {
      if (context.mode !== 'write') return false
      const root = context.policy.productionRoot
      if (root === null) return false
      const targets = writeTargetsOf(context)
      return targets.length > 0 && targets.every((t) => isWithin(t, root, context.policy.caseInsensitive))
    },
    evidence: (_evidence, context) => ({ matchedPattern: 'production-root', targets: writeTargetsOf(context), productionRoot: context.policy.productionRoot }),
  },
  {
    id: 'write-outside-buffer',
    category: 'write',
    light: 'yellow',
    reason: '写越出沙箱',
    tags: ['needs-approval'],
    match: (_evidence, context) => {
      if (context.mode !== 'write') return false
      const targets = writeTargetsOf(context)
      if (targets.length === 0) return true
      return targets.some((t) => !isWithin(t, context.policy.bufferRoot, context.policy.caseInsensitive) && !inAllowList(t, context.policy))
    },
    evidence: (_evidence, context) => ({
      matchedPattern: 'outside-buffer-and-allowlist',
      targets: writeTargetsOf(context),
      bufferRoot: context.policy.bufferRoot,
      allowPaths: context.policy.allowPaths,
    }),
  },
  {
    id: 'exec-read-only',
    category: 'exec',
    light: 'blue',
    reason: '只读 shell 命令（无重定向）',
    tags: ['allow-with-audit'],
    match: (evidence, context) => context.mode === 'exec' && execLooksReadOnly(evidence, context.policy),
    evidence: (_evidence, context) => ({ matchedPattern: 'read-only-prefix', commandSnippet: context.commandText.slice(0, 200) }),
  },
  {
    id: 'exec-side-effect',
    category: 'exec',
    light: 'yellow',
    reason: 'shell 命令有副作用，不在只读白名单',
    tags: ['needs-approval'],
    match: (_evidence, context) => context.mode === 'exec',
    evidence: (_evidence, context) => ({ matchedPattern: 'side-effect', commandSnippet: context.commandText.slice(0, 200), writeTargets: context.writeTargets }),
  },
  {
    id: 'read-in-buffer',
    category: 'read',
    light: 'green',
    reason: '沙箱内只读',
    tags: ['auto-allow'],
    match: (_evidence, context) => {
      if (context.mode !== 'read') return false
      const root = context.policy.bufferRoot
      if (root === null) return false
      const targets = readTargetsOf(context)
      return targets.length > 0 && targets.every((t) => isWithin(t, root, context.policy.caseInsensitive))
    },
    evidence: (_evidence, context) => ({ matchedPattern: 'in-buffer', targets: readTargetsOf(context), bufferRoot: context.policy.bufferRoot }),
  },
  {
    id: 'read-outside-buffer',
    category: 'read',
    light: 'blue',
    reason: '沙箱外只读',
    tags: ['allow-with-audit'],
    match: (_evidence, context) => context.mode === 'read',
    evidence: (_evidence, context) => ({ matchedPattern: 'outside-buffer', targets: readTargetsOf(context), bufferRoot: context.policy.bufferRoot }),
  },
  {
    id: 'unknown-tool',
    category: 'fallback',
    light: 'yellow',
    reason: '未登记的工具，保守判黄',
    tags: ['conservative'],
    match: () => true,
    evidence: (evidence, context) => ({ matchedPattern: 'fallback', tool: String(evidence.tool ?? ''), mode: context.mode, hasTarget: context.target.kind !== 'none' }),
  },
]

/** 规则形状校验：注册时立刻失败，而不是在评分路径上静默漏判。 */
export function assertActionRule(rule: ActionRule): ActionRule {
  if (rule === null || typeof rule !== 'object') throw new TypeError('action rule must be an object')
  if (typeof rule.id !== 'string' || rule.id.length === 0) throw new TypeError('action rule.id must be a non-empty string')
  if (!ACTION_CATEGORIES.includes(rule.category)) throw new TypeError(`action rule ${rule.id}: unknown category ${String(rule.category)}`)
  if (!Object.prototype.hasOwnProperty.call(LIGHT_RANK, rule.light)) throw new TypeError(`action rule ${rule.id}: unknown light ${String(rule.light)}`)
  if (typeof rule.match !== 'function') throw new TypeError(`action rule ${rule.id}: match() is required`)
  if (typeof rule.evidence !== 'function') throw new TypeError(`action rule ${rule.id}: evidence() is required`)
  return rule
}

/**
 * 可注册/可覆盖的规则集。注册必须显式给出 before/after：
 * 追加到表尾等于永不命中（前面有兜底规则），所以位置是规则语义的一部分。
 */
export function createActionRuleSet(initial: readonly ActionRule[] = DEFAULT_ACTION_RULES): ActionRuleSet {
  const rules: ActionRule[] = (initial ?? []).map((rule) => assertActionRule(rule))
  const findIndex = (id: string): number => rules.findIndex((r) => r.id === id)

  function register(rule: ActionRule, placement: RulePlacement): ActionRule {
    assertActionRule(rule)
    if (findIndex(rule.id) >= 0) throw new Error(`action rule already registered: ${rule.id}（覆盖请用 override()）`)
    const before = placement.before === undefined ? -1 : findIndex(placement.before)
    const after = placement.after === undefined ? -1 : findIndex(placement.after)
    if (before >= 0) rules.splice(before, 0, rule)
    else if (after >= 0) rules.splice(after + 1, 0, rule)
    else throw new Error(`action rule ${rule.id}: register() requires before/after naming an existing rule`)
    return rule
  }

  function override(id: string, patch: Partial<Omit<ActionRule, 'id'>>): ActionRule {
    const index = findIndex(id)
    const current = index < 0 ? undefined : rules[index]
    if (current === undefined) throw new Error(`action rule not found: ${id}`)
    const merged = assertActionRule({ ...current, ...patch, id } as ActionRule)
    rules[index] = merged
    return merged
  }

  function remove(id: string): boolean {
    const index = findIndex(id)
    if (index < 0) return false
    rules.splice(index, 1)
    return true
  }

  function reset(): void {
    rules.length = 0
    for (const rule of DEFAULT_ACTION_RULES) rules.push(rule)
  }

  return {
    rules,
    ids: () => rules.map((r) => r.id),
    register,
    override,
    remove,
    reset,
    find(evidence: ActionEvidence, context: ActionContext): ActionRule | null {
      return rules.find((rule) => rule.match(evidence, context)) ?? rules[rules.length - 1] ?? null
    },
  }
}

export const DEFAULT_ACTION_RULES: readonly ActionRule[] = Object.freeze(BUILTIN_RULES)
const DEFAULT_RULE_SET: ActionRuleSet = createActionRuleSet(DEFAULT_ACTION_RULES)

/** 基础灯色：首个命中胜出；返回值带 matchedRule / category / tags / 结构化证据。 */
export function baseLight(evidence: ActionEvidence, policy: ActionPolicy, ruleSet: ActionRuleSet = DEFAULT_RULE_SET): BaseLightResult {
  const context = buildActionContext(evidence, policy)
  const found = ruleSet.find(evidence, context)
  const fallbackRule = DEFAULT_ACTION_RULES[DEFAULT_ACTION_RULES.length - 1] as ActionRule
  const matched = found ?? fallbackRule
  const detail: RuleEvidence = matched.evidence(evidence, context) ?? {}
  const firstTarget = Array.isArray(detail.targets) && typeof detail.targets[0] === 'string' ? detail.targets[0] : null
  return {
    light: matched.light,
    matchedRule: matched.id,
    category: matched.category,
    tags: [...matched.tags],
    lifecycle: matched.id === 'dsh-lifecycle',
    credential: matched.id === 'credential-access',
    target: context.target,
    path: context.targetPath ?? firstTarget,
    reason: matched.reason,
    evidence: detail,
  }
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
  /** 规则表：数组或 createActionRuleSet() 的实例；缺省用 DEFAULT_ACTION_RULES。 */
  readonly rules?: readonly ActionRule[] | ActionRuleSet
}

export class ActionScorer {
  private readonly policySource: () => ActionPolicyInput
  private readonly floors: FloorTable
  private readonly caseInsensitive: boolean
  private readonly clock: Clock
  private readonly ruleSet: ActionRuleSet
  private policyCache: { readonly stamp: string; readonly policy: ActionPolicy } | null = null

  constructor(options: ActionScorerOptions) {
    this.policySource = typeof options.policy === 'function' ? options.policy : () => options.policy as ActionPolicyInput
    this.floors = options.floors
    this.caseInsensitive = options.caseInsensitive ?? false
    this.clock = options.clock ?? DEFAULT_CLOCK
    const provided = options.rules
    const isRuleSet = provided !== undefined
      && !Array.isArray(provided)
      && typeof (provided as ActionRuleSet).find === 'function'
    this.ruleSet = isRuleSet
      ? provided as ActionRuleSet
      : createActionRuleSet(Array.isArray(provided) ? provided : DEFAULT_ACTION_RULES)
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

  /** 规则表只读视图（数组顺序即优先级）。 */
  get rules(): readonly ActionRule[] {
    return this.ruleSet.rules
  }

  ruleIds(): readonly string[] {
    return this.ruleSet.ids()
  }

  registerRule(rule: ActionRule, placement: RulePlacement): ActionRule {
    return this.ruleSet.register(rule, placement)
  }

  overrideRule(id: string, patch: Partial<Omit<ActionRule, 'id'>>): ActionRule {
    return this.ruleSet.override(id, patch)
  }

  removeRule(id: string): boolean {
    return this.ruleSet.remove(id)
  }

  resetRules(): void {
    this.ruleSet.reset()
  }

  baseLight(evidence: ActionEvidence): BaseLightResult {
    return baseLight(evidence, this.policy, this.ruleSet)
  }

  /** 面向 UI/审批的解释：规则 id、类别、tags、证据。 */
  explain(evidence: ActionEvidence): BaseLightResult {
    return this.baseLight(evidence)
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
    const base = this.baseLight(evidence)
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
      category: base.category,
      tags: base.tags,
      lifecycle: base.lifecycle,
      credential: base.credential,
      reason: base.reason,
      evidence: base.evidence,
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
    return { grade: 'E', basis: 'unscored-fail-closed' }
  }
}
