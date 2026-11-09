// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T4 — business-producers：外部业务系统 → 决策中心的命名适配层。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createBusinessProducers } from '../src/lib/business-producers.mjs'

function harness() {
  const sent = []
  const producers = createBusinessProducers({ submit: async (payload) => { sent.push(payload); return { ok: true } }, now: () => 1234 })
  return { producers, sent }
}

test('business-producers: MirrorUpgrade red restart ticket + failed ticket', async () => {
  const { producers, sent } = harness()
  await producers.mirrorUpgradeRestartRequired({ from: '3.1.0', to: '3.2.0' })
  await producers.mirrorUpgradeFailed({ from: '3.1.0', reason: 'download-failed' })
  assert.equal(sent[0].producer, 'MirrorUpgrade')
  assert.equal(sent[0].kind, 'mirror-upgrade')
  assert.equal(sent[0].level, 'red')
  assert.equal(sent[0].actions[0].id, 'confirm_restart')
  assert.equal(sent[0].dedupeKey, 'mirror-upgrade:restart:3.1.0->3.2.0')
  assert.equal(sent[1].level, 'yellow')
  assert.equal(sent[1].dedupeKey, 'mirror-upgrade:failed:download-failed')
})

test('business-producers: EssenceManager conflict level follows severity', async () => {
  const { producers, sent } = harness()
  await producers.essenceConflict({ essenceId: 'e1', conflicts: [{ kind: 'x' }], severity: 'warning' })
  await producers.essenceConflict({ essenceId: 'e2', conflicts: [], severity: 'fatal' })
  assert.equal(sent[0].kind, 'essence-conflict')
  assert.equal(sent[0].level, 'yellow')
  assert.equal(sent[0].dedupeKey, 'essence-conflict:e1')
  assert.equal(sent[1].level, 'red')
})

test('business-producers: HarnessMM / PluginUpdater / SuperAgent are blue/green FYI', async () => {
  const { producers, sent } = harness()
  await producers.harnessmmSuggestion({ id: 'h1', summary: 'use cache' })
  await producers.pluginUpdaterBackup({ pluginId: 'p1', backupId: 'b1' })
  await producers.superagentCompletion({ taskId: 't1', summary: 'done' })
  assert.deepEqual(sent.map((item) => [item.producer, item.kind, item.level]), [
    ['HarnessMM', 'harnessmm-suggestion', 'blue'],
    ['PluginUpdater', 'plugin-updater-backup', 'green'],
    ['SuperAgent', 'superagent-completion', 'green'],
  ])
  assert.equal(sent[0].dedupeKey, 'harnessmm:h1')
  assert.equal(sent[1].dedupeKey, 'plugin-updater:backup:b1')
  assert.equal(sent[2].dedupeKey, 'superagent:completed:t1')
})

test('business-producers: PJM timeout is yellow with auto-gray deadline; PJM fatal is yellow; Worker deviation is yellow', async () => {
  const { producers, sent } = harness()
  await producers.pjmTimeout({ projectId: 'p1', phase: 'build' })
  await producers.pjmFatal({ projectId: 'p1', error: 'container crashed' })
  await producers.workerDeviation({ workerId: 'w1', taskId: 't1', detail: 'edited outside scope' })
  assert.deepEqual(sent.map((item) => [item.producer, item.kind, item.level]), [
    ['PJM', 'pjm-timeout', 'yellow'],
    ['PJM', 'pjm-fatal', 'yellow'],
    ['Worker', 'worker-deviation', 'yellow'],
  ])
  assert.equal(sent[0].timeoutMinutes, 5)
  assert.equal(sent[0].dedupeKey, 'pjm:timeout:p1:build')
  assert.equal(sent[1].dedupeKey, 'pjm:fatal:p1')
  assert.equal(sent[2].dedupeKey, 'worker:deviation:t1')
})

test('business-producers: submit is required', () => {
  assert.throws(() => createBusinessProducers({}), /submit required/)
})
