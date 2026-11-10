// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang lib — capture the essence runtime's plugin changes back into the essence.
//
// The essence runtime (`profiles/essence-runtime`) is a config instance: the user opens
// it, installs/updates/removes plugins through the DSH plugin manager, and expects the
// 元宝 to keep those changes. The runtime profile is cloned from the essence `merged`
// profile on every open, so without capture the next open would replay the old config and
// silently drop the work (v3.1.7 known boundary; implemented here in v3.1.8).
//
// What is captured:
//   * `package.json`: dependencies + `dsh.profile.bundles` (+ name/private/type),
//   * `cordis.patch.yml`: entries that differ from the merged profile (enable/disable),
//   * the pnpm dependency-graph files (`pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`),
//   * the touched module directories: packages pnpm re-materialized in the runtime
//     `node_modules` are hardlink-copied into the essence module tree so derived forks see
//     the same plugin set.
//
// Capture is cheap when nothing changed: a signature over package.json + cordis.patch.yml
// + the node_modules manifest mtime is stored in the runtime profile and compared first.
import fs from 'node:fs'
import path from 'node:path'

import { ensureDir, exists, hardlinkTree, readJson, removeTree, writeJsonAtomic } from '../kernel/index.mjs'
import { parsePatchEntries } from './essence.mjs'

/** Files the pnpm dependency graph needs and the runtime may have rewritten. */
export const CAPTURED_AUX_FILES = Object.freeze(['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc'])
/** Marker written inside the runtime profile after a successful capture. */
export const CAPTURE_MARKER_FILE = '.fang-runtime-capture.json'
/** Top-level/scope entries that are pnpm bookkeeping, never package directories. */
const INTERNAL_MODULE_NAMES = new Set(['.pnpm', '.bin', '.modules.yaml', '.ignored', '.pnpm-workspace-state-v1.json'])

function readText(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}

