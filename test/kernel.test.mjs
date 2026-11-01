// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// kernel 单测：fsx（含 junction 安全删除）/ paths / rounds / ledger / bus。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { tmpDir, writeTempFile } from './helpers.mjs'
import {
  ensureDir, exists, readJson, writeJsonAtomic, appendJsonl, digestTree, diffDigests,
  copyTree, removeTree, makeJunction, isLink, listFiles, sha256,
  parseWebUrl, detectProfileTag, resolveDshHome, resolveFangLayout,
  createRounds, appendChained, verifyChain, bus, diffResources, totalResources,
  EXIT, SERVICE, ROW, FORK_STATUS, FANG_VERSION,
} from '../src/kernel/index.mjs'

function mkRounds() {
  return createRounds({
    readdirSync: fs.readdirSync,
    statSync: fs.statSync,
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    mkdirSync: fs.mkdirSync,
    copyFileSync: fs.copyFileSync,
    unlinkSync: fs.unlinkSync,
    existsSync: fs.existsSync,
  })
}

test('fsx: atomic json roundtrip + jsonl append', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'state.json')
  writeJsonAtomic(file, { a: 1, b: [2, 3] })
  assert.deepEqual(readJson(file), { a: 1, b: [2, 3] })
  assert.equal(readJson(path.join(dir, 'missing.json'), 'fallback'), 'fallback')

  const log = path.join(dir, 'audit.jsonl')
  appendJsonl(log, { kind: 'a' })
  appendJsonl(log, { kind: 'b' })
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 2)
  assert.equal(sha256('x').length, 64)
  removeTree(dir)
})

test('fsx: removeTree is junction-safe (never enters the target)', () => {
  const root = tmpDir()
  const target = path.join(root, 'target')
  writeTempFile(path.join(target, 'keep.txt'), 'do not delete me')
  const home = path.join(root, 'forkhome')
  ensureDir(home)
  const link = path.join(home, 'node_modules')
  makeJunction(target, link)
  assert.equal(isLink(link), true, 'junction must be recognised as a link')

  removeTree(home)

  assert.equal(exists(home), false, 'fork home removed')
  assert.equal(exists(path.join(target, 'keep.txt')), true, 'junction target untouched')
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'do not delete me')
  removeTree(root)
})

test('fsx: digestTree + diffDigests detect change/add/remove', () => {
  const dir = tmpDir()
  writeTempFile(path.join(dir, 'a.js'), 'v1')
  const before = digestTree(dir)
  assert.equal(Object.keys(before).length, 1)

  writeTempFile(path.join(dir, 'a.js'), 'v2')
  writeTempFile(path.join(dir, 'b.js'), 'new')
  const after = digestTree(dir)
  const diff = diffDigests(before, after)
  assert.deepEqual(diff.changed, ['a.js'])
  assert.deepEqual(diff.added, ['b.js'])
  assert.deepEqual(diff.removed, [])

  fs.unlinkSync(path.join(dir, 'b.js'))
  const diff2 = diffDigests(after, digestTree(dir))
  assert.deepEqual(diff2.removed, ['b.js'])

  const parent = tmpDir()
  const copy = path.join(parent, 'copy')
  copyTree(dir, copy)
  assert.deepEqual(listFiles(copy), ['a.js'])

  // copying into a directory inside the source must terminate (no self-recursion)
  const inner = path.join(dir, 'inner-copy')
  copyTree(dir, inner)
  assert.deepEqual(listFiles(inner), ['a.js'])

  removeTree(parent)
  removeTree(dir)
})

test('paths: parseWebUrl only accepts the tokenized line, never the bare URL', () => {
  const tokenized = 'dsh web: http://127.0.0.1:58904/?token=abc123'
  assert.deepEqual(parseWebUrl(tokenized), {
    url: 'http://127.0.0.1:58904/?token=abc123', port: 58904, token: 'abc123',
  })
  assert.equal(parseWebUrl('dsh web: http://127.0.0.1:58904/'), null, 'bare URL is 401, not usable')
  assert.equal(parseWebUrl('noise'), null)
})

