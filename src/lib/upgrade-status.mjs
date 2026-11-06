// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.9 read-only upgrade status. Pure function: no IO, no upgrade/backup side effects.
export function buildUpgradeStatus({ version = '', mirror = null, essences = [], compat = null, tasks = null } = {}) {
  const current = mirror?.current ?? mirror?.currentVersion ?? null
  const latest = mirror?.latest ?? mirror?.officialLatest ?? null
  const mother = {
    current,
    latest,
    updateAvailable: Boolean(current && latest && current !== latest) || mirror?.updateAvailable === true,
    lastBackupAt: Number(mirror?.lastBackupAt) || 0,
    backupIntervalHours: [6, 12, 24].includes(Number(mirror?.backupIntervalHours)) ? Number(mirror.backupIntervalHours) : 24,
  }
  const list = Array.isArray(essences) ? essences.map((e) => ({
    id: String(e?.id ?? ''),
    name: String(e?.name ?? ''),
    status: String(e?.status ?? 'unknown'),
    stale: Boolean(e?.stale),
  })) : []
  const staleCount = list.filter((e) => e.stale).length
  const conflicted = list.filter((e) => e.status === 'conflicted').length
  const failedTasks = Number(tasks?.failed) || 0

  // 系统状态灯：绿=全绿；黄=有更新/待同步；红=有失败。
  const level = { green: 0, yellow: 1, red: 2 }
  let tone = 'green'
  const reasons = []
  const bump = (next, code, text) => {
    if (level[next] > level[tone]) tone = next
    reasons.push({ code, text })
  }
  if (mother.updateAvailable) bump('yellow', 'mother-update', '母体有新版本可更新')
  if (staleCount > 0) bump('yellow', 'essence-stale', `${staleCount} 个元主待同步到新母体`)
  if (compat && compat.ok === false) bump('red', 'compat-failed', '兼容门禁未通过，子插件可能被关闭')
  if (conflicted > 0) bump('red', 'essence-conflicted', `${conflicted} 个元主存在致命冲突`)
  if (failedTasks > 0) bump('red', 'fork-failed', `${failedTasks} 个分身处于失败状态`)

  return {
    ok: true, version: String(version || ''), mother,
    essences: list, operation: null,
    staleCount, conflicted, failedTasks,
    light: { tone, reasons },
  }
}
