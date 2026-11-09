// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/boot-guard.mjs — DSH 启动前/发布前插件树自检。
//
//   node tools/boot-guard.mjs --profile-dir <profile>              # dry-run：检查行/模块/import
//   node tools/boot-guard.mjs --profile-dir <profile> --apply      # 禁用失败行（写 profile patch + 备份）
//   node tools/boot-guard.mjs --profile-dir <profile> --safe-mode  # 禁用全部 fang 行（安全模式）
//
// 只处理 fang bundle 的行；不碰 DSH 核心/其他插件；写 profile 前备份 .bak-<ts>。
import path from 'node:path'

import {
  applyDisabledRows,
  checkBundleRows,
  findFangPackageDir,
  readBundleRows,
  readPackageName,
  smokePackage,
} from '../src/lib/boot-guard.mjs'

function parseArgs(argv = []) {
  const out = { profileDir: '', pkgDir: '', candidateDir: '', apply: false, safeMode: false, json: false, timeoutMs: 8000 }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') { out.apply = true; continue }
    if (arg === '--safe-mode') { out.safeMode = true; continue }
    if (arg === '--json') { out.json = true; continue }
    if (arg === '--profile-dir') { out.profileDir = String(argv[++index] ?? ''); continue }
    if (arg === '--pkg-dir') { out.pkgDir = String(argv[++index] ?? ''); continue }
    if (arg === '--candidate-dir') { out.candidateDir = String(argv[++index] ?? ''); continue }
    if (arg === '--timeout') { out.timeoutMs = Math.max(1000, Number(argv[++index]) || 8000); continue }
    throw new Error(`unknown argument: ${arg}`)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
// 更新器候选包冒烟：不读 profile、不写任何文件，只报告是否可转正。
if (args.candidateDir) {
  const candidateDir = path.resolve(args.candidateDir)
  const smoke = smokePackage(candidateDir, { timeoutMs: args.timeoutMs })
  const result = { candidateDir, ...smoke }
  if (args.json) console.log(JSON.stringify(result, null, 2))
  else console.log(`${smoke.ok ? 'PASS' : 'FAIL'}  candidate smoke ${candidateDir}${smoke.ok ? '' : ' — ' + (smoke.error ?? 'no apply()')}`)
  process.exit(smoke.ok ? 0 : 1)
}
const profileDir = path.resolve(args.profileDir || '')
if (!args.profileDir) {
  console.error('usage: node tools/boot-guard.mjs --profile-dir <profile> [--apply|--safe-mode] [--json]')
  process.exit(2)
}
const result = { profileDir, ok: false, checked: 0, findings: [], applied: null }
try {
  const pkgDir = args.pkgDir ? path.resolve(args.pkgDir) : findFangPackageDir(profileDir)
  if (!pkgDir) {
    result.findings = [{ code: 'fang-package-not-found', level: 'block', detail: profileDir }]
  } else {
    result.packageDir = pkgDir
    const parsed = readBundleRows(pkgDir)
    if (!parsed.ok) result.findings.push({ code: 'bundle-patch-invalid', level: 'block', detail: parsed.error })
    result.rows = parsed.rows.length
    if (parsed.rows.length > 0) {
      const checked = checkBundleRows(parsed.rows, { profileDir, ownPackage: readPackageName(pkgDir), timeoutMs: args.timeoutMs })
      result.ok = checked.ok
      result.checked = checked.checked
      result.findings = [...result.findings, ...checked.findings]
    } else if (parsed.ok) {
      result.ok = true
    }
    if (args.apply || args.safeMode) {
      const ids = args.safeMode
        ? parsed.rows.map((row) => row.id)
        : [...new Set(result.findings.filter((finding) => finding.level === 'block' && finding.id).map((finding) => finding.id))]
      if (!ids.length) {
        result.applied = { tried: false, reason: 'nothing-to-disable' }
      } else {
        result.applied = applyDisabledRows(profileDir, ids)
        // 失败行已写 disabled:true（profile 覆盖层会跳过它们）→ 本次 guard 视为已恢复。
        if (result.applied.ok) result.ok = true
      }
    }
  }
} catch (error) {
  result.findings = [{ code: 'boot-guard-threw', level: 'block', detail: String(error?.message ?? error) }]
}
if (args.json) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  boot-guard ${result.profileDir}`)
  for (const finding of result.findings) console.log(`  ${finding.level}: ${finding.code}${finding.id ? ' ' + finding.id : ''}${finding.detail ? ' — ' + finding.detail : ''}`)
  if (result.applied) console.log(`  applied: ${JSON.stringify(result.applied)}`)
  if (!result.ok && !args.apply && !args.safeMode) {
    console.log('  hint: add --apply to disable failing rows (profile patch backup is written), or --safe-mode')
  }
}
process.exit(result.ok ? 0 : 1)
