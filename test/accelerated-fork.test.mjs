// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// P0: accelerated fork profile (minimal composition + scope-rewritten model overlay).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ACCEL_BUNDLES_WITH_FANG,
  ALIAS_STUB_VERSION,
  OVERLAY_MARKER,
  buildAcceleratedForkProfile,
  buildModelOverlay,
  normalizeCoreMode,
  pruneAliasStubs,
  rewriteScope,
  writeAcceleratedForkProfile,
} from '../src/lib/accelerated-fork.mjs'
import { DEFAULT_EXPECTED_ROUTE_COUNT, REQUIRED_ROUTE_PATHS } from '../src/lib/compat.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function tmp(prefix = 'fang-accel-fork-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function fakeFangRoot(name = '@local/dsh-fang') {
  const root = tmp('fang-accel-fangroot-')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version: '0.0.0-test' }))
  fs.writeFileSync(path.join(root, 'client.js'), '// client\n')
  for (const child of ['dsh-fang-web-entry', 'dsh-fang-queue-journal']) {
    const dir = path.join(root, 'node_modules', '@twinsearth', child)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `@twinsearth/${child}` }))
  }
  return root
}

test('composition is exactly base + web-app + fang', () => {
  const profile = buildAcceleratedForkProfile({ profileName: 'fang-accel-x', fangRoot: 'E:/GPT/dsh-fang' })
  assert.deepEqual(profile.dsh.profile.bundles, ['@twinsearth/dsh-base', '@twinsearth/dsh-web-app', '@local/dsh-fang'])
  assert.deepEqual(profile.dsh.profile.bundles, [...ACCEL_BUNDLES_WITH_FANG])
  assert.equal(profile.dependencies['@local/dsh-fang'], 'link:E:/GPT/dsh-fang')
  assert.equal(profile.name, 'dsh-profile-fang-accel-x')
})

test('rewriteScope only rewrites the dsh package scope', () => {
  const text = 'name: "@deepseek-ai/dsh-base"\nother: "@deepseek-ai/not-dsh"\nkeep: "@twinsearth/dsh-web-app"'
  const out = rewriteScope(text)
  assert.match(out, /@twinsearth\/dsh-base/)
  assert.match(out, /@deepseek-ai\/not-dsh/)
  assert.match(out, /@twinsearth\/dsh-web-app/)
})

test('buildModelOverlay: missing mother patch is an explicit error', () => {
  const built = buildModelOverlay({ motherHome: tmp() })
  assert.equal(built.ok, false)
  assert.equal(built.error, 'mother-home-patch-missing')
})

test('buildModelOverlay: rewrites scope and marks the generated file', () => {
  const home = tmp()
  fs.writeFileSync(path.join(home, 'cordis.patch.yml'), '- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n')
  const built = buildModelOverlay({ motherHome: home })
  assert.equal(built.ok, true)
  assert.ok(built.text.startsWith(OVERLAY_MARKER))
  assert.match(built.text, /@twinsearth\/dsh-llm-pi-ai/)
})

