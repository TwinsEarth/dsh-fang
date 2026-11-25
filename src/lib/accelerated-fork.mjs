// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// Accelerated fork profile (P0): a *minimal* profile for a fork that runs on the
// accelerated core (@twinsearth/dsh). The mother/desktop profile is never
// cloned: its bundles are @deepseek-ai/* and its third-party plugins target the
// stock core, so they cannot be reused here.
//
// Composition is intentionally tiny and asserted by tests:
//   @twinsearth/dsh-base → @twinsearth/dsh-web-app → @twinsearth/fang-dsh-plugin
// plus per-entry junctions for the fang bundle and its two child plugins, and a
// scope-rewritten model overlay for the fork's own DSH_HOME.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'

export const ACCEL_BUNDLES = Object.freeze(['@twinsearth/dsh-base', '@twinsearth/dsh-web-app'])
export const FANG_BUNDLE = '@twinsearth/fang-dsh-plugin'
/** npm-installed fang bundle name (aliases @twinsearth/fang-dsh-plugin in production profiles). */
export const FANG_NPM_BUNDLE = '@twinsearth/dsh-fang'
/** Published npm package name of this repo's bundle (post-build name; not renamed by build). */
export const FANG_PUBLISHED_BUNDLE = '@twinsearth/fang-dsh-plugin'
function isFangBundle(bundle) {
  return bundle === FANG_BUNDLE || bundle === FANG_NPM_BUNDLE || bundle === FANG_PUBLISHED_BUNDLE
}
export const ACCEL_BUNDLES_WITH_FANG = Object.freeze([...ACCEL_BUNDLES, FANG_BUNDLE])
export const FANG_CHILD_PACKAGES = Object.freeze([
  '@twinsearth/dsh-fang-web-entry',
  '@twinsearth/dsh-fang-queue-journal',
])
export const OVERLAY_MARKER = '# dsh-Fang accelerated-fork model overlay (generated; do not edit by hand)'
export const OVERLAY_FILE = 'cordis.patch.yml'

/**
 * 2026-11-22：fork profile 里 fang bundle 的**实际包名**以 fangRoot/package.json 为准。
 * 发布构建会把源码里的 `@twinsearth/fang-dsh-plugin` 常量改名成发布名，而 junction 路径若写死
 * `@twinsearth/fang-dsh-plugin` 就会与包名/bundle 行不一致 → 派生时报 fork-bundle-unavailable。
 * 这里统一用包名（开发链 @twinsearth/fang-dsh-plugin / npm 安装 @twinsearth/fang-dsh-plugin）。
 */
export function fangBundleNameOf(fangRoot = '') {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(String(fangRoot ?? '').trim(), 'package.json'), 'utf8'))
    const name = typeof pkg?.name === 'string' ? pkg.name.trim() : ''
    if (/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) return name
  } catch { /* fall back to dev alias */ }
  return FANG_BUNDLE
}

