// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.8 branch model: one session, many branch logs, one writer per branch, no merge.
import fs from 'node:fs'
import path from 'node:path'

/** Branch/session ids become directory names; keep them to safe single segments. */
export const BRANCH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function assertBranchId(branchId) {
  const id = String(branchId ?? '')
  if (!BRANCH_ID_RE.test(id)) throw new Error('invalid-branch-id')
  return id
}

function assertSessionId(sessionId) {
  const id = String(sessionId ?? '')
  if (!SESSION_ID_RE.test(id)) throw new Error('invalid-session-id')
  return id
}

export function createSession(sessionId) {
  const main = { branchId: 'main', parentBranchId: null, baseTurn: 0, status: 'active', createdAt: Date.now() }
  return { sessionId, activeBranchId: 'main', branches: new Map([['main', main]]) }
}

export function createBranch(session, { branchId, parentBranchId = session.activeBranchId, baseTurn = 0 }) {
  const id = assertBranchId(branchId)
  if (id === 'main') throw new Error('invalid-branch-id')
  if (session.branches.has(id)) throw new Error('branch-exists')
  if (!session.branches.has(parentBranchId)) throw new Error('parent-missing')
  session.branches.set(id, { branchId: id, parentBranchId, baseTurn, status: 'active', createdAt: Date.now() })
  return session.branches.get(id)
}

export function activateBranch(session, branchId) {
  const id = assertBranchId(branchId)
  const branch = session.branches.get(id)
  if (!branch) throw new Error('branch-missing')
  if (branch.status !== 'active') throw new Error('branch-not-active')
  session.activeBranchId = id
  return branch
}

export function setBranchStatus(session, branchId, status) {
  const id = assertBranchId(branchId)
  if (!['sealed', 'archived'].includes(status)) throw new Error('invalid-status')
  const branch = session.branches.get(id)
  if (!branch) throw new Error('branch-missing')
  if (id === session.activeBranchId) throw new Error('cannot-seal-active')
  branch.status = status
  return branch
}

export function branchPath(root, sessionId, branchId) {
  return path.join(root, assertSessionId(sessionId), 'branches', assertBranchId(branchId))
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
