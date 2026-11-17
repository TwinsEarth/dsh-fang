// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// Accelerated core installation (P0): installs @twinsearth/dsh into
// <FANG_HOME>/accel/cli and remembers where the CLI entry lives.
//
// Design rules (see docs/ACCELERATED-FORK.md):
//   * The accelerated core only ever runs FORKS; mother/essence stay stock.
//   * Only a JavaScript entry (`lib/bin.js`) is accepted: spawning a `.cmd`
//     shim from Node on Windows fails with EINVAL/EPERM.
//   * Missing install is a hard, explicit failure — never a silent stock
//     fallback.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const ACCEL_PACKAGE = '@twinsearth/dsh'
export const DEFAULT_ACCEL_VERSION = '3.5.0'
export const ACCEL_ENTRY_REL = path.join('node_modules', '@twinsearth', 'dsh', 'lib', 'bin.js')
const SCRIPT_RE = /\.(?:mjs|cjs|js)$/i

/** Install root layout under <FANG_HOME>/accel. */
export function acceleratedLayout(fangHome) {
  const root = path.join(String(fangHome ?? '').trim(), 'accel')
  const cliDir = path.join(root, 'cli')
  return {
    root,
    cliDir,
    stateFile: path.join(root, 'state.json'),
    cliPath: path.join(cliDir, ACCEL_ENTRY_REL),
    packageFile: path.join(cliDir, 'node_modules', ACCEL_PACKAGE, 'package.json'),
  }
}

/** Read the persisted install state (null when never installed). */
export function readAcceleratedState(fangHome) {
  const { stateFile } = acceleratedLayout(fangHome)
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    return raw
  } catch {
    return null
  }
}

