// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// 启动 DSH Desktop 并把它的重启权交给 restart-supervisor（默认 dry-run）。
//
//   node tools/desktop-launch.mjs --exe "C:\\Path\\DSH Desktop.exe" --data-root <fang-data>
//   node tools/desktop-launch.mjs --execute --exe ... --data-root ... --arg=--some-desktop-flag
import { spawn } from 'node:child_process'
import process from 'node:process'

import { describeDesktopLaunch, detectDesktopProfileDir, resolveDesktopLaunch, runBootGuard } from '../src/lib/desktop-launch.mjs'

function parseArgs(argv = []) {
  const out = { exe: '', dataRoot: '', profileDir: '', execute: false, args: [], bootGuard: true, safeModeOnFailure: true }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--execute') { out.execute = true; continue }
    if (arg === '--exe') { out.exe = String(argv[++i] ?? ''); continue }
    if (arg === '--data-root') { out.dataRoot = String(argv[++i] ?? ''); continue }
    if (arg === '--profile-dir') { out.profileDir = String(argv[++i] ?? ''); continue }
    if (arg === '--no-boot-guard') { out.bootGuard = false; continue }
    if (arg === '--no-safe-mode') { out.safeModeOnFailure = false; continue }
    if (arg.startsWith('--arg=')) { out.args.push(arg.slice('--arg='.length)); continue }
    if (arg === '--arg') { out.args.push(String(argv[++i] ?? '')); continue }
    throw new Error(`unknown argument: ${arg}`)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
// 未显式给 profile-dir 时，按 DSH_PROFILE_DIR / DSH_HOME/profiles/<profile> 自动探测；
// 探测不到就跳过自检（不阻塞启动），但会打印提示。
const detectedProfileDir = (args.profileDir || !args.bootGuard) ? '' : detectDesktopProfileDir({ env: process.env, args: args.args })
const profileDir = args.profileDir || detectedProfileDir
if (args.bootGuard && !args.profileDir && detectedProfileDir) console.log(`[boot-guard] auto-detected profile: ${detectedProfileDir}`)
const plan = resolveDesktopLaunch({ exe: args.exe, dataRoot: args.dataRoot, profileDir, args: args.args, execute: args.execute })
if (!plan.ok) {
  console.error(`desktop-launch: ${plan.error}`)
  process.exitCode = 2
} else {
  console.log(describeDesktopLaunch(plan))
  // 启动前自检：失败时（--execute 且未 --no-safe-mode）自动安全模式禁用 fang 行。
  let guard = null
  if (args.bootGuard && plan.profileDir) {
    guard = runBootGuard(plan.profileDir, { dataRoot: plan.dataRoot, safeModeOnFailure: args.execute && args.safeModeOnFailure })
    if (guard.ok && guard.safeModeApplied) {
      console.warn(`[boot-guard] safe-mode applied: disabled ${guard.applied?.added ?? 0} fang row(s); fix profile before re-enabling`)
    } else if (!guard.ok) {
      console.error(`[boot-guard] blocked: ${guard.error ?? 'boot-guard-blocked'}`)
      for (const finding of (guard.blocked ?? guard.findings ?? []).slice(0, 10)) {
        console.error(`  ${finding.level}: ${finding.code}${finding.id ? ' ' + finding.id : ''}${finding.detail ? ' — ' + finding.detail : ''}`)
      }
      if (!args.execute && args.safeModeOnFailure) console.error('[boot-guard] dry-run: would apply safe-mode on --execute')
      console.error('[boot-guard] 不启动；先运行 tools/boot-guard.mjs --profile-dir <profile> --apply/--safe-mode 修复，或加 --no-boot-guard')
      process.exitCode = 2
    } else {
      console.log(`[boot-guard] PASS checked=${guard.checked ?? 0} findings=${(guard.findings ?? []).length}`)
    }
  }
  if (process.exitCode === 2) {
    // fail-closed：自检失败绝不继续启动
  } else if (plan.dryRun) {
    console.log('dry-run：未启动。加 --execute 才会真正交给 supervisor。')
  } else {
    const child = spawn(plan.argv[0], plan.argv.slice(1), { stdio: 'inherit', windowsHide: false })
    child.on('exit', (code, signal) => {
      if (signal) process.kill(process.pid, signal)
      else process.exitCode = code ?? 0
    })
  }
}
