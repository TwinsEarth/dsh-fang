// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.8 branch persistence: one JSON file per task under <dataDir>/tasks/<taskId>/branches.json.
import fs from 'node:fs'
import path from 'node:path'
import { activateBranch, createBranch, createSession, setBranchStatus } from './branch.mjs'

/** taskId is a path segment under <dataDir>/tasks; reject separators and traversal. */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export class BranchStore {
  constructor(dataDir) {
    this.dataDir = dataDir
  }

  file(taskId) {
    const id = String(taskId ?? '')
    if (!TASK_ID_RE.test(id)) throw new Error('invalid-task-id')
    return path.join(this.dataDir, 'tasks', id, 'branches.json')
  }

  load(taskId) {
    const file = this.file(taskId) // validate outside the read fallback
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      return {
        sessionId: raw.sessionId,
        activeBranchId: raw.activeBranchId,
        branches: new Map(Object.entries(raw.branches || {})),
      }
    } catch {
      return createSession(String(taskId))
    }
  }

  save(taskId, session) {
    const file = this.file(taskId)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const payload = {
      sessionId: session.sessionId,
      activeBranchId: session.activeBranchId,
      branches: Object.fromEntries(session.branches),
    }
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, file)
    return payload
  }

  list(taskId) {
    const session = this.load(taskId)
    return { ok: true, sessionId: session.sessionId, activeBranchId: session.activeBranchId, branches: [...session.branches.values()] }
  }

  create(taskId, input) {
    const session = this.load(taskId)
    const branch = createBranch(session, input)
    this.save(taskId, session)
    return { ok: true, branch }
  }

  /** 把分支库的 sessionId 绑定到该分身真实会话（启动/还原时由单会话守卫调用）。 */
  bindSession(taskId, sessionId) {
    const session = this.load(taskId)
    const next = String(sessionId ?? '').trim()
    if (!next || session.sessionId === next) return { ok: true, sessionId: session.sessionId, changed: false }
    session.sessionId = next
    this.save(taskId, session)
    return { ok: true, sessionId: session.sessionId, changed: true }
  }

  activate(taskId, branchId) {
    const session = this.load(taskId)
    const branch = activateBranch(session, branchId)
    this.save(taskId, session)
    return { ok: true, branch, activeBranchId: session.activeBranchId }
  }

  setStatus(taskId, branchId, status) {
    const session = this.load(taskId)
    const branch = setBranchStatus(session, branchId, status)
    this.save(taskId, session)
    return { ok: true, branch }
  }
}
