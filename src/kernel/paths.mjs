// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang kernel — path resolution and the fork web-URL contract.
//
// Layout (mother):
//   $DSH_HOME/fang/<profileTag>/          data dir  (audit.jsonl, forks.json, buffer/, snapshots/, run/)
// Forks: every fork owns its own $DSH_HOME, so the same rule isolates it from the mother.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

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

/** 用户级数据根：$FANG_HOME 优先；未设置时新装默认 D:\ToFuture（旧布局有数据则继续用旧布局）。 */
export function resolveFangHome(env = process.env) {
  const raw = env && env.FANG_HOME
  if (typeof raw === 'string' && raw.trim()) return path.resolve(raw.trim())
  // 迁移指针：<DSH_HOME>/fang/fang-home.txt 第一行写明数据根（无需改环境变量/配置即可切换）。
  try {
    const pointer = path.join(resolveDshHome(env), 'fang', 'fang-home.txt')
    if (fs.existsSync(pointer)) {
      const first = fs.readFileSync(pointer, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[0].trim()
      if (first && path.isAbsolute(first)) {
        // 迁移指针可能是旧盘/旧目录：根不存在或指向普通文件时忽略，回退到本机布局，
        // 避免 ensureDir(dataDir) 在插件 apply 阶段抛错导致“必须删 .dsh”才能启动。
        const root = path.parse(first).root
        const rootUsable = Boolean(root) && fs.existsSync(root)
        let targetUsable = true
        try { if (fs.existsSync(first) && !fs.statSync(first).isDirectory()) targetUsable = false } catch { targetUsable = false }
        if (rootUsable && targetUsable) return path.resolve(first)
      }
    }
  } catch { /* ignore */ }
  // 兼容：旧布局不再作为默认落点。v3.8.2 起默认数据根固定到 D:\ToFuture\FangData，
  // 避免与宿主/客户端/工程目录（尤其 E:\DSH\DS）混用。迁移指针存在时优先使用指针。
  // v3.8.2: real installs must use the isolated root even when the DSH launcher
  // sets DSH_HOME explicitly (it normally does). Only test/temp/portable homes
  // are allowed to stay local, otherwise every real host would keep writing
  // into C:\Users\...\.dsh\fang or E:\DSH\DS.
  const dshHomeText = resolveDshHome(env)
  const testOrPortableHome = Boolean(env && env.NODE_TEST_CONTEXT)
    || /(?:[\\/](?:tmp|temp|scratch|test|tests|\.tmp)(?:[\\/]|$))/i.test(dshHomeText)
    || /(?:[\\/]AppData[\\/]Local[\\/]Temp[\\/])/i.test(dshHomeText)
  const explicitDisableCanonical = Boolean(env && String(env.DSH_FANG_DISABLE_CANONICAL ?? '') === '1')
  if (!testOrPortableHome && !explicitDisableCanonical && process.platform === 'win32') {
    try { if (fs.existsSync('D:\\')) return 'D:\\ToFuture\\FangData' } catch { /* ignore */ }
  }
  return ''
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
    fangHome = '',
    env = process.env,
    argv = process.argv,
  } = options
  const profileTag = detectProfileTag(argv, env)
  const dshHome = resolveDshHome(env)
  // 显式传入 dataRoot/forksRoot（测试、独立部署）时不要自动跳到 FANG_HOME 默认值，
  // 否则临时目录测试会写进真实的 D:\ToFuture。
  const explicitRoots = Boolean(String(dataRoot ?? '').trim() || String(forksRoot ?? '').trim() || String(bufferRoot ?? '').trim())
  const hasEnvFangHome = Boolean(String(env?.FANG_HOME ?? '').trim())
  const resolvedFangHome = fangHome
    ? path.resolve(fangHome)
    : (explicitRoots && !hasEnvFangHome ? '' : resolveFangHome(env))
  // v3.8.2: canonical root is D:\ToFuture\FangData. If a legacy install still
  // has tasks under <DSH_HOME>/fang/<tag> and the canonical root is empty, keep
  // serving the legacy data (never silently show an empty profile) and mark it
  // for explicit migration. New installs without legacy data use the canonical root.
  let effectiveFangHome = resolvedFangHome
  let legacyDataDetected = false
  try {
    if (resolvedFangHome && !hasEnvFangHome && !String(fangHome ?? '').trim() && profileTag) {
      const canonicalTasks = path.join(resolvedFangHome, 'mirror', profileTag, 'tasks.json')
      const legacyTasks = path.join(dshHome, 'fang', profileTag, 'tasks.json')
      if (!fs.existsSync(canonicalTasks) && fs.existsSync(legacyTasks)) {
        effectiveFangHome = ''
        legacyDataDetected = true
      }
    }
  } catch { /* ignore */ }
  const activeFangHome = effectiveFangHome
  const dataDir = dataRoot
    ? path.resolve(dataRoot)
    : (activeFangHome ? path.join(activeFangHome, 'mirror', profileTag) : path.join(dshHome, 'fang', profileTag))
  // 三区分离：母体=mirror/<tag>，原身=essence/，分身=forks/，会话/运行态=sessions/。
  const essenceRoot = activeFangHome ? path.join(activeFangHome, 'essence') : path.join(dataDir, 'essences')
  const forkHomesDir = forksRoot
    ? path.resolve(forksRoot)
    : (activeFangHome ? path.join(activeFangHome, 'forks') : path.join(dataDir, 'forks'))
  const sessionsRoot = activeFangHome ? path.join(activeFangHome, 'sessions') : ''
  const runtimeRoot = activeFangHome ? path.join(activeFangHome, 'sessions') : path.join(dataDir, 'runtime')
  return {
    dataDir,
    profileTag,
    dshHome,
    fangHome: activeFangHome,
    canonicalFangHome: resolvedFangHome,
    legacyDataDetected,
    legacyDataDir: legacyDataDetected ? path.join(dshHome, 'fang', profileTag) : '',
    ledgerFile: path.join(dataDir, 'audit.jsonl'),
    stateFile: path.join(dataDir, 'state.json'),
    forksFile: path.join(dataDir, 'forks.json'),
    tasksFile: path.join(dataDir, 'tasks.json'),
    pidFile: path.join(dataDir, 'fang.pid'),
    bufferDir: bufferRoot ? path.resolve(bufferRoot) : path.join(dataDir, 'buffer'),
    snapshotsDir: path.join(dataDir, 'snapshots'),
    roundsDir: path.join(dataDir, 'rounds'),
    runDir: path.join(dataDir, 'run'),
    forkHomesDir,
    essenceRoot,
    runtimeRoot,
    sessionsRoot,
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
