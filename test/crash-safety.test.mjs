// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T-crash-safety — 防崩溃门禁自身：源码不变量、打包产物检查、文档/门禁接线。
// 目的：让「瓮城的防崩溃方案」成为可回归的约束，而不是口头约定。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')
const TOOL = path.join(ROOT, 'tools', 'release', 'crash-safety.mjs')

function runTool(args = []) {
  const result = spawnSync(process.execPath, [TOOL, ...args, '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true })
  let report = null
  try { report = JSON.parse(result.stdout) } catch { report = null }
  return { status: result.status, report, stdout: result.stdout, stderr: result.stderr }
}

test('crash-safety: source invariants are green', () => {
  const { status, report } = runTool([])
  assert.equal(status, 0, `tool failed: ${JSON.stringify(report?.checks?.filter((c) => !c.ok) ?? [])}`)
  assert.ok(report, 'tool must emit JSON')
  assert.equal(report.mode, 'source')
  assert.equal(report.ok, true)
  assert.ok(report.checks.length >= 8, `expected >=8 checks, got ${report.checks.length}`)
  const ids = report.checks.map((check) => check.id)
  for (const required of [
    'source: crash-safety files present',
    'source: fail-safe exports resolvable',
    'source: restart-guard gate intact',
    'source: fork supervision wired',
    'source: role fail-closed gate',
    'source: client half load-guarded',
    'docs: WORKFLOW-UI + CRASH-SAFETY',
    'package: guard docs packed',
  ]) assert.ok(ids.includes(required), `missing check: ${required}`)
})

test('crash-safety: packaged artifact must carry the guard files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-crash-safety-'))
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@twinsearth/dsh-fang', version: '0.0.0-test', main: './src/index.mjs' }), 'utf8')
    const { status, report } = runTool(['--package', dir])
    assert.notEqual(status, 0, 'a package without crash-safety files must fail')
    assert.ok(report)
    assert.equal(report.ok, false)
    const staged = report.checks.find((check) => check.id === 'artifact: crash-safety files staged')
    assert.ok(staged, 'staged-files check must exist')
    assert.equal(staged.ok, false)
    assert.match(staged.detail, /client\.js/)
    assert.match(staged.detail, /tools\/boot-guard\.mjs/)
    assert.match(staged.detail, /docs\/CRASH-SAFETY\.md/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('crash-safety: fail-safe libraries expose their APIs', async () => {
  const bootGuard = await import(pathToFileURL(path.join(ROOT, 'src', 'lib', 'boot-guard.mjs')).href)
  for (const key of ['readBundleRows', 'checkBundleRows', 'applyDisabledRows', 'smokePackage', 'readPackageEntry']) {
    assert.equal(typeof bootGuard[key], 'function', `boot-guard.${key}`)
  }
  const supervisor = await import(pathToFileURL(path.join(ROOT, 'src', 'lib', 'fork-supervisor.mjs')).href)
  for (const key of ['computeBackoff', 'planRestart', 'reconcileOrphans', 'writeForkMeta']) {
    assert.equal(typeof supervisor[key], 'function', `fork-supervisor.${key}`)
  }
  const launch = await import(pathToFileURL(path.join(ROOT, 'src', 'lib', 'desktop-launch.mjs')).href)
  for (const key of ['runBootGuard', 'readUncleanBoot']) assert.equal(typeof launch[key], 'function', `desktop-launch.${key}`)
})

test('crash-safety: the gate is wired into tests, packaging, release preflight and the docs', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes('docs/WORKFLOW-UI.md'), 'WORKFLOW-UI must ship in the tarball')
  assert.ok(pkg.files.includes('docs/CRASH-SAFETY.md'), 'CRASH-SAFETY must ship in the tarball')

  const preflight = fs.readFileSync(path.join(ROOT, 'tools', 'release', 'preflight.mjs'), 'utf8')
  assert.match(preflight, /crash-safety/i, 'preflight must run the crash-safety gate')
  const build = fs.readFileSync(path.join(ROOT, 'tools', 'release', 'build.mjs'), 'utf8')
  assert.match(build, /crash-safety/i, 'build must verify the packaged artifact')

  for (const rel of ['docs/WORKFLOW-UI.md', 'docs/CRASH-SAFETY.md']) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    assert.match(text, /发布必须由人类显式授权|人类显式授权/, `${rel} must state the human-approval rule`)
  }
})
