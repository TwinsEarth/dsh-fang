#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// restart-watchdog — C 方案「外部看护」：不改 DSH 启动方式，只旁路观察宿主。
//
// 它每 poll-ms 读一次 <dataDir>/fang.pid（守卫插件在母体启动时写、优雅卸载时删）：
//   宿主活着   → 继续观察（execute 模式下同时续写 supervisor.present 心跳）
//   宿主死了   → 只读校验 <stateDir>/approved/<id>.json：
//                  没有 armed/未过期/pid 匹配/无回执的清单 → 不干预，退出
//                  有清单 + --execute                          → 用 `--` 之后的命令重启宿主
//                  有清单 + dry-run（默认）                    → 只报告 would-relaunch
// 重启成功后写 executed/<id>.json 回执（execution.executed=true），这是唯一的执行证明。
//
// 用法：
//   node tools/restart-watchdog.mjs --data-root <dir> -- <重启命令 argv...>
//   node tools/restart-watchdog.mjs --execute --data-root <dir> -- <重启命令 argv...>
//
// 安全边界：
//   * 默认 dry-run；只有 --execute 才会写 supervisor.present（守卫据此判断「有人在拉起我」）
//     并真正 spawn 重启命令。
//   * 没有清单/清单未 armed/过期/pid 不匹配/已有回执 => 不干预，绝不重启。
//   * 与 DSH Desktop 的启动方式无关：命令由用户提供，watchdog 不猜。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  appendJsonl,
  ensureDir,
  resolveFangLayout,
  sleep,
  writeJsonAtomic,
} from '../src/kernel/index.mjs'
import {
  buildExecutionReceipt,
  receiptFile,
} from '../src/lib/restart-contract.mjs'
import { readForkSupervisionSettings } from '../src/lib/fork-supervision-settings.mjs'
import { detectDesktopProfileDir, runBootGuard } from '../src/lib/desktop-launch.mjs'
import { GATED_RESTART_EXIT, verifyApprovalForPid, writeRestartReceipt } from './restart-supervisor.mjs'

export const WATCHDOG_ID = 'fang-restart-watchdog'
export const MARKER_FILENAME = 'supervisor.present'
export const DEFAULTS = Object.freeze({
  execute: false,
  pollMs: 2000,
  maxRelaunches: 3,
  startupTimeoutMs: 60000,
  dataRoot: '',
  stateDir: '',
  pidFile: '',
  log: '',
  supervisorId: WATCHDOG_ID,
  // null = 只在 --execute 时自动拉起分身；true/false 可显式覆盖
  autostartForks: null,
  motherUrl: '',
  token: '',
  autostartTimeoutMs: 15000,
  profileDir: '',
  bootGuard: true,
  safeModeOnFailure: true,
})

export const USAGE = `usage: node tools/restart-watchdog.mjs [options] -- <relaunch command argv...>

外部看护（C）：不改 DSH 启动方式；只在宿主以退出码 75 死亡且存在 armed 授权清单时重启它。

options:
  --data-root <dir>         Fang 数据根目录（默认 resolveFangLayout()）
  --pid-file <file>         宿主 pid 文件（默认 <dataDir>/fang.pid）
  --state-dir <dir>         守卫状态目录（默认 <dataDir>/restart）
  --execute                 真正重启（默认 dry-run：只报告 would-relaunch）
  --poll-ms <n>             轮询间隔（默认 ${DEFAULTS.pollMs}ms）
  --max-relaunches <n>      最多重启次数（默认 ${DEFAULTS.maxRelaunches}）
  --startup-timeout-ms <n>  重启后等新 pid 出现的上限（默认 ${DEFAULTS.startupTimeoutMs}ms）
  --autostart-forks         启动时自动拉起已登记但没在跑的分身（默认：--execute 时开启）
  --no-autostart-forks      关闭分身自动启动
  --mother-url <url>        母体 HTTP 地址（默认读 <dataDir>/endpoint.json）
  --token <token>           母体鉴权 token（默认 env DSH_FANG_AUTH_TOKEN 或 <dataDir>/fang-auth.json）
  --supervisor-id <id>      写进执行回执的执行者标识（默认 ${DEFAULTS.supervisorId}）
  --profile-dir <dir>       DSH profile（用于重启前 boot-guard；默认自动探测）
  --no-boot-guard           重启前不跑 boot-guard
  --no-safe-mode            boot-guard 失败只拒绝重启，不自动禁用 fang 行
  --log <file>              看护日志（默认 <stateDir>/watchdog.jsonl）
  -h, --help                显示本帮助

examples:
  node tools/restart-watchdog.mjs --data-root E:\\fang-data -- "E:\\DS\\DeepSeek Harness.exe"
  node tools/restart-watchdog.mjs --execute --data-root E:\\fang-data -- "E:\\DS\\DeepSeek Harness.exe"
`

