// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v3.1.31 回归：折行纯量（plain scalar continuation）不得再让 patch 解析失败。
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseYamlSubset } from '../src/lib/rule-registry.mjs'

test('yaml subset: folded plain scalar continues across deeper-indented lines', () => {
  const src = [
    '- insert:',
    '    - id: x',
    '      config:',
    '        description: Stronger agentic coding; suited',
    '          to complex tasks at higher cost.',
    '        contextWindow: 1048576',
    '',
  ].join('\n')
  const r = parseYamlSubset(src)
  assert.deepEqual(r.errors, [])
  const cfg = r.value[0].insert[0].config
  assert.equal(cfg.description, 'Stronger agentic coding; suited to complex tasks at higher cost.')
  assert.equal(cfg.contextWindow, 1048576, 'sibling key after a folded scalar must still parse')
})

test('yaml subset: multi-fold scalar joins with single spaces', () => {
  const src = [
    'root:',
    '  note: line one',
    '    line two',
    '    line three',
    '  after: 1',
    '',
  ].join('\n')
  const r = parseYamlSubset(src)
  assert.deepEqual(r.errors, [])
  assert.equal(r.value.root.note, 'line one line two line three')
  assert.equal(r.value.root.after, 1)
})

test('yaml subset: folded scalar must not swallow a sibling key', () => {
  // 续行若其实是结构行（key:），不能被吃掉
  const src = [
    'a:',
    '  b: hello',
    '    world',
    '  c: sibling',
    '',
  ].join('\n')
  const r = parseYamlSubset(src)
  assert.deepEqual(r.errors, [])
  assert.equal(r.value.a.b, 'hello world')
  assert.equal(r.value.a.c, 'sibling')
})

test('yaml subset: sequence item inline key also folds', () => {
  const src = [
    '- id: y',
    '  name: a very long name that',
    '    continues on the next line',
    '  disabled: true',
    '',
  ].join('\n')
  const r = parseYamlSubset(src)
  assert.deepEqual(r.errors, [])
  assert.equal(r.value[0].name, 'a very long name that continues on the next line')
  assert.equal(r.value[0].disabled, true)
})

test('yaml subset: quoted and folded scalars coexist', () => {
  const src = [
    'a:',
    '  quoted: "keep: this"',
    '  plain: fold me',
    '    please',
    '',
  ].join('\n')
  const r = parseYamlSubset(src)
  assert.deepEqual(r.errors, [])
  assert.equal(r.value.a.quoted, 'keep: this')
  assert.equal(r.value.a.plain, 'fold me please')
})