/** @returns {{name:string, private:true, dsh:{profile:{bundles:string[]}}, dependencies:Record<string,string>}} */
export function buildAcceleratedForkProfile({ profileName = 'fang-accelerated', fangRoot = '' } = {}) {
  const deps = {}
  const fangBundle = fangRoot ? fangBundleNameOf(fangRoot) : FANG_BUNDLE
  if (fangRoot) deps[fangBundle] = `link:${String(fangRoot).replace(/\\/g, '/')}`
  return {
    name: `dsh-profile-${String(profileName).replace(/[^a-z0-9._-]/gi, '-').toLowerCase()}`,
    private: true,
    dsh: { profile: { bundles: [...ACCEL_BUNDLES, fangBundle] } },
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

/**
 * Disposition of known `@deepseek-ai/*` specs that have no accelerated equivalent.
 * Established by source attribution (2026-11-17): these are client-half/devDependency
 * declarations, desktop-app string references, or metadata-only peer declarations —
 * NOT host-side runtime imports. See docs/ACCEL-FORK-COMPAT.md §3.5.
 */
export const ALIAS_DISPOSITIONS = Object.freeze({
  '@deepseek-ai/dsh-client-runtime': 'client-half',
  '@deepseek-ai/dsh-client-store': 'client-half',
  '@deepseek-ai/dsh-client-ui-primitives': 'client-half',
  '@deepseek-ai/dsh-desktop': 'desktop-only',
  '@deepseek-ai/dsh-desktop-runtime': 'desktop-only',
  '@deepseek-ai/dsh-invariants': 'dev-metadata',
  '@deepseek-ai/dsh-code-runtime': 'optional-metadata',
  '@deepseek-ai/dsh-tool-lsp': 'string-reference',
})

/** Category for a spec without an accelerated equivalent. */
export function classifyAliasSpec(spec) {
  return ALIAS_DISPOSITIONS[String(spec ?? '')] ?? 'unknown'
}

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
      unsupported.push({ spec, reason: accelHasPackage(accelNodeModules, name) ? 'no-export-mapping' : 'no-accelerated-equivalent', category: classifyAliasSpec(spec) })
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

/**
 * Remove `@deepseek-ai/*` alias stubs written by writeAliasStubs().
 *
 * Why: a fork can switch core (`syncForkCoreMode`). An accelerated fork owns alias stubs
 * that shadow the installation's real `@deepseek-ai/*` packages; switching it back to the
 * stock CLI must delete those stubs, otherwise the stock host imports the accelerated
 * modules (and any subpath the stub never mapped, e.g. `dsh-tool-subagent/model-selection-settings`,
 * fails with ERR_PACKAGE_PATH_NOT_EXPORTED → startup-abort → "spawn-failed/exited" on restore).
 *
 * Only packages whose package.json carries ALIAS_STUB_VERSION are removed; real packages
 * (including a user's own @deepseek-ai deps) are never touched.
 * @returns {{ok:boolean, removed:string[]}}
 */
export function pruneAliasStubs(profileDir) {
  const removed = []
  const profile = String(profileDir ?? '').trim()
  if (!profile) return { ok: false, removed }
  const scopeDir = path.join(profile, 'node_modules', '@deepseek-ai')
  let entries = []
  try { entries = fs.readdirSync(scopeDir, { withFileTypes: true }) } catch { return { ok: true, removed } }
  for (const entry of entries) {
    if (!entry || typeof entry.isDirectory !== 'function' || !entry.isDirectory()) continue
    const pkgDir = path.join(scopeDir, entry.name)
    const pkg = readJsonFile(path.join(pkgDir, 'package.json'))
    if (pkg?.version !== ALIAS_STUB_VERSION) continue
    try {
      fs.rmSync(pkgDir, { recursive: true, force: true })
      removed.push(entry.name)
    } catch { /* best-effort: a locked stub must not abort the start */ }
  }
  if (removed.length > 0) {
    try {
      if (fs.readdirSync(scopeDir).length === 0) fs.rmdirSync(scopeDir)
    } catch { /* ignore */ }
  }
  return { ok: true, removed }
}

/**
 * 2026-11-22: the accelerated core 3.5.0 session-format migration only accepts
 * `subagent/catalog` facts with version 0/1/2. A stock-DSH session imported into an
 * accelerated fork can carry version 3, which makes the fork's session reader fail with
 * `SessionFormatError: subagent/catalog requires a supported versioned catalog fact`.
 *
 * Downgrade version 3+ catalog events to the equivalent version 1/2 fact, frame-preserving:
 * only frames containing such events are re-compressed; every other frame keeps its exact bytes.
 * @returns {{ok:boolean, changedEvents:number, changedFrames:number, backup?:string, error?:string}}
 */
export function downgradeSubagentCatalogLog(logFile, { backup = true, knownEventTypes = null } = {}) {
  const file = String(logFile ?? '').trim()
  if (!file) return { ok: false, changedEvents: 0, changedFrames: 0, error: 'no-log-file' }
  const known = knownEventTypes instanceof Set
    ? knownEventTypes
    : new Set(Array.isArray(knownEventTypes) ? knownEventTypes : [])
  let buf
  try { buf = fs.readFileSync(file) } catch (error) { return { ok: false, changedEvents: 0, changedFrames: 0, error: String(error?.message ?? error) } }
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  for (let i = 0; (i = buf.indexOf(MAGIC, i)) !== -1; i += 4) offsets.push(i)
  if (offsets.length === 0 || offsets[0] !== 0) return { ok: false, changedEvents: 0, changedFrames: 0, error: 'not-frame-log' }
  const frames = []
  let changedFrames = 0
  let changedEvents = 0
  let markedIgnorable = 0
  let strippedFields = 0
  for (let k = 0; k < offsets.length; k++) {
    const raw = buf.subarray(offsets[k], k + 1 < offsets.length ? offsets[k + 1] : buf.length)
    const text = zlib.zstdDecompressSync(raw).toString('utf8')
    const lines = text.split('\n')
    let changed = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim()) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (event?.type === 'subagent/catalog' && event.data && typeof event.data === 'object') {
        const version = Number(event.data.version)
        if (version > 2) {
          const mode = event.data.mode === 'external' ? 'external' : (event.data.mode === 'one-shot' ? 'one-shot' : 'continuable')
          event.data.version = mode === 'external' ? 2 : 1
          event.data.mode = mode
          if (mode === 'continuable' && typeof event.data.label !== 'string') event.data.label = ''
          changed = true
          changedEvents += 1
        }
        // v1/v2 schema is strict: `name` was introduced with v3 and is an unrecognized key
        // for the accelerated core's projection (2026-11-22: unrecognized_keys "name").
        if (event.data.name !== undefined) {
          delete event.data.name
          changed = true
          strippedFields += 1
        }
      }
      // The accelerated core refuses event types it does not know unless the writer marks
      // them ignorable. Stock DSH adds new event types (e.g. team/mode) first; a fork must
      // still be able to read the copied history, so mark only unknown-to-accelerated events.
      const fallbackIgnorable = new Set(['team/mode', 'team/task', 'team/status', 'deliverables/presented'])
      if (fallbackIgnorable.has(event.type) && (known.size === 0 || !known.has(event.type)) && event.ignorable !== true) {
        event.ignorable = true
        changed = true
        markedIgnorable += 1
      }
      if (changed) lines[i] = JSON.stringify(event)
    }
    if (!changed) { frames.push(raw); continue }
    frames.push(zlib.zstdCompressSync(Buffer.from(lines.join('\n'), 'utf8')))
    changedFrames += 1
  }
  if (changedEvents === 0 && markedIgnorable === 0 && strippedFields === 0) return { ok: true, changedEvents: 0, changedFrames: 0, markedIgnorable: 0, strippedFields: 0 }
  const backupFile = backup ? `${file}.bak-catalogv3-${Date.now()}` : ''
  if (backup) fs.copyFileSync(file, backupFile)
  const tmp = `${file}.tmp-catalogv3-${process.pid}`
  fs.writeFileSync(tmp, Buffer.concat(frames))
  // Verify: still decodable and header frame unchanged; abandon on any mismatch.
  try {
    const verify = fs.readFileSync(tmp)
    const voffs = []
    for (let i = 0; (i = verify.indexOf(MAGIC, i)) !== -1; i += 4) voffs.push(i)
    const header = zlib.zstdDecompressSync(verify.subarray(voffs[0], voffs[1] ?? verify.length)).toString('utf8')
    const originalHeader = zlib.zstdDecompressSync(buf.subarray(offsets[0], offsets[1] ?? buf.length)).toString('utf8')
    if (header !== originalHeader) throw new Error('header-frame-changed')
    for (let k = 0; k < voffs.length; k++) {
      zlib.zstdDecompressSync(verify.subarray(voffs[k], k + 1 < voffs.length ? voffs[k + 1] : verify.length))
    }
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    return { ok: false, changedEvents: 0, changedFrames: 0, error: String(error?.message ?? error) }
  }
  fs.renameSync(tmp, file)
  return { ok: true, changedEvents, changedFrames, markedIgnorable, strippedFields, ...(backupFile ? { backup: backupFile } : {}) }
}

