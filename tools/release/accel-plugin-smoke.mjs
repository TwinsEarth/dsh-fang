#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// Accelerated-fork plugin-surface smoke (D2 follow-up):
//   1. build a *synced* accelerated profile from a real essence/mother profile via the
//      production `writeAcceleratedForkProfile({sourceProfileDir, accelNodeModules})`;
//   2. boot the accelerated CLI against it;
//   3. classify each target plugin entry as activated / pending(service) / failed(import);
//   4. run host-level functional probes (web page + fang adapter identity).
//
// Exit code: 0 = no import failures; 1 = failures; 2 = unusable args/environment.
// Usage:
//   node tools/release/accel-plugin-smoke.mjs --accel-nm <accel>/node_modules \
//     --essence-profile <merged profile> [--out dir] [--port 18094] [--json]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

import { writeAcceleratedForkProfile } from '../../src/lib/accelerated-fork.mjs'

const argv = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? String(argv[index + 1] ?? '') : fallback
}
const hasFlag = (name) => argv.includes(`--${name}`)

const ACCEL_NM = arg('accel-nm')
const ESS = arg('essence-profile')
const PORT = Number(arg('port', '18094'))
const OUT = arg('out', path.join(process.env.TEMP || '.', `fang-plugin-smoke-${Date.now()}`))
const JSON_ONLY = hasFlag('json')
const FANG_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..')

if (!ACCEL_NM || !ESS) {
  console.error('usage: node tools/release/accel-plugin-smoke.mjs --accel-nm <accel>/node_modules --essence-profile <profile> [--out dir] [--port n] [--json]')
  process.exit(2)
}
const ACCEL_BIN = path.join(ACCEL_NM, '@twinsearth', 'dsh', 'lib', 'bin.js')
if (!fs.existsSync(ACCEL_BIN)) { console.error(`accelerated CLI missing: ${ACCEL_BIN}`); process.exit(2) }

fs.mkdirSync(OUT, { recursive: true })
const home = path.join(OUT, 'home')
fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
const profileDir = path.join(home, 'profiles', 'web-accel')
const profileName = path.basename(profileDir)

const built = writeAcceleratedForkProfile({
  profileDir,
  fangRoot: FANG_ROOT,
  homeDir: home,
  motherHome: '',
  profileName,
  sourceProfileDir: ESS,
  accelNodeModules: ACCEL_NM,
})
if (built.ok !== true) {
  console.error(JSON.stringify({ ok: false, error: built.error ?? 'profile-build-failed', detail: JSON.stringify(built).slice(0, 400) }))
  process.exit(1)
}
const sync = built.sync ?? {}
const targetPlugins = (sync.copiedPlugins ?? []).filter((spec) => !spec.startsWith('@twinsearth/dsh-fang'))

function classify(stderr, spec) {
  const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const failed = new RegExp(`\\(${escaped}\\): failed to (?:import|activate)[^\\n]*`, 'i').exec(stderr)
  const pending = new RegExp(`\\(${escaped}\\): pending \\(waiting for service: ([^)]+)\\)`, 'i').exec(stderr)
  if (failed) return { state: 'failed', detail: failed[0].trim().slice(0, 240) }
  if (pending) return { state: 'pending-service', detail: `waiting for service: ${pending[1]}` }
  return { state: 'activated', detail: '' }
}