test('paths: profile tag and DSH_HOME resolution precedence', () => {
  assert.equal(detectProfileTag(['node', 'x', '--profile', 'web'], {}), 'web')
  assert.equal(detectProfileTag(['node', '--profile=desk'], {}), 'desk')
  assert.equal(detectProfileTag(['node'], { DSH_PROFILE: 'envprof' }), 'envprof')
  assert.equal(detectProfileTag(['C:/x/profiles/frompath/index.js'], {}), 'frompath')
  assert.equal(detectProfileTag(['node'], {}), 'default')

  assert.equal(resolveDshHome({ DSH_HOME: 'D:\\h' }), path.resolve('D:\\h'))
  assert.ok(resolveDshHome({}).endsWith('.dsh'))

  const layout = resolveFangLayout({ dataRoot: 'C:\\data', env: { DSH_HOME: 'C:\\home' } })
  assert.equal(layout.dataDir, path.resolve('C:\\data'))
  assert.ok(layout.ledgerFile.endsWith('audit.jsonl'))
  assert.ok(layout.bufferDir.includes('buffer'))
  assert.ok(layout.forksFile.endsWith('forks.json'))

  const derived = resolveFangLayout({ env: { DSH_HOME: 'C:\\home', DSH_PROFILE: 'pp' } })
  assert.ok(derived.dataDir.endsWith(path.join('fang', 'pp')))
})

test('rounds: begin round snapshots, reset restores the pre-image', () => {
  const rounds = mkRounds()
  const staging = tmpDir()
  writeTempFile(path.join(staging, 'plug', 'index.js'), 'v1')
  writeTempFile(path.join(staging, 'plug', 'extra.js'), 'keep')

  const begun = rounds.beginRound({ stagingDir: staging, name: 'plug', note: 't' })
  assert.equal(begun.ok, true)
  assert.equal(begun.files, 2)
  assert.equal(rounds.listRounds({ stagingDir: staging, name: 'plug' }).length, 1)

  writeTempFile(path.join(staging, 'plug', 'index.js'), 'v2')
  const reset = rounds.resetRound({ stagingDir: staging, name: 'plug' })
  assert.equal(reset.ok, true)
  assert.equal(reset.clean, true)
  assert.equal(fs.readFileSync(path.join(staging, 'plug', 'index.js'), 'utf8'), 'v1')
  removeTree(staging)
})

test('ledger: chained append verifies, tampering is detected', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'audit.jsonl')
  appendChained(file, { kind: 'boot', at: 'T0' })
  appendChained(file, { kind: 'fork-started', at: 'T1' })
  const ok = verifyChain(file)
  assert.equal(ok.ok, true)
  assert.equal(ok.count, 2)

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  const tampered = JSON.parse(lines[1])
  tampered.at = 'T1-tampered'
  lines[1] = JSON.stringify(tampered)
  fs.writeFileSync(file, lines.join('\n') + '\n')
  assert.equal(verifyChain(file).ok, false, 'tamper must break the chain')
  removeTree(dir)
})

test('bus: emit is fault-isolated, clear resets listeners', () => {
  let hits = 0
  const off = bus.on('t', () => { hits++ })
  bus.on('t', () => { throw new Error('listener exploded') })
  assert.equal(bus.emit('t', {}), 1)
  assert.equal(hits, 1)
  off()
  assert.equal(bus.emit('t', {}), 0, 'throwing listener does not break emit and is not counted')
  assert.equal(bus.listenerCount('t'), 1)
  bus.clear()
  assert.equal(bus.emit('t', {}), 0)
})

test('core: resource diff and shared vocabulary', () => {
  const diff = diffResources({ a: 1, b: 2 }, { a: 3, b: 1 })
  assert.deepEqual(diff.added, { a: 2 })
  assert.deepEqual(diff.removed, { b: 1 })
  assert.equal(diff.leakedRefed, 2)
  assert.equal(totalResources({ a: 1, b: 2 }), 3)
  assert.equal(EXIT.RESTART, 75)
  assert.equal(FANG_VERSION, '2.7.2')
  assert.equal(SERVICE.orchestrator, 'fang')
  assert.equal(ROW.orchestrator, 'fang-orchestrator')
  assert.equal(FORK_STATUS.RUNNING, 'running')
})
