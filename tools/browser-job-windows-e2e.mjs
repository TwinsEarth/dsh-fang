// SPDX-License-Identifier: AGPL-3.0-or-later
// Windows browser Job Object E2E: launch a real Chromium browser under
// fang-job-host, verify the Job owns the browser child tree, then kill only the
// helper and require every browser process for the unique profile to disappear.
//
// Usage: node tools/browser-job-windows-e2e.mjs [--helper <path>] [--browser <path>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'

if (process.platform !== 'win32') {
  console.log('SKIP browser-job-e2e: Windows only')
  process.exit(0)
}

const args = process.argv.slice(2)
const helperIndex = args.indexOf('--helper')
const browserIndex = args.indexOf('--browser')
const helper = helperIndex >= 0 ? path.resolve(args[helperIndex + 1]) : path.resolve('native/win32/fang-job-host.exe')
const candidates = [
  browserIndex >= 0 ? path.resolve(args[browserIndex + 1]) : '',
  process.env.FANG_E2E_BROWSER || '',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean)
const browser = candidates.find((item) => fs.existsSync(item))
if (!fs.existsSync(helper)) {
  console.error(`FAIL helper not found: ${helper}`)
  process.exit(1)
}
if (!browser) {
  console.log('SKIP browser-job-e2e: no Edge/Chrome found')
  process.exit(0)
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-browser-job-e2e-'))
const profile = path.join(dir, 'profile')
const heartbeat = path.join(dir, 'heartbeat.json')
const ready = path.join(dir, 'ready.json')
const log = path.join(dir, 'helper.log')
fs.mkdirSync(profile, { recursive: true })
fs.writeFileSync(heartbeat, '{}', 'utf8')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const browserName = path.basename(browser)
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

function browserPids() {
  try {
    const ps = [
      'Get-CimInstance Win32_Process',
      `| Where-Object { $_.Name -eq '${browserName}' -and $_.CommandLine -like '*${profile.replace(/'/g, "''")}*' }`,
      '| Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress',
    ].join(' ')
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', windowsHide: true, timeout: 15000,
    }).trim()
    if (!out) return []
    const rows = JSON.parse(out)
    return (Array.isArray(rows) ? rows : [rows]).map((row) => Number(row.ProcessId)).filter(Boolean)
  } catch {
    return []
  }
}

const helperProc = spawn(helper, [
  '--heartbeat', heartbeat,
  '--ready-file', ready,
  '--job-name', 'fang-browser-e2e',
  '--host-pid', String(process.pid),
  '--heartbeat-timeout-ms', '60000',
  '--heartbeat-grace-ms', '30000',
  '--log', log,
  '--', browser,
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${profile}`,
  '--remote-debugging-port=0',
  'about:blank',
], { windowsHide: true, stdio: 'ignore' })

let helperPid = 0
let childPid = 0
try {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline && !fs.existsSync(ready)) await sleep(200)
  if (!fs.existsSync(ready)) throw new Error('timeout waiting ready.json')
  const data = JSON.parse(fs.readFileSync(ready, 'utf8'))
  helperPid = Number(data.helperPid) || 0
  childPid = Number(data.childPid) || 0
  if (!helperPid || !childPid || data.error) throw new Error(`bad ready.json: ${JSON.stringify(data)}`)

  const deadline2 = Date.now() + 10000
  let pids = []
  while (Date.now() < deadline2) {
    pids = browserPids()
    if (alive(childPid) && pids.length >= 2) break
    await sleep(300)
  }
  if (!alive(childPid)) throw new Error(`browser root ${childPid} not alive`)
  if (pids.length < 2) throw new Error(`expected browser child tree, got ${JSON.stringify(pids)}`)
  console.log(`PASS browser root=${childPid} helper=${helperPid} tree=${pids.join(',')}`)

  // Kill only the helper. The Job handle closes; Windows must terminate every
  // browser child. Do NOT use taskkill /T, which would prove tree-kill instead.
  process.kill(helperPid)
  const deadline3 = Date.now() + 15000
  while (Date.now() < deadline3) {
    pids = browserPids()
    if (!alive(childPid) && pids.length === 0) break
    await sleep(300)
  }
  pids = browserPids()
  if (alive(childPid) || pids.length > 0) throw new Error(`browser tree survived: root=${childPid} alive=${alive(childPid)} pids=${JSON.stringify(pids)}`)
  console.log(`PASS browser tree gone after kill-on-close (root=${childPid})`)
  process.exit(0)
} catch (error) {
  console.error(`FAIL ${error?.message ?? error}`)
  try { if (helperPid && alive(helperPid)) process.kill(helperPid) } catch { /* best effort */ }
  for (const pid of browserPids()) {
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* best effort */ }
  }
  try { console.error(fs.readFileSync(log, 'utf8').slice(-3000)) } catch { /* ignore */ }
  process.exit(1)
} finally {
  try { helperProc.kill() } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}
