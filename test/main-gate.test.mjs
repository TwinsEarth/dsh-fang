// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v3.3.0 主城门禁：源码/产物/发布/安装/部署/新建 profile 的 blocker 语义与零残留。
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createGatedProfile,
  runMainGate,
  _internals,
} from '../src/lib/main-gate.mjs'
import { scoreGateFindings } from '../src/plugins/scorer.mjs'

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function temp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)) }
function rm(dir) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } }

function writeProfile(home, name, { bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@twinsearth/dsh-fang'], patch = '[]\n' } = {}) {
  const dir = path.join(home, 'profiles', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `dsh-profile-${name}`, private: true, dsh: { profile: { bundles } } }, null, 2))
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), patch)
  return dir
}

function writeArtifact(root, version = '3.3.0') {
  const dist = path.join(root, 'dist')
  fs.mkdirSync(dist, { recursive: true })
  const tgz = path.join(dist, `dsh-fang-${version}.tgz`)
  fs.writeFileSync(tgz, Buffer.from('fake-tarball-' + version))
  const hash = sha256(fs.readFileSync(tgz))
  fs.writeFileSync(`${tgz}.sha256`, `${hash}  dsh-fang-${version}.tgz\n`)
  const files = [
    'package/package.json', 'package/client.js', 'package/cordis.patch.yml',
    'package/src/index.mjs', 'package/src/lib/boot-guard.mjs',
    'package/src/lib/main-gate.mjs', 'package/src/plugins/restart-guard.mjs',
    'package/tools/gate/main-city.mjs',
  ]
  const manifest = { name: '@twinsearth/dsh-fang', version, tarball: path.basename(tgz), size: fs.statSync(tgz).size, sha256: hash, files }
  fs.writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2))
  fs.mkdirSync(path.join(dist, 'npm', 'package'), { recursive: true })
  for (const rel of ['package.json', 'client.js', 'cordis.patch.yml']) fs.writeFileSync(path.join(dist, 'npm', 'package', rel), rel === 'package.json' ? JSON.stringify({ name: '@twinsearth/dsh-fang', version, private: false, dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } }) : (rel === 'cordis.patch.yml' ? '[]\n' : '// x\n'))
  for (const rel of ['src/index.mjs', 'src/lib/boot-guard.mjs', 'src/lib/main-gate.mjs', 'src/plugins/restart-guard.mjs', 'tools/gate/main-city.mjs']) {
    fs.mkdirSync(path.dirname(path.join(dist, 'npm', 'package', rel)), { recursive: true })
    fs.writeFileSync(path.join(dist, 'npm', 'package', rel), '// x\n')
  }
  return { dist, tgz, manifest, packageDir: path.join(dist, 'npm', 'package') }
}

test('main gate: real source tree passes (A grade)', () => {
  const root = path.resolve(import.meta.dirname, '..')
  const report = runMainGate({ target: 'source', root })
  assert.equal(report.ok, true, JSON.stringify(report.blockers))
  assert.equal(report.score.grade, 'A')
  assert.equal(report.summary.blockers, 0)
})

test('main gate: artifact integrity checks sha, sidecar, forbidden entries and required files', () => {
  const root = temp('fang-gate-artifact-')
  try {
    const art = writeArtifact(root)
    const report = runMainGate({
      target: 'package', root, version: '3.3.0',
      packageDir: art.packageDir, distDir: art.dist, tarball: art.tgz,
    })
    assert.equal(report.ok, true, JSON.stringify(report.blockers))
    // 篡改 tarball 后 sha 必须红
    fs.appendFileSync(art.tgz, 'tampered')
    const bad = runMainGate({ target: 'package', root, version: '3.3.0', packageDir: art.packageDir, distDir: art.dist, tarball: art.tgz })
    assert.equal(bad.ok, false)
    assert.ok(bad.blockers.some((item) => item.id.includes('sha256')))
  } finally { rm(root) }
})

test('main gate: package gate rejects a staged package without bundle/client manifest', () => {
  const root = temp('fang-gate-package-')
  try {
    const art = writeArtifact(root)
    const pkgFile = path.join(art.packageDir, 'package.json')
    fs.writeFileSync(pkgFile, JSON.stringify({ name: '@twinsearth/dsh-fang', version: '3.3.0' }))
    const report = runMainGate({ target: 'package', root, version: '3.3.0', packageDir: art.packageDir, distDir: art.dist, tarball: art.tgz })
    assert.equal(report.ok, false)
    const ids = report.blockers.map((item) => item.id)
    assert.ok(ids.includes('package: client half'))
    assert.ok(ids.includes('package: bundle manifest'))
  } finally { rm(root) }
})

test('main gate: publish blocks a tag/version mismatch and an already published version', () => {
  const root = temp('fang-gate-publish-')
  try {
    const art = writeArtifact(root)
    const mismatch = runMainGate({ target: 'publish', root, version: '3.3.0', packageDir: art.packageDir, distDir: art.dist, tarball: art.tgz, tag: 'v3.2.9' })
    assert.equal(mismatch.ok, false)
    assert.ok(mismatch.blockers.some((item) => item.id === 'publish: tag matches version'))
    const duplicate = runMainGate({ target: 'publish', root, version: '3.3.0', packageDir: art.packageDir, distDir: art.dist, tarball: art.tgz, tag: 'v3.3.0', npmLatest: '3.3.0' })
    assert.equal(duplicate.ok, false)
    assert.ok(duplicate.blockers.some((item) => item.id === 'publish: registry version not already used'))
    const idempotent = runMainGate({ target: 'publish', root, version: '3.3.0', packageDir: art.packageDir, distDir: art.dist, tarball: art.tgz, tag: 'v3.3.0', npmLatest: '3.3.0', allowExisting: true })
    assert.equal(idempotent.ok, true)
  } finally { rm(root) }
})

