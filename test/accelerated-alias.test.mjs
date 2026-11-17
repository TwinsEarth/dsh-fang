// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// D2 hybrid: synced plugin surface + @deepseek-ai/* -> @twinsearth/* alias stubs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ACCEL_BUNDLES_WITH_FANG,
  buildSyncedAcceleratedProfile,
  scanDeepseekSpecs,
  translateBundles,
  writeAcceleratedForkProfile,
  writeAliasStubs,
} from '../src/lib/accelerated-fork.mjs'

function temp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

/** Minimal accelerated module tree with real ESM entry files. */
function makeAccelTree() {
  const root = path.join(temp('fang-accel-'), 'node_modules')
  const packages = {
    'dsh-base': { exports: { '.': './lib/index.js' } },
    'dsh-web-app': { exports: { '.': './lib/index.js' } },
    'dsh-session': { exports: { '.': './lib/index.js', './surface': './lib/types/surface.js' } },
    'dsh-mcp-client': { exports: { '.': './lib/index.js' } },
    'dsh-tool-bash': { exports: { '.': './lib/index.js' } },
  }
  for (const [name, meta] of Object.entries(packages)) {
    const dir = path.join(root, '@twinsearth', name)
    writeJson(path.join(dir, 'package.json'), { name: `@twinsearth/${name}`, version: '3.5.0', type: 'module', exports: meta.exports })
    writeFile(path.join(dir, 'lib', 'index.js'), `export const impl = '${name}'\n`)
    if (meta.exports['./surface']) writeFile(path.join(dir, 'lib', 'types', 'surface.js'), 'export const surface = true\n')
  }
  return root
}

/** Source (essence) profile with a third-party plugin importing stock-core packages. */
function makeSourceProfile() {
  const dir = temp('fang-essence-')
  writeJson(path.join(dir, 'package.json'), {
    name: 'dsh-profile-desktop',
    dependencies: { 'dsh-context': '1.0.0', '@openviking/dsh-memory-plugin': '1.0.0', '@deepseek-ai/dsh-subagent-codex': '0.2.2-rc.1' },
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-web-app',
          '@deepseek-ai/dsh-experimental-forge-bundle',
          'dsh-context',
          '@openviking/dsh-memory-plugin',
        ],
      },
    },
  })
  writeFile(path.join(dir, 'node_modules', 'dsh-context', 'lib', 'index.js'),
    "import '@deepseek-ai/dsh-session'\nimport '@deepseek-ai/dsh-session/surface'\nimport '@deepseek-ai/dsh-tool-bash'\nimport '@deepseek-ai/dsh-desktop'\nexport const context = true\n")
  writeFile(path.join(dir, 'node_modules', '@openviking', 'dsh-memory-plugin', 'mcp.mjs'),
    "import '@deepseek-ai/dsh-mcp-client'\nexport const memory = true\n")
  writeFile(path.join(dir, 'cordis.patch.yml'), JSON.stringify({ insert: [{ id: 'x', name: '@deepseek-ai/dsh-llm' }] }))
  return dir
}

