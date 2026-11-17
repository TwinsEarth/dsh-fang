#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// v3.5.0 三方发布协调检查（只读）：dsh-fang 3.5.0 与 @twinsearth/dsh-fang-contract 1.2.0
// 必须同窗口发布，且发布顺序为先 contract、后 dsh-fang。本工具不发布、不写盘。
//
// 用法：node tools/release/release-order.mjs [--json] [--contract-repo <dir>]
// 退出码：0 = 版本一致性检查全部通过（发布动作可能仍被凭据/审核阻塞）；2 = 一致性不通过。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? String(argv[index + 1] ?? '') : fallback
}
const asJson = argv.includes('--json')
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..')
const CONTRACT_REPO = arg('contract-repo', 'E:\\GPT\\dsh-fang-contract')

const checks = []
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: String(detail ?? '') })
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

async function registryVersions(pkg) {
  const url = `https://registry.npmjs.org/${String(pkg).replace('/', '%2f')}`
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } })
    if (!response.ok) return { ok: false, status: response.status }
    const body = await response.json()
    return { ok: true, versions: Object.keys(body.versions ?? {}), latest: body['dist-tags']?.latest ?? null }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

const fangPkg = readJson(path.join(REPO, 'package.json'))
const contractPkg = readJson(path.join(CONTRACT_REPO, 'package.json'))
const vendor = readJson(path.join(REPO, 'src', 'contract', 'VENDOR.json'))
const fangVersion = String(fangPkg?.version ?? '')
const contractVersion = String(contractPkg?.version ?? '')
const vendorVersion = String(vendor?.version ?? '')

check('dsh-fang version is 3.5.0', fangVersion === '3.5.0', fangVersion)
check('contract repo version is 1.2.0', contractVersion === '1.2.0', contractVersion)
check('vendored contract matches contract repo version', vendorVersion === contractVersion, `${vendorVersion} vs ${contractVersion}`)

const contractGit = spawnSync('git', ['-C', CONTRACT_REPO, 'status', '--porcelain'], { encoding: 'utf8' })
check('contract repo working tree clean', (contractGit.stdout ?? '').trim() === '', (contractGit.stdout ?? '').trim().split('\n')[0] ?? 'clean')

const [fangRegistry, contractRegistry] = await Promise.all([
  registryVersions('@twinsearth/dsh-fang'),
  registryVersions('@twinsearth/dsh-fang-contract'),
])
check('npm fang 3.5.0 not published yet (expected before release)', fangRegistry.ok && !fangRegistry.versions?.includes('3.5.0'), fangRegistry.ok ? `latest=${fangRegistry.latest}` : `registry error ${fangRegistry.status ?? fangRegistry.error}`)
check('npm contract 1.2.0 not published yet (expected before release)', contractRegistry.ok && !contractRegistry.versions?.includes('1.2.0'), contractRegistry.ok ? `latest=${contractRegistry.latest}` : `registry error ${contractRegistry.status ?? contractRegistry.error}`)

const tagResult = spawnSync('git', ['-C', REPO, 'tag', '--list', 'v3.5.0'], { encoding: 'utf8' })
check('tag v3.5.0 absent (expected before release)', (tagResult.stdout ?? '').trim() === '', (tagResult.stdout ?? '').trim())

const tgz = path.join(REPO, 'dist', 'dsh-fang-3.5.0.tgz')
const sidecar = `${tgz}.sha256`
const artifactExists = fs.existsSync(tgz)
check('release artifact exists', artifactExists, artifactExists ? `${Math.round(fs.statSync(tgz).size / 1024)} KiB` : 'dist/dsh-fang-3.5.0.tgz missing')
if (artifactExists) {
  const actual = crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex').toUpperCase()
  // sidecar format: "<sha256>  <filename>" (shasum-compatible) — compare the hash token only.
  const pinned = fs.existsSync(sidecar) ? (fs.readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0] ?? '').toUpperCase() : ''
  check('artifact sha256 matches sidecar', pinned !== '' && actual === pinned, `${actual.slice(0, 16)}…`)
  const headTime = Number(spawnSync('git', ['-C', REPO, 'log', '-1', '--format=%ct'], { encoding: 'utf8' }).stdout ?? 0) * 1000
  const artifactMtime = fs.statSync(tgz).mtimeMs
  check('artifact built from current HEAD (not stale)', artifactMtime >= headTime, artifactMtime >= headTime ? 'fresh' : 'STALE: rebuild before release')
}

const failed = checks.filter((item) => !item.ok)
const plan = [
  { order: 1, channel: 'npm', package: '@twinsearth/dsh-fang-contract', version: contractVersion, status: contractRegistry.ok && contractRegistry.versions?.includes(contractVersion) ? 'already-published' : 'pending' },
  { order: 2, channel: 'npm', package: '@twinsearth/dsh-fang', version: fangVersion, status: fangRegistry.ok && fangRegistry.versions?.includes(fangVersion) ? 'already-published' : 'pending' },
  { order: 3, channel: 'git tag', ref: `v${fangVersion}`, status: (tagResult.stdout ?? '').trim() ? 'already-tagged' : 'pending' },
  { order: 4, channel: 'GitHub Release', ref: `v${fangVersion}`, assets: [`dsh-fang-${fangVersion}.tgz`, `dsh-fang-${fangVersion}.tgz.sha256`], status: 'pending' },
]

const result = { ok: failed.length === 0, fangVersion, contractVersion, vendorVersion, checks, plan }
if (asJson) {
  console.log(JSON.stringify(result, null, 2))
} else {
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}  ${item.detail}`)
  console.log('\n发布顺序（先 contract 1.2.0，再 dsh-fang 3.5.0）：')
  for (const step of plan) console.log(`  ${step.order}. [${step.channel}] ${step.package ?? step.ref}@${step.version ?? ''}  ${step.status}`)
  console.log(`\n${failed.length ? 'RED' : 'GREEN'}  release-order  ${checks.length - failed.length}/${checks.length}`)
}
process.exit(failed.length ? 2 : 0)
