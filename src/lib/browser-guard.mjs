// SPDX-License-Identifier: AGPL-3.0-or-later
// Managed Chromium browser for fork Web pages.
// Why: the default browser is outside Fang's process tree, so it cannot be
// measured, force-closed, or crash-dumped. This module launches a dedicated
// profile and exposes CDP metrics for the memory guard.
import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

export function isLoweredPriorityClass(value) {
  const text = String(value ?? '').trim().toLowerCase()
  return text === 'idle' || text === 'belownormal'
}

function parsePowerShellJson(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null
  try { return JSON.parse(trimmed) } catch { /* fall through */ }
  const start = trimmed.search(/[[{]/)
  const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'))
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)) } catch { /* ignore */ }
  }
  return null
}

/** Pure summary used by tests and by the browser audit path. */
export function summarizePriorityRows(rows = [], rootPid = 0) {
  const list = (Array.isArray(rows) ? rows : []).map((row) => {
    const rawError = row?.error ?? row?.Error
    return {
      pid: Number(row?.pid ?? row?.Id),
      name: String(row?.name ?? row?.Name ?? ''),
      exists: row?.exists !== false && row?.Exists !== false,
      before: String(row?.before ?? row?.Before ?? ''),
      after: String(row?.after ?? row?.After ?? ''),
      changed: row?.changed === true || row?.Changed === true,
      skipped: row?.skipped === true || row?.Skipped === true,
      error: rawError == null || rawError === '' ? null : String(rawError),
    }
  })
  const root = list.find((row) => row.pid === Number(rootPid))
  const alive = list.filter((row) => row.exists)
  const lowered = alive.filter((row) => isLoweredPriorityClass(row.after))
  const rootOk = Boolean(root?.exists)
  return {
    ok: rootOk,
    partial: rootOk && lowered.length < alive.length,
    rootPid: Number(rootPid) || 0,
    count: list.length,
    lowered: lowered.length,
    changed: alive.filter((row) => row.changed).length,
    alreadyLow: alive.filter((row) => row.skipped || (isLoweredPriorityClass(row.before) && !row.changed)).length,
    missing: list.length - alive.length,
    failed: alive.filter((row) => row.error).length,
    notLowered: alive.filter((row) => !isLoweredPriorityClass(row.after)).length,
    rootOnly: list.length <= 1,
    rows: list,
    error: rootOk ? null : 'root-not-found',
  }
}

/** Build the PowerShell one-shot tree sampler. Exported so tests can assert recursion and safety. */
export function buildPriorityTreeScript(rootPid) {
  const root = Math.floor(Number(rootPid))
  if (!Number.isInteger(root) || root <= 0) throw new Error('invalid-pid')
  return [
    `$root = ${root}`,
    '$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId',
    '$byParent = @{}',
    'foreach ($item in $all) {',
    '  $key = [string]([int]$item.ParentProcessId)',
    '  if (-not $byParent.ContainsKey($key)) { $byParent[$key] = New-Object System.Collections.Generic.List[object] }',
    '  [void]$byParent[$key].Add($item)',
    '}',
    '$targets = New-Object System.Collections.Generic.List[int]',
    '[void]$targets.Add([int]$root)',
    '$stack = New-Object System.Collections.Generic.Stack[int]',
    '$stack.Push([int]$root)',
    '$seen = @{}',
    'while ($stack.Count -gt 0) {',
    '  $id = [int]$stack.Pop()',
    '  if ($seen.ContainsKey($id)) { continue }',
    '  $seen[$id] = $true',
    '  $children = $byParent[[string]$id]',
    '  if ($null -ne $children) {',
    '    foreach ($child in $children) {',
    '      $cid = [int]$child.ProcessId',
    '      if (-not $seen.ContainsKey($cid) -and -not $targets.Contains($cid)) {',
    '        [void]$targets.Add($cid)',
    '        $stack.Push($cid)',
    '      }',
    '    }',
    '  }',
    '}',
    '$rows = @()',
    'foreach ($id in $targets) {',
    '  $p = Get-Process -Id $id -ErrorAction SilentlyContinue',
    '  if ($null -eq $p) {',
    '    $rows += [pscustomobject]@{ Id=$id; Name=""; Exists=$false; Before=""; After=""; Changed=$false; Skipped=$false; Error="not-found" }',
    '    continue',
    '  }',
    '  $before = [string]$p.PriorityClass',
    '  $changed = $false; $skipped = $false; $setError = $null',
    '  if ($before -in @("Idle","BelowNormal")) { $skipped = $true }',
    '  else {',
    '    try { $p.PriorityClass = "BelowNormal"; $changed = $true } catch { $setError = $_.Exception.Message }',
    '    try { $p.Refresh() } catch {}',
    '  }',
    '  $after = [string]$p.PriorityClass',
    '  $rows += [pscustomobject]@{ Id=$id; Name=$p.ProcessName; Exists=$true; Before=$before; After=$after; Changed=$changed; Skipped=$skipped; Error=$setError }',
    '}',
    '$rows | ConvertTo-Json -Compress -Depth 4',
  ].join('\n')
}

