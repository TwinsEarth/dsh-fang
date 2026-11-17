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
import { pathToFileURL } from 'node:url'

export const ACCEL_BUNDLES = Object.freeze(['@twinsearth/dsh-base', '@twinsearth/dsh-web-app'])
export const FANG_BUNDLE = '@local/dsh-fang'
/** npm-installed fang bundle name (aliases @local/dsh-fang in production profiles). */
export const FANG_NPM_BUNDLE = '@twinsearth/dsh-fang'
function isFangBundle(bundle) { return bundle === FANG_BUNDLE || bundle === FANG_NPM_BUNDLE }
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

// ── D2 hybrid: alias/shim layer for third-party plugin compatibility ──────────
// Stock-core plugins import `@deepseek-ai/dsh-*`; the accelerated core ships
// `@twinsearth/dsh-*` with the same module layout. We therefore materialise the
// source profile's plugin surface in the accelerated fork and add alias stubs so
// Node's resolver hands those plugins the accelerated implementation.
export const DEEPSEEK_SCOPE = '@deepseek-ai/'
export const ACCEL_SCOPE = '@twinsearth/'
export const ALIAS_STUB_VERSION = '0.0.0-fang-alias'

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** Does the accelerated module tree ship `@twinsearth/<name>`? */
export function accelHasPackage(accelNodeModules, name) {
  const root = String(accelNodeModules ?? '').trim()
  if (!root) return false
  return fs.existsSync(path.join(root, ...String(name).split('/'), 'package.json'))
}

/**
 * Translate a stock bundle list to accelerated bundles.
 * Official packages without an accelerated equivalent are reported, never silently dropped.
 * @returns {{bundles:string[], mapped:object[], unsupported:object[]}}
 */
export function translateBundles(bundles, { accelNodeModules = '' } = {}) {
  const result = { bundles: [], mapped: [], unsupported: [] }
  const seen = new Set()
  for (const raw of Array.isArray(bundles) ? bundles : []) {
    const bundle = String(raw ?? '').trim()
    if (!bundle || seen.has(bundle)) continue
    if (isFangBundle(bundle)) continue // handled by the fang junctions
    if (bundle.startsWith(DEEPSEEK_SCOPE)) {
      const accel = `${ACCEL_SCOPE}${bundle.slice(DEEPSEEK_SCOPE.length)}`
      if (accelHasPackage(accelNodeModules, accel)) {
        seen.add(bundle)
        result.bundles.push(accel)
        result.mapped.push({ from: bundle, to: accel })
      } else {
        result.unsupported.push({ bundle, reason: 'no-accelerated-equivalent' })
      }
      continue
    }
    seen.add(bundle)
    result.bundles.push(bundle)
  }
  return result
}

/** Recursively collect `@deepseek-ai/dsh-*` import specifiers used by a plugin tree. */
export function scanDeepseekSpecs(dir, out = new Set()) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { scanDeepseekSpecs(full, out); continue }
    if (!/\.(?:mjs|cjs|js|json)$/i.test(entry.name)) continue
    let text = ''
    try { text = fs.readFileSync(full, 'utf8') } catch { continue }
    for (const match of text.matchAll(/@deepseek-ai\/dsh-[a-z0-9-]+(?:\/[a-z0-9\-/]+)?/g)) out.add(match[0])
  }
  return out
}

function accelExportFile(accelNodeModules, spec) {
  const parts = String(spec).split('/')
  const name = parts[1]
  const sub = parts.slice(2).join('/')
  const pkg = readJsonFile(path.join(accelNodeModules, '@twinsearth', name, 'package.json'))
  if (!pkg) return null
  const key = sub ? `./${sub}` : '.'
  const value = pkg.exports?.[key]
  const target = typeof value === 'string' ? value : (value?.default ?? value?.import ?? value?.require)
  if (!target) return null
  const file = path.join(accelNodeModules, '@twinsearth', name, target)
  return fs.existsSync(file) ? file : null
}

/**
 * Write `@deepseek-ai/*` alias stub packages that re-export the accelerated modules.
 * @returns {{resolved:object[], unsupported:object[], stubCount:number}}
 */
