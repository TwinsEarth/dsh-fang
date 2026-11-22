// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installGlobalRedline } from '../src/lib/global-redline.mjs'

test('global redline: fork may write own home, cannot write mother/client/other forks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-redline-'))
  const own = path.join(root, 'mother', 'forks', 'task_a')
  const mother = path.join(root, 'mother')
  const profiles = path.join(root, 'profiles')
  const install = path.join(root, 'install')
  for (const dir of [own, path.join(mother, 'forks', 'task_b'), profiles, install]) fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.join(profiles, 'desktop'), { recursive: true })
  fs.writeFileSync(path.join(profiles, 'desktop', 'read.txt'), 'read')
  const result = installGlobalRedline({ ownHome: own, motherData: mother, profilesRoot: profiles, installRoot: install })
  assert.equal(result.ok, true)
  fs.writeFileSync(path.join(own, 'ok.txt'), 'ok')
  assert.equal(fs.readFileSync(path.join(own, 'ok.txt'), 'utf8'), 'ok')
  for (const target of [
    path.join(profiles, 'desktop', 'package.json'),
    path.join(install, 'resources', 'app.asar'),
    path.join(mother, 'forks', 'task_b', 'x.txt'),
    path.join(mother, 'tasks.json'),
  ]) {
    assert.throws(() => fs.writeFileSync(target, 'x'), (error) => error?.fangRedline === true && error?.code === 'EPERM')
  }
  // Reads stay allowed: only writes are red-lined.
  assert.equal(fs.readFileSync(path.join(profiles, 'desktop', 'read.txt'), 'utf8'), 'read')
})
