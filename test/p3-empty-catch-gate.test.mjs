// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'

import { scanSource, compareCounts } from '../tools/gate/empty-catch.mjs'

test('empty-catch scanner separates bare, commented and code-bearing catches', () => {
  const source = [
    'try { a() } catch {}',
    'try { b() } catch (error) { /* best effort */ }',
    'try { c() } catch (error) { audit(error) }',
  ].join('\n')
  const rows = scanSource(source)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map((row) => [row.empty, row.bare]), [
    [true, true],
    [true, false],
    [false, false],
  ])
})

test('empty-catch scanner counts nested catches and ignores strings/comments', () => {
  const source = [
    'try { a() } catch (error) {',
    "  try { b() } catch { /* nested */ }",
    "  log('catch {} is text')",
    '}',
    '// catch {} in a comment',
  ].join('\n')
  const rows = scanSource(source)
  assert.equal(rows.length, 2)
  assert.equal(rows.filter((row) => row.empty).length, 1)
  assert.equal(rows.filter((row) => row.bare).length, 0)
})

test('empty-catch baseline comparison fails only on increases', () => {
  assert.deepEqual(compareCounts({ 'a.mjs': { empty: 2, bare: 0 } }, { 'a.mjs': { empty: 2, bare: 0 } }), [])
  assert.deepEqual(compareCounts({ 'a.mjs': { empty: 2, bare: 0 } }, { 'a.mjs': { empty: 1, bare: 0 } }), [])
  assert.deepEqual(compareCounts({ 'a.mjs': { empty: 2, bare: 0 } }, { 'a.mjs': { empty: 3, bare: 0 } }), [
    { file: 'a.mjs', kind: 'empty', before: 2, after: 3 },
  ])
  assert.deepEqual(compareCounts({}, { 'new.mjs': { empty: 1, bare: 1 } }), [
    { file: 'new.mjs', kind: 'empty', before: 0, after: 1 },
    { file: 'new.mjs', kind: 'bare', before: 0, after: 1 },
  ])
})
