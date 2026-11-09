#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// restart-supervisor — 「supervisor 契约」的执行侧入口（独立工具，可手动运行，绝不自动启动）。
//
// 它只监督你交给它的那一条命令，并且只在该命令以退出码 75（EXIT.RESTART）结束、且
// <dataDir>/restart/approved/ 里存在一份**已武装、未过期、pid 匹配**的授权清单时才重启。
// 默认 dry-run：即使验证通过也只报告 would-restart，不重启；必须显式 --execute 才真执行。
//
// 用法：
//   node tools/restart-supervisor.mjs --data-root <dir> -- <命令...>
//   node tools/restart-supervisor.mjs --execute --data-root <dir> -- <命令...>
//
// 安全边界：
//   * 不改变 DSH 启动方式；不会自己拉起 DSH，也不会写 service/startup 项。
//   * 没有授权清单 / 清单未武装 / pid 不匹配 / 已过期 / 已有回执 => 只停下，不重启。
//   * 真正重启后写 <dataDir>/restart/executed/<id>.json，回执 execution.executed=true 是唯一执行证明。
//   * 不执行任意 shell 字符串：命令必须是 argv 数组，以 `--` 与应用参数分隔。
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  EXIT,
  appendJsonl,
  ensureDir,
  resolveFangLayout,
  sleep,
  writeJsonAtomic,
} from '../src/kernel/index.mjs'
import {
  buildExecutionReceipt,
  inspectApproval,
  listApprovalIds,
  readHmacSecret,
  receiptFile,
} from '../src/lib/restart-contract.mjs'

export const GATED_RESTART_EXIT = EXIT.RESTART
export const SUPERVISOR_ID = 'fang-restart-supervisor'

export const DEFAULTS = Object.freeze({
  execute: false, // dry-run 是默认值，不是建议
  maxRestarts: 5,
  backoffMs: 300,
  backoffMaxMs: 30_000,
  supervisorId: SUPERVISOR_ID,
})

export const USAGE = `usage: node tools/restart-supervisor.mjs [options] -- <command> [args...]

gate-aware supervisor：只在子进程退出码 75（守卫放行）且存在可执行的授权清单时才重启。

options:
  --data-root <dir>       Fang 数据根目录（默认 resolveFangLayout()）
  --execute               真正重启（默认 dry-run，只报告 would-restart）
  --max-restarts <n>      最多重启次数（默认 ${DEFAULTS.maxRestarts}）
  --backoff-ms <n>        退避基数（默认 ${DEFAULTS.backoffMs}ms，指数递增）
  --backoff-max-ms <n>    退避上限（默认 ${DEFAULTS.backoffMaxMs}ms）
  --supervisor-id <id>    写入回执的执行者标识（默认 ${DEFAULTS.supervisorId}）
  --log <file>            监督日志（默认 <dataDir>/restart/supervisor.jsonl）
  -h, --help              显示本帮助

examples:
  node tools/restart-supervisor.mjs --data-root E:\\fang-data -- node app.mjs
  node tools/restart-supervisor.mjs --execute --data-root E:\\fang-data -- node app.mjs
`

const CLAMP = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

function parsePositiveInt(raw, name, { min = 0, max = 1_000_000 } = {}) {
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`)
  }
  return n
}

/**
 * 解析 argv（不含 node 与脚本路径）。命令必须放在 `--` 之后。
 * 返回 { options, command } 或 { help:true }。
 */
export function parseSupervisorArgs(argv = []) {
  const options = { ...DEFAULTS, dataRoot: '', log: '' }
  let command = []
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i])
    if (a === '--') {
      command = argv.slice(i + 1).map(String)
      break
    }
    if (a === '--help' || a === '-h') return { help: true, options, command: [] }
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`)
      return String(argv[++i])
    }
    if (a === '--data-root') { options.dataRoot = next(); continue }
    if (a.startsWith('--data-root=')) { options.dataRoot = a.slice('--data-root='.length); continue }
    if (a === '--execute') { options.execute = true; continue }
    if (a === '--dry-run') { options.execute = false; continue }
    if (a === '--max-restarts') { options.maxRestarts = parsePositiveInt(next(), '--max-restarts', { min: 0, max: 20 }); continue }
    if (a.startsWith('--max-restarts=')) { options.maxRestarts = parsePositiveInt(a.slice('--max-restarts='.length), '--max-restarts', { min: 0, max: 20 }); continue }
    if (a === '--backoff-ms') { options.backoffMs = parsePositiveInt(next(), '--backoff-ms', { min: 0, max: 3_600_000 }); continue }
    if (a.startsWith('--backoff-ms=')) { options.backoffMs = parsePositiveInt(a.slice('--backoff-ms='.length), '--backoff-ms', { min: 0, max: 3_600_000 }); continue }
    if (a === '--backoff-max-ms') { options.backoffMaxMs = parsePositiveInt(next(), '--backoff-max-ms', { min: 0, max: 3_600_000 }); continue }
    if (a.startsWith('--backoff-max-ms=')) { options.backoffMaxMs = parsePositiveInt(a.slice('--backoff-max-ms='.length), '--backoff-max-ms', { min: 0, max: 3_600_000 }); continue }
    if (a === '--supervisor-id') { options.supervisorId = next(); continue }
    if (a.startsWith('--supervisor-id=')) { options.supervisorId = a.slice('--supervisor-id='.length); continue }
    if (a === '--log') { options.log = next(); continue }
    if (a.startsWith('--log=')) { options.log = a.slice('--log='.length); continue }
    throw new Error(`unknown option: ${a} (put the command after --)`)
  }
  if (!command.length) throw new Error('missing command: use -- <command> [args...]')
  if (!options.supervisorId || options.supervisorId.length > 128) throw new Error('--supervisor-id must be 1..128 chars')
  if (options.backoffMaxMs < options.backoffMs) throw new Error('--backoff-max-ms must be >= --backoff-ms')
  return { options, command }
}

