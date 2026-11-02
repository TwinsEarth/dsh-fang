// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// dsh-Fang 保护伞 — 规则配置层（YAML 子集 + schema 校验）的 TypeScript 参考实现（v2.8.5）。
//
// 与运行时 `src/lib/rule-registry.mjs` 的 v2.8.x 语义保持一致：
//   * YAML 子集：块映射 / 序列 / 引号标量 / flow 列表 / flow 映射 / 注释；
//   * 拒绝锚点、多文档、块标量（明确报错，不猜）；
//   * schema 逐条校验（version / settings / 规则字段 / matcher kind / pattern 限制）；
//   * 正则安全启发式（拒绝明显灾难回溯形状与超长模式）。
//
// 本文件不 import 任何 `node:` 内建模块（types/ 目录的约定：纯编译、可移值）。

import type { ActionCategory, Light } from './types.js'

export const RULE_CONFIG_VERSION = 1

export const MATCHER_KINDS = [
  'command-pattern', 'path-pattern', 'path-outside',
  'url-host-in', 'url-host-not-in', 'tool-in', 'pid-equal', 'always', 'never',
] as const
export type MatcherKind = (typeof MATCHER_KINDS)[number]

export const EVIDENCE_KINDS = ['pattern-match', 'list-match', 'static'] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

/** 内置规则的默认优先级（越小越先匹配；同优先级按内置顺序）。 */
export const DEFAULT_RULE_PRIORITIES: Readonly<Record<string, number>> = {
  'dsh-lifecycle': 10,
  'destructive-command': 20,
  'credential-access': 30,
  'network-allowlisted': 40,
  'network-egress': 50,
  'dynamic-import': 60,
  'write-in-buffer': 70,
  'write-in-allowlist': 80,
  'write-production': 90,
  'write-outside-buffer': 100,
  'exec-read-only': 110,
  'exec-side-effect': 120,
  'read-in-buffer': 130,
  'read-outside-buffer': 140,
  'unknown-tool': 9999,
}

export interface RegexPatternConfig {
  readonly re: string
  readonly label?: string
}

export interface DeclarativeMatcher {
  readonly kind: MatcherKind
  /** command-pattern / path-pattern */
  readonly patterns?: readonly RegexPatternConfig[]
  /** path-pattern 作用域 */
  readonly scope?: 'target' | 'read' | 'write' | 'all'
  /** path-outside */
  readonly root?: '$bufferRoot' | '$productionRoot' | 'literal'
  readonly literal?: string
  readonly checkAllowPaths?: boolean
  /** url-host-in / url-host-not-in */
  readonly hosts?: readonly string[]
  /** tool-in */
  readonly tools?: readonly string[]
  /** pid-equal：数字或 '$currentPid' */
  readonly pid?: number | '$currentPid'
}

export interface DeclarativeEvidence {
  readonly kind: EvidenceKind
  readonly payload?: Readonly<Record<string, unknown>>
}

export interface RuleOverride {
  readonly id: string
  readonly enabled?: boolean
  readonly light?: Light
  readonly priority?: number
  readonly reason?: string
  readonly tags?: readonly string[]
  readonly category?: ActionCategory
  readonly pathPatterns?: readonly RegexPatternConfig[]
  readonly commandPatterns?: readonly RegexPatternConfig[]
  /** 存在即声明式新规则（不能与内置 id 冲突语义由 registry 处理） */
  readonly match?: DeclarativeMatcher
  readonly evidence?: DeclarativeEvidence
}

export interface RuleConfigSettings {
  readonly failOnUnknownRule: boolean
  readonly failOnInvalidPattern: boolean
  readonly rejectUnsafeRegex: boolean
}

export interface RuleConfig {
  readonly version: number
  /** v2.8.2：false = 严格模式（丢弃此层之前的可调规则，只保留硬规则 + 兜底） */
  readonly inherit: boolean
  readonly settings: RuleConfigSettings
  readonly rules: readonly RuleOverride[]
}

export interface YamlParseResult {
  readonly value: unknown
  readonly errors: readonly string[]
}

export interface RuleConfigValidationResult {
  readonly config: RuleConfig | null
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
}

export const DEFAULT_SETTINGS: RuleConfigSettings = {
  failOnUnknownRule: false,
  failOnInvalidPattern: false,
  rejectUnsafeRegex: true,
}

