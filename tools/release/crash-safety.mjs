// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/release/crash-safety.mjs — 防崩溃门禁（源码不变量 + 打包产物冒烟）。
//
//   node tools/release/crash-safety.mjs --json                     # 源码模式（preflight 调用）
//   node tools/release/crash-safety.mjs --json --package dist/npm/package --tarball dist/dsh-fang-X.tgz
//
// 源码模式：确认「瓮城」的防崩溃防线没有被删除/改坏（boot-guard、restart-guard、
// fork 监督/退避/孤儿回收、role fail-closed、未清洁启动检测、约束文档）。
// 打包模式：在**最终发布产物**上再跑一次——必需防线文件必须进包、候选包入口必须能在
// 隔离进程里 import 且导出 apply()（等价于更新候选包冒烟），manifest 校验和必须一致。
// 任一项失败 → 构建/发布失败；本工具不写任何 profile、不联网。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { ROOT, readJson, readText, sha256File, versionOf } from './lib.mjs'
import { smokePackage } from '../../src/lib/boot-guard.mjs'

const argv = process.argv.slice(2)
const jsonOnly = argv.includes('--json')
const pick = (flag) => {
  const index = argv.indexOf(flag)
  return index >= 0 ? String(argv[index + 1] ?? '') : ''
}
const packageDir = pick('--package')
const tarball = pick('--tarball')

