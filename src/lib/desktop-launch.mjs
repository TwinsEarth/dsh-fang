// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// desktop-launch — 把 DSH Desktop 启动挂到 restart-supervisor 下的「真实入口」适配器。
//
// 它不修改 DSH Desktop 安装目录，也不自动启动；只负责构造：
//   node tools/restart-supervisor.mjs [--execute] --data-root <dir> -- <desktop-exe> <args...>
// 由 supervisor 决定：退出码 75 + 已武装清单 + pid 匹配才重启；默认 dry-run。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  applyDisabledRows,
  checkBundleRows,
  findFangPackageDir,
  readBundleRows,
  readPackageName,
} from './boot-guard.mjs'

const isExecutableFile = (file) => {
  try { return fs.statSync(file).isFile() } catch { return false }
}

/** 从 env/DSH 参数推断本机 desktop profile（用于无 --profile-dir 时自动自检）。 */
export function detectDesktopProfileDir({ env = process.env, args = [] } = {}) {
  const hasPackage = (dir) => {
    try { return isExecutableFile(path.join(String(dir), 'package.json')) } catch { return false }
  }
  const explicit = String(env?.DSH_PROFILE_DIR ?? '').trim()
  if (explicit && hasPackage(explicit)) return path.resolve(explicit)
  let profile = String(env?.DSH_PROFILE ?? '').trim()
  if (!profile) {
    const index = Array.isArray(args) ? args.findIndex((value) => value === '--profile' || value === '-p') : -1
    if (index >= 0 && args[index + 1]) profile = String(args[index + 1])
    else {
      const inline = Array.isArray(args) ? args.find((value) => value.startsWith('--profile=')) : null
      if (inline) profile = inline.slice('--profile='.length)
    }
  }
  if (!profile) profile = 'desktop'
  const home = String(env?.DSH_HOME ?? '').trim() || path.join(String(env?.USERPROFILE ?? env?.HOME ?? '').trim() || '.', '.dsh')
  if (!home) return ''
  const candidate = path.join(path.resolve(home), 'profiles', profile)
  return hasPackage(candidate) ? candidate : ''
}

const pidAlive = (pid) => {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return false
  try { process.kill(value, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

/** 读取 restart-guard 写的 boot-state；上一进程 booting/crashed 且 pid 已死 = 启动期崩溃。 */
export function readUncleanBoot(dataRoot) {
  const root = String(dataRoot ?? '').trim()
  if (!root) return null
  try {
    const file = path.join(path.resolve(root), 'restart', 'boot-state.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!raw || (raw.state !== 'booting' && raw.state !== 'crashed')) return null
    if (Number(raw.pid) === process.pid) return null
    if (pidAlive(raw.pid)) return null
    return { state: String(raw.state), pid: Number(raw.pid) || null, at: Number(raw.at) || 0, error: raw.error ?? null }
  } catch { return null }
}

/**
 * 启动前跑 boot-guard：失败时可按“安全模式”禁用全部 fang 行。
 * 默认不写 profile；调用方显式 safeModeOnFailure=true 才会改（会先备份）。
 * dataRoot 给出时，若上次 boot-state 为 booting/crashed（启动期崩溃），同样走安全模式熔断。
 */
export function runBootGuard(profileDir, { dataRoot = '', safeModeOnFailure = false, timeoutMs = 8000 } = {}) {
  const dir = String(profileDir ?? '').trim()
  if (!dir) return { ok: true, skipped: 'no-profile-dir' }
  const resolved = path.resolve(dir)
  if (!isExecutableFile(path.join(resolved, 'package.json'))) return { ok: false, error: 'profile-package-missing', profileDir: resolved }
  const pkgDir = findFangPackageDir(resolved)
  if (!pkgDir) return { ok: true, skipped: 'fang-package-not-found', profileDir: resolved }
  const parsed = readBundleRows(pkgDir)
  if (!parsed.ok) return { ok: false, error: 'bundle-patch-invalid', detail: parsed.error, profileDir: resolved }
  const uncleanBoot = readUncleanBoot(dataRoot)
  const disableAllForSafeMode = (reason, findings) => {
    const applied = applyDisabledRows(resolved, parsed.rows.map((row) => row.id))
    if (!applied.ok) return { ok: false, error: 'safe-mode-apply-failed', detail: applied.error, findings, profileDir: resolved, reason }
    return { ok: true, safeModeApplied: true, reason, applied, findings, checked: findings.length, profileDir: resolved, packageDir: pkgDir }
  }
  if (uncleanBoot) {
    if (!safeModeOnFailure) return { ok: false, error: 'unclean-boot', uncleanBoot, profileDir: resolved, packageDir: pkgDir }
    return disableAllForSafeMode('unclean-boot', [{ code: 'unclean-boot', level: 'block', detail: JSON.stringify(uncleanBoot) }])
  }
  const checked = checkBundleRows(parsed.rows, { profileDir: resolved, ownPackage: readPackageName(pkgDir), timeoutMs })
  if (checked.ok) return { ok: true, checked: checked.checked, findings: checked.findings, profileDir: resolved, packageDir: pkgDir }
  const blocked = checked.findings.filter((finding) => finding.level === 'block')
  if (!safeModeOnFailure) {
    return { ok: false, error: 'boot-guard-blocked', findings: checked.findings, blocked, profileDir: resolved, packageDir: pkgDir }
  }
  return disableAllForSafeMode('boot-guard-blocked', checked.findings)
}

/**
 * @param {{exe?:string, dataRoot?:string, profileDir?:string, args?:string[], execute?:boolean, nodePath?:string, supervisorPath?:string}} input
 * @returns {{ok:true, argv:string[], dryRun:boolean, exe:string, dataRoot:string, profileDir:string} | {ok:false, error:string}}
 */
export function resolveDesktopLaunch(input = {}) {
  const exe = String(input.exe ?? '').trim()
  if (!exe) return { ok: false, error: 'desktop-exe-required' }
  const resolvedExe = path.resolve(exe)
  if (!isExecutableFile(resolvedExe)) return { ok: false, error: 'desktop-exe-missing' }
  const dataRoot = String(input.dataRoot ?? '').trim()
  if (!dataRoot) return { ok: false, error: 'data-root-required' }
  const resolvedRoot = path.resolve(dataRoot)
  const profileDir = String(input.profileDir ?? '').trim()
  if (profileDir) {
    const resolvedProfile = path.resolve(profileDir)
    if (!isExecutableFile(path.join(resolvedProfile, 'package.json'))) return { ok: false, error: 'profile-dir-missing' }
  }
  const supervisorPath = input.supervisorPath
    ? path.resolve(String(input.supervisorPath))
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'restart-supervisor.mjs')
  if (!isExecutableFile(supervisorPath)) return { ok: false, error: 'supervisor-missing' }
  const nodePath = String(input.nodePath ?? process.execPath)
  const execute = input.execute === true
  const desktopArgs = Array.isArray(input.args) ? input.args.map(String) : []
  const argv = [
    nodePath, supervisorPath,
    ...(execute ? ['--execute'] : []),
    '--data-root', resolvedRoot,
    '--', resolvedExe, ...desktopArgs,
  ]
  return { ok: true, argv, dryRun: !execute, exe: resolvedExe, dataRoot: resolvedRoot, profileDir: profileDir ? path.resolve(profileDir) : '' }
}

/** 只用于展示，不做 shell 拼接执行。 */
export function describeDesktopLaunch(plan) {
  if (!plan?.ok) return `desktop-launch: ${plan?.error ?? 'invalid'}`
  return `${plan.dryRun ? '[dry-run] ' : '[execute] '}${plan.argv.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ')}`
}
