// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T-capture — essence runtime plugin changes travel back into the essence (v3.1.8).
//
// The runtime profile is cloned from the essence merged profile on every open, so plugin
// work done inside the essence runtime is only kept if it is captured (overlay config +
// pnpm dependency graph + the touched module directories) before that replay.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { tmpDir } from './helpers.mjs'
import { exists, isLink } from '../src/kernel/index.mjs'
import { parsePatchEntries, serializePatchEntries } from '../src/lib/essence.mjs'
import {
  captureRuntimeProfileIntoEssence,
  diffPatchEntries,
  mergeOverlayPatchEntries,
  pickProfilePackage,
  planRuntimeModuleChanges,
  stableStringify,
} from '../src/lib/runtime-capture.mjs'

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}

function readJsonOr(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function writePackage(dir, { version, deps, bundles }) {
  writeJson(path.join(dir, 'package.json'), {
    name: 'pkg-' + path.basename(dir),
    version: version ?? '1.0.0',
    ...(deps ? { dependencies: deps } : {}),
  })
  writeText(path.join(dir, 'index.js'), 'export default 1\n')
  void bundles
}

/** Minimal essence manager: overlay files + a materialize-enough recompute. */
function fakeEssenceManager(essenceRoot) {
  const rootOf = (id) => path.join(essenceRoot, id)
  return {
    essenceRoot: rootOf,
    mergedProfileDir: (id) => path.join(rootOf(id), 'merged', 'profile'),
    loadOverlay(root) {
      const overlayRoot = path.join(root, 'overlay')
      const patchText = exists(path.join(overlayRoot, 'cordis.patch.yml')) ? fs.readFileSync(path.join(overlayRoot, 'cordis.patch.yml'), 'utf8') : ''
      return {
        root: overlayRoot,
        patchEntries: parsePatchEntries(patchText).entries,
        packageJson: readJsonOr(path.join(overlayRoot, 'package.json'), {}),
        settings: {},
        credentialsPath: path.join(overlayRoot, 'credentials'),
        parseErrors: [],
      }
    },
    saveOverlay(root, overlay) {
      const overlayRoot = path.join(root, 'overlay')
      fs.mkdirSync(overlayRoot, { recursive: true })
      fs.writeFileSync(path.join(overlayRoot, 'cordis.patch.yml'), serializePatchEntries(overlay.patchEntries ?? []), 'utf8')
      writeJson(path.join(overlayRoot, 'package.json'), overlay.packageJson ?? {})
    },
    recompute(id) {
      const root = rootOf(id)
      const merged = path.join(root, 'merged', 'profile')
      const overlay = this.loadOverlay(root)
      fs.mkdirSync(merged, { recursive: true })
      writeJson(path.join(merged, 'package.json'), overlay.packageJson ?? {})
      fs.writeFileSync(path.join(merged, 'cordis.patch.yml'), serializePatchEntries(overlay.patchEntries ?? []), 'utf8')
      for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']) {
        const source = path.join(root, 'overlay', name)
        if (exists(source)) fs.copyFileSync(source, path.join(merged, name))
      }
      return { status: 'ready' }
    },
  }
}

