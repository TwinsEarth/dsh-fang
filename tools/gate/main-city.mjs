#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// 主城门禁 CLI：任何进主城的动作（打包/发布/安装/部署/新建 profile）先过这里。
//   node tools/gate/main-city.mjs --target source
//   node tools/gate/main-city.mjs --target package --package-dir dist/npm/package --tarball dist/dsh-fang-X.tgz
//   node tools/gate/main-city.mjs --target publish --package-dir ... --tarball ... --tag vX --check-registry
//   node tools/gate/main-city.mjs --target install --home <DSH_HOME> --profile fang-x --package-dir <dir>
//   node tools/gate/main-city.mjs --target deploy  --home <DSH_HOME> --profile fang-x --repair
//   node tools/gate/main-city.mjs --target profile --home <DSH_HOME> --profile demo --create
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_MIN_FREE_BYTES,
  DEFAULT_PROFILE_BUNDLES,
  GATE_TARGETS,
  createGatedProfile,
  formatGateFailure,
  runMainGate,
} from '../../src/lib/main-gate.mjs'

function parseArgs(argv = []) {
  const out = { target: 'package', json: false, repair: false, create: false, force: false, allowExisting: false, checkRegistry: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index])
    const next = () => {
      if (index + 1 >= argv.length) throw new Error(`missing value for ${arg}`)
      return String(argv[++index])
    }
    if (arg === '--json') { out.json = true; continue }
    if (arg === '--repair') { out.repair = true; continue }
    if (arg === '--create') { out.create = true; continue }
    if (arg === '--force') { out.force = true; continue }
    if (arg === '--allow-existing') { out.allowExisting = true; continue }
    if (arg === '--require-backup') { out.requireBackup = true; continue }
    if (arg === '--check-registry') { out.checkRegistry = true; continue }
    if (arg === '--supervisor-present') { out.supervisorPresent = true; continue }
    if (arg === '--help' || arg === '-h') { out.help = true; continue }
    if (arg === '--target') { out.target = next(); continue }
    if (arg.startsWith('--target=')) { out.target = arg.slice(9); continue }
    if (arg === '--root') { out.root = next(); continue }
    if (arg.startsWith('--root=')) { out.root = arg.slice(7); continue }
    if (arg === '--version') { out.version = next(); continue }
    if (arg.startsWith('--version=')) { out.version = arg.slice(10); continue }
    if (arg === '--dist') { out.distDir = next(); continue }
    if (arg.startsWith('--dist=')) { out.distDir = arg.slice(7); continue }
    if (arg === '--package-dir') { out.packageDir = next(); continue }
    if (arg.startsWith('--package-dir=')) { out.packageDir = arg.slice(14); continue }
    if (arg === '--tarball') { out.tarball = next(); continue }
    if (arg.startsWith('--tarball=')) { out.tarball = arg.slice(10); continue }
    if (arg === '--tag') { out.tag = next(); continue }
    if (arg.startsWith('--tag=')) { out.tag = arg.slice(6); continue }
    if (arg === '--npm-latest') { out.npmLatest = next(); continue }
    if (arg.startsWith('--npm-latest=')) { out.npmLatest = arg.slice(13); continue }
    if (arg === '--home') { out.homeDir = next(); continue }
    if (arg.startsWith('--home=')) { out.homeDir = arg.slice(7); continue }
    if (arg === '--profile') { out.profile = next(); continue }
    if (arg.startsWith('--profile=')) { out.profile = arg.slice(10); continue }
    if (arg === '--profile-dir') { out.profileDir = next(); continue }
    if (arg.startsWith('--profile-dir=')) { out.profileDir = arg.slice(14); continue }
    if (arg === '--data-dir') { out.dataDir = next(); continue }
    if (arg.startsWith('--data-dir=')) { out.dataDir = arg.slice(11); continue }
    if (arg === '--actor') { out.actor = next(); continue }
    if (arg.startsWith('--actor=')) { out.actor = arg.slice(8); continue }
    if (arg === '--bundles') { out.bundles = next().split(',').map((item) => item.trim()).filter(Boolean); continue }
    if (arg.startsWith('--bundles=')) { out.bundles = arg.slice(10).split(',').map((item) => item.trim()).filter(Boolean); continue }
    if (arg === '--min-free-mb') { out.minFreeBytes = Math.max(0, Number(next()) || 0) * 1024 * 1024; continue }
    if (arg.startsWith('--min-free-mb=')) { out.minFreeBytes = Math.max(0, Number(arg.slice(14)) || 0) * 1024 * 1024; continue }
    throw new Error(`unknown argument: ${arg}`)
  }
  if (!out.minFreeBytes) out.minFreeBytes = DEFAULT_MIN_FREE_BYTES
  return out
}

