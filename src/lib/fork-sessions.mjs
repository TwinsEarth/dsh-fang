// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// v3.1.35 — 分身会话数约束（1..3）与默认空会话。
//
// 规格（用户 2026-11-13）：
//   「默认一个分身 Web 端的分身会话，默认不能为 0 至少有 1 个（空会话），
//     不超过 3 个，可以有多个分支。」
//
// 于是：
//   * 下限 1：分身 Web 里永远至少有一个会话可用；空白派生时自动补一个空会话；
//   * 上限 3：超过 3 个时把较旧的移入 quarantine-sessions/（不删除）；
//   * 分支不受此限：分支是同一会话的不同走向，不是新的会话。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { encodeWorkspaceKey } from './session-format.mjs'

// 复用并对外暴露，便于调用方与测试统一。
export { encodeWorkspaceKey }

export const FORK_SESSION_MIN = 1
export const FORK_SESSION_MAX = 3

const SESSION_FILE = 'session.v4.jsonl.zstd'
const DEFAULT_PRESET = 'standard'
const DEFAULT_PERMISSION = 'workspace-write'
const DEFAULT_SANDBOX = 'workspace-write'
const DEFAULT_APPROVAL = 'ask'

/** The minimal legal DSH session log (verified against a real 397-byte empty session). */
export function buildEmptySessionFrames({ sessionId, createdAt, cwd }) {
  const id = String(sessionId ?? '')
  const at = Number(createdAt) || Date.now()
  const workspace = String(cwd ?? '')
  return [
    JSON.stringify({
      type: 'session', version: 4, id, createdAt: at, cwd: workspace,
      isSeeded: false, delegationDepth: 0, agentPreset: DEFAULT_PRESET,
    }),
    JSON.stringify({ type: 'permission/preset', seq: 0, time: at + 24, data: { preset: DEFAULT_PERMISSION } }),
    JSON.stringify({ type: 'sandbox/mode', seq: 1, time: at + 40, data: { mode: DEFAULT_SANDBOX } }),
    JSON.stringify({ type: 'approval/policy', seq: 2, time: at + 41, data: { policy: DEFAULT_APPROVAL } }),
    JSON.stringify({ type: 'session/end-seed', seq: 3, time: at, data: {} }),
  ]
}

export function encodeSessionLog(frames, { compress = true } = {}) {
  const text = frames.join('\n') + '\n'
  const buffer = Buffer.from(text, 'utf8')
  if (!compress) return buffer
  if (typeof zlib.zstdCompressSync !== 'function') {
    throw new Error('zstd-unavailable: this Node build has no zlib.zstdCompressSync')
  }
  return zlib.zstdCompressSync(buffer)
}

/** Scan a fork home's own sessions: one entry per session directory. */
export function scanForkSessions(homeDir) {
  const sessionsRoot = path.join(String(homeDir), 'sessions')
  const out = []
  let workspaceDirs = []
  try { workspaceDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()) } catch { return out }
  for (const workspace of workspaceDirs) {
    const workspaceDir = path.join(sessionsRoot, workspace.name)
    let sessionDirs = []
    try { sessionDirs = fs.readdirSync(workspaceDir, { withFileTypes: true }).filter((e) => e.isDirectory()) } catch { continue }
    for (const session of sessionDirs) {
      const file = path.join(workspaceDir, session.name, SESSION_FILE)
      let mtimeMs = 0
      let bytes = 0
      try {
        const stat = fs.statSync(file)
        mtimeMs = stat.mtimeMs
        bytes = stat.size
      } catch { continue }
      out.push({ workspaceKey: workspace.name, sessionId: session.name, file, mtimeMs, bytes })
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

function readWorkspaceIndex(homeDir) {
  const file = path.join(String(homeDir), 'storages', 'workspace.json')
  let doc = null
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { doc = null }
  if (!doc || typeof doc !== 'object') {
    doc = {
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, defaultWorkspaceId: null, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] },
      tables: { workspaces: {} },
    }
  }
  doc.tables = doc.tables && typeof doc.tables === 'object' ? doc.tables : {}
  doc.tables.workspaces = doc.tables.workspaces && typeof doc.tables.workspaces === 'object' ? doc.tables.workspaces : {}
  doc.global = doc.global && typeof doc.global === 'object'
    ? doc.global
    : { initialized: true, defaultWorkspaceId: null, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }
  doc.global.workspaceIds = Array.isArray(doc.global.workspaceIds) ? doc.global.workspaceIds : []
  return { file, doc }
}

