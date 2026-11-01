// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T8 — container host tests.
//
// The AppContainer executor is a WINDOWS-ONLY fallback and unit tests must never launch
// a real container (contract §7). This file therefore:
//   * skips itself on non-Windows hosts or when no PowerShell is on PATH (reason printed);
//   * exercises only the honest degradation paths (disabled / unavailable / timeout) plus
//     injected-execFile behaviours — no real PowerShell process is spawned;
//   * runs one manual live probe only when FANG_CONTAINER_LIVE=1 is set explicitly.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createContainerHost } from '../src/lib/container/index.mjs'
import { removeTree } from '../src/kernel/index.mjs'

function findPowerShell() {
  if (process.platform !== 'win32') {
    return { ok: false, reason: `non-windows:${process.platform} — the AppContainer executor requires Windows` }
  }
  const pathValue = process.env.PATH ?? process.env.Path ?? ''
  const dirs = pathValue.split(';').filter(Boolean)
  for (const name of ['powershell.exe', 'pwsh.exe']) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name)
      try {
        if (fs.existsSync(candidate)) return { ok: true, path: candidate }
      } catch {
        /* unreadable PATH entry */
      }
    }
  }
  return { ok: false, reason: 'powershell.exe/pwsh.exe not found on PATH' }
}

const PS = findPowerShell()
/** node:test skip option: `false` runs, a string prints as the skip reason. */
const SKIP = PS.ok ? false : PS.reason
const LIVE_SKIP = process.env.FANG_CONTAINER_LIVE === '1' ? false : 'manual live probe: set FANG_CONTAINER_LIVE=1 to run'
const opts = (extra = {}) => ({ skip: SKIP, ...extra })

const probeDir = path.resolve('probes')
const tmpDirs = []
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-t8-host-'))
  tmpDirs.push(dir)
  return dir
}
process.on('exit', () => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      removeTree(dir)
    } catch {
      /* ignore */
    }
  }
})

/** A fake ChildProcess good enough for the timeout/backstop path. */
function fakeChild() {
  return {
    stdin: { end() {} },
    killed: false,
    kill() {
      this.killed = true
    },
  }
}

test('non-Windows hosts report state=disabled and exec fails closed', opts(), async () => {
  const t = tmp()
  const host = createContainerHost({ platform: 'linux', probeDir: t, powershellPath: 'pwsh' })
  assert.equal(host.state, 'disabled')
  const available = host.available()
  assert.equal(available.ok, false)
  assert.equal(available.state, 'disabled')
  assert.match(available.reason, /^non-windows:/)
  const res = await host.exec({ code: 'console.log(1)' })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'disabled')
  assert.equal(res.exitCode, null)
  assert.deepEqual(res.writes, [])
  assert.equal(res.stdout, '')
  assert.equal(host.dispose().ok, true)
})

test('missing probe assets degrade to state=unavailable with a reason (never throws)', opts(), async () => {
  const host = createContainerHost({ probeDir: tmp() })
  assert.equal(host.state, 'unavailable')
  const available = host.available()
  assert.equal(available.ok, false)
  assert.equal(available.state, 'unavailable')
  assert.match(available.reason, /^probe-missing:/)
  assert.match(available.reason, /container-exec-pipe\.ps1/)
  const res = await host.exec({ code: 'console.log(1)' })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'unavailable')
  assert.equal(res.reason, available.reason)
  assert.deepEqual(res.writes, [])
})

test('missing PowerShell degrades to state=unavailable with a reason', opts(), async () => {
  const host = createContainerHost({ probeDir, powershellPath: 'definitely-missing-t8-powershell.exe' })
  assert.equal(host.state, 'unavailable')
  assert.match(host.available().reason, /^powershell-not-found:/)
  const res = await host.exec({ code: 'console.log(1)' })
  assert.equal(res.error, 'unavailable')
})

test('static preflight on this host is honest: ready means assets+PowerShell exist, not that a container ran', opts(), () => {
  const host = createContainerHost({ probeDir })
  assert.equal(host.state, 'ready', 'probeDir + PowerShell preflight should pass on this host')
  assert.equal(host.available().ok, true)
  assert.equal(host.available().reason, 'preflight-ok')
  assert.equal(host.probeDir, probeDir)
})