function makeFixture() {
  const root = tmpDir()
  const essenceRoot = path.join(root, 'essences')
  const id = 'essence-test'
  const essence = path.join(essenceRoot, id)
  const merged = path.join(essence, 'merged', 'profile')
  const essenceModules = path.join(merged, 'node_modules')
  const runtimeHome = path.join(root, 'sessions', id, 'home')
  const runtimeProfile = path.join(runtimeHome, 'profiles', 'essence-runtime')
  const runtimeModules = path.join(runtimeProfile, 'node_modules')

  // Essence before capture: old plugin config + old module tree.
  writeJson(path.join(essence, 'overlay', 'package.json'), {
    name: 'dsh-profile-desktop', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'keep'] } },
    dependencies: { keep: '1.0.0' },
  })
  fs.mkdirSync(path.join(essence, 'overlay'), { recursive: true })
  fs.writeFileSync(path.join(essence, 'overlay', 'cordis.patch.yml'), serializePatchEntries([{ id: 'keep', name: 'keep' }]), 'utf8')
  writeJson(path.join(merged, 'package.json'), {
    name: 'dsh-profile-desktop', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'keep'] } },
    dependencies: { keep: '1.0.0' },
  })
  fs.writeFileSync(path.join(merged, 'cordis.patch.yml'), serializePatchEntries([{ id: 'keep', name: 'keep' }]), 'utf8')
  writePackage(path.join(essenceModules, 'keep'), { version: '1.0.0' })
  writePackage(path.join(essenceModules, 'gone'), { version: '1.0.0' })

  // Runtime after the user updated/installed plugins.
  writeJson(path.join(runtimeProfile, 'package.json'), {
    name: 'dsh-profile-desktop', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'keep', 'newplugin'] } },
    dependencies: { keep: '1.0.0', newplugin: '2.0.0' },
  })
  fs.writeFileSync(path.join(runtimeProfile, 'cordis.patch.yml'), serializePatchEntries([
    { id: 'keep', name: 'keep' },
    { id: 'newplugin', name: 'newplugin', disabled: true },
  ]), 'utf8')
  writeText(path.join(runtimeProfile, 'pnpm-lock.yaml'), 'lockfile v1\n')
  writeText(path.join(runtimeProfile, 'pnpm-workspace.yaml'), 'nodeLinker: hoisted\nstoreDir: C:\\store\n')
  writeText(path.join(runtimeProfile, '.npmrc'), 'store-dir=C:\\store\n')
  writeText(path.join(runtimeModules, '.modules.yaml'), '{}')
  // untouched mirror entry stays a junction; pnpm re-materialized `newplugin` as a real dir
  fs.symlinkSync(path.join(essenceModules, 'keep'), path.join(runtimeModules, 'keep'), 'junction')
  writePackage(path.join(runtimeModules, 'newplugin'), { version: '2.0.0' })
  writeText(path.join(runtimeModules, 'newplugin', 'index.js'), 'export default "new"\n')

  return { root, essenceRoot, id, essence, merged, essenceModules, runtimeProfile, runtimeModules, manager: fakeEssenceManager(essenceRoot) }
}

test('pickProfilePackage keeps only name/private/type/dsh/dependencies', () => {
  assert.deepEqual(pickProfilePackage({ name: 'a', private: true, type: 'module', scripts: { bad: 1 }, devDependencies: { x: '1' }, dsh: { profile: {} }, dependencies: { p: '1' } }), {
    name: 'a', private: true, type: 'module', dsh: { profile: {} }, dependencies: { p: '1' },
  })
  assert.deepEqual(pickProfilePackage({}), {})
})

test('diffPatchEntries reports changed/added entries and removed ids', () => {
  const merged = [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }]
  const runtime = [{ id: 'a', name: 'a' }, { id: 'b', name: 'b', disabled: true }, { id: 'c', name: 'c' }]
  const diff = diffPatchEntries(merged, runtime)
  assert.deepEqual(diff.changed.map((entry) => entry.id), ['b', 'c'])
  assert.deepEqual(diff.removedIds, [])
  assert.deepEqual(diffPatchEntries([{ id: 'x', name: 'x' }], []).removedIds, ['x'])
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }))
})

test('mergeOverlayPatchEntries upserts by id and disables removed ids', () => {
  const merged = [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }]
  const overlay = [{ id: 'a', name: 'a', disabled: true }]
  const out = mergeOverlayPatchEntries(overlay, { changed: [{ id: 'c', name: 'c' }], removedIds: ['b'] }, merged)
  const byId = Object.fromEntries(out.map((entry) => [entry.id, entry]))
  assert.equal(byId.a.disabled, true, 'existing overlay entry is kept')
  assert.equal(byId.c.name, 'c', 'changed entry is added')
  assert.equal(byId.b.disabled, true, 'removed merged id becomes a disabled marker')
})