test('translateBundles: maps official core, reports unsupported official bundles, keeps third-party', () => {
  const accel = makeAccelTree()
  const out = translateBundles(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-experimental-forge-bundle', 'dsh-context'], { accelNodeModules: accel })
  assert.deepEqual(out.bundles, ['@twinsearth/dsh-base', '@twinsearth/dsh-web-app', 'dsh-context'])
  assert.deepEqual(out.mapped.map((m) => m.to), ['@twinsearth/dsh-base', '@twinsearth/dsh-web-app'])
  assert.deepEqual(out.unsupported.map((u) => u.bundle), ['@deepseek-ai/dsh-experimental-forge-bundle'])
})

test('scanDeepseekSpecs: collects import specifiers (incl. subpaths) recursively', () => {
  const source = makeSourceProfile()
  const specs = scanDeepseekSpecs(path.join(source, 'node_modules', 'dsh-context'))
  assert.ok(specs.has('@deepseek-ai/dsh-session'))
  assert.ok(specs.has('@deepseek-ai/dsh-session/surface'))
  assert.ok(specs.has('@deepseek-ai/dsh-tool-bash'))
  assert.ok(specs.has('@deepseek-ai/dsh-desktop'))

  const all = scanDeepseekSpecs(path.join(source, 'node_modules'))
  assert.ok(all.has('@deepseek-ai/dsh-mcp-client'))
})

test('writeAliasStubs: creates re-export stubs with export maps; unsupported leave no stub', () => {
  const accel = makeAccelTree()
  const profileNm = path.join(temp('fang-profile-'), 'node_modules')
  const out = writeAliasStubs({
    profileNodeModules: profileNm,
    accelNodeModules: accel,
    specs: ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session/surface', '@deepseek-ai/dsh-mcp-client', '@deepseek-ai/dsh-desktop'],
  })
  const stubDir = path.join(profileNm, '@deepseek-ai', 'dsh-session')
  const pkg = JSON.parse(fs.readFileSync(path.join(stubDir, 'package.json'), 'utf8'))
  assert.equal(pkg.name, '@deepseek-ai/dsh-session')
  assert.deepEqual(pkg.exports, { '.': './index.js', './surface': './surface.js' })
  assert.match(fs.readFileSync(path.join(stubDir, 'index.js'), 'utf8'), /export \* from "file:\/\//)
  assert.equal(fs.existsSync(path.join(profileNm, '@deepseek-ai', 'dsh-mcp-client', 'index.js')), true)
  assert.equal(fs.existsSync(path.join(profileNm, '@deepseek-ai', 'dsh-desktop')), false)
  assert.deepEqual(out.resolved.map((r) => r.spec).sort(), ['@deepseek-ai/dsh-mcp-client', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session/surface'])
  assert.deepEqual(out.unsupported.map((u) => u.spec), ['@deepseek-ai/dsh-desktop'])
})

test('buildSyncedAcceleratedProfile: translated bundles + wrapped patch + plugin list', () => {
  const accel = makeAccelTree()
  const source = makeSourceProfile()
  const built = buildSyncedAcceleratedProfile({ sourceProfileDir: source, accelNodeModules: accel, profileName: 'p1', fangRoot: 'E:/GPT/dsh-fang' })
  assert.equal(built.ok, true)
  assert.deepEqual(built.bundles.translated, ['@twinsearth/dsh-base', '@twinsearth/dsh-web-app', 'dsh-context', '@openviking/dsh-memory-plugin'])
  assert.deepEqual(built.bundles.unsupported.map((u) => u.bundle), ['@deepseek-ai/dsh-experimental-forge-bundle'])
  assert.deepEqual(built.pluginPackages, ['dsh-context', '@openviking/dsh-memory-plugin'])
  assert.match(built.patchText, /^\[/)
  assert.match(built.patchText, /@twinsearth\/dsh-llm/)
  assert.equal(built.deps['@deepseek-ai/dsh-subagent-codex'], undefined)
  assert.ok(built.deps['@local/dsh-fang'])
})

test('writeAcceleratedForkProfile(synced): copies plugins, writes stubs, reports sync', () => {
  const accel = makeAccelTree()
  const source = makeSourceProfile()
  const home = temp('fang-home-')
  const profileDir = path.join(home, 'profiles', 'web-accel')
  const out = writeAcceleratedForkProfile({
    profileDir,
    fangRoot: 'E:/GPT/dsh-fang',
    homeDir: home,
    motherHome: '',
    profileName: 'web-accel',
    sourceProfileDir: source,
    accelNodeModules: accel,
  })
  assert.equal(out.ok, true)
  const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  assert.deepEqual(pkg.dsh.profile.bundles, ['@twinsearth/dsh-base', '@twinsearth/dsh-web-app', 'dsh-context', '@openviking/dsh-memory-plugin', '@local/dsh-fang'])
  assert.ok(fs.existsSync(path.join(profileDir, 'node_modules', 'dsh-context', 'lib', 'index.js')))
  assert.ok(fs.existsSync(path.join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-session', 'index.js')))
  assert.ok(out.sync)
  assert.deepEqual(out.sync.copiedPlugins.sort(), ['@openviking/dsh-memory-plugin', 'dsh-context'])
  assert.ok(out.sync.alias.resolved.some((r) => r.spec === '@deepseek-ai/dsh-session'))
  assert.ok(out.sync.alias.unsupported.some((u) => u.spec === '@deepseek-ai/dsh-desktop'))
})

test('writeAcceleratedForkProfile: no source profile keeps the minimal composition', () => {
  const home = temp('fang-home-min-')
  const profileDir = path.join(home, 'profiles', 'web-accel-min')
  const out = writeAcceleratedForkProfile({ profileDir, fangRoot: 'E:/GPT/dsh-fang', homeDir: home, motherHome: '', profileName: 'web-accel-min' })
  assert.equal(out.ok, true)
  assert.deepEqual(out.bundles, [...ACCEL_BUNDLES_WITH_FANG])
  assert.equal(out.sync, null)
  assert.equal(fs.existsSync(path.join(profileDir, 'node_modules', '@deepseek-ai')), false)
})
