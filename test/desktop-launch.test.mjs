// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T4 — DSH Desktop 真实启动入口：argv 构造 + supervisor 交接 + dry-run 默认。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { describeDesktopLaunch, detectDesktopProfileDir, resolveDesktopLaunch, runBootGuard } from '../src/lib/desktop-launch.mjs'

const repoRoot = path.resolve('.')
const supervisor = path.join(repoRoot, 'tools', 'restart-supervisor.mjs')

test('desktop-launch: auto-detects profile from DSH_HOME / DSH_PROFILE_DIR / --profile', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-profile-detect-'))
  try {
    const desktop = path.join(home, 'profiles', 'desktop')
    const custom = path.join(home, 'profiles', 'custom')
    for (const dir of [desktop, custom]) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'package.json'), '{}\n', 'utf8')
    }
    assert.equal(detectDesktopProfileDir({ env: { DSH_HOME: home } }), desktop)
    assert.equal(detectDesktopProfileDir({ env: { DSH_HOME: home, DSH_PROFILE: 'custom' } }), custom)
    assert.equal(detectDesktopProfileDir({ env: { DSH_HOME: home }, args: ['--profile', 'custom'] }), custom)
    assert.equal(detectDesktopProfileDir({ env: { DSH_PROFILE_DIR: custom, DSH_HOME: home } }), custom)
    assert.equal(detectDesktopProfileDir({ env: { DSH_HOME: path.join(home, 'missing') } }), '')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('desktop-launch: runBootGuard blocks bad fang row and safe-mode disables rows', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-launch-guard-'))
  try {
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'p', private: true }), 'utf8')
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n', 'utf8')
    const pkg = path.join(profile, 'node_modules', '@twinsearth', 'dsh-fang')
    fs.mkdirSync(pkg, { recursive: true })
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
      name: '@twinsearth/dsh-fang', type: 'module',
      exports: { './good': './good.mjs', './bad': './bad.mjs' },
    }), 'utf8')
    fs.writeFileSync(path.join(pkg, 'good.mjs'), 'export const apply = () => {}\n', 'utf8')
    fs.writeFileSync(path.join(pkg, 'bad.mjs'), 'throw new Error("bad-plugin")\n', 'utf8')
    fs.writeFileSync(path.join(pkg, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: fang-good',
      '      name: "@twinsearth/dsh-fang/good"',
      '    - id: fang-bad',
      '      name: "@twinsearth/dsh-fang/bad"',
      '',
    ].join('\n'), 'utf8')

    const blocked = runBootGuard(profile)
    assert.equal(blocked.ok, false)
    assert.equal(blocked.error, 'boot-guard-blocked')
    assert.equal(blocked.blocked.some((finding) => finding.id === 'fang-bad'), true)

    const recovered = runBootGuard(profile, { safeModeOnFailure: true })
    assert.equal(recovered.ok, true)
    assert.equal(recovered.safeModeApplied, true)
    assert.ok(recovered.applied.added >= 2)
    const patch = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /fang-good/)
    assert.match(patch, /fang-bad/)
    assert.match(patch, /disabled/)
  } finally {
    fs.rmSync(profile, { recursive: true, force: true })
  }
})

test('desktop-launch: runBootGuard skips profiles without the fang package', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-launch-guard-empty-'))
  try {
    fs.writeFileSync(path.join(profile, 'package.json'), '{}\n', 'utf8')
    const out = runBootGuard(profile)
    assert.equal(out.ok, true)
    assert.equal(out.skipped, 'fang-package-not-found')
  } finally {
    fs.rmSync(profile, { recursive: true, force: true })
  }
})

