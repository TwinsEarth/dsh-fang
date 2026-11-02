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
  const sessionsDir = path.join(bundleDir, 'sessions')
  const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/
  const MAX_FILES = Math.max(1, Math.floor(Number(options.maxFiles) || 2000))
  const MAX_TOTAL_BYTES = Math.max(1, Math.floor(Number(options.maxTotalBytes) || 512 * 1024 * 1024))
  const MAX_FILE_BYTES = Math.max(1, Math.floor(Number(options.maxFileBytes) || 64 * 1024 * 1024))
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, SYNC_MANIFEST), 'utf8')) } catch {
    return { ok: false, code: 'manifest-unreadable' }
  }
  const conflicts = []
  const pulled = []
  const pendingMatch = []
  const skipped = []
  let fileCount = 0
  let totalBytes = 0
  for (const entry of Array.isArray(manifest.sessions) ? manifest.sessions : []) {
    if (fileCount >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) { skipped.push(String(entry?.sessionId ?? '')); continue }
    const sessionId = String(entry?.sessionId ?? '')
    if (!SAFE_SEGMENT.test(sessionId)) { skipped.push(sessionId || '<invalid>'); continue }
    const ws = workspaces.find((w) => w.path && entry.workspacePath && w.path === entry.workspacePath)
      ?? workspaces.find((w) => w.title && entry.workspaceTitle && w.title === entry.workspaceTitle)
    if (!ws || !ws.path) { pendingMatch.push(sessionId); continue }
    const workspaceKey = encodeWorkspaceKey(ws.path)
    const destDir = path.resolve(targetRoot, workspaceKey, sessionId)
    // v3.0.5/B3：目标必须落在 targetRoot 内（防 `../` 写出根外）
    if (!destDir.startsWith(targetRoot + path.sep)) { skipped.push(sessionId); continue }
    const destFile = path.join(destDir, SESSION_LOG)
    const src = path.resolve(bundleDir, 'sessions', String(entry.file ?? ''))
    // v3.0.5/B3：源必须落在 bundleDir/sessions 内（防 `../../` 读取 bundle 外文件）
    if (!src.startsWith(sessionsDir + path.sep)) { skipped.push(sessionId); continue }
    if (!fs.existsSync(src)) { skipped.push(sessionId); continue }
    const stat = fs.statSync(src)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) { skipped.push(sessionId); continue }
    const buf = fs.readFileSync(src)
    totalBytes += buf.length
    fileCount += 1
    if (sha256(buf) !== entry.sha256) { skipped.push(sessionId); continue }
    fs.mkdirSync(destDir, { recursive: true })
    if (fs.existsSync(destFile)) {
      fs.writeFileSync(path.join(destDir, `${SESSION_LOG}.fork-${Date.now()}-${conflicts.length}.jsonl.zstd`), buf)
      conflicts.push(sessionId)
      continue
    }
    fs.writeFileSync(destFile, buf)
    pulled.push(sessionId)
  }
  return { ok: true, pulled, conflicts, pendingMatch, skipped }
}
