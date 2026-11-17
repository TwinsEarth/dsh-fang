// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// P1: fork core switch (persisted settings + panel/route/source guards).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_FORK_CORE,
  FORK_CORE_FILE,
  normalizeForkCoreMode,
  normalizeForkCoreSettings,
  normalizeForkSessionMode,
  readForkCoreSettings,
  writeForkCoreSettings,
} from '../src/lib/fork-core-settings.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function tmp(prefix = 'fang-fork-core-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('defaults: stock + new session', () => {
  assert.equal(DEFAULT_FORK_CORE.mode, 'stock')
  assert.equal(DEFAULT_FORK_CORE.sessionMode, 'new')
  const empty = tmp()
  assert.deepEqual(readForkCoreSettings(empty), { mode: 'stock', sessionMode: 'new', updatedAt: null, updatedBy: null })
})

test('normalizers: unknown values fall back to the safe defaults', () => {
  assert.equal(normalizeForkCoreMode('accelerated'), 'accelerated')
  assert.equal(normalizeForkCoreMode('ACCELERATED'), 'stock')
  assert.equal(normalizeForkCoreMode(''), 'stock')
  assert.equal(normalizeForkSessionMode('inherit'), 'inherit')
  assert.equal(normalizeForkSessionMode('nope'), 'new')
  assert.deepEqual(normalizeForkCoreSettings(null), { mode: 'stock', sessionMode: 'new', updatedAt: null, updatedBy: null })
})

test('write → read round-trip persists both fields atomically', () => {
  const dir = tmp()
  const written = writeForkCoreSettings(dir, { mode: 'accelerated' }, { by: 'panel', at: '2026-11-17T00:00:00.000Z' })
  assert.equal(written.ok, true)
  assert.ok(fs.existsSync(path.join(dir, FORK_CORE_FILE)))
  const read = readForkCoreSettings(dir)
  assert.equal(read.mode, 'accelerated')
  assert.equal(read.sessionMode, 'new')
  assert.equal(read.updatedBy, 'panel')
  assert.equal(read.updatedAt, '2026-11-17T00:00:00.000Z')
})

test('partial patch keeps the untouched field', () => {
  const dir = tmp()
  writeForkCoreSettings(dir, { mode: 'accelerated', sessionMode: 'inherit' })
  writeForkCoreSettings(dir, { mode: 'stock' })
  const read = readForkCoreSettings(dir)
  assert.equal(read.mode, 'stock')
  assert.equal(read.sessionMode, 'inherit')
})

test('corrupt file degrades to defaults instead of throwing', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, FORK_CORE_FILE), '{ not json')
  assert.deepEqual(readForkCoreSettings(dir), { mode: 'stock', sessionMode: 'new', updatedAt: null, updatedBy: null })
})

test('missing dataDir is an explicit write error', () => {
  assert.deepEqual(writeForkCoreSettings('', { mode: 'stock' }), { ok: false, error: 'no-data-dir' })
})

test('routes and UI are wired (source guards)', () => {
  const orchestrator = fs.readFileSync(path.join(REPO, 'src', 'plugins', 'orchestrator.mjs'), 'utf8')
  assert.match(orchestrator, /routeMethods\(`\$\{prefix\}\/api\/fork-core`, \{/)
  assert.equal(/route\('(?:GET|POST)', `\$\{prefix\}\/api\/fork-core`/.test(orchestrator), false, 'one path, one register (GET+POST via routeMethods)')
  assert.match(orchestrator, /writeForkCoreSettings\(layout\.dataDir/)
  assert.match(orchestrator, /const coreMode = normalizeCoreMode\(input\.coreMode \?\? coreSettings\.mode\)/)
  assert.match(orchestrator, /accelerated-new-session/)
  // 开关不是热更新：restore/autostart 在启动前按当前开关换核（重新 provision），并只用返回的 coreMode。
  assert.match(orchestrator, /const coreSync = await syncForkCoreMode\(task\)/)
  assert.match(orchestrator, /coreMode: coreSync\.coreMode/)
  assert.equal(/normalizeCoreMode\(task\.coreMode \?\? forkCoreSettings\(\)\.mode\)/.test(orchestrator), false)
  assert.match(orchestrator, /fang\/fork-core-switched/)
  const client = fs.readFileSync(path.join(REPO, 'client.js'), 'utf8')
  assert.match(client, /分身Core核心加速引擎：(官方|一键加速)/)
  assert.match(client, /重新打开分身 Web 生效/)
  assert.match(client, /dataBtnId: 'M-09'/)
  assert.match(client, /'data-core': 'accelerated'/)
  const forkerSource = fs.readFileSync(path.join(REPO, 'src', 'plugins', 'forker.mjs'), 'utf8')
  assert.match(forkerSource, /coreMode: rec\.coreMode === 'accelerated' \? 'accelerated' : 'stock'/)
})
