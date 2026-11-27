// SPDX-License-Identifier: AGPL-3.0-or-later
// Accelerated Web sidecar: keeps the original DSH process untouched and starts
// a second @twinsearth/dsh Web process with its own profile and port.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { ensureDir, readJson, writeJsonAtomic } from '../kernel/index.mjs'
import { readProcessIdentity } from './memory-guard.mjs'
import { hashCommandLine, matchesProcessIdentity } from './process-identity.mjs'

export const ACCELERATED_STATE_FILE = 'accelerated-web.json'
export const DEFAULT_ACCELERATED_PORT = 18080
export const URL_PATTERN = /dsh web: (https?:\/\/\S+)/

/** Resolve the accelerated CLI: explicit config, env, or the installed package bin. */
export function resolveAcceleratedCli({ cliPath = '', env = process.env } = {}) {
  const explicit = String(cliPath ?? '').trim()
  if (explicit) return explicit
  const fromEnv = String(env.FANG_ACCEL_CLI ?? '').trim()
  if (fromEnv) return fromEnv
  return ''
}

/** Build the argv for one accelerated Web process. */
export function buildAcceleratedArgs({ profile = 'fang-accelerated', port = DEFAULT_ACCELERATED_PORT, resetProfile = false } = {}) {
  const args = []
  if (resetProfile) args.push('--from-default-profile', 'web')
  args.push('--profile', profile, '--port', String(port), '--no-open')
  return args
}

/** Read the persisted sidecar state. */
export function readAcceleratedState(dataDir) {
  return readJson(path.join(dataDir, ACCELERATED_STATE_FILE), null)
}

function acceleratedTokens({ profile, port }) {
  const profileText = String(profile ?? '').trim()
  const portText = String(Number(port) || DEFAULT_ACCELERATED_PORT)
  return profileText ? ['--profile', profileText, '--port', portText] : []
}

function identityForState(state) {
  const pid = Number(state?.pid)
  const tokens = Array.isArray(state?.pidIdentity?.tokens) && state.pidIdentity.tokens.length
    ? state.pidIdentity.tokens
    : acceleratedTokens({ profile: state?.profile, port: state?.port })
  return { ...(state?.pidIdentity ?? {}), pid, port: Number(state?.port) || null, tokens }
}

function identityFromRow(row, { pid, profile, port }) {
  const createdAt = Number(row?.createdAt)
  return {
    pid: Number(pid),
    startedAt: Number.isFinite(createdAt) ? createdAt : null,
    commandLineHash: row?.commandLine ? hashCommandLine(row.commandLine) : null,
    tokens: acceleratedTokens({ profile, port }),
    capturedAt: Date.now(),
    source: 'cim',
  }
}

/** Verify a persisted sidecar PID before reuse/status/stop. */
async function verifyStateIdentity(state, { readIdentityImpl = readProcessIdentity } = {}) {
  const pid = Number(state?.pid)
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, exists: false, reason: 'bad-pid' }
  const identity = identityForState(state)
  const current = await readIdentityImpl(pid).catch((error) => ({ ok: false, error: String(error?.message ?? error), row: null }))
  if (!current.ok) {
    return {
      ok: false,
      exists: String(current.error ?? '') !== 'not-found',
      reason: current.error ?? 'identity-unreadable',
      identity,
    }
  }
  const matched = matchesProcessIdentity(current.row, identity)
  return { ok: matched.ok, exists: true, reason: matched.reason, detail: matched.detail ?? null, row: current.row, identity }
}

async function probeHttp(port, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
    return response.ok || response.status < 500
  } catch {
    return false
  }
}