test('desktop-launch: runBootGuard safe-modes after an unclean previous boot', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-launch-unclean-'))
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-launch-unclean-data-'))
  try {
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'p', private: true }), 'utf8')
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n', 'utf8')
    const pkg = path.join(profile, 'node_modules', '@twinsearth', 'dsh-fang')
    fs.mkdirSync(pkg, { recursive: true })
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
      name: '@twinsearth/dsh-fang', type: 'module', exports: { './good': './good.mjs' },
    }), 'utf8')
    fs.writeFileSync(path.join(pkg, 'good.mjs'), 'export const apply = () => {}\n', 'utf8')
    fs.writeFileSync(path.join(pkg, 'cordis.patch.yml'), '- insert:\n    - id: fang-good\n      name: "@twinsearth/dsh-fang/good"\n', 'utf8')
    fs.mkdirSync(path.join(dataRoot, 'restart'), { recursive: true })
    fs.writeFileSync(path.join(dataRoot, 'restart', 'boot-state.json'), JSON.stringify({ state: 'booting', pid: 999999, at: Date.now() - 5000 }), 'utf8')

    const blocked = runBootGuard(profile, { dataRoot })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.error, 'unclean-boot')

    const recovered = runBootGuard(profile, { dataRoot, safeModeOnFailure: true })
    assert.equal(recovered.ok, true)
    assert.equal(recovered.reason, 'unclean-boot')
    assert.equal(recovered.safeModeApplied, true)
    assert.match(fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8'), /fang-good/)
  } finally {
    fs.rmSync(profile, { recursive: true, force: true })
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('desktop-launch: builds supervisor argv and defaults to dry-run', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-desktop-launch-'))
  try {
    const plan = resolveDesktopLaunch({ exe: process.execPath, dataRoot, supervisorPath: supervisor })
    assert.equal(plan.ok, true)
    assert.equal(plan.dryRun, true)
    assert.equal(plan.argv.includes('--execute'), false)
    assert.equal(plan.argv[1], supervisor)
    assert.equal(plan.argv[plan.argv.indexOf('--data-root') + 1], path.resolve(dataRoot))
    const sep = plan.argv.indexOf('--')
    assert.ok(sep > 0)
    assert.equal(plan.argv[sep + 1], path.resolve(process.execPath))
    assert.match(describeDesktopLaunch(plan), /^\[dry-run\] /)
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('desktop-launch: --execute is explicit and desktop args stay after --', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-desktop-launch-'))
  try {
    const plan = resolveDesktopLaunch({
      exe: process.execPath, dataRoot, supervisorPath: supervisor, execute: true,
      args: ['--profile', 'desktop', '--flag=with space'],
    })
    assert.equal(plan.ok, true)
    assert.equal(plan.dryRun, false)
    assert.ok(plan.argv.includes('--execute'))
    const sep = plan.argv.indexOf('--')
    assert.deepEqual(plan.argv.slice(sep + 1), [path.resolve(process.execPath), '--profile', 'desktop', '--flag=with space'])
    assert.match(describeDesktopLaunch(plan), /^\[execute\] /)
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('desktop-launch: rejects missing exe/data-root/supervisor', () => {
  assert.equal(resolveDesktopLaunch({}).error, 'desktop-exe-required')
  assert.equal(resolveDesktopLaunch({ exe: path.join(os.tmpdir(), 'no-such-desktop.exe'), dataRoot: os.tmpdir() }).error, 'desktop-exe-missing')
  assert.equal(resolveDesktopLaunch({ exe: process.execPath, dataRoot: '' }).error, 'data-root-required')
  const badSupervisor = path.join(os.tmpdir(), 'no-supervisor.mjs')
  assert.equal(resolveDesktopLaunch({ exe: process.execPath, dataRoot: os.tmpdir(), supervisorPath: badSupervisor }).error, 'supervisor-missing')
})

test('desktop-launch CLI prints dry-run plan without starting the desktop', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-desktop-launch-cli-'))
  try {
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'tools', 'desktop-launch.mjs'),
      '--no-boot-guard',
      '--exe', process.execPath, '--data-root', dataRoot,
    ], { encoding: 'utf8' })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /^\[dry-run\] /)
    assert.match(result.stdout, /restart-supervisor\.mjs/)
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
})
