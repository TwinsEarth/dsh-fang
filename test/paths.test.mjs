// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { resolveFangHome, resolveFangLayout } from '../src/kernel/paths.mjs'

test('FANG_HOME gives D:/fang mirror/essence/sessions layout', () => {
  const layout = resolveFangLayout({ env: { FANG_HOME: 'D:/fang', DSH_PROFILE: 'desktop' }, argv: [] })
  assert.equal(layout.fangHome, path.resolve('D:/fang'))
  assert.equal(layout.dataDir, path.resolve('D:/fang/mirror/desktop'))
  assert.equal(layout.essenceRoot, path.resolve('D:/fang/essence'))
  assert.equal(layout.forkHomesDir, path.resolve('D:/fang/essence'))
  assert.equal(layout.sessionsRoot, path.resolve('D:/fang/sessions'))
  assert.equal(layout.forksFile, path.join(layout.dataDir, 'forks.json'))
})

test('without FANG_HOME legacy layout is unchanged', () => {
  const layout = resolveFangLayout({ env: { DSH_HOME: 'C:/Users/x/.dsh', DSH_PROFILE: 'desktop' }, argv: [] })
  assert.equal(layout.fangHome, '')
  assert.equal(layout.dataDir, path.resolve('C:/Users/x/.dsh/fang/desktop'))
  assert.equal(layout.forkHomesDir, path.join(layout.dataDir, 'forks'))
  assert.equal(resolveFangHome({}), '')
})