function bootAndProbe() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ACCEL_BIN, '--profile', profileName, '--port', String(PORT), '--no-open'], {
      env: { ...process.env, DSH_HOME: home, DSH_FANG_ROLE: 'fork', DSH_FANG_TASK_ID: 'plugin-smoke' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let url = null
    let finished = false
    const finish = async (code) => {
      if (finished) return
      finished = true
      const plugins = (targetPlugins.length ? targetPlugins : sync.pluginPackages ?? []).map((spec) => ({ spec, ...classify(stderr, spec) }))
      const probes = { webPage: null, fangIdentity: null }
      if (url) {
        const token = (() => { try { return new URL(url).searchParams.get('token') ?? '' } catch { return '' } })()
        try {
          const res = await fetch(`${url.replace(/\/\?.*$/, '')}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
          probes.webPage = { status: res.status, ok: res.status >= 200 && res.status < 400 }
        } catch (error) { probes.webPage = { ok: false, error: String(error?.message ?? error) } }
        // fang data dir is <home>/fang/<profileTag> where profileTag can vary; find the token file.
        const authFile = (() => {
          const stack = [{ dir: home, depth: 0 }]
          while (stack.length) {
            const { dir, depth } = stack.shift()
            if (depth > 4) continue
            let entries
            try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
            for (const entry of entries) {
              if (entry.isDirectory()) { stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 }); continue }
              if (entry.name === 'fang-auth.json') return path.join(dir, entry.name)
            }
          }
          return null
        })()
        if (authFile) {
          try {
            const auth = JSON.parse(fs.readFileSync(authFile, 'utf8'))
            const res = await fetch(`http://127.0.0.1:${PORT}/fang/adapter/identity`, { headers: { 'x-fang-auth': auth.token } })
            const body = await res.json().catch(() => null)
            probes.fangIdentity = { status: res.status, ok: body?.role === 'fork', role: body?.role ?? null, version: body?.version ?? null }
          } catch (error) { probes.fangIdentity = { ok: false, error: String(error?.message ?? error) } }
        } else {
          // Fork homes may run fang without an auth token file (token comes from the spawn env);
          // probe unauthenticated and report what the route answers.
          try {
            const res = await fetch(`http://127.0.0.1:${PORT}/fang/adapter/identity`)
            const body = await res.json().catch(() => null)
            probes.fangIdentity = { status: res.status, ok: body?.role === 'fork', role: body?.role ?? null, version: body?.version ?? null, unauthenticated: true }
          } catch (error) { probes.fangIdentity = { ok: null, skipped: `fetch failed: ${String(error?.message ?? error)}` } }
        }
      }
      try { child.kill() } catch { /* gone */ }
      const failed = plugins.filter((p) => p.state === 'failed')
      const fangOk = probes.fangIdentity?.skipped ? true : probes.fangIdentity?.ok === true
      resolve({
        ok: failed.length === 0 && probes.webPage?.ok === true && fangOk,
        boot: { url: url ? url.replace(/token=[^\s]+/, 'token=<redacted>') : null, exit: code },
        profile: { home, profileDir, bundles: built.bundles, copiedPlugins: sync.copiedPlugins ?? [], alias: sync.alias ? { resolved: sync.alias.resolved.length, unsupported: sync.alias.unsupported.length } : null },
        plugins,
        probes,
        failures: failed.map((p) => p.spec),
      })
    }
    const timer = setTimeout(() => finish(null), 45000)
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      const m = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)
      if (m && !url) {
        url = m[0]
        setTimeout(() => finish(0), 6000) // collect activation warnings, then probe
      }
    })
    child.stderr.on('data', (chunk) => { stderr += String(chunk); if (stderr.length > 120000) stderr = stderr.slice(-120000) })
    child.on('exit', (code) => { clearTimeout(timer); finish(code) })
    child.on('error', (error) => { clearTimeout(timer); stderr += `\nspawn-error: ${String(error?.message ?? error)}`; finish(1) })
  })
}

const result = await bootAndProbe()
result.generatedAt = new Date().toISOString()
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2))
if (JSON_ONLY) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`accelerated plugin smoke — profile ${profileName}`)
  console.log(`bundles: ${(result.profile.bundles ?? []).join(', ')}`)
  if (result.profile.alias) console.log(`alias: resolved=${result.profile.alias.resolved} unsupported=${result.profile.alias.unsupported}`)
  for (const plugin of result.plugins) console.log(`${plugin.state === 'activated' ? 'PASS' : plugin.state === 'pending-service' ? 'WARN' : 'FAIL'}  ${plugin.spec}  ${plugin.detail}`)
  console.log(`webPage: ${result.probes.webPage?.status ?? 'n/a'} | fangIdentity: ${result.probes.fangIdentity?.ok ? 'PASS' : 'FAIL'} (${result.probes.fangIdentity?.version ?? result.probes.fangIdentity?.error ?? ''})`)
  console.log(`${result.ok ? 'GREEN' : 'RED'}  plugin surface smoke (${result.plugins.filter((p) => p.state === 'activated').length}/${result.plugins.length} activated)`)
  console.log(`result: ${path.join(OUT, 'result.json')}`)
}
process.exit(result.ok ? 0 : 1)
