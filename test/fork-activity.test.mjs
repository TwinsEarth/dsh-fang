// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// P1-1: activity contract + fail-closed idle-close decision.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { tmpDir } from './helpers.mjs'
import { summarizeSessionActivity, decideIdleClose, readForkActivity } from '../src/lib/fork-activity.mjs'

const NOW = 1_700_000_000_000

function writeSession(home, sessionId, events, { mtimeMs } = {}) {
  const dir = path.join(home, 'sessions', 'ws', sessionId)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  const frames = events.map((event) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n', 'utf8')))
  fs.writeFileSync(file, Buffer.concat(frames))
  if (Number.isFinite(mtimeMs)) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs))
  return file
}

test('summarizeSessionActivity: turn/start → running, turn/end → idle, user after end → unknown', () => {
  const running = summarizeSessionActivity([
    { type: 'turn/start', seq: 1, time: NOW, data: { turn: 7 } },
    { type: 'assistant/message', seq: 2, time: NOW + 1000, data: {} },
  ], { now: NOW + 2000 })
  assert.equal(running.turnRunning, true)
  assert.equal(running.turn, 7)
  assert.equal(running.signal, 'turn-event')
  assert.equal(running.lastActivityAt, NOW + 1000)

  const ended = summarizeSessionActivity([
    { type: 'turn/start', seq: 1, time: NOW },
    { type: 'turn/end', seq: 2, time: NOW + 1000, data: { turn: 1 } },
  ], { now: NOW + 2000 })
  assert.equal(ended.turnRunning, false)
  assert.equal(ended.lastActivityAt, NOW + 1000)

  const queued = summarizeSessionActivity([
    { type: 'turn/end', seq: 2, time: NOW + 1000 },
    { type: 'user/message', seq: 3, time: NOW + 2000 },
  ], { now: NOW + 3000 })
  assert.equal(queued.turnRunning, null, 'queued user message must not be claimed idle')
})

test('summarizeSessionActivity: no event time falls back to mtime and never invents a turn state', () => {
  const out = summarizeSessionActivity([{ type: 'assistant/message', seq: 1 }], { mtimeMs: NOW - 60_000, now: NOW })
  assert.equal(out.lastActivityAt, NOW - 60_000)
  assert.equal(out.lastActivitySource, 'mtime')
  assert.equal(out.turnRunning, null)
  assert.equal(out.signal, 'activity-only')
})

test('summarizeSessionActivity: a corrupt/partial tail cannot turn a completed turn into permission to close', () => {
  const out = summarizeSessionActivity([
    { type: 'turn/start', seq: 1, time: NOW },
    { type: 'turn/end', seq: 2, time: NOW + 1000 },
  ], { now: NOW + 2000, degraded: ['frame-decode-failed'] })
  assert.equal(out.turnRunning, null)
  assert.ok(out.degraded.includes('frame-decode-failed'))
})

test('decideIdleClose: only a completed turn older than the window may close', () => {
  const activity = { ok: true, lastActivityAt: NOW - 20 * 60_000, turnRunning: false, signal: 'turn-event' }
  const idle = decideIdleClose(activity, { hiddenSince: NOW - 30 * 60_000, now: NOW, idleMinutes: 10, onlyWhenIdle: true })
  assert.equal(idle.close, true)
  assert.equal(idle.reason, 'turn-ended-idle')

  const running = decideIdleClose({ ...activity, turnRunning: true }, { hiddenSince: NOW - 30 * 60_000, now: NOW, idleMinutes: 10, onlyWhenIdle: true })
  assert.equal(running.close, false)
  assert.equal(running.reason, 'turn-running')

  const unknown = decideIdleClose({ ok: true, lastActivityAt: NOW - 20 * 60_000, turnRunning: null, signal: 'activity-only' }, { hiddenSince: NOW - 30 * 60_000, now: NOW, idleMinutes: 10, onlyWhenIdle: true })
  assert.equal(unknown.close, false)
  assert.equal(unknown.warn, true)
  assert.equal(unknown.reason, 'turn-signal-unavailable')

  const missing = decideIdleClose({ ok: false, error: 'activity-unavailable' }, { hiddenSince: NOW - 30 * 60_000, now: NOW, idleMinutes: 10, onlyWhenIdle: true })
  assert.equal(missing.close, false)
  assert.equal(missing.warn, true)

  const recent = decideIdleClose({ ...activity, lastActivityAt: NOW - 2 * 60_000 }, { hiddenSince: NOW - 30 * 60_000, now: NOW, idleMinutes: 10, onlyWhenIdle: true })
  assert.equal(recent.close, false)
  assert.equal(recent.reason, 'recent-activity')

  const disabled = decideIdleClose(activity, { hiddenSince: NOW - 30 * 60_000, now: NOW, idleMinutes: 10, onlyWhenIdle: false })
  assert.equal(disabled.close, true, 'explicit idleCloseOnlyWhenIdle=false keeps the old opt-out')
})

