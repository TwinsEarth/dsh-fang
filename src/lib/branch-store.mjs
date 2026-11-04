// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.8 branch persistence: one JSON file per task under <dataDir>/tasks/<taskId>/branches.json.
import fs from 'node:fs'
import path from 'node:path'
import { activateBranch, createBranch, createSession, setBranchStatus } from './branch.mjs'

export class BranchStore {
  constructor(dataDir) {
    this.dataDir = dataDir
  }

  file(taskId) {
    return path.join(this.dataDir, 'tasks', String(taskId), 'branches.json')
  }

  load(taskId) {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(taskId), 'utf8'))
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