test('main gate: profile gate rejects path escape, duplicate bundles, unsafe patch and reserved names', () => {
  const home = temp('fang-gate-home-')
  try {
    const dir = writeProfile(home, 'demo')
    const good = runMainGate({ target: 'profile', homeDir: home, profile: 'demo', profileDir: dir })
    assert.equal(good.ok, true, JSON.stringify(good.blockers))
    const dupDir = writeProfile(home, 'dup', { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-base'] })
    const dup = runMainGate({ target: 'profile', homeDir: home, profile: 'dup', profileDir: dupDir })
    assert.equal(dup.ok, false)
    assert.ok(dup.blockers.some((item) => item.id === 'profile: no duplicate bundles'))
    const badPatchDir = writeProfile(home, 'badpatch', { patch: 'a:\n  b: 1\n bad-indent: x\n' })
    const badPatch = runMainGate({ target: 'profile', homeDir: home, profile: 'badpatch', profileDir: badPatchDir })
    assert.equal(badPatch.ok, false)
    assert.ok(badPatch.blockers.some((item) => item.id === 'profile: patch parses'))
    const escape = runMainGate({ target: 'profile', homeDir: home, profile: 'demo', profileDir: path.join(temp('elsewhere-'), 'demo') })
    assert.equal(escape.ok, false)
    assert.ok(escape.blockers.some((item) => item.id === 'profile: inside home/profiles'))
    assert.equal(_internals.isInside(path.join(home, 'profiles'), dir), true)
  } finally { rm(home) }
})

test('main gate: runtime guards block a live host, restart safe-mode and a broken audit chain', () => {
  const home = temp('fang-gate-runtime-')
  try {
    const dir = writeProfile(home, 'demo')
    const dataDir = path.join(home, 'fang', 'demo')
    fs.mkdirSync(path.join(dataDir, 'restart'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'fang.pid'), JSON.stringify({ pid: process.pid, at: Date.now() }))
    fs.writeFileSync(path.join(dataDir, 'restart', 'safe-mode.json'), JSON.stringify({ active: true, reason: 'crash-loop', at: Date.now() }))
    fs.writeFileSync(path.join(dataDir, 'audit.jsonl'), JSON.stringify({ kind: 'x', seq: 0, prevHash: 'GENESIS', hash: 'bad' }) + '\n')
    const report = runMainGate({ target: 'install', homeDir: home, profile: 'demo', profileDir: dir, dataDir })
    assert.equal(report.ok, false)
    const ids = report.blockers.map((item) => item.id)
    assert.ok(ids.includes('runtime: no live host on this profile'))
    assert.ok(ids.includes('runtime: restart safe-mode clear'))
    assert.ok(ids.includes('audit: hash chain verifies'))
  } finally { rm(home) }
})

test('main gate: crash loop circuit breaker blocks deploy even when the PID file is gone', () => {
  const home = temp('fang-gate-crash-')
  try {
    const dir = writeProfile(home, 'demo', { patch: '[]\n' })
    const dataDir = path.join(home, 'fang', 'demo')
    fs.mkdirSync(path.join(dataDir, 'restart'), { recursive: true })
    const now = Date.now()
    fs.writeFileSync(path.join(dataDir, 'restart', 'runtime-crash.jsonl'),
      [now - 3000, now - 2000, now - 1000].map((at) => JSON.stringify({ at, pid: 1, origin: 'uncaughtException', message: 'boom' })).join('\n') + '\n')
    const report = runMainGate({ target: 'deploy', homeDir: home, profile: 'demo', profileDir: dir, dataDir, repair: true })
    // repair 会创建备份，但崩溃循环仍是 blocker
    assert.equal(report.ok, false)
    assert.ok(report.blockers.some((item) => item.id === 'runtime: no active crash loop'))
    assert.ok(fs.existsSync(path.join(dir, '.gate-backups')))
  } finally { rm(home) }
})

test('main gate: createGatedProfile creates a minimal profile and refuses overwrite without force', () => {
  const home = temp('fang-gate-create-')
  try {
    const created = createGatedProfile({ homeDir: home, profile: 'fresh' })
    assert.equal(created.ok, true, JSON.stringify(created))
    const pkg = JSON.parse(fs.readFileSync(path.join(home, 'profiles', 'fresh', 'package.json'), 'utf8'))
    assert.deepEqual(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@twinsearth/dsh-fang'])
    const again = createGatedProfile({ homeDir: home, profile: 'fresh' })
    assert.equal(again.ok, false)
    assert.equal(again.error, 'profile-exists')
    const forced = createGatedProfile({ homeDir: home, profile: 'fresh', force: true })
    assert.equal(forced.ok, true)
    assert.ok(fs.existsSync(path.join(home, 'profiles', 'fresh', '.gate-backups')))
    const reserved = createGatedProfile({ homeDir: home, profile: 'desktop' })
    assert.equal(reserved.ok, false)
    assert.equal(reserved.error, 'profile-name-reserved')
  } finally { rm(home) }
})

test('main gate: scorer converts findings to an A/B admission grade', () => {
  assert.equal(scoreGateFindings([]).grade, 'A')
  assert.equal(scoreGateFindings([{ severity: 'warning' }]).grade, 'B')
  assert.equal(scoreGateFindings([{ severity: 'warning' }, { severity: 'warning' }]).grade, 'B')
  assert.equal(scoreGateFindings([{ severity: 'warning' }, { severity: 'warning' }, { severity: 'warning' }]).grade, 'C')
  assert.equal(scoreGateFindings([{ severity: 'blocker' }]).ok, false)
  assert.equal(scoreGateFindings([{ severity: 'warning' }], { maxGrade: 'A' }).ok, false)
})
