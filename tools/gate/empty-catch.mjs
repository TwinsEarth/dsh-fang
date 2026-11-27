// SPDX-License-Identifier: AGPL-3.0-or-later
// P3 empty-catch lint baseline. It does not rewrite 461 existing catches; it
// freezes the current per-file count so new bare `catch {}` blocks fail the
// gate. Existing catches can be cleaned directory by directory.
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const DEFAULT_BASELINE = path.join(ROOT, 'tools', 'gate', 'empty-catch-baseline.json')

function stripComments(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === '/' && next === '/') {
      i += 2
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch
      out += ch
      i += 1
      while (i < text.length) {
        const c = text[i]
        out += c
        i += 1
        if (c === '\\') { if (i < text.length) { out += text[i]; i += 1 } continue }
        if (c === quote) break
      }
      continue
    }
    out += ch
    i += 1
  }
  return out
}

function skipRegex(text, i) {
  i += 1
  let inClass = false
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) return i + 1
    else if (ch === '\n') return i
    i += 1
  }
  return i
}

function regexStart(text, i) {
  let j = i - 1
  while (j >= 0 && /\s/.test(text[j])) j -= 1
  if (j < 0) return true
  return /[=(:,;[!&|?{};+\-*%<>~^]/.test(text[j]) || /\b(?:return|case|typeof|instanceof|in|of|new|delete|void|throw|yield|await)\b/.test(text.slice(Math.max(0, j - 10), j + 1))
}

function skipString(text, i) {
  const quote = text[i]
  i += 1
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue }
    if (text[i] === quote) return i + 1
    i += 1
  }
  return i
}

function skipComment(text, i) {
  if (text[i] === '/' && text[i + 1] === '/') {
    i += 2
    while (i < text.length && text[i] !== '\n') i += 1
    return i
  }
  if (text[i] === '/' && text[i + 1] === '*') {
    i += 2
    while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
    return Math.min(text.length, i + 2)
  }
  return i
}

/** Find `catch (...) { ... }` bodies without being fooled by strings/comments. */
export function scanSource(source) {
  const rows = []
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\'' || ch === '"' || ch === '`') { i = skipString(source, i); continue }
    if (ch === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) { i = skipComment(source, i); continue }
    if (ch === '/' && regexStart(source, i)) { i = skipRegex(source, i); continue }
    if (source.startsWith('catch', i) && !/[A-Za-z0-9_$]/.test(source[i - 1] ?? '')) {
      let j = i + 5
      while (/\s/.test(source[j] ?? '')) j += 1
      if (source[j] === '(') {
        let depth = 0
        for (; j < source.length; j += 1) {
          if (source[j] === '\'' || source[j] === '"' || source[j] === '`') { j = skipString(source, j) - 1; continue }
          if (source[j] === '/' && (source[j + 1] === '/' || source[j + 1] === '*')) { j = skipComment(source, j) - 1; continue }
          if (source[j] === '/' && regexStart(source, j)) { j = skipRegex(source, j) - 1; continue }
          if (source[j] === '(') depth += 1
          if (source[j] === ')') { depth -= 1; if (depth === 0) { j += 1; break } }
        }
      }
      while (/\s/.test(source[j] ?? '')) j += 1
      if (source[j] === '{') {
        const start = j + 1
        let depth = 1
        j += 1
        for (; j < source.length; j += 1) {
          const c = source[j]
          if (c === '\'' || c === '"' || c === '`') { j = skipString(source, j) - 1; continue }
          if (c === '/' && (source[j + 1] === '/' || source[j + 1] === '*')) { j = skipComment(source, j) - 1; continue }
          if (c === '/' && regexStart(source, j)) { j = skipRegex(source, j) - 1; continue }
          if (c === '{') depth += 1
          if (c === '}') { depth -= 1; if (depth === 0) break }
        }
        const body = source.slice(start, j)
        const code = stripComments(body).trim()
        rows.push({ line: source.slice(0, i).split('\n').length, body, empty: code === '', bare: body.trim() === '' })
        const bodyStartLine = source.slice(0, start).split('\n').length
        for (const nested of scanSource(body)) rows.push({ ...nested, line: bodyStartLine + nested.line - 1 })
      }
      i = j + 1
      continue
    }
    i += 1
  }
  return rows
}

export function compareCounts(baseline, current) {
  const violations = []
  for (const [file, count] of Object.entries(current)) {
    const old = baseline[file] ?? { empty: 0, bare: 0 }
    if (count.empty > (old.empty ?? 0)) violations.push({ file, kind: 'empty', before: old.empty ?? 0, after: count.empty })
    if (count.bare > (old.bare ?? 0)) violations.push({ file, kind: 'bare', before: old.bare ?? 0, after: count.bare })
  }
  return violations
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

function collect(root) {
  const files = walk(path.join(root, 'src'))
  const byFile = {}
  const byDir = {}
  for (const file of files) {
    const rel = path.relative(root, file).replace(/\\/g, '/')
    const rows = scanSource(fs.readFileSync(file, 'utf8'))
    if (rows.length === 0) continue
    const empty = rows.filter((row) => row.empty).length
    const bare = rows.filter((row) => row.bare).length
    if (empty === 0) continue
    byFile[rel] = { empty, bare }
    const dir = path.posix.dirname(rel)
    byDir[dir] ??= { files: 0, empty: 0, bare: 0 }
    byDir[dir].files += 1
    byDir[dir].empty += empty
    byDir[dir].bare += bare
  }
  return { byFile, byDir }
}

function summarize(data) {
  const totals = Object.values(data.byFile).reduce((acc, row) => ({
    files: acc.files + 1, empty: acc.empty + row.empty, bare: acc.bare + row.bare,
  }), { files: 0, empty: 0, bare: 0 })
  return totals
}

function printReport(data, violations = []) {
  const totals = summarize(data)
  console.log(`empty-catch: ${totals.empty} in ${totals.files} files (bare ${totals.bare}, commented ${totals.empty - totals.bare})`)
  for (const [dir, row] of Object.entries(data.byDir).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${dir}: ${row.empty} (bare ${row.bare}, files ${row.files})`)
  }
  if (violations.length) {
    console.error('empty-catch gate FAILED: new or increased bare catch blocks')
    for (const v of violations) console.error(`  ${v.file}: ${v.kind} ${v.before} -> ${v.after}`)
    return 1
  }
  console.log('empty-catch gate PASS')
  return 0
}

function main() {
  const args = process.argv.slice(2)
  const rootArg = args.find((arg) => arg.startsWith('--root='))
  const root = rootArg ? path.resolve(rootArg.slice('--root='.length)) : ROOT
  const baselineArg = args.find((arg) => arg.startsWith('--baseline='))
  const baselinePath = baselineArg ? path.resolve(baselineArg.slice('--baseline='.length)) : DEFAULT_BASELINE
  const update = args.includes('--update')
  const data = collect(root)
  const totals = summarize(data)
  if (update) {
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true })
    fs.writeFileSync(baselinePath, `${JSON.stringify({
      generatedAt: new Date().toISOString(), root, totals, files: data.byFile,
    }, null, 2)}\n`)
    console.log(`empty-catch baseline written: ${baselinePath}`)
    printReport(data)
    return 0
  }
  let baseline
  try { baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) } catch {
    console.error(`empty-catch baseline missing: ${baselinePath}`)
    return 1
  }
  const violations = compareCounts(baseline.files ?? {}, data.byFile)
  if (args.includes('--json')) console.log(JSON.stringify({ totals, byDir: data.byDir, violations }, null, 2))
  return printReport(data, violations)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exitCode = main()
}
