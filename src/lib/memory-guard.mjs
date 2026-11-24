// SPDX-License-Identifier: AGPL-3.0-or-later
// Windows commit-memory guard + process-tree sampling for dsh-Fang.
// No native addon: PowerShell/CIM is queried at most once per cache window.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'

const execFileAsync = promisify(execFile)
const DEFAULT_CACHE_MS = 5000
let cache = { at: 0, value: null, pending: null }

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

/** Read Windows commit limit/free. Values are MB. Non-Windows returns a disabled shape. */
export async function readSystemMemory({ force = false, cacheMs = DEFAULT_CACHE_MS } = {}) {
  if (process.platform !== 'win32') {
    return { ok: true, supported: false, source: 'non-windows', commitLimitMB: null, commitFreeMB: null, physicalFreeMB: Math.round(os.freemem() / 1048576) }
  }
  const now = Date.now()
  if (!force && cache.value && now - cache.at < cacheMs) return cache.value
  if (!force && cache.pending) return cache.pending
  const script = [
    '$o = Get-CimInstance Win32_OperatingSystem',
    '$p = [pscustomobject]@{',
    '  CommitLimitMB = [math]::Round($o.TotalVirtualMemorySize / 1024)',
    '  CommitFreeMB = [math]::Round($o.FreeVirtualMemory / 1024)',
    '  PhysicalTotalMB = [math]::Round($o.TotalVisibleMemorySize / 1024)',
    '  PhysicalFreeMB = [math]::Round($o.FreePhysicalMemory / 1024)',
    '}',
    '$p | ConvertTo-Json -Compress',
  ].join('\n')
  const run = (async () => {
    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        timeout: 10000, windowsHide: true, maxBuffer: 65536,
      })
      const data = parsePowerShellJson(stdout)
      if (!data) return { ok: false, supported: true, source: 'powershell', error: 'memory-parse-failed' }
      const value = {
        ok: true,
        supported: true,
        source: 'powershell',
        commitLimitMB: Number(data.CommitLimitMB) || 0,
        commitFreeMB: Number(data.CommitFreeMB) || 0,
        physicalTotalMB: Number(data.PhysicalTotalMB) || 0,
        physicalFreeMB: Number(data.PhysicalFreeMB) || 0,
        at: now,
      }
      cache = { at: now, value, pending: null }
      return value
    } catch (error) {
      const value = { ok: false, supported: true, source: 'powershell', error: String(error?.message ?? error) }
      cache = { at: now, value, pending: null }
      return value
    }
  })()
  cache.pending = run
  return run
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

/** Snapshot all Windows processes into rows; caller filters by PID tree. */
export async function readProcessTable() {
  if (process.platform !== 'win32') return { ok: true, supported: false, rows: [] }
  const script = [
    'Get-CimInstance Win32_Process |',
    '  Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PageFileUsage,CommandLine |',
    '  ConvertTo-Json -Compress',
  ].join('\n')
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      timeout: 12000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    })
    let rows = parsePowerShellJson(stdout)
    if (rows === null) return { ok: false, supported: true, error: 'process-table-parse-failed', rows: [] }
    if (!Array.isArray(rows)) rows = [rows]
    return { ok: true, supported: true, rows: rows.map((row) => ({
      pid: Number(row.ProcessId),
      ppid: Number(row.ParentProcessId),
      name: String(row.Name ?? ''),
      workingSetMB: Math.round((Number(row.WorkingSetSize) || 0) / 1048576),
      commitMB: Math.round((Number(row.PageFileUsage) || 0) / 1048576),
      commandLine: String(row.CommandLine ?? ''),
    })) }
  } catch (error) {
    return { ok: false, supported: true, error: String(error?.message ?? error), rows: [] }
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
