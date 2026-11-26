// SPDX-License-Identifier: AGPL-3.0-or-later
// Windows commit-memory guard + process-tree sampling for dsh-Fang.
// No native addon: PowerShell/CIM is queried at most once per cache window.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'

const execFileAsync = promisify(execFile)
// Host memory is checked on a 15s timer; a 10s cache still coalesces ad-hoc
// probes while the watchdog tick keeps one PowerShell/CIM query per interval.
const DEFAULT_CACHE_MS = 10000
const DEFAULT_PROCESS_TABLE_CACHE_MS = 0
let cache = { at: 0, value: null, pending: null }
const processTableCache = new Map()

function parsePowerShellJson(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null
  try { return JSON.parse(trimmed) } catch { /* fall through */ }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)) } catch { /* ignore */ }
  }
  return null
}

function asArray(value) {
  if (Array.isArray(value)) return value
  if (value === null || value === undefined || value === '') return []
  return [value]
}

function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function roundMB(value) {
  return Math.round(positiveNumber(value))
}

function driveOf(name) {
  const match = /^([A-Za-z]:)/.exec(String(name ?? '').trim())
  return match ? match[1].toUpperCase() : ''
}

/** Normalize per-drive Win32_PageFileUsage rows. */
export function normalizePageFileDetails(value) {
  return asArray(value)
    .map((row) => ({
      name: String(row?.Name ?? row?.name ?? ''),
      allocatedMB: roundMB(row?.AllocatedBaseSize ?? row?.allocatedBaseSize),
      currentUsageMB: roundMB(row?.CurrentUsage ?? row?.currentUsage),
      peakUsageMB: roundMB(row?.PeakUsage ?? row?.peakUsage),
    }))
    .filter((row) => row.name || row.allocatedMB > 0)
}

/** Normalize per-drive Win32_PageFileSetting rows (configured, possibly inactive). */
export function normalizePageFileSettings(value) {
  return asArray(value)
    .map((row) => ({
      name: String(row?.Name ?? row?.name ?? ''),
      initialMB: roundMB(row?.InitialSize ?? row?.initialSize),
      maximumMB: roundMB(row?.MaximumSize ?? row?.maximumSize),
    }))
    .filter((row) => row.name)
}

/** Normalize all fixed/removable volumes for diagnostics; no decision uses them yet. */
export function normalizeVolumes(value) {
  return asArray(value)
    .map((row) => ({
      deviceId: String(row?.DeviceID ?? row?.deviceId ?? '').toUpperCase(),
      sizeMB: roundMB(row?.SizeMB ?? row?.sizeMB),
      freeMB: roundMB(row?.FreeMB ?? row?.freeMB),
      fileSystem: String(row?.FileSystem ?? row?.fileSystem ?? ''),
    }))
    .filter((row) => row.deviceId)
}

/**
 * Pure mapping from the PowerShell JSON shape. Kept exported so a synthetic
 * C: + D: pagefile result can be tested without Windows.
 */
