// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// session-bundle — selected-session export/import for the sync mode.
//
// The unit is a session *directory* (`<workspaceKey>/<sessionId>/session.v4.jsonl.zstd`).
// Export is read-only on the source PC; import never overwrites: an existing target
// keeps both copies (`.fork-<ts>`), matching dsh-session-sync's keep-both semantics.
// This module is pure fs + zlib-free: it copies bytes and records sha256 manifests.

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { encodeWorkspaceKey } from './session-format.mjs'

export const SYNC_MANIFEST = 'manifest.json'
export const SESSION_LOG = 'session.v4.jsonl.zstd'

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

function walkSessionDirs(sessionsRoot) {
  const out = []
  let roots = []
  try { roots = fs.readdirSync(sessionsRoot, { withFileTypes: true }) } catch { return out }
  for (const root of roots) {
    if (!root.isDirectory()) continue
    const dir = path.join(sessionsRoot, root.name)
    let sessions = []
    try { sessions = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of sessions) {
      if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue
      const file = path.join(dir, entry.name, SESSION_LOG)
      if (!fs.existsSync(file)) continue
      out.push({ workspaceKey: root.name, sessionId: entry.name, dir: path.join(dir, entry.name), file })
    }
  }
  return out
}

/**
 * Export selected sessions into a staging bundle (read-only on the source).
 * @returns {{ok:true, bundleDir:string, manifest:object, exported:string[], skipped:string[], bytes:number}}
 */
export function exportSessions(options = {}) {
  const sessionsRoot = path.resolve(String(options.sessionsRoot ?? ''))
  const bundleDir = path.resolve(String(options.bundleDir ?? ''))
  if (!sessionsRoot || !bundleDir) return { ok: false, code: 'invalid-options' }
  const wanted = Array.isArray(options.sessionIds) ? options.sessionIds.map((x) => String(x)).filter(Boolean) : []
  const found = walkSessionDirs(sessionsRoot)
  const selected = wanted.length > 0 ? found.filter((row) => wanted.includes(row.sessionId)) : found
  const skipped = wanted.filter((id) => !found.some((row) => row.sessionId === id))
  fs.mkdirSync(bundleDir, { recursive: true })
  const workspaceByKey = new Map()
  for (const ws of Array.isArray(options.workspaces) ? options.workspaces : []) {
    if (ws && typeof ws.path === 'string') workspaceByKey.set(encodeWorkspaceKey(ws.path), ws)
  }
  const entries = []
  let bytes = 0
  for (const row of selected) {
    const destDir = path.join(bundleDir, 'sessions', row.workspaceKey, row.sessionId)
    fs.mkdirSync(destDir, { recursive: true })
    const buf = fs.readFileSync(row.file)
    fs.writeFileSync(path.join(destDir, SESSION_LOG), buf)
    bytes += buf.length
    const ws = workspaceByKey.get(row.workspaceKey) ?? null
    entries.push({
      sessionId: row.sessionId,
      workspaceKey: row.workspaceKey,
      workspacePath: ws?.path ?? null,
      workspaceTitle: ws?.title ?? null,
      bytes: buf.length,
      sha256: sha256(buf),
      file: `${row.workspaceKey}/${row.sessionId}/${SESSION_LOG}`,
      mtimeMs: fs.statSync(row.file).mtimeMs,
    })
  }
  const manifest = { version: 1, createdAt: new Date().toISOString(), source: sessionsRoot, sessions: entries, bytes }
  fs.writeFileSync(path.join(bundleDir, SYNC_MANIFEST), JSON.stringify(manifest, null, 2) + '\n')
  return { ok: true, bundleDir, manifest, exported: entries.map((e) => e.sessionId), skipped, bytes }
}

/**
 * Import a staging bundle into a target sessions root.
 * Matching is exact by workspace path first, then exact workspace title; a target
 * without that workspace goes to pendingMatch instead of guessing.
 * @returns {{ok:true, pulled:string[], conflicts:string[], pendingMatch:string[], skipped:string[]}}
 */
export function importSessions(options = {}) {
  const bundleDir = path.resolve(String(options.bundleDir ?? ''))
  const targetRoot = path.resolve(String(options.targetSessionsRoot ?? ''))
  const workspaces = Array.isArray(options.workspaces) ? options.workspaces : []
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, SYNC_MANIFEST), 'utf8')) } catch {
    return { ok: false, code: 'manifest-unreadable' }
  }
  const conflicts = []
  const pulled = []
  const pendingMatch = []
  const skipped = []
  for (const entry of Array.isArray(manifest.sessions) ? manifest.sessions : []) {
    const ws = workspaces.find((w) => w.path && entry.workspacePath && w.path === entry.workspacePath)
      ?? workspaces.find((w) => w.title && entry.workspaceTitle && w.title === entry.workspaceTitle)
    if (!ws || !ws.path) { pendingMatch.push(entry.sessionId); continue }
    const workspaceKey = encodeWorkspaceKey(ws.path)
    const destDir = path.join(targetRoot, workspaceKey, entry.sessionId)
    const destFile = path.join(destDir, SESSION_LOG)
    const src = path.join(bundleDir, 'sessions', entry.file)
    if (!fs.existsSync(src)) { skipped.push(entry.sessionId); continue }
    const buf = fs.readFileSync(src)
    if (sha256(buf) !== entry.sha256) { skipped.push(entry.sessionId); continue }
    fs.mkdirSync(destDir, { recursive: true })
    if (fs.existsSync(destFile)) {
      fs.writeFileSync(path.join(destDir, `${SESSION_LOG}.fork-${Date.now()}-${conflicts.length}.jsonl.zstd`), buf)
      conflicts.push(entry.sessionId)
      continue
    }
    fs.writeFileSync(destFile, buf)
    pulled.push(entry.sessionId)
  }
  return { ok: true, pulled, conflicts, pendingMatch, skipped }
}
