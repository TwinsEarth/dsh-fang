// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BranchStore } from '../src/lib/branch-store.mjs'

test('branch store persists create/activate/status across instances', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-branch-store-'))
  const store = new BranchStore(dir)
  assert.equal(store.list('t1').branches.length, 1)
  store.create('t1', { branchId: 'b1' })
  store.activate('t1', 'b1')
  store.setStatus('t1', 'main', 'sealed')
  const reopened = new BranchStore(dir)
  const state = reopened.list('t1')
  assert.equal(state.activeBranchId, 'b1')
  assert.equal(state.branches.find((b) => b.branchId === 'main').status, 'sealed')
  assert.equal(state.branches.find((b) => b.branchId === 'b1').parentBranchId, 'main')
  fs.rmSync(dir, { recursive: true, force: true })
})
