// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.8 branch model: one session, many branch logs, one writer per branch, no merge.
import fs from 'node:fs'
import path from 'node:path'

export function createSession(sessionId) {
  const main = { branchId: 'main', parentBranchId: null, baseTurn: 0, status: 'active', createdAt: Date.now() }
  return { sessionId, activeBranchId: 'main', branches: new Map([['main', main]]) }
}

export function createBranch(session, { branchId, parentBranchId = session.activeBranchId, baseTurn = 0 }) {
  if (!branchId || branchId === 'main') throw new Error('invalid-branch-id')
  if (session.branches.has(branchId)) throw new Error('branch-exists')
  if (!session.branches.has(parentBranchId)) throw new Error('parent-missing')
  session.branches.set(branchId, { branchId, parentBranchId, baseTurn, status: 'active', createdAt: Date.now() })
  return session.branches.get(branchId)
}

export function activateBranch(session, branchId) {
  const branch = session.branches.get(branchId)
  if (!branch) throw new Error('branch-missing')
  if (branch.status !== 'active') throw new Error('branch-not-active')
  session.activeBranchId = branchId
  return branch
}

export function setBranchStatus(session, branchId, status) {
  if (!['sealed', 'archived'].includes(status)) throw new Error('invalid-status')
  const branch = session.branches.get(branchId)
  if (!branch) throw new Error('branch-missing')
  if (branchId === session.activeBranchId) throw new Error('cannot-seal-active')
  branch.status = status
  return branch
}

export function branchPath(root, sessionId, branchId) {
  return path.join(root, sessionId, 'branches', branchId)
}

export function acquireWriter(root, sessionId, branchId) {
  const dir = branchPath(root, sessionId, branchId)
  fs.mkdirSync(dir, { recursive: true })
  const lock = path.join(dir, 'writer.lock')
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' })
  } catch {
    const error = new Error('branch-busy')
    error.code = '409'
    throw error
  }
  return { release() { try { fs.rmSync(lock, { force: true }) } catch { /* ignore */ } } }
}
