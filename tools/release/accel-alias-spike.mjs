#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// D2 spike: quantify alias-shim coverage for third-party plugins on the accelerated core.
// It builds two probe profiles (baseline vs @deepseek-ai/* alias stubs), boots the
// accelerated CLI for each, and reports activation warnings/failures.
//
// Usage:
//   node tools/release/accel-alias-spike.mjs --accel-nm <accel>/node_modules --essence-profile <merged profile> [--out dir]
//
// No installs are performed; existing accelerated core + a merged essence profile are required.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const index = argv.indexOf('--' + name)
  return index >= 0 ? String(argv[index + 1] ?? '') : fallback
}
const ACCEL_NM = arg('accel-nm')
const ESS = arg('essence-profile')
if (!ACCEL_NM || !ESS) {
  console.error('usage: node tools/release/accel-alias-spike.mjs --accel-nm <accel dir>/node_modules --essence-profile <profile dir> [--out dir]')
  process.exit(2)
}
const ACCEL = ACCEL_NM
const ACCEL_BIN = path.join(ACCEL, '@twinsearth', 'dsh', 'lib', 'bin.js')
const ESS_NM = path.join(ESS, 'node_modules')

const WORK = arg('out', path.join(process.env.TEMP || '.', 'fang-alias-spike'))

fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(WORK, { recursive: true })

const PLUGINS = [
  { spec: 'dsh-context', label: 'dsh-context' },
  { spec: '@openviking/dsh-memory-plugin', label: '@openviking/dsh-memory-plugin' },
  { spec: 'dshmarket', label: 'dshmarket' },
  { spec: '@twinsearth/w2m-dsh-plugin', label: '@twinsearth/w2m-dsh-plugin' },
]

const BASE_BUNDLES = ['@twinsearth/dsh-base', '@twinsearth/dsh-web-app']

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(src, dst)
    else fs.copyFileSync(src, dst)
  }
}

function installed(pluginSpec) {
  const dir = path.join(ESS_NM, ...pluginSpec.split('/'))
  return fs.existsSync(path.join(dir, 'package.json')) ? dir : null
}

function scanImports(dir, out = new Set()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { scanImports(full, out); continue }
    if (!/\.(mjs|cjs|js|json)$/i.test(entry.name)) continue
    let text = ''
    try { text = fs.readFileSync(full, 'utf8') } catch { continue }
    for (const match of text.matchAll(/@deepseek-ai\/dsh-[a-z0-9-]+(?:\/[a-z0-9\-/]+)?/g)) out.add(match[0])
  }
  return out
}

function accelPackageFor(baseName) {
  const dir = path.join(ACCEL, '@twinsearth', baseName)
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) } catch { return null }
}

function exportTarget(pkg, subpath) {
  const key = subpath ? `./${subpath}` : '.'
  const value = pkg.exports?.[key]
  if (!value) return null
  if (typeof value === 'string') return value
  return value.default ?? value.import ?? value.require ?? null
}

/** Create alias stubs for every @deepseek-ai spec a plugin imports. */
function createStubs(nodeModulesDir, specs) {
  const resolved = []
  const missing = []
  for (const spec of [...specs].sort()) {
    const parts = spec.split('/')
    const name = parts[1]
    const sub = parts.slice(2).join('/')
    const pkg = accelPackageFor(name)
    if (!pkg) { missing.push({ spec, reason: 'no-accelerated-equivalent' }); continue }
    const target = exportTarget(pkg, sub)
    if (!target) { missing.push({ spec, reason: 'no-export-mapping', available: Object.keys(pkg.exports ?? {}) }); continue }
    const stubDir = path.join(nodeModulesDir, '@deepseek-ai', name)
    if (!fs.existsSync(stubDir)) fs.mkdirSync(stubDir, { recursive: true })
    const accelFile = path.join(ACCEL, '@twinsearth', name, target)
    const stubFile = path.join(stubDir, sub ? `${sub.replace(/[\\/]/g, '_')}.js` : 'index.js')
    fs.writeFileSync(stubFile,
      `// alias-shim spike: @deepseek-ai/${name}${sub ? '/' + sub : ''} -> @twinsearth/${name}\n` +
      `export * from ${JSON.stringify(pathToFileURL(accelFile).href)}\n` +
      `import * as NS from ${JSON.stringify(pathToFileURL(accelFile).href)}\n` +
      `export default NS\n`)
    // package.json exports map for every requested subpath of this package
    const subpaths = [...specs].filter((s) => s === `@deepseek-ai/${name}` || s.startsWith(`@deepseek-ai/${name}/`))
    const exportsMap = {}
    for (const s of subpaths) {
      const rel = s === `@deepseek-ai/${name}` ? null : s.slice(`@deepseek-ai/${name}/`.length)
      const file = rel ? `${rel.replace(/[\\/]/g, '_')}.js` : 'index.js'
      exportsMap[rel ? `./${rel}` : '.'] = `./${file}`
    }
    fs.writeFileSync(path.join(stubDir, 'package.json'), JSON.stringify({
      name: `@deepseek-ai/${name}`,
      version: '0.0.0-alias-shim-spike',
      private: true,
      type: 'module',
      exports: exportsMap,
    }, null, 2))
    resolved.push({ spec, accel: `@twinsearth/${name}${sub ? '/' + sub : ''}` })
  }
  return { resolved, missing }
}

