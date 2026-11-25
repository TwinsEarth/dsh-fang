// SPDX-License-Identifier: AGPL-3.0-or-later
// Fork open health gate: session size/event count, adapter state, and the fork's
// own /api/health response. Pure helpers are exported for unit tests; the HTTP
// probe is bounded so a broken fork cannot hang the mother.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import http from 'node:http'
import { scanForkSessions } from './fork-sessions.mjs'

export const FORK_HEALTH_DEFAULTS = Object.freeze({
  path: '/fang/api/health',
  fallbackPaths: ['/api/health'],
  timeoutMs: 2000,
  maxSessionMB: 64,
  maxEvents: 50000,
  maxUncompressedBytes: 64 * 1024 * 1024,
})

function boundedNumber(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * Count newline-delimited session frames without loading the whole log.
 * The stream is destroyed as soon as the event budget is exceeded, so a 500 MB
 * session cannot become a 500 MB allocation in the mother process.
 */
export async function countSessionEvents(file, options = {}) {
  const maxEvents = Math.floor(boundedNumber(options.maxEvents, FORK_HEALTH_DEFAULTS.maxEvents, 1, 10_000_000))
  const maxUncompressedBytes = Math.floor(boundedNumber(options.maxUncompressedBytes, FORK_HEALTH_DEFAULTS.maxUncompressedBytes, 1024, 2 * 1024 * 1024 * 1024))
  let stream = null
  try {
    if (typeof zlib.createZstdDecompress !== 'function') {
      return { ok: false, error: 'zstd-stream-unavailable', events: null, bytes: 0, truncated: false }
    }
    stream = fs.createReadStream(file).pipe(zlib.createZstdDecompress())
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), events: null, bytes: 0, truncated: false }
  }
  let bytes = 0
  let lines = 0
  let lastByte = 0
  let truncated = false
  let error = null
  try {
    for await (const chunk of stream) {
      bytes += chunk.length
      if (bytes > maxUncompressedBytes) {
        truncated = true
        try { stream.destroy() } catch { /* ignore */ }
        break
      }
      for (let i = 0; i < chunk.length; i += 1) {
        if (chunk[i] === 0x0a) {
          lines += 1
          if (lines > maxEvents) {
            truncated = true
            try { stream.destroy() } catch { /* ignore */ }
            break
          }
        }
      }
      if (truncated) break
      if (chunk.length > 0) lastByte = chunk[chunk.length - 1]
    }
  } catch (e) {
    error = String(e?.message ?? e)
  }
  if (bytes > 0 && lastByte !== 0x0a && !truncated) lines += 1
  return {
    ok: error === null,
    error,
    events: lines,
    bytes,
    truncated,
    maxEvents,
    maxUncompressedBytes,
  }
}

/**
 * Inspect a fork home's own session store. The largest session is the one that
 * decides whether opening a browser is safe; total bytes/count are reported too.
 */
export async function inspectForkSessionHealth(homeDir, options = {}) {
  const maxCompressedBytes = Math.floor(boundedNumber(options.maxSessionMB, FORK_HEALTH_DEFAULTS.maxSessionMB, 1, 4096)) * 1024 * 1024
  const maxEvents = Math.floor(boundedNumber(options.maxEvents, FORK_HEALTH_DEFAULTS.maxEvents, 1, 10_000_000))
  const sessions = scanForkSessions(homeDir)
  const totalBytes = sessions.reduce((sum, row) => sum + (Number(row.bytes) || 0), 0)
  if (sessions.length === 0) {
    return {
      ok: true, sessions: 0, totalBytes: 0, largestBytes: 0,
      largestSessionId: null, events: 0, eventScan: null, truncated: false,
    }
  }
  const largest = sessions.reduce((max, row) => (Number(row.bytes) > Number(max.bytes) ? row : max), sessions[0])
  if (largest.bytes > maxCompressedBytes) {
    return {
      ok: false,
      error: 'session-too-large',
      sessions: sessions.length,
      totalBytes,
      largestBytes: largest.bytes,
      largestSessionId: largest.sessionId,
      events: null,
      eventScan: null,
      truncated: true,
      maxSessionBytes: maxCompressedBytes,
    }
  }
  const eventScan = await countSessionEvents(largest.file, {
    maxEvents,
    maxUncompressedBytes: Math.min(
      FORK_HEALTH_DEFAULTS.maxUncompressedBytes,
      Math.max(4 * 1024 * 1024, maxCompressedBytes * 8),
    ),
  })
  return {
    ok: eventScan.ok === true,
    error: eventScan.error ?? null,
    sessions: sessions.length,
    totalBytes,
    largestBytes: largest.bytes,
    largestSessionId: largest.sessionId,
    events: eventScan.events,
    eventScan,
    truncated: eventScan.truncated === true,
    maxSessionBytes: maxCompressedBytes,
    maxEvents,
  }
}

