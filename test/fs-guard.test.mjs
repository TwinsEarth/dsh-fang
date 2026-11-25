// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertInside, safeJoin } from '../src/lib/fs-guard.mjs'

test('safeJoin keeps paths inside root', () => {
  const root = path.join(os.tmpdir(), 'fang-guard-root')
  assert.equal(safeJoin(root, 'a', 'b'), path.join(root, 'a', 'b'))
  assert.throws(() => safeJoin(root, '..', 'mirror'), /path-escape/)
  assert.throws(() => safeJoin(root, 'C:\\Windows'), /path-escape/)
  assert.throws(() => safeJoin(root, 'a\0b'), /path-escape/)
})

test('assertInside rejects traversal and accepts nested file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-guard-'))
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(root, 'sessions', 'a.jsonl'), '{}\n')
  assert.equal(assertInside(root, path.join(root, 'sessions', 'a.jsonl')), path.join(root, 'sessions', 'a.jsonl'))
  assert.throws(() => assertInside(root, path.join(root, '..', 'mirror')), /path-escape/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('symlink escape is rejected when symlinks are available', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-guard-link-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-guard-outside-'))
  try {
    fs.symlinkSync(outside, path.join(root, 'link'), 'junction')
  } catch {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
    return // Windows without symlink privilege: covered by lexical tests above
  }
  assert.throws(() => assertInside(root, path.join(root, 'link')), /path-escape/)
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})
