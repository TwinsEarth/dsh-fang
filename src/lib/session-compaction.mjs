// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// v3.8.2 P2#2: bounded, lossless session-log compaction.
//
// A DSH session log is `session.v4.jsonl.zstd`: a concatenation of zstd
// frames. We never interpret or rewrite event JSON. We only recompress
// non-header frames at a higher zstd level, preserve the header frame
// byte-for-byte, then verify the full decoded byte stream before replacing
// the original. The original inode is kept as a hard-link backup, so a
// successful compaction costs no extra disk space for the rollback copy.
//
// This implementation streams one frame at a time: a 60 MB log that expands
// to ~400 MB must not require a 400 MB ArrayBuffer on a Commit-constrained
// Windows host. Each frame is decoded, hashed, and recompressed before the
// next frame is read.
//
// Hard safety boundaries:
//   * only exact `session.v4.jsonl.zstd` files under a task home's
//     `sessions/` or `quarantine-sessions/`;
//   * only when the task is stopped/archived (caller decision);
//   * if the file has one frame, is not zstd, exceeds maxBytes, or any frame
//     fails to decode, leave it untouched;
//   * if the recompressed result is not smaller, leave it untouched.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'

export const SESSION_LOG_FILE = 'session.v4.jsonl.zstd'
export const SESSION_COMPACT_DEFAULTS = Object.freeze({
  minBytes: 16 * 1024 * 1024,
  maxBytes: 128 * 1024 * 1024,
  level: 9,
  backupSuffix: '.compact-bak-',
  markerFile: '.fang-session-compact.json',
})
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const READ_CHUNK = 256 * 1024

function isZstd(buf) {
  return buf.length >= 4
    && buf[0] === ZSTD_MAGIC[0] && buf[1] === ZSTD_MAGIC[1]
    && buf[2] === ZSTD_MAGIC[2] && buf[3] === ZSTD_MAGIC[3]
}

/**
 * Yield compressed zstd frames from a file, at most one frame in memory.
 * The split rule is the same as the prior implementation: every zstd magic
 * after byte 0 starts a new frame. A false split is caught by frame decode
 * and aborts without touching the original.
 */
function* streamFrames(file) {
  const fd = fs.openSync(file, 'r')
  try {
    let current = Buffer.alloc(0)
    let scanFrom = 1
    let first = true
    let sawAny = false
    while (true) {
      const chunk = Buffer.alloc(READ_CHUNK)
      const n = fs.readSync(fd, chunk, 0, READ_CHUNK, null)
      if (n === 0) break
      sawAny = true
      const bytes = chunk.subarray(0, n)
      if (first) {
        current = bytes
        first = false
      } else {
        current = Buffer.concat([current, bytes])
      }
      let index = current.indexOf(ZSTD_MAGIC, scanFrom)
      while (index !== -1) {
        if (index > 0) {
          yield current.subarray(0, index)
          current = current.subarray(index)
          scanFrom = 1
          index = current.indexOf(ZSTD_MAGIC, 1)
        } else {
          scanFrom = 1
          index = current.indexOf(ZSTD_MAGIC, 1)
        }
      }
      scanFrom = Math.max(1, current.length - 3)
    }
    if (!sawAny || current.length === 0) throw new Error('empty')
    if (!isZstd(current)) throw new Error('not-zstd')
    yield current
  } finally {
    try { fs.closeSync(fd) } catch { /* best effort */ }
  }
}

function decodedDigestFile(file) {
  const hash = createHash('sha256')
  let frames = 0
  let bytes = 0
  try {
    for (const frame of streamFrames(file)) {
      let decoded
      try { decoded = zlib.zstdDecompressSync(frame) } catch { return { ok: false, error: 'frame-decode-failed' } }
      hash.update(decoded)
      bytes += decoded.length
      frames += 1
    }
  } catch (error) {
    const message = String(error?.message ?? error)
    return { ok: false, error: message === 'empty' || message === 'not-zstd' ? message : `read-failed:${message}` }
  }
  if (frames <= 1) return { ok: false, error: 'single-frame' }
  return { ok: true, frames, bytes, digest: hash.digest('hex') }
}

function writeMarker(dir, payload, markerName) {
  const markerFile = path.join(dir, markerName)
  const markerTmp = markerFile + '.tmp-' + process.pid
  fs.writeFileSync(markerTmp, JSON.stringify(payload, null, 2))
  fs.renameSync(markerTmp, markerFile)
}

