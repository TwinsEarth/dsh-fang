// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// v3.8.3 P1-1 — 分身活动信号（供空闲浏览器关闭使用）。
//
// 旧的 taskIdleForClose 只看握手时写入的 adapter.idle；这个字段没有后续更新，
// 结果是「永远不关」。本模块从分身自己的会话日志尾部推断：
//   * lastActivityAt：最近一条会话事件时间（缺失时用文件 mtime）
//   * turnRunning：最后一个 turn/start 之后是否还没有 turn/end
//   * turn：对应 turn 序号（用于诊断）
// 无会话日志 / 无 turn 事件时返回 null，调用方必须 fail-closed（不关，只审计提示）。
import fs from 'node:fs'
import zlib from 'node:zlib'
import { scanForkSessions } from './fork-sessions.mjs'
import { readBoundedTailEvents } from './session-format.mjs'

export const ACTIVITY_DEFAULTS = Object.freeze({
  maxSessions: 3,
  maxFrames: 512,
  maxCompressedBytes: 256 * 1024,
  maxEvents: 2000,
})

function asTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return asTimestamp(numeric)
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function eventTime(event) {
  return asTimestamp(event?.time ?? event?.at ?? event?.data?.time ?? event?.data?.at ?? null)
}

function eventTurn(event) {
  const value = Number(event?.data?.turn ?? event?.turn)
  return Number.isFinite(value) ? value : null
}

function turnKind(type) {
  const value = String(type ?? '').toLowerCase()
  if (value === 'turn/start') return 'start'
  if (value === 'turn/end' || value === 'turn/aborted' || value === 'turn/error' || value === 'turn/cancel') return 'end'
  return null
}

/**
 * Pure: turn a bounded session event list into the activity contract.
 * `turnRunning` is true/false only when a turn lifecycle event was observed;
 * otherwise null means "unknown" and must not authorize closing.
 */
export function summarizeSessionActivity(events = [], options = {}) {
  const list = Array.isArray(events) ? events : []
  const mtimeMs = asTimestamp(options.mtimeMs) ?? null
  const now = Number(options.now) || Date.now()
  let lastEventAt = null
  let lastEventAtSource = null
  let turnRunning = null
  let lastTurn = null
  let lastTurnMarkerIndex = -1
  let lastTurnMarkerKind = null
  let lastUserIndex = -1
  let messageEvents = 0
  for (let i = 0; i < list.length; i++) {
    const event = list[i]
    if (!event || typeof event !== 'object') continue
    const at = eventTime(event)
    if (at !== null && (lastEventAt === null || at >= lastEventAt)) {
      lastEventAt = at
      lastEventAtSource = 'event'
    }
    const type = String(event.type ?? '')
    if (type === 'user/message' || type === 'assistant/message') {
      lastUserIndex = i
      messageEvents += 1
    }
    const kind = turnKind(type)
    if (kind) {
      lastTurnMarkerIndex = i
      lastTurnMarkerKind = kind
      turnRunning = kind === 'start'
      const t = eventTurn(event)
      if (t !== null) lastTurn = t
    }
  }
  const mtime = mtimeMs !== null ? mtimeMs : null
  if (mtime !== null && (lastEventAt === null || mtime > lastEventAt)) {
    lastEventAt = mtime
    lastEventAtSource = 'mtime'
  }
  // A user message after a completed turn but before the next turn/start means
  // the next turn is queued/starting; do not claim idle on that ambiguous edge.
  if (lastTurnMarkerKind === 'end' && lastUserIndex > lastTurnMarkerIndex) turnRunning = null
  // A partially decoded/corrupt tail may have skipped a turn/start. Never let
  // an incomplete read authorize closing; `frame-limit` alone is safe because
  // the retained suffix still ends at the real last event.
  const degraded = Array.isArray(options.degraded) ? [...options.degraded] : []
  if (turnRunning === false && degraded.some((tag) => ['frame-decode-failed', 'read-failed', 'not-zstd', 'line-unparsable'].includes(tag))) {
    turnRunning = null
  }
  const signal = lastTurnMarkerIndex >= 0 ? 'turn-event' : (lastEventAt !== null ? 'activity-only' : 'none')
  return {
    ok: true,
    at: now,
    lastActivityAt: lastEventAt,
    lastActivityISO: lastEventAt === null ? null : new Date(lastEventAt).toISOString(),
    lastActivitySource: lastEventAtSource,
    turnRunning,
    turn: lastTurn,
    signal,
    messages: messageEvents,
    sessionId: options.sessionId ?? null,
    workspaceKey: options.workspaceKey ?? null,
    source: 'session-log',
    events: list.length,
    degraded,
  }
}

/**
 * Read the newest bounded set of fork sessions and aggregate their activity.
 * If a log cannot be decoded, that session contributes only its mtime; the
 * result remains `ok:true` with degraded tags, never a fabricated turn state.
 */
