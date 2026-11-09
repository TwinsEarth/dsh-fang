// SPDX-License-Identifier: AGPL-3.0-or-later
// T4 — boot-guard：bundle 行解析 / 重复 id / 隔离 import 冒烟 / 安全禁用写 profile。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  applyDisabledRows,
  checkBundleRows,
  findFangPackageDir,
  readBundleRows,
  smokePackage,
} from '../src/lib/boot-guard.mjs'

function makeProfile() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-boot-guard-'))
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'p', private: true }), 'utf8')
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n', 'utf8')
  const pkg = path.join(profile, 'node_modules', '@twinsearth', 'dsh-fang')
  fs.mkdirSync(pkg, { recursive: true })
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
    name: '@twinsearth/dsh-fang', version: '0.0.0', type: 'module',
    exports: {
      '.': './index.mjs', './good': './good.mjs', './bad': './bad.mjs', './noapply': './noapply.mjs',
    },
  }), 'utf8')
  fs.writeFileSync(path.join(pkg, 'index.mjs'), 'export const apply = () => {}\n', 'utf8')
  fs.writeFileSync(path.join(pkg, 'good.mjs'), 'export const apply = () => {}\nexport const name = "good"\n', 'utf8')
  fs.writeFileSync(path.join(pkg, 'bad.mjs'), 'throw new Error("boom-on-import")\n', 'utf8')
  fs.writeFileSync(path.join(pkg, 'noapply.mjs'), 'export const nope = 1\n', 'utf8')
  fs.writeFileSync(path.join(pkg, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: fang-good',
    '      name: "@twinsearth/dsh-fang/good"',
    '    - id: fang-bad',
    '      name: "@twinsearth/dsh-fang/bad"',
    '    - id: fang-noapply',
    '      name: "@twinsearth/dsh-fang/noapply"',
    '    - id: fang-good',
    '      name: "@twinsearth/dsh-fang/good"',
    '    - id: fang-web-entry',
    '      name: "@twinsearth/dsh-fang-web-entry"',
    '',
  ].join('\n'), 'utf8')
  return { profile, pkg }
}

test('boot-guard: candidate package smoke for updater gate', () => {
  const { pkg } = makeProfile()
  const root = path.dirname(path.dirname(path.dirname(pkg)))
  try {
    const good = smokePackage(pkg)
    assert.equal(good.ok, true)
    assert.match(good.entry, /index\.mjs$/)

    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-candidate-bad-'))
    try {
      fs.writeFileSync(path.join(badDir, 'package.json'), JSON.stringify({ name: 'bad', main: './bad.mjs' }), 'utf8')
      fs.writeFileSync(path.join(badDir, 'bad.mjs'), 'throw new Error("candidate-boom")\n', 'utf8')
      const bad = smokePackage(badDir)
      assert.equal(bad.ok, false)
      assert.match(String(bad.error), /candidate-boom/)

      const tool = path.resolve('tools/boot-guard.mjs')
      const cli = spawnSync(process.execPath, [tool, '--candidate-dir', badDir, '--json'], { encoding: 'utf8' })
      assert.equal(cli.status, 1)
      assert.equal(JSON.parse(cli.stdout).ok, false)
    } finally {
      fs.rmSync(badDir, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('boot-guard: reads bundle rows and detects duplicate/unresolvable/smoke failures', () => {
  const { profile, pkg } = makeProfile()
  try {
    assert.equal(findFangPackageDir(profile), pkg)
    const parsed = readBundleRows(pkg)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.rows.length, 5)
    const checked = checkBundleRows(parsed.rows, { profileDir: profile, ownPackage: '@twinsearth/dsh-fang' })
    assert.equal(checked.ok, false)
    const codes = new Set(checked.findings.map((finding) => finding.code))
    assert.equal(codes.has('duplicate-id'), true)
    assert.equal(codes.has('module-smoke-failed'), true)
    assert.equal(checked.findings.some((finding) => finding.id === 'fang-bad'), true)
    assert.equal(checked.findings.some((finding) => finding.id === 'fang-noapply'), true)
    // 可选子插件缺失只 warn，不 block
    const external = checked.findings.find((finding) => finding.id === 'fang-web-entry')
    assert.equal(external?.code, 'module-unresolved')
    assert.equal(external?.level, 'warn')
    // good 行本身可加载（重复 id 是另一条 finding）
    assert.equal(checked.findings.some((finding) => finding.id === 'fang-good' && finding.code !== 'duplicate-id'), false)
  } finally {
    fs.rmSync(profile, { recursive: true, force: true })
  }
})

test('boot-guard: applyDisabledRows merges into YAML/JSON profile patch with backup', () => {
  const { profile } = makeProfile()
  try {
    const file = path.join(profile, 'cordis.patch.yml')
    const applied = applyDisabledRows(profile, ['fang-bad', 'fang-noapply'])
    assert.equal(applied.ok, true)
    assert.equal(applied.added, 2)
    const text = fs.readFileSync(file, 'utf8')
    assert.match(text, /fang-bad/)
    const parsedPatch = JSON.parse(text)
    assert.equal(parsedPatch.some((entry) => entry.id === 'fang-bad' && entry.disabled === true), true)
    assert.equal(fs.readdirSync(profile).some((name) => name.startsWith('cordis.patch.yml.bak-')), true)
    // 幂等：第二次不会重复添加
    const again = applyDisabledRows(profile, ['fang-bad'])
    assert.equal(again.added, 0)

    // JSON patch 形态保持 JSON
    fs.writeFileSync(file, JSON.stringify({ insert: [{ id: 'existing' }] }, null, 2) + '\n', 'utf8')
    const jsonApplied = applyDisabledRows(profile, ['fang-bad'])
    assert.equal(jsonApplied.format, 'json')
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(Array.isArray(parsed), true)
    assert.equal(parsed.some((entry) => entry.id === 'fang-bad' && entry.disabled === true), true)
  } finally {
    fs.rmSync(profile, { recursive: true, force: true })
  }
})

test('boot-guard CLI: dry-run fails on bad row; --apply disables it and exits 0', () => {
  const { profile } = makeProfile()
  try {
    const tool = path.resolve('tools/boot-guard.mjs')
    const dry = spawnSync(process.execPath, [tool, '--profile-dir', profile, '--json'], { encoding: 'utf8' })
    assert.equal(dry.status, 1)
    const dryJson = JSON.parse(dry.stdout)
    assert.equal(dryJson.ok, false)
    assert.ok(dryJson.findings.some((finding) => finding.id === 'fang-bad'))

    const applied = spawnSync(process.execPath, [tool, '--profile-dir', profile, '--apply', '--json'], { encoding: 'utf8' })
    assert.equal(applied.status, 0, applied.stderr)
    const appliedJson = JSON.parse(applied.stdout)
    assert.equal(appliedJson.ok, true)
    assert.equal(appliedJson.applied.ok, true)
    assert.match(fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8'), /fang-bad/)

    const safe = spawnSync(process.execPath, [tool, '--profile-dir', profile, '--safe-mode', '--json'], { encoding: 'utf8' })
    assert.equal(safe.status, 0, safe.stderr)
    const safeText = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
    assert.match(safeText, /fang-good/)
    assert.match(safeText, /fang-bad/)
  } finally {
    fs.rmSync(profile, { recursive: true, force: true })
  }
})