test('exec kills a hung runner and returns a structured timeout', opts(), async () => {
  let killed = false
  const host = createContainerHost({
    probeDir,
    execFileImpl(file, args, options, callback) {
      assert.equal(typeof options.timeout, 'number')
      const child = fakeChild()
      child.kill = () => {
        killed = true
      }
      return child // never calls back: the host backstop must settle the promise
    },
  })
  const started = Date.now()
  const res = await host.exec({ code: 'while(true){}', timeoutMs: 30 })
  const elapsed = Date.now() - started
  assert.equal(res.ok, false)
  assert.equal(res.error, 'timeout')
  assert.equal(res.exitCode, null)
  assert.deepEqual(res.writes, [])
  assert.equal(res.stdout, '')
  assert.equal(killed, true, 'the hung child must be killed')
  assert.ok(elapsed < 5000, `timeout must settle promptly (took ${elapsed}ms)`)
})

test('exec parses NDJSON proxy frames from stdout and applies declared writes via writeApplier', opts(), async () => {
  const bufferRoot = tmp()
  const applied = []
  let captured = null
  const stdout = [
    'codeLen=42 codeFile=C:\\Temp\\code.js',
    JSON.stringify({ op: 'ping', reqId: 'p1' }),
    JSON.stringify({ op: 'write', reqId: 'w1', path: 'plug/index.js', data: 'hello' }),
    JSON.stringify({ op: 'write', reqId: 'w2', path: 'other/evil.js', data: 'nope' }),
    JSON.stringify({ op: 'stat', reqId: 's1', path: 'plug/index.js' }),
    JSON.stringify({ op: 'write', reqId: 'w3', path: '../escape.js', data: 'nope' }),
    JSON.stringify({ ok: true, result: { answer: 42 } }),
  ].join('\n') + '\n'
  const host = createContainerHost({
    probeDir,
    bufferRoot,
    execFileImpl(file, args, options, callback) {
      captured = { file, args, options }
      process.nextTick(() => callback(null, stdout, ''))
      return fakeChild()
    },
    writeApplier({ target, bytes }, frame) {
      applied.push({ target, bytes, frame })
    },
  })
  const res = await host.exec({
    code: 'console.log("ignored by fake")',
    declaredWrites: [{ path: 'plug', reason: 'plugin tree' }],
    env: { FANG_TEST_FLAG: '1' },
    timeoutMs: 5000,
  })

  assert.equal(res.ok, true)
  assert.equal(res.exitCode, 0)
  assert.equal(res.stderr, '')
  assert.equal(res.stdout, stdout, 'raw stdout is preserved for diagnostics')
  assert.deepEqual(res.result, { answer: 42 }, 'the probe result is parsed from the last JSON line')
  assert.equal(captured.args.includes('-File'), true)
  assert.equal(captured.args.includes(path.join(probeDir, 'container-exec-pipe.ps1')), true)
  assert.equal(captured.args.includes('-CodeFile'), true)
  assert.equal(captured.args.includes('-ResultFile'), true)
  assert.equal(captured.options.env.FANG_TEST_FLAG, '1', 'per-exec env is merged into the child env')
  assert.equal(captured.options.env.FANG_DECLARED_WRITES, '["plug"]')
  assert.equal(captured.options.timeout, 5000)

  const byId = Object.fromEntries(res.writes.map((w) => [w.reqId, w]))
  assert.equal(res.writes.length, 5, 'ping + 3 writes + stat frames are collected')
  assert.equal(byId.p1.ok, true)
  assert.equal(byId.w1.ok, true)
  assert.equal(byId.w1.path, 'plug/index.js')
  assert.equal(byId.w1.target, path.join(path.resolve(bufferRoot), 'plug', 'index.js'))
  assert.equal(byId.w1.applied, true)
  assert.equal(applied.length, 1, 'only the declared write reaches the applier')
  assert.equal(applied[0].frame.reqId, 'w1')
  assert.equal(byId.w2.ok, false)
  assert.equal(byId.w2.reason, 'not-declared')
  assert.equal(byId.s1.ok, true, 'stat only needs a safe path, not a declaration')
  assert.equal(byId.s1.target, path.join(path.resolve(bufferRoot), 'plug', 'index.js'))
  assert.equal(byId.w3.ok, false)
  assert.equal(byId.w3.reason, 'dotdot-segment')
})

