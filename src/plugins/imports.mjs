// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// 零依赖 import 层扫描器：手写 tokenizer（跳过注释/字符串），再扫 token 流
// 局限（必须如实声明）：只覆盖 **import 层**，不做调用层（exec/spawn）分析

const WORD_START = /[A-Za-z_$]/
const WORD_PART = /[A-Za-z0-9_$]/

/** 把源码切成 {t:'word'|'str'|'punct', v, line}，跳过注释与空白 */
export function tokenize(src) {
  const out = []
  let i = 0
  let line = 1
  const n = src.length

  const err = (msg) => { throw Object.assign(new Error(msg), { line }) }

  while (i < n) {
    const c = src[i]

    if (c === '\n') { line++; i++; continue }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue }

    // 行注释
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue }
    // 块注释
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++ }
      i += 2
      continue
    }

    // 字符串
    if (c === '"' || c === "'") {
      const q = c
      const startLine = line
      i++
      let v = ''
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { v += src[i + 1] ?? ''; i += 2; continue }
        if (src[i] === '\n') { line++; }
        v += src[i]; i++
      }
      i++ // 关引号
      out.push({ t: 'str', v, line: startLine, quote: q })
      continue
    }

    // 模板串：只取静态部分（含 ${} 的标为 tpl，specifier 判定时视为非字面量）
    if (c === '`') {
      const startLine = line
      i++
      let v = ''
      let dynamic = false
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { v += src[i + 1] ?? ''; i += 2; continue }
        if (src[i] === '$' && src[i + 1] === '{') {
          dynamic = true
          let depth = 1
          i += 2
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++
            else if (src[i] === '}') depth--
            else if (src[i] === '\n') line++
            i++
          }
          continue
        }
        if (src[i] === '\n') line++
        v += src[i]; i++
      }
      i++
      out.push({ t: 'str', v, line: startLine, tpl: true, dynamic })
      continue
    }

    // 标识符 / 关键字
    if (WORD_START.test(c)) {
      const start = i
      const startLine = line
      while (i < n && WORD_PART.test(src[i])) i++
      out.push({ t: 'word', v: src.slice(start, i), line: startLine })
      continue
    }

    // 其它一律当标点（单字符足够用于本扫描）
    out.push({ t: 'punct', v: c, line })
    i++
  }
  return out
}

const RE_SPECIFIER_FROM_IMPORT = new Set(['import', 'export'])

/**
 * 抽取 import 说明符。
 * kind: 'static' | 'side-effect' | 'dynamic' | 'require' | 'export-from'
 */
export function extractImports(tokens) {
  const imports = []
  const warnings = []

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.t !== 'word') continue

    // require('x')
    if (tok.v === 'require') {
      const a = tokens[i + 1], b = tokens[i + 2], c = tokens[i + 3]
      if (a?.t === 'punct' && a.v === '(' && b?.t === 'str' && c?.t === 'punct' && c.v === ')') {
        imports.push({ kind: 'require', specifier: b.v, line: tok.line, literal: !b.dynamic && !b.tpl })
      }
      continue
    }

    if (!RE_SPECIFIER_FROM_IMPORT.has(tok.v)) continue

    const next = tokens[i + 1]

    // import('x') —— 动态
    if (tok.v === 'import' && next?.t === 'punct' && next.v === '(') {
      const arg = tokens[i + 2]
      if (arg?.t === 'str') {
        imports.push({ kind: 'dynamic', specifier: arg.v, line: tok.line, literal: !arg.dynamic && !arg.tpl })
      } else {
        warnings.push({ line: tok.line, reason: 'dynamic-import-nonliteral' })
      }
      continue
    }

    // import 'x' —— 副作用
    if (tok.v === 'import' && next?.t === 'str') {
      imports.push({ kind: 'side-effect', specifier: next.v, line: tok.line, literal: !next.dynamic && !next.tpl })
      continue
    }

    // import ... from 'x' / export ... from 'x'
    // 向后最多 200 个 token 找 from；遇到 ';' 或 '=' 视为不是该语句
    let j = i + 1
    let found = null
    let limit = 0
    while (j < tokens.length && limit++ < 200) {
      const t = tokens[j]
      if (t.t === 'punct' && (t.v === ';' || t.v === '=')) break
      if (t.t === 'word' && t.v === 'from') { found = tokens[j + 1]; break }
      j++
    }
    if (found && found.t === 'str') {
      imports.push({
        kind: tok.v === 'import' ? 'static' : 'export-from',
        specifier: found.v,
        line: tok.line,
        literal: !found.dynamic && !found.tpl,
      })
    } else if (tok.v === 'import') {
      // import.meta / import x = ... / 纯类型导入失败等
      const maybe = tokens[i + 1]
      if (!(maybe?.t === 'punct' && maybe.v === '.')) warnings.push({ line: tok.line, reason: 'unparsed-import' })
    }
  }
  return { imports, warnings }
}

export function scanSource(src) {
  const tokens = tokenize(src)
  const { imports, warnings } = extractImports(tokens)
  return { imports, warnings, tokenCount: tokens.length }
}

// ─────────── 说明符 → 信号（只做 import 层） ───────────
const CHILD_PROCESS = new Set(['child_process', 'node:child_process'])
const NETWORK = new Set(['net', 'node:net', 'http', 'node:http', 'https', 'node:https',
  'dgram', 'node:dgram', 'tls', 'node:tls', 'http2', 'node:http2',
  'undici', 'node:undici', 'ws', 'axios', 'node-fetch', 'got'])
const FSCAP = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises'])
const VM = new Set(['vm', 'node:vm'])

export function importsToSignals(scan, pkg = {}) {
  const seen = new Set()
  const signals = []
  const evidence = {}
  const add = (id, weight, detail) => {
    if (seen.has(id)) { evidence[id].push(detail); return }
    seen.add(id)
    evidence[id] = [detail]
    signals.push({ id, weight, evidence: { modules: [detail] } })
  }
  for (const imp of scan.imports) {
    const s = imp.specifier
    if (CHILD_PROCESS.has(s)) add('S1-child_process', 30, s)
    else if (NETWORK.has(s)) add('S2-network', 20, s)
    else if (FSCAP.has(s)) add('S3-fs-capability', 15, s)
    else if (VM.has(s)) add('S4-vm', 25, s)
  }
  // 合并同一信号的多个模块
  for (const sig of signals) sig.evidence.modules = evidence[sig.id]
  return { signals, coverage: 'import-only' }
}
