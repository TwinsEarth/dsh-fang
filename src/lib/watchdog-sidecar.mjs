// SPDX-License-Identifier: AGPL-3.0-or-later
// Independent watchdog. Runs outside the DSH host so it can still clean up
// managed browsers / fork trees if the host dies or is force-killed.
// It only acts on PIDs written by the host into watchdog.json, and verifies the
// recorded CreationDate / CommandLine fingerprint before taskkill (PID reuse guard).
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { readProcessIdentity } from './memory-guard.mjs'
import { matchesProcessIdentity } from './process-identity.mjs'

const file = String(process.argv[2] ?? '')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let hostChecked = false
let stopReason = ''

function alive(pid) {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return false
  try { process.kill(value, 0); return true } catch { return false }
}

/**
 * A live PID can still be a hung host. The host writes host-state.json every
 * 15 s; if its mtime is older than hostStuckMs (default 60 s), the event loop
 * is no longer making progress and the sidecar must drain children.
 */
function heartbeatState(data) {
  const heartbeatFile = String(data?.heartbeatFile ?? '')
  const limitMs = Math.max(15000, Number(data?.hostStuckMs) || 60000)
  if (!heartbeatFile) return { available: false, stale: false, ageMs: null, limitMs }
  try {
    const stat = fs.statSync(heartbeatFile)
    const ageMs = Math.max(0, Date.now() - Number(stat.mtimeMs))
    return { available: true, stale: ageMs > limitMs, ageMs, limitMs, at: stat.mtime.toISOString() }
  } catch {
    // Before the first heartbeat the file may not exist. Do not kill on a
    // missing path; host exit/PID identity still cover that window.
    return { available: false, stale: false, ageMs: null, limitMs }
  }
}

async function hostIsDead(data, hostPid) {
  if (data.stop === true || data.clean === true) { stopReason = 'host-clean-stop'; return true }
  if (!alive(hostPid)) { stopReason = 'host-exit'; return true }
  const heartbeat = heartbeatState(data)
  if (heartbeat.stale) { stopReason = 'host-heartbeat-stale'; return { dead: true, heartbeat } }
  // A live PID is not enough: after a host crash its PID can be recycled.
  // hostStartedAt is written by the host at boot; mismatch means a different process.
  if (hostChecked || data.hostStartedAt === undefined || data.hostStartedAt === null) return false
  hostChecked = true
  const identity = await readProcessIdentity(hostPid).catch(() => null)
  if (identity?.ok && identity.row && Number.isFinite(Number(identity.row.createdAt))) {
    const expected = Number(data.hostStartedAt)
    if (Number.isFinite(expected) && Math.abs(Number(identity.row.createdAt) - expected) > 120_000) {
      stopReason = 'host-pid-reused'
      return true
    }
  }
  return false
}

function hasTargetIdentity(target) {
  return Boolean(target?.commandLineHash)
    || (target?.createdAt !== undefined && target?.createdAt !== null)
    || (Array.isArray(target?.tokens) && target.tokens.length > 0)
}

async function killTree(target) {
  const value = Number(target?.pid)
  if (!Number.isInteger(value) || value <= 0) return { ok: false, error: 'invalid-pid' }
  if (!hasTargetIdentity(target)) return { ok: false, error: 'target-identity-missing' }
  const identity = await readProcessIdentity(value).catch((error) => ({ ok: false, error: String(error?.message ?? error), row: null }))
  if (!identity.ok || !identity.row) return { ok: false, error: identity.error ?? 'target-not-found' }
  const matched = matchesProcessIdentity(identity.row, {
    pid: value,
    startedAt: target.createdAt,
    commandLineHash: target.commandLineHash ?? null,
    tokens: target.tokens,
    profile: target.profile,
    port: target.port,
  })
  if (!matched.ok) return { ok: false, error: `pid-reuse:${matched.reason}`, detail: matched.detail ?? null }
  try {
    const result = spawnSync('taskkill.exe', ['/PID', String(value), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 })
    if (result.error) return { ok: false, error: String(result.error.message ?? result.error) }
    if (result.status !== 0) return { ok: false, error: `taskkill-exit-${result.status ?? 'null'}` }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

async function main() {
  if (!file) process.exit(0)
  for (;;) {
    let data = null
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* host may be writing */ }
    if (!data) { await sleep(2000); continue }
    const hostPid = Number(data.hostPid)
    const targets = Array.isArray(data.targets) ? data.targets : []
    const dead = await hostIsDead(data, hostPid)
    if (dead === true || dead?.dead === true) {
      const reason = stopReason || 'host-dead'
      const heartbeat = dead?.heartbeat ?? heartbeatState(data)
      const skipped = []
      for (const target of targets) {
        const result = await killTree(target)
        if (!result.ok) skipped.push({ pid: target.pid, kind: target.kind ?? '', taskId: target.taskId ?? '', error: result.error, detail: result.detail ?? null })
      }
      try { fs.writeFileSync(file, JSON.stringify({ ...data, stoppedAt: new Date().toISOString(), stop: true, stopReason: reason, heartbeat, skipped }, null, 2)) } catch { /* ignore */ }
      process.exit(0)
    }
    await sleep(2000)
  }
}

main().catch(() => process.exit(0))
