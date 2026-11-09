// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T4 — restart-watchdog（C 方案外部看护）
// 覆盖：argv 解析、pid 文件读取、marker 心跳、dry-run 不重启、no-approved-restart 不干预、
//       execute 重启 + 写回执 + previousPid/replacementPid、max-relaunches、marker 清理。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import {
  approvalFile,
  buildApprovalManifest,
  readExecutionReceipt,
  receiptFile,
  verifyExecutionReceipt,
} from '../src/lib/restart-contract.mjs'
import {
  clearSupervisorMarker,
  dataDirForWatchdog,
  markerFileFor,
  parseWatchdogArgs,
  readHostPid,
  readMotherEndpoint,
  readMotherToken,
  resolveAutostartPreference,
  watch,
  writeSupervisorMarker,
} from '../tools/restart-watchdog.mjs'
import { writeForkSupervisionSettings } from '../src/lib/fork-supervision-settings.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fang-restart-watchdog-'))
const now = Date.now()

function armedManifest(pid) {
  return buildApprovalManifest({
    id: 'rst_watch1',
    risk: 'red',
    outcome: 'approved',
    approvalId: 'apr_watch1',
    approvedBy: 'tester',
    reason: 'watchdog test',
    scope: 'process',
    origin: 'supervisor',
    digests: ['sha256:d'],
    requestedAt: now - 10,
    approvedAt: now,
    ttlMs: 60000,
    guard: {
      mode: 'enforce', authMode: 'manual', strictRedLine: true,
      allowProcessRestart: true, pid, instanceId: 'inst_watchdog',
    },
  })
}

function writeManifest(stateDir, manifest) {
  const file = approvalFile(stateDir, manifest.id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(manifest), 'utf8')
}

function writePidFile(file, pid) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ version: 1, pid, at: Date.now() }), 'utf8')
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  const pid = child.pid
  await new Promise((resolve) => child.once('exit', resolve))
  return pid
}