function setRootPriorityFallback(pid) {
  return new Promise((resolve) => {
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).PriorityClass = 'BelowNormal'`], { windowsHide: true, timeout: 5000 }, (error) => {
        resolve(error ? { ok: false, error: String(error.message ?? error), rootOnly: true, partial: true } : { ok: true, rootOnly: true, partial: true })
      })
    } catch (error) { resolve({ ok: false, error: String(error?.message ?? error), rootOnly: true, partial: true }) }
  })
}

/**
 * Lower the browser/fork process tree, not only the root. Chromium renderer/GPU
 * children may or may not inherit the root priority; the tree is sampled before
 * and after so callers can audit what actually changed.
 */
export async function lowerProcessPriority(pid, { timeoutMs = 10000 } = {}) {
  const value = Number(pid)
  if (process.platform !== 'win32' || !Number.isInteger(value) || value <= 0) return { ok: false, error: 'unsupported' }
  let script = ''
  try { script = buildPriorityTreeScript(value) } catch (error) { return { ok: false, error: String(error?.message ?? error) } }
  const output = await new Promise((resolve) => {
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
        if (error) { resolve({ ok: false, error: String(error.message ?? error) }); return }
        resolve({ ok: true, stdout: String(stdout ?? '') })
      })
    } catch (error) { resolve({ ok: false, error: String(error?.message ?? error) }) }
  })
  if (!output.ok) {
    const fallback = await setRootPriorityFallback(value)
    return { ...fallback, tree: false, detail: output.error }
  }
  const parsed = parsePowerShellJson(output.stdout)
  if (parsed === null) {
    const fallback = await setRootPriorityFallback(value)
    return { ...fallback, tree: false, detail: 'priority-json-parse-failed' }
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return { ...summarizePriorityRows(rows, value), tree: true }
}

export function findBrowserPath(configured = '') {
  const explicit = String(configured || '').trim()
  // An explicitly configured browser path is authoritative. If it is stale,
  // failing closed is safer than silently substituting another browser: the
  // caller asked for a specific managed executable, not "any browser".
  if (explicit) return fs.existsSync(explicit) ? explicit : ''
  for (const candidate of [...EDGE_CANDIDATES, ...CHROME_CANDIDATES]) if (fs.existsSync(candidate)) return candidate
  return ''
}

export function isPidAlive(pid) {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return false
  try { process.kill(value, 0); return true } catch { return false }
}

export async function freePort(start = 19300, end = 19400) {
  for (let port = start; port <= end; port += 1) {
    const ok = await new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => server.close(() => resolve(true)))
      server.listen(port, '127.0.0.1')
    })
    if (ok) return port
  }
  return 0
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

/** Launch an isolated app window and wait for its CDP endpoint. */
export async function launchManagedBrowser({ exe, url, profileDir, logDir, port, extraArgs = [] }) {
  if (!exe || !fs.existsSync(exe)) return { ok: false, error: 'browser-unavailable' }
  fs.mkdirSync(profileDir, { recursive: true })
  fs.mkdirSync(logDir, { recursive: true })
  const logFile = path.join(logDir, `browser-${Date.now()}.log`)
  const crashDir = path.join(logDir, 'crash-dumps')
  fs.mkdirSync(crashDir, { recursive: true })
  const args = [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-features=msEdgeSyncConfirmation,msEdgeIdentity',
    '--renderer-process-limit=1',
    '--enable-logging',
    `--log-file=${logFile}`,
    '--enable-crash-reporter',
    `--crash-dumps-dir=${crashDir}`,
    '--js-flags=--max-old-space-size=2048',
    ...extraArgs,
  ]
  let child
  try {
    child = spawn(exe, args, { detached: false, stdio: 'ignore', windowsHide: false })
  } catch (error) {
    return { ok: false, error: 'browser-spawn-failed', detail: String(error?.message ?? error) }
  }
  child.on('error', () => {})
  child.unref?.()
  const pid = Number(child.pid)
  let ready = false
  for (let i = 0; i < 40; i += 1) {
    await sleep(250)
    if (!isPidAlive(pid)) break
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) { ready = true; break }
    } catch { /* not ready */ }
  }
  if (!ready) {
    try { await closeManagedBrowser({ pid, port }) } catch { /* ignore */ }
    return { ok: false, error: 'browser-cdp-timeout', pid }
  }
  let priority = null
  try { priority = await lowerProcessPriority(pid) } catch (error) { priority = { ok: false, error: String(error?.message ?? error) } }
  return { ok: true, pid, port, profileDir, logFile, crashDir, exe, priority }
}

export async function closeManagedBrowser({ pid, port, graceMs = 3000, timeoutMs = 3000 }) {
  const value = Number(pid)
  if (Number.isInteger(value) && value > 0) {
    // 1) Ask the browser to close itself, giving the page a chance to flush.
    let graceful = false
    if (port) {
      try { graceful = await browserCloseCdp(port) } catch { graceful = false }
      for (let i = 0; i < Math.ceil(Math.max(0, graceMs) / 100); i += 1) {
        if (!isPidAlive(value)) return { ok: true, graceful: true }
        await sleep(100)
      }
    }
    // 2) Force the whole tree only after the grace window.
    if (process.platform === 'win32') {
      try {
        await new Promise((resolve) => {
          const child = spawn('taskkill.exe', ['/PID', String(value), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
          child.once('exit', resolve)
          child.once('error', resolve)
        })
      } catch { /* ignore */ }
    } else {
      try { process.kill(-value, 'SIGKILL') } catch { try { process.kill(value, 'SIGKILL') } catch { /* ignore */ } }
    }
    for (let i = 0; i < Math.ceil(timeoutMs / 100); i += 1) {
      if (!isPidAlive(value)) break
      await sleep(100)
    }
    return { ok: !isPidAlive(value), graceful: false }
  }
  return { ok: true, graceful: true }
}

async function cdpTargets(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) return []
    const list = await response.json()
    return Array.isArray(list) ? list.filter((item) => item.type === 'page' && item.webSocketDebuggerUrl) : []
  } catch { return [] }
}

function cdpEvaluate(wsUrl, expression, timeoutMs = 2500) {
  return cdpCommand(wsUrl, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false }, timeoutMs).then((result) => result?.result?.value ?? null)
}

function cdpCommand(wsUrl, method, params = {}, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let ws
    let timer
    try {
      ws = new WebSocket(wsUrl)
    } catch {
      resolve(null)
      return
    }
    const done = (value) => {
      try { clearTimeout(timer) } catch { /* ignore */ }
      try { ws?.close() } catch { /* ignore */ }
      resolve(value)
    }
    timer = setTimeout(() => done(null), timeoutMs)
    ws.addEventListener('open', () => {
      try { ws.send(JSON.stringify({ id: 1, method, params })) } catch { done(null) }
    })
    ws.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data))
        if (message.id !== 1) return
        done(message.result ?? null)
      } catch { done(null) }
    })
    ws.addEventListener('error', () => done(null))
    ws.addEventListener('close', () => done(null))
  })
}

async function browserCloseCdp(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })
    if (!response.ok) return false
    const info = await response.json()
    if (!info.webSocketDebuggerUrl) return false
    await cdpCommand(info.webSocketDebuggerUrl, 'Browser.close', {}, 1500)
    return true
  } catch { return false }
}


/** Read DOM/heap/visibility from the managed page. */
/** Best-effort page flush before force-close; server-side session persistence is authoritative. */
export async function flushManagedBrowser(port) {
  const targets = await cdpTargets(port)
  if (!targets.length) return { ok: false, error: 'no-page' }
  const target = targets[0]
  await cdpEvaluate(target.webSocketDebuggerUrl, `(() => {
    try { window.dispatchEvent(new Event('pagehide')); window.dispatchEvent(new Event('beforeunload')); } catch (e) {}
    return true;
  })()`, 1200)
  return { ok: true }
}

/**
 * Experimental hidden-tab pause. Chromium supports Page.setWebLifecycleState
 * with 'frozen'/'active'; callers must keep this off by default until a real
 * fork page has been verified to wake up and accept input after 'active'.
 */
export async function setManagedBrowserLifecycle(port, state) {
  const normalized = state === 'frozen' ? 'frozen' : 'active'
  const targets = await cdpTargets(port)
  if (!targets.length) return { ok: false, state: normalized, error: 'no-page' }
  const target = targets.find((item) => item.url?.startsWith('http://127.0.0.1:')) ?? targets[0]
  await cdpCommand(target.webSocketDebuggerUrl, 'Page.enable', {}, 1500)
  const result = await cdpCommand(target.webSocketDebuggerUrl, 'Page.setWebLifecycleState', { state: normalized }, 1500)
  if (!result || typeof result !== 'object') return { ok: false, state: normalized, error: 'cdp-lifecycle-failed' }
  return { ok: true, state: normalized }
}

export async function sampleManagedBrowser(port) {
  const targets = await cdpTargets(port)
  if (!targets.length) return { ok: false, error: 'browser-cdp-no-page' }
  const target = targets.find((item) => item.url?.startsWith('http://127.0.0.1:')) ?? targets[0]
  const value = await cdpEvaluate(target.webSocketDebuggerUrl, `(() => {
    return { visibility: document.visibilityState, url: location.href };
  })()`)
  if (!value || typeof value !== 'object') return { ok: false, error: 'browser-cdp-evaluate-failed' }
  const perf = await cdpCommand(target.webSocketDebuggerUrl, 'Performance.getMetrics', {}, 2000)
  const dom = await cdpCommand(target.webSocketDebuggerUrl, 'Memory.getDOMCounters', {}, 2000)
  const heap = await cdpCommand(target.webSocketDebuggerUrl, 'Runtime.getHeapUsage', {}, 2000)
  const metrics = Array.isArray(perf?.metrics)
    ? Object.fromEntries(perf.metrics.map((item) => [item.name, item.value]))
    : {}
  return {
    ok: true,
    visibility: value.visibility,
    url: value.url,
    heapBytes: Number(metrics.JSHeapUsedSize || heap?.usedSize || dom?.jsHeapUsedSize || 0),
    nodes: Number(perf?.nodes ?? metrics.Nodes ?? dom?.nodes ?? 0),
    documents: Number(metrics.Documents ?? dom?.documents ?? 0),
    listeners: Number(dom?.jsEventListeners ?? 0),
    layoutCount: Number(metrics.LayoutCount ?? 0),
  }
}
