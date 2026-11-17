// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// P0 live test: forker provisions + spawns a REAL accelerated fork.
// Gated: node --test with FANG_ACCEL_LIVE=1 (CI never downloads/boots the accelerated core).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as forker from '../src/plugins/forker.mjs'
import { makeCtx } from './helpers.mjs'
import { ACCEL_BUNDLES_WITH_FANG } from '../src/lib/accelerated-fork.mjs'
import { resolveAcceleratedCore } from '../src/lib/accelerated-install.mjs'

const LIVE = process.env.FANG_ACCEL_LIVE === '1'

test('live: accelerated fork provision + spawn on the real accelerated core', { skip: !LIVE }, async (t) => {
  const fangHome = String(process.env.FANG_HOME ?? 'D:\\ToFuture').trim()
  const resolved = resolveAcceleratedCore({ env: process.env, fangHome })
  assert.equal(resolved.ok, true, JSON.stringify(resolved))
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-accel-live-'))
  const ctx = makeCtx()
  const service = forker.apply(ctx, {
    dataRoot,
    coreMode: 'accelerated',
    acceleratedCliPath: resolved.cliPath,
    allocatePorts: false,
    startTimeoutMs: 120000,
    forkSeed: { enabled: false },
  })
  t.after(() => {
    try { service.dispose?.() } catch { /* ignore */ }
    try { fs.rmSync(dataRoot, { recursive: true, force: true }) } catch { /* junctions */ }
  })

  const homeDir = path.join(dataRoot, 'homes', 'f-a')
  const provisioned = service.provision({ forkId: 'f-a', homeDir, profile: 'accel-live', coreMode: 'accelerated' })
  assert.equal(provisioned.ok, true, JSON.stringify(provisioned))
  assert.equal(provisioned.coreMode, 'accelerated')
  const pkg = JSON.parse(fs.readFileSync(path.join(provisioned.profileDir, 'package.json'), 'utf8'))
  assert.deepEqual(pkg.dsh.profile.bundles, [...ACCEL_BUNDLES_WITH_FANG])

  const started = await service.spawn({ forkId: 'f-a', homeDir, profile: 'accel-live', coreMode: 'accelerated', port: 0 })
  assert.equal(started.ok, true, JSON.stringify(started))
  assert.ok(started.url, 'web url printed')
  const identity = await fetch(new URL('/fang/adapter/identity', started.url)).then((r) => r.json())
  assert.equal(identity.role, 'fork')
  assert.equal(identity.version, JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')).version)
  service.stop('f-a')
})
