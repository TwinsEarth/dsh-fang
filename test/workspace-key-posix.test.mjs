// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v3.1.35 回归：POSIX 绝对路径的工作区编码必须与 DSH 一致（多一个前导 '-' 会让分身 workspace.json 变空）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeWorkspaceKey } from '../src/lib/session-format.mjs'

test('encodeWorkspaceKey: Windows drive paths (unchanged behaviour)', () => {
  assert.equal(encodeWorkspaceKey('E:\\GPT'), '--E-GPT--')
  assert.equal(encodeWorkspaceKey('E:\\ToFuture'), '--E-ToFuture--')
  assert.equal(encodeWorkspaceKey('C:\\Users\\a\\b\\c'), '--C-Users-a-b-c--')
})

test('encodeWorkspaceKey: POSIX absolute paths must not gain a leading dash', () => {
  // MacMini 实测：DSH 编码为 --Users-fang-Desktop-DS--，
  // 旧实现编码成 ---Users-fang-Desktop-DS-- → 合并工作区索引永远落空。
  assert.equal(encodeWorkspaceKey('/Users/fang/Desktop/DS'), '--Users-fang-Desktop-DS--')
  assert.equal(encodeWorkspaceKey('/home/fang/work'), '--home-fang-work--')
})

test('encodeWorkspaceKey: trailing separators are ignored on both platforms', () => {
  assert.equal(encodeWorkspaceKey('/Users/fang/Desktop/DS/'), '--Users-fang-Desktop-DS--')
  assert.equal(encodeWorkspaceKey('E:\\GPT\\'), '--E-GPT--')
})

test('encodeWorkspaceKey: never emits a triple dash at either end', () => {
  for (const input of ['/a/b', 'a/b', '//server/share/x', '/tmp/x/', 'E:\\x']) {
    const key = encodeWorkspaceKey(input)
    assert.doesNotMatch(key, /^---/, `${input} must not start with '---'`)
    assert.doesNotMatch(key, /---$/, `${input} must not end with '---'`)
    assert.match(key, /^--[^-].*[^-]--$|^--[A-Za-z0-9_]--$/, `${input} produced unexpected shape: ${key}`)
  }
})

test('encodeWorkspaceKey: empty input stays empty', () => {
  assert.equal(encodeWorkspaceKey(''), '')
  assert.equal(encodeWorkspaceKey('   '), '')
})