function buildProfile({ withStubs }) {
  const home = fs.mkdtempSync(path.join(WORK, withStubs ? 'home-stubs-' : 'home-base-'))
  const profileName = 'spike'
  const profileDir = path.join(home, 'profiles', profileName)
  const nm = path.join(profileDir, 'node_modules')
  fs.mkdirSync(nm, { recursive: true })

  // 1) third-party plugin copies (so resolution walks the probe tree, where stubs live)
  const copied = []
  for (const plugin of PLUGINS) {
    const source = installed(plugin.spec)
    if (!source) { copied.push({ ...plugin, ok: false }); continue }
    copyDir(source, path.join(nm, ...plugin.spec.split('/')))
    copied.push({ ...plugin, ok: true })
  }

  // 2) per-entry junctions for the rest of the essence module tree
  for (const entry of fs.readdirSync(ESS_NM, { withFileTypes: true })) {
    if (entry.name === '@deepseek-ai') continue
    if (entry.name.startsWith('@')) {
      for (const scoped of fs.readdirSync(path.join(ESS_NM, entry.name), { withFileTypes: true })) {
        const rel = path.join(entry.name, scoped.name)
        if (copied.some((p) => p.spec === rel)) continue
        const dst = path.join(nm, rel)
        if (fs.existsSync(dst)) continue
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        try { fs.symlinkSync(path.join(ESS_NM, rel), dst, 'junction') } catch { /* skip */ }
      }
      continue
    }
    if (copied.some((p) => p.spec === entry.name)) continue
    const dst = path.join(nm, entry.name)
    try { fs.symlinkSync(path.join(ESS_NM, entry.name), dst, 'junction') } catch { /* skip */ }
  }

  // 3) profile package.json + patch
  const pkg = JSON.parse(fs.readFileSync(path.join(ESS, 'package.json'), 'utf8'))
  pkg.dsh.profile.bundles = [...BASE_BUNDLES, ...PLUGINS.filter((p) => copied.some((c) => c.spec === p.spec && c.ok)).map((p) => p.spec)]
  for (const key of Object.keys(pkg.dependencies ?? {})) if (key.startsWith('@deepseek-ai/')) delete pkg.dependencies[key]
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(pkg, null, 2))
  let patch = fs.readFileSync(path.join(ESS, 'cordis.patch.yml'), 'utf8').replace(/@deepseek-ai\/dsh-/g, '@twinsearth/dsh-')
  patch = patch.trimStart().startsWith('{') ? `[${patch}]` : patch
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), patch)
  fs.copyFileSync(path.join(ESS, 'cordis.yml'), path.join(profileDir, 'cordis.yml'))

  // 4) stubs
  const specs = new Set()
  for (const plugin of copied.filter((c) => c.ok)) scanImports(path.join(nm, ...plugin.spec.split('/')), specs)
  const stubs = withStubs ? createStubs(nm, specs) : { resolved: [], missing: [], scanned: [...specs].length }
  if (!withStubs) stubs.scanned = [...specs].length
  return { home, profileName, profileDir, copied, stubs, specsCount: specs.size }
}

function boot({ home, profileName }, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ACCEL_BIN, '--profile', profileName, '--port', String(port), '--no-open'], {
      env: { ...process.env, DSH_HOME: home, DSH_FANG_ROLE: 'fork', DSH_FANG_TASK_ID: 'alias-spike' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let url = null
    const finish = (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, url: url ?? stderr }) }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* gone */ }
      setTimeout(() => finish(null), 500)
    }, 45000)
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      const m = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)
      if (m && !url) url = m[0]
    })
    child.stderr.on('data', (chunk) => { stderr += String(chunk); if (stderr.length > 60000) stderr = stderr.slice(-60000) })
    child.on('error', (error) => { stderr += `\nspawn-error: ${String(error?.message ?? error)}`; finish(1) })
    child.on('exit', (code) => finish(code))
    // early exit when the URL appears: keep running a moment so activation warnings are collected
    const check = setInterval(() => {
      if (url) { clearInterval(check); setTimeout(() => { try { child.kill() } catch {} }, 3500) }
    }, 300)
  })
}

function summarizeStderr(stderr) {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const failed = lines.filter((l) => /failed to import|failed to activate|Cannot find package|ERR_MODULE_NOT_FOUND/i.test(l))
  const pending = lines.filter((l) => /pending \(/i.test(l))
  const warnings = lines.filter((l) => /^dsh: warning/i.test(l))
  const counts = {}
  for (const line of pending) {
    const m = line.match(/^([a-z0-9-]+) \(([^)]+)\): pending/i)
    if (m) counts[`pending:${m[1]}`] = (counts[`pending:${m[1]}`] ?? 0) + 1
  }
  const failures = failed.map((l) => l.slice(0, 200))
  return { warnings, pendingCount: pending.length, pending, failureCount: failed.length, failures, counts }
}

const results = {}
for (const [name, withStubs, port] of [['baseline', false, 18091], ['stubs', true, 18092]]) {
  const profile = buildProfile({ withStubs })
  const run = await boot(profile, port)
  const summary = summarizeStderr(run.stderr)
  results[name] = {
    url: run.url ? run.url.replace(/token=[^\s]+/, 'token=<redacted>') : null,
    boot: run.url ? 'UP' : (run.code === null ? 'timeout' : `exit ${run.code}`),
    pluginsCopied: profile.copied.filter((c) => c.ok).map((c) => c.spec),
    specsScanned: profile.specsCount,
    stubsResolved: profile.stubs.resolved?.length ?? 0,
    stubsMissing: profile.stubs.missing ?? [],
    stderrSummary: { warnings: summary.warnings, pendingCount: summary.pendingCount, failureCount: summary.failureCount },
    failures: summary.failures.slice(0, 18),
    pending: summary.pending.slice(0, 12),
  }
}

fs.writeFileSync(path.join(WORK, 'result.json'), JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2).slice(0, 12000))
