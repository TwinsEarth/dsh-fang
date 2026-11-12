// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// dsh-Fang v2.8.0 — 可配置的动作规则表（YAML 叠加层）。
//
// 约束：本仓库零第三方运行时依赖（CI 与 profile 安装都依赖这一点），所以这里手写
//   * YAML **子集**解析器（块映射 / 序列 / 引号标量 / 简单 flow 列表 / 注释；不做锚点、多文档、块标量）
//   * 配置 schema 校验（手写，错误逐条给出）
//   * 声明式 matcher/evidence 编译器（只允许内置 kind，不能写任意 JS）
//   * RuleRegistry（内置规则 + YAML 叠加，事务化应用）
//   * 文件加载 + fs.watch 热加载（失败保留旧规则）
//
// 设计边界（刻意的）：
//   YAML 是「配置」不是「脚本」。match 是任意 JS 谓词，不可能安全地塞进 YAML；
//   因此 YAML 只能 (a) 开关内置规则、(b) 覆盖 light/priority/reason/tags/category、
//   (c) 给内置规则追加正则、(d) 用内置声明式 matcher 新增简单规则。
//   复杂谓词仍然写在代码里，用 id 引用。

import fs from 'node:fs'
import path from 'node:path'
import { ACTION_CATEGORIES, assertActionRule, DEFAULT_ACTION_RULES } from './umbrella.mjs'
import { LIGHT_RANK } from '../kernel/index.mjs'

/** 内置规则的默认优先级（越小越先匹配；同优先级按内置顺序）。 */
export const DEFAULT_RULE_PRIORITIES = Object.freeze({
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
})

export const RULE_CONFIG_VERSION = 1
export const MATCHER_KINDS = [
  'command-pattern', 'path-pattern', 'path-outside',
  'url-host-in', 'url-host-not-in', 'tool-in', 'pid-equal', 'always', 'never',
]
export const EVIDENCE_KINDS = ['pattern-match', 'list-match', 'static']
const MAX_PATTERN_LENGTH = 500
const MAX_PATTERNS = 50

// ─────────────────────────────────────────────────────────────────────────────
// 1. YAML 子集解析
// ─────────────────────────────────────────────────────────────────────────────

function stripComment(line) {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === '#' && !inSingle && !inDouble) return line.slice(0, i)
  }
  return line
}

