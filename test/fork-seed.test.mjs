// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T-seed — 派生分身的默认第三方插件种子（v3.1.12）：安装不激活 / 安装并激活。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { tmpDir } from './helpers.mjs'
import { ensureDir, hardlinkTree, writeJsonAtomic } from '../src/kernel/index.mjs'
import {
  DEFAULT_FORK_SEED,
  SEED_MARKER,
  applyForkSeedToProfile,
  forkSeedFingerprint,
  forkSeedProfilePatch,
  mergeSeedModules,
  normalizeForkSeed,
  seedPackageDir,
} from '../src/lib/fork-seed.mjs'

const writeJson = (file, value) => { ensureDir(path.dirname(file)); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8') }
const writeFile = (file, value = 'export default 1\n') => { ensureDir(path.dirname(file)); fs.writeFileSync(file, value, 'utf8') }

test('fork-seed: default lists match the requested plugin sets', () => {
  assert.deepEqual([...DEFAULT_FORK_SEED.install], [
    '@twinsearth/dsh-2xray',
    '@michengai/dsh-agency-agents',
    'dsh-better-sidebar',
    'dsh-context',
    '@liustack/modlens',
    '@liustack/modsearch',
  ])
  assert.deepEqual([...DEFAULT_FORK_SEED.activate], [
    'dshmarket',
    '@twinsearth/dsh-im2a-plugin',
    '@openviking/dsh-memory-plugin',
    '@twinsearth/w2m-dsh-plugin',
  ])
})

test('fork-seed: normalize dedupes, validates names and keeps activate disjoint', () => {
  const seed = normalizeForkSeed({
    enabled: true,
    install: ['alpha', ' alpha ', '../evil', '@scope/pkg', 'alpha'],
    activate: ['beta', 'alpha', 'beta', 'bad/../name'],
  })
  assert.equal(seed.enabled, true)
  assert.deepEqual(seed.install, ['alpha', '@scope/pkg'])
  assert.deepEqual(seed.activate, ['beta', 'alpha'])
  assert.deepEqual(seed.packages, ['alpha', '@scope/pkg', 'beta'])
  assert.equal(forkSeedFingerprint(seed), forkSeedFingerprint({ enabled: true, install: ['@scope/pkg', 'alpha'], activate: ['alpha', 'beta'] }), 'fingerprint ignores order/duplicates')
  assert.notEqual(forkSeedFingerprint(seed), forkSeedFingerprint({ install: ['alpha'], activate: ['beta'] }), 'different lists yield a different cache')
  assert.equal(normalizeForkSeed({ enabled: false }).enabled, false)
})

test('fork-seed: profile patch adds dependencies and only activates the activate list', () => {
  const pkg = { name: 'fork-profile', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@local/dsh-fang'] } } }
  const patched = forkSeedProfilePatch(pkg, { install: ['alpha'], activate: ['beta'] }, { alpha: '1.2.3', beta: '2.0.0' })
  assert.equal(patched.changed, true)
  assert.deepEqual(patched.addedDependencies, ['alpha', 'beta'])
  assert.deepEqual(patched.addedBundles, ['beta'])
  assert.equal(patched.packageJson.dependencies.alpha, '^1.2.3')
  assert.equal(patched.packageJson.dependencies.beta, '^2.0.0')
  assert.deepEqual(patched.packageJson.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@local/dsh-fang', 'beta'])
  const again = forkSeedProfilePatch(patched.packageJson, { install: ['alpha'], activate: ['beta'] }, { alpha: '1.2.3', beta: '2.0.0' })
  assert.equal(again.changed, false, 'second patch is a no-op')
})

test('fork-seed: module merge keeps mother mirror entries and overlays scoped packages', () => {
  const root = tmpDir()
  try {
    const motherScope = path.join(root, 'mother', 'node_modules', '@deepseek-ai')
    writeJson(path.join(motherScope, 'pkg-x', 'package.json'), { name: '@deepseek-ai/pkg-x', version: '9.9.9' })
    const targetModules = path.join(root, 'target', 'node_modules')
    ensureDir(path.join(targetModules, 'keep'))
    writeFile(path.join(targetModules, 'keep', 'index.js'))
    fs.symlinkSync(motherScope, path.join(targetModules, '@deepseek-ai'), 'junction')

    const seedModules = path.join(root, 'seed', 'node_modules')
    writeJson(path.join(seedModules, 'alpha', 'package.json'), { name: 'alpha', version: '1.0.0' })
    writeJson(path.join(seedModules, '@twinsearth', 'plugin-b', 'package.json'), { name: '@twinsearth/plugin-b', version: '2.0.0' })

    const merged = mergeSeedModules(seedModules, targetModules)
    assert.equal(merged.ok, true, JSON.stringify(merged))
    assert.ok(merged.copied.includes('alpha'))
    assert.ok(merged.scopes.includes('@twinsearth'))
    assert.equal(fs.existsSync(path.join(targetModules, 'alpha', 'package.json')), true)
    assert.equal(fs.existsSync(path.join(targetModules, '@twinsearth', 'plugin-b', 'package.json')), true)
    assert.equal(fs.existsSync(path.join(targetModules, '@deepseek-ai', 'pkg-x', 'package.json')), true, 'mother mirror scope preserved')
    assert.equal(fs.existsSync(path.join(targetModules, 'keep', 'index.js')), true, 'unrelated mirror entry untouched')
    assert.equal(fs.existsSync(`${targetModules}${path.sep}@twinsearth.fang-seed-merge`), false, 'staging scope cleaned up')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('fork-seed: apply installs once, patches profile, merges modules, then caches', async () => {
  const root = tmpDir()
  try {
    const profileDir = path.join(root, 'forks', 'task_a', 'profiles', 'web-base')
    const modulesDir = path.join(profileDir, 'node_modules')
    ensureDir(path.join(modulesDir, 'mother-mirror'))
    writeJson(path.join(profileDir, 'package.json'), {
      name: 'fork-profile',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@local/dsh-fang'] } },
    })
    const seedRoot = path.join(root, 'forks', '.plugin-seed')
    let installs = 0
    const install = async ({ seedHome, packages }) => {
      installs += 1
      assert.deepEqual(packages, ['alpha', '@scope/plugin-b'])
      const modules = path.join(seedHome, 'seed', 'node_modules')
      writeJson(path.join(modules, 'alpha', 'package.json'), { name: 'alpha', version: '1.0.0' })
      writeJson(path.join(modules, '@scope', 'plugin-b', 'package.json'), { name: '@scope/plugin-b', version: '2.0.0' })
      return { ok: true }
    }
    const seed = { enabled: true, install: ['alpha'], activate: ['@scope/plugin-b'] }
    const first = await applyForkSeedToProfile({ seed, profileDir, profileModulesDir: modulesDir, seedRoot, cliPath: 'fake-cli', install })
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(installs, 1)
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    assert.equal(pkg.dependencies.alpha, '^1.0.0')
    assert.equal(pkg.dependencies['@scope/plugin-b'], '^2.0.0')
    assert.ok(pkg.dsh.profile.bundles.includes('@scope/plugin-b'))
    assert.equal(fs.existsSync(seedPackageDir(modulesDir, 'alpha')), true, 'seed package merged into fork node_modules')
    assert.equal(fs.existsSync(seedPackageDir(modulesDir, '@scope/plugin-b')), true)
    assert.equal(fs.existsSync(path.join(modulesDir, 'mother-mirror')), true)
    assert.equal(fs.existsSync(path.join(profileDir, SEED_MARKER)), true, 'marker written')
    const second = await applyForkSeedToProfile({ seed, profileDir, profileModulesDir: modulesDir, seedRoot, cliPath: 'fake-cli', install })
    assert.equal(second.cached, true)
    assert.equal(installs, 1, 'cached seed is never installed twice')
    // Every fork spawn replays the clean template over package.json; the cached path
    // must re-apply the seeded dependencies/bundles without installing again.
    writeJson(path.join(profileDir, 'package.json'), {
      name: 'fork-profile',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@local/dsh-fang'] } },
    })
    const third = await applyForkSeedToProfile({ seed, profileDir, profileModulesDir: modulesDir, seedRoot, cliPath: 'fake-cli', install })
    assert.equal(third.cached, true)
    assert.equal(installs, 1)
    const restored = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    assert.equal(restored.dependencies.alpha, '^1.0.0')
    assert.ok(restored.dsh.profile.bundles.includes('@scope/plugin-b'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('fork-seed: disabled seed is a no-op and never installs', async () => {
  const root = tmpDir()
  try {
    const profileDir = path.join(root, 'profile')
    writeJson(path.join(profileDir, 'package.json'), { name: 'p', dsh: { profile: { bundles: [] } } })
    ensureDir(path.join(profileDir, 'node_modules'))
    const result = await applyForkSeedToProfile({
      seed: { enabled: false }, profileDir, seedRoot: path.join(root, 'seed'), cliPath: 'fake',
      install: async () => { throw new Error('must not install') },
    })
    assert.equal(result.ok, true)
    assert.equal(result.skipped, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
