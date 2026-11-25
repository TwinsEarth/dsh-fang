// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'
import { encodeWorkspaceKey } from '../src/lib/session-format.mjs'
import {
  isLegacyWorkspacePath, legacyWorkspaceSlug, mapWorkspacePathForFork,
  mappedWorkspacePath, migrateForkWorkspace, normalizeWorkspacePath, rewriteSessionHeaderCwd,
} from '../src/lib/workspace-mapping.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fang-wsmap-'))
const SID = 'session-11111111-1111-4111-8111-111111111111'

function writeSession(home, workspacePath, { plain = false } = {}) {
  const key = encodeWorkspaceKey(workspacePath)
  const dir = path.join(home, 'sessions', key, SID)
  fs.mkdirSync(dir, { recursive: true })
  const header = { type: 'session', version: 4, id: SID, createdAt: 1, cwd: workspacePath }
  if (plain) {
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), `${JSON.stringify(header)}\n{"type":"event","n":1}\n`)
  } else {
    const frame1 = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`))
    const frame2 = zlib.zstdCompressSync(Buffer.from('{"type":"event","n":1}\n'))
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([frame1, frame2]))
  }
  return dir
}

function writeIndex(home, workspacePath, entryId = 'ws-old') {
  fs.mkdirSync(path.join(home, 'storages'), { recursive: true })
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: entryId, workspaceIds: [entryId], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { [entryId]: { path: workspacePath, title: '旧工作区', sessionIds: [SID], createdAt: 'x', updatedAt: 'x' } } },
  }, null, 2))
}

function readHeader(file) {
  const bytes = fs.readFileSync(file)
  const firstFrame = zlib.zstdDecompressSync(bytes)
  // Node decompresses all concatenated frames; first line is the header.
  return JSON.parse(Buffer.from(firstFrame).toString('utf8').split('\n')[0])
}

test('workspace map: legacy roots are exact Windows prefix matches, not substring guesses', () => {
  assert.equal(isLegacyWorkspacePath('E:\\DSH\\DS'), true)
  assert.equal(isLegacyWorkspacePath('e:/dsh/ds/Fang'), true)
  assert.equal(isLegacyWorkspacePath('E:\\DSH\\DSX'), true, 'E:\\DSH is a legacy parent root too')
  assert.equal(isLegacyWorkspacePath('E:\\DSH2\\DS'), false)
  assert.equal(isLegacyWorkspacePath('C:\\Users\\fangw'), false)
  assert.equal(normalizeWorkspacePath('E:\\DSH\\DS\\'), 'e:/dsh/ds')
  assert.equal(legacyWorkspaceSlug('E:\\DSH\\DS'), 'drive-E-DSH-DS')
})

test('workspace map: target stays inside the fork home and marker is explicit', () => {
  const home = tmp()
  const mapped = mappedWorkspacePath(home, 'E:\\DSH\\DS')
  assert.equal(mapped, path.join(home, 'workspace', 'legacy', 'drive-E', 'DSH', 'DS'))
  const result = mapWorkspacePathForFork(home, 'E:\\DSH\\DS', { forkId: 'task-x' })
  assert.equal(result.mapped, true)
  assert.equal(fs.existsSync(path.join(mapped, '.fang-workspace-map.json')), true)
  const marker = JSON.parse(fs.readFileSync(path.join(mapped, '.fang-workspace-map.json'), 'utf8'))
  assert.equal(marker.mode, 'redirect-only')
  assert.equal(marker.originalPath, 'E:\\DSH\\DS')
  assert.equal(marker.forkId, 'task-x')
})

test('workspace map: migrates existing session key/header while preserving event frames', () => {
  const home = tmp()
  writeSession(home, 'E:\\DSH\\DS')
  writeIndex(home, 'E:\\DSH\\DS')
  const oldKey = encodeWorkspaceKey('E:\\DSH\\DS')
  const oldDir = path.join(home, 'sessions', oldKey, SID)
  assert.equal(fs.existsSync(oldDir), true)

  const result = migrateForkWorkspace(home, { forkId: 'task-x' })
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.equal(result.mappings.length, 1)
  const newKey = encodeWorkspaceKey(result.mappings[0].mappedPath)
  const newDir = path.join(home, 'sessions', newKey, SID)
  assert.equal(fs.existsSync(newDir), true)
  assert.equal(fs.existsSync(oldDir), false, 'the session dir is moved, not copied')
  assert.equal(fs.existsSync(path.join(home, 'sessions', oldKey)), true, 'the old workspace-key parent may remain empty')
  assert.equal(readHeader(path.join(newDir, 'session.v4.jsonl.zstd')).cwd, result.mappings[0].mappedPath)

  const index = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'))
  assert.equal(index.tables.workspaces['ws-old'].path, result.mappings[0].mappedPath)
  assert.equal(index.tables.workspaces['ws-old'].workspaceMapping.originalPath, 'E:\\DSH\\DS')
  assert.equal(fs.existsSync(path.join(home, '_workspace-map', 'mappings.json')), true)
  assert.equal(fs.existsSync(result.workspaceBackup), true)
})

test('workspace map: idempotent and rewrites plain JSONL header too', () => {
  const home = tmp()
  writeSession(home, 'E:\\DSH\\DS', { plain: true })
  writeIndex(home, 'E:\\DSH\\DS')
  const first = migrateForkWorkspace(home, {})
  assert.equal(first.ok, true)
  const second = migrateForkWorkspace(home, {})
  assert.equal(second.ok, true)
  assert.equal(second.changed, false)
  assert.equal(second.moved.length, 0)
  const newKey = encodeWorkspaceKey(first.mappings[0].mappedPath)
  const text = fs.readFileSync(path.join(home, 'sessions', newKey, SID, 'session.v4.jsonl.zstd'), 'utf8')
  assert.equal(JSON.parse(text.split('\n')[0]).cwd, first.mappings[0].mappedPath)
})

test('workspace map: header rewrite is fail-closed on corrupt input', () => {
  const home = tmp()
  const file = path.join(home, 'bad.session.v4.jsonl.zstd')
  fs.writeFileSync(file, 'not zstd')
  const out = rewriteSessionHeaderCwd(file, 'E:\\DSH\\DS', 'C:\\x')
  assert.equal(out.ok, false)
  assert.equal(out.changed, false)
})

test('workspace map: startup sweep covers existing fork homes, not only new imports', () => {
  const source = fs.readFileSync(new URL('../src/plugins/orchestrator.mjs', import.meta.url), 'utf8')
  assert.match(source, /fork-workspace-migrated-startup/)
  assert.match(source, /for \(const entry of fs\.readdirSync\(layout\.forkHomesDir/)
  assert.match(source, /migrateForkWorkspace\(home, \{ roots: workspaceMigrationRoots\(cfg\) \}\)/)
  assert.match(source, /DEFAULT_LEGACY_WORKSPACE_ROOTS/)
})
