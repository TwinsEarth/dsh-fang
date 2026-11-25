// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// session-bundle: selected-session export/import, keep-both conflicts, pending workspaces.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { tmpDir } from './helpers.mjs'
import { exportSessions, importSessions, SESSION_LOG } from '../src/lib/session-bundle.mjs'
import { encodeWorkspaceKey } from '../src/lib/session-format.mjs'

const sha = (b) => createHash('sha256').update(b).digest('hex')

function makeSource(root) {
  const wsA = 'E:\\proj-a'
  const wsB = 'E:\\proj-b'
  for (const [ws, sid, text] of [
    [wsA, 'session-11111111-2222-4333-8444-555555555555', 'A-one'],
    [wsA, 'session-22222222-3333-4444-8555-666666666666', 'A-two'],
    [wsB, 'session-33333333-4444-5555-8666-777777777777', 'B-one'],
  ]) {
    const dir = path.join(root, 'sessions', encodeWorkspaceKey(ws), sid)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, SESSION_LOG), text)
  }
  return { wsA, wsB }
}

test('session-bundle: export copies only the selected sessions, read-only on the source', () => {
  const dir = tmpDir('fang-bundle-')
  try {
    const srcRoot = path.join(dir, 'pc')
    const bundle = path.join(dir, 'bundle')
    const { wsA } = makeSource(srcRoot)
    const before = fs.readFileSync(path.join(srcRoot, 'sessions', encodeWorkspaceKey(wsA), 'session-11111111-2222-4333-8444-555555555555', SESSION_LOG), 'utf8')

    const out = exportSessions({
      sessionsRoot: path.join(srcRoot, 'sessions'),
      bundleDir: bundle,
      sessionIds: ['session-11111111-2222-4333-8444-555555555555'],
      workspaces: [{ path: wsA, title: 'proj-a' }, { path: 'E:\\proj-b', title: 'proj-b' }],
    })
    assert.equal(out.ok, true)
    assert.deepEqual(out.exported, ['session-11111111-2222-4333-8444-555555555555'])
    assert.equal(out.manifest.sessions[0].workspacePath, wsA)
    assert.equal(out.manifest.sessions[0].sha256, sha(Buffer.from('A-one')))
    assert.equal(fs.existsSync(path.join(bundle, 'sessions', encodeWorkspaceKey(wsA), 'session-11111111-2222-4333-8444-555555555555', SESSION_LOG)), true)
    assert.equal(fs.readFileSync(path.join(srcRoot, 'sessions', encodeWorkspaceKey(wsA), 'session-11111111-2222-4333-8444-555555555555', SESSION_LOG), 'utf8'), before, 'source untouched')

    // unselected session is absent from the bundle
    assert.equal(fs.existsSync(path.join(bundle, 'sessions', encodeWorkspaceKey(wsA), 'session-22222222-3333-4444-8555-666666666666')), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('session-bundle: import matches by workspace path, never overwrites (keep-both + fork)', () => {
  const dir = tmpDir('fang-bundle-')
  try {
    const srcRoot = path.join(dir, 'pc')
    const bundle = path.join(dir, 'bundle')
    const target = path.join(dir, 'target')
    const { wsA } = makeSource(srcRoot)
    exportSessions({
      sessionsRoot: path.join(srcRoot, 'sessions'),
      bundleDir: bundle,
      sessionIds: ['session-11111111-2222-4333-8444-555555555555'],
      workspaces: [{ path: wsA, title: 'proj-a' }],
    })

    const first = importSessions({ bundleDir: bundle, targetSessionsRoot: path.join(target, 'sessions'), workspaces: [{ path: wsA, title: 'proj-a' }], encodeWorkspaceKey })
    assert.equal(first.ok, true)
    assert.deepEqual(first.pulled, ['session-11111111-2222-4333-8444-555555555555'])
    const destDir = path.join(target, 'sessions', encodeWorkspaceKey(wsA), 'session-11111111-2222-4333-8444-555555555555')
    assert.equal(fs.readFileSync(path.join(destDir, SESSION_LOG), 'utf8'), 'A-one')

    const second = importSessions({ bundleDir: bundle, targetSessionsRoot: path.join(target, 'sessions'), workspaces: [{ path: wsA, title: 'proj-a' }], encodeWorkspaceKey })
    assert.deepEqual(second.conflicts, ['session-11111111-2222-4333-8444-555555555555'])
    assert.equal(fs.readFileSync(path.join(destDir, SESSION_LOG), 'utf8'), 'A-one', 'existing session is not overwritten')
    assert.equal(fs.readdirSync(destDir).some((f) => f.includes('.fork-')), true, 'the incoming copy is kept as a fork file')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('session-bundle: a missing workspace goes to pendingMatch instead of guessing', () => {
  const dir = tmpDir('fang-bundle-')
  try {
    const srcRoot = path.join(dir, 'pc')
    const bundle = path.join(dir, 'bundle')
    const { wsA } = makeSource(srcRoot)
    exportSessions({ sessionsRoot: path.join(srcRoot, 'sessions'), bundleDir: bundle, sessionIds: ['session-11111111-2222-4333-8444-555555555555'], workspaces: [{ path: wsA, title: 'proj-a' }] })
    const out = importSessions({ bundleDir: bundle, targetSessionsRoot: path.join(dir, 'target', 'sessions'), workspaces: [], encodeWorkspaceKey })
    assert.deepEqual(out.pendingMatch, ['session-11111111-2222-4333-8444-555555555555'])
    assert.equal(out.pulled.length, 0)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