export function mapMemoryProbe(data, { now = Date.now(), systemDrive = process.env.SystemDrive || 'C:' } = {}) {
  if (!data || typeof data !== 'object') return { ok: false, supported: true, source: 'powershell', error: 'memory-parse-failed' }
  const physicalTotalMB = roundMB(data.PhysicalTotalMB)
  const physicalFreeMB = roundMB(data.PhysicalFreeMB)
  const pageFileDetails = normalizePageFileDetails(data.PageFileDetails)
  const pageFileSettings = normalizePageFileSettings(data.PageFileSettings)
  const volumes = normalizeVolumes(data.Volumes)
  const pageFileMB = pageFileDetails.reduce((sum, row) => sum + row.allocatedMB, 0)
    || roundMB(data.PageFileMB)
  const pageFileUsageMB = pageFileDetails.reduce((sum, row) => sum + row.currentUsageMB, 0)
    || roundMB(data.PageFileUsageMB)
  const pageFilePeakMB = pageFileDetails.reduce((sum, row) => sum + row.peakUsageMB, 0)
    || roundMB(data.PageFilePeakMB)
  const osLimitMB = roundMB(data.CommitLimitOSMB ?? data.CommitLimitMB)
  const derivedLimitMB = physicalTotalMB > 0 ? physicalTotalMB + pageFileMB : 0
  // The OS value is system-wide, but older probes only surfaced the system drive
  // through their pagefile detail. Taking the larger of the OS value and
  // RAM + every pagefile makes an under-reported C-only limit visible instead of
  // silently gating on it. Equal values keep the OS value as the source of truth.
  const commitLimitMB = Math.max(osLimitMB, derivedLimitMB)
  const commitLimitSource = derivedLimitMB > osLimitMB + 1024
    ? 'physical-plus-all-pagefiles'
    : (osLimitMB > 0 ? 'os-total' : 'derived')
  const pagingFiles = String(data.PagingFiles ?? '')
  const drives = [...new Set([
    ...pageFileDetails.map((row) => driveOf(row.name)).filter(Boolean),
    ...pageFileSettings.map((row) => driveOf(row.name)).filter(Boolean),
  ])].sort()
  const normalizedSystemDrive = driveOf(systemDrive) || 'C:'
  const value = {
    ok: true,
    supported: true,
    source: 'powershell',
    commitLimitMB,
    commitLimitOSMB: osLimitMB || null,
    commitLimitDerivedMB: derivedLimitMB || null,
    commitLimitSource,
    commitLimitMismatchMB: derivedLimitMB && osLimitMB ? derivedLimitMB - osLimitMB : null,
    commitFreeMB: roundMB(data.CommitFreeMB),
    physicalTotalMB,
    physicalFreeMB,
    pageFileMB,
    pageFileUsageMB,
    pageFilePeakMB,
    pageFileCount: pageFileDetails.length,
    pageFileDetails,
    pageFileSettings,
    pageFileDrives: drives,
    pageFileDriveCount: drives.length,
    pageFileOnSystemDrive: drives.includes(normalizedSystemDrive),
    pageFileOffSystemDrive: drives.some((drive) => drive !== normalizedSystemDrive),
    systemDrive: normalizedSystemDrive,
    volumes,
    selfRssMB: roundMB(data.SelfRssMB),
    selfPrivateMB: roundMB(data.SelfPrivateMB),
    hasPageFile: pageFileMB > 0,
    pagingFiles,
    pagingFilesEmpty: pagingFiles.trim() === '',
    automaticManagedPagefile: data.AutomaticManagedPagefile === true,
    commitLimitNearRam: isCommitLimitNearRam(commitLimitMB, physicalTotalMB),
    at: now,
    cached: false,
    cacheAgeMs: 0,
  }
  value.pagefileMissing = isPagefileMissing(value)
  return value
}

