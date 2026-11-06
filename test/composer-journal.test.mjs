// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ComposerJournal } from '../src/lib/composer-journal.mjs'

test('composer journal persists draft and queue across instances', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-journal-'))
  const store = new ComposerJournal(dir)
  store.save('session-a', { draft: 'hello', queue: [{ text: 'second', at: 1 }], path: '/s/a' })
  const reopened = new ComposerJournal(dir)
  const entry = reopened.get('session-a')
  assert.equal(entry.draft, 'hello')
  assert.equal(entry.queue[0].text, 'second')
  assert.equal(entry.path, '/s/a')
  reopened.remove('session-a')
  assert.equal(new ComposerJournal(dir).get('session-a'), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('composer journal bounds draft, queue and NUL bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-journal-'))
  const store = new ComposerJournal(dir)
  const entry = store.save('k', { draft: 'a\0b', queue: Array.from({ length: 150 }, (_, i) => ({ text: 'm' + i })) })
  assert.equal(entry.draft.includes('\0'), false)
  assert.equal(entry.queue.length, 100)
  assert.throws(() => store.save('', {}), /journal-key-required/)
  fs.rmSync(dir, { recursive: true, force: true })
})
