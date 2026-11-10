// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang lib — pnpm settings for the essence runtime profile.
//
// DSH 0.2.2-rc.1 bundles pnpm 11, and pnpm 11 no longer reads non-auth settings
// (`store-dir`, `package-import-method`, …) from a project `.npmrc`: only auth and
// network keys are read from that file, the rest moved to `pnpm-workspace.yaml`
// (camelCase). Fang used to write only `.npmrc`, so every pnpm operation inside an
// essence runtime picked the per-drive default store (`D:\.pnpm-store\v11` on a D:
// project) while the module tree recorded the mother's C: store, and pnpm failed with
//     [ERR_PNPM_UNEXPECTED_STORE] Unexpected store location ...
// Before removing/updating any plugin (v3.1.8 report).
//
// This module writes the settings in the form pnpm 11 actually reads, keeps the legacy
// `.npmrc` for older pnpm/npm, and aligns the modules manifest so pnpm's compatibility
// check accepts the shared module tree: the store must match and the virtual store must
// be this project's own `node_modules/.pnpm` (the copied manifest still named the
// mother's virtual store).
import fs from 'node:fs'
import path from 'node:path'

/** The project settings file pnpm 11 reads (non-auth settings). */
export const PNPM_WORKSPACE_FILE = 'pnpm-workspace.yaml'
/** Legacy npm/pnpm config file; still written for older toolchains. */
export const NPMRC_FILE = '.npmrc'
/** The modules manifest pnpm writes into `node_modules`. */
export const MODULES_MANIFEST_FILE = '.modules.yaml'

function readText(file, fallback = '') {
  try { return fs.readFileSync(file, 'utf8') } catch { return fallback }
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}

/**
 * Read the store + virtual store recorded for a module tree.
 * @param {string} modulesDir `node_modules` directory (its `.modules.yaml` is read).
 * @returns {{storeDir:string, virtualStoreDir:string|null, layoutVersion:number|null, file:string}|null}
 */
export function readModulesManifest(modulesDir) {
  const file = path.join(String(modulesDir ?? ''), MODULES_MANIFEST_FILE)
  const manifest = readJson(file, null)
  if (!manifest || typeof manifest !== 'object') return null
  return {
    storeDir: typeof manifest.storeDir === 'string' ? manifest.storeDir : '',
    virtualStoreDir: typeof manifest.virtualStoreDir === 'string' ? manifest.virtualStoreDir : null,
    layoutVersion: Number.isFinite(manifest.layoutVersion) ? manifest.layoutVersion : null,
    file,
  }
}

/**
 * The linker an existing module tree was laid out with, from the profile that owns it.
 * DSH's desktop profile declares `nodeLinker: hoisted`; a runtime profile cloned from it
 * must keep the same linker or pnpm would want to rebuild the modules directory.
 * @param {string} profileDir Profile directory whose pnpm-workspace.yaml is read.
 * @param {string} [fallback='hoisted'] Value used when the file has no nodeLinker.
 * @returns {string}
 */
export function readNodeLinker(profileDir, fallback = 'hoisted') {
  const text = readText(path.join(String(profileDir ?? ''), PNPM_WORKSPACE_FILE))
  const match = /^nodeLinker:\s*([A-Za-z-]+)\s*$/m.exec(text)
  return match ? match[1] : fallback
}

/**
 * Upsert top-level keys in a pnpm settings YAML file, preserving every other line
 * (settings, comments, order). The values written here are machine paths and simple
 * scalars, so a line-oriented upsert is enough and keeps the file readable.
 * @param {string} file pnpm-workspace.yaml path.
 * @param {Record<string,string>} settings Keys to write (camelCase).
 * @returns {string[]} Keys written.
 */
export function upsertPnpmWorkspaceSettings(file, settings = {}) {
  const entries = Object.entries(settings).filter(([, value]) => typeof value === 'string' && value !== '')
  if (entries.length === 0) return []
  const keys = new Set(entries.map(([key]) => key))
  const original = readText(file)
  const kept = original.split(/\r?\n/).filter((line) => {
    const match = /^([A-Za-z][A-Za-z0-9_]*):/.exec(line)
    return !(match && keys.has(match[1]))
  })
  const trimmed = kept.join('\n').replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '')
  const appended = entries.map(([key, value]) => `${key}: ${value}`).join('\n')
  writeText(file, `${trimmed ? `${trimmed}\n` : ''}${appended}\n`)
  return entries.map(([key]) => key)
}