/** Start the accelerated process; returns its PID and URL after the URL line. */
export async function startAcceleratedWeb({ dataDir, cliPath, profile = 'fang-accelerated', port = DEFAULT_ACCELERATED_PORT, home = process.env.DSH_HOME, timeoutMs = 60000, spawnImpl = spawn, fetchImpl = fetch, readIdentityImpl = readProcessIdentity } = {}) {
  const previous = readAcceleratedState(dataDir)
  if (previous?.pid) {
    const existing = await verifyStateIdentity(previous, { readIdentityImpl })
    if (existing.ok) {
      if (await probeHttp(previous.port, fetchImpl)) return { ok: true, already: true, ...previous, pidIdentity: existing.identity }
      return { ok: false, error: 'accelerated-existing-not-serving', pid: previous.pid, state: previous }
    }
    if (existing.exists) return { ok: false, error: 'accelerated-existing-identity-mismatch', reason: existing.reason, pid: previous.pid, state: previous }
  }
  const cli = resolveAcceleratedCli({ cliPath })
  if (!cli) return { ok: false, error: 'accelerated-cli-missing' }
  ensureDir(dataDir)
  const profileDir = path.join(home ?? '', 'profiles', profile)
  const resetProfile = !profileDir || !readJson(path.join(profileDir, 'package.json'), null)
  const args = buildAcceleratedArgs({ profile, port, resetProfile })
  const isScript = /\.(?:mjs|cjs|js)$/i.test(cli)
  const child = spawnImpl(isScript ? process.execPath : cli, isScript ? [cli, ...args] : args, {
    env: { ...process.env, ...(home ? { DSH_HOME: home } : {}) },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('accelerated-web-start-timeout')), timeoutMs)
    const onData = (chunk) => {
      output += String(chunk)
      const match = URL_PATTERN.exec(output)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => { if (!URL_PATTERN.test(output)) { clearTimeout(timer); reject(new Error(`accelerated-web-exited-${code}`)) } })
  }).catch((error) => {
    try { child.kill() } catch { /* already gone */ }
    return { error }
  })
  if (typeof url !== 'string') return { ok: false, error: url.error?.message ?? 'accelerated-web-start-failed', output: output.slice(-2000) }
  // Capture a capture-time fingerprint before the first possible stop. If CIM
  // is unavailable, argv tokens are still a safe fallback for this exact process.
  const current = await readIdentityImpl(child.pid).catch((error) => ({ ok: false, error: String(error?.message ?? error), row: null }))
  const pidIdentity = current?.ok === true
    ? identityFromRow(current.row, { pid: child.pid, profile, port })
    : { pid: child.pid, tokens: acceleratedTokens({ profile, port }), capturedAt: Date.now(), source: 'spawn-provisional' }
  const state = { version: 1, pid: child.pid, url, port, profile, cliPath: cli, startedAt: new Date().toISOString(), running: true, pidIdentity, identityCheckedAt: Date.now() }
  writeJsonAtomic(path.join(dataDir, ACCELERATED_STATE_FILE), state)
  child.once('exit', () => {
    const current = readAcceleratedState(dataDir)
    if (current?.pid === child.pid) writeJsonAtomic(path.join(dataDir, ACCELERATED_STATE_FILE), { ...current, running: false, stoppedAt: new Date().toISOString() })
  })
  return { ok: true, ...state }
}

/** Stop the sidecar process tree only after a capture-time PID identity match. */
export async function stopAcceleratedWeb({ dataDir, execFileImpl, readIdentityImpl = readProcessIdentity } = {}) {
  const state = readAcceleratedState(dataDir)
  if (!state?.pid) return { ok: true, stopped: false, gone: true }
  const verified = await verifyStateIdentity(state, { readIdentityImpl })
  if (!verified.ok) {
    if (verified.exists === false) {
      writeJsonAtomic(path.join(dataDir, ACCELERATED_STATE_FILE), { ...state, running: false, stoppedAt: new Date().toISOString(), identityError: verified.reason })
      return { ok: true, stopped: false, gone: true, pid: state.pid }
    }
    return { ok: false, stopped: false, error: 'accelerated-identity-mismatch', reason: verified.reason, pid: state.pid }
  }
  const execFile = execFileImpl ?? (await import('node:child_process')).execFile
  await new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(state.pid), '/T', '/F'], { windowsHide: true }, () => resolve(undefined))
  })
  writeJsonAtomic(path.join(dataDir, ACCELERATED_STATE_FILE), { ...state, running: false, stoppedAt: new Date().toISOString() })
  return { ok: true, stopped: true, pid: state.pid }
}

/** Current sidecar view for the panel; a mismatched PID is never reported running. */
export async function acceleratedWebStatus({ dataDir, fetchImpl = fetch, readIdentityImpl = readProcessIdentity } = {}) {
  const state = readAcceleratedState(dataDir)
  if (!state?.pid) return { ok: true, running: false, state: null }
  const verified = await verifyStateIdentity(state, { readIdentityImpl })
  if (!verified.ok) {
    return {
      ok: true,
      running: false,
      state: { ...state, running: false, identityOk: false, identityError: verified.reason, identityCheckedAt: Date.now() },
    }
  }
  const running = await probeHttp(state.port, fetchImpl)
  return { ok: true, running, state: { ...state, running, identityOk: true, identityCheckedAt: Date.now() } }
}
