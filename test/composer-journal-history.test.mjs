// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.1.21：composer journal 的 append-only 历史 + 会话键 + UTF-8 往返。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ComposerJournal } from '../src/lib/composer-journal.mjs'

function withJournal(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-journal-'))
  try { fn(new ComposerJournal(dir), dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

test('composer-journal: save returns entry and keeps per-session keys separate', () => withJournal((journal) => {
  const a = journal.save('session-a', { draft: '草稿A', queue: [{ text: '队列A-1' }] })
  const b = journal.save('session-b', { draft: '草稿B', queue: [{ text: '队列B-1' }, { text: '队列B-2' }] })
  assert.equal(a.key, 'session-a')
  assert.equal(b.key, 'session-b')
  assert.equal(journal.get('session-a').queue.length, 1)
  assert.equal(journal.get('session-b').queue.length, 2)
  // 关键：后写的不覆盖前写的（旧实现全部塌缩到 "/"）
  assert.equal(journal.get('session-a').draft, '草稿A')
}))

test('composer-journal: queue saves are appended to history (newest first)', () => withJournal((journal, dir) => {
  journal.save('s1', { draft: '', queue: [{ text: '第一条' }] })
  journal.save('s1', { draft: '', queue: [{ text: '第一条' }, { text: '第二条' }] })
  journal.save('s2', { draft: '', queue: [{ text: '另一个会话' }] })
  const history = journal.history({ limit: 10 })
  assert.ok(history.length >= 3, `history should contain 3 snapshots, got ${history.length}`)
  assert.equal(history[0].sessionKey, 's2', 'newest first')
  assert.ok(fs.existsSync(path.join(dir, 'composer-journal-history.jsonl')))
  // 按 sessionKey 过滤
  const onlyS1 = journal.history({ sessionKey: 's1' })
  assert.equal(onlyS1.length, 2)
}))

test('composer-journal: drafts without queue do not spam history', () => withJournal((journal) => {
  journal.save('draft-only', { draft: '只有草稿', queue: [] })
  assert.equal(journal.history({ limit: 10 }).length, 0, 'draft-only saves must not append history')
}))

test('composer-journal: history is bounded and keeps the newest snapshots', () => withJournal((journal) => {
  for (let i = 0; i < 8; i += 1) journal.save('s', { draft: '', queue: [{ text: `条目-${i}` }] })
  assert.ok(journal.history({ limit: 8 }).length <= 8)
  const newest = journal.history({ limit: 1 })[0]
  assert.equal(newest.queue[0].text, '条目-7')
}))

test('composer-journal: Chinese and emoji survive the UTF-8 round trip', () => withJournal((journal) => {
  const text = '中文队列条目 🔥 with CRLF\r\n第二行'
  journal.save('utf8', { draft: '中文草稿', queue: [{ text }] })
  const saved = journal.get('utf8')
  assert.equal(saved.queue[0].text, text, 'queue text must round-trip byte-for-byte')
  assert.equal(saved.draft, '中文草稿')
  assert.equal(/\?{3,}/.test(saved.queue[0].text), false, 'no mojibake placeholders')
  // 落盘文件也必须是可读 UTF-8
  const raw = fs.readFileSync(path.join(journal.file), 'utf8')
  assert.ok(raw.includes('中文队列条目'))
}))
