// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// fork-supervisor — pure/codable pieces shared by fang-forker and its tests:
// restart backoff, orphan reconciliation, per-fork meta.json, and a loopback health probe.
// No process spawning here; the forker keeps that responsibility.

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

export const SUPERVISION_DEFAULTS = Object.freeze({
  maxRestarts: 3,
  baseMs: 1000,
  maxMs: 30000,
  jitter: 0.2,
  healthPath: '/',
  healthTimeoutMs: 1500,
})

export const META_FILE = 'fang-meta.json'
export const META_VERSION = 1

/** Exponential backoff with jitter; deterministic when `random` is injected. */
export function computeBackoff(attempt, options = {}) {
  const baseMs = Math.max(1, Number(options.baseMs ?? SUPERVISION_DEFAULTS.baseMs) || SUPERVISION_DEFAULTS.baseMs)
  const maxMs = Math.max(baseMs, Number(options.maxMs ?? SUPERVISION_DEFAULTS.maxMs) || SUPERVISION_DEFAULTS.maxMs)
  const jitter = Math.min(0.9, Math.max(0, Number(options.jitter ?? SUPERVISION_DEFAULTS.jitter) || 0))
  const random = typeof options.random === 'function' ? options.random : Math.random
  const n = Math.max(0, Math.floor(Number(attempt) || 0))
  const exp = Math.min(maxMs, baseMs * 2 ** n)
  const delta = exp * jitter
  return Math.max(0, Math.floor(exp + (random() * 2 - 1) * delta))
}

/**
 * Decide what supervision does after an exit.
 * Only crashes of a fork that had actually become ready are restarted; a failed first
 * spawn is reported to the orchestrator instead of loop-spawning.
 * @returns {{action:'restart'|'give-up'|'ignore', reason:string, attempt:number, delayMs:number}}
 */
export function planRestart(exitInfo, record = {}, policy = {}) {
  const intentional = record.intentionalStop === true
  const ready = record.ready === true
  const kind = String(exitInfo?.kind ?? 'crash')
  if (intentional) return { action: 'ignore', reason: 'intentional-stop', attempt: 0, delayMs: 0 }
  if (!ready) return { action: 'give-up', reason: 'never-ready', attempt: 0, delayMs: 0 }
  if (kind === 'normal') return { action: 'ignore', reason: 'normal-exit', attempt: 0, delayMs: 0 }
  const maxRestarts = Math.max(0, Number(policy.maxRestarts ?? SUPERVISION_DEFAULTS.maxRestarts) || 0)
  const attempt = Math.max(0, Number(record.restartCount ?? 0) || 0)
  if (attempt >= maxRestarts) return { action: 'give-up', reason: 'max-restarts', attempt, delayMs: 0 }
  return {
    action: 'restart',
    reason: kind === 'restart-request' ? 'restart-request' : 'crash',
    attempt,
    delayMs: computeBackoff(attempt, policy),
  }
}

/** Reconcile persisted records: alive pids keep running; dead ones become crashed; foreign pids are flagged. */
export function reconcileOrphans(records = [], isAlive = () => false) {
  const updates = []
  for (const rec of Array.isArray(records) ? records : []) {
    const pid = Number(rec?.pid)
    const liveStatus = ['provisioning', 'ready', 'running', 'starting'].includes(String(rec?.status ?? ''))
    if (!liveStatus) continue
    if (!Number.isInteger(pid) || pid <= 0) {
      updates.push({ forkId: rec.forkId, action: 'mark-crashed', reason: 'no-pid' })
      continue
    }
    if (isAlive(pid)) updates.push({ forkId: rec.forkId, action: 'keep', reason: 'pid-alive' })
    else updates.push({ forkId: rec.forkId, action: 'mark-crashed', reason: 'pid-dead', pid })
  }
  return updates
}

export function metaPath(homeDir) {
  return path.join(String(homeDir ?? ''), META_FILE)
}

/** Atomic per-fork meta (mode 0600). Never throws on read; write returns false on failure. */
export function writeForkMeta(homeDir, meta) {
  if (!homeDir) return false
  const file = metaPath(homeDir)
  const doc = { version: META_VERSION, at: new Date().toISOString(), ...meta }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
    return true
  } catch {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    return false
  }
}

export function readForkMeta(homeDir) {
  try {
    const doc = JSON.parse(fs.readFileSync(metaPath(homeDir), 'utf8'))
    return doc && typeof doc === 'object' ? doc : null
  } catch {
    return null
  }
}

/** Loopback probe: any HTTP response means the process is listening (connection refused means not). */
export function probeHttpAlive(port, options = {}) {
  const n = Math.floor(Number(port))
  if (!Number.isInteger(n) || n < 1 || n > 65535) return Promise.resolve(false)
  const host = options.host ?? '127.0.0.1'
  const pathName = options.path ?? SUPERVISION_DEFAULTS.healthPath
  const timeoutMs = Math.max(50, Number(options.timeoutMs ?? SUPERVISION_DEFAULTS.healthTimeoutMs) || SUPERVISION_DEFAULTS.healthTimeoutMs)
  return new Promise((resolve) => {
    const req = http.request({ host, port: n, path: pathName, method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume()
      resolve(true)
    })
    req.once('error', () => resolve(false))
    req.once('timeout', () => { req.destroy(); resolve(false) })
    req.end()
  })
}