// ── YAML 子集解析（与 .mjs 实现同语义）──────────────────────────────────────

function unescapeDouble(text: string): string {
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

function parseScalar(raw: string): unknown {
  const text = String(raw).trim()
  if (text.length === 0) return null
  if (text === 'null' || text === '~') return null
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10)
  if (/^-?\d+\.\d+$/.test(text)) return Number.parseFloat(text)
  if ((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('{') && text.endsWith('}'))) {
    const isList = text.startsWith('[')
    const inner = text.slice(1, -1).trim()
    if (inner.length === 0) return isList ? [] : {}
    const parts = splitFlowParts(inner)
    if (isList) return parts.map((part) => parseScalar(part))
    const mapping: Record<string, unknown> = {}
    for (const part of parts) {
      const colon = findFlowColon(part)
      if (colon < 0) {
        mapping[unquoteFlowKey(part)] = null
        continue
      }
      mapping[unquoteFlowKey(part.slice(0, colon))] = parseScalar(part.slice(colon + 1))
    }
    return mapping
  }
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) return unescapeDouble(text.slice(1, -1))
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1)
  return text
}

function stripComment(line: string): string {
  let inSingle = false
  let inDouble = false
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === '#' && !inSingle && !inDouble) {
      if (index === 0 || /\s/.test(line[index - 1] ?? '')) return line.slice(0, index)
    }
  }
  return line
}

function splitFlowParts(inner: string): string[] {
  const parts: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let depth = 0
  for (const ch of inner) {
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (!inSingle && !inDouble) {
      if (ch === '[' || ch === '{') depth += 1
      else if (ch === ']' || ch === '}') depth -= 1
      else if (ch === ',' && depth === 0) {
        parts.push(current)
        current = ''
        continue
      }
    }
    current += ch
  }
  if (current.trim().length > 0) parts.push(current)
  return parts
}

function findFlowColon(part: string): number {
  let inSingle = false
  let inDouble = false
  let depth = 0
  for (let index = 0; index < part.length; index += 1) {
    const ch = part[index]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (!inSingle && !inDouble) {
      if (ch === '[' || ch === '{') depth += 1
      else if (ch === ']' || ch === '}') depth -= 1
      else if (ch === ':' && depth === 0) return index
    }
  }
  return -1
}