async function waitFor(fn, { timeout = 8000, interval = 30 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error('waitFor timeout')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('parseWatchdogArgs: dry-run default, relaunch command after --', () => {
  const parsed = parseWatchdogArgs(['--data-root', 'E:\\tmp\\fang', '--', 'node', 'app.mjs'])
  assert.equal(parsed.options.execute, false, 'default is dry-run')
  assert.equal(parsed.options.pollMs, 2000)
  assert.equal(parsed.options.maxRelaunches, 3)
  assert.deepEqual(parsed.relaunch, ['node', 'app.mjs'])

  const execute = parseWatchdogArgs([
    '--execute', '--data-root=E:\\tmp\\fang', '--pid-file', 'E:\\tmp\\host.pid',
    '--poll-ms=20', '--max-relaunches', '2', '--startup-timeout-ms', '900',
    '--supervisor-id', 'wd-test', '--log', 'E:\\tmp\\wd.jsonl', '--', 'node', 'app.mjs',
  ])
  assert.equal(execute.options.execute, true)
  assert.equal(execute.options.dataRoot, 'E:\\tmp\\fang')
  assert.equal(execute.options.pidFile, 'E:\\tmp\\host.pid')
  assert.equal(execute.options.pollMs, 20)
  assert.equal(execute.options.maxRelaunches, 2)
  assert.equal(execute.options.startupTimeoutMs, 900)
  assert.equal(execute.options.supervisorId, 'wd-test')
  assert.equal(execute.options.log, 'E:\\tmp\\wd.jsonl')
  assert.equal(parseWatchdogArgs(['--help']).help, true)

  assert.throws(() => parseWatchdogArgs(['--bogus', '--', 'node']), /unknown option/)
  assert.throws(() => parseWatchdogArgs(['--execute']), /missing relaunch command/)
  assert.throws(() => parseWatchdogArgs(['--poll-ms', '1', '--', 'node']), /--poll-ms/)
  assert.throws(() => parseWatchdogArgs(['--max-relaunches', '21', '--', 'node']), /--max-relaunches/)

  // 分身自动启动选项
  assert.equal(parseWatchdogArgs(['--', 'node']).options.autostartForks, null, '默认随 --execute 决定')
  const auto = parseWatchdogArgs(['--execute', '--autostart-forks', '--mother-url=http://127.0.0.1:1', '--token=t', '--', 'node'])
  assert.equal(auto.options.autostartForks, true)
  assert.equal(auto.options.motherUrl, 'http://127.0.0.1:1')
  assert.equal(auto.options.token, 't')
  assert.equal(parseWatchdogArgs(['--no-autostart-forks', '--', 'node']).options.autostartForks, false)
})

test('mother endpoint/token discovery: explicit wins, else <dataDir>/endpoint.json + fang-auth.json', () => {
  const root = tmp()
  try {
    fs.writeFileSync(path.join(root, 'endpoint.json'), JSON.stringify({ url: 'http://127.0.0.1:3999/' }), 'utf8')
    fs.writeFileSync(path.join(root, 'fang-auth.json'), JSON.stringify({ token: 'file-token' }), 'utf8')
    assert.equal(readMotherEndpoint({ dataRoot: root }), 'http://127.0.0.1:3999')
    assert.equal(readMotherToken({ dataRoot: root }), 'file-token')
    assert.equal(readMotherEndpoint({ dataRoot: root, motherUrl: 'http://127.0.0.1:4000/' }), 'http://127.0.0.1:4000')
    assert.equal(readMotherToken({ dataRoot: root, token: 'explicit' }), 'explicit')
    assert.equal(readMotherEndpoint({ dataRoot: path.join(root, 'missing') }), '')
    assert.equal(readMotherToken({ dataRoot: path.join(root, 'missing'), token: '' }), '')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('readHostPid accepts JSON and plain text; marker write/clear is pid-scoped', () => {
  const root = tmp()
  try {
    const pidFile = path.join(root, 'fang.pid')
    fs.writeFileSync(pidFile, JSON.stringify({ pid: 1234 }), 'utf8')
    assert.equal(readHostPid(pidFile), 1234)
    fs.writeFileSync(pidFile, '5678\n', 'utf8')
    assert.equal(readHostPid(pidFile), 5678)
    fs.writeFileSync(pidFile, 'not-a-pid', 'utf8')
    assert.equal(readHostPid(pidFile), null)
    assert.equal(readHostPid(path.join(root, 'missing.pid')), null)

    const stateDir = path.join(root, 'restart')
    const marker = writeSupervisorMarker(stateDir, { pid: process.pid, execute: true, supervisor: 'wd-test' })
    assert.equal(marker, markerFileFor(stateDir))
    const body = JSON.parse(fs.readFileSync(marker, 'utf8'))
    assert.equal(body.execute, true)
    assert.equal(body.pid, process.pid)
    assert.equal(body.supervisor, 'wd-test')
    // 别的 pid 不得删掉我们的 marker
    clearSupervisorMarker(stateDir, { pid: process.pid + 1 })
    assert.equal(fs.existsSync(marker), true)
    clearSupervisorMarker(stateDir, { pid: process.pid })
    assert.equal(fs.existsSync(marker), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('watchdog autostart preference: settings are default, CLI overrides, dry-run never autostarts', () => {
  const dataRoot = tmp()
  try {
    const dataDir = dataDirForWatchdog({ dataRoot })
    assert.equal(resolveAutostartPreference({ dataRoot, execute: true }).want, true, 'default settings autostart=true')
    assert.equal(resolveAutostartPreference({ dataRoot, execute: false }).want, false, 'dry-run must not autostart')

    writeForkSupervisionSettings(dataDir, { autostartForks: false })
    const disabled = resolveAutostartPreference({ dataRoot, execute: true })
    assert.equal(disabled.want, false)
    assert.equal(disabled.source, 'settings')

    const cliOn = resolveAutostartPreference({ dataRoot, execute: true, autostartForks: true })
    assert.equal(cliOn.want, true)
    assert.equal(cliOn.source, 'cli')
    const cliOff = resolveAutostartPreference({ dataRoot, execute: true, autostartForks: false })
    assert.equal(cliOff.want, false)
    assert.equal(cliOff.source, 'cli')
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('watch dry-run: dead host + approval => would-relaunch only, no marker, no spawn', async () => {
  const root = tmp()
  const stateDir = path.join(root, 'restart')
  const pidFile = path.join(root, 'fang.pid')
  const relaunchMark = path.join(root, 'relaunched.txt')
  try {
    const pid = await deadPid()
    writePidFile(pidFile, pid)
    const manifest = armedManifest(pid)
    writeManifest(stateDir, manifest)

    const result = await watch({
      relaunch: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(relaunchMark)}, 'x')`],
      options: {
        execute: false, dataRoot: root, pidFile, stateDir,
        pollMs: 20, log: path.join(root, 'watchdog.jsonl'),
      },
    })
    assert.equal(result.stopped, 'dry-run')
    assert.equal(result.deadPid, pid)
    assert.equal(result.manifestId, manifest.id)
    assert.equal(result.relaunches, 0)
    assert.equal(fs.existsSync(relaunchMark), false, 'dry-run must not run the relaunch command')
    assert.equal(fs.existsSync(markerFileFor(stateDir)), false, 'dry-run must not advertise a supervisor')
    await sleep(100)
    assert.equal(fs.existsSync(relaunchMark), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('watch execute: no approval => never relaunches', async () => {
  const root = tmp()
  const stateDir = path.join(root, 'restart')
  const pidFile = path.join(root, 'fang.pid')
  const relaunchMark = path.join(root, 'relaunched.txt')
  try {
    const pid = await deadPid()
    writePidFile(pidFile, pid)
    const result = await watch({
      relaunch: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(relaunchMark)}, 'x')`],
      options: { execute: true, dataRoot: root, pidFile, stateDir, pollMs: 20, log: path.join(root, 'watchdog.jsonl') },
    })
    assert.equal(result.stopped, 'no-approved-restart')
    assert.equal(result.reason, 'no-approval')
    assert.equal(result.relaunches, 0)
    assert.equal(fs.existsSync(relaunchMark), false)
    assert.equal(fs.existsSync(markerFileFor(stateDir)), false, 'marker must be cleaned up on exit')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('watch execute: max-relaunches=0 stops without spawning', async () => {
  const root = tmp()
  const stateDir = path.join(root, 'restart')
  const pidFile = path.join(root, 'fang.pid')
  try {
    const pid = await deadPid()
    writePidFile(pidFile, pid)
    const manifest = armedManifest(pid)
    writeManifest(stateDir, manifest)
    const result = await watch({
      relaunch: [process.execPath, '-e', 'process.exit(0)'],
      options: {
        execute: true, maxRelaunches: 0, dataRoot: root, pidFile, stateDir,
        pollMs: 20, log: path.join(root, 'watchdog.jsonl'),
      },
    })
    assert.equal(result.stopped, 'max-relaunches')
    assert.equal(result.relaunches, 0)
    assert.equal(fs.existsSync(receiptFile(stateDir, manifest.id)), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('watch execute: boot-guard block stops before spawning', async () => {
  const root = tmp()
  const stateDir = path.join(root, 'restart')
  const pidFile = path.join(root, 'fang.pid')
  try {
    const pid = await deadPid()
    writePidFile(pidFile, pid)
    writeManifest(stateDir, armedManifest(pid))
    let spawned = 0
    const result = await watch({
      relaunch: [process.execPath, '-e', 'process.exit(0)'],
      options: {
        execute: true, dataRoot: root, pidFile, stateDir,
        pollMs: 20, log: path.join(root, 'watchdog.jsonl'),
      },
      guard: async () => ({ ok: false, error: 'candidate-import-boom' }),
      spawnImpl: () => { spawned += 1; return { pid: 12345, unref() {}, on() {} } },
    })
    assert.equal(result.stopped, 'boot-guard-blocked')
    assert.equal(result.reason, 'candidate-import-boom')
    assert.equal(spawned, 0)
    assert.equal(fs.existsSync(receiptFile(stateDir, result.manifestId)), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('watch execute: relaunches, waits for new host pid, writes receipt with both pids', async (t) => {
  const root = tmp()
  const stateDir = path.join(root, 'restart')
  const pidFile = path.join(root, 'fang.pid')
  const relaunchPidFile = path.join(root, 'relaunch.pid')
  try {
    const pid = await deadPid()
    writePidFile(pidFile, pid)
    const manifest = armedManifest(pid)
    writeManifest(stateDir, manifest)

    // 假宿主：写出自己的 pid，然后活 3s，让 watchdog 能确认 replacementPid。
    const relaunchScript = `
import fs from 'node:fs'
fs.writeFileSync(${JSON.stringify(relaunchPidFile)}, JSON.stringify({ pid: process.pid }))
fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ version: 1, pid: process.pid, at: Date.now() }))
setTimeout(() => {}, 3000)
`
    const ac = new AbortController()
    const events = []
    const running = watch({
      relaunch: [process.execPath, '--input-type=module', '-e', relaunchScript],
      options: {
        execute: true, dataRoot: root, pidFile, stateDir, pollMs: 30,
        startupTimeoutMs: 5000, log: path.join(root, 'watchdog.jsonl'), supervisorId: 'wd-test',
      },
      signal: ac.signal,
      sleepFn: sleep,
      logSink: (event, data) => events.push({ event, data }),
    })

    await waitFor(() => fs.existsSync(receiptFile(stateDir, manifest.id)) ? true : false, { timeout: 10000 })
    assert.equal(fs.existsSync(markerFileFor(stateDir)), true, 'marker must exist while watching')
    ac.abort()
    const result = await running
    assert.equal(result.stopped, 'aborted')
    assert.equal(result.relaunches, 1)
    assert.ok(events.some(e => e.event === 'relaunched'))

    const receipt = readExecutionReceipt(stateDir, manifest.id)
    assert.ok(receipt, 'relaunch must leave an execution receipt')
    assert.equal(receipt.execution.executed, true)
    assert.equal(receipt.execution.previousPid, pid)
    const relaunchPid = JSON.parse(fs.readFileSync(relaunchPidFile, 'utf8')).pid
    assert.equal(receipt.execution.replacementPid, relaunchPid, 'receipt must point at the new host pid')
    assert.equal(verifyExecutionReceipt(receipt, { manifest }).ok, true)
    assert.equal(fs.existsSync(markerFileFor(stateDir)), false, 'marker must be cleaned up on abort')

    try { process.kill(relaunchPid, 'SIGTERM') } catch { /* already gone */ }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function withHttpServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

test('watch execute: autostarts forks once via POST /fang/api/forks/autostart', async () => {
  const root = tmp()
  const stateDir = path.join(root, 'restart')
  const pidFile = path.join(root, 'fang.pid')
  writePidFile(pidFile, process.pid) // 宿主活着
  const calls = []
  const server = await withHttpServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers['x-fang-auth'], body: raw })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        started: [{ taskId: 't1' }, { taskId: 't2' }],
        failed: [],
        skipped: [{ taskId: 't3', reason: 'archived' }],
      }))
    })
  })
  try {
    const ac = new AbortController()
    const running = watch({
      relaunch: [process.execPath, '-e', 'process.exit(0)'],
      options: {
        execute: true, pidFile, stateDir, pollMs: 20,
        motherUrl: server.url, token: 'test-token', autostartForks: true,
        log: path.join(root, 'watchdog.jsonl'),
      },
      signal: ac.signal,
      sleepFn: sleep,
    })
    await waitFor(() => calls.length >= 1, { timeout: 8000 })
    ac.abort()
    const result = await running
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].url, '/fang/api/forks/autostart')
    assert.equal(calls[0].auth, 'test-token')
    assert.equal(result.autostart.requested, true)
    assert.equal(result.autostart.ok, true)
    assert.equal(result.autostart.started, 2)
    assert.equal(result.autostart.skipped, 1)
    assert.equal(calls.length, 1, 'autostart must happen once, not every poll')
  } finally {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('watch dry-run: reports would-autostart-forks without HTTP or side effects', async () => {
  const root = tmp()
  const stateDir = path.join(root, 'restart')
  const pidFile = path.join(root, 'fang.pid')
  writePidFile(pidFile, process.pid)
  try {
    const events = []
    const ac = new AbortController()
    const running = watch({
      relaunch: [process.execPath, '-e', 'process.exit(0)'],
      options: {
        execute: false, pidFile, stateDir, pollMs: 20, autostartForks: true,
        log: path.join(root, 'watchdog.jsonl'),
      },
      signal: ac.signal,
      sleepFn: sleep,
      logSink: (event) => events.push(event),
    })
    await waitFor(() => events.includes('would-autostart-forks'), { timeout: 5000 })
    ac.abort()
    const result = await running
    assert.equal(result.stopped, 'aborted')
    assert.deepEqual(result.autostart, { requested: false, reason: 'dry-run' })
    assert.equal(fs.existsSync(markerFileFor(stateDir)), false, 'dry-run must not write a supervisor marker')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