function unescapeDouble(text) {
  return text.replace(/\\(["\\/nrt])/g, (_m, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c))
}

/** 按顶层逗号切分 flow 内容（尊重引号与嵌套 [] {}）。 */
function splitFlowParts(inner) {
  const parts = []
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

/** flow 映射里第一个顶层冒号位置（引号/嵌套外）；没有则 -1。 */
function findFlowColon(part) {
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

function unquoteFlowKey(raw) {
  const text = String(raw ?? '').trim()
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.startsWith('"') ? unescapeDouble(text.slice(1, -1)) : text.slice(1, -1)
  }
  return text
}

function parseScalar(raw) {
  const text = String(raw ?? '').trim()
  if (text.length === 0) return null
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return unescapeDouble(text.slice(1, -1))
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'")
  if ((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('{') && text.endsWith('}'))) {
    const isList = text.startsWith('[')
    const inner = text.slice(1, -1).trim()
    if (inner.length === 0) return isList ? [] : {}
    const parts = splitFlowParts(inner)
    if (isList) return parts.map((part) => parseScalar(part))
    const mapping = {}
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
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === '~') return null
  if (/^-?\d+$/.test(text)) return Number(text)
  if (/^-?\d+\.\d+$/.test(text)) return Number(text)
  return text
}

/**
 * 解析 YAML 子集。返回 { value, errors }。
 * 不支持的语法（锚点/别名/多文档/块标量/tab 缩进）会给出明确错误，由调用方 fail-safe 处理。
 */
export function parseYamlSubset(text) {
  const errors = []
  const tokens = []
  const lines = String(text ?? '').split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const noComment = stripComment(lines[index])
    if (noComment.trim().length === 0) continue
    if (noComment.startsWith('---') || noComment.startsWith('...')) {
      errors.push(`line ${index + 1}: multi-document YAML is not supported`)
      continue
    }
    const indentMatch = /^[ \t]*/.exec(noComment)[0]
    if (indentMatch.includes('\t')) {
      errors.push(`line ${index + 1}: tab indentation is not supported`)
      continue
    }
    tokens.push({ indent: indentMatch.length, content: noComment.trim(), line: index + 1 })
  }
  if (errors.length > 0) return { value: null, errors }

  const isSequenceLine = (token) => token.content === '-' || token.content.startsWith('- ')

  const parseBlock = (startIndex, indent) => {
    const first = tokens[startIndex]
    if (first === undefined) return [null, startIndex]
    if (isSequenceLine(first)) return parseSequence(startIndex, indent)
    return parseMapping(startIndex, indent)
  }

  const parseSequence = (startIndex, indent) => {
    const items = []
    let index = startIndex
    while (index < tokens.length) {
      const token = tokens[index]
      if (token.indent !== indent || !isSequenceLine(token)) break
      const rest = token.content === '-' ? '' : token.content.slice(2).trim()
      if (rest.length === 0) {
        const next = tokens[index + 1]
        if (next !== undefined && next.indent > indent) {
          const [child, nextIndex] = parseBlock(index + 1, next.indent)
          items.push(child)
          index = nextIndex
        } else {
          items.push(null)
          index += 1
        }
        continue
      }
      const inlineKey = /^([A-Za-z0-9_$.-]+):(?:\s|$)/.exec(rest)
      if (inlineKey !== null) {
        const virtualIndent = indent + 2
        const key = inlineKey[1]
        const restValue = rest.slice(inlineKey[0].length).trim()
        const mapped = {}
        if (restValue.length > 0) {
          const [folded, nextIndex] = foldContinuations({ content: restValue }, index + 1, virtualIndent)
          mapped[key] = parseScalar(folded)
          index = nextIndex - 1
        } else {
          const next = tokens[index + 1]
          if (next !== undefined && next.indent > virtualIndent) {
            const [child, nextIndex] = parseBlock(index + 1, next.indent)
            mapped[key] = child
            index = nextIndex - 1
          } else {
            mapped[key] = null
          }
        }
        // 同时解析续行的同级键（`- key: v` 后面按 indent+2 继续）
        index += 1
        while (index < tokens.length && tokens[index].indent === virtualIndent && !isSequenceLine(tokens[index])) {
          const line = tokens[index]
          const match = /^([A-Za-z0-9_$.-]+):(?:\s*(.*))?$/.exec(line.content)
          if (match === null) {
            errors.push(`line ${line.line}: expected "key: value" inside sequence item`)
            index += 1
            continue
          }
          const childKey = match[1]
          const childRest = String(match[2] ?? '').trim()
          if (childRest.length > 0) {
            const [folded, nextIndex] = foldContinuations({ content: childRest }, index + 1, virtualIndent)
            mapped[childKey] = parseScalar(folded)
            index = nextIndex
            continue
          }
          const nextToken = tokens[index + 1]
          if (nextToken !== undefined && nextToken.indent > virtualIndent) {
            const [child, nextIndex] = parseBlock(index + 1, nextToken.indent)
            mapped[childKey] = child
            index = nextIndex
          } else {
            mapped[childKey] = null
            index += 1
          }
        }
        items.push(mapped)
        continue
      }
      items.push(parseScalar(rest))
      index += 1
    }
    return [items, index]
  }

  // v3.1.31：折行纯量（plain scalar continuation）。
  // DSH 会把超长 description 折成多行，续行缩进更深、且既不是 "key:" 也不是 "- item"。
  // 结构行（映射键/序列项）一律不吸收，避免吞掉兄弟节点。
  const KEY_LINE = /^[A-Za-z0-9_$.-]+:(?:\s|$)/
  const isStructural = (token) => isSequenceLine(token) || KEY_LINE.test(token.content)
  const foldContinuations = (valueToken, startIndex, parentIndent) => {
    const parts = []
    let index = startIndex
    while (index < tokens.length) {
      const token = tokens[index]
      if (token.indent <= parentIndent) break
      if (isStructural(token)) break
      parts.push(token.content)
      index += 1
    }
    if (parts.length === 0) return [valueToken.content, startIndex]
    const first = valueToken.content
    const joined = [first, ...parts].join(" ")
    return [joined, index]
  }
  const parseMapping = (startIndex, indent) => {
    const mapping = {}
    let index = startIndex
    while (index < tokens.length) {
      const token = tokens[index]
      if (token.indent !== indent || isSequenceLine(token)) break
      const match = /^([A-Za-z0-9_$.-]+):(?:\s*(.*))?$/.exec(token.content)
      if (match === null) {
        errors.push(`line ${token.line}: expected "key: value" or "- item"`)
        index += 1
        continue
      }
      const key = match[1]
      const rest = String(match[2] ?? '').trim()
      if (rest.length > 0) {
        // v3.1.31：先吸收折行续行，再按纯量解析。
        const [folded, nextIndex] = foldContinuations({ content: rest }, index + 1, indent)
        mapping[key] = parseScalar(folded)
        index = nextIndex
        continue
      }
      const next = tokens[index + 1]
      if (next !== undefined && next.indent > indent) {
        const [child, nextIndex] = parseBlock(index + 1, next.indent)
        mapping[key] = child
        index = nextIndex
      } else {
        mapping[key] = null
        index += 1
      }
    }
    return [mapping, index]
  }

  const [value, endIndex] = parseBlock(0, tokens[0].indent)
  if (endIndex < tokens.length) {
    const leftover = tokens[endIndex]
    errors.push(`line ${leftover.line}: unexpected indentation / content`)
  }
  return { value, errors }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. schema 校验（手写；错误逐条给出，不做部分接受）
// ─────────────────────────────────────────────────────────────────────────────

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function checkPatternList(list, field, errors) {
  if (!Array.isArray(list)) {
    errors.push(`${field}: must be a list`)
    return
  }
  if (list.length === 0 || list.length > MAX_PATTERNS) {
    errors.push(`${field}: must contain 1..${MAX_PATTERNS} patterns`)
    return
  }
  for (const [index, pattern] of list.entries()) {
    if (!isPlainObject(pattern)) {
      errors.push(`${field}[${index}]: must be an object { re, label? }`)
      continue
    }
    if (typeof pattern.re !== 'string' || pattern.re.length === 0) {
      errors.push(`${field}[${index}].re: required non-empty string`)
      continue
    }
    if (pattern.re.length > MAX_PATTERN_LENGTH) {
      errors.push(`${field}[${index}].re: longer than ${MAX_PATTERN_LENGTH} chars`)
    }
    if (pattern.label !== undefined && (typeof pattern.label !== 'string' || pattern.label.length > 200)) {
      errors.push(`${field}[${index}].label: string ≤200 chars`)
    }
  }
}

function validateMatcher(match, field, errors) {
  if (!isPlainObject(match)) {
    errors.push(`${field}: must be an object with a "kind"`)
    return
  }
  const kind = match.kind
  if (!MATCHER_KINDS.includes(kind)) {
    errors.push(`${field}.kind: unknown matcher "${String(kind)}" (allowed: ${MATCHER_KINDS.join(', ')})`)
    return
  }
  if (kind === 'command-pattern') checkPatternList(match.patterns, `${field}.patterns`, errors)
  if (kind === 'path-pattern') {
    checkPatternList(match.patterns, `${field}.patterns`, errors)
    if (match.scope !== undefined && !['target', 'read', 'write', 'all'].includes(match.scope)) {
      errors.push(`${field}.scope: must be target|read|write|all`)
    }
  }
  if (kind === 'path-outside') {
    if (!['$bufferRoot', '$productionRoot', 'literal'].includes(match.root)) {
      errors.push(`${field}.root: must be $bufferRoot|$productionRoot|literal`)
    }
    if (match.root === 'literal' && typeof match.literal !== 'string') {
      errors.push(`${field}.literal: required when root=literal`)
    }
  }
  if (kind === 'url-host-in' || kind === 'url-host-not-in') {
    if (!Array.isArray(match.hosts) || match.hosts.length === 0 || match.hosts.length > 100) {
      errors.push(`${field}.hosts: list with 1..100 entries`)
    }
  }
  if (kind === 'tool-in') {
    if (!Array.isArray(match.tools) || match.tools.length === 0 || match.tools.length > 50) {
      errors.push(`${field}.tools: list with 1..50 entries`)
    }
  }
  if (kind === 'pid-equal') {
    const ok = match.pid === '$currentPid' || (typeof match.pid === 'number' && Number.isInteger(match.pid))
    if (!ok) errors.push(`${field}.pid: must be $currentPid or an integer`)
  }
}

function validateEvidence(evidence, field, errors) {
  if (evidence === undefined) return
  if (!isPlainObject(evidence)) {
    errors.push(`${field}: must be an object`)
    return
  }
  if (!EVIDENCE_KINDS.includes(evidence.kind)) {
    errors.push(`${field}.kind: unknown evidence "${String(evidence.kind)}" (allowed: ${EVIDENCE_KINDS.join(', ')})`)
    return
  }
  if (evidence.kind === 'static' && !isPlainObject(evidence.payload)) {
    errors.push(`${field}.payload: object required for kind=static`)
  }
}

/** 校验单个规则条目（overlay 或 declarative）。 */
export function validateRuleEntry(entry, index, errors) {
  const field = `rules[${index}]`
  if (!isPlainObject(entry)) {
    errors.push(`${field}: must be an object`)
    return
  }
  if (typeof entry.id !== 'string' || entry.id.length === 0 || entry.id.length > 100) {
    errors.push(`${field}.id: required string (1..100 chars)`)
  } else if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.id)) {
    errors.push(`${field}.id: must match ^[a-z0-9][a-z0-9-]*$`)
  }
  if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') errors.push(`${field}.enabled: boolean`)
  if (entry.light !== undefined && !Object.prototype.hasOwnProperty.call(LIGHT_RANK, entry.light)) {
    errors.push(`${field}.light: must be green|blue|yellow|red`)
  }
  if (entry.priority !== undefined && (!Number.isInteger(entry.priority) || entry.priority < 0 || entry.priority > 10000)) {
    errors.push(`${field}.priority: integer 0..10000`)
  }
  if (entry.reason !== undefined && (typeof entry.reason !== 'string' || entry.reason.length > 500)) {
    errors.push(`${field}.reason: string ≤500 chars`)
  }
  if (entry.tags !== undefined) {
    if (!Array.isArray(entry.tags) || entry.tags.length > 20 || entry.tags.some((t) => typeof t !== 'string')) {
      errors.push(`${field}.tags: list of ≤20 strings`)
    }
  }
  if (entry.category !== undefined && !ACTION_CATEGORIES.includes(entry.category)) {
    errors.push(`${field}.category: must be one of ${ACTION_CATEGORIES.join(', ')}`)
  }
  if (entry.match !== undefined) validateMatcher(entry.match, `${field}.match`, errors)
  if (entry.evidence !== undefined) validateEvidence(entry.evidence, `${field}.evidence`, errors)
  if (entry.pathPatterns !== undefined) checkPatternList(entry.pathPatterns, `${field}.pathPatterns`, errors)
  if (entry.commandPatterns !== undefined) checkPatternList(entry.commandPatterns, `${field}.commandPatterns`, errors)
}

/**
 * 校验整个配置。返回 { config, errors }；errors 非空时调用方必须回退（fail-safe）。
 */
export function validateRuleConfig(raw) {
  const errors = []
  if (!isPlainObject(raw)) return { config: null, errors: ['config: top level must be a mapping'] }
  if (raw.version !== RULE_CONFIG_VERSION) {
    errors.push(`version: must be ${RULE_CONFIG_VERSION}`)
  }
  if (raw.inherit !== undefined && typeof raw.inherit !== 'boolean') errors.push('inherit: boolean')
  const settings = isPlainObject(raw.settings) ? raw.settings : {}
  for (const key of ['failOnUnknownRule', 'failOnInvalidPattern', 'rejectUnsafeRegex']) {
    if (settings[key] !== undefined && typeof settings[key] !== 'boolean') errors.push(`settings.${key}: boolean`)
  }
  const rules = raw.rules ?? []
  if (!Array.isArray(rules)) {
    errors.push('rules: must be a list')
  } else {
    for (const [index, entry] of rules.entries()) validateRuleEntry(entry, index, errors)
  }
  if (errors.length > 0) return { config: null, errors }
  return {
    config: {
      version: RULE_CONFIG_VERSION,
      inherit: raw.inherit !== false,
      settings: {
        failOnUnknownRule: settings.failOnUnknownRule === true,
        failOnInvalidPattern: settings.failOnInvalidPattern === true,
        rejectUnsafeRegex: settings.rejectUnsafeRegex !== false,
      },
      rules,
    },
    errors: [],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 正则安全启发式（不是完整 ReDoS 检测，够挡住明显灾难回溯）
// ─────────────────────────────────────────────────────────────────────────────

export function isSafePatternSource(source) {
  const text = String(source ?? '')
  if (text.length === 0 || text.length > MAX_PATTERN_LENGTH) return false
  // 禁止嵌套量词：(a+)+ / (.*)* / (\w+)* 这类灾难回溯形状
  if (/\([^()]*[+*]\)[+*]/.test(text)) return false
  if (/\([^()]*\{\d+,\}\)[+*]/.test(text)) return false
  // 超过 200 的定长重复基本没有正当用途
  if (/\{\s*\d{3,}/.test(text)) return false
  return true
}

function compilePatterns(list, errors, labelPrefix) {
  const out = []
  for (const [index, pattern] of list.entries()) {
    if (!isSafePatternSource(pattern.re)) {
      errors.push(`${labelPrefix}[${index}]: unsafe or too long regex rejected`)
      continue
    }
    try {
      out.push({
        re: new RegExp(pattern.re, 'i'),
        id: pattern.id ?? pattern.label ?? String(pattern.re).slice(0, 40),
        label: pattern.label ?? String(pattern.re).slice(0, 40),
      })
    } catch (e) {
      errors.push(`${labelPrefix}[${index}]: invalid regex (${e?.message ?? e})`)
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 声明式 matcher / evidence 编译
// ─────────────────────────────────────────────────────────────────────────────

function hostMatches(host, pattern) {
  const p = String(pattern).toLowerCase()
  const h = String(host).toLowerCase()
  if (p.startsWith('*.')) return h.endsWith(p.slice(1))
  return h === p
}

function pathInside(child, parent) {
  if (typeof child !== 'string' || typeof parent !== 'string' || parent.length === 0) return false
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 编译声明式规则；返回 { rule, errors }（errors 非空时 rule 可能仍可用，调用方决定）。 */
export function compileDeclarativeRule(entry, { rejectUnsafeRegex = true } = {}) {
  const errors = []
  const patterns = {}
  const compile = (list, key) => {
    if (list === undefined) return []
    const compiled = compilePatterns(list, errors, `rules.${entry.id}.${key}`)
    if (rejectUnsafeRegex === false) {
      // 调用方显式关闭安全检查时，把因安全被拒的模式按原样重编译（仍要求语法合法）
      for (const [index, pattern] of list.entries()) {
        if (compiled.some((c) => c.source === pattern.re)) continue
        try {
          compiled.push({ re: new RegExp(pattern.re, 'i'), id: pattern.id ?? `p${index}`, label: pattern.label ?? pattern.re })
        } catch { /* 已记录为错误 */ }
      }
    }
    patterns[key] = compiled
    return compiled
  }

  const match = entry.match
  let matchFn = null
  const evidenceKind = entry.evidence?.kind ?? 'pattern-match'

  if (match !== undefined) {
    switch (match.kind) {
      case 'command-pattern': {
        const compiled = compile(match.patterns, 'commandPatterns')
        matchFn = (_ev, ctx) => compiled.some(({ re }) => re.test(ctx.commandText))
        break
      }
      case 'path-pattern': {
        const compiled = compile(match.patterns, 'pathPatterns')
        const scope = match.scope ?? 'all'
        matchFn = (_ev, ctx) => {
          const candidates = []
          if (scope === 'target' || scope === 'all') if (ctx.targetPath !== null) candidates.push(ctx.targetPath)
          if (scope === 'write' || scope === 'all') candidates.push(...ctx.writeTargets)
          if (scope === 'read' || scope === 'all') candidates.push(...ctx.readTargets)
          return candidates.some((p) => compiled.some(({ re }) => re.test(p)))
        }
        break
      }
      case 'path-outside': {
        const rootOf = (ev) => {
          if (match.root === '$bufferRoot') return ev?.context?.bufferRoot ?? null
          if (match.root === '$productionRoot') return ev?.context?.productionRoot ?? null
          return match.literal ?? null
        }
        const checkAllowPaths = match.checkAllowPaths !== false
        matchFn = (ev, ctx) => {
          if (ctx.targetPath === null) return false
          const root = rootOf({ context: { ...ev?.context, bufferRoot: ctx.policy.bufferRoot, productionRoot: ctx.policy.productionRoot } })
          if (root === null) return false
          if (pathInside(ctx.targetPath, root)) return false
          if (checkAllowPaths && ctx.policy.allowPaths.some((a) => pathInside(ctx.targetPath, a))) return false
          return true
        }
        break
      }
      case 'url-host-in': {
        matchFn = (_ev, ctx) => ctx.url !== null && match.hosts.some((h) => hostMatches(ctx.url.host, h))
        break
      }
      case 'url-host-not-in': {
        matchFn = (_ev, ctx) => ctx.url !== null && !match.hosts.some((h) => hostMatches(ctx.url.host, h))
        break
      }
      case 'tool-in': {
        const set = new Set(match.tools.map(String))
        matchFn = (ev) => set.has(String(ev?.tool ?? ''))
        break
      }
      case 'pid-equal': {
        matchFn = (_ev, ctx) => (match.pid === '$currentPid' ? ctx.targetPid === process.pid : ctx.targetPid === match.pid)
        break
      }
      case 'always': matchFn = () => true; break
      case 'never': matchFn = () => false; break
      default: errors.push(`rules.${entry.id}.match.kind: unsupported "${String(match.kind)}"`)
    }
  }

  let evidenceFn = null
  switch (evidenceKind) {
    case 'pattern-match': {
      evidenceFn = (_ev, ctx) => {
        const hits = [...(patterns.commandPatterns ?? []), ...(patterns.pathPatterns ?? [])]
          .filter(({ re }) => re.test(ctx.commandText) || (ctx.targetPath !== null && re.test(ctx.targetPath)) || ctx.writeTargets.some((t) => re.test(t)))
          .map((p) => p.id)
        return { matchedPattern: hits.length > 0 ? hits[0] : 'declarative-pattern', patternIds: hits }
      }
      break
    }
    case 'list-match': {
      evidenceFn = (_ev, ctx) => ({
        matchedPattern: 'declarative-list',
        writeTargets: ctx.writeTargets,
        readTargets: ctx.readTargets,
      })
      break
    }
    case 'static': {
      const payload = entry.evidence?.payload ?? {}
      evidenceFn = () => ({ ...payload })
      break
    }
    default:
      errors.push(`rules.${entry.id}.evidence.kind: unsupported "${String(evidenceKind)}"`)
  }

  if (matchFn === null || evidenceFn === null) return { rule: null, errors }

  const light = entry.light
  const category = entry.category
  const reason = entry.reason
  return {
    rule: {
      id: entry.id,
      category,
      light,
      reason,
      tags: entry.tags ?? [],
      match: matchFn,
      evidence: evidenceFn,
      source: 'yaml',
      priority: entry.priority,
    },
    errors,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. RuleRegistry：内置 + YAML 叠加（事务化）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object[]} builtinRules 默认 DEFAULT_ACTION_RULES
 * @param {{priorities?: Record<string, number>}} [options]
 */
/** 不可协商标签：带这些标签的规则不可被关闭、不可被降低灯色。 */
export const NON_NEGOTIABLE_TAGS = Object.freeze(['hard-deny', 'non-negotiable'])

export function isLockedRule(rule) {
  return Array.isArray(rule?.tags) && rule.tags.some((tag) => NON_NEGOTIABLE_TAGS.includes(tag))
}

/**
 * 分层规则注册表：内置规则 → YAML 层（基线 → 项目 → 环境，后层按 id 覆盖前层）。
 * 事务化：任何一层被判定 fatal 时整次 rebuild 被拒绝，effective 保持上一次有效值。
 *
 * @param {object[]} builtinRules
 * @param {{priorities?: Record<string, number>}} [options]
 */
export function createRuleRegistry(builtinRules = DEFAULT_ACTION_RULES, options = {}) {
  const builtin = [...builtinRules]
  const defaultPriorities = { ...DEFAULT_RULE_PRIORITIES, ...(options.priorities ?? {}) }
  let effective = []
  let layers = []
  let status = { source: 'builtin', appliedAt: null, warnings: [], errors: [], configVersion: null, layers: 0, strictMode: null }

  const priorityBase = (rule, priorities) => {
    const explicit = priorities[rule.id]
    if (Number.isFinite(explicit)) return explicit
    const index = builtin.findIndex((r) => r.id === rule.id)
    return index >= 0 ? index * 10 : 5000
  }

  const sortRules = (rules, priorities) => rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => {
      const pa = priorityBase(a.rule, priorities)
      const pb = priorityBase(b.rule, priorities)
      if (pa !== pb) return pa - pb
      return a.index - b.index
    })
    .map(({ rule }) => rule)

  const resetToBuiltin = () => {
    layers = []
    effective = sortRules(builtin, defaultPriorities)
    status = { source: 'builtin', appliedAt: Date.now(), warnings: [], errors: [], configVersion: null, layers: 0, strictMode: null }
    return effective
  }
  resetToBuiltin()

  /**
   * 纯计算：从内置 + 给定层序列构建候选规则表。**不修改** effective/status，
   * 由调用方在 applied 时提交——失败时三者全部保持上一次成功值。
   */
  const computeRebuild = (layerList) => {
    const warnings = []
    const errors = []
    const layerRecords = []
    const priorities = { ...defaultPriorities }
    let byId = new Map(builtin.map((rule) => [rule.id, rule]))
    let order = builtin.map((rule) => rule.id)
    const locked = new Set()
    const builtinById = new Map(builtin.map((rule) => [rule.id, rule]))

    // inherit:false = 严格模式：丢弃此前所有可调规则，只保留硬规则 + fallback，
    // 然后从该层开始叠加。硬规则与 fallback 不能被任何配置拆掉。
    let startIndex = 0
    for (let index = layerList.length - 1; index >= 0; index -= 1) {
      if (layerList[index].inherit === false) { startIndex = index; break }
    }
    const strictMode = startIndex > 0 || (layerList.length > 0 && layerList[0].inherit === false)
    let strictModeInfo = null
    if (strictMode) {
      const preserved = builtin.filter((rule) => isLockedRule(rule) || rule.category === 'fallback')
      byId = new Map(preserved.map((rule) => [rule.id, rule]))
      order = preserved.map((rule) => rule.id)
      for (const id of Object.keys(priorities)) if (!byId.has(id)) delete priorities[id]
      strictModeInfo = {
        activatedAt: Date.now(),
        layerIndex: startIndex,
        preservedHardRules: preserved.filter((rule) => isLockedRule(rule)).map((rule) => rule.id),
        preservedFallback: preserved.filter((rule) => rule.category === 'fallback').map((rule) => rule.id),
        discardedRuleCount: builtin.length - preserved.length,
      }
    }
    let fatal = false
    let lockViolation = false

    for (let layerIndex = startIndex; layerIndex < layerList.length; layerIndex += 1) {
      const layer = layerList[layerIndex]
      const layerErrors = []
      for (const entry of layer.rules) {
        const isDeclarative = entry.match !== undefined
        if (isDeclarative) {
          if (byId.has(entry.id)) warnings.push(`declarative rule "${entry.id}" shadows an existing rule`)
          const compiled = compileDeclarativeRule(entry, { rejectUnsafeRegex: layer.settings.rejectUnsafeRegex })
          layerErrors.push(...compiled.errors)
          if (compiled.rule !== null) {
            try {
              assertActionRule(compiled.rule)
              byId.set(compiled.rule.id, compiled.rule)
              if (!order.includes(compiled.rule.id)) order.push(compiled.rule.id)
              if (entry.priority !== undefined) priorities[compiled.rule.id] = entry.priority
              if (isLockedRule(compiled.rule)) locked.add(compiled.rule.id)
            } catch (e) {
              layerErrors.push(`rules.${entry.id}: ${e.message}`)
            }
          }
          continue
        }

        // 严格模式丢弃过内置规则后，后续层仍可按 id 引用它（重新引入内置定义再覆盖），
        // 这样 inherit:false 之后的 inherit:true 层是"叠加"而不是"必须重写谓词"。
        const base = byId.get(entry.id) ?? builtinById.get(entry.id)
        if (base === undefined) {
          const message = `unknown rule id "${entry.id}"`
          if (layer.settings.failOnUnknownRule) layerErrors.push(message)
          else warnings.push(message)
          continue
        }

        // 硬规则锁定：不可关闭、不可降低灯色（允许提升灯色 / 追加 pattern / 改 reason）
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
          if (entry.tags !== undefined) {
            const requiredTags = (base.tags ?? []).filter((tag) => NON_NEGOTIABLE_TAGS.includes(tag))
            const missingTags = requiredTags.filter((tag) => !Array.isArray(entry.tags) || !entry.tags.includes(tag))
            if (missingTags.length > 0) {
              layerErrors.push(`rule "${entry.id}" is non-negotiable; locked tags cannot be removed: ${missingTags.join(',')}`)
              lockViolation = true
              continue
            }
          }
          if (entry.priority !== undefined) {
            const currentPriority = priorities[base.id] ?? defaultPriorities[base.id] ?? 500
            if (entry.priority > currentPriority) {
              layerErrors.push(`rule "${entry.id}" is non-negotiable; priority cannot move later than ${currentPriority}`)
              lockViolation = true
              continue
            }
          }
        }

        if (entry.enabled === false) {
          byId.delete(entry.id)
          locked.delete(entry.id)
          continue
        }

        if (!byId.has(entry.id)) {
          if (!order.includes(entry.id)) order.push(entry.id)
          if (priorities[entry.id] === undefined) priorities[entry.id] = defaultPriorities[entry.id] ?? 500
        }
        let patched = {
          ...base,
          light: entry.light ?? base.light,
          reason: entry.reason ?? base.reason,
          tags: entry.tags ?? base.tags,
          category: entry.category ?? base.category,
        }
        if (entry.pathPatterns !== undefined || entry.commandPatterns !== undefined) {
          const patternErrors = []
          const pathPatterns = entry.pathPatterns === undefined
            ? []
            : compilePatterns(entry.pathPatterns, patternErrors, `rules.${entry.id}.pathPatterns`)
          const commandPatterns = entry.commandPatterns === undefined
            ? []
            : compilePatterns(entry.commandPatterns, patternErrors, `rules.${entry.id}.commandPatterns`)
          layerErrors.push(...patternErrors)
          const originalMatch = base.match
          patched = {
            ...patched,
            match: (ev, ctx) => {
              if (originalMatch(ev, ctx)) return true
              if (commandPatterns.some(({ re }) => re.test(ctx.commandText))) return true
              const candidates = [ctx.targetPath, ...ctx.writeTargets, ...ctx.readTargets].filter((x) => typeof x === 'string')
              return candidates.some((p) => pathPatterns.some(({ re }) => re.test(p)))
            },
          }
        }
        if (entry.priority !== undefined) priorities[entry.id] = entry.priority
        const merged = { ...patched, source: 'yaml' }
        byId.set(entry.id, merged)
        if (isLockedRule(merged)) locked.add(entry.id)
      }
      errors.push(...layerErrors)
      if (layer.settings.failOnInvalidPattern && layerErrors.length > 0) fatal = true
      if (layer.settings.failOnUnknownRule && layerErrors.some((e) => e.startsWith('unknown rule id'))) fatal = true
      layerRecords.push({ index: layerIndex, inherit: layer.inherit !== false, version: layer.version, rules: layer.rules.length, errors: layerErrors.length })
    }

    if (lockViolation) fatal = true
    const merged = order.map((id) => byId.get(id)).filter((rule) => rule !== undefined)
    const sorted = sortRules(merged, priorities)
    // 安全网：任何 rebuild 结果都必须有 fallback（未知动作的兜底）
    if (!sorted.some((rule) => rule.category === 'fallback')) {
      warnings.push('fallback rule missing after rebuild')
      fatal = true
    }
    const source = strictMode ? 'strict-replaced' : (layerList.length > 0 ? 'layered' : 'builtin')
    if (fatal) {
      // 失败：不提交任何状态（effective / status / strictMode 保持上一次成功值）
      return {
        applied: false,
        ruleCount: effective.length,
        warnings,
        errors,
        source,
        layers: layerRecords,
        strictMode: null,
        effective,
        status,
      }
    }
    const nextStatus = {
      source,
      appliedAt: Date.now(),
      warnings,
      errors,
      configVersion: layerList.at(-1)?.version ?? null,
      layers: layerList.length,
      strictMode: strictModeInfo,
    }
    return {
      applied: true,
      ruleCount: sorted.length,
      warnings,
      errors,
      source,
      layers: layerRecords,
      strictMode: strictModeInfo,
      effective: sorted,
      status: nextStatus,
    }
  }

  const find = (evidence, ctx) => effective.find((rule) => rule.match(evidence, ctx)) ?? effective[effective.length - 1] ?? null

  // 运行时注册（测试 / 嵌宿主用；YAML 只允许声明式）
  const register = (rule, placement = {}) => {
    assertActionRule(rule)
    if (rule.id !== undefined && effective.some((r) => r.id === rule.id)) {
      throw new Error(`action rule already registered: ${rule.id}（覆盖请用 override()）`)
    }
    const before = typeof placement.before === 'string' ? effective.findIndex((r) => r.id === placement.before) : -1
    const after = typeof placement.after === 'string' ? effective.findIndex((r) => r.id === placement.after) : -1
    const next = [...effective]
    if (before >= 0) next.splice(before, 0, rule)
    else if (after >= 0) next.splice(after + 1, 0, rule)
    else throw new Error(`action rule ${rule.id}: register() requires before/after naming an existing rule`)
    effective = next
    return rule
  }
  const override = (id, patch = {}) => {
    const index = effective.findIndex((r) => r.id === id)
    if (index < 0) throw new Error(`action rule not found: ${id}`)
    const merged = assertActionRule({ ...effective[index], ...patch, id })
    effective = [...effective.slice(0, index), merged, ...effective.slice(index + 1)]
    return merged
  }
  const remove = (id) => {
    const index = effective.findIndex((r) => r.id === id)
    if (index < 0) return false
    effective = [...effective.slice(0, index), ...effective.slice(index + 1)]
    return true
  }

  return {
    builtin,
    get rules() { return [...effective] },
    ids: () => effective.map((r) => r.id),
    find,
    register,
    override,
    remove,
    reset: resetToBuiltin,
    resetToBuiltin,
    /** 用一份配置替换所有层（向后兼容 v2.8.0 的单文件语义）。 */
    applyConfig(config) {
      const out = computeRebuild([config])
      if (out.applied) {
        layers = [config]
        effective = out.effective
        status = out.status
        return out
      }
      return { ...out, revertedToLayerIndex: layers.length - 1 }
    },
    /**
     * 追加一层（基线 → 项目 → 环境）。
     * 事务化：失败时 layers / effective / status / strictMode 全部保持上一次成功值，
     * 失败层对后续层完全不可见（否则坏层会污染后续所有 rebuild）。
     * 失败结果带 revertedToLayerIndex（-1 = 内置全集），供审计回答"回退到了哪一层"。
     */
    applyLayer(config) {
      const candidate = [...layers, config]
      const out = computeRebuild(candidate)
      if (out.applied) {
        layers = candidate
        effective = out.effective
        status = out.status
        return out
      }
      return { ...out, revertedToLayerIndex: layers.length - 1 }
    },
    clearLayers() {
      const out = computeRebuild([])
      if (out.applied) {
        layers = []
        effective = out.effective
        status = out.status
      }
      return out
    },
    layerCount: () => layers.length,
    status: () => ({ ...status, ruleCount: effective.length }),
    priorities: () => ({ ...defaultPriorities }),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. 文件加载 + 热加载
// ─────────────────────────────────────────────────────────────────────────────

/** 读取并校验规则文件。文件不存在 = {config:null, errors:[], found:false}（用纯内置）。 */
export function loadRuleConfigFile(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e?.code === 'ENOENT') return { config: null, errors: [], found: false }
    return { config: null, errors: [`read failed: ${e?.message ?? e}`], found: true }
  }
  const parsed = parseYamlSubset(text)
  if (parsed.errors.length > 0) return { config: null, errors: parsed.errors, found: true }
  const validated = validateRuleConfig(parsed.value)
  return { config: validated.config, errors: validated.errors, found: true }
}

export function watchRuleConfigFiles(files, onChange = () => {}, options = {}) {
  const debounceMs = Number(options.debounceMs) > 0 ? Number(options.debounceMs) : 200
  const logger = options.logger ?? null
  const list = [...new Set((Array.isArray(files) ? files : [files])
    .filter((file) => typeof file === 'string' && file.length > 0))]
  const watchers = []
  let timer = null
  let stopped = false

  const schedule = () => {
    if (stopped) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (stopped) return
      try { onChange() } catch (error) {
        try { logger?.warn?.(`[umbrella-rules] reload callback failed: ${error?.message ?? error}`) } catch { /* ignore */ }
      }
    }, debounceMs)
  }

  for (const file of list) {
    try {
      watchers.push(fs.watch(file, schedule))
      continue
    } catch { /* missing file: watch its directory */ }
    try {
      const dir = path.dirname(file)
      const base = path.basename(file)
      watchers.push(fs.watch(dir, (_event, name) => {
        if (!name || String(name) === base) schedule()
      }))
    } catch (error) {
      try { logger?.warn?.(`[umbrella-rules] cannot watch ${file}: ${error?.message ?? error}`) } catch { /* ignore */ }
    }
  }

  return {
    files: list,
    reload: schedule,
    stop() {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      for (const watcher of watchers) {
        try { watcher.close() } catch { /* ignore */ }
      }
      watchers.length = 0
    },
  }
}

/**
 * 热加载：文件变化 → 防抖 → 重新读取 → 应用。失败保留旧规则。
 * @returns {{ stop: () => void }}
 */
export function watchRuleConfigFile(file, registry, onResult = () => {}, options = {}) {
  const debounceMs = Number(options.debounceMs) > 0 ? Number(options.debounceMs) : 200
  const logger = options.logger ?? null
  let timer = null
  let watcher = null
  let stopped = false

  const reload = () => {
    if (stopped) return
    const loaded = loadRuleConfigFile(file)
    if (loaded.errors.length > 0) {
      try { logger?.warn?.(`[umbrella-rules] reload failed, keeping previous rules: ${loaded.errors.join('; ')}`) } catch { /* ignore */ }
      onResult({ applied: false, errors: loaded.errors, warnings: [], reason: 'load-failed' })
      return
    }
    if (loaded.config === null) {
      registry.resetToBuiltin()
      onResult({ applied: true, errors: [], warnings: [], reason: 'no-config', ruleCount: registry.rules.length })
      return
    }
    const applied = registry.applyConfig(loaded.config)
    if (!applied.applied) {
      try { logger?.warn?.(`[umbrella-rules] apply rejected, keeping previous rules: ${applied.errors.join('; ')}`) } catch { /* ignore */ }
    }
    onResult({ ...applied, reason: applied.applied ? 'applied' : 'rejected' })
  }

  try {
    watcher = fs.watch(file, () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        reload()
      }, debounceMs)
    })
    watcher.on?.('error', () => { /* watch 失败不致命：仍保留启动时加载的规则 */ })
  } catch {
    watcher = null
  }

  return {
    reload,
    stop() {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      try { watcher?.close() } catch { /* ignore */ }
      watcher = null
    },
  }
}
