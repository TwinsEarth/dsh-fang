// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang v2.7.6 保护伞（Umbrella）— 一个证据管道，两个评分出口。
//
//   证据层：插件源码（交给 fang-scorer 的 import 层扫描，只算一次）+ 动作元数据
//   评分层：PluginScorer → A/B/C/D/E（静态，按指纹缓存）
//           ActionScorer → green/blue/yellow/red（动态，每次动作重算）
//   耦合层：effectiveLight = max(baseLight, gradeFloor(grade))  —— 只升不降
//
// 本模块是纯逻辑（除缓存指纹要 stat/读文件外无副作用），插件形态在
// `src/plugins/umbrella.mjs`。契约与取舍见 `docs/UMBRELLA.md`。
//
// 三条写死的原则：
//   1. 失败一律往坏里判：拿不到评分 → E；认不出的工具 → yellow；认不出的灯色 → yellow。
//   2. 插件等级只能**抬高**动作灯色，不能降低。A 级插件做红灯动作仍然是红灯。
//   3. 动作评分不缓存：args 的语义等价性无法可靠判断（见 docs/UMBRELLA.md §6）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { AUDIT, GRADE_COLOR, LIGHT, LIGHT_RANK, SERVICE } from '../kernel/index.mjs'

export { LIGHT, LIGHT_RANK, AUDIT, SERVICE }

/** 四个决策出口（保护伞的输出词汇）。 */
export const DECISION = {
  ALLOW: 'allow',
  MARK: 'mark',
  ASK: 'ask',
  DELEGATE: 'delegate',
  DENY: 'deny',
}

export const SEVERITY = { NORMAL: 'normal', CRITICAL: 'critical' }

/** 委托目标（黄色/红色 + DSH 生命周期动作）。 */
export const DELEGATE_TARGET = { RESTART_GUARD: 'restartGuard' }

/**
 * 默认下限表（设计稿 §3.3 原样）：A/B 绿，C 蓝，D 黄，E 红。
 *
 * 注意它与 kernel 的 `GRADE_COLOR`（A 绿 / B 蓝 / C 黄 / D、E 红）回答的是
 * **两个不同的问题**：GRADE_COLOR 是「这个插件自己在面板上什么颜色」，
 * gradeFloor 是「这个等级的插件跑动作时，灯色下限是多少」。二者在 B 级上不同，
 * 这是刻意的；`strict` 表把下限对齐 GRADE_COLOR，供偏好一致的部署选用。
 */
export const GRADE_FLOOR = { A: 'green', B: 'green', C: 'blue', D: 'yellow', E: 'red' }

/** 与 kernel `GRADE_COLOR` 完全一致的下限表（可选预设）。 */
export const GRADE_FLOOR_STRICT = { A: 'green', B: 'blue', C: 'yellow', D: 'red', E: 'red' }

export const FLOOR_TABLES = { umbrella: GRADE_FLOOR, strict: GRADE_FLOOR_STRICT }
export const DEFAULT_FLOOR_TABLE = 'umbrella'

/** 内置凭据路径模式（正则可配置；默认值见 docs/UMBRELLA.md §三.3）。 */
export const DEFAULT_CREDENTIAL_PATTERNS = [
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
  String.raw`(^|[/\\])Cookies$`,
]

/** 内置破坏性命令模式（可配置）。顺序无关，命中即红灯。 */
export const DEFAULT_DESTRUCTIVE_PATTERNS = [
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

/** 内置 DSH 生命周期命令模式：命中即红灯，并**委托**给 restart-guard（不直接问用户）。 */
export const DEFAULT_LIFECYCLE_PATTERNS = [
  String.raw`\bdsh\b.*\b(restart|kill|stop|shutdown)\b`,
  String.raw`\btaskkill\b.*\/im\s+dsh`,
  String.raw`\bStop-Process\b`,
]

export const DEFAULT_LIFECYCLE_TOOLS = ['restart', 'supervisor', 'kill-process', 'dsh-restart']

/** 工具名 → 动作模式。未登记的工具一律 'unknown'（→ yellow）。 */
export const TOOL_MODE = {
  read: 'read', grep: 'read', glob: 'read', ls: 'read', stat: 'read', list: 'read',
  write: 'write', edit: 'write', 'multi-edit': 'write', append: 'write', patch: 'write', apply_patch: 'write',
  bash: 'exec', bash_pwsh: 'exec', pwsh: 'exec', powershell: 'exec', shell: 'exec', exec: 'exec',
  fetch: 'network', web_fetch: 'network', web_search: 'network', http: 'network', request: 'network',
  import: 'import', require: 'import', 'dynamic-import': 'import',
}

/** 只读 shell 命令的前缀白名单（保守：还要不含重定向才算只读）。 */
export const READ_ONLY_EXEC_PATTERNS = [
  String.raw`^\s*(dir|ls|cat|type|head|tail|wc|pwd|where|which|echo|node\s+--version|node\s+-v)\b`,
  String.raw`^\s*Get-(Content|ChildItem|Item|Location|Command|Process)\b`,
  String.raw`^\s*git\s+(status|log|diff|show|branch|rev-parse)\b`,
  String.raw`^\s*npm\s+(ls|view)\b`,
]

const WRITE_REDIRECT_RE = /(^|[^>])>{1,2}(?!&)/

// ─────────────────────────────────────────────────────────────────────────────
// 归一化
// ─────────────────────────────────────────────────────────────────────────────

/** 任意输入 → 合法灯色；认不出的按 yellow（保守但不制造红灯风暴）。 */
export function normalizeLight(value, fallback = LIGHT.YELLOW) {
  const v = String(value ?? '').trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(LIGHT_RANK, v) ? v : fallback
}

/** 任意输入 → 合法等级；认不出的按 E（失败往坏里判）。 */
export function normalizeGrade(value) {
  const v = String(value ?? '').trim().toUpperCase()
  return Object.prototype.hasOwnProperty.call(GRADE_FLOOR, v) ? v : 'E'
}

/** 灯色严重度。 */
export function rankOf(light) {
  return LIGHT_RANK[normalizeLight(light)] ?? LIGHT_RANK.yellow
}

/** 取更危险的一个（相等返回后者，值相同所以无所谓）。 */
export function maxLight(a, b) {
  return rankOf(a) >= rankOf(b) ? normalizeLight(a) : normalizeLight(b)
}

/** a 是否至少和 b 一样危险。 */
export function lightAtLeast(a, b) {
  return rankOf(a) >= rankOf(b)
}

function asStringList(value) {
  if (Array.isArray(value)) return value.map(v => String(v)).filter(v => v.length > 0)
  if (typeof value === 'string' && value.length > 0) return [value]
  return []
}

function asPatternList(value, fallback) {
  // 显式传空数组 = 「一条规则都不要」；只有缺省（undefined/null）才回退内置值。
  if (value === undefined || value === null) return Array.isArray(fallback) ? [...fallback] : []
  return asStringList(value)
}

function compilePatterns(patterns) {
  const out = []
  for (const source of patterns ?? []) {
    try {
      out.push({ source: String(source), re: new RegExp(String(source), 'i') })
    } catch {
      /* 写错的正则不得让保护伞失效：跳过并在 matchesPattern 里如实返回 false */
    }
  }
  return out
}

/** 指针：`[/\\]` 已覆盖两种分隔符，`resolve` 之后这里只做大小写与包含判断。 */
function withinPath(child, parent) {
  if (!child || !parent) return false
  const c = process.platform === 'win32' ? child.toLowerCase() : child
  const p = process.platform === 'win32' ? parent.toLowerCase() : parent
  if (c === p) return true
  const withSep = p.endsWith(path.sep) ? p : p + path.sep
  return c.startsWith(withSep)
}

function resolvePathValue(value, root) {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const abs = path.isAbsolute(value) ? value : path.resolve(root, value)
    return path.normalize(abs)
  } catch {
    return null
  }
}

