// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T4 — restart-supervisor（supervisor 契约的执行侧入口）
// 覆盖：argv 解析、pid 绑定的清单校验、回执写盘、dry-run / execute / denied / non-gated / max-restarts、
//       以及真实子进程 + 真实默认校验（清单由测试在子进程运行期间写入）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  approvalFile,
  buildApprovalManifest,
  readExecutionReceipt,
  receiptFile,
  verifyExecutionReceipt,
} from '../src/lib/restart-contract.mjs'
import {
  GATED_RESTART_EXIT,
  parseSupervisorArgs,
  startChild,
  supervise,
  verifyApprovalForPid,
  writeRestartReceipt,
} from '../tools/restart-supervisor.mjs'

const TMP_PREFIX = 'fang-restart-supervisor-'
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX))
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function armedManifest({
  id = 'rst_sup1', pid = 0, approvedAt = Date.now(), ttlMs = 60000,
  mode = 'enforce', allowProcessRestart = true, outcome = 'approved', approvalId = 'apr_x',
} = {}) {
  return buildApprovalManifest({
    id,
    risk: 'red',
    outcome,
    approvalId,
    approvedBy: 'tester',
    reason: 'supervisor test',
    scope: 'process',
    origin: 'supervisor',
    digests: ['sha256:d'],
    requestedAt: approvedAt - 10,
    approvedAt,
    ttlMs,
    guard: {
      mode, authMode: 'manual', strictRedLine: true,
      allowProcessRestart, pid, instanceId: 'inst_test',
    },
  })
}

function writeManifestAt(stateDir, manifest) {
  const file = approvalFile(stateDir, manifest.id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(manifest), 'utf8')
  return file
}

function writeChildScript(dir, name, body) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, body, 'utf8')
  return file
}

test('parseSupervisorArgs: defaults are dry-run, command must follow --', () => {
  const parsed = parseSupervisorArgs(['--', 'node', '-e', 'process.exit(0)'])
  assert.equal(parsed.options.execute, false, 'default is dry-run')
  assert.equal(parsed.options.maxRestarts, 5)
  assert.equal(parsed.options.backoffMs, 300)
  assert.equal(parsed.options.backoffMaxMs, 30000)
  assert.deepEqual(parsed.command, ['node', '-e', 'process.exit(0)'])

  const execute = parseSupervisorArgs([
    '--execute', '--data-root', 'E:\\tmp\\fang', '--max-restarts', '2',
    '--backoff-ms=10', '--backoff-max-ms', '20', '--supervisor-id', 'sup-test',
    '--log', 'E:\\tmp\\sup.jsonl', '--', 'node', 'app.mjs',
  ])
  assert.equal(execute.options.execute, true)
  assert.equal(execute.options.dataRoot, 'E:\\tmp\\fang')
  assert.equal(execute.options.maxRestarts, 2)
  assert.equal(execute.options.backoffMs, 10)
  assert.equal(execute.options.backoffMaxMs, 20)
  assert.equal(execute.options.supervisorId, 'sup-test')
  assert.equal(execute.options.log, 'E:\\tmp\\sup.jsonl')
  assert.deepEqual(execute.command, ['node', 'app.mjs'])
  assert.equal(parseSupervisorArgs(['--help']).help, true)

  assert.throws(() => parseSupervisorArgs(['--bogus', '--', 'node']), /unknown option/)
  assert.throws(() => parseSupervisorArgs(['--execute']), /missing command/)
  assert.throws(() => parseSupervisorArgs(['--max-restarts', 'many', '--', 'node']), /--max-restarts/)
  assert.throws(() => parseSupervisorArgs(['--max-restarts', '21', '--', 'node']), /--max-restarts/)
  assert.throws(() => parseSupervisorArgs(['--backoff-ms', '10', '--backoff-max-ms', '5', '--', 'node']), /backoff-max-ms/)
})

