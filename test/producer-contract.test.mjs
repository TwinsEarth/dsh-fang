// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T4 — 统一 producer 契约：字段校验/defaults/dedupe + envelope + catalog。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PRODUCER_CONTRACT_VERSION,
  createProducerSubmitter,
  normalizeProducerPayload,
  producerCatalog,
} from '../src/lib/producer-contract.mjs'

test('producer-contract: catalog covers all five producers with stable kinds/levels', () => {
  const catalog = producerCatalog()
  assert.equal(catalog.ok, true)
  assert.equal(catalog.version, PRODUCER_CONTRACT_VERSION)
  assert.deepEqual(catalog.producers.map((item) => item.producer), ['HarnessMM', 'PluginUpdater', 'SuperAgent', 'PJM', 'Worker'])
  assert.deepEqual(catalog.producers[0].kinds, ['harnessmm-suggestion'])
  assert.equal(catalog.producers[0].defaultLevel, 'blue')
  assert.equal(catalog.producers[2].defaultLevel, 'green')
  assert.deepEqual(catalog.producers[3].kinds, ['pjm-timeout', 'pjm-fatal'])
})

test('producer-contract: normalizes each producer with defaults + derived dedupeKey', () => {
  const hmm = normalizeProducerPayload({ producer: 'HarnessMM', title: 'use cache', id: 'h1' })
  assert.equal(hmm.ok, true)
  assert.equal(hmm.payload.kind, 'harnessmm-suggestion')
  assert.equal(hmm.payload.level, 'blue')
  assert.equal(hmm.payload.sourceRole, 'worker')
  assert.equal(hmm.payload.dedupeKey, 'HarnessMM:harnessmm-suggestion:h1')

  const updater = normalizeProducerPayload({ producer: 'PluginUpdater', title: 'backup done', backupId: 'b1' })
  assert.equal(updater.payload.level, 'green')
  assert.equal(updater.payload.kind, 'plugin-updater-backup')

  const superagent = normalizeProducerPayload({ producer: 'SuperAgent', title: 'task done', taskId: 't1' })
  assert.equal(superagent.payload.level, 'green')

  const pjm = normalizeProducerPayload({ producer: 'PJM', title: 'timeout', projectId: 'p1' })
  assert.equal(pjm.payload.kind, 'pjm-timeout')
  assert.equal(pjm.payload.timeoutMinutes, 5)
  assert.equal(pjm.payload.dedupeKey, 'PJM:pjm-timeout:p1')

  const worker = normalizeProducerPayload({
    producer: 'Worker', title: 'drift', taskId: 't2',
    options: [{ value: 'a', label: 'A' }],
  })
  assert.equal(worker.payload.level, 'yellow')
  assert.equal(worker.payload.dedupeKey, 'Worker:worker-deviation:t2')
  assert.ok(Array.isArray(worker.payload.options))
})

test('producer-contract: rejects unknown producer/kind/level, missing title/options', () => {
  assert.equal(normalizeProducerPayload({ producer: 'Nope', title: 'x' }).code, 'unknown-producer')
  assert.equal(normalizeProducerPayload({ producer: 'Worker', kind: 'nope', title: 'x' }).code, 'unknown-kind')
  assert.equal(normalizeProducerPayload({ producer: 'Worker', title: 'x', level: 'gray' }).code, 'bad-level')
  assert.equal(normalizeProducerPayload({ producer: 'Worker', title: '   ' }).code, 'title-required')
  assert.equal(normalizeProducerPayload({ producer: 'Worker', title: 'x', actions: [] }).code, 'options-or-actions-required')
  assert.equal(normalizeProducerPayload({ producer: 'Worker', title: 'x' }).ok, true, 'Worker gets default actions')
  assert.equal(normalizeProducerPayload({ producer: 'PluginUpdater', title: 'x' }).ok, true, 'green needs no options')
})

test('producer-contract: submitter returns a uniform envelope and handles failures', async () => {
  const seen = []
  const submit = createProducerSubmitter({
    submit: async (payload) => {
      seen.push(payload)
      return { ok: true, ticket: { id: 'dec_1' }, deduped: false }
    },
  })
  const result = await submit({ producer: 'PJM', title: 'PJM 超时', projectId: 'p1', timeoutMinutes: 3 })
  assert.deepEqual(result, {
    ok: true, producer: 'PJM', kind: 'pjm-timeout', level: 'yellow',
    ticketId: 'dec_1', deduped: false, queued: false, outboxId: null, reason: null,
  })
  assert.equal(seen[0].timeoutMinutes, 3)
  assert.equal(seen[0].producerContractVersion, PRODUCER_CONTRACT_VERSION)

  const invalid = await submit({ producer: 'HarnessMM' })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'title-required')
  assert.equal(seen.length, 1, 'invalid payload must not reach submit')

  const rejecting = createProducerSubmitter({ submit: async () => { throw new Error('mother down') } })
  const failed = await rejecting({ producer: 'SuperAgent', title: 'done', taskId: 't1' })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'submit-failed')
})
