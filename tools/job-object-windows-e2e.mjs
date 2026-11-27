// SPDX-License-Identifier: AGPL-3.0-or-later
// Windows-only Job Object E2E:
//   1. KILL_ON_JOB_CLOSE: kill only the helper, the child must die.
//   2. JOB_OBJECT_LIMIT_JOB_MEMORY: a 64MB job kills/blocks a growing child.
//   3. JOB_OBJECT_LIMIT_PROCESS_MEMORY: same for the per-process cap.
//
// Usage: node tools/job-object-windows-e2e.mjs [--helper <path>] [--memory]
// Exit 0 only when every requested case passes.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

if (process.platform !== 'win32') {
  console.log('SKIP job-object-e2e: Windows only')
  process.exit(0)
}

const args = process.argv.slice(2)
const helperIndex = args.indexOf('--helper')
const helper = helperIndex >= 0 ? path.resolve(args[helperIndex + 1]) : path.resolve('native/win32/fang-job-host.exe')
const memory = args.includes('--memory')
if (!fs.existsSync(helper)) {
  console.error(`FAIL helper not found: ${helper}`)
  process.exit(1)
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-job-e2e-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(200)
  }
  throw new Error(`timeout waiting for ${label}`)
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

const childScript = 'setInterval(() => {}, 1000)'
const memoryChild = 'const chunks = []; setInterval(() => { chunks.push(Buffer.alloc(16 * 1024 * 1024, 1)) }, 50)'

async function runCase(name, { childCode, extraArgs = [], expectChildExit = false }) {
  const caseDir = path.join(dir, name)
  fs.mkdirSync(caseDir, { recursive: true })
  const heartbeat = path.join(caseDir, 'heartbeat.json')
  const ready = path.join(caseDir, 'ready.json')
  const log = path.join(caseDir, 'helper.log')
  fs.writeFileSync(heartbeat, JSON.stringify({ at: Date.now() }), 'utf8')

  const helperProc = spawn(helper, [
    '--heartbeat', heartbeat,
    '--ready-file', ready,
    '--job-name', `fang-e2e-${name}`,
    '--host-pid', String(process.pid),
    '--heartbeat-timeout-ms', '60000',
    '--heartbeat-grace-ms', '30000',
    '--log', log,
    ...extraArgs,
    '--', process.execPath, '-e', childCode,
  ], { windowsHide: true, stdio: 'ignore' })

  let helperPid = 0
  let childPid = 0
  try {
    await waitFor(() => fs.existsSync(ready), 15000, `${name}: ready.json`)
    const data = readJson(ready)
    helperPid = Number(data?.helperPid) || 0
    childPid = Number(data?.childPid) || 0
    if (!helperPid || !childPid) throw new Error(`${name}: bad ready.json: ${JSON.stringify(data)}`)
    await waitFor(() => alive(childPid), 5000, `${name}: child alive`)

    if (expectChildExit) {
      await waitFor(() => helperProc.exitCode !== null, 20000, `${name}: helper exit after memory limit`)
      if (helperProc.exitCode === 0) throw new Error(`${name}: expected nonzero child exit, got 0`)
      await waitFor(() => !alive(childPid), 5000, `${name}: child gone after limit`)
      console.log(`PASS ${name} helper=${helperPid} child=${childPid} exit=${helperProc.exitCode} (memory limit enforced)`)
      return
    }

    // Kill only the helper. The Job handle closes; Windows must terminate the
    // child. Do NOT use taskkill /T, which would prove tree-kill instead.
    process.kill(helperPid)
    await waitFor(() => !alive(childPid), 15000, `${name}: child killed by job close`)
    console.log(`PASS ${name} helper=${helperPid} child=${childPid} (kill-on-close)`)
  } catch (error) {
    console.error(`FAIL ${error?.message ?? error}`)
    if (helperPid && alive(helperPid)) {
      try { process.kill(helperPid) } catch { /* best effort */ }
    }
    if (childPid && alive(childPid)) {
      try { spawnSync('taskkill', ['/PID', String(childPid), '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* best effort */ }
    }
    try { console.error(fs.readFileSync(log, 'utf8').slice(-2000)) } catch { /* ignore */ }
    throw error
  } finally {
    try { helperProc.kill() } catch { /* ignore */ }
  }
}

try {
  await runCase('kill-on-close', { childCode: childScript })
  if (memory) {
    await runCase('job-memory-64mb', {
      childCode: memoryChild,
      extraArgs: ['--job-memory-mb', '64'],
      expectChildExit: true,
    })
    await runCase('process-memory-64mb', {
      childCode: memoryChild,
      extraArgs: ['--job-process-memory-mb', '64'],
      expectChildExit: true,
    })
  }
  console.log('PASS job-object-e2e')
  process.exit(0)
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}