/** Read Windows commit limit/free. Values are MB. Non-Windows returns a disabled shape. */
export async function readSystemMemory({ force = false, cacheMs = DEFAULT_CACHE_MS } = {}) {
  if (process.platform !== 'win32') {
    return { ok: true, supported: false, source: 'non-windows', commitLimitMB: null, commitFreeMB: null, physicalFreeMB: Math.round(os.freemem() / 1048576) }
  }
  const now = Date.now()
  if (!force && cache.value && now - cache.at < cacheMs) return { ...cache.value, cached: true, cacheAgeMs: now - cache.at }
  // A forced gate read must join an in-flight sample instead of spawning a
  // second PowerShell/CIM query in parallel.
  if (cache.pending) return cache.pending
  const script = [
    '$o = Get-CimInstance Win32_OperatingSystem',
    '$cs = Get-CimInstance Win32_ComputerSystem',
    '$mm = Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management" -ErrorAction SilentlyContinue',
    `$hp = Get-Process -Id ${Number(process.pid)} -ErrorAction SilentlyContinue`,
    '$pf = @(Get-CimInstance Win32_PageFileUsage -ErrorAction SilentlyContinue | ForEach-Object {',
    '  [pscustomobject]@{ Name=[string]$_.Name; AllocatedBaseSize=[double]$_.AllocatedBaseSize; CurrentUsage=[double]$_.CurrentUsage; PeakUsage=[double]$_.PeakUsage }',
    '})',
    '$pfs = @(Get-CimInstance Win32_PageFileSetting -ErrorAction SilentlyContinue | ForEach-Object {',
    '  [pscustomobject]@{ Name=[string]$_.Name; InitialSize=[double]$_.InitialSize; MaximumSize=[double]$_.MaximumSize }',
    '})',
    '$vol = @(Get-CimInstance Win32_LogicalDisk -ErrorAction SilentlyContinue | Where-Object { $_.DriveType -eq 2 -or $_.DriveType -eq 3 } | ForEach-Object {',
    '  [pscustomobject]@{ DeviceID=[string]$_.DeviceID; SizeMB=[math]::Round($_.Size / 1MB); FreeMB=[math]::Round($_.FreeSpace / 1MB); FileSystem=[string]$_.FileSystem }',
    '})',
    '$pfMB = [math]::Round((@($pf) | Measure-Object -Property AllocatedBaseSize -Sum).Sum)',
    '$pfUseMB = [math]::Round((@($pf) | Measure-Object -Property CurrentUsage -Sum).Sum)',
    '$pfPeakMB = [math]::Round((@($pf) | Measure-Object -Property PeakUsage -Sum).Sum)',
    '$ramMB = [math]::Round($o.TotalVisibleMemorySize / 1024)',
    '$p = [pscustomobject]@{',
    '  CommitLimitOSMB = [math]::Round($o.TotalVirtualMemorySize / 1024)',
    '  CommitLimitDerivedMB = $ramMB + $pfMB',
    '  CommitFreeMB = [math]::Round($o.FreeVirtualMemory / 1024)',
    '  PhysicalTotalMB = $ramMB',
    '  PhysicalFreeMB = [math]::Round($o.FreePhysicalMemory / 1024)',
    '  PageFileMB = $pfMB',
    '  PageFileUsageMB = $pfUseMB',
    '  PageFilePeakMB = $pfPeakMB',
    '  PageFileDetails = @($pf)',
    '  PageFileSettings = @($pfs)',
    '  Volumes = @($vol)',
    '  PagingFiles = [string](@($mm.PagingFiles) -join ";")',
    '  AutomaticManagedPagefile = [bool]($cs.AutomaticManagedPagefile -eq $true)',
    '  SelfRssMB = if ($hp) { [math]::Round($hp.WorkingSet64 / 1048576) } else { 0 }',
    '  SelfPrivateMB = if ($hp) { [math]::Round($hp.PrivateMemorySize64 / 1048576) } else { 0 }',
    '}',
    '$p | ConvertTo-Json -Compress -Depth 6',
  ].join('\n')
  const run = (async () => {
    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        timeout: 10000, windowsHide: true, maxBuffer: 262144,
      })
      const data = parsePowerShellJson(stdout)
      if (!data) return { ok: false, supported: true, source: 'powershell', error: 'memory-parse-failed' }
      const value = mapMemoryProbe(data, { now })
      cache = { at: now, value, pending: null }
      return value
    } catch (error) {
      const value = { ok: false, supported: true, source: 'powershell', error: String(error?.message ?? error), cached: false, cacheAgeMs: 0 }
      cache = { at: now, value, pending: null }
      return value
    }
  })()
  cache.pending = run
  return run
}

/** CommitLimit ≈ physical RAM is a second, independent no-pagefile signal. */
export function isCommitLimitNearRam(commitLimitMB, physicalTotalMB) {
  const limit = Number(commitLimitMB) || 0
  const total = Number(physicalTotalMB) || 0
  if (limit <= 0 || total <= 0) return false
  return limit <= total * 1.1
}