/** 极简 YAML 子集解析：返回 { value, errors }；错误逐条给出，绝不静默。 */
export function parseYamlSubset(text: string): YamlParseResult {
  const errors: string[] = []
  if (/\t/.test(text.split(/\r?\n/).filter((line) => /^\t|\t(?=\S)/.test(line) && !line.trimStart().startsWith('#')).join('\n'))) {
    errors.push('tab indentation is not supported; use spaces')
  }
  if (/^---\s*$/m.test(text)) errors.push('multi-document YAML is not supported (---)')
  if (text.includes('<<:') || /^\s*\*\w+/.test(text)) errors.push('YAML anchors/aliases are not supported')
  if (errors.length > 0) return { value: null, errors }

  const lines: Array<{ indent: number; content: string; raw: string; no: number }> = []
  const rawLines = text.split(/\r?\n/)
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index] ?? ''
    const stripped = stripComment(raw)
    if (stripped.trim().length === 0) continue
    const indent = stripped.length - stripped.trimStart().length
    lines.push({ indent, content: stripped.trim(), raw: stripped, no: index + 1 })
  }

  let cursor = 0
  const lineAt = (index: number) => lines[index]

  const parseBlock = (indent: number): unknown => {
    const first = lineAt(cursor)
    if (first === undefined) return null
    if (first.content.startsWith('- ') || first.content === '-') return parseSequence(indent)
    return parseMapping(indent)
  }

  const parseSequence = (indent: number): unknown[] => {
    const items: unknown[] = []
    while (cursor < lines.length) {
      const line = lineAt(cursor)
      if (line === undefined || line.indent < indent) break
      if (line.indent > indent) { errors.push(`line ${line.no}: unexpected indentation`); break }
      if (!(line.content.startsWith('- ') || line.content === '-')) break
      const rest = line.content === '-' ? '' : line.content.slice(2).trim()
      cursor += 1
      if (rest.length === 0) {
        const next = lineAt(cursor)
        items.push(next !== undefined && next.indent > indent ? parseBlock(next.indent) : null)
        continue
      }
      const colon = findInlineColon(rest)
      if (colon > 0) {
        const item: Record<string, unknown> = {}
        const key = unquoteFlowKey(rest.slice(0, colon))
        const valueText = rest.slice(colon + 1).trim()
        if (valueText.length > 0) item[key] = parseScalar(valueText)
        else {
          const next = lineAt(cursor)
          item[key] = next !== undefined && next.indent > indent ? parseBlock(next.indent) : null
        }
        // 支持 `- id: x` 后跟同项更多键（缩进 = indent + 2）
        while (cursor < lines.length) {
          const sub = lineAt(cursor)
          if (sub === undefined || sub.indent !== indent + 2) break
          const subColon = findInlineColon(sub.content)
          if (subColon <= 0) break
          cursor += 1
          const subKey = unquoteFlowKey(sub.content.slice(0, subColon))
          const subValue = sub.content.slice(subColon + 1).trim()
          if (subValue.length > 0) item[subKey] = parseScalar(subValue)
          else {
            const nextLine = lineAt(cursor)
            item[subKey] = nextLine !== undefined && nextLine.indent > sub.indent ? parseBlock(nextLine.indent) : null
          }
        }
        items.push(item)
        continue
      }
      items.push(parseScalar(rest))
    }
    return items
  }

  const parseMapping = (indent: number): Record<string, unknown> => {
    const map: Record<string, unknown> = {}
    while (cursor < lines.length) {
      const line = lineAt(cursor)
      if (line === undefined || line.indent < indent) break
      if (line.indent > indent) { errors.push(`line ${line.no}: unexpected indentation`); break }
      const colon = findInlineColon(line.content)
      if (colon <= 0) { errors.push(`line ${line.no}: expected "key: value" or "- item"`); break }
      cursor += 1
      const key = unquoteFlowKey(line.content.slice(0, colon))
      const valueText = line.content.slice(colon + 1).trim()
      if (valueText.length > 0) map[key] = parseScalar(valueText)
      else {
        const next = lineAt(cursor)
        map[key] = next !== undefined && next.indent > indent ? parseBlock(next.indent) : null
      }
    }
    return map
  }

  const value = parseBlock(lines[0]?.indent ?? 0)
  return { value, errors }
}

function findInlineColon(text: string): number {
  let inSingle = false
  let inDouble = false
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === ':' && !inSingle && !inDouble) {
      const nextChar = text[index + 1]
      if (nextChar === undefined || /\s/.test(nextChar)) return index
    }
  }
  return -1
}

function unquoteFlowKey(raw: string): string {
  const text = String(raw).trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return unescapeDouble(text.slice(1, -1))
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1)
  return text
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 正则安全启发式：拒绝明显灾难回溯形状与超长模式。 */
export function isSafePatternSource(source: string): boolean {
  const text = String(source ?? '')
  if (text.length === 0 || text.length > 500) return false
  if (/\([^()]*[+*][^()]*\)[+*]/.test(text)) return false
  if (/\(\.[*+]\)[*+]/.test(text)) return false
  if (/\{\d{4,}(,\d*)?\}/.test(text)) return false
  return true
}

function normalizePatterns(value: unknown, errors: string[], path: string, rejectUnsafeRegex: boolean): RegexPatternConfig[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) { errors.push(`${path}: expected a list of { re, label? }`); return [] }
  if (value.length === 0) { errors.push(`${path}: expected 1..50 patterns`); return [] }
  if (value.length > 50) { errors.push(`${path}: at most 50 patterns`); return [] }
  const out: RegexPatternConfig[] = []
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index]
    if (!isPlainObject(entry)) { errors.push(`${path}[${index}]: expected { re, label? }`); continue }
    const re = entry['re']
    if (typeof re !== 'string' || re.length === 0) { errors.push(`${path}[${index}].re: expected non-empty string`); continue }
    if (re.length > 500) { errors.push(`${path}[${index}].re: longer than 500 chars`); continue }
    if (rejectUnsafeRegex && !isSafePatternSource(re)) { errors.push(`${path}[${index}].re: unsafe regex rejected (possible ReDoS)`); continue }
    const label = entry['label']
    out.push(label === undefined ? { re } : { re, label: String(label) })
  }
  return out
}

