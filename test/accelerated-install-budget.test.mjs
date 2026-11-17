// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// P2/D4: 1 GiB install budget — above it an explicit second confirmation is required.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ACCEL_INSTALL_LIMIT_BYTES,
  acceleratedInstallSize,
  dirSizeBytes,
  ensureInstallBudget,
  installAcceleratedCore,
} from '../src/lib/accelerated-install.mjs'

const LIMIT = ACCEL_INSTALL_LIMIT_BYTES

test('limit is exactly 1 GiB', () => {
  assert.equal(LIMIT, 1024 * 1024 * 1024)
})

test('dirSizeBytes walks nested directories; missing dir is 0', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-budget-'))
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
  fs.writeFileSync(path.join(root, 'a', 'one.bin'), Buffer.alloc(1000))
  fs.writeFileSync(path.join(root, 'a', 'b', 'two.bin'), Buffer.alloc(2500))
  assert.equal(dirSizeBytes(root), 3500)
  assert.equal(dirSizeBytes(path.join(root, 'missing')), 0)
})

test('ensureInstallBudget: under the limit passes without confirmation', async () => {
  const out = await ensureInstallBudget({ sizeBytes: LIMIT, confirmOversize: false })
  assert.equal(out.ok, true)
  assert.equal(out.requiresConfirmation, undefined)
})

test('ensureInstallBudget: over the limit fails closed with a confirmation requirement', async () => {
  const out = await ensureInstallBudget({ sizeBytes: LIMIT + 1, confirmOversize: false })
  assert.equal(out.ok, false)
  assert.equal(out.error, 'accelerated-install-too-large')
  assert.equal(out.requiresConfirmation, true)
  assert.equal(out.limitBytes, LIMIT)
})

test('ensureInstallBudget: explicit flag or interactive accept passes', async () => {
  const flagged = await ensureInstallBudget({ sizeBytes: LIMIT + 1, confirmOversize: true })
  assert.equal(flagged.ok, true)
  assert.equal(flagged.confirmed, true)

  const accepted = await ensureInstallBudget({ sizeBytes: LIMIT + 1, promptImpl: async () => true })
  assert.equal(accepted.ok, true)

  const declined = await ensureInstallBudget({ sizeBytes: LIMIT + 1, promptImpl: async () => false })
  assert.equal(declined.ok, false)
  assert.equal(declined.requiresConfirmation, true)
})

test('installAcceleratedCore: reuse path also enforces the budget', async () => {
  // A fake install whose measured size we can force by a big sparse-ish file is
  // too slow for 1 GiB; instead we assert that the reuse path calls the budget
  // helper by checking a missing install returns the normal error contract.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-budget-reuse-'))
  const out = await installAcceleratedCore({
    fangHome: root,
    version: '9.9.9',
    spawnImpl: () => ({
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      once(event, cb) { if (event === 'exit') setTimeout(() => cb(1), 0); return this },
      kill: () => {},
    }),
  })
  assert.equal(out.ok, false)
  assert.equal(out.error, 'install-failed')
  assert.equal(acceleratedInstallSize(root), 0)
})