/** Pure gate used before opening a managed browser. */
export function evaluateForkHealth({ session = null, adapter = null, http = null, limits = {} } = {}) {
  const failures = []
  const maxSessionMB = boundedNumber(limits.maxSessionMB, FORK_HEALTH_DEFAULTS.maxSessionMB, 1, 4096)
  const maxEvents = boundedNumber(limits.maxEvents, FORK_HEALTH_DEFAULTS.maxEvents, 1, 10_000_000)
  if (adapter && adapter.ok !== true) {
    failures.push({ code: 'fork-adapter-unavailable', detail: String(adapter.error ?? 'adapter not ready') })
  }
  if (session) {
    if (session.ok === false) failures.push({ code: 'fork-session-unreadable', detail: session.error ?? 'session scan failed' })
    if (Number(session.largestBytes) > maxSessionMB * 1024 * 1024) {
      failures.push({ code: 'fork-health-session-too-large', detail: `largest=${session.largestBytes}B > ${maxSessionMB}MB` })
    }
    if (session.truncated === true) {
      failures.push({ code: 'fork-health-events-limit', detail: `events >= ${session.events ?? maxEvents} (limit ${maxEvents})` })
    }
    if (Number(session.events) >= maxEvents) {
      failures.push({ code: 'fork-health-events-limit', detail: `events=${session.events} >= ${maxEvents}` })
    }
  }
  if (http) {
    if (http.ok !== true) {
      failures.push({ code: 'fork-health-endpoint-unavailable', detail: http.error ?? `status=${http.status ?? 'none'}` })
    } else if (http.data && http.data.ok === false) {
      failures.push({ code: 'fork-health-rejected', detail: String(http.data.error ?? http.data.reason ?? 'health reported not-ok') })
    } else {
      const remote = http.data?.session
      if (remote && Number(remote.largestBytes) > maxSessionMB * 1024 * 1024) {
        failures.push({ code: 'fork-health-session-too-large', detail: `remote largest=${remote.largestBytes}B` })
      }
      if (remote && remote.truncated === true) {
        failures.push({ code: 'fork-health-events-limit', detail: 'remote session scan truncated' })
      }
      if (http.data?.adapter && http.data.adapter.ok === false) {
        failures.push({ code: 'fork-adapter-unavailable', detail: String(http.data.adapter.error ?? 'adapter reported not-ok') })
      }
    }
  }
  return {
    ok: failures.length === 0,
    failures,
    error: failures[0]?.code ?? null,
    detail: failures[0]?.detail ?? null,
    session,
    adapter,
    http: http ? { ok: http.ok === true, status: http.status ?? null, path: http.path ?? null, data: http.data ?? null } : null,
  }
}

function fetchJson(port, pathName, timeoutMs) {
  return new Promise((resolve) => {
    let resolved = false
    const done = (value) => {
      if (resolved) return
      resolved = true
      resolve(value)
    }
    let req = null
    try {
      req = http.request({
        host: '127.0.0.1',
        port: Number(port),
        path: pathName,
        method: 'GET',
        timeout: timeoutMs,
        headers: { host: `127.0.0.1:${Number(port)}`, accept: 'application/json' },
      }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
          if (body.length > 256 * 1024) {
            try { req.destroy() } catch { /* ignore */ }
            done({ ok: false, status: res.statusCode, error: 'health-body-too-large', path: pathName })
          }
        })
        res.on('end', () => {
          const status = Number(res.statusCode) || 0
          let data = null
          try { data = body ? JSON.parse(body) : null } catch { data = null }
          done({
            ok: status >= 200 && status < 300 && data && data.ok !== false,
            status,
            path: pathName,
            data,
            error: status >= 200 && status < 300 ? (data ? null : 'health-body-not-json') : `http-${status}`,
          })
        })
      })
      req.once('timeout', () => { try { req.destroy() } catch { /* ignore */ } done({ ok: false, status: null, path: pathName, error: 'health-timeout' }) })
      req.once('error', (error) => done({ ok: false, status: null, path: pathName, error: String(error?.message ?? error) }))
      req.end()
    } catch (error) {
      done({ ok: false, status: null, path: pathName, error: String(error?.message ?? error) })
    }
  })
}

/** Try the configured path, then the conventional /api/health. 404 is not fatal to trying the fallback. */
export async function probeForkHealth(port, options = {}) {
  const timeoutMs = boundedNumber(options.timeoutMs, FORK_HEALTH_DEFAULTS.timeoutMs, 100, 30_000)
  const paths = [options.path, ...(Array.isArray(options.fallbackPaths) ? options.fallbackPaths : FORK_HEALTH_DEFAULTS.fallbackPaths)]
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim())
    .filter((item, index, list) => list.indexOf(item) === index)
  const probes = []
  for (const pathName of paths) {
    const result = await fetchJson(port, pathName, timeoutMs)
    probes.push(result)
    if (result.ok === true) return { ...result, probes }
    if (result.status !== 404) break
  }
  const last = probes[probes.length - 1] ?? { ok: false, error: 'health-path-missing' }
  return { ...last, ok: false, probes }
}

export function forkHealthPathForPrefix(prefix = '/fang') {
  const base = String(prefix || '/fang').replace(/\/+$/, '') || '/fang'
  return path.posix.join(base, '/api/health')
}