test('verifyApprovalForPid: armed + unexpired + pid match + no receipt is the only pass', () => {
  const root = tmp()
  const stateDir = path.join(root, 'restart')
  const now = Date.now()
  try {
    assert.equal(verifyApprovalForPid({ stateDir, pid: 100, now }).reason, 'no-approval')
    assert.equal(verifyApprovalForPid({ stateDir, pid: 0, now }).reason, 'invalid-pid')

    writeManifestAt(stateDir, armedManifest({ id: 'rst_pm', pid: 111, approvedAt: now - 1000 }))
    assert.equal(verifyApprovalForPid({ stateDir, pid: 100, now }).reason, 'pid-mismatch')

    const manifest = armedManifest({ id: 'rst_ok', pid: 222, approvedAt: now - 500 })
    writeManifestAt(stateDir, manifest)
    const ok = verifyApprovalForPid({ stateDir, pid: 222, now })
    assert.equal(ok.ok, true)
    assert.equal(ok.reason, null)
    assert.equal(ok.manifest.id, 'rst_ok')

    writeManifestAt(stateDir, armedManifest({ id: 'rst_unarmed', pid: 333, approvedAt: now - 400, allowProcessRestart: false }))
    assert.equal(verifyApprovalForPid({ stateDir, pid: 333, now }).reason, 'process-restart-disabled')
    assert.equal(verifyApprovalForPid({ stateDir, pid: 333, now }).ok, false)

    writeManifestAt(stateDir, armedManifest({ id: 'rst_exp', pid: 444, approvedAt: now - 120000, ttlMs: 1000 }))
    assert.equal(verifyApprovalForPid({ stateDir, pid: 444, now }).reason, 'expired')

    // 写回执后同一 pid 再退出 75 不许重复执行
    writeRestartReceipt({ stateDir, manifest, supervisorId: 'sup-test', executedAt: now, previousPid: 222, replacementPid: 999 })
    assert.equal(verifyApprovalForPid({ stateDir, pid: 222, now }).reason, 'already-executed')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('writeRestartReceipt: durable receipt binds nonce/digest and records pids', () => {
  const root = tmp()
  const stateDir = path.join(root, 'restart')
  const manifest = armedManifest({ id: 'rst_receipt', pid: 555 })
  try {
    const { receipt, file } = writeRestartReceipt({
      stateDir, manifest, supervisorId: 'sup-test',
      executedAt: Date.now(), previousPid: 555, replacementPid: 556,
    })
    assert.equal(file, receiptFile(stateDir, manifest.id))
    assert.equal(fs.existsSync(file), true, 'receipt must be durable')
    assert.equal(receipt.execution.executed, true)
    assert.equal(receipt.execution.previousPid, 555)
    assert.equal(receipt.execution.replacementPid, 556)
    assert.deepEqual(readExecutionReceipt(stateDir, manifest.id), receipt)
    assert.equal(verifyExecutionReceipt(receipt, { manifest }).ok, true, 'receipt must verify against the manifest')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('supervise: dry-run verifies the approval but never restarts', async (t) => {
  const root = tmp()
  const stateDir = path.join(root, 'restart')
  const child = writeChildScript(root, 'exit75.mjs', 'process.exit(75)\n')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const manifest = armedManifest({ id: 'rst_dry', pid: 0 })
  let verified = 0
  const result = await supervise({
    command: [process.execPath, child],
    options: { execute: false, stateDir, log: path.join(root, 'sup.jsonl') },
    verify: ({ stateDir: dir, pid }) => {
      verified++
      assert.equal(dir, stateDir)
      assert.ok(Number.isInteger(pid) && pid > 0)
      return { ok: true, manifest }
    },
  })
  assert.equal(verified, 1)
  assert.equal(result.runs, 1)
  assert.equal(result.restarts, 0)
  assert.equal(result.finalCode, GATED_RESTART_EXIT)
  assert.equal(result.stopped, 'dry-run')
  assert.deepEqual(result.wouldRestart, ['rst_dry'])
  assert.equal(fs.existsSync(receiptFile(stateDir, manifest.id)), false, 'dry-run must not write a receipt')
})

test('supervise: execute restarts only after a verified approval and writes receipts', async (t) => {
  const root = tmp()
  const stateDir = path.join(root, 'restart')
  const counter = path.join(root, 'runs.txt')
  const child = writeChildScript(root, 'exit75-twice.mjs', `
import fs from 'node:fs'
let n = 0
try { n = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) } catch {}
n++
fs.writeFileSync(${JSON.stringify(counter)}, String(n))
process.exit(n <= 2 ? ${GATED_RESTART_EXIT} : 0)
`)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  // 每次重启都需要一份新的授权（真实守卫每次请求写一份新清单）
  let seq = 0
  const manifests = []
  const result = await supervise({
    command: [process.execPath, child],
    options: {
      execute: true, maxRestarts: 5, backoffMs: 0, backoffMaxMs: 0,
      stateDir, log: path.join(root, 'sup.jsonl'),
    },
    sleepFn: async () => {},
    verify: () => {
      seq++
      const manifest = armedManifest({ id: `rst_exec${seq}`, pid: 0, approvedAt: Date.now() })
      manifests.push(manifest)
      return { ok: true, manifest }
    },
  })
  assert.equal(result.runs, 3)
  assert.equal(result.restarts, 2)
  assert.equal(result.finalCode, 0)
  assert.equal(result.stopped, 'clean-exit')
  assert.equal(result.receipts.length, 2)
  assert.equal(Number(fs.readFileSync(counter, 'utf8')), 3, 'child really ran three times')
  for (const { id, file } of result.receipts) {
    const receipt = readExecutionReceipt(stateDir, id)
    assert.ok(receipt, `receipt ${id} must exist at ${file}`)
    assert.equal(receipt.execution.executed, true)
    assert.equal(receipt.execution.exitCode, GATED_RESTART_EXIT)
    assert.equal(verifyExecutionReceipt(receipt, { manifest: manifests.find(m => m.id === id) }).ok, true)
  }
})

test('supervise: exit 75 without a verified approval is denied and not retried', async (t) => {
  const root = tmp()
  const counter = path.join(root, 'runs.txt')
  const child = writeChildScript(root, 'exit75.mjs', `
import fs from 'node:fs'
let n = 0
try { n = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) } catch {}
n++
fs.writeFileSync(${JSON.stringify(counter)}, String(n))
process.exit(${GATED_RESTART_EXIT})
`)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const result = await supervise({
    command: [process.execPath, child],
    options: { execute: true, stateDir: path.join(root, 'restart'), log: path.join(root, 'sup.jsonl') },
    sleepFn: async () => {},
    verify: () => ({ ok: false, reason: 'no-approval' }),
  })
  assert.equal(result.runs, 1)
  assert.equal(result.restarts, 0)
  assert.equal(result.stopped, 'restart-denied')
  assert.equal(result.deniedReason, 'no-approval')
  assert.equal(Number(fs.readFileSync(counter, 'utf8')), 1, 'no second run')
})

test('supervise: non-75 exit is never restarted, even when an approval exists', async (t) => {
  const root = tmp()
  const child = writeChildScript(root, 'exit1.mjs', 'process.exit(1)\n')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let verified = 0
  const result = await supervise({
    command: [process.execPath, child],
    options: { execute: true, stateDir: path.join(root, 'restart'), log: path.join(root, 'sup.jsonl') },
    sleepFn: async () => {},
    verify: () => { verified++; return { ok: true, manifest: armedManifest({ id: 'rst_no' }) } },
  })
  assert.equal(verified, 0, 'crash exit codes must not even reach authorization')
  assert.equal(result.runs, 1)
  assert.equal(result.restarts, 0)
  assert.equal(result.finalCode, 1)
  assert.equal(result.stopped, 'non-gated-exit')
})

test('supervise: max-restarts is enforced', async (t) => {
  const root = tmp()
  const child = writeChildScript(root, 'always75.mjs', 'process.exit(75)\n')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let seq = 0
  const result = await supervise({
    command: [process.execPath, child],
    options: {
      execute: true, maxRestarts: 2, backoffMs: 0, backoffMaxMs: 0,
      stateDir: path.join(root, 'restart'), log: path.join(root, 'sup.jsonl'),
    },
    sleepFn: async () => {},
    verify: () => {
      seq++
      return { ok: true, manifest: armedManifest({ id: `rst_max${seq}`, approvedAt: Date.now() }) }
    },
  })
  assert.equal(result.runs, 3)
  assert.equal(result.restarts, 2)
  assert.equal(result.stopped, 'max-restarts')
  assert.equal(result.finalCode, GATED_RESTART_EXIT)
})

test('supervise: spawn failure stops cleanly', async (t) => {
  const root = tmp()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const result = await supervise({
    command: [path.join(root, 'definitely-not-a-real-binary')],
    options: { execute: false, stateDir: path.join(root, 'restart'), log: path.join(root, 'sup.jsonl') },
    sleepFn: async () => {},
  })
  assert.equal(result.stopped, 'spawn-error')
  assert.equal(result.runs, 0)
  assert.ok(result.error)
})

test('startChild advances only on a real spawn event', async () => {
  const started = await startChild([process.execPath, '-e', 'process.exit(0)'])
  assert.equal(started.ok, true)
  assert.ok(Number.isInteger(started.pid) && started.pid > 0)
  await new Promise(resolve => started.child.once('exit', resolve))
})

test('supervise + real pid-bound approval: the supervisor only restarts its own child', async (t) => {
  const root = tmp()
  const stateDir = path.join(root, 'restart')
  const counter = path.join(root, 'runs.txt')
  const goFile = path.join(root, 'go.txt')
  const pidFile = (n) => path.join(root, `pid-${n}.txt`)
  const child = writeChildScript(root, 'wait-for-approval.mjs', `
import fs from 'node:fs'
const counter = ${JSON.stringify(counter)}
const go = ${JSON.stringify(goFile)}
let n = 0
try { n = Number(fs.readFileSync(counter, 'utf8')) } catch {}
n++
fs.writeFileSync(counter, String(n))
fs.writeFileSync(${JSON.stringify(path.join(root, 'pid-'))} + n + '.txt', String(process.pid))
if (n === 1) {
  const deadline = Date.now() + 5000
  while (!fs.existsSync(go)) {
    if (Date.now() > deadline) process.exit(1)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
  process.exit(${GATED_RESTART_EXIT})
}
process.exit(0)
`)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const running = supervise({
    command: [process.execPath, child],
    options: {
      execute: true, maxRestarts: 2, backoffMs: 0, backoffMaxMs: 0,
      stateDir, log: path.join(root, 'sup.jsonl'),
    },
  })

  // 等第一个子进程写出自己的 pid，再为这个 pid 写一份 armed 清单
  let firstPid = 0
  for (let i = 0; i < 250 && !firstPid; i++) {
    try { firstPid = Number(fs.readFileSync(pidFile(1), 'utf8')) } catch { /* not yet */ }
    if (!firstPid) await sleep(20)
  }
  assert.ok(firstPid > 0, 'child pid file must appear')
  const manifest = armedManifest({ id: 'rst_realpid', pid: firstPid, approvedAt: Date.now() })
  writeManifestAt(stateDir, manifest)
  fs.writeFileSync(goFile, 'go', 'utf8')

  const result = await running
  assert.equal(result.restarts, 1)
  assert.equal(result.runs, 2)
  assert.equal(result.stopped, 'clean-exit')
  assert.deepEqual(result.wouldRestart, ['rst_realpid'])
  assert.equal(result.receipts.length, 1)

  const receipt = readExecutionReceipt(stateDir, manifest.id)
  assert.ok(receipt, 'real restart must leave an execution receipt')
  assert.equal(receipt.execution.executed, true)
  assert.equal(receipt.execution.previousPid, firstPid)
  assert.ok(Number.isInteger(receipt.execution.replacementPid))
  assert.notEqual(receipt.execution.replacementPid, firstPid)
  assert.equal(verifyExecutionReceipt(receipt, { manifest }).ok, true)
  assert.equal(verifyApprovalForPid({ stateDir, pid: firstPid, now: Date.now() }).reason, 'already-executed')
})
