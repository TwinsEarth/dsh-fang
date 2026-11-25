// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs'
import path from 'node:path'

/** Chromium/Edge cache directories that are safe to regenerate after the browser closes. */
export const BROWSER_CACHE_DIR_NAMES = Object.freeze([
  'Cache', 'Cache2', 'Code Cache', 'GPUCache', 'ShaderCache', 'GrShaderCache',
  'DawnCache', 'GraphiteDawnCache', 'CacheStorage', 'ScriptCache', 'Application Cache',
])

export const WINDOWS_SEARCH_INDEX_PATHS = Object.freeze([
  'C:\\ProgramData\\Microsoft\\Search\\Data\\Applications\\Windows\\windows.db',
  'C:\\ProgramData\\Microsoft\\Search\\Data\\Applications\\Windows\\Windows.edb',
])

/** Recursively measure a directory without following symlinks. */
export function directorySize(dir) {
  let bytes = 0
  let files = 0
  let errors = 0
  const walk = (current, depth) => {
    if (depth > 8) return
    let entries = []
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { errors += 1; return }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      try {
        if (entry.isSymbolicLink?.()) continue
        if (entry.isDirectory?.()) walk(full, depth + 1)
        else if (entry.isFile?.()) {
          const stat = fs.statSync(full)
          bytes += Number(stat.size) || 0
          files += 1
        }
      } catch { errors += 1 }
    }
  }
  walk(dir, 0)
  return { bytes, files, errors }
}

/** Find only known cache directories under a managed browser profile. */
export function findBrowserCacheDirs(profileRoot) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry?.isDirectory?.() || entry.isSymbolicLink?.()) continue
      const full = path.join(dir, entry.name)
      if (BROWSER_CACHE_DIR_NAMES.includes(entry.name)) {
        const size = directorySize(full)
        out.push({ path: full, name: entry.name, bytes: size.bytes, files: size.files, errors: size.errors })
        continue
      }
      // Never walk into heavy user-data subtrees such as Network/Cookies.
      if (['Network', 'Local Storage', 'Session Storage', 'IndexedDB', 'File System'].includes(entry.name)) continue
      walk(full, depth + 1)
    }
  }
  walk(profileRoot, 0)
  return out.sort((a, b) => b.bytes - a.bytes)
}

function fileProbe(file) {
  try {
    const stat = fs.statSync(file)
    return { path: file, exists: true, readable: true, bytes: stat.isFile() ? stat.size : null, error: null }
  } catch (error) {
    const code = String(error?.code ?? '')
    const missing = code === 'ENOENT'
    return {
      path: file, exists: missing ? false : null,
      readable: false, bytes: null,
      error: missing ? null : `${code || 'error'}: ${String(error?.message ?? error)}`,
    }
  }
}

/**
 * Read-only snapshot. windows.db is a Windows Search system database:
 * this module never deletes or rewrites it, only reports whether it is readable.
 */
export function scanDiskHygiene(options = {}) {
  const platform = options.platform || process.platform
  const taskHomes = Array.isArray(options.taskHomes) ? options.taskHomes : []
  const browserProfiles = []
  for (const item of taskHomes) {
    const taskId = String(item?.taskId ?? '')
    const home = String(item?.homeDir ?? '')
    if (!home) continue
    const profile = path.join(home, 'browser-profile')
    let exists = false
    try { exists = fs.statSync(profile).isDirectory() } catch { exists = false }
    if (!exists) continue
    const total = directorySize(profile)
    const caches = findBrowserCacheDirs(profile)
    browserProfiles.push({
      taskId, status: String(item?.status ?? ''), profile, exists: true,
      bytes: total.bytes, files: total.files, errors: total.errors,
      cacheBytes: caches.reduce((sum, row) => sum + row.bytes, 0),
      caches,
    })
  }
  const searchIndex = platform === 'win32'
    ? WINDOWS_SEARCH_INDEX_PATHS.map(fileProbe)
    : []
  return {
    ok: true,
    platform,
    at: Date.now(),
    browserProfiles,
    browserCacheBytes: browserProfiles.reduce((sum, row) => sum + Number(row.cacheBytes || 0), 0),
    searchIndex,
    notes: {
      browserCache: '只清理 Cache/Code Cache/GPUCache 等可重建目录；不碰 Cookies、登录态、Local Storage。',
      windowsSearch: 'windows.db 是 Windows Search 系统索引，插件只报告大小；重建请在“索引选项 → 高级 → 重建”，不要直接删除。',
    },
  }
}

/**
 * Move known cache directories to a recycle directory. Requires confirm:true.
 * The browser must be stopped by the caller first; a rename failure is reported,
 * never retried as a delete.
 */
export function cleanupBrowserCaches(taskHome, options = {}) {
  const taskId = String(options.taskId ?? '')
  const recycleDir = String(options.recycleDir ?? '')
  if (options.confirm !== true) return { ok: false, error: 'confirmation-required' }
  if (!taskHome || !recycleDir) return { ok: false, error: 'invalid-args' }
  const profile = path.join(taskHome, 'browser-profile')
  let stat = null
  try { stat = fs.statSync(profile) } catch { return { ok: false, error: 'profile-missing', profile } }
  if (!stat.isDirectory()) return { ok: false, error: 'profile-not-directory', profile }
  const caches = findBrowserCacheDirs(profile)
  if (caches.length === 0) return { ok: true, moved: 0, bytes: 0, results: [] }
  const minBytes = Math.max(0, Number(options.minBytes) || 0)
  const totalBytes = caches.reduce((sum, row) => sum + Number(row.bytes || 0), 0)
  if (totalBytes < minBytes) return { ok: true, skipped: 'below-threshold', moved: 0, bytes: totalBytes, results: [] }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const targetRoot = path.join(recycleDir, `${taskId || 'task'}-${stamp}`)
  const results = []
  let moved = 0
  let bytes = 0
  for (const cache of caches) {
    const rel = path.relative(profile, cache.path)
    const dest = path.join(targetRoot, rel)
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.renameSync(cache.path, dest)
      moved += 1
      bytes += cache.bytes
      results.push({ ok: true, from: cache.path, to: dest, bytes: cache.bytes })
    } catch (error) {
      results.push({ ok: false, from: cache.path, error: String(error?.message ?? error) })
    }
  }
  return { ok: moved > 0, moved, bytes, recycleDir: targetRoot, results, profile }
}