test('planRuntimeModuleChanges copies touched packages and removes dropped ones', () => {
  const fixture = makeFixture()
  try {
    const plan = planRuntimeModuleChanges(fixture.runtimeModules, fixture.essenceModules)
    assert.deepEqual(plan.copy.map((entry) => entry.rel), ['newplugin'])
    assert.deepEqual(plan.remove, ['gone'])
    assert.deepEqual(plan.untouched, ['keep'], 'a mirror junction is untouched')
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('captureRuntimeProfileIntoEssence persists config, pnpm graph files and modules', () => {
  const fixture = makeFixture()
  try {
    const report = captureRuntimeProfileIntoEssence({
      essenceManager: fixture.manager,
      essenceId: fixture.id,
      runtimeProfileDir: fixture.runtimeProfile,
    })
    assert.equal(report.ok, true)
    assert.equal(report.captured, true)
    assert.equal(report.packageChanged, true)
    assert.equal(report.patchChanged, 1)
    assert.deepEqual(report.modules.copied, ['newplugin'])
    assert.deepEqual(report.modules.removed, ['gone'])

    // overlay: dependencies + bundles persisted; changed patch entry persisted; pnpm files ride along
    const overlayPkg = readJsonOr(path.join(fixture.essence, 'overlay', 'package.json'), {})
    assert.equal(overlayPkg.dependencies.newplugin, '2.0.0')
    assert.deepEqual(overlayPkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'keep', 'newplugin'])
    const overlayPatch = parsePatchEntries(fs.readFileSync(path.join(fixture.essence, 'overlay', 'cordis.patch.yml'), 'utf8')).entries
    assert.equal(overlayPatch.find((entry) => entry.id === 'newplugin')?.disabled, true)
    for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']) {
      assert.equal(exists(path.join(fixture.essence, 'overlay', name)), true, `${name} captured into the overlay`)
    }

    // merged: recomputed from the captured overlay; pnpm files projected; module tree reconciled
    const mergedPkg = readJsonOr(path.join(fixture.merged, 'package.json'), {})
    assert.equal(mergedPkg.dependencies.newplugin, '2.0.0')
    assert.equal(exists(path.join(fixture.merged, 'pnpm-lock.yaml')), true)
    const essenceNew = path.join(fixture.essenceModules, 'newplugin')
    assert.equal(exists(path.join(essenceNew, 'index.js')), true, 'touched package is materialized into the essence tree')
    assert.equal(fs.readFileSync(path.join(essenceNew, 'index.js'), 'utf8'), 'export default "new"\n')
    assert.equal(exists(path.join(fixture.essenceModules, 'gone')), false, 'dropped package removed from the essence tree')
    assert.equal(exists(path.join(fixture.essenceModules, 'keep')), true, 'untouched package stays')
    assert.equal(isLink(path.join(fixture.runtimeModules, 'keep')), true, 'the runtime mirror junction is not modified')

    // second capture is a cheap no-op
    const again = captureRuntimeProfileIntoEssence({
      essenceManager: fixture.manager, essenceId: fixture.id, runtimeProfileDir: fixture.runtimeProfile,
    })
    assert.equal(again.captured, false)
    assert.equal(again.skipped, 'unchanged')
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('captureRuntimeProfileIntoEssence is a no-op without a runtime profile or manager', () => {
  const root = tmpDir()
  try {
    const manager = fakeEssenceManager(path.join(root, 'essences'))
    assert.equal(captureRuntimeProfileIntoEssence({ essenceManager: manager, essenceId: 'essence-x', runtimeProfileDir: path.join(root, 'nope') }).captured, false)
    assert.equal(captureRuntimeProfileIntoEssence({ essenceManager: null, essenceId: 'essence-x', runtimeProfileDir: root }).error, 'essence-manager-unavailable')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