function readPackageJson(profileDir) {
  const value = readJson(path.join(String(profileDir ?? ''), 'package.json'), null)
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/** Stable JSON (sorted object keys) for structural comparisons. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** The profile package fields the essence overlay carries (mirrors EssenceManager.selectProfilePackage). */
export function pickProfilePackage(profilePkg) {
  const picked = {}
  for (const key of ['name', 'private', 'type']) {
    if (profilePkg?.[key] !== undefined) picked[key] = profilePkg[key]
  }
  const dsh = profilePkg?.dsh
  if (dsh && typeof dsh === 'object' && Object.keys(dsh).length > 0) picked.dsh = dsh
  const deps = profilePkg?.dependencies
  if (deps && typeof deps === 'object' && Object.keys(deps).length > 0) picked.dependencies = deps
  return picked
}

/**
 * Patch entries the runtime changed or added relative to the merged profile, plus merged
 * ids the runtime no longer carries (the plugin manager removed the row; a disabled marker
 * keeps the mirror-provided row from coming back).
 * @param {Array<Record<string,unknown>>} mergedEntries
 * @param {Array<Record<string,unknown>>} runtimeEntries
 * @returns {{changed:Array<Record<string,unknown>>, removedIds:string[]}}
 */
export function diffPatchEntries(mergedEntries = [], runtimeEntries = []) {
  const mergedById = new Map((mergedEntries ?? []).map((entry) => [String(entry?.id ?? ''), entry]))
  const runtimeById = new Map((runtimeEntries ?? []).map((entry) => [String(entry?.id ?? ''), entry]))
  const changed = []
  for (const [id, entry] of runtimeById) {
    const previous = mergedById.get(id)
    if (previous === undefined || stableStringify(previous) !== stableStringify(entry)) changed.push(entry)
  }
  const removedIds = [...mergedById.keys()].filter((id) => !runtimeById.has(id))
  return { changed, removedIds }
}

/** Merge captured patch changes into the overlay entry list (by id; keep order stable). */
export function mergeOverlayPatchEntries(overlayEntries = [], { changed = [], removedIds = [] } = {}, mergedEntries = []) {
  const byId = new Map((overlayEntries ?? []).map((entry) => [String(entry?.id ?? ''), entry]))
  const mergedById = new Map((mergedEntries ?? []).map((entry) => [String(entry?.id ?? ''), entry]))
  for (const entry of changed) byId.set(String(entry?.id ?? ''), entry)
  for (const id of removedIds) {
    const previous = byId.get(id) ?? mergedById.get(id)
    byId.set(id, { ...(previous && typeof previous === 'object' ? previous : { id }), disabled: true })
  }
  return [...byId.values()]
}

function isRealDirectory(entryPath) {
  try {
    const stat = fs.lstatSync(entryPath)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function packageVersion(entryDir) {
  return String(readJson(path.join(entryDir, 'package.json'), null)?.version ?? '')
}

/** Module entries under `node_modules`, scope entries expanded; link entries are reported as untouched. */
function listModuleEntries(modulesDir) {
  const entries = []
  let top = []
  try { top = fs.readdirSync(modulesDir, { withFileTypes: true }) } catch { return entries }
  for (const entry of top) {
    const name = entry.name
    if (INTERNAL_MODULE_NAMES.has(name) || name.startsWith('.')) continue
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const absolute = path.join(modulesDir, name)
    if (name.startsWith('@')) {
      // A mirrored scope is a single junction; its children were not touched by pnpm.
      const scopeIsLink = !isRealDirectory(absolute)
      let children = []
      try { children = fs.readdirSync(absolute, { withFileTypes: true }) } catch { children = [] }
      for (const child of children) {
        if (!child.isDirectory() && !child.isSymbolicLink()) continue
        entries.push({ rel: `${name}/${child.name}`, absolute: path.join(absolute, child.name), link: scopeIsLink || child.isSymbolicLink() })
      }
      continue
    }
    entries.push({ rel: name, absolute, link: !isRealDirectory(absolute) })
  }
  return entries
}

/**
 * Decide which runtime module entries must travel into the essence tree.
 * Junction entries are untouched mirror entries (pnpm never rewrote them) and are skipped.
 * Real directories are the packages pnpm re-materialized in the runtime; only those whose
 * version differs from the essence copy (or that the essence does not have) are copied.
 * Entries the runtime no longer carries are removed from the essence tree.
 * @param {string} runtimeModules
 * @param {string} essenceModules
 * @returns {{copy:Array<{rel:string, from:string}>, remove:string[], untouched:string[]}}
 */
export function planRuntimeModuleChanges(runtimeModules, essenceModules) {
  const copy = []
  const remove = []
  const untouched = []
  const runtimeEntries = listModuleEntries(runtimeModules)
  const runtimeByRel = new Map(runtimeEntries.map((entry) => [entry.rel, entry]))
  for (const entry of runtimeEntries) {
    if (entry.link === true || !isRealDirectory(entry.absolute)) { untouched.push(entry.rel); continue }
    const destination = path.join(essenceModules, entry.rel)
    if (!exists(destination)) { copy.push({ rel: entry.rel, from: entry.absolute }); continue }
    const runtimeVersion = packageVersion(entry.absolute)
    const essenceVersion = packageVersion(destination)
    if (runtimeVersion !== essenceVersion) copy.push({ rel: entry.rel, from: entry.absolute })
    else untouched.push(entry.rel)
  }
  const essenceEntries = listModuleEntries(essenceModules)
  for (const entry of essenceEntries) {
    if (!runtimeByRel.has(entry.rel)) remove.push(entry.rel)
  }
  return { copy, remove, untouched }
}

/** Hardlink-copy one planned entry into place, replacing the essence copy atomically enough. */
function materializeModuleEntry(essenceModules, { rel, from }) {
  const destination = path.join(essenceModules, rel)
  const staging = path.join(essenceModules, `.fang-sync-${rel.replace(/[\\/]/g, '_')}`)
  removeTree(staging)
  ensureDir(path.dirname(destination))
  hardlinkTree(from, staging)
  removeTree(destination)
  fs.renameSync(staging, destination)
}

/**
 * Execute a module plan; returns counts plus the entries it could not copy.
 * @param {string} runtimeModules
 * @param {string} essenceModules
 * @param {ReturnType<typeof planRuntimeModuleChanges>} [plan]
 */
export function reconcileRuntimeModules(runtimeModules, essenceModules, plan = planRuntimeModuleChanges(runtimeModules, essenceModules)) {
  const copied = []
  const removed = []
  const failed = []
  for (const entry of plan.copy) {
    try { materializeModuleEntry(essenceModules, entry); copied.push(entry.rel) } catch (error) {
      failed.push({ rel: entry.rel, error: String(error?.message ?? error) })
    }
  }
  for (const rel of plan.remove) {
    try { removeTree(path.join(essenceModules, rel)); removed.push(rel) } catch { /* best effort */ }
  }
  // Drop scopes emptied by the removals.
  let scopes = []
  try { scopes = fs.readdirSync(essenceModules, { withFileTypes: true }).filter((entry) => entry.name.startsWith('@')).map((entry) => entry.name) } catch { scopes = [] }
  for (const scope of scopes) {
    const scopePath = path.join(essenceModules, scope)
    try { if (fs.readdirSync(scopePath).length === 0) removeTree(scopePath) } catch { /* ignore */ }
  }
  return { copied, removed, failed, untouched: plan.untouched }
}

/** Signature of the runtime profile's plugin configuration; cheap no-op detection. */
export function runtimeCaptureSignature(runtimeProfileDir) {
  const packageText = readText(path.join(String(runtimeProfileDir ?? ''), 'package.json'))
  const patchText = readText(path.join(String(runtimeProfileDir ?? ''), 'cordis.patch.yml'))
  let modulesMtime = 0
  try { modulesMtime = fs.statSync(path.join(String(runtimeProfileDir ?? ''), 'node_modules', '.modules.yaml')).mtimeMs } catch { modulesMtime = 0 }
  return `${packageText.length}:${patchText.length}:${modulesMtime}`
}

function readCaptureMarker(runtimeProfileDir) {
  return readJson(path.join(String(runtimeProfileDir ?? ''), CAPTURE_MARKER_FILE), null)
}

function writeCaptureMarker(runtimeProfileDir, marker) {
  try { writeJsonAtomic(path.join(String(runtimeProfileDir ?? ''), CAPTURE_MARKER_FILE), marker) } catch { /* marker is an optimization only */ }
}

/**
 * Capture the runtime profile's plugin work into the essence and recompute its merged
 * profile. Safe to call when nothing changed (signature check) or when the runtime
 * profile does not exist yet (no-op).
 * @param {{essenceManager:object, essenceId:string, runtimeProfileDir:string, logger?:object}} options
 * @returns {{ok:boolean, captured:boolean, packageChanged?:boolean, patchChanged?:number, modules?:object, error?:string, detail?:string}}
 */
export function captureRuntimeProfileIntoEssence({ essenceManager, essenceId, runtimeProfileDir, logger = null } = {}) {
  const id = String(essenceId ?? '').trim()
  const profileDir = String(runtimeProfileDir ?? '').trim()
  if (!essenceManager || typeof essenceManager.loadOverlay !== 'function' || typeof essenceManager.recompute !== 'function') {
    return { ok: false, captured: false, error: 'essence-manager-unavailable' }
  }
  if (!id || !profileDir || !exists(profileDir)) return { ok: true, captured: false, skipped: 'runtime-profile-missing' }
  const runtimePkg = readPackageJson(profileDir)
  if (!runtimePkg) return { ok: true, captured: false, skipped: 'runtime-package-missing' }
  const signature = runtimeCaptureSignature(profileDir)
  const previousMarker = readCaptureMarker(profileDir)
  if (previousMarker?.signature === signature) return { ok: true, captured: false, skipped: 'unchanged' }

  const root = essenceManager.essenceRoot(id)
  const mergedProfile = essenceManager.mergedProfileDir(id)
  const mergedPkg = readPackageJson(mergedProfile) ?? {}
  const runtimePatchText = readText(path.join(profileDir, 'cordis.patch.yml'))
  const mergedPatchText = readText(path.join(mergedProfile, 'cordis.patch.yml'))
  const runtimeEntries = parsePatchEntries(runtimePatchText).entries
  const mergedEntries = parsePatchEntries(mergedPatchText).entries
  const packageChanged = stableStringify(pickProfilePackage(runtimePkg)) !== stableStringify(pickProfilePackage(mergedPkg))
  const { changed, removedIds } = diffPatchEntries(mergedEntries, runtimeEntries)
  const runtimeModules = path.join(profileDir, 'node_modules')
  const essenceModules = path.join(mergedProfile, 'node_modules')
  const modulePlan = planRuntimeModuleChanges(runtimeModules, essenceModules)
  const moduleChanges = modulePlan.copy.length + modulePlan.remove.length
  if (!packageChanged && changed.length === 0 && removedIds.length === 0 && moduleChanges === 0) {
    writeCaptureMarker(profileDir, { at: Date.now(), signature, captured: false })
    return { ok: true, captured: false, skipped: 'no-plugin-changes' }
  }

  // 1) overlay: package.json (deps + bundles + profile metadata) and changed patch entries
  const overlay = essenceManager.loadOverlay(root)
  if (packageChanged) overlay.packageJson = { ...overlay.packageJson, ...pickProfilePackage(runtimePkg) }
  if (changed.length > 0 || removedIds.length > 0) {
    overlay.patchEntries = mergeOverlayPatchEntries(overlay.patchEntries ?? [], { changed, removedIds }, mergedEntries)
  }
  essenceManager.saveOverlay(root, overlay)
  // 2) pnpm dependency graph files ride with the overlay so every rematerialization keeps them
  const overlayRoot = path.join(root, 'overlay')
  for (const name of CAPTURED_AUX_FILES) {
    const source = path.join(profileDir, name)
    if (!exists(source)) continue
    try { fs.copyFileSync(source, path.join(overlayRoot, name)) } catch { /* single file best effort */ }
  }
  // 3) recompute merged (materializeMerged preserves the existing module tree) …
  try {
    essenceManager.recompute(id)
  } catch (error) {
    return { ok: false, captured: false, error: 'recompute-failed', detail: String(error?.message ?? error) }
  }
  // 4) … then hardlink the touched packages into the essence module tree.
  let modules = { copied: [], removed: [], failed: [], untouched: [] }
  try {
    const essenceModulesAfter = path.join(essenceManager.mergedProfileDir(id), 'node_modules')
    modules = reconcileRuntimeModules(runtimeModules, essenceModulesAfter, modulePlan)
  } catch (error) {
    logger?.warn?.(`[fang] runtime capture module sync failed: ${String(error?.message ?? error)}`)
    modules = { copied: [], removed: [], failed: [{ rel: '*', error: String(error?.message ?? error) }], untouched: [] }
  }
  writeCaptureMarker(profileDir, {
    at: Date.now(),
    signature,
    captured: true,
    packageChanged,
    patchChanged: changed.length + removedIds.length,
    modules: { copied: modules.copied.length, removed: modules.removed.length, failed: modules.failed.length },
  })
  return {
    ok: true,
    captured: true,
    packageChanged,
    patchChanged: changed.length + removedIds.length,
    modules,
  }
}