/** <dataDir>/restart；options.stateDir 优先（测试/嵌入用）。 */
export function stateDirFor(options = {}) {
  if (options.stateDir) return String(options.stateDir)
  const layout = resolveFangLayout({ dataRoot: options.dataRoot ?? '' })
  return path.join(layout.dataDir, 'restart')
}

/**
 * 只读校验：是否存在一份可以用于「这个 pid 的这次退出」的授权清单。
 * 条件是契约的完整前置：armed、未过期、execution.executed===false、无回执、guard.pid 匹配。
 *
 * @returns {{ok:boolean, reason:string|null, approval?:object, manifest?:object, candidates?:number}}
 */
export function verifyApprovalForPid({ stateDir, pid, now = Date.now(), hmacSecret = null } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: 'invalid-pid' }
  // 本地 HMAC key 存在 => 清单必须带有效签名；不存在 => 保持 digest-only 兼容。
  let secret = hmacSecret
  let requireSignature = false
  if (secret === null) {
    const local = readHmacSecret(stateDir)
    if (local.ok) { secret = local.secret; requireSignature = true }
  } else {
    requireSignature = true
  }
  const ids = listApprovalIds(stateDir)
  if (!ids.length) return { ok: false, reason: 'no-approval', candidates: 0 }
  const statuses = ids
    .map(id => inspectApproval(stateDir, id, { now, hmacSecret: secret, requireSignature }))
    .filter(s => s.found && s.manifest)
    .sort((a, b) => (b.manifest.approvedAt ?? 0) - (a.manifest.approvedAt ?? 0))
  const forPid = statuses.filter(s => s.manifest.guard?.pid === pid)
  if (!forPid.length) {
    return {
      ok: false,
      reason: statuses.length ? 'pid-mismatch' : 'no-approval',
      candidates: statuses.length,
    }
  }
  const newest = forPid[0]
  if (newest.executed) return { ok: false, reason: 'already-executed', approval: newest, manifest: newest.manifest, candidates: forPid.length }
  if (!newest.authorized) {
    return {
      ok: false,
      reason: newest.blockedReason ?? 'not-authorized',
      approval: newest,
      manifest: newest.manifest,
      candidates: forPid.length,
    }
  }
  return { ok: true, reason: null, approval: newest, manifest: newest.manifest, candidates: forPid.length }
}

/** 写执行回执（仅在替换进程已经 spawn 成功后调用）。 */
export function writeRestartReceipt({
  stateDir,
  manifest,
  supervisorId = SUPERVISOR_ID,
  executedAt = Date.now(),
  exitCode = GATED_RESTART_EXIT,
  previousPid = null,
  replacementPid = null,
} = {}) {
  const receipt = buildExecutionReceipt({
    manifest,
    supervisorId,
    pid: process.pid,
    executedAt,
    exitCode,
    previousPid,
    replacementPid,
  })
  const file = receiptFile(stateDir, manifest.id)
  writeJsonAtomic(file, receipt)
  return { receipt, file }
}