function writeWorkspaceIndex(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * Ensure the fork has at least FORK_SESSION_MIN sessions (default: one empty session).
 * Returns { ok, created, sessionId, workspaceKey } — idempotent when a session already exists.
 */
export function ensureForkEmptySession(homeDir, { workspacePath = '', workspaceTitle = '', now = Date.now() } = {}) {
  const existing = scanForkSessions(homeDir)
  if (existing.length >= FORK_SESSION_MIN) {
    return { ok: true, created: false, sessionId: existing[0].sessionId, workspaceKey: existing[0].workspaceKey }
  }
  const cwd = String(workspacePath ?? '').trim() || process.cwd()
  const title = String(workspaceTitle ?? '').trim() || path.basename(cwd) || '新会话'
  const workspaceKey = encodeWorkspaceKey(cwd)
  const sessionId = 'session-' + randomUUID()
  const dir = path.join(String(homeDir), 'sessions', workspaceKey, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  const frames = buildEmptySessionFrames({ sessionId, createdAt: now, cwd })
  fs.writeFileSync(path.join(dir, SESSION_FILE), encodeSessionLog(frames))

  const { file, doc } = readWorkspaceIndex(homeDir)
  // 与 DSH 自身一致：workspaceId 由 workspace 路径稳定派生。
  const workspaceId = 'ws-' + Buffer.from(workspaceKey).toString('hex').slice(0, 12)
  const previous = doc.tables.workspaces[workspaceId]
  const sessionIds = Array.isArray(previous?.sessionIds) ? previous.sessionIds.filter((id) => typeof id === 'string') : []
  if (!sessionIds.includes(sessionId)) sessionIds.push(sessionId)
  doc.tables.workspaces[workspaceId] = {
    path: cwd,
    title,
    sessionIds,
    createdAt: previous?.createdAt ?? new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  }
  if (!doc.global.workspaceIds.includes(workspaceId)) doc.global.workspaceIds.push(workspaceId)
  if (!doc.global.defaultWorkspaceId) doc.global.defaultWorkspaceId = workspaceId
  doc.global.initialized = true
  writeWorkspaceIndex(file, doc)

  return { ok: true, created: true, sessionId, workspaceKey }
}

/**
 * Enforce the upper bound: keep the newest FORK_SESSION_MAX sessions, move the rest to
 * quarantine-sessions/<stamp>/… (never delete). Branch sessions are exempt.
 */
export function enforceForkSessionCap(homeDir, { keepSessionIds = [], max = FORK_SESSION_MAX, now = Date.now() } = {}) {
  const keep = new Set((Array.isArray(keepSessionIds) ? keepSessionIds : []).map(String))
  const sessions = scanForkSessions(homeDir).filter((session) => !keep.has(session.sessionId))
  const overflow = sessions.slice(Math.max(0, max))
  if (overflow.length === 0) return { ok: true, kept: Math.min(sessions.length, max), quarantined: [] }
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  const quarantined = []
  for (const session of overflow) {
    const target = path.join(String(homeDir), 'quarantine-sessions', stamp, session.workspaceKey, session.sessionId)
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.renameSync(path.dirname(session.file), target)
      quarantined.push({ workspaceKey: session.workspaceKey, sessionId: session.sessionId, movedTo: target, at: now })
    } catch { /* 移动失败则保留原地，不删除 */ }
  }
  return { ok: true, kept: Math.min(sessions.length, max), quarantined }
}

/** Feedback for the panel: how many sessions, and whether the cap is violated. */
export function summarizeForkSessions(homeDir) {
  const list = scanForkSessions(homeDir)
  return {
    count: list.length,
    min: FORK_SESSION_MIN,
    max: FORK_SESSION_MAX,
    belowFloor: list.length < FORK_SESSION_MIN,
    violation: list.length > FORK_SESSION_MAX,
  }
}