const checks = []
const add = (id, ok, detail = '') => {
  checks.push({ id, ok: !!ok, detail: String(detail) })
  if (!jsonOnly) console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(48)} ${detail}`)
}
const fileText = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8') } catch { return '' } }
const fileExists = (rel) => fs.existsSync(path.join(ROOT, rel))

// ── 1. 源码防线：文件存在 + 纯函数导出可用 ────────────────────────────────
const REQUIRED_SOURCE_FILES = [
  'src/lib/boot-guard.mjs',
  'tools/boot-guard.mjs',
  'src/lib/fork-supervisor.mjs',
  'src/lib/desktop-launch.mjs',
  'src/plugins/restart-guard.mjs',
  'src/kernel/role.mjs',
  'client.js',
]
const missingSources = REQUIRED_SOURCE_FILES.filter((rel) => !fileExists(rel))
add('source: crash-safety files present', missingSources.length === 0, missingSources.length ? `missing=${missingSources.join(',')}` : `${REQUIRED_SOURCE_FILES.length} files`)

async function exportsOf(rel) {
  try { return await import(pathToFileURL(path.join(ROOT, rel)).href) } catch (error) { return { __error: String(error?.message ?? error) } }
}
const bootGuardLib = await exportsOf('src/lib/boot-guard.mjs')
const forkSupervisor = await exportsOf('src/lib/fork-supervisor.mjs')
const desktopLaunch = await exportsOf('src/lib/desktop-launch.mjs')
const bootGuardApi = ['readBundleRows', 'checkBundleRows', 'applyDisabledRows', 'smokePackage', 'readPackageEntry']
const forkApi = ['computeBackoff', 'planRestart', 'reconcileOrphans', 'writeForkMeta']
const launchApi = ['runBootGuard', 'readUncleanBoot']
const apiMissing = [
  ...bootGuardApi.filter((key) => typeof bootGuardLib[key] !== 'function').map((key) => `boot-guard.${key}`),
  ...forkApi.filter((key) => typeof forkSupervisor[key] !== 'function').map((key) => `fork-supervisor.${key}`),
  ...launchApi.filter((key) => typeof desktopLaunch[key] !== 'function').map((key) => `desktop-launch.${key}`),
]
add('source: fail-safe exports resolvable', apiMissing.length === 0, apiMissing.length ? `missing=${apiMissing.join(',')}` : `${bootGuardApi.length + forkApi.length + launchApi.length} exports`)

// ── 2. 源码防线：插件层不得绕过既有闸门 ─────────────────────────────────
const restartGuard = fileText('src/plugins/restart-guard.mjs')
add('source: restart-guard gate intact', restartGuard.includes("name = 'fang-restart-guard'") && restartGuard.includes('export function decide'), 'fang-restart-guard/decide')
const forker = fileText('src/plugins/forker.mjs')
add('source: fork supervision wired', forker.includes('planRestart(') && forker.includes('reconcileOrphans('), 'planRestart/reconcileOrphans')
const role = fileText('src/kernel/role.mjs')
add('source: role fail-closed gate', role.includes('export function roleGate') && role.includes('export function roleAllows'), 'roleGate/roleAllows')
const client = fileText('client.js')
const clientGuarded = client.includes('window.__ModuleLoader__.load') && client.includes("typeof window !== 'undefined'")
add('source: client half load-guarded', clientGuarded, 'loader guard')
add('source: client half never imports node builtins', !/\brequire\(['"]node:/.test(client) && !/\bfrom ['"]node:/.test(client), 'browser-safe')

// ── 3. 持久约束：流程/防线文档与打包清单 ──────────────────────────────────
const docsOk = fileExists('docs/WORKFLOW-UI.md') && fileExists('docs/CRASH-SAFETY.md')
add('docs: WORKFLOW-UI + CRASH-SAFETY', docsOk, docsOk ? 'present' : 'missing')
const manifestPkg = readJson('package.json')
const packedFiles = Array.isArray(manifestPkg.files) ? manifestPkg.files : []
const packedDocs = ['docs/WORKFLOW-UI.md', 'docs/CRASH-SAFETY.md'].filter((rel) => !packedFiles.includes(rel))
add('package: guard docs packed', packedDocs.length === 0, packedDocs.length ? `missing=${packedDocs.join(',')}` : '2 docs')
const packedGuardFiles = ['tools/boot-guard.mjs', 'src/**/*.mjs']
const packedToolsOk = packedGuardFiles.some((pattern) => packedFiles.includes(pattern))
add('package: guard tool packed', packedToolsOk, 'tools/boot-guard.mjs')

// ── 4. 打包模式：在最终产物上复验 ─────────────────────────────────────────
if (packageDir) {
  const dir = path.resolve(packageDir)
  const required = [
    'package.json', 'client.js', 'cordis.patch.yml', 'tools/boot-guard.mjs',
    'src/lib/boot-guard.mjs', 'src/lib/fork-supervisor.mjs', 'src/lib/desktop-launch.mjs',
    'src/plugins/restart-guard.mjs', 'src/kernel/role.mjs',
    'docs/WORKFLOW-UI.md', 'docs/CRASH-SAFETY.md',
  ]
  const missing = required.filter((rel) => !fs.existsSync(path.join(dir, rel)))
  add('artifact: crash-safety files staged', missing.length === 0, missing.length ? `missing=${missing.join(',')}` : `${required.length} files`)
  if (missing.length === 0) {
    let stagedPkg = null
    try { stagedPkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) } catch { stagedPkg = null }
    add('artifact: staged package matches version', stagedPkg?.version === versionOf(), `${stagedPkg?.version ?? '?'} vs ${versionOf()}`)
    add('artifact: staged client half declared', stagedPkg?.dsh?.client?.platform === 'web', JSON.stringify(stagedPkg?.dsh?.client ?? null))
    const smoke = smokePackage(dir)
    add('artifact: candidate package apply() smoke', smoke.ok === true, smoke.ok ? `${smoke.name ?? 'apply'} ok` : String(smoke.error ?? 'failed'))
  }
  if (tarball) {
    const tgz = path.resolve(tarball)
    add('artifact: tarball exists', fs.existsSync(tgz), path.basename(tgz))
    if (fs.existsSync(tgz) && fileExists('dist/manifest.json')) {
      const manifest = readJson('dist/manifest.json')
      const actual = sha256File(tgz)
      add('artifact: manifest sha256 matches tarball', manifest.sha256 === actual, actual.slice(0, 16))
      const listed = Array.isArray(manifest.files) ? manifest.files : []
      const missingEntries = ['package/docs/WORKFLOW-UI.md', 'package/docs/CRASH-SAFETY.md']
        .filter((rel) => !listed.includes(rel))
      add('artifact: guard docs inside tarball', missingEntries.length === 0, missingEntries.length ? `missing=${missingEntries.join(',')}` : '2 docs')
    }
  }
}

const ok = checks.every((check) => check.ok)
const report = {
  ok,
  mode: packageDir ? 'package' : 'source',
  version: versionOf(),
  node: process.versions.node,
  packageDir: packageDir ? path.resolve(packageDir) : null,
  tarball: tarball ? path.resolve(tarball) : null,
  checks,
  at: new Date().toISOString(),
}
if (jsonOnly) console.log(JSON.stringify(report, null, 2))
else console.log(`\n${ok ? 'GREEN' : 'RED'}  crash-safety ${report.mode} ${report.version}`)
process.exitCode = ok ? 0 : 1