/**
 * 评分策略归一化：相对路径按 `root` 解析，缺省值补齐。
 * `allowPaths`/`credentialPatterns` 等传空数组 = 显式「没有」，只有缺省才用内置值。
 */
export function normalizePolicy(input = {}) {
  const src = input && typeof input === 'object' ? input : {}
  const root = resolvePathValue(src.root, process.cwd()) ?? process.cwd()
  return {
    root,
    bufferRoot: resolvePathValue(src.bufferRoot, root),
    productionRoot: resolvePathValue(src.productionRoot, root),
    allowPaths: asStringList(src.allowPaths).map(v => resolvePathValue(v, root)).filter(Boolean),
    networkAllowlist: asStringList(src.networkAllowlist),
    credentialPatterns: asPatternList(src.credentialPatterns, DEFAULT_CREDENTIAL_PATTERNS),
    destructivePatterns: asPatternList(src.destructivePatterns, DEFAULT_DESTRUCTIVE_PATTERNS),
    lifecyclePatterns: asPatternList(src.lifecyclePatterns, DEFAULT_LIFECYCLE_PATTERNS),
    lifecycleTools: src.lifecycleTools === undefined ? [...DEFAULT_LIFECYCLE_TOOLS] : asStringList(src.lifecycleTools),
    readOnlyExecPatterns: asPatternList(src.readOnlyExecPatterns, READ_ONLY_EXEC_PATTERNS),
  }
}

/** 下限表解析：接受名字或表对象；未知回退默认并给出 degraded 标记。 */
export function resolveFloorTable(table) {
  if (typeof table === 'string') {
    const key = table.trim().toLowerCase()
    if (Object.prototype.hasOwnProperty.call(FLOOR_TABLES, key)) {
      return { name: key, table: { ...FLOOR_TABLES[key] }, degraded: false }
    }
    return { name: DEFAULT_FLOOR_TABLE, table: { ...GRADE_FLOOR }, degraded: true }
  }
  if (table && typeof table === 'object') {
    const out = {}
    for (const g of ['A', 'B', 'C', 'D', 'E']) out[g] = normalizeLight(table[g], GRADE_FLOOR[g])
    return { name: 'custom', table: out, degraded: false }
  }
  return { name: DEFAULT_FLOOR_TABLE, table: { ...GRADE_FLOOR }, degraded: false }
}

// ─────────────────────────────────────────────────────────────────────────────
// 插件等级 → 动作下限（耦合规则）
// ─────────────────────────────────────────────────────────────────────────────

/** 等级 → 灯色下限。认不出的等级按 E（红）。 */
export function gradeFloor(grade, options = {}) {
  const table = resolveFloorTable(options.table ?? options.floorTable ?? DEFAULT_FLOOR_TABLE).table
  const g = normalizeGrade(grade)
  return table[g] ?? LIGHT.RED
}

/**
 * 工作灯色 = max(基础灯色, 插件等级下限)。
 * 只会抬高，永不降低：A 级插件做红灯动作仍是红灯。
 */
