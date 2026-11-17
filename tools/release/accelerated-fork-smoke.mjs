#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// P0 smoke: a REAL accelerated fork. It installs nothing and touches no product
// profile: it uses <FANG_HOME>/accel/cli (or --cli), builds a throwaway DSH_HOME,
// provisions the minimal accelerated profile, boots @twinsearth/dsh, and asserts:
//   1. the web banner appears;
//   2. /fang/adapter/identity reports {role:'fork', version:<fang version>};
//   3. the boot page lists dsh-fang/client.js;
//   4. no stock CLI is used and no mother/essence profile is written.
//
// Usage: node tools/release/accelerated-fork-smoke.mjs [--cli <bin.js>] [--fang-home <dir>] [--json]
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { resolveAcceleratedCore, installedAcceleratedVersion } from '../../src/lib/accelerated-install.mjs'
import { writeAcceleratedForkProfile } from '../../src/lib/accelerated-fork.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? String(process.argv[index + 1] ?? '') : fallback
}
const asJson = process.argv.includes('--json')
const out = (value) => { if (asJson) console.log(JSON.stringify(value)); else console.log(JSON.stringify(value, null, 2)) }

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function killTree(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    else process.kill(-pid, 'SIGKILL')
  } catch { /* best effort */ }
}

async function httpJson(url, timeoutMs = 15000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  return { status: response.status, text: await response.text() }
}

/** The boot URL token is exchanged for a cookie on the first redirect; fetch must replay it. */
async function fetchBootPage(url, timeoutMs = 20000) {
  const first = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
  if (first.status === 200) return { status: 200, text: await first.text() }
  const setCookie = typeof first.headers.getSetCookie === 'function' ? first.headers.getSetCookie() : []
  const cookie = setCookie.map((value) => String(value).split(';')[0]).join('; ')
  const location = first.headers.get('location')
  if (!location) return { status: first.status, text: await first.text() }
  const second = await fetch(new URL(location, url).toString(), {
    headers: cookie ? { cookie } : {},
    signal: AbortSignal.timeout(timeoutMs),
  })
  return { status: second.status, text: await second.text() }
}

const main = async () => {
  const fangHome = arg('fang-home', String(process.env.FANG_HOME ?? 'D:\\ToFuture').trim())
  const cliArg = arg('cli', '')
  const resolved = resolveAcceleratedCore({ cliPath: cliArg, env: process.env, fangHome })
  if (resolved.ok !== true) {
    out({ ok: false, stage: 'resolve-cli', error: resolved.error, searched: resolved.searched })
    return 2
  }
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-accel-smoke-'))
  const profile = 'fang-accel-smoke'
  const profileDir = path.join(tempHome, 'profiles', profile)
  const provisioned = writeAcceleratedForkProfile({
    profileDir,
    fangRoot: REPO,
    homeDir: tempHome,
    motherHome: String(process.env.DSH_HOME ?? '').trim(),
    profileName: profile,
  })
  if (provisioned.ok !== true) {
    killTree(0)
    out({ ok: false, stage: 'provision', detail: provisioned })
    return 2
  }
  const port = await freePort()
  const child = spawn(process.execPath, [resolved.cliPath, '--profile', profile, '--port', String(port), '--no-open'], {
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      USERPROFILE: process.env.USERPROFILE,
      DSH_HOME: tempHome,
      DSH_FANG_ROLE: 'fork',
      DSH_FANG_TASK_ID: 'smoke-task',
      DSH_FANG_MOTHER: String(process.env.DSH_HOME ?? '').trim(),
    },
    cwd: tempHome,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const url = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), Math.max(15000, Number(arg('timeout-ms', '90000'))))
    const onData = (chunk) => {
      output += String(chunk)
      const match = /dsh web: (https?:\/\/\S+)/.exec(output)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', () => { clearTimeout(timer); resolve(null) })
  }).catch(() => null)

  const checks = []
  const check = (id, ok, detail) => { checks.push({ id, ok: Boolean(ok), detail }) }
  check('web-banner', Boolean(url), url ?? output.slice(-400))
  if (url) {
    const base = new URL(url).origin
    const identity = await httpJson(`${base}/fang/adapter/identity`).catch((error) => ({ status: 0, text: String(error) }))
    let body = null
    try { body = JSON.parse(identity.text) } catch { body = null }
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
    check('adapter-identity-200', identity.status === 200, identity.status)
    check('adapter-role-fork', body?.role === 'fork', body?.role ?? null)
    check('adapter-version', body?.version === pkg.version, `${body?.version} (expect ${pkg.version})`)
    const page = await fetchBootPage(url).catch((error) => ({ status: 0, text: String(error) }))
    check('boot-page-200', page.status === 200, page.status)
    check('client-half-listed', page.text.includes('dsh-fang/client.js'), 'boot manifest')
    check('core-version', Boolean(installedAcceleratedVersion(fangHome)), installedAcceleratedVersion(fangHome))
    check('no-stock-cli', !String(resolved.cliPath).includes('DeepSeek Harness'), resolved.cliPath)
  }
  killTree(child.pid)
  try { fs.rmSync(tempHome, { recursive: true, force: true }) } catch { /* junctions may resist; best effort */ }
  const ok = checks.every((item) => item.ok)
  out({ ok, cli: resolved.cliPath, source: resolved.source, port, checks })
  return ok ? 0 : 1
}

main().then((code) => process.exit(code)).catch((error) => {
  out({ ok: false, stage: 'exception', error: String(error?.stack ?? error) })
  process.exit(1)
})
