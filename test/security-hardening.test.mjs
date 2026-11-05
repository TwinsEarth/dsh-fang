// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.5 — 安全止血（B2/B3/B5/B6/B8）：create-only、seed 修复、env 白名单、bundle 路径/大小限制。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { EssenceManager, OFFICIAL_ESSENCE_ID } from '../src/lib/essence.mjs'
import { buildForkChildEnv } from '../src/plugins/forker.mjs'
import { SYNC_MANIFEST, importSessions } from '../src/lib/session-bundle.mjs'
import { tmpDir } from './helpers.mjs'

function makeEssenceFixture() {
  const root = tmpDir('fang-sec-essence-')
  const mirrorRoot = path.join(root, 'mirror')
  const profileDir = path.join(mirrorRoot, 'active', 'profile')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- insert: []\n', 'utf8')
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'mirror', dependencies: {} }), 'utf8')
  fs.writeFileSync(path.join(mirrorRoot, 'meta.json'), JSON.stringify({ version: '3.0.5' }), 'utf8')
  const essencesRoot = path.join(root, 'essences')
  fs.mkdirSync(essencesRoot, { recursive: true })
  return { root, essencesRoot, manager: new EssenceManager({ essencesRoot, mirrorRoot }) }
}

test('B6: create-only —— 已存在的官方原身不能被 create() 抢占', () => {
  const { manager } = makeEssenceFixture()
  manager.ensureOfficialEssence()
  assert.throws(() => manager.create({
    id: OFFICIAL_ESSENCE_ID, name: '抢注', official: true, locked: true, skipQuota: true,
  }), /already exists/)
})

test('B6: 官方原身 meta 被篡改后 ensure 会修复 locked/official', () => {
  const { manager, essencesRoot } = makeEssenceFixture()
  manager.ensureOfficialEssence()
  const metaPath = path.join(essencesRoot, OFFICIAL_ESSENCE_ID, 'meta.json')
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  fs.writeFileSync(metaPath, JSON.stringify({ ...meta, locked: false, official: false }), 'utf8')
  const repaired = manager.ensureOfficialEssence()
  assert.equal(repaired.locked, true)
  assert.equal(repaired.official, true)
  assert.equal(manager.getMeta(OFFICIAL_ESSENCE_ID).locked, true)
})

test('B5: 派生 env 白名单不继承 API key / adapter token', () => {
  const env = buildForkChildEnv({
    PATH: '/usr/bin', SystemRoot: 'C:\\Windows',
    DSH_ADAPTER_TOKEN: 'adapter-secret', OPENAI_API_KEY: 'sk-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret', CUSTOM_TOKEN: 'x',
  }, { DSH_FANG_ROLE: 'fork', DSH_ADAPTER_TOKEN: 'own-token' })
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.SystemRoot, 'C:\\Windows')
  assert.equal(env.DSH_FANG_ROLE, 'fork')
  assert.equal(env.DSH_ADAPTER_TOKEN, 'own-token')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined)
  assert.equal(env.CUSTOM_TOKEN, undefined)
})

function makeBundle(bundleDir, entries) {
  fs.mkdirSync(path.join(bundleDir, 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(bundleDir, SYNC_MANIFEST), JSON.stringify({ version: 1, sessions: entries }), 'utf8')
}

test('B3: 会话导入拒绝 ../ 路径穿越（源与目标两侧）', () => {
  const root = tmpDir('fang-sec-bundle-')
  const bundleDir = path.join(root, 'bundle')
  const targetRoot = path.join(root, 'target', 'sessions')
  fs.mkdirSync(path.join(targetRoot, 'ws'), { recursive: true })
  const outside = path.join(root, 'outside.jsonl.zstd')
  fs.writeFileSync(outside, 'leak', 'utf8')
  const sha = '0'.repeat(64)
  makeBundle(bundleDir, [
    { sessionId: '../../escaped', workspacePath: '/w', workspaceTitle: 'w', file: 'a/b/log', sha256: sha },
    { sessionId: 'ok', workspacePath: '/w', workspaceTitle: 'w', file: '../../outside.jsonl.zstd', sha256: sha },
  ])
  const result = importSessions({
    bundleDir,
    targetSessionsRoot: targetRoot,
    workspaces: [{ id: 'w', path: '/w', title: 'w' }],
  })
  assert.equal(result.ok, true)
  assert.equal(result.pulled.length, 0)
  assert.ok(result.skipped.length >= 2)
  assert.equal(fs.existsSync(path.join(root, 'target', 'escaped')), false)
})

test('B3: 超过单文件大小上限的条目被跳过', () => {
  const root = tmpDir('fang-sec-bundle-big-')
  const bundleDir = path.join(root, 'bundle')
  const targetRoot = path.join(root, 'target', 'sessions')
  const file = path.join(bundleDir, 'sessions', 'w', 's1', 'log.jsonl.zstd')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.alloc(2048), 'utf8')
  fs.mkdirSync(targetRoot, { recursive: true })
  makeBundle(bundleDir, [{
    sessionId: 's1', workspacePath: '/w', workspaceTitle: 'w',
    file: 'w/s1/log.jsonl.zstd', sha256: '0'.repeat(64),
  }])
  const result = importSessions({
    bundleDir,
    targetSessionsRoot: targetRoot,
    maxFileBytes: 1024,
    workspaces: [{ id: 'w', path: '/w', title: 'w' }],
  })
  assert.equal(result.pulled.length, 0)
  assert.equal(result.skipped[0], 's1')
})