export function effectiveLight(baseLight, grade, options = {}) {
  const base = normalizeLight(baseLight)
  const floor = gradeFloor(grade, options)
  const light = maxLight(base, floor)
  return {
    light,
    baseLight: base,
    gradeFloor: floor,
    pluginGrade: normalizeGrade(grade),
    raised: rankOf(light) > rankOf(base),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 动作证据 → 基础灯色
// ─────────────────────────────────────────────────────────────────────────────

/** 工具名/显式 mode → 动作模式。 */
export function modeOf(evidence = {}) {
  const explicit = String(evidence?.mode ?? '').trim().toLowerCase()
  if (explicit) return explicit
  const tool = String(evidence?.tool ?? '').trim().toLowerCase()
  return TOOL_MODE[tool] ?? 'unknown'
}

/** 目标三元组归一化：url / command / path（含 pid）。 */
export function targetOf(evidence = {}) {
  const args = evidence?.args && typeof evidence.args === 'object' ? evidence.args : {}
  const declared = evidence?.target && typeof evidence.target === 'object' ? evidence.target : {}
  const kind = String(declared.kind ?? '').trim().toLowerCase()
  const declaredValue = typeof declared.value === 'string' ? declared.value : ''
  const command = declaredValue || stringArg(args, ['command', 'cmd', 'script', 'argv'])
  const url = stringArg(args, ['url', 'uri', 'href'])
  const filePath = declaredValue || stringArg(args, ['path', 'file', 'filePath', 'target', 'cwd', 'dir'])
  if (kind === 'url' || (!declaredValue && url && /^[a-z][a-z0-9+.-]*:\/\//i.test(url))) {
    return { kind: 'url', value: url || declaredValue }
  }
  if (kind === 'command' || (!declaredValue && command)) return { kind: 'command', value: command }
  if (kind === 'pid') return { kind: 'pid', value: declaredValue || String(args.pid ?? '') }
  if (kind === 'path' || filePath) return { kind: 'path', value: filePath }
  if (declaredValue) return { kind: kind || 'path', value: declaredValue }
  return { kind: 'none', value: '' }
}

function stringArg(args, keys) {
  for (const key of keys) {
    const v = args?.[key]
    if (typeof v === 'string' && v.length > 0) return v
    if (Array.isArray(v) && v.length > 0) return v.map(String).join(' ')
  }
  return ''
}

function matchesAny(patterns, text) {
  if (!text) return false
  for (const p of patterns) if (p.re.test(text)) return true
  return false
}

/** 动作作用域：session | system | process（system/process 视为 DSH 生命周期）。 */
export function scopeOf(evidence = {}) {
  const raw = evidence?.scope ?? evidence?.args?.scope
  const scope = String(raw ?? '').trim().toLowerCase()
  return scope === 'session' || scope === 'system' || scope === 'process' ? scope : null
}

export function isDestructiveCommand(evidence = {}, policy = normalizePolicy()) {
  const mode = modeOf(evidence)
  if (mode !== 'exec' && mode !== 'unknown') return false
  const target = targetOf(evidence)
  const text = target.kind === 'command' ? target.value : String(evidence?.args?.command ?? '')
  return matchesAny(compilePatterns(policy.destructivePatterns), text)
}

export function isDshLifecycleAction(evidence = {}, policy = normalizePolicy()) {
  const scope = scopeOf(evidence)
  if (scope === 'system' || scope === 'process') return true
  const tool = String(evidence?.tool ?? '').trim().toLowerCase()
  const lifecycleTools = asStringList(policy.lifecycleTools).map(v => v.toLowerCase())
  if (lifecycleTools.includes(tool)) return true
  const target = targetOf(evidence)
  const text = target.kind === 'command' ? target.value : String(evidence?.args?.command ?? '')
  return matchesAny(compilePatterns(policy.lifecyclePatterns), text)
}

export function isCredentialAccess(evidence = {}, policy = normalizePolicy()) {
  const target = targetOf(evidence)
  const text = [target.value, String(evidence?.args?.command ?? ''), String(evidence?.args?.path ?? '')]
    .filter(v => typeof v === 'string' && v.length > 0)
    .join('\n')
  return matchesAny(compilePatterns(policy.credentialPatterns), text)
}

export function isNetworkEgress(evidence = {}) {
  if (modeOf(evidence) === 'network') return true
  return targetOf(evidence).kind === 'url'
}

export function isDynamicImport(evidence = {}) {
  return modeOf(evidence) === 'import'
}

export function isReadOnly(evidence = {}) {
  return modeOf(evidence) === 'read'
}

function networkAllowed(hostText, policy) {
  if (!hostText) return false
  let host = ''
  let hostPort = ''
  try {
    const url = new URL(hostText)
    host = url.hostname.toLowerCase()
    hostPort = `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`.toLowerCase()
  } catch {
    host = hostText.toLowerCase()
    hostPort = host
  }
  for (const raw of asStringList(policy.networkAllowlist)) {
    const entry = raw.trim().toLowerCase()
    if (!entry) continue
    if (entry === host || entry === hostPort) return true
    if (entry.startsWith('*.') && host.endsWith(entry.slice(1))) return true
    if (hostText.toLowerCase().startsWith(entry)) return true
  }
  return false
}

function resolveEvidencePath(evidence, policy) {
  const target = targetOf(evidence)
  if (target.kind !== 'path') return null
  return resolvePathValue(target.value, policy.root)
}

function inAllowList(absPath, policy) {
  if (!absPath) return false
  return asStringList(policy.allowPaths).some(prefix => withinPath(absPath, prefix))
}

function execLooksReadOnly(evidence, policy) {
  const target = targetOf(evidence)
  const text = target.kind === 'command' ? target.value : String(evidence?.args?.command ?? '')
  if (!text) return false
  if (WRITE_REDIRECT_RE.test(text)) return false
  return matchesAny(compilePatterns(policy.readOnlyExecPatterns), text)
}

// ─────────────────────────────────────────────────────────────────────────────
// 动作规则上下文（每条规则共享一份解析结果，避免重复解析命令/路径/URL）
// ─────────────────────────────────────────────────────────────────────────────

const SHELL_TOOLS = new Set(['bash', 'bash_pwsh', 'pwsh', 'powershell', 'shell', 'exec'])
const WRITE_TOOL_NAMES = new Set(['write', 'edit', 'multi-edit', 'append', 'patch', 'apply_patch'])
const READ_TOOL_NAMES = new Set(['read', 'grep', 'glob', 'ls', 'stat', 'list'])

// ─────────────────────────────────────────────────────────────────────────────
// shell 词法 / 语法（AST-lite）：重定向目标的唯一来源
//
// 为什么不用 shell-quote：它只把字符串切成 token，不区分操作符与命令边界
// （`2>&1` 会被当成「写目标 &1」），给不了重定向语义。
// 为什么不用 @aliou/sh：它是真 AST 解析器（v0.3.4，MIT AND BSD-3-Clause，零运行时依赖，
// unpacked ~315 KB），但**引入第三方运行时依赖会破坏本仓库的零依赖约束**（CI 与安装都依赖这一点）。
// 所以这里手写一个只覆盖「重定向目标提取」的 AST-lite 扫描器：
//   * 引号（单/双/反斜杠转义）、$VAR / $(...) / 反引号 / 通配 → 动态，不可静态解析
//   * fd 前缀（2>、3>>）、>| &> &>> >& <& <> << <<- <<<
//   * heredoc 正文整段跳过（正文里的 `>` 是数据，不是重定向）
//   * 命令分隔符（换行 ; && || | & 括号）划分命令段，段内识别 tee / dd / Set-Content / Get-Content 这类隐式文件命令
// 任何无法确定的情况一律 fail-closed：parseFailed = true，由规则判黄，绝不猜。
// ─────────────────────────────────────────────────────────────────────────────

const SHELL_SEPARATORS = new Set(['newline', ';', ';;', '&&', '||', '|', '&', '(', ')'])

/** 重定向操作符匹配（最长优先）。返回 { op, len } 或 null。 */
function matchRedirectOp(text, i) {
  const ch = text[i]
  const two = text.slice(i, i + 2)
  const three = text.slice(i, i + 3)
  if (ch === '&') {
    if (three === '&>>') return { op: '&>>', len: 3 }
    if (two === '&>') return { op: '&>', len: 2 }
    return null
  }
  if (ch === '>') {
    if (three === '>>|') return null
    if (two === '>>') return { op: '>>', len: 2 }
    if (two === '>|') return { op: '>|', len: 2 }
    if (two === '>&') return { op: '>&', len: 2 }
    if (two === '>=') return null
    return { op: '>', len: 1 }
  }
  if (ch === '<') {
    if (three === '<<<') return { op: '<<<', len: 3 }
    if (three === '<<-') return { op: '<<-', len: 3 }
    if (two === '<<') return { op: '<<', len: 2 }
    if (two === '<&') return { op: '<&', len: 2 }
    if (two === '<>') return { op: '<>', len: 2 }
    if (two === '<=') return null
    return { op: '<', len: 1 }
  }
  return null
}

/** 跳过 `$( ... )`：计数括号，忽略引号内的括号。返回结束后一位。 */
function skipParenGroup(text, i) {
  let depth = 0
  let j = i
  while (j < text.length) {
    const ch = text[j]
    if (ch === '\\') { j += 2; continue }
    if (ch === '(') depth += 1
    else if (ch === ')') { depth -= 1; if (depth === 0) return j + 1 }
    j += 1
  }
  return -1
}

/**
 * 扫描一个 word（不含分隔符）。返回 { value, dynamic, end, error }。
 * dynamic = true 表示包含参数展开/命令替换/通配，无法作为字面量路径。
 */
function scanWord(text, i) {
  let value = ''
  let dynamic = false
  let j = i
  while (j < text.length) {
    const ch = text[j]
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') break
    if (SHELL_SEPARATORS.has(ch) || ch === '>' || ch === '<' || ch === ';') break
    if (ch === '\\') {
      const next = text[j + 1]
      if (next === undefined) return { value, dynamic, end: j + 1, error: 'trailing-backslash' }
      if (next === '\n') { j += 2; continue }
      value += next
      j += 2
      continue
    }
    if (ch === "'") {
      const close = text.indexOf("'", j + 1)
      if (close < 0) return { value, dynamic, end: text.length, error: 'unterminated-single-quote' }
      value += text.slice(j + 1, close)
      j = close + 1
      continue
    }
    if (ch === '"') {
      let k = j + 1
      let closed = false
      while (k < text.length) {
        const c = text[k]
        if (c === '\\') {
          const next = text[k + 1]
          if (next === undefined) break
          if (next === '"' || next === '\\' || next === '$' || next === '`') value += next
          else value += `\\${next}`
          k += 2
          continue
        }
        if (c === '"') { closed = true; k += 1; break }
        if (c === '$' || c === '`') dynamic = true
        value += c
        k += 1
      }
      if (!closed) return { value, dynamic, end: text.length, error: 'unterminated-double-quote' }
      j = k
      continue
    }
    if (ch === '$') {
      dynamic = true
      const next = text[j + 1]
      if (next === '(') {
        const end = skipParenGroup(text, j + 1)
        if (end < 0) return { value, dynamic, end: text.length, error: 'unterminated-substitution' }
        j = end
        continue
      }
      if (next === '{') {
        const close = text.indexOf('}', j + 2)
        if (close < 0) return { value, dynamic, end: text.length, error: 'unterminated-brace-expansion' }
        j = close + 1
        continue
      }
      // $'...' / $VAR
      if (next === "'") {
        const close = text.indexOf("'", j + 2)
        if (close < 0) return { value, dynamic, end: text.length, error: 'unterminated-ansi-c' }
        value += text.slice(j + 2, close)
        j = close + 1
        continue
      }
      j += 1
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j += 1
      continue
    }
    if (ch === '`') {
      dynamic = true
      const close = text.indexOf('`', j + 1)
      if (close < 0) return { value, dynamic, end: text.length, error: 'unterminated-backtick' }
      j = close + 1
      continue
    }
    if (ch === '*' || ch === '?' || ch === '[' || ch === '{') dynamic = true
    value += ch
    j += 1
  }
  return { value, dynamic, end: j, error: null }
}

/**
 * 词法扫描：产出 word / redirect / op token，并把 heredoc 正文整段吞掉。
 * @returns {{tokens: object[], errors: string[], heredocs: number}}
 */
export function tokenizeShell(commandText) {
  const text = String(commandText ?? '')
  const tokens = []
  const errors = []
  let heredocs = 0
  let pendingHeredocs = []
  let i = 0
  let lastEnd = -1

  const consumeHeredocBodies = () => {
    for (const hd of pendingHeredocs) {
      heredocs += 1
      let k = i
      let closed = false
      while (k <= text.length) {
        const lineEnd = text.indexOf('\n', k)
        const line = text.slice(k, lineEnd < 0 ? text.length : lineEnd)
        const compare = hd.strip ? line.replace(/^\t+/, '') : line
        k = lineEnd < 0 ? text.length : lineEnd + 1
        if (compare === hd.delimiter) { closed = true; break }
        if (lineEnd < 0) break
      }
      if (!closed) errors.push('unterminated-heredoc')
      i = k
    }
    pendingHeredocs = []
  }

  while (i < text.length) {
    const ch = text[i]
    if (ch === ' ' || ch === '\t' || ch === '\r') { i += 1; continue }
    if (ch === '\\' && text[i + 1] === '\n') { i += 2; continue }
    if (ch === '\n') {
      tokens.push({ type: 'op', value: 'newline' })
      i += 1
      if (pendingHeredocs.length > 0) consumeHeredocBodies()
      continue
    }
    // 重定向（可能带 fd 前缀）
    const redir = matchRedirectOp(text, i)
    if (redir !== null) {
      let fd = null
      const prev = tokens[tokens.length - 1]
      if (prev !== undefined && prev.type === 'word' && prev.end === i && /^\d+$/.test(prev.value) && !prev.dynamic) {
        fd = Number(prev.value)
        tokens.pop()
      }
      i += redir.len
      while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1
      let target = null
      const next = text[i]
      const targetIsWord = next !== undefined
        && next !== '\n' && next !== ';' && next !== '|' && next !== '&' && next !== '>' && next !== '<'
      if (targetIsWord) {
        const word = scanWord(text, i)
        if (word.error !== null) errors.push(word.error)
        target = { value: word.value, dynamic: word.dynamic }
        i = word.end
      }
      tokens.push({ type: 'redirect', op: redir.op, fd, target })
      if ((redir.op === '<<' || redir.op === '<<-') && target !== null) {
        if (target.dynamic) errors.push('dynamic-heredoc-delimiter')
        else pendingHeredocs.push({ delimiter: target.value, strip: redir.op === '<<-' })
      }
      continue
    }
    // 命令分隔 / 管道 / 括号
    if (ch === ';' || ch === '&' || ch === '|' || ch === '(' || ch === ')') {
      const two = text.slice(i, i + 2)
      let value = ch
      if (two === ';;' || two === '&&' || two === '||') value = two
      tokens.push({ type: 'op', value })
      i += value.length
      continue
    }
    const word = scanWord(text, i)
    if (word.error !== null) errors.push(word.error)
    tokens.push({ type: 'word', value: word.value, dynamic: word.dynamic, start: i, end: word.end })
    if (word.end <= i) { i += 1; continue }
    i = word.end
    lastEnd = word.end
  }
  return { tokens, errors, heredocs, lastEnd }
}

const IMPLICIT_WRITE_COMMANDS = new Set(['tee', 'tee-object', 'out-file', 'set-content', 'add-content'])
const IMPLICIT_READ_COMMANDS = new Set(['cat', 'type', 'less', 'head', 'tail', 'more', 'get-content', 'gc'])

/** 段内隐式文件命令（tee / dd / Set-Content / Get-Content …）的目标。 */
function collectImplicitTargets(argv, writeTargets, readTargets) {
  const first = argv[0]
  if (first === undefined || first.dynamic) return
  const name = String(first.value).split(/[\\/]/).pop()?.toLowerCase() ?? ''
  const rest = argv.slice(1)
  const positional = []
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index]
    if (word.dynamic) continue
    const value = String(word.value)
    if (value === '--') continue
    if (value.startsWith('-')) continue
    positional.push({ value, previous: rest[index - 1]?.value })
  }
  if (name === 'tee') {
    for (const item of positional) writeTargets.push(item.value)
    return
  }
  if (name === 'dd') {
    for (const word of rest) {
      if (word.dynamic) continue
      const value = String(word.value)
      if (value.startsWith('of=')) writeTargets.push(value.slice(3))
      else if (value.startsWith('if=')) readTargets.push(value.slice(3))
    }
    return
  }
  if (IMPLICIT_WRITE_COMMANDS.has(name)) {
    const flagged = positional.find((item) => String(item.previous ?? '').toLowerCase() === '-path' || String(item.previous ?? '').toLowerCase() === '-filepath')
    if (flagged !== undefined) writeTargets.push(flagged.value)
    else if (positional.length > 0) writeTargets.push(String(positional[0].value))
    return
  }
  if (IMPLICIT_READ_COMMANDS.has(name)) {
    for (const item of positional) readTargets.push(item.value)
  }
}

/**
 * 从命令文本提取写/读重定向目标（AST-lite）。
 * @returns {{writeTargets:string[], readTargets:string[], parseFailed:boolean,
 *   parseError:string|null, heredocs:number, warnings:string[]}}
 */
export function parseShellRedirects(commandText, policyInput = {}) {
  const policy = policyInput && policyInput.__normalized === true ? policyInput : normalizePolicy(policyInput ?? {})
  const text = String(commandText ?? '')
  const empty = { writeTargets: [], readTargets: [], parseFailed: false, parseError: null, heredocs: 0, warnings: [] }
  if (text.trim().length === 0) return empty

  const lex = tokenizeShell(text)
  const writeRaw = []
  const readRaw = []
  const warnings = []
  let argv = []

  const flushCommand = () => {
    if (argv.length > 0) collectImplicitTargets(argv, writeRaw, readRaw)
    argv = []
  }

  for (const token of lex.tokens) {
    if (token.type === 'op') {
      if (SHELL_SEPARATORS.has(token.value)) flushCommand()
      continue
    }
    if (token.type === 'word') { argv.push({ value: token.value, dynamic: token.dynamic }); continue }
    if (token.type === 'redirect') {
      const target = token.target
      const op = token.op
      if (op === '<<' || op === '<<-' || op === '<<<') continue // heredoc / herestring 的内容不是文件路径
      if (target === null) { warnings.push(`${op}-missing-target`); continue }
      if (target.dynamic) { warnings.push(`${op}-dynamic-target`); continue }
      const value = String(target.value)
      if (op === '>' || op === '>>' || op === '>|' || op === '&>' || op === '&>>') {
        writeRaw.push(value)
      } else if (op === '<') {
        readRaw.push(value)
      } else if (op === '<>') {
        readRaw.push(value)
        writeRaw.push(value)
      } else if (op === '>&' || op === '<&') {
        // 纯数字目标是 fd 复制（2>&1），不是文件
        if (/^\d+$/.test(value)) continue
        if (op === '>&') writeRaw.push(value)
        else readRaw.push(value)
      }
    }
  }
  flushCommand()

  const resolve = (list) => {
    const out = []
    for (const raw of list) {
      const abs = resolvePathValue(String(raw), policy.root)
      if (abs !== null && !out.includes(abs)) out.push(abs)
    }
    return out
  }
  const parseFailed = lex.errors.length > 0
  return {
    writeTargets: resolve(writeRaw),
    readTargets: resolve(readRaw),
    parseFailed,
    parseError: parseFailed ? lex.errors[0] : null,
    heredocs: lex.heredocs,
    warnings,
  }
}

/** URL → { raw, host, hostPort }；坏 URL 返回 null（由 network-egress 判黄兜住）。 */
export function parseUrlParts(raw) {
  const text = String(raw ?? '').trim()
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)/i.exec(text)
  if (m === null) return null
  const scheme = String(m[1]).toLowerCase()
  const authority = String(m[2])
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

/**
 * 规则上下文：一次解析，供 15 条规则共享。
 * @returns {{mode:string, target:object, commandText:string, targetPath:string|null,
 *   url:{raw:string,host:string,hostPort:string}|null, targetPid:number|null,
 *   writeTargets:string[], readTargets:string[], policy:object}}
 */
export function buildActionContext(evidence = {}, policyInput = {}) {
  const policy = policyInput && policyInput.__normalized === true ? policyInput : normalizePolicy(policyInput ?? {})
  const mode = modeOf(evidence)
  const target = targetOf(evidence)
  const commandText = target.kind === 'command' ? target.value : String(evidence?.args?.command ?? '')
  const redirects = parseShellRedirects(commandText, policy)
  const targetPath = target.kind === 'path' ? resolvePathValue(target.value, policy.root) : null
  const url = target.kind === 'url' ? parseUrlParts(target.value) : null
  const targetPid = target.kind === 'pid' ? Number(target.value) : null
  return {
    mode,
    target,
    commandText,
    targetPath,
    url,
    targetPid: Number.isFinite(targetPid) ? targetPid : null,
    writeTargets: redirects.writeTargets,
    readTargets: redirects.readTargets,
    parseFailed: redirects.parseFailed,
    parseError: redirects.parseError,
    heredocs: redirects.heredocs,
    warnings: redirects.warnings,
    policy,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 声明式动作规则表：id / category / light / reason / tags / match / evidence
//
// 与 AST 规则表（S1–S7 / C2–C5）同一个粒度：每条规则可独立喂证据、独立断言证据形状。
// **首个命中胜出**（数组顺序即优先级），不是"取最高灯色"——灯色是排他性的，
// 而且凭据访问必须无条件压过"沙箱内只读"的绿规则。
// ─────────────────────────────────────────────────────────────────────────────

export const ACTION_CATEGORIES = [
  'lifecycle', 'destructive', 'credential', 'network', 'import', 'write', 'exec', 'read', 'fallback',
]

function firstPattern(patterns, text) {
  for (const source of patterns ?? []) {
    let re
    try {
      re = new RegExp(String(source), 'i')
    } catch {
      continue
    }
    if (re.test(String(text ?? ''))) return String(source)
  }
  return null
}

function shellCommandOf(ctx) {
  return ctx.commandText
}

/** 写动作的目标路径集合：write 工具取 target 路径，shell 取重定向目标。 */
function writeTargetsOf(ctx) {
  const out = []
  if (ctx.mode === 'write' && ctx.targetPath !== null) out.push(ctx.targetPath)
  for (const t of ctx.writeTargets) if (!out.includes(t)) out.push(t)
  return out
}

/** 读动作的目标路径集合：read 工具取 target 路径，shell 取读命令目标。 */
function readTargetsOf(ctx) {
  const out = []
  if (ctx.mode === 'read' && ctx.targetPath !== null) out.push(ctx.targetPath)
  for (const t of ctx.readTargets) if (!out.includes(t)) out.push(t)
  return out
}

const NO_TARGET = { kind: 'none', value: '' }

/** 默认规则表（v2.7.8 起声明式；id 与 v2.7.6 的 15 条一一对应）。 */
export const DEFAULT_ACTION_RULES = Object.freeze([
  {
    id: 'dsh-lifecycle',
    category: 'lifecycle',
    light: LIGHT.RED,
    reason: 'DSH 生命周期动作，交给 restart-guard',
    tags: ['hard-deny', 'delegate-to-restart-guard'],
    match: (ev, ctx) => isDshLifecycleAction(ev, ctx.policy),
    evidence: (ev, ctx) => {
      const scope = scopeOf(ev)
      const tool = String(ev?.tool ?? '').trim().toLowerCase()
      const policy = ctx.policy
      const lifecycleTools = policy.lifecycleTools.map((v) => v.toLowerCase())
      let matchedPattern = 'unknown'
      if (scope === 'system' || scope === 'process') matchedPattern = `scope:${scope}`
      else if (lifecycleTools.includes(tool)) matchedPattern = `tool:${tool}`
      else {
        const hit = firstPattern(policy.lifecyclePatterns.map((p) => p.source ?? p), shellCommandOf(ctx))
        matchedPattern = hit === null ? 'pattern' : `pattern:${hit}`
      }
      return { matchedPattern, tool: String(ev?.tool ?? ''), targetPid: ctx.targetPid, commandSnippet: shellCommandOf(ctx).slice(0, 200) }
    },
  },
  {
    id: 'destructive-command',
    category: 'destructive',
    light: LIGHT.RED,
    reason: '命令命中破坏性模式（不可逆）',
    tags: ['hard-deny'],
    match: (ev, ctx) => isDestructiveCommand(ev, ctx.policy),
    evidence: (ev, ctx) => {
      const hit = firstPattern(ctx.policy.destructivePatterns.map((p) => p.source ?? p), shellCommandOf(ctx))
      return { matchedPattern: hit === null ? 'unknown' : `pattern:${hit}`, commandSnippet: shellCommandOf(ctx).slice(0, 200) }
    },
  },
  {
    id: 'credential-access',
    category: 'credential',
    light: LIGHT.RED,
    reason: '命中凭据路径，硬拒绝',
    tags: ['hard-deny'],
    match: (ev, ctx) => isCredentialAccess(ev, ctx.policy),
    evidence: (ev, ctx) => {
      const candidates = []
      if (ctx.targetPath !== null) candidates.push(ctx.targetPath)
      for (const p of [...ctx.readTargets, ...ctx.writeTargets]) candidates.push(p)
      const text = [ctx.target.value, shellCommandOf(ctx), String(ev?.args?.path ?? '')].filter(Boolean).join('\n')
      const hit = firstPattern(ctx.policy.credentialPatterns.map((p) => p.source ?? p), text)
      const matchedPaths = candidates.filter((p) => firstPattern(ctx.policy.credentialPatterns.map((x) => x.source ?? x), p) !== null)
      return { matchedPattern: hit === null ? 'unknown' : `pattern:${hit}`, paths: matchedPaths, target: ctx.target }
    },
  },
  {
    id: 'network-allowlisted',
    category: 'network',
    light: LIGHT.BLUE,
    reason: '外连命中允许列表',
    tags: ['allow-with-audit'],
    match: (ev, ctx) => isNetworkEgress(ev) && networkAllowed(ctx.target.value, ctx.policy),
    evidence: (ev, ctx) => ({ matchedPattern: 'allowlisted-host', url: ctx.url?.raw ?? ctx.target.value, host: ctx.url?.host ?? null, allowlist: ctx.policy.networkAllowlist }),
  },
  {
    id: 'network-egress',
    category: 'network',
    light: LIGHT.YELLOW,
    reason: '外连未在允许列表',
    tags: ['needs-approval'],
    match: (ev, ctx) => isNetworkEgress(ev) && !networkAllowed(ctx.target.value, ctx.policy),
    evidence: (ev, ctx) => ({ matchedPattern: ctx.url === null ? 'unparsable-url' : 'non-allowlisted-host', url: ctx.target.value, host: ctx.url?.host ?? null, allowlist: ctx.policy.networkAllowlist }),
  },
  {
    id: 'dynamic-import',
    category: 'import',
    light: LIGHT.YELLOW,
    reason: '动态加载未评分模块',
    tags: ['needs-approval'],
    match: (ev) => isDynamicImport(ev),
    evidence: (ev, ctx) => ({ matchedPattern: 'import-tool', tool: String(ev?.tool ?? ''), specifier: String(ev?.args?.specifier ?? ev?.args?.module ?? ctx.target.value ?? '') }),
  },
  {
    id: 'write-in-buffer',
    category: 'write',
    light: LIGHT.BLUE,
    reason: '写落在沙箱缓冲区内',
    tags: ['allow-with-audit'],
    match: (ev, ctx) => {
      if (ctx.mode !== 'write' && ctx.mode !== 'exec') return false
      const root = ctx.policy.bufferRoot
      if (root === null) return false
      const targets = writeTargetsOf(ctx)
      return targets.length > 0 && targets.every((t) => withinPath(t, root))
    },
    evidence: (ev, ctx) => ({ matchedPattern: 'in-buffer', targets: writeTargetsOf(ctx), bufferRoot: ctx.policy.bufferRoot }),
  },
  {
    id: 'write-in-allowlist',
    category: 'write',
    light: LIGHT.BLUE,
    reason: '写命中允许列表',
    tags: ['allow-with-audit'],
    match: (ev, ctx) => {
      if (ctx.mode !== 'write') return false
      const targets = writeTargetsOf(ctx)
      return targets.length > 0 && targets.every((t) => inAllowList(t, ctx.policy))
    },
    evidence: (ev, ctx) => ({ matchedPattern: 'in-allowlist', targets: writeTargetsOf(ctx), allowPaths: ctx.policy.allowPaths }),
  },
  {
    id: 'write-production',
    category: 'write',
    light: LIGHT.YELLOW,
    reason: '写落在生产区',
    tags: ['needs-approval'],
    match: (ev, ctx) => {
      if (ctx.mode !== 'write') return false
      const root = ctx.policy.productionRoot
      if (root === null) return false
      const targets = writeTargetsOf(ctx)
      return targets.length > 0 && targets.every((t) => withinPath(t, root))
    },
    evidence: (ev, ctx) => ({ matchedPattern: 'production-root', targets: writeTargetsOf(ctx), productionRoot: ctx.policy.productionRoot }),
  },
  {
    id: 'write-outside-buffer',
    category: 'write',
    light: LIGHT.YELLOW,
    reason: '写越出沙箱',
    tags: ['needs-approval'],
    match: (ev, ctx) => {
      // fail-closed：命令里出现重定向符号但语法解析失败 → 不猜目标，直接判黄（需审批）
      if (ctx.parseFailed === true && /[>]/.test(shellCommandOf(ctx))) return true
      if (ctx.mode !== 'write') return false
      const targets = writeTargetsOf(ctx)
      if (targets.length === 0) return true
      return targets.some((t) => !withinPath(t, ctx.policy.bufferRoot) && !inAllowList(t, ctx.policy))
    },
    evidence: (ev, ctx) => ({
      matchedPattern: ctx.parseFailed === true ? 'unparsed-redirect-fail-closed' : 'outside-buffer-and-allowlist',
      targets: writeTargetsOf(ctx),
      bufferRoot: ctx.policy.bufferRoot,
      allowPaths: ctx.policy.allowPaths,
      parseFailed: ctx.parseFailed === true,
      parseError: ctx.parseError ?? null,
    }),
  },
  {
    id: 'exec-read-only',
    category: 'exec',
    light: LIGHT.BLUE,
    reason: '只读 shell 命令（无重定向）',
    tags: ['allow-with-audit'],
    // 解析失败时不宣称只读：宁可判黄，也不把没看懂的语法放成蓝/绿
    match: (ev, ctx) => ctx.mode === 'exec' && ctx.parseFailed !== true && execLooksReadOnly(ev, ctx.policy),
    evidence: (ev, ctx) => ({ matchedPattern: 'read-only-prefix', commandSnippet: shellCommandOf(ctx).slice(0, 200) }),
  },
  {
    id: 'exec-side-effect',
    category: 'exec',
    light: LIGHT.YELLOW,
    reason: 'shell 命令有副作用，不在只读白名单',
    tags: ['needs-approval'],
    match: (ev, ctx) => ctx.mode === 'exec',
    evidence: (ev, ctx) => ({
      matchedPattern: ctx.parseFailed === true ? 'unparsed-command-fail-closed' : 'side-effect',
      commandSnippet: shellCommandOf(ctx).slice(0, 200),
      writeTargets: ctx.writeTargets,
      parseFailed: ctx.parseFailed === true,
      parseError: ctx.parseError ?? null,
    }),
  },
  {
    id: 'read-in-buffer',
    category: 'read',
    light: LIGHT.GREEN,
    reason: '沙箱内只读',
    tags: ['auto-allow'],
    match: (ev, ctx) => {
      if (ctx.mode !== 'read') return false
      const root = ctx.policy.bufferRoot
      if (root === null) return false
      const targets = readTargetsOf(ctx)
      return targets.length > 0 && targets.every((t) => withinPath(t, root))
    },
    evidence: (ev, ctx) => ({ matchedPattern: 'in-buffer', targets: readTargetsOf(ctx), bufferRoot: ctx.policy.bufferRoot }),
  },
  {
    id: 'read-outside-buffer',
    category: 'read',
    light: LIGHT.BLUE,
    reason: '沙箱外只读',
    tags: ['allow-with-audit'],
    match: (ev, ctx) => ctx.mode === 'read',
    evidence: (ev, ctx) => ({ matchedPattern: 'outside-buffer', targets: readTargetsOf(ctx), bufferRoot: ctx.policy.bufferRoot }),
  },
  {
    id: 'unknown-tool',
    category: 'fallback',
    light: LIGHT.YELLOW,
    reason: '未登记的工具，保守判黄',
    tags: ['conservative'],
    match: () => true,
    evidence: (ev, ctx) => ({ matchedPattern: 'fallback', tool: String(ev?.tool ?? ''), mode: ctx.mode, hasTarget: ctx.target.kind !== 'none' }),
  },
])

/** 规则形状校验：注册时立刻失败，而不是在评分路径上静默漏判。 */
export function assertActionRule(rule) {
  if (!rule || typeof rule !== 'object') throw new TypeError('action rule must be an object')
  if (typeof rule.id !== 'string' || rule.id.length === 0) throw new TypeError('action rule.id must be a non-empty string')
  if (!ACTION_CATEGORIES.includes(rule.category)) throw new TypeError(`action rule ${rule.id}: unknown category ${String(rule.category)}`)
  if (!Object.prototype.hasOwnProperty.call(LIGHT_RANK, rule.light)) throw new TypeError(`action rule ${rule.id}: unknown light ${String(rule.light)}`)
  if (typeof rule.match !== 'function') throw new TypeError(`action rule ${rule.id}: match() is required`)
  if (typeof rule.evidence !== 'function') throw new TypeError(`action rule ${rule.id}: evidence() is required`)
  return rule
}

/**
 * 可注册/可覆盖的规则集。注册是**插入到正确优先级位置**，不是追加到末尾——
 * 追加一条红灯规则到表尾等于永远不命中（前面有 fallback）。
 */
export function createActionRuleSet(initial = DEFAULT_ACTION_RULES) {
  const rules = (initial ?? []).map((rule) => assertActionRule(rule))
  const findIndex = (id) => rules.findIndex((r) => r.id === id)

  function register(rule, opts = {}) {
    assertActionRule(rule)
    if (typeof rule.id === 'string' && findIndex(rule.id) >= 0) {
      throw new Error(`action rule already registered: ${rule.id}（覆盖请用 override()）`)
    }
    const before = typeof opts.before === 'string' ? findIndex(opts.before) : -1
    const after = typeof opts.after === 'string' ? findIndex(opts.after) : -1
    if (before >= 0) rules.splice(before, 0, rule)
    else if (after >= 0) rules.splice(after + 1, 0, rule)
    else throw new Error(`action rule ${rule.id}: register() requires before/after naming an existing rule`)
    return rule
  }

  function override(id, patch = {}) {
    const index = findIndex(id)
    if (index < 0) throw new Error(`action rule not found: ${id}`)
    const merged = assertActionRule({ ...rules[index], ...patch, id })
    rules[index] = merged
    return merged
  }

  function remove(id) {
    const index = findIndex(id)
    if (index < 0) return false
    rules.splice(index, 1)
    return true
  }

  function reset() {
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
    find(evidence, ctx) {
      return rules.find((rule) => rule.match(evidence, ctx)) ?? rules[rules.length - 1] ?? null
    },
  }
}

/** 默认规则集实例（只读用途：baseLight 用它）。 */
const DEFAULT_RULE_SET = createActionRuleSet(DEFAULT_ACTION_RULES)

/**
 * 基础灯色：只看动作本身，不看插件等级。
 * 规则按数组顺序首个命中胜出；返回值带 matchedRule / category / tags / 结构化证据。
 */
export function baseLight(evidence = {}, policyInput = {}, ruleSet = DEFAULT_RULE_SET) {
  const policy = policyInput && policyInput.__normalized === true ? policyInput : normalizePolicy(policyInput ?? {})
  const ctx = buildActionContext(evidence, policy)
  const rule = (ruleSet && typeof ruleSet.find === 'function' ? ruleSet.find(evidence, ctx) : null)
    ?? DEFAULT_ACTION_RULES[DEFAULT_ACTION_RULES.length - 1]
  const detail = rule.evidence(evidence, ctx) ?? {}
  return {
    light: rule.light,
    matchedRule: rule.id,
    category: rule.category,
    tags: [...(rule.tags ?? [])],
    lifecycle: rule.id === 'dsh-lifecycle',
    credential: rule.id === 'credential-access',
    target: ctx.target ?? NO_TARGET,
    path: ctx.targetPath ?? (detail.targets?.[0] ?? null),
    reason: rule.reason,
    evidence: detail,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 决策矩阵
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 灯色 + 动作类别 → 决策。纯函数，不读策略、不碰 IO。
 * @returns {{decision:string, severity:string, reason:string, originLight?:string, target?:string, elevated?:boolean}}
 */
export function decide(assessment = {}) {
  const light = normalizeLight(assessment.light)
  const lifecycle = assessment.lifecycle === true || assessment.matchedRule === 'dsh-lifecycle'
  const credential = assessment.credential === true || assessment.matchedRule === 'credential-access'

  if (light === LIGHT.GREEN) {
    return { decision: DECISION.ALLOW, severity: SEVERITY.NORMAL, reason: 'green-light' }
  }
  if (light === LIGHT.BLUE) {
    return { decision: DECISION.MARK, severity: SEVERITY.NORMAL, reason: 'blue-light', elevated: true }
  }
  if (light === LIGHT.YELLOW) {
    if (lifecycle) {
      return {
        decision: DECISION.DELEGATE,
        severity: SEVERITY.NORMAL,
        reason: 'lifecycle-yellow',
        originLight: LIGHT.YELLOW,
        target: DELEGATE_TARGET.RESTART_GUARD,
      }
    }
    return { decision: DECISION.ASK, severity: SEVERITY.NORMAL, reason: 'yellow-light' }
  }
  // red
  if (credential) return { decision: DECISION.DENY, severity: SEVERITY.CRITICAL, reason: 'credential-access' }
  if (lifecycle) {
    return {
      decision: DECISION.DELEGATE,
      severity: SEVERITY.CRITICAL,
      reason: 'lifecycle-red',
      originLight: LIGHT.RED,
      target: DELEGATE_TARGET.RESTART_GUARD,
    }
  }
  return { decision: DECISION.ASK, severity: SEVERITY.CRITICAL, reason: 'red-light' }
}

// ─────────────────────────────────────────────────────────────────────────────
// 评分门面
// ─────────────────────────────────────────────────────────────────────────────

function sha1(text) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex')
}

function mtimeOf(file) {
  try {
    return String(fs.statSync(file).mtimeMs)
  } catch {
    return null
  }
}

function pluginKeyOf(input) {
  if (typeof input.pluginId === 'string' && input.pluginId.length > 0) return `id:${input.pluginId}`
  if (typeof input.dir === 'string' && input.dir.length > 0) return `dir:${path.resolve(input.dir)}`
  if (typeof input.source === 'string') return `src:${sha1(input.source)}`
  return null
}

/**
 * 保护伞门面。消费者（Router / Approver / 工具执行器）只接触这一个对象。
 *
 * @param {object} options
 * @param {{scoreSource?:Function, scoreDir?:Function}|null} options.scorer fang-scorer 服务（缺省 = 失败往坏里判）
 * @param {object} [options.policy] 见 normalizePolicy
 * @param {string|object} [options.floorTable]
 * @param {number} [options.cacheSize]
 * @param {Function} [options.now]
 * @param {Function|null} [options.audit] (record) => void，每次决策一条
 * @param {Function|null} [options.onPluginScored] (assessment) => void，插件评分落审计
 */
export function createUmbrella(options = {}) {
  const {
    scorer = null,
    policy: rawPolicy = {},
    floorTable = DEFAULT_FLOOR_TABLE,
    cacheSize = 200,
    now = () => Date.now(),
    audit = null,
    onPluginScored = null,
    rules: initialRules = null,
    registry = null,
  } = options

  // 规则集：可传数组（自动建集）或 createActionRuleSet() 的实例（可注册/覆盖）。
  const ruleSet = initialRules && typeof initialRules.find === 'function' && Array.isArray(initialRules.rules)
    ? initialRules
    : createActionRuleSet(initialRules ?? DEFAULT_ACTION_RULES)
  // v2.8.0：可选的规则注册表（内置 + YAML 叠加）。提供时优先于 ruleSet。
  const activeRules = registry ?? ruleSet

  // policy 允许是函数：插件在每次评分时都能拿到最新的 buffer root（buffer-keeper 的
  // root 是 start({dir}) 之后才知道的），而缓存仍按插件指纹失效，不因 root 变化清空。
  const policySource = typeof rawPolicy === 'function' ? rawPolicy : () => rawPolicy
  let policyCache = null
  let policyStamp = null
  function policyNow() {
    const raw = policySource() ?? {}
    const stamp = JSON.stringify(raw)
    if (policyCache !== null && stamp === policyStamp) return policyCache
    policyStamp = stamp
    policyCache = { ...normalizePolicy(raw), __normalized: true }
    return policyCache
  }

  const floors = resolveFloorTable(floorTable)
  const maxCache = Math.max(1, Math.floor(Number(cacheSize) || 200))
  const cache = new Map()
  const grades = new Map()
  const stats = { hits: 0, misses: 0, evictions: 0, invalidations: 0, pluginScans: 0 }

  function auditRecord(record) {
    if (typeof audit !== 'function') return
    try { audit(record) } catch { /* 审计失败不得影响评分 */ }
  }

  function emitPluginScored(assessment) {
    if (typeof onPluginScored !== 'function') return
    try { onPluginScored(assessment) } catch { /* 同上 */ }
  }

  function rememberGrade(assessment) {
    if (!assessment?.pluginId) return
    grades.set(String(assessment.pluginId), assessment.grade)
  }

  function runScorer(input) {
    const fail = (reason) => ({
      grade: 'E', S: 100, color: LIGHT.RED, veto: false, degraded: true,
      signals: [], reasons: [reason], basis: null, dir: input.dir ?? null, entry: input.entry ?? null,
    })
    if (!scorer || (typeof scorer.scoreSource !== 'function' && typeof scorer.scoreDir !== 'function')) {
      return fail('scorer-unavailable')
    }
    const opts = { environment: input.environment }
    try {
      if (typeof input.source === 'string' && typeof scorer.scoreSource === 'function') {
        return scorer.scoreSource(input.source, input.pkg ?? {}, opts) ?? fail('scorer-empty-result')
      }
      if (typeof input.dir === 'string' && typeof scorer.scoreDir === 'function') {
        return scorer.scoreDir(input.dir, input.manifest ?? null, opts) ?? fail('scorer-empty-result')
      }
      return fail('no-scoring-input')
    } catch (e) {
      return fail(`scorer-error:${e?.message ?? e}`)
    }
  }

  function isStale(entry) {
    if (!entry) return true
    if (entry.entryFile) {
      const current = mtimeOf(entry.entryFile)
      if (current === null) return true
      return current !== entry.fingerprint
    }
    return false
  }

  function store(key, entry) {
    if (cache.has(key)) cache.delete(key)
    cache.set(key, entry)
    while (cache.size > maxCache) {
      const oldest = cache.keys().next().value
      cache.delete(oldest)
      stats.evictions += 1
    }
  }

  /** 插件评分：静态证据只算一次，按入口文件 mtime（或 inline 源码 sha1）失效。 */
  function assessPlugin(input = {}) {
    const started = now()
    const key = pluginKeyOf(input)
    if (!key) {
      const failed = {
        pluginId: 'unknown', version: '0.0.0', grade: 'E', score: 100, color: LIGHT.RED,
        veto: false, degraded: true, signals: [], reasons: ['no-scoring-input'], basis: null,
        entry: null, cachedAt: started, fingerprint: null, fromCache: false,
      }
      emitPluginScored(failed)
      return failed
    }

    if (input.refresh !== true && cache.has(key)) {
      const hit = cache.get(key)
      if (!isStale(hit)) {
        stats.hits += 1
        store(key, hit) // LRU：命中后挪到队尾
        return { ...hit.assessment, fromCache: true }
      }
      cache.delete(key)
    }

    stats.misses += 1
    stats.pluginScans += 1
    const scored = runScorer(input)
    const entryFile = scored?.dir && scored?.entry ? path.join(scored.dir, scored.entry) : null
    const fingerprint = entryFile ? mtimeOf(entryFile) : sha1(String(input.source ?? ''))
    const grade = normalizeGrade(scored?.grade)
    const assessment = {
      pluginId: String(input.pluginId ?? (input.dir ? path.basename(path.resolve(input.dir)) : 'inline')),
      version: String(input.version ?? input.pkg?.version ?? '0.0.0'),
      grade,
      score: Number.isFinite(Number(scored?.S)) ? Number(scored.S) : 100,
      color: scored?.color ?? GRADE_COLOR[grade] ?? LIGHT.RED,
      veto: scored?.veto === true,
      degraded: scored?.degraded === true || gradedDegraded(scored),
      signals: Array.isArray(scored?.signals) ? scored.signals.map(s => ({ id: s.id, weight: s.weight })) : [],
      reasons: Array.isArray(scored?.reasons) ? [...scored.reasons] : [],
      basis: scored?.basis ?? null,
      entry: scored?.entry ?? null,
      dir: scored?.dir ?? input.dir ?? null,
      cachedAt: started,
      fingerprint,
      durationMs: Math.max(0, now() - started),
      fromCache: false,
    }
    rememberGrade(assessment)
    store(key, { assessment, entryFile, fingerprint })
    emitPluginScored(assessment)
    return assessment
  }

  function gradedDegraded(scored) {
    const reasons = Array.isArray(scored?.reasons) ? scored.reasons : []
    return reasons.some(r => typeof r === 'string' && r.startsWith('scorer-'))
  }

  function gradeFor(evidence, opts) {
    if (opts && typeof opts.grade === 'string') return { grade: normalizeGrade(opts.grade), basis: 'explicit-grade' }
    if (opts && opts.assessment && typeof opts.assessment.grade === 'string') {
      return { grade: normalizeGrade(opts.assessment.grade), basis: 'assessment' }
    }
    if (evidence && typeof evidence.pluginGrade === 'string') {
      return { grade: normalizeGrade(evidence.pluginGrade), basis: 'evidence' }
    }
    const pluginId = String((opts && opts.pluginId) ?? evidence?.pluginId ?? '')
    if (pluginId && grades.has(pluginId)) return { grade: grades.get(pluginId), basis: 'cached-plugin-grade' }
    return { grade: 'E', basis: 'unscored-fail-closed' }
  }

  /** 动作评分：基础灯色 + 等级下限，只升不降。每次调用都重算，不缓存。 */
  function assessAction(evidence = {}, opts = {}) {
    const started = now()
    const base = baseLight(evidence, policyNow(), activeRules)
    const { grade, basis } = gradeFor(evidence, opts)
    const eff = effectiveLight(base.light, grade, { table: floors.table })
    return {
      light: eff.light,
      baseLight: eff.baseLight,
      gradeFloor: eff.gradeFloor,
      raised: eff.raised,
      pluginGrade: grade,
      gradeBasis: basis,
      matchedRule: base.matchedRule,
      category: base.category,
      tags: base.tags,
      lifecycle: base.lifecycle,
      credential: base.credential,
      reason: base.reason,
      evidence: base.evidence,
      tool: String(evidence?.tool ?? ''),
      target: base.target,
      path: base.path,
      durationMs: Math.max(0, now() - started),
      fromCache: false,
    }
  }

  /** 动作评分 + 决策矩阵 + 审计（一条 umbrella-decision）。 */
  function decideAction(evidence = {}, opts = {}) {
    const started = now()
    const assessment = assessAction(evidence, opts)
    const decision = decide(assessment)
    const record = {
      kind: AUDIT.UMBRELLA_DECISION,
      at: now(),
      tool: assessment.tool || null,
      target: assessment.target?.value ? { kind: assessment.target.kind, value: assessment.target.value } : null,
      pluginId: String((opts && opts.pluginId) ?? evidence?.pluginId ?? '') || null,
      pluginGrade: assessment.pluginGrade,
      gradeBasis: assessment.gradeBasis,
      baseLight: assessment.baseLight,
      light: assessment.light,
      matchedRule: assessment.matchedRule,
      category: assessment.category,
      evidence: assessment.evidence,
      decision: decision.decision,
      severity: decision.severity,
      durationMs: Math.max(0, now() - started),
    }
    auditRecord(record)
    return { ...assessment, decision: decision.decision, severity: decision.severity, decisionRecord: record }
  }

  function cacheStats() {
    return { ...stats, size: cache.size, capacity: maxCache }
  }

  function invalidate(keyOrPluginId) {
    const text = String(keyOrPluginId ?? '')
    let removed = 0
    for (const key of [...cache.keys()]) {
      if (key === text || key.endsWith(`:${text}`)) {
        cache.delete(key)
        removed += 1
      }
    }
    if (grades.delete(text)) removed += 1
    stats.invalidations += removed
    return removed
  }

  function clearCache() {
    const size = cache.size
    cache.clear()
    grades.clear()
    stats.invalidations += size
    return size
  }

  return {
    get policy() {
      return policyNow()
    },
    floorTable: floors.name,
    floorDegraded: floors.degraded,
    grades: floors.table,
    assessPlugin,
    assessAction,
    decideAction,
    baseLight: (evidence) => baseLight(evidence, policyNow(), activeRules),
    gradeFloor: (grade) => gradeFloor(grade, { table: floors.table }),
    effectiveLight: (base, grade) => effectiveLight(base, grade, { table: floors.table }),
    cachedGrade: (pluginId) => grades.get(String(pluginId)) ?? null,
    cacheStats,
    invalidate,
    clearCache,
    // 规则表：只读视图 + 唯一的三种变更入口（都做形状校验并以 id 定位）
    get rules() {
      return activeRules.rules.slice()
    },
    get ruleRegistry() {
      return registry
    },
    ruleIds: () => activeRules.ids(),
    registerRule: (rule, opts) => activeRules.register(rule, opts),
    overrideRule: (id, patch) => activeRules.override(id, patch),
    removeRule: (id) => activeRules.remove(id),
    resetRules: () => activeRules.reset(),
  }
}

export const _internals = {
  compilePatterns,
  withinPath,
  resolvePathValue,
  networkAllowed,
  execLooksReadOnly,
  resolveEvidencePath,
  pluginKeyOf,
  sha1,
  mtimeOf,
  firstPattern,
  writeTargetsOf,
  readTargetsOf,
  DEFAULT_CREDENTIAL_PATTERNS,
  DEFAULT_DESTRUCTIVE_PATTERNS,
  DEFAULT_LIFECYCLE_PATTERNS,
  DEFAULT_LIFECYCLE_TOOLS,
  READ_ONLY_EXEC_PATTERNS,
  TOOL_MODE,
}
