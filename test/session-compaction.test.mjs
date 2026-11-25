// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { compactLegacySessions, compactSessionLog, compactTaskSessions, listSessionLogs, SESSION_LOG_FILE } from '../src/lib/session-compaction.mjs'

function zstd(buf, level = 1) {
  return zlib.zstdCompressSync(buf, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } })
}

function buildLog(lines) {
  return Buffer.concat(lines.map((line) => zstd(Buffer.from(line + '\n', 'utf8'))))
}

function decodedLines(file) {
  const buf = fs.readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === magic[0] && buf[i + 1] === magic[1] && buf[i + 2] === magic[2] && buf[i + 3] === magic[3]) offsets.push(i)
  }
  const bounds = [...new Set(offsets)].sort((a, b) => a - b)
  return Buffer.concat(bounds.map((start, i) => zlib.zstdDecompressSync(buf.subarray(start, bounds[i + 1] ?? buf.length)))).toString('utf8').trim().split('\n')
}

test('session compaction recompresses event frames and preserves decoded content', () => {
  if (typeof zlib.zstdCompressSync !== 'function') return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-compact-'))
  const dir = path.join(root, 'sessions', '--W--', 'session-abc')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, SESSION_LOG_FILE)
  const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega']
  let seed = 123456789
  const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed }
  const payload = Array.from({ length: 20000 }, () => words[next() % words.length]).join(' ')
  const lines = [
    JSON.stringify({ type: 'session', version: 4, id: 'session-abc' }),
    ...Array.from({ length: 3 }, (_, i) => JSON.stringify({ type: 'assistant/message', seq: i, data: { text: payload + i } })),
  ]
  fs.writeFileSync(file, buildLog(lines))
  const before = fs.statSync(file).size
  const out = compactSessionLog(file, { minBytes: 1, level: 9 })
  assert.equal(out.ok, true)
  assert.equal(out.compacted, true)
  assert.ok(out.afterBytes < before)
  assert.ok(fs.existsSync(out.backup))
  assert.deepEqual(decodedLines(file), lines)
  assert.deepEqual(decodedLines(out.backup), lines)
  assert.equal(fs.statSync(file).size, out.afterBytes)
  const second = compactTaskSessions(root, { minBytes: 1, level: 9 })
  assert.equal(second.candidates, 0, 'a compacted file must not be re-read on the next sweep')
  fs.rmSync(root, { recursive: true, force: true })
})

test('session compaction leaves files untouched below threshold and on no gain', () => {
  if (typeof zlib.zstdCompressSync !== 'function') return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-compact-skip-'))
  const dir = path.join(root, 'sessions', '--W--', 'session-skip')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, SESSION_LOG_FILE)
  fs.writeFileSync(file, buildLog([JSON.stringify({ type: 'session', version: 4 }), JSON.stringify({ type: 'x', n: 1 })]))
  const before = fs.readFileSync(file)
  const threshold = compactSessionLog(file, { minBytes: 4096 })
  assert.equal(threshold.ok, true)
  assert.equal(threshold.skipped, 'below-threshold')
  assert.deepEqual(fs.readFileSync(file), before)
  const noGain = compactSessionLog(file, { minBytes: 1, level: 1 })
  assert.equal(noGain.ok, true)
  assert.equal(noGain.skipped, 'no-gain')
  assert.deepEqual(fs.readFileSync(file), before)
  fs.rmSync(root, { recursive: true, force: true })
})

test('session compaction refuses a corrupt frame without replacing the original', () => {
  if (typeof zlib.zstdCompressSync !== 'function') return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-compact-corrupt-'))
  const dir = path.join(root, 'sessions', '--W--', 'session-corrupt')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, SESSION_LOG_FILE)
  const good = zstd(Buffer.from('{"type":"session"}\n'))
  const corrupt = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00])
  fs.writeFileSync(file, Buffer.concat([good, corrupt]))
  const before = fs.readFileSync(file)
  const out = compactSessionLog(file, { minBytes: 1, level: 9 })
  assert.equal(out.ok, true)
  assert.equal(out.compacted, undefined)
  assert.ok(out.skipped)
  assert.deepEqual(fs.readFileSync(file), before)
  fs.rmSync(root, { recursive: true, force: true })
})

test('compactTaskSessions scans sessions and quarantine-sessions only', () => {
  if (typeof zlib.zstdCompressSync !== 'function') return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-compact-task-'))
  const sessionDir = path.join(root, 'sessions', '--W--', 'session-one')
  const quarantineDir = path.join(root, 'quarantine-sessions', 'stamp', '--W--', 'session-two')
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.mkdirSync(quarantineDir, { recursive: true })
  const file = path.join(sessionDir, SESSION_LOG_FILE)
  fs.writeFileSync(file, buildLog([JSON.stringify({ type: 'session' }), JSON.stringify({ type: 'event', text: 'x'.repeat(2048) })]))
  fs.writeFileSync(path.join(quarantineDir, SESSION_LOG_FILE), buildLog([JSON.stringify({ type: 'session' }), JSON.stringify({ type: 'event', text: 'y'.repeat(2048) })]))
  const found = listSessionLogs(root)
  assert.equal(found.length, 2)
  const out = compactTaskSessions(root, { minBytes: 1, level: 9 })
  assert.equal(out.candidates, 2)
  assert.equal(out.failed, 0)
  fs.rmSync(root, { recursive: true, force: true })
})


test('compactLegacySessions only scans migrated legacy history', () => {
  if (typeof zlib.zstdCompressSync !== 'function') return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-compact-legacy-'))
  const liveDir = path.join(root, 'sessions', '--LIVE--', 'session-live')
  const legacyDir = path.join(root, 'sessions', 'migrated-2026-11-21', 'legacy', 'session-old')
  fs.mkdirSync(liveDir, { recursive: true })
  fs.mkdirSync(legacyDir, { recursive: true })
  const live = path.join(liveDir, SESSION_LOG_FILE)
  const legacy = path.join(legacyDir, SESSION_LOG_FILE)
  fs.writeFileSync(live, buildLog([JSON.stringify({ type: 'session' }), JSON.stringify({ type: 'event', text: 'live' })]))
  fs.writeFileSync(legacy, buildLog([JSON.stringify({ type: 'session' }), JSON.stringify({ type: 'event', text: 'old' })]))
  const beforeLive = fs.readFileSync(live)
  const out = compactLegacySessions(root, { minBytes: 1, level: 9 })
  assert.equal(out.candidates, 1)
  assert.equal(out.results.length, 1)
  assert.match(out.results[0].file, /legacy/)
  assert.deepEqual(fs.readFileSync(live), beforeLive)
  fs.rmSync(root, { recursive: true, force: true })
})