/**
 * Resolve the accelerated core's supported event vocabulary from its installed
 * `@twinsearth/dsh-session` package (dynamic import, cached by Node).
 * @returns {Promise<Set<string>|null>}
 */
export async function loadAcceleratedKnownEventTypes(accelNodeModules) {
  const root = String(accelNodeModules ?? '').trim()
  if (!root) return null
  const file = path.join(root, '@twinsearth', 'dsh-session', 'lib', 'index.js')
  if (!fs.existsSync(file)) return null
  try {
    const mod = await import(pathToFileURL(file).href)
    const value = mod?.KNOWN_SESSION_EVENT_TYPES
    if (value instanceof Set) return value
    if (Array.isArray(value)) return new Set(value)
  } catch { /* accelerated core unavailable: caller falls back to catalog-only compat */ }
  return null
}

/**
 * Walk a fork's own `$DSH_HOME/sessions` and downgrade legacy catalog facts so an
 * accelerated core can read sessions imported from a stock mother.
 */
export function sanitizeAcceleratedForkSessions(homeDir, options = {}) {
  const root = path.join(String(homeDir ?? '').trim(), 'sessions')
  const result = { ok: true, files: [], changedEvents: 0, changedFrames: 0 }
  let workspaces = []
  try { workspaces = fs.readdirSync(root, { withFileTypes: true }) } catch { return result }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    let sessions = []
    try { sessions = fs.readdirSync(path.join(root, workspace.name), { withFileTypes: true }) } catch { continue }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const logFile = path.join(root, workspace.name, session.name, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(logFile)) continue
      const downgraded = downgradeSubagentCatalogLog(logFile, options)
      if (downgraded.changedEvents > 0 || downgraded.markedIgnorable > 0 || downgraded.strippedFields > 0) {
        result.files.push({ sessionId: session.name, workspace: workspace.name, ...downgraded })
        result.changedEvents += downgraded.changedEvents
        result.changedFrames += downgraded.changedFrames
      } else if (downgraded.ok === false) {
        result.ok = false
        result.files.push({ sessionId: session.name, workspace: workspace.name, ok: false, error: downgraded.error })
      }
    }
  }
  return result
}

