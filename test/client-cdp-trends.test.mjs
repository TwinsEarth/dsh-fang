// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'client.js'), 'utf8')

test('fork card renders CDP documents/listeners/layoutCount trends', () => {
  assert.match(source, /function renderCdpTrends\(task\)/)
  assert.match(source, /key:\s*'documents', label:\s*'文档 documents'/)
  assert.match(source, /key:\s*'listeners', label:\s*'监听器 listeners'/)
  assert.match(source, /key:\s*'layoutCount', label:\s*'布局 layoutCount'/)
  assert.match(source, /task\.browser\.metrics|browser\.metrics/)
  assert.match(source, /browser\.history/)
  assert.match(source, /function sparkline\(values/)
  assert.match(source, /bodyWrap\.append\(cdpTrends\)|append\(cdpTrends\)/)
})

test('sparkline is dependency-free and handles one/zero points', () => {
  const fn = source.slice(source.indexOf('function sparkline'), source.indexOf('// 局部图标缓存', source.indexOf('function sparkline')))
  assert.ok(fn.length > 0)
  assert.match(fn, /nums\.length === 1/)
  assert.match(fn, /svg\('path'/)
  assert.doesNotMatch(fn, /chart\.js|d3|recharts/i)
})
