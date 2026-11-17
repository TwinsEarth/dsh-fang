// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// Accelerated fork profile (P0): a *minimal* profile for a fork that runs on the
// accelerated core (@twinsearth/dsh). The mother/desktop profile is never
// cloned: its bundles are @deepseek-ai/* and its third-party plugins target the
// stock core, so they cannot be reused here.
//
// Composition is intentionally tiny and asserted by tests:
//   @twinsearth/dsh-base → @twinsearth/dsh-web-app → @local/dsh-fang
// plus per-entry junctions for the fang bundle and its two child plugins, and a
// scope-rewritten model overlay for the fork's own DSH_HOME.
import fs from 'node:fs'
import path from 'node:path'

export const ACCEL_BUNDLES = Object.freeze(['@twinsearth/dsh-base', '@twinsearth/dsh-web-app'])
export const FANG_BUNDLE = '@local/dsh-fang'
export const ACCEL_BUNDLES_WITH_FANG = Object.freeze([...ACCEL_BUNDLES, FANG_BUNDLE])
export const FANG_CHILD_PACKAGES = Object.freeze([
  '@twinsearth/dsh-fang-web-entry',
  '@twinsearth/dsh-fang-queue-journal',
])
export const OVERLAY_MARKER = '# dsh-Fang accelerated-fork model overlay (generated; do not edit by hand)'
export const OVERLAY_FILE = 'cordis.patch.yml'

/** @returns {{name:string, private:true, dsh:{profile:{bundles:string[]}}, dependencies:Record<string,string>}} */
export function buildAcceleratedForkProfile({ profileName = 'fang-accelerated', fangRoot = '' } = {}) {
  const deps = {}
  if (fangRoot) deps[FANG_BUNDLE] = `link:${String(fangRoot).replace(/\\/g, '/')}`
  return {
    name: `dsh-profile-${String(profileName).replace(/[^a-z0-9._-]/gi, '-').toLowerCase()}`,
    private: true,
    dsh: { profile: { bundles: [...ACCEL_BUNDLES_WITH_FANG] } },
    dependencies: deps,
  }
}

/** Rewrite the stock package scope to the accelerated core's scope. */
export function rewriteScope(text) {
  return String(text ?? '').replace(/@deepseek-ai\/dsh-/g, '@twinsearth/dsh-')
}

/**
 * Build the home-level model overlay for the accelerated fork.
 * The mother's home patch defines providers with @deepseek-ai/* names; the
 * accelerated core resolves @twinsearth/* names, so the same rows would be
 * skipped ("name mismatch"). Rewriting the scope makes the config apply.
 * @returns {{ok:boolean, text?:string, error?:string, source?:string}}
 */
export function buildModelOverlay({ motherHome = '', readImpl = fs.readFileSync } = {}) {
  const source = path.join(String(motherHome ?? '').trim(), OVERLAY_FILE)
  let text = ''
  try {
    text = String(readImpl(source, 'utf8'))
  } catch {
    return { ok: false, error: 'mother-home-patch-missing', source }
  }
  const rewritten = rewriteScope(text)
  if (!rewritten.trim()) return { ok: false, error: 'mother-home-patch-empty', source }
  return { ok: true, text: `${OVERLAY_MARKER}\n${rewritten.replace(/^\uFEFF/, '')}`, source }
}

function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, file)
}

function makeEntryJunction(target, linkPath) {
  if (!fs.existsSync(target)) return { ok: false, reason: 'target-missing', target }
  try {
    const stat = fs.lstatSync(linkPath, { throwIfNoEntry: false })
    if (stat) return { ok: true, reused: true }
  } catch { /* fall through */ }
  try {
    fs.symlinkSync(target, linkPath, 'junction')
    return { ok: true, created: true }
  } catch (error) {
    return { ok: false, reason: 'junction-failed', detail: String(error?.message ?? error) }
  }
}

/**
 * Materialise the accelerated fork profile and its home overlay.
 * @returns {{ok:boolean, profileDir?:string, bundles?:string[], junctions?:object[], warning?:string[],
 *   overlay?:{ok:boolean, file?:string, error?:string}, error?:string}}
 */
export function writeAcceleratedForkProfile(options = {}) {
  const {
    profileDir = '',
    fangRoot = '',
    homeDir = '',
    motherHome = '',
    profileName = path.basename(String(profileDir || '')),
  } = options
  if (!String(profileDir ?? '').trim()) return { ok: false, error: 'no-profile-dir' }
  if (!String(fangRoot ?? '').trim()) return { ok: false, error: 'no-fang-root' }
  const fangDir = path.resolve(fangRoot)
  if (!fs.existsSync(path.join(fangDir, 'package.json'))) return { ok: false, error: 'fang-package-missing', fangRoot: fangDir }

  fs.mkdirSync(profileDir, { recursive: true })
  const pkg = buildAcceleratedForkProfile({ profileName, fangRoot: fangDir })
  writeFileAtomic(path.join(profileDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  // Empty patch layer; applyForkConfigLock() appends the production locks afterwards.
  writeFileAtomic(path.join(profileDir, OVERLAY_FILE), '[]\n')

  const moduleDir = path.join(profileDir, 'node_modules')
  fs.mkdirSync(path.join(moduleDir, '@local'), { recursive: true })
  fs.mkdirSync(path.join(moduleDir, '@twinsearth'), { recursive: true })
  const junctions = []
  junctions.push({ package: FANG_BUNDLE, ...makeEntryJunction(fangDir, path.join(moduleDir, '@local', 'dsh-fang')) })
  for (const child of FANG_CHILD_PACKAGES) {
    const [scope, name] = child.split('/')
    junctions.push({
      package: child,
      ...makeEntryJunction(path.join(fangDir, 'node_modules', scope, name), path.join(moduleDir, scope, name)),
    })
  }
  const warning = junctions.filter((entry) => entry.ok !== true).map((entry) => `junction-failed:${entry.package}${entry.reason ? `:${entry.reason}` : ''}`)

  let overlay = { ok: false, error: 'overlay-skipped' }
  if (String(homeDir ?? '').trim() && String(motherHome ?? '').trim()) {
    const built = buildModelOverlay({ motherHome })
    if (built.ok) {
      const target = path.join(homeDir, OVERLAY_FILE)
      let existing = ''
      try { existing = String(fs.readFileSync(target, 'utf8')) } catch { existing = '' }
      if (existing && !existing.includes(OVERLAY_MARKER)) {
        overlay = { ok: false, error: 'home-patch-exists-unmanaged', file: target }
      } else {
        writeFileAtomic(target, built.text)
        overlay = { ok: true, file: target, source: built.source }
      }
    } else {
      overlay = { ok: false, error: built.error }
    }
  }
  return { ok: true, profileDir, bundles: [...ACCEL_BUNDLES_WITH_FANG], junctions, warning, overlay }
}

/** Normalise a configured core mode; anything unknown is stock (safe default). */
export function normalizeCoreMode(value) {
  return String(value ?? '').trim() === 'accelerated' ? 'accelerated' : 'stock'
}