const CLAMP = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

function parsePositiveInt(raw, name, { min = 0, max = 1_000_000 } = {}) {
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`)
  }
  return n
}

export function parseWatchdogArgs(argv = []) {
  const options = { ...DEFAULTS }
  let relaunch = []
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i])
    if (a === '--') { relaunch = argv.slice(i + 1).map(String); break }
    if (a === '--help' || a === '-h') return { help: true, options, relaunch: [] }
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`)
      return String(argv[++i])
    }
    if (a === '--data-root') { options.dataRoot = next(); continue }
    if (a.startsWith('--data-root=')) { options.dataRoot = a.slice('--data-root='.length); continue }
    if (a === '--pid-file') { options.pidFile = next(); continue }
    if (a.startsWith('--pid-file=')) { options.pidFile = a.slice('--pid-file='.length); continue }
    if (a === '--state-dir') { options.stateDir = next(); continue }
    if (a.startsWith('--state-dir=')) { options.stateDir = a.slice('--state-dir='.length); continue }
    if (a === '--log') { options.log = next(); continue }
    if (a.startsWith('--log=')) { options.log = a.slice('--log='.length); continue }
    if (a === '--supervisor-id') { options.supervisorId = next(); continue }
    if (a.startsWith('--supervisor-id=')) { options.supervisorId = a.slice('--supervisor-id='.length); continue }
    if (a === '--execute') { options.execute = true; continue }
    if (a === '--dry-run') { options.execute = false; continue }
    if (a === '--poll-ms') { options.pollMs = parsePositiveInt(next(), '--poll-ms', { min: 10, max: 3_600_000 }); continue }
    if (a.startsWith('--poll-ms=')) { options.pollMs = parsePositiveInt(a.slice('--poll-ms='.length), '--poll-ms', { min: 10, max: 3_600_000 }); continue }
    if (a === '--max-relaunches') { options.maxRelaunches = parsePositiveInt(next(), '--max-relaunches', { min: 0, max: 20 }); continue }
    if (a.startsWith('--max-relaunches=')) { options.maxRelaunches = parsePositiveInt(a.slice('--max-relaunches='.length), '--max-relaunches', { min: 0, max: 20 }); continue }
    if (a === '--startup-timeout-ms') { options.startupTimeoutMs = parsePositiveInt(next(), '--startup-timeout-ms', { min: 100, max: 600000 }); continue }
    if (a.startsWith('--startup-timeout-ms=')) { options.startupTimeoutMs = parsePositiveInt(a.slice('--startup-timeout-ms='.length), '--startup-timeout-ms', { min: 100, max: 600000 }); continue }
    if (a === '--autostart-timeout-ms') { options.autostartTimeoutMs = parsePositiveInt(next(), '--autostart-timeout-ms', { min: 100, max: 600000 }); continue }
    if (a.startsWith('--autostart-timeout-ms=')) { options.autostartTimeoutMs = parsePositiveInt(a.slice('--autostart-timeout-ms='.length), '--autostart-timeout-ms', { min: 100, max: 600000 }); continue }
    if (a === '--autostart-forks') { options.autostartForks = true; continue }
    if (a === '--no-autostart-forks') { options.autostartForks = false; continue }
    if (a === '--profile-dir') { options.profileDir = next(); continue }
    if (a.startsWith('--profile-dir=')) { options.profileDir = a.slice('--profile-dir='.length); continue }
    if (a === '--no-boot-guard') { options.bootGuard = false; continue }
    if (a === '--no-safe-mode') { options.safeModeOnFailure = false; continue }
    if (a === '--mother-url') { options.motherUrl = next(); continue }
    if (a.startsWith('--mother-url=')) { options.motherUrl = a.slice('--mother-url='.length); continue }
    if (a === '--token') { options.token = next(); continue }
    if (a.startsWith('--token=')) { options.token = a.slice('--token='.length); continue }
    throw new Error(`unknown option: ${a} (put the relaunch command after --)`)
  }
  if (!relaunch.length) throw new Error('missing relaunch command: use -- <command> [args...]')
  if (!options.supervisorId || options.supervisorId.length > 128) throw new Error('--supervisor-id must be 1..128 chars')
  return { options, relaunch }
}

