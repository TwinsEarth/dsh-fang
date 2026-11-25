// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendJsonlRotated, pruneJsonlArchives, rotateJsonlFile } from '../src/lib/log-rotation.mjs'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fang-log-rotation-'))
}

test('size rotation moves the active JSONL aside before exceeding maxBytes', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'samples.jsonl')
  const now = Date.UTC(2026, 10, 25, 2, 0, 0)
  assert.equal(appendJsonlRotated(file, { n: 1 }, { maxBytes: 20, retentionDays: 7, now }), true)
  assert.equal(appendJsonlRotated(file, { n: 2 }, { maxBytes: 20, retentionDays: 7, now }), true)
  assert.equal(appendJsonlRotated(file, { n: 3 }, { maxBytes: 20, retentionDays: 7, now }), true)
  const names = fs.readdirSync(dir)
  assert.ok(names.some((name) => name.startsWith('samples.jsonl.')), names.join(','))
  const active = fs.readFileSync(file, 'utf8')
  assert.equal(active.split('\n').filter(Boolean).length, 1)
  assert.match(active, /"n":3/)
})

test('prune removes rotated archives older than retentionDays and keeps recent ones', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'samples.jsonl')
  const now = Date.UTC(2026, 10, 25, 2, 0, 0)
  const old = path.join(dir, 'samples.jsonl.2026-11-10T00-00-00-000Z')
  const recent = path.join(dir, 'samples.jsonl.2026-11-24T00-00-00-000Z')
  fs.writeFileSync(old, '{}\n')
  fs.writeFileSync(recent, '{}\n')
  const oldTime = new Date(now - 20 * 24 * 60 * 60 * 1000)
  const recentTime = new Date(now - 1 * 24 * 60 * 60 * 1000)
  fs.utimesSync(old, oldTime, oldTime)
  fs.utimesSync(recent, recentTime, recentTime)
  const out = pruneJsonlArchives(file, { retentionDays: 7, now })
  assert.equal(out.removed, 1)
  assert.equal(fs.existsSync(old), false)
  assert.equal(fs.existsSync(recent), true)
})

test('rotation never throws when the target path is not writable', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'blocked.jsonl')
  fs.mkdirSync(file)
  assert.equal(appendJsonlRotated(file, { n: 1 }, { maxBytes: 8, retentionDays: 7 }), false)
})

test('rotateJsonlFile keeps existing archives when names collide', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'samples.jsonl')
  const now = Date.UTC(2026, 10, 25, 2, 0, 0)
  fs.writeFileSync(file, 'a\n')
  const first = rotateJsonlFile(file, now)
  fs.writeFileSync(file, 'b\n')
  const second = rotateJsonlFile(file, now)
  assert.notEqual(first, second)
  assert.equal(fs.existsSync(first), true)
  assert.equal(fs.existsSync(second), true)
})
