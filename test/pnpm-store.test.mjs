// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T-pnpm — essence runtime pnpm settings (v3.1.8).
//
// pnpm 11 reads non-auth settings from pnpm-workspace.yaml, not .npmrc, and rejects a
// modules directory whose recorded store/virtual store differ from this project's. The
// runtime profile is cloned from the essence module tree, so without these helpers every
// plugin update/remove in the essence runtime fails with ERR_PNPM_UNEXPECTED_STORE.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { tmpDir } from './helpers.mjs'
import {
  MODULES_MANIFEST_FILE,
  NPMRC_FILE,
  PNPM_WORKSPACE_FILE,
  ensureEssenceRuntimePnpmConfig,
  patchModulesManifest,
  readModulesManifest,
  readNodeLinker,
  upsertNpmrc,
  upsertPnpmWorkspaceSettings,
} from '../src/lib/pnpm-store.mjs'

const STORE = 'C:\\Users\\fangw\\AppData\\Local\\pnpm\\store\\v11'
const MOTHER_VIRTUAL = 'C:\\Users\\fangw\\.dsh\\profiles\\desktop\\node_modules\\.pnpm'

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function writeModules(modulesDir, { storeDir = STORE, virtualStoreDir = MOTHER_VIRTUAL } = {}) {
  writeJson(path.join(modulesDir, MODULES_MANIFEST_FILE), {
    hoistPattern: ['*'],
    included: { dependencies: true, devDependencies: true, optionalDependencies: true },
    layoutVersion: 5,
    publicHoistPattern: [],
    storeDir,
    virtualStoreDir,
    virtualStoreDirMaxLength: 60,
  })
}

