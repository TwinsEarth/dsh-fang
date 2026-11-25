#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// Real-host smoke for the v3.8.0 / v3.8.1 regressions:
//   1) never boot a second DSH host when the watchdog starts;
//   2) the web client reaches a mounted shell without pending/plugin-load errors.
//
// This is deliberately not a source-string assertion. It boots the packaged
// DeepSeek Harness CLI, visits the real web client with headless Edge, and
// inspects the live process table and rendered DOM.
//
// Usage (Windows, packaged host stopped or another host running):
//   node tools/release/host-boot-smoke.mjs \
//     --cli "D:\DSH\resources\runtime\cli\bin\dsh.cmd" \
//     --plugin "C:\Users\<you>\.dsh\profiles\desktop\node_modules\@twinsearth\fang-dsh-plugin"
//
// Optional:
//   --profile <name>    default fang-host-smoke
//   --dsh-home <dir>    reuse an isolated DSH_HOME instead of a temp one
//   --out <dir>         report directory (default <dsh-home>/host-smoke-report)
//   --port <n>          default 0 (random port printed by the host)
//   --edge <exe>        default auto-detect Edge/Chrome
//   --keep              keep the isolated DSH_HOME after the run
//   --json              print only the machine-readable report
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..')
const argv = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const key = String(name).startsWith('--') ? String(name) : `--${name}`
  const index = argv.indexOf(key)
  return index >= 0 ? String(argv[index + 1] ?? '') : fallback
}
const has = (name) => argv.includes(name)
const asJson = has('--json')
const keep = has('--keep')
const profile = arg('--profile', 'fang-host-smoke').trim()
const portArg = Number(arg('--port', '0')) || 0
const cli = path.resolve(arg('--cli', process.env.DSH_CLI ?? 'D:\\DSH\\resources\\runtime\\cli\\bin\\dsh.cmd'))
const plugin = path.resolve(arg('--plugin', ROOT))
const explicitHome = arg('--dsh-home', '').trim()
const dshHome = path.resolve(explicitHome || fs.mkdtempSync(path.join(os.tmpdir(), 'fang-host-smoke-')))
const dataHome = path.join(dshHome, 'data')
const out = path.resolve(arg('--out', path.join(dshHome, 'host-smoke-report')))
const edgeArg = arg('--edge', '')
const checks = []
const artifacts = {}
let child = null
let hostPid = 0
let bootUrl = ''

fs.mkdirSync(out, { recursive: true })

function check(id, ok, detail = '') {
  checks.push({ id, ok: Boolean(ok), detail: String(detail) })
  if (!asJson) console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id}${detail ? ` — ${detail}` : ''}`)
}

function tail(text, size = 2000) {
  return String(text ?? '').slice(-size)
}

function runCli(args, timeout = 120000) {
  const result = spawnSync(cli, args, {
    cwd: dshHome,
    env: { ...process.env, DSH_HOME: dshHome, FANG_HOME: dataHome },
    encoding: 'utf8',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    shell: process.platform === 'win32',
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error }
}

function psJson(expression) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', expression], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`powershell failed: ${result.stderr || result.stdout}`)
  const text = String(result.stdout ?? '').trim()
  if (!text) return []
  const value = JSON.parse(text)
  return Array.isArray(value) ? value : [value]
}

function processesForProfile() {
  const safe = profile.replace(/[^A-Za-z0-9._-]/g, '')
  return psJson(`Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'DeepSeek Harness.exe' -and $_.CommandLine -like '*--profile ${safe}*' } | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`)
}

function sidecarProcesses(host) {
  return psJson(`Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*watchdog-sidecar.mjs*' -and $_.ParentProcessId -eq ${Number(host)} } | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`)
}

