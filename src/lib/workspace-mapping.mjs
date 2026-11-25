// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// v3.8.2 only stopped *new* data from using E:\DSH\DS. Existing fork homes
// still carried workspace metadata that pointed at the shared host/project tree.
// This module maps those legacy paths into the fork's own home and rewrites the
// workspace index + first session header frame. It never deletes old workspace
// files; it only redirects Fang-owned metadata and keeps a rollback manifest.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { encodeWorkspaceKey, SESSION_LOG_FILE } from './session-format.mjs'

export const DEFAULT_LEGACY_WORKSPACE_ROOTS = [
  'E:\\DSH\\DS',
  'E:\\DSH',
  'E:\\DS',
  'D:\\DSH\\DS',
  'D:\\DSH',
  'D:\\DS',
]
export const WORKSPACE_MAP_DIR = '_workspace-map'
export const WORKSPACE_MAP_MANIFEST = 'mappings.json'
export const LEGACY_WORKSPACE_MODE = 'redirect-only'
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function trimPath(value) {
  return String(value ?? '').trim().replace(/[\\/]+$/, '')
}

/** Compare Windows-style paths without letting the current OS reinterpret the drive. */
export function normalizeWorkspacePath(value) {
  return trimPath(value).replace(/\\/g, '/').toLowerCase()
}

export function isLegacyWorkspacePath(value, roots = DEFAULT_LEGACY_WORKSPACE_ROOTS) {
  const target = normalizeWorkspacePath(value)
  if (!target) return false
  return (Array.isArray(roots) ? roots : []).some((root) => {
    const base = normalizeWorkspacePath(root)
    return Boolean(base) && (target === base || target.startsWith(base + '/'))
  })
}

function splitWindowsPath(value) {
  const parts = trimPath(value).split(/[\\/]+/).filter(Boolean)
  const drive = parts[0] && /^[a-zA-Z]:$/.test(parts[0]) ? parts.shift().slice(0, 1) : ''
  return { drive, parts }
}

export function legacyWorkspaceSlug(value) {
  const { drive, parts } = splitWindowsPath(value)
  const rest = parts.map((part) => part.replace(/[^a-zA-Z0-9_.-]/g, '_'))
  return [drive ? `drive-${drive.toUpperCase()}` : 'unc', ...rest].filter(Boolean).join('-') || 'legacy'
}