const USAGE = `usage: node tools/gate/main-city.mjs --target <${GATE_TARGETS.join('|')}> [options]

options:
  --root <dir>              source root (default: process.cwd())
  --version <semver>        expected version (default: package.json)
  --dist <dir>              dist directory containing manifest.json/tarball (default: dist)
  --package-dir <dir>       staged package directory (dist/npm/package)
  --tarball <file>          explicit tarball path
  --tag <vX.Y.Z>            release tag to match against version
  --npm-latest <version>    current registry latest (offline check)
  --check-registry          fetch npm latest before publish check
  --allow-existing          allow an already-published version (idempotent republish)
  --home <dir>              DSH_HOME that owns the profile
  --profile <name>          profile name
  --profile-dir <dir>       explicit profile directory
  --data-dir <dir>          explicit fang data dir (default <home>/fang/<profile>)
  --create                  create the profile after a green gate
  --force                   allow replacing an existing profile (backup taken)
  --repair                  create a .gate-backups snapshot when a profile has none
  --require-backup          block deploy when no profile backup exists
  --bundles a,b,c           bundles for a newly created profile
  --min-free-mb <n>         minimum free disk space (default ${Math.round(DEFAULT_MIN_FREE_BYTES / 1024 / 1024)})
  --actor <id>              recorded in the chained audit record
  --json                    machine-readable report
  -h, --help
`

async function npmLatest(version) {
  try {
    const res = await fetch('https://registry.npmjs.org/@twinsearth%2Fdsh-fang', { signal: AbortSignal.timeout(15000) })
    if (!res.ok) return { ok: false, detail: `registry HTTP ${res.status}` }
    const body = await res.json()
    return { ok: true, latest: String(body?.['dist-tags']?.latest ?? '') }
  } catch (error) {
    return { ok: false, detail: String(error?.message ?? error) }
  }
}

async function main() {
  let args
  try { args = parseArgs(process.argv.slice(2)) } catch (error) {
    console.error(`[main-city] ${error?.message ?? error}`)
    console.error(USAGE)
    return 2
  }
  if (args.help) { console.log(USAGE); return 0 }
  if (!GATE_TARGETS.includes(args.target)) {
    console.error(`[main-city] unknown target: ${args.target}`)
    console.error(USAGE)
    return 2
  }
  if (args.checkRegistry && args.target === 'publish') {
    const latest = await npmLatest()
    if (latest.ok) args.npmLatest = latest.latest
    else if (!args.json) console.warn(`[main-city] registry check skipped: ${latest.detail}`)
  }

  let report = runMainGate({
    target: args.target,
    root: args.root,
    version: args.version,
    distDir: args.distDir,
    packageDir: args.packageDir,
    tarball: args.tarball,
    tag: args.tag,
    npmLatest: args.npmLatest,
    allowExisting: args.allowExisting,
    homeDir: args.homeDir,
    profile: args.profile,
    profileDir: args.profileDir,
    dataDir: args.dataDir,
    repair: args.repair,
    requireBackup: args.requireBackup,
    supervisorPresent: args.supervisorPresent,
    create: args.create,
    force: args.force,
    minFreeBytes: args.minFreeBytes,
    actor: args.actor,
  })

  if (args.target === 'profile' && args.create === true && report.ok) {
    const created = createGatedProfile({
      homeDir: args.homeDir,
      profile: args.profile,
      bundles: args.bundles ?? DEFAULT_PROFILE_BUNDLES,
      force: args.force,
      minFreeBytes: args.minFreeBytes,
    })
    report = { ...report, create: created }
    if (!created.ok) {
      report.ok = false
      report.blockers = [...(report.blockers ?? []), { id: 'profile-create: failed', detail: `${created.error}${created.detail ? ': ' + created.detail : ''}` }]
      report.summary = { ...report.summary, blockers: report.summary.blockers + 1 }
    }
  }

  const reportFile = path.join(process.cwd(), 'dist', 'main-city-gate.json')
  try {
    fs.mkdirSync(path.dirname(reportFile), { recursive: true })
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', 'utf8')
  } catch { /* report is best-effort */ }

  if (args.json) console.log(JSON.stringify(report, null, 2))
  else {
    for (const item of report.checks ?? []) {
      if (item.ok && item.severity === 'info') continue
      console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.id.padEnd(48)} ${item.detail}`)
      if (item.repair) console.log(`      repair: ${item.repair}`)
    }
    console.log(`\n${report.ok ? 'GREEN' : 'RED'}  main-city gate ${report.target}  ` +
      `blockers=${report.summary?.blockers ?? 0} warnings=${report.summary?.warnings ?? 0} grade=${report.score?.grade ?? '?'}`)
    if (!report.ok) console.log(formatGateFailure(report))
    console.log(`report: ${reportFile}`)
  }
  return report.ok ? 0 : 1
}

const isMain = (() => {
  try { return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) } catch { return false }
})()

if (isMain) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    console.error(`[main-city] ${error?.stack ?? error}`)
    process.exitCode = 1
  })
}