/** Pagefile missing by usage, registry PagingFiles={}, or CommitLimit≈RAM. */
export function isPagefileMissing(memory) {
  if (!memory || memory.ok !== true || memory.supported === false) return false
  if (memory.pagingFilesEmpty === true || memory.commitLimitNearRam === true) return true
  return memory.hasPageFile !== true || Number(memory.pageFileMB) <= 0
}

/**
 * No-pagefile policy: advisory only. Kept exported for compatibility; it must
 * never report `limited: true` or be used to refuse a fork (v3.9.4).
 */
export function evaluatePagefileSingleFork(memory, { activeForks = 0 } = {}) {
  const active = Math.max(0, Number(activeForks) || 0)
  if (!isPagefileMissing(memory)) return { ok: true, limited: false, activeForks: active }
  return { ok: true, limited: false, advisory: 'pagefile-missing', activeForks: active, detail: '页面文件缺失只是提醒，建议设置；不限制分身数量，实际准入只按 Commit 余量判断。' }
}

/** Pure guard decision, kept separate for tests. */
export function evaluateMemoryGuard(memory, { minFreeMB = 4096 } = {}) {
  if (!memory?.ok) return { ok: true, skipped: 'memory-unavailable', memory }
  if (memory.supported === false) return { ok: true, skipped: 'unsupported-platform', memory }
  const free = Number(memory.commitFreeMB) || 0
  const min = Math.max(0, Number(minFreeMB) || 0)
  if (free < min) return { ok: false, error: 'memory-low', commitFreeMB: free, minFreeMB: min, memory }
  return { ok: true, commitFreeMB: free, minFreeMB: min, memory }
}

/** Parse Windows CIM CreationDate (ISO, /Date(ms)/, or numeric epoch) to milliseconds. */
export function parseProcessCreationDate(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const text = String(value).trim()
  const wmi = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(text)
  if (wmi) return Number(wmi[1])
  if (/^\d+$/.test(text)) return Number(text)
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeProcessRow(row) {
  const creationDate = String(row?.CreationDate ?? '')
  return {
    pid: Number(row?.ProcessId),
    ppid: Number(row?.ParentProcessId),
    name: String(row?.Name ?? ''),
    workingSetMB: Math.round((Number(row?.WorkingSetSize) || 0) / 1048576),
    commitMB: Math.round((Number(row?.PageFileUsage) || 0) / 1048576),
    commandLine: String(row?.CommandLine ?? ''),
    creationDate,
    createdAt: parseProcessCreationDate(row?.CreationDate),
  }
}

function processTableKey(detailed) {
  return detailed ? 'full' : 'lite'
}

/** Build the PowerShell table query. Lite rows omit identity-only fields. */
export function buildProcessTableScript({ detailed = true } = {}) {
  const fields = detailed
    ? 'ProcessId,ParentProcessId,Name,WorkingSetSize,PageFileUsage,CommandLine,CreationDate'
    : 'ProcessId,ParentProcessId,Name,WorkingSetSize,PageFileUsage'
  return [
    'Get-CimInstance Win32_Process |',
    `  Select-Object ${fields} |`,
    '  ConvertTo-Json -Compress',
  ].join('\n')
}

/**
 * Snapshot all Windows processes into rows; caller filters by PID tree.
 * `cacheMs` lets the 15s watchdog reuse one table across ticks; `force` is for
 * kill/identity paths that must not act on a stale snapshot. Lite tables omit
 * CommandLine/CreationDate, which are only needed by orphan identity checks.
 */
export async function readProcessTable({ detailed = true, cacheMs = DEFAULT_PROCESS_TABLE_CACHE_MS, force = false } = {}) {
  if (process.platform !== 'win32') return { ok: true, supported: false, rows: [] }
  const key = processTableKey(detailed)
  const now = Date.now()
  let entry = processTableCache.get(key)
  if (!entry) entry = { at: 0, value: null, pending: null }
  if (!force && cacheMs > 0 && entry.value && now - entry.at < cacheMs) {
    return { ...entry.value, cached: true, cacheAgeMs: now - entry.at }
  }
  if (!force && entry.pending) return entry.pending
  const started = Date.now()
  const script = buildProcessTableScript({ detailed })
  const run = (async () => {
    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        timeout: 12000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
      })
      let rows = parsePowerShellJson(stdout)
      if (rows === null) {
        processTableCache.set(key, { at: entry.at, value: entry.value, pending: null })
        return { ok: false, supported: true, error: 'process-table-parse-failed', rows: [], costMs: Date.now() - started, cached: false, cacheAgeMs: 0 }
      }
      if (!Array.isArray(rows)) rows = [rows]
      const value = { ok: true, supported: true, rows: rows.map(normalizeProcessRow), costMs: Date.now() - started, cached: false, cacheAgeMs: 0 }
      processTableCache.set(key, { at: Date.now(), value, pending: null })
      return value
    } catch (error) {
      processTableCache.set(key, { at: entry.at, value: entry.value, pending: null })
      return { ok: false, supported: true, error: String(error?.message ?? error), rows: [], costMs: Date.now() - started, cached: false, cacheAgeMs: 0 }
    }
  })()
  processTableCache.set(key, { at: entry.at, value: entry.value, pending: run })
  return run
}

