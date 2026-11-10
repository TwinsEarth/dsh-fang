// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang kernel — filesystem helpers.
// All disk mutation used by Fang plugins goes through here so that:
//   * writes are atomic (tmp + rename),
//   * tree removal is junction-safe (never follows a reparse point into the mother),
//   * digests are stable across platforms.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
  return p
}

export function exists(p) {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function readTextSafe(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return fallback
  }
}

let _tmpSeq = 0
export function tmpName(dir, stem = 'tmp') {
  _tmpSeq = (_tmpSeq + 1) % 1e9
  return path.join(dir, `.${stem}.${process.pid}.${Date.now().toString(36)}.${_tmpSeq}.tmp`)
}

export function writeFileAtomic(file, data) {
  ensureDir(path.dirname(file))
  const tmp = tmpName(path.dirname(file), path.basename(file))
  fs.writeFileSync(tmp, data)
  try {
    fs.renameSync(tmp, file)
  } catch {
    // Windows can refuse a rename while a reader holds the file open; retry once, then fall back.
    try {
      fs.copyFileSync(tmp, file)
    } finally {
      try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    }
  }
  return file
}

export function writeJsonAtomic(file, value, { indent = 2 } = {}) {
  return writeFileAtomic(file, JSON.stringify(value, null, indent) + '\n')
}

export function appendJsonl(file, record) {
  ensureDir(path.dirname(file))
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
  return record
}

/** Read a JSONL file into records; unparsable lines are skipped (verifyChain reports them). */
export function readJsonl(file) {
  const out = []
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch { return out }
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t)) } catch { /* skip */ }
  }
  return out
}

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex')
}