export function writeAliasStubs({ profileNodeModules = '', accelNodeModules = '', specs = [] } = {}) {
  const resolved = []
  const unsupported = []
  const byPackage = new Map()
  for (const spec of [...new Set(specs)].sort()) {
    const parts = String(spec).split('/')
    if (parts.length < 2 || !parts[1]) continue
    const name = parts[1]
    const sub = parts.slice(2).join('/')
    const accelFile = accelExportFile(accelNodeModules, spec)
    if (!accelFile) {
      unsupported.push({ spec, reason: accelHasPackage(accelNodeModules, name) ? 'no-export-mapping' : 'no-accelerated-equivalent' })
      continue
    }
    if (!byPackage.has(name)) byPackage.set(name, [])
    byPackage.get(name).push({ spec, sub, accelFile })
  }
  let stubCount = 0
  for (const [name, entries] of byPackage) {
    const stubDir = path.join(profileNodeModules, '@deepseek-ai', name)
    fs.mkdirSync(stubDir, { recursive: true })
    const exportsMap = {}
    for (const entry of entries) {
      const rel = entry.sub ? `${entry.sub.replace(/[\\/]/g, '_')}.js` : 'index.js'
      const file = path.join(stubDir, rel)
      const target = pathToFileURL(entry.accelFile).href
      fs.mkdirSync(path.dirname(file), { recursive: true })
      writeFileAtomic(file,
        `// fang alias stub: ${entry.spec} -> ${ACCEL_SCOPE}${name}${entry.sub ? `/${entry.sub}` : ''}\n` +
        `export * from ${JSON.stringify(target)}\n` +
        `import * as NS from ${JSON.stringify(target)}\n` +
        `export default NS\n`)
      exportsMap[entry.sub ? `./${entry.sub}` : '.'] = `./${rel}`
      stubCount += 1
      resolved.push({ spec: entry.spec, accel: `${ACCEL_SCOPE}${name}${entry.sub ? `/${entry.sub}` : ''}` })
    }
    writeFileAtomic(path.join(stubDir, 'package.json'), `${JSON.stringify({
      name: `${DEEPSEEK_SCOPE}${name}`,
      version: ALIAS_STUB_VERSION,
      private: true,
      type: 'module',
      exports: exportsMap,
    }, null, 2)}\n`)
  }
  return { resolved, unsupported, stubCount }
}

function copyPackageDir(source, target) {
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const src = path.join(source, entry.name)
    const dst = path.join(target, entry.name)
    if (entry.isDirectory()) copyPackageDir(src, dst)
    else fs.copyFileSync(src, dst)
  }
}

/**
 * Build the accelerated profile package + patch for a source (essence/mother) profile,
 * copying third-party plugin packages into the fork profile and linking the rest of
 * the source module tree by junction. Returns metadata for the sync report.
 */
