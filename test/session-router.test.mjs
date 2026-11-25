// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// session-router: pure truth table for sync vs bridge vs deny.
import test from 'node:test'
import assert from 'node:assert/strict'

import { chooseMode } from '../src/plugins/session-router.mjs'

test('session-router: truth table (same machine / host / realtime / migration)', () => {
  const base = { sameMachine: true, bridgeEnabled: true, pcHostRunning: true, needsRealtime: true, oneTimeMigration: false }
  assert.equal(chooseMode(base), 'bridge')
  assert.equal(chooseMode({ ...base, needsRealtime: false }), 'sync')
  assert.equal(chooseMode({ ...base, oneTimeMigration: true }), 'sync')
  assert.equal(chooseMode({ ...base, pcHostRunning: false }), 'sync')
  assert.equal(chooseMode({ ...base, bridgeEnabled: false }), 'sync')
  assert.equal(chooseMode({ ...base, sameMachine: false }), 'deny')
  assert.equal(chooseMode({ ...base, sameMachine: false, needsRealtime: false }), 'sync')
})