/**
 * Scan a task home for session logs. Read-only: never decompresses or writes.
 * Includes `sessions/` and `quarantine-sessions/`; backups are ignored by exact
 * filename, so a previous compaction cannot re-enter the candidate set.
 */
export function listSessionLogs(homeDir) {
  const roots = ['sessions', 'quarantine-sessions']
  const out = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry?.name) continue
      const full = path.join(dir, entry.name)
      if (entry.isFile?.() && entry.name === SESSION_LOG_FILE) {
        try {
          const stat = fs.statSync(full)
          let compactedAt = 0
          try {
            const marker = JSON.parse(fs.readFileSync(path.join(dir, '.fang-session-compact.json'), 'utf8'))
            compactedAt = Number(marker?.at) || 0
          } catch { /* no marker = eligible */ }
          if (stat.isFile()) out.push({ file: full, bytes: stat.size, mtimeMs: stat.mtimeMs, compactedAt, workspaceKey: path.basename(path.dirname(dir)), sessionId: path.basename(dir) })
        } catch { /* unreadable log is ignored, never treated as empty data */ }
        continue
      }
      if (entry.isDirectory?.()) walk(full, depth + 1)
    }
  }
  for (const rel of roots) walk(path.join(String(homeDir ?? ''), rel), 0)
  out.sort((a, b) => b.bytes - a.bytes)
  return out
}

function rewriteFrames(source, target, level, mode) {
  let fd = null
  try { fd = fs.openSync(target, 'w', mode) } catch (error) {
    return { ok: false, error: `tmp-open-failed:${String(error?.message ?? error)}` }
  }
  const hash = createHash('sha256')
  let frames = 0
  let decodedBytes = 0
  try {
    for (const frame of streamFrames(source)) {
      if (frames === 0) {
        // Header frame byte-identical: DSH validates header-derived fingerprints.
        let header
        try { header = zlib.zstdDecompressSync(frame) } catch { return { ok: false, error: 'frame-decode-failed' } }
        hash.update(header)
        decodedBytes += header.length
        fs.writeSync(fd, frame)
        frames = 1
        continue
      }
      let decoded
      try { decoded = zlib.zstdDecompressSync(frame) } catch { return { ok: false, error: 'frame-decode-failed' } }
      hash.update(decoded)
      decodedBytes += decoded.length
      const out = zlib.zstdCompressSync(decoded, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } })
      fs.writeSync(fd, out)
      frames += 1
    }
  } catch (error) {
    return { ok: false, error: `frame-read-failed:${String(error?.message ?? error)}` }
  } finally {
    try { fs.closeSync(fd) } catch { /* best effort */ }
  }
  if (frames <= 1) return { ok: false, error: 'single-frame' }
  return { ok: true, frames, bytes: decodedBytes, digest: hash.digest('hex') }
}

/**
 * Losslessly recompress one session log.
 * Returns `{ok:true, skipped}` when no action was justified or possible
 * without risk; the original is byte-identical in every skipped path.
 */