test('writeAcceleratedForkProfile: minimal profile + junctions + overlay', () => {
  const root = tmp()
  const fangRoot = fakeFangRoot()
  const motherHome = tmp()
  fs.writeFileSync(path.join(motherHome, 'cordis.patch.yml'), '- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n')
  const profileDir = path.join(root, 'home', 'profiles', 'fang-accel')
  const homeDir = path.join(root, 'home')

  const written = writeAcceleratedForkProfile({ profileDir, fangRoot, homeDir, motherHome, profileName: 'fang-accel' })
  assert.equal(written.ok, true)
  const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  assert.deepEqual(pkg.dsh.profile.bundles, [...ACCEL_BUNDLES_WITH_FANG])
  assert.equal(fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8').trim(), '[]')
  assert.equal(written.overlay.ok, true)
  const overlay = fs.readFileSync(path.join(homeDir, 'cordis.patch.yml'), 'utf8')
  assert.ok(overlay.includes(OVERLAY_MARKER))
  assert.match(overlay, /@twinsearth\/dsh-agent-default-model/)
  assert.equal(written.junctions.length, 3)
  for (const junction of written.junctions) assert.equal(junction.ok, true, JSON.stringify(junction))
})

test('writeAcceleratedForkProfile: published package name gets a resolvable junction (v3.5.9 fork-bundle fix)', () => {
  const root = tmp()
  // 发布构建后的真实包名：build 会把源码常量 @local/dsh-fang 改名，junction 必须跟包名一致。
  const fangRoot = fakeFangRoot('@twinsearth/fang-dsh-plugin')
  const profileDir = path.join(root, 'home', 'profiles', 'fang-accel-pub')
  const written = writeAcceleratedForkProfile({ profileDir, fangRoot, homeDir: path.join(root, 'home'), motherHome: '', profileName: 'fang-accel-pub' })
  assert.equal(written.ok, true)
  const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  assert.deepEqual(pkg.dsh.profile.bundles, ['@twinsearth/dsh-base', '@twinsearth/dsh-web-app', '@twinsearth/fang-dsh-plugin'])
  assert.equal(pkg.dependencies['@twinsearth/fang-dsh-plugin'], `link:${fangRoot.replace(/\\/g, '/')}`)
  const moduleDir = path.join(profileDir, 'node_modules')
  const linked = path.join(moduleDir, '@twinsearth', 'fang-dsh-plugin')
  assert.equal(fs.existsSync(linked), true, 'published bundle must be resolvable in the fork profile')
  assert.equal(fs.lstatSync(linked).isSymbolicLink(), true)
  assert.equal(fs.existsSync(path.join(moduleDir, '@local', 'dsh-fang')), true, 'legacy dev alias stays compatible')
  const packageJunction = written.junctions.find((entry) => entry.package === '@twinsearth/fang-dsh-plugin')
  assert.ok(packageJunction && packageJunction.ok === true, JSON.stringify(written.junctions))
})

test('writeAcceleratedForkProfile: never overwrites an unmanaged home patch', () => {
  const root = tmp()
  const fangRoot = fakeFangRoot()
  const motherHome = tmp()
  fs.writeFileSync(path.join(motherHome, 'cordis.patch.yml'), '- id: x\n  name: "@deepseek-ai/dsh-x"\n')
  const homeDir = path.join(root, 'home')
  fs.mkdirSync(homeDir, { recursive: true })
  fs.writeFileSync(path.join(homeDir, 'cordis.patch.yml'), '# user own patch\n- id: keep\n')
  const written = writeAcceleratedForkProfile({ profileDir: path.join(homeDir, 'profiles', 'p'), fangRoot, homeDir, motherHome })
  assert.equal(written.ok, true)
  assert.equal(written.overlay.ok, false)
  assert.equal(written.overlay.error, 'home-patch-exists-unmanaged')
  assert.match(fs.readFileSync(path.join(homeDir, 'cordis.patch.yml'), 'utf8'), /user own patch/)
})

test('writeAcceleratedForkProfile: missing fang root and profile dir are explicit errors', () => {
  assert.equal(writeAcceleratedForkProfile({ profileDir: '', fangRoot: 'x' }).error, 'no-profile-dir')
  assert.equal(writeAcceleratedForkProfile({ profileDir: tmp(), fangRoot: '' }).error, 'no-fang-root')
  assert.equal(writeAcceleratedForkProfile({ profileDir: tmp(), fangRoot: tmp() }).error, 'fang-package-missing')
})

test('normalizeCoreMode: unknown values fall back to stock', () => {
  assert.equal(normalizeCoreMode('accelerated'), 'accelerated')
  assert.equal(normalizeCoreMode('ACCELERATED'), 'stock')
  assert.equal(normalizeCoreMode(''), 'stock')
  assert.equal(normalizeCoreMode(undefined), 'stock')
})

test('2026-11-22: pruneAliasStubs removes only accelerated alias stubs (stock restore after core switch)', () => {
  const profile = tmp('fang-prune-alias-')
  const scope = path.join(profile, 'node_modules', '@deepseek-ai')
  const stub = path.join(scope, 'dsh-session')
  fs.mkdirSync(stub, { recursive: true })
  fs.writeFileSync(path.join(stub, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session', version: ALIAS_STUB_VERSION }))
  fs.writeFileSync(path.join(stub, 'index.js'), 'export * from "file:///accel/dsh-session.js"\n')
  const real = path.join(scope, 'real-package')
  fs.mkdirSync(real, { recursive: true })
  fs.writeFileSync(path.join(real, 'package.json'), JSON.stringify({ name: '@deepseek-ai/real-package', version: '1.2.3' }))

  const pruned = pruneAliasStubs(profile)
  assert.equal(pruned.ok, true)
  assert.deepEqual(pruned.removed, ['dsh-session'], 'only fang alias stubs are removed')
  assert.equal(fs.existsSync(stub), false)
  assert.equal(fs.existsSync(real), true, 'real @deepseek-ai packages are never touched')

  // After the last stub disappears the empty @deepseek-ai scope dir is removed as well
  // (fresh profile: a real package elsewhere must not be involved).
  const onlyStub = tmp('fang-prune-alias-empty-')
  const onlyScope = path.join(onlyStub, 'node_modules', '@deepseek-ai')
  fs.mkdirSync(path.join(onlyScope, 'dsh-tools'), { recursive: true })
  fs.writeFileSync(path.join(onlyScope, 'dsh-tools', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: ALIAS_STUB_VERSION }))
  const second = pruneAliasStubs(onlyStub)
  assert.equal(second.ok, true)
  assert.deepEqual(second.removed, ['dsh-tools'])
  assert.equal(fs.existsSync(onlyScope), false)
  fs.rmSync(profile, { recursive: true, force: true })
  fs.rmSync(onlyStub, { recursive: true, force: true })
})

test('route contract: fork-core is required and the sidecar routes retired (86 total)', () => {
  assert.equal(DEFAULT_EXPECTED_ROUTE_COUNT, 86)
  assert.ok(REQUIRED_ROUTE_PATHS.includes('/fang/api/fork-core'))
  for (const retired of ['/fang/api/accelerated/status', '/fang/api/accelerated/start', '/fang/api/accelerated/stop']) {
    assert.equal(REQUIRED_ROUTE_PATHS.includes(retired), false)
  }
})

test('source guards: essence is pinned to stock and forker has no silent stock fallback', () => {
  const orchestrator = fs.readFileSync(path.join(REPO, 'src', 'plugins', 'orchestrator.mjs'), 'utf8')
  assert.ok((orchestrator.match(/coreMode: 'stock'/g) ?? []).length >= 2, 'essence provision + spawn pin stock')
  const forkerSource = fs.readFileSync(path.join(REPO, 'src', 'plugins', 'forker.mjs'), 'utf8')
  assert.equal(/cfg\.coreMode === 'accelerated' && cfg\.acceleratedCliPath \?/.test(forkerSource), false, 'old silent fallback removed')
  assert.match(forkerSource, /error: 'accelerated-cli-missing'/)
  // 2026-11-22: a stock spawn must prune accelerated alias stubs BEFORE the child starts,
  // otherwise a failed core-switch makes restore fail with spawn-failed/exited.
  assert.match(forkerSource, /pruneAliasStubs\(rec\.profileDir\)/)
  // 2026-11-22: the client must not auto-archive a failed task just to "restore" it.
  const clientSource = fs.readFileSync(path.join(REPO, 'client.js'), 'utf8')
  assert.equal(clientSource.includes('A stopped (but not archived) fork cannot be restored directly'), false)
  assert.equal(/restored\.body\?\.error === 'not-archived'/.test(clientSource), false)
})
