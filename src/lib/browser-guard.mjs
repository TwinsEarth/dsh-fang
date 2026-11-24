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

export async function lowerProcessPriority(pid) {
  const value = Number(pid)
  if (process.platform !== 'win32' || !Number.isInteger(value) || value <= 0) return { ok: false, error: 'unsupported' }
  return new Promise((resolve) => {
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${value} -ErrorAction Stop).PriorityClass = 'BelowNormal'`], { windowsHide: true, timeout: 5000 }, (error) => {
        resolve(error ? { ok: false, error: String(error.message ?? error) } : { ok: true })
      })
    } catch (error) { resolve({ ok: false, error: String(error?.message ?? error) }) }
  })
}

export function findBrowserPath(configured = '') {
  const explicit = String(configured || '').trim()
  if (explicit && fs.existsSync(explicit)) return explicit
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
  try { await lowerProcessPriority(pid) } catch { /* best effort */ }
  return { ok: true, pid, port, profileDir, logFile, crashDir, exe }
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
