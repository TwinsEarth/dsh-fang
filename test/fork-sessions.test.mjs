// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v3.1.34 回归：分身会话数必须落在 1..3（下限自动补空会话，上限隔离不删除）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import {
  FORK_SESSION_MAX,
  FORK_SESSION_MIN,
  buildEmptySessionFrames,
  encodeSessionLog,
  encodeWorkspaceKey,
  enforceForkSessionCap,
  ensureForkEmptySession,
  scanForkSessions,
  summarizeForkSessions,
} from '../src/lib/fork-sessions.mjs'

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-sessions-'))
  try { return fn(home) } finally { fs.rmSync(home, { recursive: true, force: true }) }
}

function seedSession(home, key, id, at) {
  const dir = path.join(home, 'sessions', key, id)
  fs.mkdirSync(dir, { recursive: true })
  const frames = buildEmptySessionFrames({ sessionId: id, createdAt: at, cwd: 'E:\\GPT' })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), encodeSessionLog(frames))
}

test('fork sessions: bounds are 1..3', () => {
  assert.equal(FORK_SESSION_MIN, 1)
  assert.equal(FORK_SESSION_MAX, 3)
})

test('fork sessions: empty fork gets exactly one legal empty session', () => {
  withHome((home) => {
    const result = ensureForkEmptySession(home, { workspacePath: 'E:\\GPT', workspaceTitle: 'GPT' })
    assert.equal(result.ok, true)
    assert.equal(result.created, true)
    assert.equal(result.workspaceKey, '--E-GPT--', 'must use the DSH workspace key encoding')
    const sessions = scanForkSessions(home)
    assert.equal(sessions.length, 1)
    // 生成的日志必须是 DSH 能读的合法 zstd + 5 帧
    const raw = zlib.zstdDecompressSync(fs.readFileSync(sessions[0].file))
    const frames = raw.toString('utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(frames.length, 5)
    assert.equal(frames[0].type, 'session')
    assert.equal(frames[0].version, 4)
    assert.equal(frames[0].id, result.sessionId)
    assert.equal(frames.at(-1).type, 'session/end-seed')
  })
})

test('fork sessions: floor is idempotent (never creates a second session)', () => {
  withHome((home) => {
    const first = ensureForkEmptySession(home, { workspacePath: 'E:\\GPT' })
    const second = ensureForkEmptySession(home, { workspacePath: 'E:\\GPT' })
    assert.equal(second.created, false)
    assert.equal(second.sessionId, first.sessionId)
    assert.equal(scanForkSessions(home).length, 1)
  })
})

test('fork sessions: cap keeps the newest three and quarantines the rest', () => {
  withHome((home) => {
    const key = encodeWorkspaceKey('E:\\GPT')
    for (let i = 0; i < 6; i += 1) seedSession(home, key, `session-cap${i}`, 1700000000000 + i * 1000)
    assert.equal(scanForkSessions(home).length, 6)
    const result = enforceForkSessionCap(home, {})
    assert.equal(result.ok, true)
    assert.equal(result.quarantined.length, 3)
    assert.equal(scanForkSessions(home).length, 3)
    // 隔离而非删除
    const quarantinedRoot = path.join(home, 'quarantine-sessions')
    assert.equal(fs.existsSync(quarantinedRoot), true)
    const summary = summarizeForkSessions(home)
    assert.equal(summary.violation, false)
    assert.equal(summary.belowFloor, false)
    assert.equal(summary.count, 3)
  })
})

test('fork sessions: branch sessions are exempt from the cap', () => {
  withHome((home) => {
    const key = encodeWorkspaceKey('E:\\GPT')
    for (let i = 0; i < 5; i += 1) seedSession(home, key, `session-main${i}`, 1700000000000 + i * 1000)
    seedSession(home, key, 'session-branch-a', 1700000000100)
    seedSession(home, key, 'session-branch-b', 1700000000200)
    const result = enforceForkSessionCap(home, { keepSessionIds: ['session-branch-a', 'session-branch-b'] })
    assert.ok(result.quarantined.length > 0, 'main sessions over the cap must be quarantined')
    const remaining = scanForkSessions(home).map((s) => s.sessionId)
    assert.ok(remaining.includes('session-branch-a'), 'branch session must survive')
    assert.ok(remaining.includes('session-branch-b'), 'branch session must survive')
  })
})

test('fork sessions: summary reports the floor for an empty fork', () => {
  withHome((home) => {
    const summary = summarizeForkSessions(home)
    assert.equal(summary.count, 0)
    assert.equal(summary.belowFloor, true)
    assert.equal(summary.violation, false)
  })
})