test('decideIdleClose: hiddenSince after last activity still requires the full idle window', () => {
  const activity = { ok: true, lastActivityAt: NOW - 30 * 60_000, turnRunning: false }
  const out = decideIdleClose(activity, { hiddenSince: NOW - 5 * 60_000, now: NOW, idleMinutes: 10, onlyWhenIdle: true })
  assert.equal(out.close, false)
  assert.equal(out.reason, 'recent-activity', 'only 5m since hidden, not 10m')
  assert.equal(out.idleMs, 5 * 60_000)
})

test('readForkActivity: blank seeded session does not poison a completed decision', () => {
  const home = tmpDir('fang-activity-blank-')
  try {
    writeSession(home, 'session-33333333-2222-4333-8444-555555555555', [
      { type: 'turn/start', seq: 1, time: NOW - 21 * 60_000, data: { turn: 1 } },
      { type: 'turn/end', seq: 2, time: NOW - 20 * 60_000, data: { turn: 1 } },
    ], { mtimeMs: NOW - 20 * 60_000 })
    writeSession(home, 'session-44444444-2222-4333-8444-555555555555', [
      { type: 'session', version: 4, id: 'session-44444444-2222-4333-8444-555555555555', createdAt: NOW },
      { type: 'permission/preset', seq: 0, time: NOW, data: { preset: 'standard' } },
      { type: 'session/end-seed', seq: 1, time: NOW, data: {} },
    ], { mtimeMs: NOW })
    const activity = readForkActivity(home, { now: NOW })
    assert.equal(activity.turnRunning, false, 'blank seed must not force null')
    assert.equal(activity.sessionId, 'session-33333333-2222-4333-8444-555555555555')
    const decision = decideIdleClose(activity, { hiddenSince: NOW - 30 * 60_000, now: NOW + 30 * 60_000, idleMinutes: 10, onlyWhenIdle: true })
    assert.equal(decision.close, true)
    assert.equal(decision.reason, 'turn-ended-idle')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('readForkActivity: no home / no sessions is explicit none (never fabricated idle)', () => {
  const noHome = readForkActivity('', { now: NOW })
  assert.equal(noHome.ok, false)
  assert.equal(noHome.turnRunning, null)
  const emptyHome = tmpDir('fang-activity-empty-')
  try {
    const none = readForkActivity(emptyHome, { now: NOW })
    assert.equal(none.ok, true)
    assert.equal(none.lastActivityAt, null)
    assert.equal(none.turnRunning, null)
    assert.equal(none.signal, 'none')
  } finally {
    fs.rmSync(emptyHome, { recursive: true, force: true })
  }
})

test('readForkActivity: newest tail turn state wins and mtime-only logs are not claimed idle', () => {
  const homeActive = tmpDir('fang-activity-active-')
  const homeEnded = tmpDir('fang-activity-ended-')
  try {
    writeSession(homeActive, 'session-11111111-2222-4333-8444-555555555555', [
      { type: 'turn/start', seq: 1, time: NOW - 60_000, data: { turn: 1 } },
      { type: 'assistant/message', seq: 2, time: NOW - 59_000, data: {} },
    ], { mtimeMs: NOW - 59_000 })
    const active = readForkActivity(homeActive, { now: NOW })
    assert.equal(active.ok, true)
    assert.equal(active.turnRunning, true)
    assert.equal(active.lastActivityAt, NOW - 59_000)
    assert.equal(active.sessionId, 'session-11111111-2222-4333-8444-555555555555')

    writeSession(homeEnded, 'session-22222222-2222-4333-8444-555555555555', [
      { type: 'turn/end', seq: 1, time: NOW - 20 * 60_000, data: { turn: 1 } },
    ], { mtimeMs: NOW - 20 * 60_000 })
    const ended = readForkActivity(homeEnded, { now: NOW })
    assert.equal(ended.turnRunning, false)
    assert.equal(ended.lastActivityAt, NOW - 20 * 60_000)
  } finally {
    fs.rmSync(homeActive, { recursive: true, force: true })
    fs.rmSync(homeEnded, { recursive: true, force: true })
  }
})