/**
 * Upsert legacy `.npmrc` keys. pnpm 11 ignores these, but npm and older pnpm honor
 * them and the runtime profile may outlive a DSH downgrade.
 * @param {string} profileDir Profile directory.
 * @param {{storeDir:string, packageImportMethod:string}} options
 * @returns {string[]}
 */
export function upsertNpmrc(profileDir, { storeDir, packageImportMethod = 'copy' } = {}) {
  const file = path.join(String(profileDir ?? ''), NPMRC_FILE)
  const pairs = [
    ['store-dir', storeDir],
    ['package-import-method', packageImportMethod],
  ].filter(([, value]) => typeof value === 'string' && value !== '')
  if (pairs.length === 0) return []
  const written = []
  let text = readText(file)
  for (const [key, value] of pairs) {
    const re = new RegExp(`^${key}=.*$`, 'm')
    if (re.test(text)) text = text.replace(re, `${key}=${value}`)
    else text = `${text && !text.endsWith('\n') ? `${text}\n` : text}${key}=${value}\n`
    written.push(key)
  }
  writeText(file, text.replace(/^\n+/, ''))
  return written
}

/**
 * Align a modules manifest with the store and virtual store pnpm will compute for this
 * project. pnpm's `checkCompatibility` refuses a modules directory whose recorded store
 * differs from the chosen store, or whose recorded `virtualStoreDir` differs from the
 * project's own — the runtime tree was copied from the mother, so it names the mother's
 * virtual store. Both become this project's values; the rest of the manifest is kept.
 * @param {string} modulesDir `node_modules` directory.
 * @param {{storeDir:string, virtualStoreDir:string}} options
 * @returns {{changed:boolean, storeDir?:string, virtualStoreDir?:string, error?:string}}
 */
export function patchModulesManifest(modulesDir, { storeDir, virtualStoreDir } = {}) {
  const manifest = readModulesManifest(modulesDir)
  if (!manifest) return { changed: false, error: 'modules-manifest-missing' }
  if (!storeDir || !virtualStoreDir) return { changed: false, error: 'store-or-virtual-store-missing' }
  const raw = readJson(manifest.file, null)
  if (!raw) return { changed: false, error: 'modules-manifest-unreadable' }
  const sameStore = raw.storeDir === storeDir
  const sameVirtual = raw.virtualStoreDir === virtualStoreDir
  if (sameStore && sameVirtual) return { changed: false, storeDir, virtualStoreDir }
  raw.storeDir = storeDir
  raw.virtualStoreDir = virtualStoreDir
  writeText(manifest.file, `${JSON.stringify(raw, null, 2)}\n`)
  return { changed: true, storeDir, virtualStoreDir }
}

/**
 * Make an essence runtime profile's pnpm operations work off the shared module tree.
 *
 * Writes the settings pnpm 11 reads (`pnpm-workspace.yaml`), refreshes the legacy
 * `.npmrc`, and aligns `node_modules/.modules.yaml` with the store and this project's
 * virtual store. The store location is taken from the module tree's own manifest, so the
 * chosen store always matches what the installed packages were linked from.
 * @param {{profileDir:string, modulesDir:string, sourceModulesDir?:string, nodeLinker?:string}} options
 * @returns {{ok:boolean, storeDir?:string, virtualStoreDir?:string, nodeLinker?:string, settings?:string[], npmrc?:string[], manifest?:object, error?:string}}
 */
export function ensureEssenceRuntimePnpmConfig({ profileDir, modulesDir, sourceModulesDir = '', nodeLinker = 'hoisted' } = {}) {
  const profile = String(profileDir ?? '')
  const modules = String(modulesDir ?? '')
  if (!profile || !modules) return { ok: false, error: 'profile-or-modules-missing' }
  const source = String(sourceModulesDir ?? '') || modules
  const manifest = readModulesManifest(source) ?? readModulesManifest(modules)
  if (!manifest) return { ok: false, error: 'modules-manifest-missing' }
  const storeDir = manifest.storeDir
  if (!storeDir) return { ok: false, error: 'store-dir-unknown' }
  const virtualStoreDir = path.join(modules, '.pnpm')
  const settings = upsertPnpmWorkspaceSettings(path.join(profile, PNPM_WORKSPACE_FILE), {
    nodeLinker,
    storeDir,
    packageImportMethod: 'copy',
  })
  const npmrc = upsertNpmrc(profile, { storeDir, packageImportMethod: 'copy' })
  const patched = patchModulesManifest(modules, { storeDir, virtualStoreDir })
  return {
    ok: patched.error === undefined,
    storeDir,
    virtualStoreDir,
    nodeLinker,
    settings,
    npmrc,
    manifest: patched,
    ...(patched.error === undefined ? {} : { error: patched.error }),
  }
}