export function buildSyncedAcceleratedProfile({ sourceProfileDir = '', accelNodeModules = '', fangRoot = '', profileName = 'fang-accelerated' } = {}) {
  const source = path.resolve(String(sourceProfileDir ?? '').trim() || '.')
  const sourcePkg = readJsonFile(path.join(source, 'package.json'))
  if (!sourcePkg || !sourcePkg.dsh?.profile) return { ok: false, error: 'source-profile-invalid', source }
  const accel = String(accelNodeModules ?? '').trim()
  if (!accel) return { ok: false, error: 'accel-node-modules-missing' }
  const translated = translateBundles(sourcePkg.dsh.profile.bundles, { accelNodeModules: accel })
  const deps = {}
  for (const [name, version] of Object.entries(sourcePkg.dependencies ?? {})) {
    if (name.startsWith(DEEPSEEK_SCOPE)) continue
    if (isFangBundle(name)) continue
    deps[name] = version
  }
  if (fangRoot) deps[FANG_BUNDLE] = `link:${path.resolve(fangRoot).replace(/\\/g, '/')}`
  const pkg = {
    name: `dsh-profile-${String(profileName).replace(/[^a-z0-9._-]/gi, '-').toLowerCase()}`,
    private: true,
    dsh: { profile: { bundles: [...translated.bundles, ...(fangRoot ? [FANG_BUNDLE] : [])] } },
    dependencies: deps,
  }
  const sourcePatchFile = path.join(source, OVERLAY_FILE)
  let patchText = ''
  try { patchText = String(fs.readFileSync(sourcePatchFile, 'utf8')) } catch { patchText = '' }
  patchText = rewriteScope(patchText).replace(/^\uFEFF/, '')
  if (patchText.trim().startsWith('{')) patchText = `[${patchText}]`
  if (!patchText.trim()) patchText = '[]\n'
  return {
    ok: true,
    package: pkg,
    patchText,
    source,
    bundles: { translated: translated.bundles, mapped: translated.mapped, unsupported: translated.unsupported },
    pluginPackages: translated.bundles.filter((bundle) => !bundle.startsWith(ACCEL_SCOPE) && !isFangBundle(bundle)),
    deps,
  }
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
  const sourceProfileDir = String(options.sourceProfileDir ?? '').trim()
  const accelNodeModules = String(options.accelNodeModules ?? '').trim()
  let synced = null
  if (sourceProfileDir && accelNodeModules) {
    const built = buildSyncedAcceleratedProfile({ sourceProfileDir, accelNodeModules, fangRoot: fangDir, profileName })
    if (built.ok !== true) return { ok: false, error: built.error ?? 'synced-profile-failed', sourceProfileDir }
    synced = built
    writeFileAtomic(path.join(profileDir, 'package.json'), `${JSON.stringify(built.package, null, 2)}\n`)
    writeFileAtomic(path.join(profileDir, OVERLAY_FILE), built.patchText)
  } else {
    const pkg = buildAcceleratedForkProfile({ profileName, fangRoot: fangDir })
    writeFileAtomic(path.join(profileDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
    // Empty patch layer; applyForkConfigLock() appends the production locks afterwards.
    writeFileAtomic(path.join(profileDir, OVERLAY_FILE), '[]\n')
  }

  const moduleDir = path.join(profileDir, 'node_modules')
  fs.mkdirSync(path.join(moduleDir, '@local'), { recursive: true })
  fs.mkdirSync(path.join(moduleDir, '@twinsearth'), { recursive: true })
  let alias = null
  let copiedPlugins = []
  if (synced) {
    const sourceModules = path.join(synced.source, 'node_modules')
    for (const bundle of synced.pluginPackages) {
      const from = path.join(sourceModules, ...bundle.split('/'))
      if (!fs.existsSync(from)) continue
      copyPackageDir(from, path.join(moduleDir, ...bundle.split('/')))
      copiedPlugins.push(bundle)
    }
    // Link the rest of the source module tree by entry junctions (never the whole tree:
    // each plugin must keep resolving through the fork profile, where alias stubs live).
    if (fs.existsSync(sourceModules)) {
      const linkEntry = (rel) => {
        if (rel === '@deepseek-ai' || copiedPlugins.includes(rel)) return
        const dst = path.join(moduleDir, rel)
        if (fs.existsSync(dst)) return
        try { makeEntryJunction(path.join(sourceModules, rel), dst) } catch { /* best effort */ }
      }
      for (const entry of fs.readdirSync(sourceModules, { withFileTypes: true })) {
        if (entry.name === '@deepseek-ai') continue
        if (entry.name.startsWith('@')) {
          try {
            for (const scoped of fs.readdirSync(path.join(sourceModules, entry.name))) linkEntry(path.join(entry.name, scoped))
          } catch { /* ignore */ }
        } else linkEntry(entry.name)
      }
    }
    const specs = new Set()
    for (const plugin of synced.pluginPackages) {
      const pluginDir = path.join(moduleDir, ...plugin.split('/'))
      if (fs.existsSync(pluginDir)) scanDeepseekSpecs(pluginDir, specs)
    }
    alias = writeAliasStubs({ profileNodeModules: moduleDir, accelNodeModules, specs: [...specs] })
  }
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
  const bundles = synced ? [...synced.bundles.translated, FANG_BUNDLE] : [...ACCEL_BUNDLES_WITH_FANG]
  return {
    ok: true,
    profileDir,
    bundles,
    junctions,
    warning,
    overlay,
    sync: synced ? {
      source: synced.source,
      mapped: synced.bundles.mapped,
      unsupportedBundles: synced.bundles.unsupported,
      copiedPlugins,
      alias,
    } : null,
  }
}

/** Normalise a configured core mode; anything unknown is stock (safe default). */
export function normalizeCoreMode(value) {
  return String(value ?? '').trim() === 'accelerated' ? 'accelerated' : 'stock'
}
