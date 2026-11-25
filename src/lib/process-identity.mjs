// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// PID 复用防护：孤儿清理不能只凭 PID 判断。任务在 spawn 后记录进程的
// CreationDate + CommandLine 指纹；cleanup 时与 taskkill 前各核对一次。
import crypto from 'node:crypto'

/** Stable hash for the exact Windows CommandLine captured at spawn. */
export function hashCommandLine(commandLine) {
  return crypto.createHash('sha256').update(String(commandLine ?? ''), 'utf8').digest('hex')
}

/**
 * Match a current process row against a task's recorded identity.
 * Fail-closed: if an expected identity field is missing from the current row, reject.
 * @param {object} row - process table row (pid/createdAt/commandLine)
 * @param {{pid:number, taskId?:string, profile?:string, port?:number, startedAt?:number|null, commandLineHash?:string|null, tokens?:string[]}} expected
 * @param {{toleranceMs?:number}} [options]
 * @returns {{ok:boolean, reason:string, detail?:object}}
 */
export function matchesProcessIdentity(row, expected, { toleranceMs = 120_000 } = {}) {
  const pid = Number(expected?.pid)
  if (!row || !Number.isInteger(pid) || pid <= 0) return { ok: false, reason: 'bad-pid' }
  if (Number(row.pid) !== pid) return { ok: false, reason: 'pid-mismatch', detail: { actualPid: row.pid ?? null } }

  const commandLine = String(row.commandLine ?? '')
  if (!commandLine) return { ok: false, reason: 'no-command-line' }

  if (expected.commandLineHash) {
    const actualHash = hashCommandLine(commandLine)
    if (actualHash !== String(expected.commandLineHash)) {
      return { ok: false, reason: 'command-line-changed', detail: { expected: expected.commandLineHash, actual: actualHash } }
    }
  }

  if (expected.startedAt !== undefined && expected.startedAt !== null) {
    const expectedStart = Number(expected.startedAt)
    const actualStart = row.createdAt === null || row.createdAt === undefined ? NaN : Number(row.createdAt)
    if (!Number.isFinite(expectedStart)) return { ok: false, reason: 'bad-recorded-start-time' }
    if (!Number.isFinite(actualStart)) return { ok: false, reason: 'no-creation-time' }
    if (Math.abs(actualStart - expectedStart) > Math.max(0, Number(toleranceMs) || 0)) {
      return { ok: false, reason: 'creation-time-mismatch', detail: { expected: expectedStart, actual: actualStart } }
    }
  }

  // Legacy tasks have no hash: require profile AND port (or the task marker) in argv.
  // Browser targets pass explicit `tokens` instead (profileDir + remote-debugging-port).
  if (!expected.commandLineHash) {
    const tokens = Array.isArray(expected.tokens) ? expected.tokens.map((item) => String(item ?? '')).filter(Boolean) : []
    if (tokens.length > 0) {
      const missing = tokens.filter((token) => !commandLine.includes(token))
      if (missing.length > 0) {
        return { ok: false, reason: 'command-line-token-mismatch', detail: { missing: missing.slice(0, 4) } }
      }
      return { ok: true, reason: 'matched' }
    }
    const taskId = String(expected.taskId ?? '')
    const profile = String(expected.profile ?? '')
    const port = Math.floor(Number(expected.port))
    const hasMarker = taskId.length > 0 && commandLine.includes(taskId)
    const hasProfile = profile.length > 0 && commandLine.includes(profile)
    const hasPort = Number.isInteger(port) && port > 0 && new RegExp(`--port(?:=|\\s+)${port}(?:\\s|$)`).test(commandLine)
    if (!(hasProfile && (hasPort || hasMarker))) {
      return { ok: false, reason: 'command-line-token-mismatch', detail: { hasMarker, hasProfile, hasPort } }
    }
  }

  return { ok: true, reason: 'matched' }
}