/** Read one process row, including CreationDate and CommandLine. Windows-only; no table scan. */
export async function readProcessIdentity(pid) {
  if (process.platform !== 'win32') return { ok: true, supported: false, row: null }
  const target = Math.floor(Number(pid))
  if (!Number.isInteger(target) || target <= 0) return { ok: false, supported: true, error: 'bad-pid', row: null }
  const script = [
    `Get-CimInstance Win32_Process -Filter "ProcessId = ${target}" |`,
    '  Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PageFileUsage,CommandLine,CreationDate |',
    '  ConvertTo-Json -Compress',
  ].join('\n')
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024,
    })
    if (!String(stdout ?? '').trim()) return { ok: false, supported: true, error: 'not-found', row: null }
    let rows = parsePowerShellJson(stdout)
    if (rows === null) return { ok: false, supported: true, error: 'process-identity-parse-failed', row: null }
    if (Array.isArray(rows)) rows = rows[0]
    if (!rows || !Number(rows.ProcessId)) return { ok: false, supported: true, error: 'not-found', row: null }
    return { ok: true, supported: true, row: normalizeProcessRow(rows) }
  } catch (error) {
    return { ok: false, supported: true, error: String(error?.message ?? error), row: null }
  }
}

/** Select a root PID and all descendants from a process table. */
export function selectProcessTree(rows, rootPid) {
  const root = Number(rootPid)
  if (!Number.isInteger(root) || root <= 0) return []
  const byParent = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, [])
    byParent.get(row.ppid).push(row)
  }
  const out = []
  const stack = [root]
  const seen = new Set()
  while (stack.length) {
    const pid = stack.pop()
    if (seen.has(pid)) continue
    seen.add(pid)
    const row = rows.find((item) => item.pid === pid)
    if (row) out.push(row)
    for (const child of byParent.get(pid) ?? []) stack.push(child.pid)
  }
  return out
}

export function sumProcessTree(tree) {
  return {
    pids: tree.map((row) => row.pid),
    count: tree.length,
    workingSetMB: tree.reduce((n, row) => n + row.workingSetMB, 0),
    commitMB: tree.reduce((n, row) => n + row.commitMB, 0),
  }
}

/** Kill one process tree. Only intended for PIDs recorded by the task registry. */
export async function killProcessTree(rootPid) {
  const pid = Number(rootPid)
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, error: 'invalid-pid' }
  if (process.platform !== 'win32') {
    try { process.kill(pid, 'SIGKILL'); return { ok: true } } catch (error) { return { ok: false, error: String(error?.message ?? error) } }
  }
  try {
    await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 10000, windowsHide: true, maxBuffer: 65536 })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

export function memoryGuardDefaults() {
  return { enabled: true, minFreeMB: 4096, watchdogEnabled: true, watchIntervalMs: 30000, killCommitMB: 2048, growCommitMB: 768, singleActiveFork: true }
}
