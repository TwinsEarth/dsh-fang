// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.3.5: 审批/提升链路的真实执行 drill（隔离 dataRoot，不碰生产）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { cleanupApprovalDrill, runApprovalDrill } from '../src/lib/approval-drill.mjs'

test('approval drill: red promotion request → decide → snapshot → rollback', async () => {
  const result = await runApprovalDrill()
  try {
    assert.equal(result.ok, true, JSON.stringify({ error: result.error, request: result.request, pendingBefore: result.pendingBefore, pendingAfter: result.pendingAfter, snapshot: result.snapshot, rollback: result.rollback, restored: result.restored }))
    assert.equal(result.request.kind, 'promotion')
    assert.equal(result.request.risk, 'red')
    assert.equal(result.request.outcome, 'approved')
    assert.equal(result.pendingBefore, 1)
    assert.equal(result.pendingAfter, 0)
    assert.notEqual(result.snapshot.ok, false)
    assert.equal(result.rollback.ok, true)
    assert.equal(result.restored, true)
  } finally {
    assert.equal(cleanupApprovalDrill(result), true, 'drill must leave zero residue')
  }
})
