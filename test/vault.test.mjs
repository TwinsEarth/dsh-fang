// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exportVault, readVault, importVault } from '../vault/lib/vault.mjs'

function makeHome(root) {
  const home = path.join(root, 'home')
  fs.mkdirSync(path.join(home, 'profiles', 'old'), { recursive: true })
  fs.mkdirSync(path.join(home, 'sessions', 'ws', 'session-1'), { recursive: true })
  fs.mkdirSync(path.join(home, 'attachments', 'v1', 'objects', 'ab'), { recursive: true })
  fs.mkdirSync(path.join(home, 'storages'), { recursive: true })
  fs.mkdirSync(path.join(home, 'xclient'), { recursive: true })
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true })
  fs.writeFileSync(path.join(home, 'profiles', 'old', 'package.json'), '{"name":"p"}\n')
  fs.writeFileSync(path.join(home, 'profiles', 'old', 'cordis.patch.yml'), '[]\n')
  fs.writeFileSync(path.join(home, 'sessions', 'ws', 'session-1', 'session.v4.jsonl.zstd'), 'zstd')
  fs.writeFileSync(path.join(home, 'attachments', 'v1', 'objects', 'ab', 'abc'), 'att')
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces: { w: { path: path.join(root, 'project'), title: 'T', sessionIds: ['session-1'] } } } }))
  fs.writeFileSync(path.join(home, '.credentials.yaml'), 'token: secret\n')
  fs.mkdirSync(path.join(root, 'project'), { recursive: true })
  fs.writeFileSync(path.join(root, 'project', 'a.txt'), 'project')
  return home
}

test('Vault: curated export defaults (no workspace, secrets included), optional workspace snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-vault-'))
  const home = makeHome(root)
  const out = exportVault({ homeDir: home, destDir: path.join(root, 'vault'), task: { taskId: 'task_1', title: 'T', profile: 'old' } })
  assert.equal(out.ok, true)
  assert.equal(fs.existsSync(path.join(out.dir, '10_SESSIONS', 'session-1', 'session.v4.jsonl.zstd')), true)
  assert.equal(fs.existsSync(path.join(out.dir, '20_ATTACHMENTS', 'v1', 'objects', 'ab', 'abc')), true)
  assert.equal(fs.existsSync(path.join(out.dir, '40_FORK_PROFILE', 'old', 'package.json')), true)
  assert.equal(fs.existsSync(path.join(out.dir, '70_SECRETS', '.credentials.yaml')), true)
  assert.equal(fs.existsSync(path.join(out.dir, '30_WORKSPACES')), false)
  const withWs = exportVault({ homeDir: home, destDir: path.join(root, 'vault-ws'), task: { taskId: 'task_1', title: 'T', profile: 'old', workspacePath: path.join(root, 'project') }, options: { workspace: true, workspaceSnapshot: true } })
  assert.equal(fs.existsSync(path.join(withWs.dir, '30_WORKSPACES', 'snapshot', 'a.txt')), true)
})

test('Vault: import restores sessions/profile into a new home', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-vault-import-'))
  const home = makeHome(root)
  const out = exportVault({ homeDir: home, destDir: path.join(root, 'vault'), task: { taskId: 'task_1', title: 'T', profile: 'old' } })
  assert.equal(readVault(out.dir).ok, true)
  const target = path.join(root, 'imported')
  const result = importVault({ sourceDir: out.dir, homeDir: target, profile: 'fang-new' })
  assert.equal(result.ok, true)
  assert.equal(fs.existsSync(path.join(target, 'sessions', 'ws', 'session-1', 'session.v4.jsonl.zstd')), true)
  assert.equal(fs.existsSync(path.join(target, 'profiles', 'fang-new', 'package.json')), true)
  assert.equal(fs.existsSync(path.join(target, '.credentials.yaml')), true)
})
