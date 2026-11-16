// SPDX-License-Identifier: AGPL-3.0-or-later
// Accelerated Web sidecar: keeps the original DSH process untouched and starts
// a second @twinsearth/dsh Web process with its own profile and port.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { ensureDir, readJson, writeJsonAtomic } from '../kernel/index.mjs'

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

/** Start the accelerated process; returns its PID and URL after the URL line. */
export async function startAcceleratedWeb({ dataDir, cliPath, profile = 'fang-accelerated', port = DEFAULT_ACCELERATED_PORT, home = process.env.DSH_HOME, timeoutMs = 60000, spawnImpl = spawn, fetchImpl = fetch } = {}) {
  const previous = readAcceleratedState(dataDir)
  if (previous?.pid && await isAlive(previous.pid, fetchImpl, previous.port)) return { ok: true, already: true, ...previous }
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
  const state = { version: 1, pid: child.pid, url, port, profile, cliPath: cli, startedAt: new Date().toISOString() }
  writeJsonAtomic(path.join(dataDir, ACCELERATED_STATE_FILE), state)
  child.once('exit', () => {
    const current = readAcceleratedState(dataDir)
    if (current?.pid === child.pid) writeJsonAtomic(path.join(dataDir, ACCELERATED_STATE_FILE), { ...current, running: false, stoppedAt: new Date().toISOString() })
  })
  return { ok: true, ...state }
}

/** Stop the sidecar process tree. */
export async function stopAcceleratedWeb({ dataDir, execFileImpl } = {}) {
  const state = readAcceleratedState(dataDir)
  if (!state?.pid) return { ok: true, stopped: false }
  const execFile = execFileImpl ?? (await import('node:child_process')).execFile
  await new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(state.pid), '/T', '/F'], { windowsHide: true }, () => resolve(undefined))
  })
  writeJsonAtomic(path.join(dataDir, ACCELERATED_STATE_FILE), { ...state, running: false, stoppedAt: new Date().toISOString() })
  return { ok: true, stopped: true, pid: state.pid }
}

/** Current sidecar view for the panel. */
export async function acceleratedWebStatus({ dataDir, fetchImpl = fetch } = {}) {
  const state = readAcceleratedState(dataDir)
  if (!state?.pid) return { ok: true, running: false, state: null }
  const running = await isAlive(state.pid, fetchImpl, state.port)
  return { ok: true, running, state: { ...state, running } }
}

async function isAlive(pid, fetchImpl, port = DEFAULT_ACCELERATED_PORT) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
    return response.ok || response.status < 500
  } catch {
    return false
  }
}
