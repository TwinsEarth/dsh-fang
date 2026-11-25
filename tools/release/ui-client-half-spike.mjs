#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// UI client half spike: boot a *synced* accelerated fork and inspect the browser
// client module graph — which third-party client halves are advertised, what they
// require, and whether the accelerated core has the target modules. Read-only.
//
// Usage:
//   node tools/release/ui-client-half-spike.mjs --essence-profile <merged profile> \
//     [--fang-home <FANG_HOME>] [--out dir] [--port 18101]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { accelNodeModulesRoot, resolveAcceleratedCore } from '../../src/lib/accelerated-install.mjs'
import { writeAcceleratedForkProfile } from '../../src/lib/accelerated-fork.mjs'

const argv = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? String(argv[index + 1] ?? '') : fallback
}
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..')
const essenceProfile = arg('essence-profile', '')
const out = arg('out', path.join(process.env.TEMP || '.', 'fang-ui-client-spike'))
const port = Number(arg('port', '18101'))
if (!essenceProfile) {
  console.error('usage: node tools/release/ui-client-half-spike.mjs --essence-profile <merged profile> [--fang-home dir] [--out dir] [--port n]')
  process.exit(2)
}
const resolved = resolveAcceleratedCore({ cliPath: arg('cli', ''), env: process.env, fangHome: arg('fang-home', String(process.env.FANG_HOME ?? '').trim()) })
if (resolved.ok !== true) {
  console.error(JSON.stringify({ ok: false, stage: 'resolve-cli', error: resolved.error, searched: resolved.searched }))
  process.exit(2)
}
fs.mkdirSync(out, { recursive: true })
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-ui-spike-'))
const profileName = 'ui-spike'
const built = writeAcceleratedForkProfile({
  profileDir: path.join(home, 'profiles', profileName), fangRoot: REPO, homeDir: home, motherHome: '',
  profileName, sourceProfileDir: essenceProfile, accelNodeModules: accelNodeModulesRoot(resolved.cliPath),
})
if (built.ok !== true) {
  console.error(JSON.stringify({ ok: false, stage: 'provision', detail: built }))
  process.exit(2)
}

const child = spawn(process.execPath, [resolved.cliPath, '--profile', profileName, '--port', String(port), '--no-open'], {
  env: { ...process.env, DSH_HOME: home, DSH_FANG_ROLE: 'fork', DSH_FANG_TASK_ID: 'ui-spike' },
  cwd: home, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
const url = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 90000)
  const onData = (chunk) => {
    output += String(chunk)
    const match = /dsh web: (https?:\/\/\S+)/.exec(output)
    if (match) { clearTimeout(timer); resolve(match[1]) }
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  child.once('exit', () => { clearTimeout(timer); resolve(null) })
})
if (!url) {
  console.error(JSON.stringify({ ok: false, stage: 'boot', tail: output.slice(-800) }))
  try { child.kill() } catch { /* gone */ }
  process.exit(2)
}
const origin = new URL(url).origin
let cookie = ''
const first = await fetch(url, { redirect: 'manual' })
const cookies = typeof first.headers.getSetCookie === 'function' ? first.headers.getSetCookie() : []
if (cookies.length) cookie = cookies.map((v) => String(v).split(';')[0]).join('; ')
const html = await (await fetch(`${origin}/`, { headers: cookie ? { cookie } : {} })).text()
fs.writeFileSync(path.join(out, 'boot.html'), html)
const boot = JSON.parse(/globalThis\["__DSH_BOOT__"\]\s*=\s*(\{[\s\S]*?\});?<\/script>/.exec(html)[1])
fs.writeFileSync(path.join(out, 'boot.json'), JSON.stringify(boot, null, 2))

async function fetchPath(p) {
  const target = p.startsWith('http') ? p : `${origin}/${p.replace(/^\/+/, '')}`
  const res = await fetch(target.replace(/&amp;/g, '&'), { headers: cookie ? { cookie } : {} })
  return { status: res.status, text: await res.text(), target }
}
function specifiers(text, scope) {
  return [...new Set([...text.matchAll(new RegExp(`${scope}\\/[a-z0-9-]+(?:\\/[a-zA-Z0-9._-]+)?`, 'g'))].map((m) => m[0]))]
}

const entries = boot.entries ?? []
const report = { ok: true, cli: resolved.cliPath, entries: entries.length, clientHalves: [], bundles: [] }
for (const entry of entries) {
  if (String(entry.id).startsWith('@twinsearth/')) continue
  const res = await fetchPath(entry.url)
  const deepseekSpecs = specifiers(res.text, '@deepseek-ai')
  const twinSpecs = specifiers(res.text, '@twinsearth')
  report.clientHalves.push({
    id: entry.id,
    status: res.status,
    bytes: res.text.length,
    injectDeepseekIds: (entry.inject ?? []).filter((id) => String(id).startsWith('@deepseek-ai/')),
    requireDeepseekSpecs: deepseekSpecs,
  })
  report.bundles.push({ id: entry.id, url: entry.url })
  fs.writeFileSync(path.join(out, `${entry.id.replace(/[^a-z0-9]+/gi, '_')}.js`), res.text)
  console.log(`${entry.id}: bundle=${res.status} ${res.text.length}B inject@deepseek=${(entry.inject ?? []).filter((i) => String(i).startsWith('@deepseek-ai/')).length} require=${deepseekSpecs.slice(0, 6).join(',') || 'none'}`)
}
const scriptSrc = [...html.matchAll(/<script[^>]*src=["']([^"']+)["']/g)].map((m) => m[1])
const coreSrc = scriptSrc.find((s) => s.includes('dsh-client-modules')) ?? scriptSrc[0]
if (coreSrc) {
  const core = await fetchPath(coreSrc)
  fs.writeFileSync(path.join(out, 'client-modules.js'), core.text)
  const hasAlias = /alias|redirect|normalizeSpecifier|moduleMap/i.test(core.text)
  report.clientModuleSystem = { url: coreSrc, status: core.status, bytes: core.text.length, hasAliasSupport: hasAlias }
  console.log(`client-modules: ${core.status} ${core.text.length}B alias-support=${hasAlias}`)
}
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
console.log(`\nreport: ${path.join(out, 'report.json')}`)
try { child.kill() } catch { /* gone */ }
process.exit(0)