/** schema 校验：错误逐条给出；config 非空表示可应用（错误列表非空说明该层会被拒绝）。 */
export function validateRuleConfig(raw: unknown): RuleConfigValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  if (!isPlainObject(raw)) return { config: null, errors: ['config: expected a mapping'], warnings }
  if (raw['version'] !== RULE_CONFIG_VERSION) errors.push(`version: expected ${RULE_CONFIG_VERSION}`)
  if (raw['inherit'] !== undefined && typeof raw['inherit'] !== 'boolean') errors.push('inherit: expected boolean')
  const inherit = raw['inherit'] !== false
  const settings = isPlainObject(raw['settings']) ? raw['settings'] : {}
  const configSettings: RuleConfigSettings = {
    failOnUnknownRule: settings['failOnUnknownRule'] === true,
    failOnInvalidPattern: settings['failOnInvalidPattern'] === true,
    rejectUnsafeRegex: settings['rejectUnsafeRegex'] !== false,
  }
  for (const key of ['failOnUnknownRule', 'failOnInvalidPattern', 'rejectUnsafeRegex']) {
    if (settings[key] !== undefined && typeof settings[key] !== 'boolean') errors.push(`settings.${key}: expected boolean`)
  }
  const rulesRaw = raw['rules'] === undefined || raw['rules'] === null ? [] : raw['rules']
  if (!Array.isArray(rulesRaw)) errors.push('rules: expected a list')
  const rules: RuleOverride[] = []
  if (Array.isArray(rulesRaw)) {
    for (let index = 0; index < rulesRaw.length; index += 1) {
      const entry = rulesRaw[index]
      const at = `rules[${index}]`
      if (!isPlainObject(entry)) { errors.push(`${at}: expected a mapping`); continue }
      const id = entry['id']
      if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) { errors.push(`${at}.id: expected kebab-case id`); continue }
      if (entry['light'] !== undefined && !['green', 'blue', 'yellow', 'red'].includes(String(entry['light']))) errors.push(`${at}.light: expected green|blue|yellow|red`)
      if (entry['category'] !== undefined && typeof entry['category'] !== 'string') errors.push(`${at}.category: expected string`)
      if (entry['priority'] !== undefined && !Number.isFinite(entry['priority'])) errors.push(`${at}.priority: expected number`)
      if (entry['enabled'] !== undefined && typeof entry['enabled'] !== 'boolean') errors.push(`${at}.enabled: expected boolean`)
      const match = entry['match']
      const evidence = entry['evidence']
      if (match !== undefined) {
        if (!isPlainObject(match)) errors.push(`${at}.match: expected a mapping`)
        else {
          const kind = String(match['kind'] ?? '')
          if (!(MATCHER_KINDS as readonly string[]).includes(kind)) errors.push(`${at}.match.kind: unknown matcher "${kind}"`)
          else {
            if (kind === 'command-pattern') normalizePatterns(match['patterns'], errors, `${at}.match.patterns`, configSettings.rejectUnsafeRegex)
            if (kind === 'path-pattern') normalizePatterns(match['patterns'], errors, `${at}.match.patterns`, configSettings.rejectUnsafeRegex)
            if (kind === 'url-host-in' || kind === 'url-host-not-in') {
              if (!Array.isArray(match['hosts']) || match['hosts'].length === 0) errors.push(`${at}.match.hosts: expected non-empty list`)
            }
            if (kind === 'tool-in') {
              if (!Array.isArray(match['tools']) || match['tools'].length === 0) errors.push(`${at}.match.tools: expected non-empty list`)
            }
          }
        }
      }
      if (evidence !== undefined) {
        if (!isPlainObject(evidence)) errors.push(`${at}.evidence: expected a mapping`)
        else {
          const kind = String(evidence['kind'] ?? '')
          if (!(EVIDENCE_KINDS as readonly string[]).includes(kind)) errors.push(`${at}.evidence.kind: unknown evidence "${kind}"`)
        }
      }
      if (entry['pathPatterns'] !== undefined) normalizePatterns(entry['pathPatterns'], errors, `${at}.pathPatterns`, configSettings.rejectUnsafeRegex)
      if (entry['commandPatterns'] !== undefined) normalizePatterns(entry['commandPatterns'], errors, `${at}.commandPatterns`, configSettings.rejectUnsafeRegex)
      rules.push(entry as unknown as RuleOverride)
    }
  }
  if (errors.length > 0) return { config: null, errors, warnings }
  return {
    config: { version: RULE_CONFIG_VERSION, inherit, settings: configSettings, rules },
    errors,
    warnings,
  }
}