/**
 * Client halves resolved by the accelerated web shell as *static* modules (the shell's
 * `staticModules` table), not as `@twinsearth` packages. Kept explicit: the accelerated
 * client bundles require these exact names, so a third-party bundle rewritten to them works
 * without an extra client row.
 */
export const STATIC_CLIENT_MODULES = Object.freeze([
  '@twinsearth/dsh-client-ui-primitives',
  '@twinsearth/dsh-client-store',
  '@twinsearth/dsh-client-ui-slots',
  '@twinsearth/dsh-client-ui-dockkit',
])

/** Every browser-module id the accelerated fork can satisfy for a client half. */
export function availableClientModules(accelNodeModules) {
  const available = new Set(STATIC_CLIENT_MODULES)
  try {
    const scopeDir = path.join(accelNodeModules, ACCEL_SCOPE.slice(0, -1))
    for (const entry of fs.readdirSync(scopeDir)) {
      const dir = path.join(scopeDir, entry)
      let pkg = null
      try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) } catch { pkg = null }
      const hasClient = (pkg?.dsh?.client && typeof pkg.dsh.client === 'object')
        || Boolean(pkg?.exports?.['./client'])
        || fs.existsSync(path.join(dir, 'lib', 'client.js'))
      if (hasClient) available.add(`${ACCEL_SCOPE}${entry}`)
    }
  } catch { /* best effort: static table still applies */ }
  return available
}

/**
 * Rewrite `@deepseek-ai/*` browser-module specifiers to the accelerated scope for client
 * halves. Only specs with an accelerated counterpart are rewritten; the rest are reported
 * verbatim so the UI can list unsupported client halves explicitly (never silent).
 */
export function rewriteClientSpecifiers(text, available = new Set()) {
  const mapped = []
  const unsupported = []
  const output = String(text ?? '').replace(/@deepseek-ai\/([a-z0-9][a-z0-9-]*)/giu, (spec, name) => {
    const target = `${ACCEL_SCOPE}${name}`
    if (available.has(target)) {
      mapped.push({ from: `@deepseek-ai/${name}`, to: target })
      return target
    }
    unsupported.push(spec)
    return spec
  })
  return { text: output, mapped, unsupported: [...new Set(unsupported)] }
}

function clientEntryFiles(pluginDir, pkgJson) {
  const files = new Set()
  const clientExport = pkgJson?.exports?.['./client']
  const pick = typeof clientExport === 'string'
    ? clientExport
    : (clientExport && typeof clientExport === 'object' ? clientExport.default ?? clientExport.import ?? '' : '')
  if (typeof pick === 'string' && pick) files.add(path.resolve(pluginDir, pick))
  const fallback = path.join(pluginDir, 'lib', 'client.js')
  if (fs.existsSync(fallback)) files.add(fallback)
  return [...files].filter((file) => {
    try { return fs.statSync(file).isFile() } catch { return false }
  })
}

