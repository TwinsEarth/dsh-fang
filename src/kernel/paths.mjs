// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang kernel — path resolution and the fork web-URL contract.
//
// Layout (mother):
//   $DSH_HOME/fang/<profileTag>/          data dir  (audit.jsonl, forks.json, buffer/, snapshots/, run/)
// Forks: every fork owns its own $DSH_HOME, so the same rule isolates it from the mother.
import os from 'node:os'
import path from 'node:path'

/** `--profile name` > `--profile=name` > $DSH_PROFILE > .../profiles/<name> > 'default' */
export function detectProfileTag(argv = process.argv, env = process.env) {
  const argvList = Array.isArray(argv) ? argv : []
  // The launcher sets DSH_PROFILE for the booted profile; trust it before argv, because a
  // profile boot may re-exec with the template name still on the command line.
  if (env && typeof env.DSH_PROFILE === 'string' && env.DSH_PROFILE.trim()) return env.DSH_PROFILE.trim()
  const i = argvList.indexOf('--profile')
  if (i >= 0 && argvList[i + 1]) return String(argvList[i + 1])
  const eq = argvList.find(a => typeof a === 'string' && a.startsWith('--profile='))
  if (eq) return eq.slice('--profile='.length)
  const joined = argvList.join(' ')
  const m = /[\\/]profiles[\\/]([^\\/\s"']+)/.exec(joined)
  if (m) return m[1]
  const cwd = process.cwd()
  const cm = /[\\/]profiles[\\/]([^\\/\s"']+)/.exec(cwd)
  if (cm) return cm[1]
  return 'default'
}

export function resolveDshHome(env = process.env) {
  const raw = env && env.DSH_HOME
  if (typeof raw === 'string' && raw.trim()) return path.resolve(raw.trim())
  return path.join(os.homedir(), '.dsh')
}

export function resolveProfileDir(profileTag, env = process.env) {
  return path.join(resolveDshHome(env), 'profiles', profileTag)
}

/**
 * Every path a Fang plugin needs. Pure: no directory is created here.
 * @returns {{dataDir:string, profileTag:string, dshHome:string, ledgerFile:string, stateFile:string,
 *   forksFile:string, pidFile:string, bufferDir:string, snapshotsDir:string, roundsDir:string,
 *   runDir:string, forkHomesDir:string}}
 */
export function resolveFangLayout(options = {}) {
  const {
    dataRoot = '',
    bufferRoot = '',
    forksRoot = '',
    env = process.env,
    argv = process.argv,
  } = options
  const profileTag = detectProfileTag(argv, env)
  const dshHome = resolveDshHome(env)
  const dataDir = dataRoot ? path.resolve(dataRoot) : path.join(dshHome, 'fang', profileTag)
  return {
    dataDir,
    profileTag,
    dshHome,
    ledgerFile: path.join(dataDir, 'audit.jsonl'),
    stateFile: path.join(dataDir, 'state.json'),
    forksFile: path.join(dataDir, 'forks.json'),
    tasksFile: path.join(dataDir, 'tasks.json'),
    pidFile: path.join(dataDir, 'fang.pid'),
    bufferDir: bufferRoot ? path.resolve(bufferRoot) : path.join(dataDir, 'buffer'),
    snapshotsDir: path.join(dataDir, 'snapshots'),
    roundsDir: path.join(dataDir, 'rounds'),
    runDir: path.join(dataDir, 'run'),
    forkHomesDir: forksRoot ? path.resolve(forksRoot) : path.join(dataDir, 'forks'),
  }
}

/** Matches the line a `dsh web` boot prints: `dsh web: http://127.0.0.1:<port>/...token...` */
export const WEB_URL_RE = /dsh web:\s+(http:\/\/127\.0\.0\.1:(\d+)\/\S*)/

/**
 * Parse a fork's stdout tail into its tokenized web URL.
 * The bare URL is 401, so a line without `?token=` is NOT a usable fork URL and
 * parses to null — failing loud beats handing the UI an address that always 401s.
 * @returns {{url:string, port:number, token:string}|null}
 */
export function parseWebUrl(text) {
  if (!text) return null
  const m = WEB_URL_RE.exec(String(text))
  if (!m) return null
  const url = m[1]
  const t = /[?&]token=([^&\s]+)/.exec(url)
  if (!t) return null
  let token = t[1]
  try { token = decodeURIComponent(token) } catch { /* keep raw */ }
  return { url, port: Number(m[2]), token }
}

/** A fork is healthy only when its loopback URL answers; token is part of the URL. */
export async function probeWebUrl(url, { timeoutMs = 3000, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'no-fetch' }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: ac.signal })
    return { ok: res.status < 500, status: res.status }
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) }
  } finally {
    clearTimeout(timer)
  }
}


/**
 * Read-only layout of the mother's session/workspace storage. Session catalog uses
 * this; it must never write these paths ($DSH_HOME is the mother's own data).
 */
export function resolveSessionsLayout(options = {}) {
  const { env = process.env } = options
  const dshHome = resolveDshHome(env)
  const sessionsDir = path.join(dshHome, 'sessions')
  const storagesDir = path.join(dshHome, 'storages')
  return {
    dshHome,
    sessionsDir,
    storagesDir,
    workspaceFile: path.join(storagesDir, 'workspace.json'),
    projcacheDir: path.join(storagesDir, 'session_projcache'),
  }
}