export function readForkActivity(homeDir, options = {}) {
  const home = String(homeDir ?? '').trim()
  const now = Number(options.now) || Date.now()
  const maxSessions = Math.max(1, Math.floor(Number(options.maxSessions) || ACTIVITY_DEFAULTS.maxSessions))
  if (!home) {
    return { ok: false, error: 'home-unavailable', at: now, turnRunning: null, lastActivityAt: null, signal: 'none', source: 'session-log' }
  }
  let sessions = []
  try { sessions = scanForkSessions(home).slice(0, maxSessions) } catch { sessions = [] }
  if (sessions.length === 0) {
    return {
      ok: true, at: now, lastActivityAt: null, lastActivityISO: null, lastActivitySource: null,
      turnRunning: null, turn: null, signal: 'none', sessionId: null, workspaceKey: null,
      source: 'session-log', sessionsScanned: 0, degraded: [],
    }
  }
  const summaries = []
  const degraded = []
  for (const session of sessions) {
    const tail = readBoundedTailEvents({
      file: session.file,
      maxFrames: options.maxFrames ?? ACTIVITY_DEFAULTS.maxFrames,
      maxCompressedBytes: options.maxCompressedBytes ?? ACTIVITY_DEFAULTS.maxCompressedBytes,
      maxEvents: options.maxEvents ?? ACTIVITY_DEFAULTS.maxEvents,
      fsApi: options.fsApi ?? fs,
      zstdDecompressSync: options.zstdDecompressSync ?? zlib.zstdDecompressSync,
    })
    for (const tag of tail.degraded) if (!degraded.includes(tag)) degraded.push(tag)
    summaries.push(summarizeSessionActivity(tail.events, {
      mtimeMs: session.mtimeMs,
      sessionId: session.sessionId,
      workspaceKey: session.workspaceKey,
      now,
      degraded: tail.degraded,
    }))
  }
  let latest = summaries[0]
  for (const item of summaries) {
    if ((Number(item.lastActivityAt) || 0) > (Number(latest.lastActivityAt) || 0)) latest = item
  }
  // A blank seeded session (product floor = 1) has no messages/turn markers and
  // must not poison the aggregate into "unknown forever". Use the newest session
  // that actually has conversation/turn evidence as the decision primary; any
  // simultaneously running turn in any session still vetoes closing.
  const relevant = summaries.filter((item) => item.turnRunning !== null || Number(item.messages) > 0)
  let decision = relevant[0] ?? latest
  for (const item of relevant) {
    if ((Number(item.lastActivityAt) || 0) > (Number(decision.lastActivityAt) || 0)) decision = item
  }
  let turnRunning = null
  let turn = decision.turn
  for (const item of summaries) {
    if (item.turnRunning === true) {
      turnRunning = true
      turn = item.turn ?? turn
      break
    }
  }
  if (turnRunning !== true) turnRunning = decision.turnRunning ?? null
  const signal = summaries.some((item) => item.signal === 'turn-event')
    ? 'turn-event'
    : (latest.lastActivityAt !== null ? 'activity-only' : 'none')
  return {
    ok: true,
    at: now,
    lastActivityAt: latest.lastActivityAt ?? null,
    lastActivityISO: latest.lastActivityISO ?? null,
    lastActivitySource: latest.lastActivitySource ?? null,
    turnRunning,
    turn,
    signal,
    sessionId: decision.sessionId ?? null,
    workspaceKey: decision.workspaceKey ?? null,
    source: 'session-log',
    sessionsScanned: sessions.length,
    degraded,
  }
}

/**
 * Pure close decision. `close` is only true when the activity contract proves
 * a completed turn and the newest activity is older than the idle window.
 * Mtime-only / missing turn signal returns `warn:true`, never a close.
 */
export function decideIdleClose(activity, options = {}) {
  const now = Number(options.now) || Date.now()
  const hiddenSince = asTimestamp(options.hiddenSince) ?? 0
  const idleMinutes = Math.max(0, Number(options.idleMinutes) || 0)
  const idleMs = idleMinutes * 60_000
  if (options.onlyWhenIdle === false) {
    return { close: true, reason: 'idle-check-disabled', warn: false, idleMs: now - hiddenSince, activity }
  }
  if (options.busy === true) {
    return { close: false, reason: 'adapter-busy', warn: false, idleMs: 0, activity }
  }
  if (!activity || activity.ok === false) {
    return { close: false, reason: activity?.error ?? 'activity-unavailable', warn: true, idleMs: 0, activity }
  }
  if (activity.turnRunning === true) {
    return { close: false, reason: 'turn-running', warn: false, idleMs: 0, activity }
  }
  const lastActivityAt = asTimestamp(activity.lastActivityAt)
  if (lastActivityAt === null) {
    return { close: false, reason: 'last-activity-unavailable', warn: true, idleMs: 0, activity }
  }
  const since = Math.max(hiddenSince, lastActivityAt)
  const idle = now - since
  if (idle < idleMs) {
    return { close: false, reason: 'recent-activity', warn: false, idleMs: idle, activity }
  }
  if (activity.turnRunning === false) {
    return { close: true, reason: 'turn-ended-idle', warn: false, idleMs: idle, activity }
  }
  return { close: false, reason: 'turn-signal-unavailable', warn: true, idleMs: idle, activity }
}