export function sha256File(file) {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

/** Stable recursive digest of a tree: sorted rel paths + content hash; links carry their target. */
export function digestTree(dir, { maxFiles = 20000 } = {}) {
  const out = {}
  let files = 0
  const walk = (d, rel = '') => {
    let names
    try { names = fs.readdirSync(d).sort() } catch { return }
    for (const n of names) {
      if (files >= maxFiles) return
      const abs = path.join(d, n)
      const r = rel ? rel + '/' + n : n
      let st
      try { st = fs.lstatSync(abs) } catch { continue }
      if (st.isSymbolicLink()) {
        try { out[r] = 'link:' + fs.readlinkSync(abs) } catch { out[r] = 'link:?' }
        files++
        continue
      }
      if (st.isDirectory()) { walk(abs, r); continue }
      out[r] = sha256File(abs)
      files++
    }
  }
  walk(dir)
  return out
}

export function diffDigests(before, after) {
  const added = []
  const removed = []
  const changed = []
  for (const [k, v] of Object.entries(after ?? {})) {
    if (!(k in (before ?? {}))) added.push(k)
    else if (before[k] !== v) changed.push(k)
  }
  for (const k of Object.keys(before ?? {})) if (!(k in (after ?? {}))) removed.push(k)
  return { added, removed, changed, same: Object.keys(after ?? {}).length - added.length - changed.length }
}

/** Copy a tree. Symlinks/junctions are recreated as junctions, never traversed.
 *  Safe when `to` lives inside `from`: the destination is created only after the
 *  source listing is taken, and the destination itself is never re-entered. */
export function copyTree(from, to, { filter = null } = {}) {
  let names
  try { names = fs.readdirSync(from) } catch {
    ensureDir(to)
    return to
  }
  ensureDir(to)
  const toAbs = path.resolve(to)
  for (const n of names) {
    const src = path.join(from, n)
    const dst = path.join(to, n)
    if (filter && !filter(n, src)) continue
    if (path.resolve(src) === toAbs) continue
    let st
    try { st = fs.lstatSync(src) } catch { continue }
    if (st.isSymbolicLink()) {
      try {
        const target = fs.readlinkSync(src)
        fs.symlinkSync(target, dst, 'junction')
      } catch { /* ignore */ }
      continue
    }
    if (st.isDirectory()) { copyTree(src, dst, { filter }); continue }
    ensureDir(path.dirname(dst))
    try { fs.copyFileSync(src, dst) } catch { /* ignore */ }
  }
  return to
}

export function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Copy a tree with hardlinked files: directories are recreated, ordinary files are
 * hardlinked (same volume only; falls back to a copy), and links are recreated as links
 * rather than traversed. Used when the essence runtime's touched packages must be
 * materialized into the essence module tree without duplicating file bytes and without
 * junction cycles (the runtime mirror would otherwise point back at the essence tree).
 * @param {string} from Source directory.
 * @param {string} to Destination directory (created; expected to be empty/new).
 * @returns {string} The destination.
 */
export function hardlinkTree(from, to) {
  let names
  try { names = fs.readdirSync(from) } catch {
    ensureDir(to)
    return to
  }
  ensureDir(to)
  for (const name of names) {
    const src = path.join(from, name)
    const dst = path.join(to, name)
    let st
    try { st = fs.lstatSync(src) } catch { continue }
    if (st.isSymbolicLink()) {
      let target = ''
      try { target = fs.readlinkSync(src) } catch { continue }
      try {
        const absolute = path.isAbsolute(target) ? target : path.resolve(from, target)
        const stTarget = fs.lstatSync(absolute)
        if (stTarget.isDirectory()) fs.symlinkSync(absolute, dst, 'junction')
        else fs.copyFileSync(absolute, dst)
      } catch { /* an unmirrorable link is skipped */ }
      continue
    }
    if (st.isDirectory()) { hardlinkTree(src, dst); continue }
    try { fs.linkSync(src, dst) } catch {
      try { fs.copyFileSync(src, dst) } catch { /* skip */ }
    }
  }
  return to
}

/** Create (or replace) a Windows junction / POSIX dir symlink. */
export function makeJunction(target, linkPath) {
  ensureDir(path.dirname(linkPath))
  if (exists(linkPath)) return linkPath
  fs.symlinkSync(path.resolve(target), linkPath, 'junction')
  return linkPath
}

/**
 * Replace `dest` with a real directory that mirrors `source`'s top-level entries:
 * directories become junctions to their real targets, plain root files are copied.
 * Package contents are never copied, so the module tree stays shared — but every
 * entry is its own link. That is what DSH's profile-scope resolver needs: an
 * importer below a linked root gets the installation's `@deepseek-ai/*` packages
 * supplied (subject to the peer declaration), while a single whole-node_modules
 * junction leaves the importer outside every known scope. Measured consequence of
 * the whole-tree link: plugins that lazily `import('@deepseek-ai/dsh-tools')` in a
 * fork fall back to their offline shim — w2m's shim stamps `required: false` into a
 * property schema, and the provider rejects every request with
 * `Invalid schema for function 'w2m_report'` (v3.1.7 report).
 * Junction-safe: a reparse point in `dest` is unlinked, never entered; link targets
 * are resolved with realpath first so a link-to-link (pnpm) also lands on a dir.
 * @param {string} source Directory whose entries are mirrored (the module tree).
 * @param {string} dest Directory to replace with the mirror.
 * @returns {{ok:boolean, links:string[], files:string[], error?:string}}
 */
export function mirrorModuleTree(source, dest) {
  const src = path.resolve(String(source ?? ''))
  if (!exists(src)) return { ok: false, links: [], files: [], error: 'source-missing' }
  let srcStat
  try { srcStat = fs.lstatSync(src) } catch { return { ok: false, links: [], files: [], error: 'source-unreadable' } }
  if (!srcStat.isDirectory() && !srcStat.isSymbolicLink()) return { ok: false, links: [], files: [], error: 'source-not-directory' }
  removeTree(dest)
  ensureDir(dest)
  const links = []
  const files = []
  let names = []
  try { names = fs.readdirSync(src) } catch { names = [] }
  for (const name of names) {
    const from = path.join(src, name)
    const to = path.join(dest, name)
    let real = from
    try {
      if (fs.lstatSync(from).isSymbolicLink()) real = fs.realpathSync(from)
    } catch { continue }
    let targetStat
    try { targetStat = fs.statSync(real) } catch { continue }
    if (targetStat.isDirectory()) {
      try {
        fs.symlinkSync(path.resolve(real), to, 'junction')
        links.push(name)
      } catch { /* an unmirrorable entry is skipped; the remaining tree still boots */ }
      continue
    }
    try {
      fs.copyFileSync(from, to)
      files.push(name)
    } catch { /* ignore */ }
  }
  return { ok: true, links, files }
}

/**
 * Repair a profile `node_modules` that is still a whole-tree junction (v3.1.6 and
 * older) into the per-entry mirror form. A real directory is left untouched.
 * @param {string} modulesPath The profile's node_modules path.
 * @returns {{ok:boolean, changed:boolean, links?:string[], files?:string[], source?:string, error?:string}}
 */
export function ensureModuleMirror(modulesPath) {
  const p = String(modulesPath ?? '')
  if (!p || !exists(p)) return { ok: false, changed: false, error: 'node-modules-missing' }
  let st
  try { st = fs.lstatSync(p) } catch { return { ok: false, changed: false, error: 'node-modules-unreadable' } }
  if (!st.isSymbolicLink()) return { ok: true, changed: false, links: [], files: [] }
  let source
  try { source = fs.realpathSync(p) } catch { return { ok: false, changed: false, error: 'node-modules-target-missing' } }
  const mirrored = mirrorModuleTree(source, p)
  return { ...mirrored, changed: true, source }
}

/**
 * Remove a file or directory tree. Junction-safe: a reparse point is unlinked,
 * its target is never entered. This is the ONLY removal path plugins may use on
 * fork homes, because a fork home contains a node_modules junction to the mother.
 */
export function removeTree(target) {
  let st
  try { st = fs.lstatSync(target) } catch { return false }
  if (st.isSymbolicLink()) {
    try { fs.unlinkSync(target); return true } catch { return false }
  }
  if (!st.isDirectory()) {
    try { fs.unlinkSync(target); return true } catch { return false }
  }
  let names = []
  try { names = fs.readdirSync(target) } catch { names = [] }
  for (const n of names) removeTree(path.join(target, n))
  try { fs.rmdirSync(target) } catch { /* ignore */ }
  return true
}

export function listFiles(dir, { max = 5000 } = {}) {
  const out = []
  const walk = (d, rel = '') => {
    if (out.length >= max) return
    let names
    try { names = fs.readdirSync(d).sort() } catch { return }
    for (const n of names) {
      if (out.length >= max) return
      const abs = path.join(d, n)
      const r = rel ? rel + '/' + n : n
      let st
      try { st = fs.lstatSync(abs) } catch { continue }
      if (st.isDirectory()) walk(abs, r)
      else out.push(r)
    }
  }
  walk(dir)
  return out
}

export function nowMs() {
  return Date.now()
}

export function iso(ms = Date.now()) {
  return new Date(ms).toISOString()
}
// NOTE: `sleep` lives in core.mjs only — two `export *` sources exporting the same
// name make the whole kernel barrel un-importable (`conflicting star exports`).