export function compactSessionLog(file, options = {}) {
  const opts = { ...SESSION_COMPACT_DEFAULTS, ...(options ?? {}) }
  const target = path.resolve(String(file ?? ''))
  const minBytes = Math.max(0, Number(opts.minBytes) || 0)
  const maxBytes = Math.max(minBytes, Number(opts.maxBytes) || SESSION_COMPACT_DEFAULTS.maxBytes)
  const level = Math.min(19, Math.max(1, Math.floor(Number(opts.level) || SESSION_COMPACT_DEFAULTS.level)))
  let stat
  try { stat = fs.statSync(target) } catch (error) {
    return { ok: false, error: `stat-failed:${String(error?.message ?? error)}` }
  }
  if (!stat.isFile()) return { ok: false, error: 'not-a-file' }
  if (stat.size < minBytes) return { ok: true, skipped: 'below-threshold', bytes: stat.size }
  if (stat.size > maxBytes) return { ok: true, skipped: 'above-max-bytes', bytes: stat.size }

  const original = decodedDigestFile(target)
  if (!original.ok) {
    if (['not-zstd', 'single-frame', 'frame-decode-failed', 'empty'].includes(original.error)) {
      return { ok: true, skipped: original.error, bytes: stat.size }
    }
    return { ok: false, error: original.error, bytes: stat.size }
  }

  const tmp = `${target}.compact-tmp-${process.pid}-${Date.now()}`
  let backupCreated = false
  let backup = ''
  try {
    const built = rewriteFrames(target, tmp, level, stat.mode)
    if (!built.ok) {
      if (['single-frame', 'frame-decode-failed'].includes(built.error)) {
        try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
        return { ok: true, skipped: built.error, bytes: stat.size }
      }
      throw new Error(built.error)
    }
    if (built.digest !== original.digest || built.bytes !== original.bytes || built.frames !== original.frames) {
      throw new Error('content-digest-mismatch')
    }
    const afterBytes = fs.statSync(tmp).size
    if (afterBytes >= stat.size) {
      try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
      // A no-gain attempt is expensive enough (full decode) that a marker stops
      // the periodic sweep from retrying the same unchanged file every 10 min.
      try {
        writeMarker(path.dirname(target), {
          version: 1, at: Date.now(), skipped: 'no-gain', beforeBytes: stat.size,
          afterBytes, frames: original.frames, level,
        }, opts.markerFile || SESSION_COMPACT_DEFAULTS.markerFile)
      } catch { /* marker is optional */ }
      return { ok: true, skipped: 'no-gain', bytes: stat.size, afterBytes, frames: original.frames }
    }

    const verify = decodedDigestFile(tmp)
    if (!verify.ok || verify.digest !== original.digest || verify.bytes !== original.bytes || verify.frames !== original.frames) {
      throw new Error(`verify-failed:${verify.error ?? 'digest'}`)
    }

    const stamp = new Date(Number(opts.now) || Date.now()).toISOString().replace(/[:.]/g, '-')
    backup = `${target}${opts.backupSuffix}${stamp}`
    // Hard-link rollback copy: same inode, near-zero extra disk. If the
    // volume cannot hard-link, skip rather than doubling the session size.
    try { fs.linkSync(target, backup) } catch (error) {
      throw new Error(`backup-link-unavailable:${String(error?.message ?? error)}`)
    }
    backupCreated = true
    fs.rmSync(target, { force: true })
    fs.renameSync(tmp, target)
    let marker = false
    try {
      writeMarker(path.dirname(target), {
        version: 1, at: Date.now(), beforeBytes: stat.size, afterBytes,
        savedBytes: stat.size - afterBytes, frames: original.frames, level,
      }, opts.markerFile || SESSION_COMPACT_DEFAULTS.markerFile)
      marker = true
    } catch { /* marker is an optimization; compaction remains valid */ }
    return {
      ok: true,
      compacted: true,
      beforeBytes: stat.size,
      afterBytes,
      savedBytes: stat.size - afterBytes,
      frames: original.frames,
      level,
      backup,
      digest: original.digest,
      marker,
    }
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    if (backupCreated && !fs.existsSync(target)) {
      try { fs.renameSync(backup, target) } catch { /* backup remains for manual recovery */ }
    }
    return { ok: false, error: String(error?.message ?? error), bytes: stat.size }
  }
}

function compactRows(logs, opts) {
  const minBytes = Math.max(0, Number(opts.minBytes) || 0)
  const candidates = logs.filter((row) => row.bytes >= minBytes
    && !(Number(row.compactedAt) > 0 && Number(row.mtimeMs) <= Number(row.compactedAt)))
  const results = []
  let savedBytes = 0
  for (const row of candidates) {
    const result = compactSessionLog(row.file, { ...opts, minBytes })
    results.push({ file: row.file, ...result })
    if (result.compacted === true) savedBytes += Number(result.savedBytes) || 0
  }
  return {
    ok: true,
    candidates: candidates.length,
    compacted: results.filter((row) => row.compacted === true).length,
    skipped: results.filter((row) => row.ok === true && row.compacted !== true).length,
    failed: results.filter((row) => row.ok !== true).length,
    savedBytes,
    results,
  }
}

/** Compact all eligible logs under one task home. Caller must ensure stopped. */
export function compactTaskSessions(homeDir, options = {}) {
  const opts = { ...SESSION_COMPACT_DEFAULTS, ...(options ?? {}) }
  return compactRows(listSessionLogs(homeDir), opts)
}

/**
 * Compact only migrated legacy history under <dataDir>/sessions/**\legacy/**.
 * These are copied archives, not an active DSH session; still lossless in place,
 * with the same hard-link backup and marker.
 */
export function compactLegacySessions(dataDir, options = {}) {
  const opts = { ...SESSION_COMPACT_DEFAULTS, ...(options ?? {}) }
  const logs = listSessionLogs(dataDir).filter((row) => {
    const parts = row.file.split(path.sep)
    const sessionsIndex = parts.indexOf('sessions')
    if (sessionsIndex < 0) return false
    const migrated = parts[sessionsIndex + 1] || ''
    return migrated.startsWith('migrated-') && parts.includes('legacy')
  })
  return compactRows(logs, opts)
}
