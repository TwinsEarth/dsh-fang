// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.9 read-only upgrade status. Pure function: no IO, no upgrade/backup side effects.
export function buildUpgradeStatus({ version = '', mirror = null, essences = [] } = {}) {
  const current = mirror?.current ?? null
  const latest = mirror?.latest ?? null
  const mother = {
    current,
    latest,
    updateAvailable: Boolean(current && latest && current !== latest),
    lastBackupAt: Number(mirror?.lastBackupAt) || 0,
    backupIntervalHours: [6, 12, 24].includes(Number(mirror?.backupIntervalHours)) ? Number(mirror.backupIntervalHours) : 24,
  }
  const list = Array.isArray(essences) ? essences.map((e) => ({
    id: String(e?.id ?? ''),
    name: String(e?.name ?? ''),
    status: String(e?.status ?? 'unknown'),
    stale: Boolean(e?.stale),
  })) : []
  return { ok: true, version: String(version || ''), mother, essences: list, operation: null }
}