/** spawn 一个子进程；在 'spawn' 成功或 'error' 时 resolve。 */
export function startChild(argv, { spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnImpl(argv[0], argv.slice(1), { stdio: 'inherit', env: process.env })
    } catch (error) {
      return resolve({ ok: false, error: String(error?.message ?? error), pid: null })
    }
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      child.removeListener('spawn', onSpawn)
      child.removeListener('error', onError)
      resolve(value)
    }
    const onSpawn = () => settle({ ok: true, child, pid: child.pid ?? null })
    const onError = (error) => settle({ ok: false, error: String(error?.message ?? error), pid: child.pid ?? null })
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
}

/** 等子进程退出；返回 { code, signal, pid, error? }。 */
export function waitExit(child) {
  return new Promise((resolve) => {
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    child.once('exit', (code, signal) => settle({ code, signal: signal ?? null, pid: child.pid ?? null, error: null }))
    child.once('error', (error) => settle({ code: null, signal: null, pid: child.pid ?? null, error: String(error?.message ?? error) }))
  })
}

function normalizeOptions(options = {}) {
  const merged = { ...DEFAULTS, ...options }
  const maxRestarts = Number.isFinite(merged.maxRestarts) ? CLAMP(Math.floor(merged.maxRestarts), 0, 20) : DEFAULTS.maxRestarts
  const backoffMs = Number.isFinite(merged.backoffMs) ? CLAMP(Math.floor(merged.backoffMs), 0, 3_600_000) : DEFAULTS.backoffMs
  const backoffMaxMs = Number.isFinite(merged.backoffMaxMs) ? CLAMP(Math.floor(merged.backoffMaxMs), backoffMs, 3_600_000) : Math.max(DEFAULTS.backoffMaxMs, backoffMs)
  const supervisorId = String(merged.supervisorId ?? SUPERVISOR_ID).trim() || SUPERVISOR_ID
  return { ...merged, maxRestarts, backoffMs, backoffMaxMs, supervisorId, execute: merged.execute === true }
}

/**
 * 监督主循环。
 * @param {object} input
 * @param {string[]} input.command 要监督的命令 argv
 * @param {object} [input.options] {execute, maxRestarts, backoffMs, backoffMaxMs, supervisorId, dataRoot, stateDir, log}
 * @param {Function} [input.verify] 默认 verifyApprovalForPid；测试可注入
 * @param {Function} [input.sleepFn] 默认 kernel sleep；测试可注入
 * @param {Function} [input.logSink] 额外的日志接收器（测试用）
 */