/** Redirect target under the fork home. Ownership stays in the fork; no shared-tree path remains. */
export function mappedWorkspacePath(homeDir, legacyPath) {
  const home = String(homeDir ?? '')
  if (!home) throw new Error('workspace-map: no homeDir')
  const { drive, parts } = splitWindowsPath(legacyPath)
  const rest = parts.map((part) => part.replace(/[^a-zA-Z0-9_.-]/g, '_'))
  return path.join(home, 'workspace', 'legacy', drive ? `drive-${drive.toUpperCase()}` : 'unc', ...rest)
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function atomicWriteJson(file, value) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function backupFile(homeDir, label, file) {
  if (!fs.existsSync(file)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(homeDir, WORKSPACE_MAP_DIR, 'backup', `${label}-${stamp}${path.extname(file) || '.bak'}`)
  ensureDir(path.dirname(dest))
  fs.copyFileSync(file, dest)
  return dest
}

function firstJsonHeader(text) {
  const first = String(text ?? '').split(/\r?\n/)[0]
  if (!first) return null
  try {
    const doc = JSON.parse(first)
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : null
  } catch { return null }
}

/** Read only the first session header frame/line, without touching event frames. */
export function readSessionHeaderCwd(file) {
  const target = String(file ?? '')
  let bytes
  try { bytes = fs.readFileSync(target) } catch { return null }
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(ZSTD_MAGIC)) {
    let offset = 4
    while (true) {
      const next = bytes.indexOf(ZSTD_MAGIC, offset)
      const end = next > 0 ? next : bytes.length
      try {
        const decoded = zlib.zstdDecompressSync(bytes.subarray(0, end))
        const doc = firstJsonHeader(Buffer.from(decoded).toString('utf8'))
        if (doc && typeof doc.cwd === 'string') return doc.cwd
      } catch { /* false magic or truncated candidate */ }
      if (next <= 0) return null
      offset = next + 4
    }
  }
  const text = bytes.toString('utf8')
  const doc = firstJsonHeader(text.split(/\r?\n/)[0])
  return typeof doc?.cwd === 'string' ? doc.cwd : null
}

/**
 * Rewrite only the first session frame (the header). The rest of the multi-frame
 * zstd file is copied byte-for-byte, so a multi-gigabyte event log is not decoded.
 * @returns {{ok:boolean, changed:boolean, reason:string, frameEnd?:number}}
 */
export function rewriteSessionHeaderCwd(file, oldCwd, newCwd) {
  const source = String(file ?? '')
  const target = path.resolve(source)
  const before = String(oldCwd ?? '')
  const after = String(newCwd ?? '')
  if (!before || !after || normalizeWorkspacePath(before) === normalizeWorkspacePath(after)) {
    return { ok: false, changed: false, reason: 'bad-path' }
  }
  let bytes
  try { bytes = fs.readFileSync(target) } catch { return { ok: false, changed: false, reason: 'read-failed' } }

  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(ZSTD_MAGIC)) {
    let offset = 4
    let frameEnd = -1
    let header = null
    while (true) {
      const next = bytes.indexOf(ZSTD_MAGIC, offset)
      const end = next > 0 ? next : bytes.length
      try {
        const decoded = zlib.zstdDecompressSync(bytes.subarray(0, end))
        const doc = firstJsonHeader(Buffer.from(decoded).toString('utf8'))
        if (doc) { header = doc; frameEnd = end; break }
      } catch { /* false magic or truncated candidate */ }
      if (next <= 0) break
      offset = next + 4
    }
    if (!header || frameEnd <= 0) return { ok: false, changed: false, reason: 'header-frame-not-found' }
    if (normalizeWorkspacePath(header.cwd) !== normalizeWorkspacePath(before)) {
      return { ok: true, changed: false, reason: 'cwd-not-old', frameEnd }
    }
    header.cwd = after
    if (Object.prototype.hasOwnProperty.call(header, 'workspacePath')) header.workspacePath = after
    const frame = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'))
    fs.writeFileSync(target, Buffer.concat([frame, bytes.subarray(frameEnd)]))
    return { ok: true, changed: true, reason: 'rewritten-zstd', frameEnd }
  }

  // Tests and older hosts may use plain JSONL. Keep the first line only.
  const text = bytes.toString('utf8')
  const newline = text.indexOf('\n')
  const headerText = newline >= 0 ? text.slice(0, newline) : text
  const header = firstJsonHeader(headerText)
  if (!header) return { ok: false, changed: false, reason: 'header-not-json' }
  if (normalizeWorkspacePath(header.cwd) !== normalizeWorkspacePath(before)) {
    return { ok: true, changed: false, reason: 'cwd-not-old' }
  }
  header.cwd = after
  if (Object.prototype.hasOwnProperty.call(header, 'workspacePath')) header.workspacePath = after
  const rest = newline >= 0 ? text.slice(newline + 1) : ''
  fs.writeFileSync(target, `${JSON.stringify(header)}\n${rest}`, 'utf8')
  return { ok: true, changed: true, reason: 'rewritten-text' }
}

/**
 * Map one workspace path. For legacy paths the target directory is created and
 * a mapping marker is written; no file from the old workspace is copied.
 */
export function mapWorkspacePathForFork(homeDir, workspacePath, {
  roots = DEFAULT_LEGACY_WORKSPACE_ROOTS,
  forkId = '',
  writeMarker = true,
} = {}) {
  const original = String(workspacePath ?? '').trim()
  if (!original) return { ok: true, mapped: false, path: '', original: '', slug: '', key: '' }
  if (!isLegacyWorkspacePath(original, roots)) {
    return { ok: true, mapped: false, path: original, original: original, slug: '', key: encodeWorkspaceKey(original) }
  }
  const mapped = mappedWorkspacePath(homeDir, original)
  ensureDir(mapped)
  if (writeMarker) {
    const marker = path.join(mapped, '.fang-workspace-map.json')
    try {
      atomicWriteJson(marker, {
        version: 1,
        mode: LEGACY_WORKSPACE_MODE,
        originalPath: original,
        mappedPath: mapped,
        forkId: String(forkId ?? ''),
        createdAt: new Date().toISOString(),
        note: 'Fang redirected this session workspace into the fork home. Old workspace files were not copied or deleted.',
      })
    } catch { /* marker failure does not make the path unsafe */ }
  }
  return {
    ok: true, mapped: true, path: mapped, original,
    slug: legacyWorkspaceSlug(original), key: encodeWorkspaceKey(mapped),
  }
}

function listSessionDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch { return [] }
}

function mergeWorkspaceEntry(index, entryId, entry, mappedPath, oldKey, newKey) {
  const tables = index.tables.workspaces
  const sessionIds = [...new Set([...(entry.sessionIds ?? [])])]
  // If an earlier run already created the mapped entry, merge it and keep one id.
  for (const [otherId, other] of Object.entries(tables)) {
    if (otherId === entryId) continue
    if (normalizeWorkspacePath(other?.path) !== normalizeWorkspacePath(mappedPath)) continue
    for (const id of other.sessionIds ?? []) if (!sessionIds.includes(id)) sessionIds.push(id)
    delete tables[otherId]
    const ids = Array.isArray(index.global.workspaceIds) ? index.global.workspaceIds : []
    index.global.workspaceIds = ids.filter((id) => id !== otherId)
    if (index.global.defaultWorkspaceId === otherId) index.global.defaultWorkspaceId = entryId
  }
  tables[entryId] = {
    ...entry,
    path: mappedPath,
    sessionIds,
    updatedAt: new Date().toISOString(),
    workspaceMapping: {
      mode: LEGACY_WORKSPACE_MODE,
      originalPath: String(entry.path ?? ''),
      oldWorkspaceKey: oldKey,
      newWorkspaceKey: newKey,
      at: new Date().toISOString(),
    },
  }
}

/**
 * Migrate an existing fork home. Synchronous and idempotent. Moves only Fang's
 * session directories inside the fork home; never touches the legacy workspace.
 */