function findBrowser() {
  if (edgeArg) return path.resolve(edgeArg)
  const candidates = []
  if (process.env['ProgramFiles(x86)']) candidates.push(path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? ''
}

function cookieFrom(headers) {
  const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
  return values.map((value) => String(value).split(';')[0]).join('; ')
}

async function readJson(url, headers) {
  const response = await fetch(url, { headers })
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

async function authenticate(url) {
  const first = await fetch(url, { redirect: 'manual' })
  const cookie = cookieFrom(first.headers)
  let pageUrl = url
  let html = ''
  if (first.status >= 300 && first.status < 400) {
    pageUrl = new URL(first.headers.get('location') ?? '/', url).toString()
    const page = await fetch(pageUrl, { headers: cookie ? { cookie } : {} })
    html = await page.text()
  } else {
    html = await first.text()
  }
  const base = new URL(url)
  const authHeaders = { accept: 'application/json', ...(cookie ? { cookie } : {}) }
  const tokenBody = await readJson(new URL('/fang/api/auth-token', base).toString(), authHeaders)
  return { cookie, token: String(tokenBody.token ?? ''), html, pageUrl }
}

function writeJson(name, value) {
  const file = path.join(out, name)
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
  artifacts[name] = file
}

function shutdownHost(pid) {
  if (!pid) return
  try {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15000 })
  } catch { /* best effort */ }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('host-boot-smoke requires Windows (packaged DSH host + process table)')
  if (!fs.existsSync(cli)) throw new Error(`missing DSH CLI: ${cli}`)
  if (!fs.existsSync(plugin)) throw new Error(`missing plugin package: ${plugin}`)

  const profileDir = path.join(dshHome, 'profiles', profile)
  if (!fs.existsSync(path.join(profileDir, 'package.json'))) {
    const created = runCli([profile, '--from-default-profile', 'web', '--dump-config'])
    check('isolated profile created from shipped web template', created.status === 0, tail(created.stderr || created.stdout))
  } else {
    check('isolated profile reused', true, profileDir)
  }

  const added = runCli(['plugin', '--profile', profile, 'add', plugin])
  check('Fang plugin linked into isolated profile', added.status === 0, tail(added.stderr || added.stdout))
  if (added.status !== 0) throw new Error('plugin install failed')

  child = spawn(cli, ['--profile', profile, '--port', String(portArg), '--no-open'], {
    cwd: dshHome,
    env: { ...process.env, DSH_HOME: dshHome, FANG_HOME: dataHome, DSH_FANG_ROLE: 'mother' },
    windowsHide: true,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })
  bootUrl = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(''), 150000)
    const inspect = () => {
      const match = /dsh web: (https?:\/\/\S+)/.exec(output)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    }
    child.stdout.on('data', inspect)
    child.stderr.on('data', inspect)
    child.once('exit', () => { clearTimeout(timer); resolve('') })
    inspect()
  })
  check('real DSH host booted and printed a web URL', Boolean(bootUrl), bootUrl ? new URL(bootUrl).origin : tail(output))
  if (!bootUrl) {
    const status = await exited
    throw new Error(`host did not boot (exit=${status.code}/${status.signal}): ${tail(output, 4000)}`)
  }

  await new Promise((resolve) => setTimeout(resolve, 3000))
  const hosts = processesForProfile()
  writeJson('host-processes.json', hosts)
  check('exactly one DSH host for this profile', hosts.length === 1, `hosts=${hosts.length} pids=${hosts.map((item) => item.ProcessId).join(',')}`)
  if (hosts.length !== 1) throw new Error(`second host detected: ${JSON.stringify(hosts)}`)
  hostPid = Number(hosts[0].ProcessId)
  check('host process is the packaged DeepSeek Harness executable', String(hosts[0].ExecutablePath).toLowerCase().endsWith('deepseek harness.exe'), hosts[0].ExecutablePath)

  const auth = await authenticate(bootUrl)
  const statusHeaders = { accept: 'application/json', ...(auth.cookie ? { cookie: auth.cookie } : {}), ...(auth.token ? { 'x-fang-auth': auth.token } : {}) }
  const status = await readJson(new URL('/fang/api/status', new URL(bootUrl)).toString(), statusHeaders)
  writeJson('status.json', status)
  check('Fang status route responded as mother', status.role === 'mother' && Boolean(status.version), `role=${status.role} version=${status.version}`)
  check('host audit reports a clean boot', status.audit?.ok === true && status.audit?.health?.ok === true && status.audit?.health?.lastBoot?.pid === hostPid, JSON.stringify(status.audit?.health?.lastBoot ?? null))

  let sidecars = []
  for (let attempt = 0; attempt < 8 && sidecars.length === 0; attempt += 1) {
    sidecars = sidecarProcesses(hostPid)
    if (sidecars.length === 0) await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  writeJson('sidecar-processes.json', sidecars)
  check('watchdog sidecar started as a child of the one host', sidecars.length === 1, `sidecars=${sidecars.length}`)
  if (sidecars.length === 1) {
    const exe = String(sidecars[0].ExecutablePath ?? '')
    check('sidecar uses DSH bundled node.exe, not the Electron executable', /resources[\\/]runtime[\\/]primary-runtime[\\/]dependencies[\\/]node[\\/]bin[\\/]node\.exe$/i.test(exe), exe)
    check('sidecar command is watchdog-sidecar.mjs', /watchdog-sidecar\.mjs/i.test(String(sidecars[0].CommandLine ?? '')), String(sidecars[0].CommandLine ?? '').slice(-300))
  }

  const browser = findBrowser()
  check('headless Edge/Chrome available for client boot', Boolean(browser), browser)
  if (!browser) throw new Error('no Edge/Chrome found')
  const browserHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-host-smoke-browser-'))
  const dump = spawnSync(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    `--user-data-dir=${browserHome}`, '--dump-dom', bootUrl,
  ], { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024, windowsHide: true })
  const dom = String(dump.stdout ?? '')
  try { fs.rmSync(browserHome, { recursive: true, force: true }) } catch { /* best effort */ }
  fs.writeFileSync(path.join(out, 'boot.html'), dom)
  artifacts['boot.html'] = path.join(out, 'boot.html')
  check('headless browser returned a DOM', dump.status === 0 && dom.length > 1000, `exit=${dump.status} bytes=${dom.length} ${tail(dump.stderr || '', 300)}`)
  if (dump.status !== 0 || dom.length <= 1000) throw new Error('client DOM dump failed')

  check('Fang client half is mounted', dom.includes('data-fang-overlays="visible"'), 'data-fang-overlays="visible"')
  const bootGraphMatch = /globalThis\["__DSH_BOOT__"\]\s*=\s*(\{[\s\S]*?\});?<\/script>/.exec(dom)
  let bootGraph = null
  if (bootGraphMatch) {
    try { bootGraph = JSON.parse(bootGraphMatch[1]) } catch { bootGraph = null }
  }
  writeJson('boot.json', bootGraph ?? { parseError: true, match: Boolean(bootGraphMatch) })
  check('client boot graph is present', Boolean(bootGraph?.entries?.length), `entries=${bootGraph?.entries?.length ?? 0}`)
  const errorMarkers = ['pending waiting', 'failed to load plugins', 'handler-threw', 'failed to import', 'missed the module table']
  const found = errorMarkers.filter((marker) => dom.toLowerCase().includes(marker))
  check('no pending-waiting / plugin-load / handler-threw markers', found.length === 0, found.join(', '))

  const hostsAfter = processesForProfile()
  writeJson('host-processes-after.json', hostsAfter)
  check('still exactly one DSH host after client boot', hostsAfter.length === 1, `hosts=${hostsAfter.length}`)

  shutdownHost(hostPid)
  await new Promise((resolve) => setTimeout(resolve, 2500))
  const hostsStopped = processesForProfile()
  check('smoke host stopped cleanly', hostsStopped.length === 0, `hosts=${hostsStopped.length}`)

  artifacts['report.json'] = path.join(out, 'report.json')
  writeJson('report.json', {
    ok: checks.every((item) => item.ok),
    generatedAt: new Date().toISOString(),
    profile,
    hostPid,
    bootUrl: bootUrl.replace(/token=[^&]+/, 'token=<redacted>'),
    dshHome,
    dataHome,
    checks,
    artifacts,
  })
  return checks.every((item) => item.ok)
}

let result = false
try {
  result = await main()
} catch (error) {
  check('smoke completed without throwing', false, String(error?.message ?? error))
  artifacts['report.json'] = path.join(out, 'report.json')
  writeJson('report.json', {
    ok: false,
    generatedAt: new Date().toISOString(),
    profile,
    hostPid,
    dshHome,
    dataHome,
    checks,
    artifacts,
    error: String(error?.message ?? error),
  })
} finally {
  if (child && child.pid && !hostPid) {
    try { child.kill() } catch { /* gone */ }
  }
  if (hostPid) shutdownHost(hostPid)
  if (!keep && !explicitHome) {
    try { fs.rmSync(dshHome, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

if (asJson) {
  const reportFile = artifacts['report.json'] ? fs.readFileSync(artifacts['report.json'], 'utf8') : '{"ok":false}'
  process.stdout.write(reportFile)
} else {
  console.log(`\nreport: ${artifacts['report.json'] ?? '(not written)'}`)
}

process.exit(result ? 0 : 2)
