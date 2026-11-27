#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// 三方发布协调检查（只读，版本取自 package.json / contract 仓库）：dsh-fang 与
// @twinsearth/dsh-fang-contract 的 vendored pin 必须一致，发布顺序为先 contract、后 dsh-fang。
// 本工具不发布、不写盘。
//
// 用法：node tools/release/release-order.mjs [--json] [--contract-repo <dir>]
// 退出码：0 = 版本一致性检查全部通过（发布动作可能仍被凭据/审核阻塞）；2 = 一致性不通过。
import crypto from 'node:crypto'
import { PUBLISH_NAME } from './lib.mjs'
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
// Migration 2026-11-21: the contract repo is a local sub-repo at <REPO>/contract (git-ignored),
// so the default stays location-independent; --contract-repo still overrides it.
const CONTRACT_REPO = arg('contract-repo', path.join(REPO, 'contract'))

const checks = []
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: String(detail ?? '') })
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

async function registryVersions(pkg) {
  const url = `https://registry.npmjs.org/${String(pkg).replace('/', '%2f')}`
  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { accept: 'application/json' } })
      if (!response.ok) return { ok: false, status: response.status }
      const body = await response.json()
      return { ok: true, versions: Object.keys(body.versions ?? {}), latest: body['dist-tags']?.latest ?? null }
    } catch (error) {
      lastError = String(error?.message ?? error)
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt))
    }
  }
  return { ok: false, error: lastError }
}

const fangPkg = readJson(path.join(REPO, 'package.json'))
const contractPkg = readJson(path.join(CONTRACT_REPO, 'package.json'))
const vendor = readJson(path.join(REPO, 'src', 'contract', 'VENDOR.json'))
const fangVersion = String(fangPkg?.version ?? '')
const contractVersion = String(contractPkg?.version ?? '')
const vendorVersion = String(vendor?.version ?? '')

check('dsh-fang version (from package.json)', /^\d+\.\d+\.\d+$/.test(fangVersion), fangVersion)
check('contract repo version readable', /^\d+\.\d+\.\d+$/.test(contractVersion), contractVersion)
check('vendored contract matches contract repo version', vendorVersion === contractVersion, `${vendorVersion} vs ${contractVersion}`)

const contractGit = spawnSync('git', ['-C', CONTRACT_REPO, 'status', '--porcelain'], { encoding: 'utf8' })
check('contract repo working tree clean', (contractGit.stdout ?? '').trim() === '', (contractGit.stdout ?? '').trim().split('\n')[0] ?? 'clean')

const [fangRegistry, contractRegistry] = await Promise.all([
  registryVersions(PUBLISH_NAME),
  registryVersions('@twinsearth/dsh-fang-contract'),
])
const warnings = []
const checkRegistryAbsent = (name, registry, version) => {
  if (!registry.ok) {
    warnings.push(`${name}: registry unreachable (${registry.status ?? registry.error}) — cannot verify`)
    check(name, true, `WARN registry unreachable (${registry.status ?? registry.error})`)
    return
  }
  check(name, true, registry.versions?.includes(version) ? `already published (latest=${registry.latest})` : `not published yet (latest=${registry.latest})`)
}
// 发布顺序检查：contract 必须先发布（同步要求）；fang 在 tag 之前不应已发布，但已发布也视为发布进行中（不判红）。
checkRegistryAbsent(`contract ${contractVersion} sync requirement (published before/with v${fangVersion})`, contractRegistry, contractVersion)
checkRegistryAbsent(`${PUBLISH_NAME} ${fangVersion} publish state`, fangRegistry, fangVersion)

const tagResult = spawnSync('git', ['-C', REPO, 'tag', '--list', `v${fangVersion}`], { encoding: 'utf8' })
const tagged = (tagResult.stdout ?? '').trim() !== ''
check(`tag v${fangVersion} state`, true, tagged ? 'already tagged' : 'not tagged yet')
if (tagged) {
  const tagCommit = (spawnSync('git', ['-C', REPO, 'rev-parse', `v${fangVersion}^{commit}`], { encoding: 'utf8' }).stdout ?? '').trim()
  const headCommit = (spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim()
  check('tag points at HEAD (docs committed before tag)', tagCommit !== '' && tagCommit === headCommit, `${tagCommit.slice(0, 8)} vs HEAD ${headCommit.slice(0, 8)}`)
  for (const doc of [`docs/AUDIT-v${fangVersion}.md`, `docs/RELEASE-v${fangVersion}.md`, 'docs/DSH-ARCHITECTURE-MAP.md']) {
    const tagDoc = spawnSync('git', ['-C', REPO, 'show', `v${fangVersion}:${doc}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    let headDoc = null
    try { headDoc = fs.readFileSync(path.join(REPO, doc), 'utf8') } catch { headDoc = null }
    const tagText = String(tagDoc.stdout ?? '').replace(/\r\n/g, '\n')
    const headText = String(headDoc ?? '').replace(/\r\n/g, '\n')
    check(`tag contains current ${doc}`, tagDoc.status === 0 && headDoc !== null && tagText === headText, tagDoc.status === 0 ? (tagText === headText ? 'match' : 'differs from HEAD') : 'missing in tag')
  }
}

const tgz = path.join(REPO, 'dist', `dsh-fang-${fangVersion}.tgz`)
const sidecar = `${tgz}.sha256`
const artifactExists = fs.existsSync(tgz)
check('release artifact exists', artifactExists, artifactExists ? `${Math.round(fs.statSync(tgz).size / 1024)} KiB` : `dist/dsh-fang-${fangVersion}.tgz missing`)
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
  { order: 2, channel: 'npm', package: PUBLISH_NAME, version: fangVersion, status: fangRegistry.ok && fangRegistry.versions?.includes(fangVersion) ? 'already-published' : 'pending' },
  { order: 3, channel: 'git tag', ref: `v${fangVersion}`, status: (tagResult.stdout ?? '').trim() ? 'already-tagged' : 'pending' },
  { order: 4, channel: 'GitHub Release', ref: `v${fangVersion}`, assets: [`dsh-fang-${fangVersion}.tgz`, `dsh-fang-${fangVersion}.tgz.sha256`], status: 'pending' },
]

const result = { ok: failed.length === 0, fangVersion, contractVersion, vendorVersion, warnings, checks, plan }
if (asJson) {
  console.log(JSON.stringify(result, null, 2))
} else {
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}  ${item.detail}`)
  for (const warning of warnings) console.log(`WARN  ${warning}`)
  console.log(`\n发布顺序（先 contract ${contractVersion}，再 dsh-fang ${fangVersion}）：`)
  for (const step of plan) console.log(`  ${step.order}. [${step.channel}] ${step.package ?? step.ref}@${step.version ?? ''}  ${step.status}`)
  console.log(`\n${failed.length ? 'RED' : 'GREEN'}  release-order  ${checks.length - failed.length}/${checks.length}`)
}
process.exit(failed.length ? 2 : 0)
