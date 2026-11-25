// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acquireWriter, activateBranch, createBranch, createSession, setBranchStatus } from '../src/lib/branch.mjs'

test('branch model: 物理分支记录子会话 sessionId', () => {
  const s = createSession('s1')
  const branch = createBranch(s, { branchId: 'exp-1', baseTurn: 3, sessionId: 'child-session-1' })
  assert.equal(branch.sessionId, 'child-session-1')
  assert.equal(branch.baseTurn, 3)
})

test('one session can hold independent branches', () => {
  const s = createSession('s1')
  createBranch(s, { branchId: 'b1' })
  createBranch(s, { branchId: 'b2', parentBranchId: 'b1' })
  assert.equal(s.branches.size, 3)
  assert.equal(s.branches.get('b2').parentBranchId, 'b1')})

test('active branch switch is a pointer move', () => {
  const s = createSession('s1')
  createBranch(s, { branchId: 'b1' })
  activateBranch(s, 'b1')
  assert.equal(s.activeBranchId, 'b1')
})

test('sealed branch becomes read-only and cannot be active', () => {
  const s = createSession('s1')
  createBranch(s, { branchId: 'b1' })
  setBranchStatus(s, 'b1', 'sealed')
  assert.equal(s.branches.get('b1').status, 'sealed')
  assert.throws(() => activateBranch(s, 'b1'), /branch-not-active/)
})

test('only one writer per branch, per-branch lock', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-branch-'))
  const first = acquireWriter(root, 's1', 'main')
  assert.throws(() => acquireWriter(root, 's1', 'main'), /branch-busy/)
  const other = acquireWriter(root, 's1', 'b1')
  first.release(); other.release()
  fs.rmSync(root, { recursive: true, force: true })
})

test('branch module exposes no merge operation', async () => {
  const mod = await import('../src/lib/branch.mjs')
  assert.equal(typeof mod.mergeBranch, 'undefined')
})
