// SPDX-License-Identifier: AGPL-3.0-or-later
// Read-only session-body footprint scanner for dsh-Fang.
//
// A DSH session is a multi-frame zstd log. The expensive part for the Host is
// not the compressed bytes alone; it is the fact that opening one large log
// expands it into the V8 heap. This scanner only stats the exact session log
// filename (no decode, no read), so it can run from the 5 s host tick behind a
// longer cache without becoming a second memory problem.
import path from 'node:path'
import { listSessionLogs } from './session-compaction.mjs'

export const SESSION_FOOTPRINT_SCAN_DEFAULTS = Object.freeze({
  top: 8,
})

function safeRelative(homeDir, file) {
  try {
    return path.relative(homeDir, file) || path.basename(file)
  } catch {
    return path.basename(file)
  }
}

/**
 * Build one root summary from rows returned by listSessionLogs().
 * The rows already contain exact `session.v4.jsonl.zstd` files only.
 */
export function summarizeSessionRoot(logs = [], { label = '', taskId = null, homeDir = '' } = {}) {
  const rows = Array.isArray(logs) ? logs.filter((row) => row && Number.isFinite(Number(row.bytes))) : []
  const bytes = rows.reduce((sum, row) => sum + Math.max(0, Number(row.bytes) || 0), 0)
  const largest = rows.reduce((max, row) => {
    if (!max) return row
    return Number(row.bytes) > Number(max.bytes) ? row : max
  }, null)
  return {
    label: String(label || ''),
    taskId: taskId || null,
    homeDir: String(homeDir || ''),
    files: rows.length,
    bytes,
    largestBytes: largest ? Math.max(0, Number(largest.bytes) || 0) : 0,
    largestFile: largest ? safeRelative(homeDir, largest.file) : null,
    largestSessionId: largest?.sessionId ?? null,
  }
}

/**
 * Scan the Host DSH home and every task/fork home. Roots are explicit so the
 * caller controls whether archived tasks are included; this function never
 * follows a workspace path or reads a session's content.
 */
export function scanSessionFootprint(roots = [], options = {}) {
  const top = Math.max(1, Math.min(50, Number(options.top) || SESSION_FOOTPRINT_SCAN_DEFAULTS.top))
  const rootSummaries = []
  const allRows = []
  for (const root of Array.isArray(roots) ? roots : []) {
    const homeDir = String(root?.homeDir ?? '')
    if (!homeDir) continue
    let logs = []
    let error = null
    try {
      logs = listSessionLogs(homeDir)
    } catch (scanError) {
      error = String(scanError?.message ?? scanError)
      logs = []
    }
    const summary = summarizeSessionRoot(logs, {
      label: root?.label,
      taskId: root?.taskId ?? null,
      homeDir,
    })
    rootSummaries.push({ ...summary, ok: error === null, error })
    for (const log of logs) {
      allRows.push({
        label: summary.label,
        taskId: summary.taskId,
        homeDir,
        file: safeRelative(homeDir, log.file),
        sessionId: log.sessionId ?? null,
        bytes: Math.max(0, Number(log.bytes) || 0),
        mtimeMs: Number(log.mtimeMs) || 0,
      })
    }
  }
  allRows.sort((a, b) => b.bytes - a.bytes)
  const largest = allRows[0] ?? null
  return {
    ok: true,
    at: Date.now(),
    roots: rootSummaries,
    bytes: allRows.reduce((sum, row) => sum + row.bytes, 0),
    files: allRows.length,
    largestBytes: largest?.bytes ?? 0,
    largestFile: largest?.file ?? null,
    largestSessionId: largest?.sessionId ?? null,
    largestRoot: largest?.label ?? null,
    top: allRows.slice(0, top),
    truncated: allRows.length > top,
  }
}