export function stateDirForWatchdog(options = {}) {
  if (options.stateDir) return String(options.stateDir)
  const layout = resolveFangLayout({ dataRoot: options.dataRoot ?? '' })
  return path.join(layout.dataDir, 'restart')
}

export function pidFileFor(options = {}) {
  if (options.pidFile) return String(options.pidFile)
  if (options.stateDir) return path.join(path.dirname(String(options.stateDir)), 'fang.pid')
  const layout = resolveFangLayout({ dataRoot: options.dataRoot ?? '' })
  return layout.pidFile
}

export function markerFileFor(stateDir) {
  return path.join(String(stateDir), MARKER_FILENAME)
}

export function writeSupervisorMarker(stateDir, { pid = process.pid, execute = false, supervisor = WATCHDOG_ID } = {}) {
  ensureDir(stateDir)
  const file = markerFileFor(stateDir)
  writeJsonAtomic(file, { version: 1, supervisor, pid, execute: execute === true, at: Date.now() })
  return file
}

export function clearSupervisorMarker(stateDir, { pid = process.pid } = {}) {
  const file = markerFileFor(stateDir)
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (Number(raw?.pid) === Number(pid)) fs.unlinkSync(file)
  } catch { /* already gone */ }
}

/** 读宿主 pid 文件；兼容 {pid} JSON 与纯数字文本。读不到返回 null。 */
export function readHostPid(pidFile) {
  try {
    const raw = fs.readFileSync(pidFile, 'utf8').replace(/^\uFEFF/, '').trim()
    if (!raw) return null
    if (/^\d+$/.test(raw)) return Number(raw)
    const parsed = JSON.parse(raw)
    const pid = Number(parsed?.pid)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

export function dataDirForWatchdog(options = {}) {
  if (options.stateDir) return path.dirname(String(options.stateDir))
  const layout = resolveFangLayout({ dataRoot: options.dataRoot ?? '' })
  return layout.dataDir
}

/** 母体 HTTP 地址：显式 --mother-url 优先，否则读 orchestrator 写的 <dataDir>/endpoint.json。 */
export function readMotherEndpoint(options = {}) {
  if (options.motherUrl) return String(options.motherUrl).replace(/\/+$/, '')
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dataDirForWatchdog(options), 'endpoint.json'), 'utf8'))
    return String(doc?.url ?? '').replace(/\/+$/, '')
  } catch {
    return ''
  }
}

/** 母体鉴权 token：显式 --token > env DSH_FANG_AUTH_TOKEN > <dataDir>/fang-auth.json。 */
export function readMotherToken(options = {}) {
  if (options.token) return String(options.token)
  const env = String(process.env.DSH_FANG_AUTH_TOKEN ?? '').trim()
  if (env) return env
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dataDirForWatchdog(options), 'fang-auth.json'), 'utf8'))
    return String(doc?.token ?? '')
  } catch {
    return ''
  }
}

/** UI 持久化开关 vs CLI 显式覆盖：给出本次 watchdog 是否请求 autostart。 */
export function resolveAutostartPreference(options = {}) {
  const settings = readForkSupervisionSettings(dataDirForWatchdog(options))
  const explicit = options.autostartForks === true || options.autostartForks === false
  const want = explicit
    ? options.autostartForks === true
    : (options.execute === true && settings.autostartForks !== false)
  return { want, source: explicit ? 'cli' : 'settings', settings }
}


