// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildManagedBrowserArgs } from '../src/lib/browser-guard.mjs'

test('managed browser gives each page its own renderer and exits after the last page closes', () => {
  const args = buildManagedBrowserArgs({
    url: 'http://127.0.0.1:18080',
    profileDir: 'C:\\tmp\\browser-profile',
    port: 19444,
    logFile: 'C:\\tmp\\browser.log',
    crashDir: 'C:\\tmp\\crash',
  })
  assert.ok(args.includes('--process-per-tab'), 'tabs must not share a renderer')
  assert.ok(args.includes('--disable-background-mode'), 'last page close must reap the tree')
  assert.equal(args.some(arg => arg.startsWith('--renderer-process-limit')), false, 'single-renderer cap must be gone')
  assert.ok(args.includes('--app=http://127.0.0.1:18080'))
})
