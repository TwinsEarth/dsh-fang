// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exportForkHome, readForkExport } from '../src/lib/fork-export.mjs'

test('fork export/import: full home round-trips, node_modules/tmp excluded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-export-'))
  const home = path.join(root, 'home')
  fs.mkdirSync(path.join(home, 'profiles', 'p1'), { recursive: true })
  fs.mkdirSync(path.join(home, 'sessions', 'w'), { recursive: true })
  fs.mkdirSync(path.join(home, 'tmp'), { recursive: true })
  fs.mkdirSync(path.join(home, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(home, 'profiles', 'p1', 'package.json'), '{"name":"p"}\n')
  fs.writeFileSync(path.join(home, 'sessions', 'w', 's.jsonl'), '{"type":"user"}\n')
  fs.writeFileSync(path.join(home, 'tmp', 'x'), 'tmp')
  fs.writeFileSync(path.join(home, 'node_modules', 'x'), 'nm')
  const out = exportForkHome({ homeDir: home, destDir: path.join(root, 'export'), task: { taskId: 'task_x', title: 'T', profile: 'p1' } })
  assert.equal(out.ok, true)
  assert.equal(fs.existsSync(path.join(out.dir, 'home', 'sessions', 'w', 's.jsonl')), true)
  assert.equal(fs.existsSync(path.join(out.dir, 'home', 'tmp')), false)
  assert.equal(fs.existsSync(path.join(out.dir, 'home', 'node_modules')), false)
  const parsed = readForkExport(out.dir)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.manifest.format, 'dsh-fang-fork-export/v1')
  assert.equal(parsed.manifest.profile, 'p1')
})
