// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// P2#4/#5: bounded host diagnostics. Both files are written on every host start
// or crash; without pruning they grow forever and compete with the same disk /
// Commit budget as session logs.
import fs from 'node:fs'
import path from 'node:path'

export const HOST_HOUSEKEEPING_DEFAULTS = Object.freeze({
  watchdogRetentionDays: 7,
  watchdogMaxFiles: 20,
  hostCrashMaxEntries: 50,
  hostCrashRetentionDays: 30,
})

function finiteAt(item) {
  const value = Number(item?.at)
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Keep the newest crash entries and drop entries older than the retention
 * window. Never mutates the input array; callers decide whether to rewrite.
 */
export function pruneHostCrashHistory(crashes, options = {}) {
  const now = Number(options.now) || Date.now()
  const retentionDays = Math.max(1, Number(options.retentionDays) || HOST_HOUSEKEEPING_DEFAULTS.hostCrashRetentionDays)
  const maxEntries = Math.max(1, Math.floor(Number(options.maxEntries) || HOST_HOUSEKEEPING_DEFAULTS.hostCrashMaxEntries))
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000
  const input = Array.isArray(crashes) ? crashes : []
  const retained = input.filter((item) => {
    const at = finiteAt(item)
    return at > 0 && now - at <= retentionMs
  }).sort((a, b) => finiteAt(a) - finiteAt(b))
  const expired = input.length - retained.length
  const overflow = Math.max(0, retained.length - maxEntries)
  const kept = overflow > 0 ? retained.slice(overflow) : retained
  return {
    crashes: kept,
    input: input.length,
    expired,
    dropped: overflow,
    pruned: expired + overflow,
    changed: expired + overflow > 0,
    retentionDays,
    maxEntries,
  }
}

function readWatchdog(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/**
 * Move dead old `watchdog-<pid>.json` files to a same-volume recycle directory.
 * The current host file is always kept. A PID that still answers alive is kept
 * conservatively, even if the file is old: another host may share dataDir.
 */
export function cleanupWatchdogFiles(options = {}) {
  const dataDir = String(options.dataDir ?? '')
  const currentPid = Number(options.currentPid) || process.pid
  const rawMaxFiles = Number(options.maxFiles)
  const maxFiles = Number.isFinite(rawMaxFiles)
    ? Math.max(0, Math.floor(rawMaxFiles))
    : HOST_HOUSEKEEPING_DEFAULTS.watchdogMaxFiles
  const retentionDays = Math.max(1, Number(options.retentionDays) || HOST_HOUSEKEEPING_DEFAULTS.watchdogRetentionDays)
  const now = Number(options.now) || Date.now()
  // Do not move a file whose detached sidecar may still be polling it. Ten
  // minutes is far longer than a sidecar needs to kill and exit.
  const minAgeMs = Number.isFinite(Number(options.minAgeMs)) ? Math.max(0, Number(options.minAgeMs)) : 10 * 60 * 1000
  const recycleDir = String(options.recycleDir || path.join(dataDir, 'recycle', 'watchdog'))
  const isPidAlive = typeof options.isPidAlive === 'function' ? options.isPidAlive : () => false
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000
  if (!dataDir) return { ok: true, moved: 0, kept: 0, errors: [] }
  let names = []
  try { names = fs.readdirSync(dataDir) } catch (error) {
    return { ok: false, moved: 0, kept: 0, errors: [String(error?.message ?? error)] }
  }
  const rows = []
  for (const name of names) {
    const match = /^watchdog-(\d+)\.json$/.exec(name)
    if (!match) continue
    const pid = Number(match[1])
    if (pid === currentPid) continue
    const file = path.join(dataDir, name)
    let stat = null
    try { stat = fs.statSync(file) } catch { continue }
    const doc = readWatchdog(file)
    let alive = false
    try { alive = isPidAlive(pid) } catch { alive = false }
    if (alive) continue
    const at = Number(doc?.at ? Date.parse(doc.at) : 0) || Number(stat.mtimeMs) || 0
    const ageMs = Math.max(0, now - at)
    if (ageMs < minAgeMs) continue
    rows.push({ file, name, pid, at, mtimeMs: Number(stat.mtimeMs) || 0, ageMs })
  }
  rows.sort((a, b) => (b.at - a.at) || (b.mtimeMs - a.mtimeMs))
  const keep = rows.filter((row) => row.ageMs <= retentionMs).slice(0, maxFiles)
  const keepNames = new Set(keep.map((row) => row.name))
  const move = rows.filter((row) => !keepNames.has(row.name))
  const errors = []
  let moved = 0
  if (move.length) {
    try { fs.mkdirSync(recycleDir, { recursive: true }) } catch (error) {
      return { ok: false, moved: 0, kept: keep.length, errors: [String(error?.message ?? error)] }
    }
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
    for (const row of move) {
      const dest = path.join(recycleDir, `${row.name}.${stamp}`)
      try {
        fs.renameSync(row.file, dest)
        moved += 1
      } catch (error) {
        errors.push(`${row.name}: ${String(error?.message ?? error)}`)
      }
    }
  }
  return { ok: errors.length === 0, moved, kept: keep.length, errors, recycleDir }
}
