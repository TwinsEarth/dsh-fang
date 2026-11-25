// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// Bounded diagnostic JSONL: rotate by size, prune archives by age.
import fs from 'node:fs'
import path from 'node:path'

export const LOG_ROTATION_DEFAULTS = {
  maxBytes: 16 * 1024 * 1024,
  retentionDays: 7,
  pruneIntervalMs: 60 * 60 * 1000,
}

const lastPruneAt = new Map()

function archiveName(file, now) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  let candidate = `${file}.${stamp}`
  let index = 1
  while (fs.existsSync(candidate)) candidate = `${file}.${stamp}-${index++}`
  return candidate
}

/** Move the active file aside so the next append starts a fresh one. */
export function rotateJsonlFile(file, now = Date.now()) {
  const target = archiveName(file, now)
  fs.renameSync(file, target)
  return target
}

/** Delete rotated archives older than retentionDays. Active file is untouched. */
export function pruneJsonlArchives(file, { retentionDays = LOG_ROTATION_DEFAULTS.retentionDays, now = Date.now() } = {}) {
  const dir = path.dirname(file)
  const base = path.basename(file)
  const maxAgeMs = Math.max(1, Number(retentionDays) || 1) * 24 * 60 * 60 * 1000
  let removed = 0
  let names = []
  try { names = fs.readdirSync(dir) } catch { return { removed, archives: 0 } }
  const archives = names.filter((name) => name.startsWith(`${base}.`) && name !== base)
  for (const name of archives) {
    const full = path.join(dir, name)
    try {
      const stat = fs.statSync(full)
      if (now - stat.mtimeMs > maxAgeMs) { fs.unlinkSync(full); removed += 1 }
    } catch { /* concurrent rotation/prune: next pass */ }
  }
  return { removed, archives: archives.length }
}

/**
 * Append one JSON line, rotating before the file exceeds maxBytes. Pruning is
 * throttled per file (default hourly) so hot sample loops do not scan the dir.
 * Never throws: diagnostics must not break the task path.
 * @returns {boolean} true when the line was appended
 */
export function appendJsonlRotated(file, record, options = {}) {
  const maxBytes = Math.max(1, Number(options.maxBytes) || LOG_ROTATION_DEFAULTS.maxBytes)
  const retentionDays = Math.max(1, Number(options.retentionDays) || LOG_ROTATION_DEFAULTS.retentionDays)
  const now = Number(options.now) || Date.now()
  const line = `${JSON.stringify(record)}\n`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    let size = 0
    try {
      const stat = fs.statSync(file)
      if (stat.isFile()) size = stat.size
    } catch { /* new file */ }
    if (size > 0 && (size >= maxBytes || size + Buffer.byteLength(line) > maxBytes)) rotateJsonlFile(file, now)
    fs.appendFileSync(file, line)
  } catch { return false }
  const last = Number(lastPruneAt.get(file)) || 0
  if (now - last >= LOG_ROTATION_DEFAULTS.pruneIntervalMs) {
    lastPruneAt.set(file, now)
    pruneJsonlArchives(file, { retentionDays, now })
  }
  return true
}
