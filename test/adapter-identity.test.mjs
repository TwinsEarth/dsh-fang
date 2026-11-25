// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T-identity — adapter Web identity contract (v3.1.14): the browser cannot hold the
// adapter Bearer token, so /fang/adapter/identity is public and only exposes role/kind.
import test from 'node:test'
import assert from 'node:assert/strict'

import { identityKind } from '../src/plugins/adapter.mjs'

test('adapter identity: role/taskId/env map to mother/essence/fork', () => {
  assert.equal(identityKind({ role: 'mother' }), 'mother')
  assert.equal(identityKind({ role: 'fork', taskId: 'task_abc' }), 'fork')
  assert.equal(identityKind({ role: 'fork', taskId: 'rt-official-dev' }), 'essence')
  assert.equal(identityKind({ role: 'fork', taskId: 'task_abc', essence: true }), 'essence', 'explicit runtime env wins')
  assert.equal(identityKind({}), 'fork')
})