/** Persist the install state atomically. */
export function writeAcceleratedState(fangHome, state) {
  const { root, stateFile } = acceleratedLayout(fangHome)
  fs.mkdirSync(root, { recursive: true })
  const tmp = `${stateFile}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  fs.renameSync(tmp, stateFile)
  return state
}

/** Keep only JavaScript entries: `.cmd`/`.ps1` shims cannot be spawned safely. */
export function isScriptEntry(cliPath) {
  return SCRIPT_RE.test(String(cliPath ?? ''))
}

/**
 * Validate one candidate CLI path.
 * @returns {{ok:true, cliPath:string} | {ok:false, reason:string}}
 */
export function checkCliCandidate(cliPath) {
  const value = String(cliPath ?? '').trim()
  if (!value) return { ok: false, reason: 'empty' }
  if (!isScriptEntry(value)) return { ok: false, reason: 'not-a-js-entry' }
  try {
    if (!fs.statSync(value).isFile()) return { ok: false, reason: 'not-a-file' }
  } catch {
    return { ok: false, reason: 'missing' }
  }
  return { ok: true, cliPath: path.resolve(value) }
}

/**
 * Resolve the accelerated CLI entry with an explicit, auditable chain.
 * Sources, in order: config cliPath → FANG_ACCEL_CLI → install state →
 * <FANG_HOME>/accel/cli standard location. The global npm root is not probed
 * because a project must not accidentally pick a machine-wide install.
 * @returns {{ok:true, cliPath:string, source:string} | {ok:false, error:'accelerated-cli-missing', searched:Array<{source:string, value:string, reason:string}>}}
 */
export function resolveAcceleratedCore(options = {}) {
  const { cliPath = '', env = process.env, fangHome = '' } = options
  const layout = acceleratedLayout(fangHome)
  const state = readAcceleratedState(fangHome)
  const searched = []
  const candidates = [
    { source: 'config', value: String(cliPath ?? '').trim() },
    { source: 'env:FANG_ACCEL_CLI', value: String(env?.FANG_ACCEL_CLI ?? '').trim() },
    { source: 'state', value: String(state?.cliPath ?? '').trim() },
    { source: 'layout', value: layout.cliPath },
  ]
  for (const candidate of candidates) {
    if (!candidate.value) { searched.push({ ...candidate, reason: 'empty' }); continue }
    const checked = checkCliCandidate(candidate.value)
    if (checked.ok) return { ok: true, cliPath: checked.cliPath, source: candidate.source }
    searched.push({ ...candidate, reason: checked.reason })
  }
  return { ok: false, error: 'accelerated-cli-missing', searched }
}

/** Read installed version (null when absent). */
export function installedAcceleratedVersion(fangHome) {
  const { packageFile } = acceleratedLayout(fangHome)
  try {
    const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'))
    return typeof pkg?.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/** Read-only view for the panel route. */
export function acceleratedCoreInfo(options = {}) {
  const { env = process.env, cliPath = '', fangHome = '' } = options
  const resolved = resolveAcceleratedCore({ cliPath, env, fangHome })
  const state = readAcceleratedState(fangHome)
  return {
    installed: resolved.ok === true,
    version: installedAcceleratedVersion(fangHome) ?? state?.version ?? null,
    cliPath: resolved.ok ? resolved.cliPath : null,
    source: resolved.ok ? resolved.source : null,
    error: resolved.ok ? null : resolved.error,
    searched: resolved.ok ? [] : resolved.searched,
    installedAt: state?.installedAt ?? null,
    layout: acceleratedLayout(fangHome),
  }
}

/** Build the npm install invocation (pure, unit-testable). */
export function buildInstallCommand({ cliDir, version = DEFAULT_ACCEL_VERSION, npmBin = 'npm' } = {}) {
  const spec = `${ACCEL_PACKAGE}@${String(version ?? '').trim() || DEFAULT_ACCEL_VERSION}`
  return {
    command: npmBin,
    args: ['install', '--prefix', path.resolve(cliDir), '--no-audit', '--no-fund', '--loglevel=error', spec],
    spec,
  }
}

function runOnce(spec, { spawnImpl = spawn, timeoutMs = 600000, cwd } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnImpl(spec.command, spec.args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // .cmd shims on Windows need a shell; the command name is operator-provided.
        shell: process.platform === 'win32',
      })
    } catch (error) {
      resolve({ ok: false, error: 'spawn-failed', detail: String(error?.message ?? error) })
      return
    }
    let output = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      resolve({ ok: false, error: 'install-timeout', output: output.slice(-2000) })
    }, Math.max(1000, Number(timeoutMs) || 600000))
    child.stdout?.on('data', (chunk) => { output += String(chunk) })
    child.stderr?.on('data', (chunk) => { output += String(chunk) })
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, error: 'spawn-error', detail: String(error?.message ?? error), output: output.slice(-2000) })
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, error: code === 0 ? null : 'install-failed', code, output: output.slice(-4000) })
    })
  })
}

/**
 * Install (or reuse) the accelerated core under <FANG_HOME>/accel/cli.
 * Reuses an existing install whose version matches, unless force.
 * @returns {Promise<{ok:boolean, version?:string, cliPath?:string, reused?:boolean, error?:string, output?:string}>}
 */
export async function installAcceleratedCore(options = {}) {
  const { fangHome = '', version = DEFAULT_ACCEL_VERSION, force = false, spawnImpl = spawn, npmBin = process.env.FANG_NPM_BIN || 'npm' } = options
  const layout = acceleratedLayout(fangHome)
  if (!String(fangHome ?? '').trim()) return { ok: false, error: 'fang-home-missing' }
  const currentVersion = installedAcceleratedVersion(fangHome)
  if (!force && currentVersion) {
    const checked = checkCliCandidate(layout.cliPath)
    if (checked.ok && (!version || currentVersion === version)) {
      const state = writeAcceleratedState(fangHome, {
        version: currentVersion,
        cliPath: checked.cliPath,
        installedAt: readAcceleratedState(fangHome)?.installedAt ?? new Date().toISOString(),
        checkedAt: new Date().toISOString(),
      })
      return { ok: true, version: currentVersion, cliPath: checked.cliPath, reused: true, state }
    }
  }
  fs.mkdirSync(layout.cliDir, { recursive: true })
  const spec = buildInstallCommand({ cliDir: layout.cliDir, version, npmBin })
  const run = await runOnce(spec, { spawnImpl })
  if (!run.ok) return { ok: false, error: run.error ?? 'install-failed', output: run.output, detail: run.detail }
  const installed = installedAcceleratedVersion(fangHome)
  const checked = checkCliCandidate(layout.cliPath)
  if (!installed || !checked.ok) {
    return { ok: false, error: 'install-verify-failed', output: run.output, version: installed, cliPath: checked.ok ? checked.cliPath : null }
  }
  const state = writeAcceleratedState(fangHome, {
    version: installed,
    cliPath: checked.cliPath,
    installedAt: new Date().toISOString(),
    spec: spec.spec,
  })
  return { ok: true, version: installed, cliPath: checked.cliPath, reused: false, state, output: run.output }
}