export function migrateForkWorkspace(homeDir, {
  roots = DEFAULT_LEGACY_WORKSPACE_ROOTS,
  forkId = '',
} = {}) {
  const home = String(homeDir ?? '')
  if (!home) return { ok: false, error: 'no-home-dir', changed: false, mappings: [], moved: [], conflicts: [] }
  const indexFile = path.join(home, 'storages', 'workspace.json')
  if (!fs.existsSync(indexFile)) return { ok: true, changed: false, mappings: [], moved: [], conflicts: [], indexFile }
  let index
  try { index = readJson(indexFile) } catch (error) {
    return { ok: false, error: 'workspace-index-invalid', detail: String(error?.message ?? error), changed: false, mappings: [], moved: [], conflicts: [] }
  }
  index.tables = index.tables && typeof index.tables === 'object' ? index.tables : {}
  index.tables.workspaces = index.tables.workspaces && typeof index.tables.workspaces === 'object' ? index.tables.workspaces : {}
  index.global = index.global && typeof index.global === 'object' ? index.global : {}
  index.global.workspaceIds = Array.isArray(index.global.workspaceIds) ? index.global.workspaceIds : []

  const mappings = []
  const moved = []
  const conflicts = []
  for (const [entryId, entry] of Object.entries(index.tables.workspaces)) {
    const original = String(entry?.path ?? '').trim()
    if (!isLegacyWorkspacePath(original, roots)) continue
    const mapped = mappedWorkspacePath(home, original)
    ensureDir(mapped)
    const oldKey = encodeWorkspaceKey(original)
    const newKey = encodeWorkspaceKey(mapped)
    if (oldKey !== newKey) {
      const oldDir = path.join(home, 'sessions', oldKey)
      ensureDir(path.join(home, 'sessions', newKey))
      for (const sessionId of listSessionDirs(oldDir)) {
        const from = path.join(oldDir, sessionId, SESSION_LOG_FILE)
        const toDir = path.join(home, 'sessions', newKey, sessionId)
        if (fs.existsSync(toDir)) {
          conflicts.push({ sessionId, reason: 'destination-exists', from: path.join(oldDir, sessionId), to: toDir })
          continue
        }
        if (!fs.existsSync(from)) {
          conflicts.push({ sessionId, reason: 'session-log-missing', from: path.join(oldDir, sessionId) })
          continue
        }
        const backup = backupFile(home, sessionId, from)
        const headerCwd = readSessionHeaderCwd(from)
        let rewriteFrom = original
        if (headerCwd && normalizeWorkspacePath(headerCwd) !== normalizeWorkspacePath(original)) {
          if (!isLegacyWorkspacePath(headerCwd, roots)) {
            conflicts.push({ sessionId, reason: 'header-cwd-mismatch', headerCwd, from, to: mapped })
            continue
          }
          rewriteFrom = headerCwd
        }
        const rewritten = headerCwd == null
          ? { ok: false, changed: false, reason: 'header-not-readable' }
          : rewriteSessionHeaderCwd(from, rewriteFrom, mapped)
        if (rewritten.ok !== true) {
          conflicts.push({ sessionId, reason: `header-rewrite-${rewritten.reason}`, from, backup })
          continue
        }
        try {
          ensureDir(path.dirname(toDir))
          fs.renameSync(path.join(oldDir, sessionId), toDir)
          moved.push({ sessionId, fromKey: oldKey, toKey: newKey, headerChanged: rewritten.changed === true, backup })
        } catch (error) {
          conflicts.push({ sessionId, reason: 'move-failed', from: path.join(oldDir, sessionId), to: toDir, error: String(error?.message ?? error), backup })
        }
      }
    }
    mergeWorkspaceEntry(index, entryId, entry, mapped, oldKey, newKey)
    mappings.push({
      entryId, originalPath: original, mappedPath: mapped, oldKey, newKey,
      mode: LEGACY_WORKSPACE_MODE, at: new Date().toISOString(),
    })
  }

  if (mappings.length === 0) {
    return { ok: true, changed: false, mappings, moved, conflicts, indexFile }
  }
  const workspaceBackup = backupFile(home, 'workspace', indexFile)
  // The manifest is written before the index so a crash mid-write still has the
  // rollback facts; the index backup is the authoritative old copy.
  const manifestFile = path.join(home, WORKSPACE_MAP_DIR, WORKSPACE_MAP_MANIFEST)
  let prior = { version: 1, mappings: [] }
  try { prior = readJson(manifestFile) } catch { /* first run */ }
  const byOriginal = new Map((prior.mappings ?? []).map((item) => [String(item.originalPath), item]))
  for (const mapping of mappings) byOriginal.set(mapping.originalPath, mapping)
  atomicWriteJson(manifestFile, {
    version: 1,
    forkId: String(forkId ?? ''),
    updatedAt: new Date().toISOString(),
    mode: LEGACY_WORKSPACE_MODE,
    indexBackup: workspaceBackup,
    mappings: [...byOriginal.values()],
  })
  atomicWriteJson(indexFile, index)
  return {
    ok: conflicts.length === 0,
    changed: true, mappings, moved, conflicts,
    indexFile, manifestFile, workspaceBackup,
  }
}

/** For new imports: map the metadata path and rewrite the copied header if needed. */
export function prepareImportedSession(homeDir, { sessionId = '', workspacePath = '', roots = DEFAULT_LEGACY_WORKSPACE_ROOTS, forkId = '' } = {}) {
  const map = mapWorkspacePathForFork(homeDir, workspacePath, { roots, forkId })
  if (!map.ok || !map.mapped || !sessionId) return { ok: map.ok, mapped: map.mapped, workspacePath: map.path, originalPath: map.original, header: null }
  const key = encodeWorkspaceKey(map.path)
  const logFile = path.join(homeDir, 'sessions', key, String(sessionId), SESSION_LOG_FILE)
  if (!fs.existsSync(logFile)) return { ok: true, mapped: true, workspacePath: map.path, originalPath: map.original, header: null, reason: 'session-log-missing' }
  const backup = backupFile(homeDir, String(sessionId), logFile)
  const header = rewriteSessionHeaderCwd(logFile, map.original, map.path)
  return { ok: header.ok, mapped: true, workspacePath: map.path, originalPath: map.original, header, backup }
}