test('readModulesManifest: reads store and virtual store, tolerates a missing file', () => {
  const dir = tmpDir()
  try {
    writeModules(dir)
    const manifest = readModulesManifest(dir)
    assert.equal(manifest.storeDir, STORE)
    assert.equal(manifest.virtualStoreDir, MOTHER_VIRTUAL)
    assert.equal(manifest.layoutVersion, 5)
    assert.equal(readModulesManifest(path.join(dir, 'missing')), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('readNodeLinker: reads the owning profile value with a hoisted fallback', () => {
  const dir = tmpDir()
  try {
    fs.writeFileSync(path.join(dir, PNPM_WORKSPACE_FILE), 'nodeLinker: isolated\n')
    assert.equal(readNodeLinker(dir), 'isolated')
    fs.writeFileSync(path.join(dir, PNPM_WORKSPACE_FILE), 'autoInstallPeers: false\n')
    assert.equal(readNodeLinker(dir), 'hoisted')
    assert.equal(readNodeLinker(path.join(dir, 'nope')), 'hoisted')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('upsertPnpmWorkspaceSettings: replaces only the named keys and keeps the rest', () => {
  const dir = tmpDir()
  try {
    const file = path.join(dir, PNPM_WORKSPACE_FILE)
    fs.writeFileSync(file, [
      '# mother settings copied into the profile',
      'packages:',
      '  - .',
      'nodeLinker: isolated',
      'autoInstallPeers: false',
      '',
    ].join('\n'))
    const written = upsertPnpmWorkspaceSettings(file, {
      nodeLinker: 'hoisted',
      storeDir: STORE,
      packageImportMethod: 'copy',
    })
    assert.deepEqual(written, ['nodeLinker', 'storeDir', 'packageImportMethod'])
    const text = fs.readFileSync(file, 'utf8')
    assert.match(text, /# mother settings copied into the profile/)
    assert.match(text, /packages:\n  - \./)
    assert.match(text, /autoInstallPeers: false/)
    assert.equal((text.match(/^nodeLinker:/gm) ?? []).length, 1, 'nodeLinker is replaced, not appended twice')
    assert.match(text, /^nodeLinker: hoisted$/m)
    assert.match(text, new RegExp(`^storeDir: ${STORE.replace(/\\/g, '\\\\')}$`, 'm'))
    assert.match(text, /^packageImportMethod: copy$/m)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('upsertNpmrc: keeps the legacy file in sync for older pnpm/npm', () => {
  const dir = tmpDir()
  try {
    const file = path.join(dir, NPMRC_FILE)
    fs.writeFileSync(file, 'registry=https://registry.npmjs.org/\nstore-dir=D:\\.pnpm-store\\v11\n')
    const written = upsertNpmrc(dir, { storeDir: STORE, packageImportMethod: 'copy' })
    assert.deepEqual(written, ['store-dir', 'package-import-method'])
    const text = fs.readFileSync(file, 'utf8')
    assert.match(text, /^registry=https:\/\/registry\.npmjs\.org\/$/m)
    assert.equal((text.match(/^store-dir=/gm) ?? []).length, 1)
    assert.match(text, new RegExp(`^store-dir=${STORE.replace(/\\/g, '\\\\')}$`, 'm'))
    assert.match(text, /^package-import-method=copy$/m)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('patchModulesManifest: aligns store and virtual store, keeps the rest, idempotent', () => {
  const dir = tmpDir()
  try {
    writeModules(dir)
    const first = patchModulesManifest(dir, { storeDir: STORE, virtualStoreDir: path.join(dir, '.pnpm') })
    assert.equal(first.changed, true)
    const manifest = readModulesManifest(dir)
    assert.equal(manifest.storeDir, STORE)
    assert.equal(manifest.virtualStoreDir, path.join(dir, '.pnpm'))
    assert.equal(manifest.layoutVersion, 5, 'unrelated fields are preserved')
    assert.equal(patchModulesManifest(dir, { storeDir: STORE, virtualStoreDir: path.join(dir, '.pnpm') }).changed, false)
    assert.equal(patchModulesManifest(path.join(dir, 'missing'), { storeDir: STORE, virtualStoreDir: 'x' }).error, 'modules-manifest-missing')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureEssenceRuntimePnpmConfig: pnpm 11 settings + modules manifest for a runtime profile', () => {
  const root = tmpDir()
  try {
    const profileDir = path.join(root, 'profiles', 'essence-runtime')
    const modulesDir = path.join(profileDir, 'node_modules')
    const sourceModulesDir = path.join(root, 'essence', 'merged', 'profile', 'node_modules')
    writeModules(sourceModulesDir)
    writeModules(modulesDir)
    fs.mkdirSync(profileDir, { recursive: true })
    fs.writeFileSync(path.join(profileDir, PNPM_WORKSPACE_FILE), 'autoInstallPeers: false\n')
    fs.writeFileSync(path.join(root, 'mother-pnpm-workspace.yaml'), 'nodeLinker: hoisted\n')

    const report = ensureEssenceRuntimePnpmConfig({
      profileDir,
      modulesDir,
      sourceModulesDir,
      nodeLinker: readNodeLinker(root, 'hoisted'),
    })
    assert.equal(report.ok, true)
    assert.equal(report.storeDir, STORE)
    assert.equal(report.virtualStoreDir, path.join(modulesDir, '.pnpm'))
    assert.equal(report.nodeLinker, 'hoisted')

    const workspace = fs.readFileSync(path.join(profileDir, PNPM_WORKSPACE_FILE), 'utf8')
    assert.match(workspace, /^autoInstallPeers: false$/m)
    // v3.1.11: the runtime disables pnpm's supply-chain observation window; otherwise a
    // just-released own plugin is rejected with ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION.
    assert.match(workspace, /^minimumReleaseAge: 0$/m)
    assert.match(workspace, /^nodeLinker: hoisted$/m)
    assert.match(workspace, new RegExp(`^storeDir: ${STORE.replace(/\\/g, '\\\\')}$`, 'm'))
    assert.match(workspace, /^packageImportMethod: copy$/m)

    const npmrc = fs.readFileSync(path.join(profileDir, NPMRC_FILE), 'utf8')
    assert.match(npmrc, /^store-dir=/m)
    assert.match(npmrc, /^package-import-method=copy$/m)

    const manifest = readModulesManifest(modulesDir)
    assert.equal(manifest.storeDir, STORE)
    assert.equal(manifest.virtualStoreDir, path.join(modulesDir, '.pnpm'), 'the copied mother virtual store is replaced')

    // A second run is stable (one key each, no duplicates).
    const again = ensureEssenceRuntimePnpmConfig({ profileDir, modulesDir, sourceModulesDir, nodeLinker: 'hoisted' })
    assert.equal(again.ok, true)
    const workspace2 = fs.readFileSync(path.join(profileDir, PNPM_WORKSPACE_FILE), 'utf8')
    assert.equal((workspace2.match(/^storeDir:/gm) ?? []).length, 1)
    assert.equal((workspace2.match(/^packageImportMethod:/gm) ?? []).length, 1)
    assert.equal((workspace2.match(/^minimumReleaseAge:/gm) ?? []).length, 1)

    // Missing modules manifest is reported, never guessed.
    const bare = ensureEssenceRuntimePnpmConfig({ profileDir, modulesDir: path.join(root, 'nope'), nodeLinker: 'hoisted' })
    assert.equal(bare.ok, false)
    assert.equal(bare.error, 'modules-manifest-missing')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