export async function requestAutostartForks(options = {}) {
  const base = readMotherEndpoint(options)
  if (!base) return { ok: false, error: 'mother-url-unavailable' }
  const token = readMotherToken(options)
  if (!token) return { ok: false, error: 'auth-token-unavailable' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(options.autostartTimeoutMs) || 15000))
  try {
    const res = await fetch(`${base}/fang/api/forks/autostart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fang-auth': token, accept: 'application/json' },
      body: '{}',
      signal: controller.signal,
    })
    const text = await res.text()
    let body = null
    try { body = text ? JSON.parse(text) : null } catch { body = null }
    if (!res.ok || body?.ok === false) {
      return { ok: false, status: res.status, error: body?.error ?? 'autostart-http-error', body }
    }
    return {
      ok: true,
      status: res.status,
      started: Array.isArray(body?.started) ? body.started.length : 0,
      failed: Array.isArray(body?.failed) ? body.failed.length : 0,
      skipped: Array.isArray(body?.skipped) ? body.skipped.length : 0,
      body,
    }
  } catch (error) {
    return {
      ok: false,
      error: error?.name === 'AbortError' ? 'autostart-timeout' : 'autostart-failed',
      detail: String(error?.message ?? error),
    }
  } finally {
    clearTimeout(timer)
  }
}

/** spawn 一个重启命令；detached + 不捕获 stdio，避免看护进程退出时带走宿主。 */
export function spawnRelaunch(argv, { spawnImpl = spawn } = {}) {
  try {
    const child = spawnImpl(argv[0], argv.slice(1), {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    child.on?.('error', () => { /* 错误由调用方通过 pid 确认兜底 */ })
    child.unref?.()
    return { ok: true, pid: Number.isInteger(child.pid) ? child.pid : null }
  } catch (error) {
    return { ok: false, pid: null, error: String(error?.message ?? error) }
  }
}

/**
 * 看护主循环（可注入 verify/sleep/spawn，测试用）。
 * @returns {Promise<{relaunches:number, stopped:string, deadPid:number|null, manifestId:string|null, receipts:Array, reason?:string}>}
 */
export async function watch({
  relaunch,
  options = {},
  verify = verifyApprovalForPid,
  sleepFn = sleep,
  spawnImpl = spawn,
  signal = null,
  logSink = null,
  guard = null,
} = {}) {
  if (!Array.isArray(relaunch) || !relaunch.length) throw new Error('watch() requires a relaunch command argv')
  const opts = { ...DEFAULTS, ...options }
  const stateDir = stateDirForWatchdog(opts)
  const pidFile = pidFileFor(opts)
  const logFile = opts.log ? String(opts.log) : path.join(stateDir, 'watchdog.jsonl')
  const log = (event, data = {}) => {
    try {
      ensureDir(path.dirname(logFile))
      appendJsonl(logFile, { at: new Date().toISOString(), watchdogPid: process.pid, event, ...data })
    } catch { /* ignore */ }
    try { logSink?.(event, data) } catch { /* ignore */ }
  }
  const result = {
    execute: opts.execute === true,
    relaunches: 0,
    stopped: null,
    deadPid: null,
    manifestId: null,
    receipts: [],
    autostart: null,
  }
  // UI 持久化开关是默认值：CLI --autostart-forks/--no-autostart-forks 显式覆盖。
  const autostartPreference = resolveAutostartPreference(opts)
  const wantAutostart = autostartPreference.want
  result.supervision = {
    autostartForks: autostartPreference.settings.autostartForks,
    source: autostartPreference.source,
    settingsFile: autostartPreference.settings.file,
  }
  let autostartDone = false
  let autostartAttempts = 0
  let markerWritten = false
  const refreshMarker = () => {
    if (!opts.execute) return
    try {
      writeSupervisorMarker(stateDir, { execute: true, supervisor: opts.supervisorId })
      markerWritten = true
    } catch (error) {
      log('marker-write-failed', { error: String(error?.message ?? error) })
    }
  }
  const stop = (reason) => {
    result.stopped = reason
    if (markerWritten) clearSupervisorMarker(stateDir)
    log('watchdog-stop', { reason, relaunches: result.relaunches })
    return result
  }

  log('watchdog-start', {
    pidFile, stateDir, dryRun: !opts.execute, pollMs: opts.pollMs,
    maxRelaunches: opts.maxRelaunches, relaunch,
  })
  refreshMarker()

  try {
    for (;;) {
      if (signal?.aborted) return stop('aborted')
      refreshMarker()

      const pid = readHostPid(pidFile)
      if (!Number.isInteger(pid) || pid <= 0) {
        log('pid-missing', { pidFile })
        await sleepFn(Math.max(20, opts.pollMs))
        continue
      }

      if (isPidAlive(pid)) {
        result.deadPid = null
        // 宿主活着：按需把已登记但没在跑的分身拉起来（只做一次；失败重试 3 次后放弃）。
        if (wantAutostart && !autostartDone) {
          if (!opts.execute) {
            log('would-autostart-forks', { pid })
            result.autostart = { requested: false, reason: 'dry-run' }
            autostartDone = true
          } else {
            const out = await requestAutostartForks(opts)
            autostartAttempts++
            if (out.ok) {
              autostartDone = true
              result.autostart = {
                requested: true, ok: true, started: out.started ?? 0,
                failed: out.failed ?? 0, skipped: out.skipped ?? 0,
              }
              log('autostart-forks', result.autostart)
            } else if (autostartAttempts >= 3) {
              autostartDone = true
              result.autostart = { requested: true, ok: false, error: out.error }
              log('autostart-forks-failed', result.autostart)
            } else {
              log('autostart-forks-deferred', { error: out.error, attempt: autostartAttempts })
            }
          }
        }
        await sleepFn(Math.max(20, opts.pollMs))
        continue
      }

      // 宿主已死：只认 armed/未过期/pid 匹配/无回执的清单
      result.deadPid = pid
      log('host-dead', { pid })
      const verdict = verify({ stateDir, pid, now: Date.now() })
      if (!verdict?.ok) {
        log('no-approved-restart', { pid, reason: verdict?.reason ?? 'not-authorized' })
        result.reason = verdict?.reason ?? 'not-authorized'
        return stop('no-approved-restart')
      }
      const manifest = verdict.manifest
      result.manifestId = manifest.id

      if (!opts.execute) {
        log('would-relaunch', { pid, manifestId: manifest.id })
        return stop('dry-run')
      }
      if (result.relaunches >= opts.maxRelaunches) return stop('max-relaunches')

      // 重启前自检：坏 profile/候选行/上次启动期崩溃 → 安全模式或拒绝重启。
      if (typeof guard === 'function') {
        let gate = null
        try { gate = await guard() } catch (error) { gate = { ok: false, error: String(error?.message ?? error) } }
        result.guard = gate
        if (gate?.safeModeApplied) log('boot-guard-safe-mode', { reason: gate.reason ?? 'unknown', added: gate.applied?.added ?? 0 })
        else if (gate?.skipped) log('boot-guard-skipped', { reason: gate.skipped })
        else if (gate?.ok) log('boot-guard-pass', { checked: gate.checked ?? 0 })
        if (!gate?.ok) {
          result.reason = String(gate?.error ?? 'boot-guard-blocked')
          log('boot-guard-blocked', { error: result.reason })
          return stop('boot-guard-blocked')
        }
      }

      const launched = spawnRelaunch(relaunch, { spawnImpl })
      if (!launched.ok) {
        result.reason = launched.error
        log('relaunch-spawn-failed', { error: launched.error })
        return stop('relaunch-spawn-failed')
      }
      result.relaunches++

      // 等新宿主写 pid 文件（最多 startupTimeoutMs）；确认后回执记录新 host pid。
      const deadline = Date.now() + Math.max(100, opts.startupTimeoutMs)
      let newPid = null
      while (Date.now() < deadline) {
        if (signal?.aborted) return stop('aborted')
        const seen = readHostPid(pidFile)
        if (Number.isInteger(seen) && seen > 0 && seen !== pid && isPidAlive(seen)) { newPid = seen; break }
        await sleepFn(Math.min(120, Math.max(20, opts.pollMs)))
      }
      const replacedAt = Date.now()
      let receipt
      try {
        const written = writeRestartReceipt({
          stateDir,
          manifest,
          supervisorId: opts.supervisorId,
          executedAt: replacedAt,
          exitCode: GATED_RESTART_EXIT,
          previousPid: pid,
          replacementPid: newPid ?? null,
        })
        receipt = { id: manifest.id, file: written.file, digest: written.receipt.digest }
        result.receipts.push(receipt)
        log('relaunched', { manifestId: manifest.id, previousPid: pid, replacementPid: newPid, spawnedPid: launched.pid, receipt: written.file })
      } catch (error) {
        result.reason = String(error?.message ?? error)
        log('receipt-write-failed', { error: result.reason })
        return stop('receipt-write-failed')
      }
      if (!newPid) {
        // 无法确认新宿主 pid：已写回执（执行确实发生），但不继续看护未知进程。
        log('replacement-unconfirmed', { spawnedPid: launched.pid })
        result.reason = 'replacement-unconfirmed'
        return stop('replacement-unconfirmed')
      }
      // 继续观察新宿主；下一轮会从新 pid 开始。
      await sleepFn(Math.max(20, opts.pollMs))
    }
  } finally {
    if (markerWritten) clearSupervisorMarker(stateDir)
  }
}

export async function main(argv = process.argv.slice(2)) {
  let parsed
  try {
    parsed = parseWatchdogArgs(argv)
  } catch (error) {
    console.error(`[restart-watchdog] ${error?.message ?? error}`)
    console.error(USAGE)
    return 2
  }
  if (parsed.help) { console.log(USAGE); return 0 }
  // 自动 profile 探测：DSH_PROFILE_DIR / DSH_HOME/profiles/<profile>；探测不到则跳过（不阻塞）。
  let guard = null
  if (parsed.options.bootGuard) {
    const dataDir = dataDirForWatchdog(parsed.options)
    const profileDir = String(parsed.options.profileDir ?? '').trim()
      || detectDesktopProfileDir({ env: process.env, args: parsed.relaunch })
    if (profileDir) {
      guard = () => runBootGuard(profileDir, {
        dataRoot: dataDir,
        safeModeOnFailure: parsed.options.execute === true && parsed.options.safeModeOnFailure !== false,
      })
      console.log(`[restart-watchdog] boot-guard profile: ${profileDir}`)
    } else {
      console.log('[restart-watchdog] boot-guard skipped: profile not detected (pass --profile-dir)')
    }
  }
  const result = await watch({ relaunch: parsed.relaunch, options: parsed.options, guard })
  if (result.stopped === 'dry-run') {
    console.log(`[restart-watchdog] dry-run: host ${result.deadPid} dead with approval ${result.manifestId}; not relaunching (pass --execute to allow)`)
  } else if (result.stopped === 'no-approved-restart') {
    console.log(`[restart-watchdog] host ${result.deadPid} dead without an approved restart (${result.reason}); not intervening`)
  } else if (result.stopped === 'boot-guard-blocked') {
    console.error(`[restart-watchdog] boot-guard blocked relaunch: ${result.reason ?? ''}`)
  } else if (result.stopped === 'relaunch-spawn-failed' || result.stopped === 'receipt-write-failed') {
    console.error(`[restart-watchdog] stopped: ${result.stopped}: ${result.reason ?? ''}`)
  } else {
    console.log(`[restart-watchdog] stopped=${result.stopped} relaunches=${result.relaunches}`)
  }
  return ['relaunch-spawn-failed', 'receipt-write-failed', 'boot-guard-blocked'].includes(result.stopped) ? 1 : 0
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isMain) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    console.error(`[restart-watchdog] ${error?.message ?? error}`)
    process.exitCode = 1
  })
}
