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

export function isDestructiveCommand(evidence = {}, policy = normalizePolicy()) {
  const mode = modeOf(evidence)
  if (mode !== 'exec' && mode !== 'unknown') return false
  const target = targetOf(evidence)
  const text = target.kind === 'command' ? target.value : String(evidence?.args?.command ?? '')
  return matchesAny(compilePatterns(policy.destructivePatterns), text)
}

export function isDshLifecycleAction(evidence = {}, policy = normalizePolicy()) {
  const scope = String(evidence?.scope ?? evidence?.args?.scope ?? '').trim().toLowerCase()
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

/**
 * 基础灯色：只看动作本身，不看插件等级。
 * 规则顺序 = 危险度顺序，先命中先返回；返回值带 matchedRule 供审计追溯。
 */
export function baseLight(evidence = {}, policyInput = {}) {
  const policy = policyInput && policyInput.__normalized === true ? policyInput : normalizePolicy(policyInput ?? {})
  const mode = modeOf(evidence)
  const target = targetOf(evidence)

  // 1) DSH 生命周期动作：先判，让宿主动作走 restart-guard 的专用路径（委托，而不是直接问用户）
  if (isDshLifecycleAction(evidence, policy)) {
    return result(LIGHT.RED, 'dsh-lifecycle', { target, lifecycle: true })
  }
  // 2) 破坏性命令
  if (isDestructiveCommand(evidence, policy)) {
    return result(LIGHT.RED, 'destructive-command', { target })
  }
  // 3) 凭据访问：唯一硬拒绝的红灯
  if (isCredentialAccess(evidence, policy)) {
    return result(LIGHT.RED, 'credential-access', { target, credential: true })
  }
  // 4) 外连
  if (isNetworkEgress(evidence)) {
    if (networkAllowed(target.value, policy)) return result(LIGHT.BLUE, 'network-allowlisted', { target })
    return result(LIGHT.YELLOW, 'network-egress', { target })
  }
  // 5) 动态加载未评分模块
  if (isDynamicImport(evidence)) {
    return result(LIGHT.YELLOW, 'dynamic-import', { target })
  }
  // 6) 写：缓冲区内 / 允许列表内 → 蓝；生产区 / 越界 → 黄
  if (mode === 'write') {
    const abs = resolveEvidencePath(evidence, policy)
    if (policy.bufferRoot && abs && withinPath(abs, policy.bufferRoot)) {
      return result(LIGHT.BLUE, 'write-in-buffer', { target, path: abs })
    }
    if (inAllowList(abs, policy)) return result(LIGHT.BLUE, 'write-in-allowlist', { target, path: abs })
    if (policy.productionRoot && abs && withinPath(abs, policy.productionRoot)) {
      return result(LIGHT.YELLOW, 'write-production', { target, path: abs })
    }
    return result(LIGHT.YELLOW, 'write-outside-buffer', { target, path: abs })
  }
  // 7) shell：有副作用但不在只读白名单 → 黄；只读白名单 → 蓝（放行并记录）
  if (mode === 'exec') {
    if (execLooksReadOnly(evidence, policy)) return result(LIGHT.BLUE, 'exec-read-only', { target })
    const abs = resolveEvidencePath(evidence, policy)
    if (policy.bufferRoot && abs && withinPath(abs, policy.bufferRoot)) {
      return result(LIGHT.BLUE, 'write-in-buffer', { target, path: abs })
    }
    return result(LIGHT.YELLOW, 'exec-side-effect', { target, path: abs })
  }
  // 8) 读
  if (isReadOnly(evidence)) {
    const abs = resolveEvidencePath(evidence, policy)
    if (policy.bufferRoot && abs && withinPath(abs, policy.bufferRoot)) {
      return result(LIGHT.GREEN, 'read-in-buffer', { target, path: abs })
    }
    return result(LIGHT.BLUE, 'read-outside-buffer', { target, path: abs })
  }
  // 9) 兜底：不认识的工具 = 行为不可预测 → 黄
  return result(LIGHT.YELLOW, 'unknown-tool', { target })
}

function result(light, matchedRule, extra = {}) {
  return {
    light,
    matchedRule,
    lifecycle: extra.lifecycle === true,
    credential: extra.credential === true,
    target: extra.target ?? { kind: 'none', value: '' },
    path: extra.path ?? null,
    reason: REASON_TEXT[matchedRule] ?? matchedRule,
    ...(extra.meta ? { meta: extra.meta } : {}),
  }
}

const REASON_TEXT = {
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
  } = options

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
    const base = baseLight(evidence, policyNow())
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
      lifecycle: base.lifecycle,
      credential: base.credential,
      reason: base.reason,
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
    baseLight: (evidence) => baseLight(evidence, policyNow()),
    gradeFloor: (grade) => gradeFloor(grade, { table: floors.table }),
    effectiveLight: (base, grade) => effectiveLight(base, grade, { table: floors.table }),
    cachedGrade: (pluginId) => grades.get(String(pluginId)) ?? null,
    cacheStats,
    invalidate,
    clearCache,
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
  DEFAULT_CREDENTIAL_PATTERNS,
  DEFAULT_DESTRUCTIVE_PATTERNS,
  DEFAULT_LIFECYCLE_PATTERNS,
  READ_ONLY_EXEC_PATTERNS,
  TOOL_MODE,
}