test('exec reports a failed probe as a structured failure (error/exitCode)', opts(), async () => {
  const host = createContainerHost({
    probeDir,
    execFileImpl(file, args, options, callback) {
      process.nextTick(() => callback(Object.assign(new Error('probe exploded'), { code: 2 }), '', 'stderr text'))
      return fakeChild()
    },
  })
  const res = await host.exec({ code: 'console.log(1)' })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'probe exploded')
  assert.equal(res.exitCode, 2)
  assert.equal(res.stderr, 'stderr text')
  assert.deepEqual(res.writes, [])
})

test('exec rejects empty code before spawning, and dispose is idempotent + fail-closed', opts(), async () => {
  let spawned = 0
  const host = createContainerHost({
    probeDir,
    execFileImpl(file, args, options, callback) {
      spawned++
      process.nextTick(() => callback(null, '{"ok":true,"result":null}\n', ''))
      return fakeChild()
    },
  })
  const empty = await host.exec({ code: '   ' })
  assert.equal(empty.ok, false)
  assert.equal(empty.error, 'empty-code')
  assert.equal(spawned, 0, 'no process for an empty code body')

  assert.equal(host.dispose().ok, true)
  assert.equal(host.dispose().ok, true, 'dispose is idempotent')
  const available = host.available()
  assert.equal(available.ok, false)
  assert.equal(available.reason, 'disposed')
  const after = await host.exec({ code: 'console.log(1)' })
  assert.equal(after.ok, false)
  assert.equal(after.error, 'disposed')
})

test('LIVE container probe (manual): real AppContainer exec when FANG_CONTAINER_LIVE=1', { skip: LIVE_SKIP, timeout: 180000 }, async () => {
  const bufferRoot = tmp()
  const applied = []
  const host = createContainerHost({
    probeDir,
    timeoutMs: 120000,
    bufferRoot,
    writeApplier({ target, bytes }) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, bytes)
      applied.push(target)
    },
  })
  assert.equal(host.state, 'ready')
  const code = [
    "const fs = require('node:fs')",
    "fs.writeFileSync('result.json', JSON.stringify({ via: 't8-live-container', pid: process.pid }))",
  ].join('\n')
  const res = await host.exec({ code, timeoutMs: 120000 })
  assert.equal(res.ok, true, `live container exec failed: ${res.error ?? ''} ${res.stderr ?? ''}`)
  assert.equal(res.result.via, 't8-live-container')
  assert.equal(typeof res.result.pid, 'number')

  // End-to-end declared write proxy: the container can only REPORT a write request;
  // the host validates it against the declaration and performs the write itself.
  const writeCode = [
    "const fs = require('node:fs')",
    "fs.writeFileSync('result.json', JSON.stringify({ via: 't8-live-write', writes: [",
    "  { op: 'write', reqId: 'live-w1', path: 'plug/live.txt', data: 'from-container' },",
    "  { op: 'write', reqId: 'live-w2', path: 'other/evil.txt', data: 'nope' },",
    "  { op: 'write', reqId: 'live-w3', path: '../escape.txt', data: 'nope' },",
    "] }))",
  ].join('\n')
  const writeRes = await host.exec({ code: writeCode, declaredWrites: [{ path: 'plug', reason: 'live probe' }], timeoutMs: 120000 })
  assert.equal(writeRes.ok, true, `live write-proxy exec failed: ${writeRes.error ?? ''}`)
  const byId = Object.fromEntries(writeRes.writes.map((w) => [w.reqId, w]))
  assert.equal(byId['live-w1'].ok, true)
  assert.equal(byId['live-w1'].applied, true)
  assert.equal(byId['live-w2'].ok, false)
  assert.equal(byId['live-w2'].reason, 'not-declared')
  assert.equal(byId['live-w3'].ok, false)
  assert.equal(byId['live-w3'].reason, 'dotdot-segment')
  assert.equal(applied.length, 1)
  assert.equal(fs.readFileSync(path.join(bufferRoot, 'plug', 'live.txt'), 'utf8'), 'from-container')
  assert.equal(fs.existsSync(path.join(bufferRoot, '..', 'escape.txt')), false)
  host.dispose()
})
