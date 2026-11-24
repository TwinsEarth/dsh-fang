// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import { assertDataPath, DEFAULT_FANG_DATA_ROOT, workspaceForFork } from '../src/lib/data-isolation.mjs'

test('data isolation rejects host/project tree and accepts canonical root', () => {
  const bad = assertDataPath('E:\\DSH\\DS\\.dsh\\fang', { forbiddenRoots: ['E:\\DSH\\DS'] })
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'data-root-forbidden')
  const good = assertDataPath(DEFAULT_FANG_DATA_ROOT + '\\mirror\\desktop', { fangHome: DEFAULT_FANG_DATA_ROOT, forbiddenRoots: ['E:\\DSH\\DS'] })
  assert.equal(good.ok, true)
})

test('fork workspace is inside its own home', () => {
  const ws = workspaceForFork('D:\\ToFuture\\FangData\\forks\\task_x')
  assert.equal(ws, 'D:\\ToFuture\\FangData\\forks\\task_x\\workspace')
})

test('data path outside configured fang home is rejected', () => {
  const out = assertDataPath('C:\\Users\\fangw\\.dsh\\fang\\desktop', { fangHome: DEFAULT_FANG_DATA_ROOT })
  assert.equal(out.ok, false)
  assert.equal(out.error, 'data-root-outside-fang-home')
})
