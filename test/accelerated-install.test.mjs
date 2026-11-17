// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// P0: accelerated core install / resolution (no real npm, no real CLI spawn).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ACCEL_PACKAGE,
  accelNodeModulesRoot,
  acceleratedCoreInfo,
  acceleratedLayout,
  buildInstallCommand,
  checkCliCandidate,
  installAcceleratedCore,
  installedAcceleratedVersion,
  isScriptEntry,
  readAcceleratedState,
  resolveAcceleratedCore,
  writeAcceleratedState,
} from '../src/lib/accelerated-install.mjs'

test('accelNodeModulesRoot: resolves <cli>/node_modules from the @twinsearth/dsh entry', () => {
  const cli = path.resolve(os.tmpdir(), 'accel', 'cli')
  const entry = path.join(cli, 'node_modules', '@twinsearth', 'dsh', 'lib', 'bin.js')
  assert.equal(accelNodeModulesRoot(entry), path.join(cli, 'node_modules'))
  assert.equal(accelNodeModulesRoot(''), '')
  // arbitrary entry shape: falls back to walking up to a node_modules directory
  const plain = path.join(cli, 'node_modules', 'some-pkg', 'bin.js')
  assert.equal(accelNodeModulesRoot(plain), path.join(cli, 'node_modules'))
  assert.equal(accelNodeModulesRoot(path.join(os.tmpdir(), 'nowhere', 'bin.js')), '')
})

function tmp(prefix = 'fang-accel-install-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function fakeInstall(root, version = '3.5.0') {
  const layout = acceleratedLayout(root)
  fs.mkdirSync(path.dirname(layout.cliPath), { recursive: true })
  fs.writeFileSync(layout.packageFile, JSON.stringify({ name: ACCEL_PACKAGE, version }))
  fs.writeFileSync(layout.cliPath, '// fake accelerated cli\n')
  return layout
}

test('layout: install root, state file and JS entry path', () => {
  const layout = acceleratedLayout('C:/fang-home')
  assert.equal(layout.root, path.join('C:/fang-home', 'accel'))
  assert.equal(layout.cliDir, path.join('C:/fang-home', 'accel', 'cli'))
  assert.equal(layout.cliPath, path.join('C:/fang-home', 'accel', 'cli', 'node_modules', '@twinsearth', 'dsh', 'lib', 'bin.js'))
})

test('checkCliCandidate: JS entry accepted, .cmd shim and missing file rejected', () => {
  const root = tmp()
  const layout = fakeInstall(root)
  assert.equal(isScriptEntry(layout.cliPath), true)
  assert.deepEqual(checkCliCandidate(layout.cliPath), { ok: true, cliPath: path.resolve(layout.cliPath) })
  assert.equal(checkCliCandidate(path.join(root, 'dsh.cmd')).ok, false)
  assert.equal(checkCliCandidate(path.join(root, 'dsh.cmd')).reason, 'not-a-js-entry')
  assert.equal(checkCliCandidate(path.join(root, 'nope.js')).reason, 'missing')
})

test('resolveAcceleratedCore: config → env → state → layout, with search trail', () => {
  const root = tmp()
  const missing = resolveAcceleratedCore({ cliPath: '', env: {}, fangHome: root })
  assert.equal(missing.ok, false)
  assert.equal(missing.error, 'accelerated-cli-missing')
  assert.equal(missing.searched.length, 4)
  assert.equal(missing.searched.at(-1).reason, 'missing')

  const layout = fakeInstall(root)
  const byLayout = resolveAcceleratedCore({ cliPath: '', env: {}, fangHome: root })
  assert.equal(byLayout.ok, true)
  assert.equal(byLayout.source, 'layout')
  assert.equal(byLayout.cliPath, path.resolve(layout.cliPath))

  const other = path.join(root, 'other', 'bin.js')
  fs.mkdirSync(path.dirname(other), { recursive: true })
  fs.writeFileSync(other, '// other\n')
  const byConfig = resolveAcceleratedCore({ cliPath: other, env: { FANG_ACCEL_CLI: layout.cliPath }, fangHome: root })
  assert.equal(byConfig.ok, true)
  assert.equal(byConfig.source, 'config')

  const byEnv = resolveAcceleratedCore({ cliPath: '', env: { FANG_ACCEL_CLI: other }, fangHome: root })
  assert.equal(byEnv.ok, true)
  assert.equal(byEnv.source, 'env:FANG_ACCEL_CLI')

  writeAcceleratedState(root, { version: '3.5.0', cliPath: path.resolve(layout.cliPath), installedAt: 'now' })
  const byState = resolveAcceleratedCore({ cliPath: '', env: {}, fangHome: root })
  assert.equal(byState.ok, true)
  assert.equal(byState.source, 'state')
})

test('installAcceleratedCore: reuses a matching install without spawning npm', async () => {
  const root = tmp()
  fakeInstall(root, '3.5.0')
  writeAcceleratedState(root, { version: '3.5.0', cliPath: path.resolve(acceleratedLayout(root).cliPath), installedAt: 'first' })
  let spawned = 0
  const result = await installAcceleratedCore({
    fangHome: root,
    version: '3.5.0',
    spawnImpl: () => { spawned += 1; throw new Error('must not spawn') },
  })
  assert.equal(result.ok, true)
  assert.equal(result.reused, true)
  assert.equal(spawned, 0)
  assert.equal(installedAcceleratedVersion(root), '3.5.0')
  assert.equal(readAcceleratedState(root).version, '3.5.0')
})

test('installAcceleratedCore: reports npm failure and keeps no state', async () => {
  const root = tmp()
  const result = await installAcceleratedCore({
    fangHome: root,
    version: '9.9.9',
    spawnImpl: () => ({
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      once(event, cb) { if (event === 'exit') setTimeout(() => cb(1), 0); return this },
      kill: () => {},
    }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'install-failed')
  assert.equal(readAcceleratedState(root), null)
})

test('installAcceleratedCore: requires fangHome', async () => {
  const result = await installAcceleratedCore({ fangHome: '' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'fang-home-missing')
})

test('buildInstallCommand: pinned spec and prefix', () => {
  const spec = buildInstallCommand({ cliDir: 'C:/fang-home/accel/cli', version: '3.5.0', npmBin: 'npm' })
  assert.equal(spec.command, 'npm')
  assert.equal(spec.spec, '@twinsearth/dsh@3.5.0')
  assert.deepEqual(spec.args, ['install', '--prefix', path.resolve('C:/fang-home/accel/cli'), '--no-audit', '--no-fund', '--loglevel=error', '@twinsearth/dsh@3.5.0'])
})

test('acceleratedCoreInfo: same truth as the resolver, plus install metadata', () => {
  const root = tmp()
  fakeInstall(root, '3.5.0')
  const info = acceleratedCoreInfo({ fangHome: root, env: {} })
  assert.equal(info.installed, true)
  assert.equal(info.version, '3.5.0')
  assert.equal(info.error, null)
  assert.equal(info.layout.root, path.join(root, 'accel'))

  const empty = acceleratedCoreInfo({ fangHome: tmp(), env: {} })
  assert.equal(empty.installed, false)
  assert.equal(empty.error, 'accelerated-cli-missing')
  assert.ok(Array.isArray(empty.searched))
})