/**
 * Rewrite a copied third-party plugin's browser side: `dsh.client.inject` / `external`
 * declarations and its `./client` bundle specifiers. Package files are copied first, so this
 * only touches the fork's private copy.
 */
export function rewriteClientHalfPackage({ pluginDir = '', available = new Set() } = {}) {
  const pkgFile = path.join(pluginDir, 'package.json')
  let pkg = null
  try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) } catch { return null }
  const mapped = []
  const unsupported = []
  const declaration = pkg?.dsh?.client
  let declarationChanged = false
  if (declaration && typeof declaration === 'object') {
    for (const field of ['inject', 'external']) {
      if (!Array.isArray(declaration[field])) continue
      const rewritten = declaration[field].map((spec) => {
        const result = rewriteClientSpecifiers(spec, available)
        mapped.push(...result.mapped)
        unsupported.push(...result.unsupported)
        if (result.text !== spec) declarationChanged = true
        return result.text
      })
      declaration[field] = [...new Set(rewritten)]
    }
    if (declarationChanged) fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`)
  }
  const clientFiles = clientEntryFiles(pluginDir, pkg)
  for (const file of clientFiles) {
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    const result = rewriteClientSpecifiers(text, available)
    mapped.push(...result.mapped)
    unsupported.push(...result.unsupported)
    if (result.text !== text) fs.writeFileSync(file, result.text)
  }
  const dedupe = (items) => [...new Map(items.map((item) => [JSON.stringify(item), item])).values()]
  return {
    package: typeof pkg?.name === 'string' ? pkg.name : path.basename(pluginDir),
    mapped: dedupe(mapped),
    unsupported: [...new Set(unsupported)],
    clientFiles: clientFiles.map((file) => path.relative(pluginDir, file).replace(/\\/g, '/')),
  }
}

/**
 * Profile rows disabled in the source (desktop-shell supplied equivalents) that the
 * accelerated *web* composition still needs. Enabling them is a deliberate, named
 * override — never a blanket "enable every disabled client row".
 */
export const CLIENT_ROW_ENABLE_OVERRIDES = Object.freeze([
  { id: 'ui-theme', reason: 'desktop shell supplies theme; accelerated web composition provides it as the theme client half' },
])

/** Re-enable the named client rows in a profile patch (JSON/JSON-array text). */
export function applyClientRowOverrides(patchText) {
  const original = String(patchText ?? '')
  const applied = []
  let parsed = null
  try { parsed = JSON.parse(original) } catch { parsed = null }
  if (parsed !== null) {
    const targetIds = new Set(CLIENT_ROW_ENABLE_OVERRIDES.map((override) => override.id))
    const walk = (node) => {
      if (Array.isArray(node)) { for (const item of node) walk(item); return }
      if (!node || typeof node !== 'object') return
      if (targetIds.has(node.id) && node.disabled === true) {
        node.disabled = false
        applied.push({ id: node.id, reason: CLIENT_ROW_ENABLE_OVERRIDES.find((override) => override.id === node.id)?.reason ?? '' })
      }
      for (const value of Object.values(node)) walk(value)
    }
    walk(parsed)
    if (applied.length) return { text: JSON.stringify(parsed, null, 2), applied }
    return { text: original, applied }
  }
  let text = original
  for (const override of CLIENT_ROW_ENABLE_OVERRIDES) {
    const escaped = override.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const blockPattern = new RegExp(`(\\{[^{}]*"id"\\s*:\\s*"${escaped}"\\s*,?[^{}]*?\\})`, 'g')
    text = text.replace(blockPattern, (block) => {
      if (!/"disabled"\s*:\s*true/.test(block)) return block
      applied.push({ id: override.id, reason: override.reason })
      return block.replace(/"disabled"\s*:\s*true/, '"disabled": false')
    })
  }
  return { text, applied }
}

/** 路线 B（增强）：fork-local LSP 所需的加速核 client/host 包。 */
export const FORK_LSP_PACKAGES = Object.freeze([
  '@twinsearth/dsh-lsp',
  '@twinsearth/dsh-lsp-stdio',
  '@twinsearth/dsh-tool-lsp',
])

/**
 * Detect whether the accelerated core can host a fork-local LSP stack (route B).
 * Detection only — provisioning stays opt-in; absent packages mean the fork keeps
 * delegating to the mother (route A) or reporting contract-unavailable.
 */
export function detectForkLspSupport(accelNodeModules) {
  const packages = FORK_LSP_PACKAGES.map((name) => ({ name, installed: accelHasPackage(accelNodeModules, name) }))
  const missing = packages.filter((item) => item.installed !== true).map((item) => item.name)
  return { available: missing.length === 0, packages, missing }
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
  if (fangRoot) deps[fangBundleNameOf(fangRoot)] = `link:${path.resolve(fangRoot).replace(/\\/g, '/')}`
  const fangBundle = fangRoot ? fangBundleNameOf(fangRoot) : FANG_BUNDLE
  const pkg = {
    name: `dsh-profile-${String(profileName).replace(/[^a-z0-9._-]/gi, '-').toLowerCase()}`,
    private: true,
    dsh: { profile: { bundles: [...translated.bundles, ...(fangRoot ? [fangBundle] : [])] } },
    dependencies: deps,
  }
  const sourcePatchFile = path.join(source, OVERLAY_FILE)
  let patchText = ''
  try { patchText = String(fs.readFileSync(sourcePatchFile, 'utf8')) } catch { patchText = '' }
  patchText = rewriteScope(patchText).replace(/^\uFEFF/, '')
  const rowOverrides = applyClientRowOverrides(patchText)
  patchText = rowOverrides.text
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
    rowOverrides: rowOverrides.applied,
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
  const clientAliases = []
  if (synced) {
    const clientAvailable = availableClientModules(accelNodeModules)
    const sourceModules = path.join(synced.source, 'node_modules')
    for (const bundle of synced.pluginPackages) {
      const from = path.join(sourceModules, ...bundle.split('/'))
      if (!fs.existsSync(from)) continue
      const targetDir = path.join(moduleDir, ...bundle.split('/'))
      copyPackageDir(from, targetDir)
      copiedPlugins.push(bundle)
      const rewritten = rewriteClientHalfPackage({ pluginDir: targetDir, available: clientAvailable })
      if (rewritten) clientAliases.push(rewritten)
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
  // 2026-11-22: 用 package.json 的真实包名建 junction（发布包名与开发别名不同；
  // 只写死 @twinsearth/fang-dsh-plugin 会让发布版在 orchestrator 的 bundle 探测里找不到 → fork-bundle-unavailable）。
  const fangBundle = fangBundleNameOf(fangDir)
  const fangTarget = path.join(moduleDir, ...fangBundle.split('/'))
  fs.mkdirSync(path.dirname(fangTarget), { recursive: true })
  junctions.push({ package: fangBundle, ...makeEntryJunction(fangDir, fangTarget) })
  if (fangBundle !== FANG_BUNDLE) {
    // 兼容旧检查/旧 profile：保留 @twinsearth/fang-dsh-plugin 开发别名 junction。
    junctions.push({ package: FANG_BUNDLE, ...makeEntryJunction(fangDir, path.join(moduleDir, '@local', 'dsh-fang')) })
  }
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
  const bundles = synced ? [...synced.bundles.translated, fangBundleNameOf(fangDir)] : [...ACCEL_BUNDLES, fangBundleNameOf(fangDir)]
  return {
    ok: true,
    profileDir,
    bundles,
    junctions,
    warning,
    overlay,
    forkLsp: accelNodeModules ? detectForkLspSupport(accelNodeModules) : null,
    sync: synced ? {
      source: synced.source,
      mapped: synced.bundles.mapped,
      unsupportedBundles: synced.bundles.unsupported,
      copiedPlugins,
      alias,
      clientAliases,
      rowOverrides: synced.rowOverrides ?? [],
      unsupportedClientHalves: clientAliases
        .filter((item) => item.unsupported.length > 0)
        .map((item) => ({ package: item.package, unsupported: item.unsupported })),
    } : null,
  }
}

/** Normalise a configured core mode; anything unknown is stock (safe default). */
export function normalizeCoreMode(value) {
  return String(value ?? '').trim() === 'accelerated' ? 'accelerated' : 'stock'
}