export async function supervise({ command, options = {}, verify = verifyApprovalForPid, sleepFn = sleep, logSink = null } = {}) {
  if (!Array.isArray(command) || !command.length) throw new Error('supervise() requires a non-empty command argv')
  const opts = normalizeOptions(options)
  const stateDir = stateDirFor(opts)
  const logFile = opts.log ? String(opts.log) : path.join(stateDir, 'supervisor.jsonl')
  const log = (event, data = {}) => {
    try {
      ensureDir(path.dirname(logFile))
      appendJsonl(logFile, { at: new Date().toISOString(), supervisorPid: process.pid, event, ...data })
    } catch { /* 日志失败不许改变监督语义 */ }
    try { logSink?.(event, data) } catch { /* ignore */ }
  }
  const result = {
    execute: opts.execute,
    supervisorId: opts.supervisorId,
    stateDir,
    logFile,
    restarts: 0,
    runs: 0,
    finalCode: null,
    signal: null,
    stopped: null,
    deniedReason: null,
    wouldRestart: [],
    receipts: [],
  }

  log('supervisor-start', {
    command, dryRun: !opts.execute, maxRestarts: opts.maxRestarts,
    backoffMs: opts.backoffMs, backoffMaxMs: opts.backoffMaxMs,
  })

  let activeChild = null
  const forward = (signal) => () => {
    try { activeChild?.kill(signal) } catch { /* ignore */ }
  }
  const onInt = forward('SIGINT')
  const onTerm = forward('SIGTERM')
  process.once('SIGINT', onInt)
  process.once('SIGTERM', onTerm)
  const cleanupSignals = () => {
    process.removeListener('SIGINT', onInt)
    process.removeListener('SIGTERM', onTerm)
  }

  try {
    let started = await startChild(command)
    if (!started.ok) {
      log('supervisor-stop', { reason: 'spawn-error', error: started.error })
      return { ...result, stopped: 'spawn-error', error: started.error }
    }
    activeChild = started.child
    result.runs++
    log('child-start', { run: result.runs, pid: started.pid })

    for (;;) {
      const exit = await waitExit(activeChild)
      activeChild = null
      result.finalCode = exit.code
      result.signal = exit.signal
      if (exit.error) {
        log('supervisor-stop', { reason: 'child-error', error: exit.error })
        return { ...result, stopped: 'child-error', error: exit.error }
      }
      log('child-exit', { run: result.runs, pid: exit.pid, code: exit.code, signal: exit.signal })

      if (exit.code !== GATED_RESTART_EXIT) {
        const reason = exit.code === 0 ? 'clean-exit' : 'non-gated-exit'
        log('supervisor-stop', { reason, code: exit.code })
        return { ...result, stopped: reason }
      }

      const verdict = verify({ stateDir, pid: exit.pid, now: Date.now() })
      if (!verdict?.ok) {
        result.deniedReason = verdict?.reason ?? 'not-authorized'
        log('restart-denied', { pid: exit.pid, reason: result.deniedReason })
        log('supervisor-stop', { reason: 'restart-denied', deniedReason: result.deniedReason })
        return { ...result, stopped: 'restart-denied' }
      }
      const manifest = verdict.manifest
      result.wouldRestart.push(manifest.id)

      if (!opts.execute) {
        log('would-restart', { id: manifest.id, pid: exit.pid, risk: manifest.risk })
        log('supervisor-stop', { reason: 'dry-run' })
        return { ...result, stopped: 'dry-run' }
      }
      if (result.restarts >= opts.maxRestarts) {
        log('supervisor-stop', { reason: 'max-restarts', restarts: result.restarts })
        return { ...result, stopped: 'max-restarts' }
      }

      result.restarts++
      const delay = Math.min(opts.backoffMaxMs, opts.backoffMs * 2 ** (result.restarts - 1))
      log('backoff', { restart: result.restarts, delayMs: delay })
      if (delay > 0) await sleepFn(delay)

      const replacedAt = Date.now()
      const next = await startChild(command)
      if (!next.ok) {
        log('supervisor-stop', { reason: 'replacement-spawn-error', error: next.error })
        return { ...result, stopped: 'replacement-spawn-error', error: next.error }
      }
      activeChild = next.child
      result.runs++
      log('child-start', { run: result.runs, pid: next.pid, restarted: true })

      try {
        const { receipt, file } = writeRestartReceipt({
          stateDir,
          manifest,
          supervisorId: opts.supervisorId,
          executedAt: replacedAt,
          exitCode: GATED_RESTART_EXIT,
          previousPid: exit.pid,
          replacementPid: next.pid,
        })
        result.receipts.push({ id: manifest.id, file, digest: receipt.digest })
        log('restart-executed', { id: manifest.id, previousPid: exit.pid, replacementPid: next.pid, receipt: file })
      } catch (error) {
        // 回执写不进去 => 执行证据缺失，立刻停下，不继续制造更多不可核对的执行。
        log('supervisor-stop', { reason: 'receipt-write-failed', error: String(error?.message ?? error) })
        return { ...result, stopped: 'receipt-write-failed', error: String(error?.message ?? error) }
      }
    }
  } finally {
    cleanupSignals()
    // 不要把被监督的子进程留在本进程退出后变成孤儿：只有本工具主动停止时才尝试收尾。
    if (activeChild && activeChild.exitCode === null) {
      try { activeChild.kill('SIGTERM') } catch { /* ignore */ }
    }
  }
}

/** CLI 入口；返回 process.exitCode。 */
export async function main(argv = process.argv.slice(2)) {
  let parsed
  try {
    parsed = parseSupervisorArgs(argv)
  } catch (error) {
    console.error(`[restart-supervisor] ${error?.message ?? error}`)
    console.error(USAGE)
    return 2
  }
  if (parsed.help) {
    console.log(USAGE)
    return 0
  }
  const result = await supervise({ command: parsed.command, options: parsed.options })
  if (result.stopped === 'spawn-error' || result.stopped === 'replacement-spawn-error') {
    console.error(`[restart-supervisor] ${result.stopped}: ${result.error ?? 'unknown error'}`)
  } else if (result.stopped === 'dry-run') {
    console.log(`[restart-supervisor] dry-run: child exited ${GATED_RESTART_EXIT}, approval ${result.wouldRestart.at(-1)} verified; not restarting (pass --execute to allow)`)
  } else if (result.stopped === 'restart-denied') {
    console.error(`[restart-supervisor] restart denied: ${result.deniedReason}`)
  } else {
    console.log(`[restart-supervisor] stopped=${result.stopped} restarts=${result.restarts} runs=${result.runs} finalCode=${result.finalCode}`)
  }
  return result.finalCode ?? 1
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
    console.error(`[restart-supervisor] ${error?.message ?? error}`)
    process.exitCode = 2
  })
}
