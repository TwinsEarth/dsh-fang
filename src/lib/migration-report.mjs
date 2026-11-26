// SPDX-License-Identifier: AGPL-3.0-or-later
// P2 #10: expose the newest legacy-root migration report to the panel.
//
// tools/migrate-fang-home.mjs writes `_migration/migration-<stamp>.json` under
// the canonical root, but until now the UI only knew `legacyDataDetected` and
// never showed what the migration actually copied/skipped/conflicted. This
// module is read-only, bounded, and never walks outside the canonical root.
import fs from 'node:fs'
import path from 'node:path'

export const MIGRATION_REPORT_DIRNAME = '_migration'
export const MIGRATION_REPORT_MAX_BYTES = 2 * 1024 * 1024
export const MIGRATION_REPORT_MAX_CONFLICTS = 20

function number(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function safeText(value, max = 400) {
  return String(value ?? '').slice(0, max)
}

function summarize(report, file, dir, stat) {
  const conflicts = Array.isArray(report?.conflicts) ? report.conflicts.map((item) => safeText(item, 500)) : []
  const sources = Array.isArray(report?.sources)
    ? report.sources.slice(0, 8).map((source) => ({
        kind: safeText(source?.kind, 80),
        dataDir: safeText(source?.dataDir, 600),
      }))
    : []
  const copied = number(report?.copied)
  const targetFiles = number(report?.files?.targetFiles)
  const applied = report?.apply === true && copied > 0
  return {
    ok: true,
    found: applied,
    applied,
    dir,
    file,
    path: path.join(dir, file),
    at: stat.mtime.toISOString(),
    stamp: safeText(report?.stamp, 80) || file.replace(/^migration-/, '').replace(/\.json$/, ''),
    apply: report?.apply === true,
    reportOk: report?.ok === true,
    target: safeText(report?.target, 600),
    profile: safeText(report?.profile, 120),
    dshHome: safeText(report?.dshHome, 600),
    copied,
    skipped: number(report?.skipped),
    conflictCount: conflicts.length,
    conflicts: conflicts.slice(0, MIGRATION_REPORT_MAX_CONFLICTS),
    sources,
    files: {
      tasksPath: safeText(report?.files?.tasks?.path, 600),
      tasksCount: number(report?.files?.tasks?.count),
      targetFiles,
      pointer: safeText(report?.files?.pointer, 600),
    },
    truncatedConflicts: Math.max(0, conflicts.length - MIGRATION_REPORT_MAX_CONFLICTS),
  }
}

/**
 * Read the newest valid migration report under <fangHome>/_migration.
 * Missing/invalid reports return a quiet `{found:false}` so the UI shows nothing
 * instead of inventing a migration status.
 */
export function readLatestMigrationReport(fangHome, { maxBytes = MIGRATION_REPORT_MAX_BYTES } = {}) {
  const root = String(fangHome ?? '').trim()
  const dir = root ? path.join(root, MIGRATION_REPORT_DIRNAME) : ''
  if (!dir) return { ok: true, found: false, dir: '', error: 'no-fang-home' }
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    return { ok: true, found: false, dir, error: String(error?.code ?? error?.message ?? error) }
  }
  const reports = entries
    .filter((entry) => entry.isFile() && /^migration-.*\.json$/.test(entry.name))
    .map((entry) => {
      const file = path.join(dir, entry.name)
      try {
        const stat = fs.statSync(file)
        return stat.size > maxBytes ? null : { file, name: entry.name, stat }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)

  for (const candidate of reports) {
    try {
      const report = JSON.parse(fs.readFileSync(candidate.file, 'utf8'))
      if (!report || typeof report !== 'object') continue
      const summary = summarize(report, candidate.name, dir, candidate.stat)
      // Dry-run (`apply:false`) and empty (`copied:0`) reports are not migrations;
      // do not raise the panel banner or hide a real older migration behind them.
      if (summary.found !== true) continue
      return summary
    } catch {
      // Try the next newer-valid report; a partial write must not blank the panel.
    }
  }
  return { ok: true, found: false, dir, error: reports.length ? 'no-applied-report' : 'no-reports' }
}
