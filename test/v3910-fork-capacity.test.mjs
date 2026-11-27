// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v3.9.10 — edition quotas for concurrent fork processes and managed browser windows.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { makeCtx, makeWebServerStub, TEST_AUTH_TOKEN } from './helpers.mjs'
import { SERVICE } from '../src/kernel/index.mjs'
import {
  ACTIVE_FORK_EDITION, DEFAULT_MAX_FORKS, DEFAULT_MAX_FORK_WEBS,
  FORK_EDITION, FORK_WEB_QUOTAS, HARD_MAX_FORKS, HARD_MAX_FORK_WEBS,
  effectiveForkLimit, effectiveForkWebLimit, forkQuotaForEdition,
} from '../src/lib/fork-capacity.mjs'
import * as orchestrator from '../src/plugins/orchestrator.mjs'

test('v3.9.10 edition table: standard 5 / professional 20 / team 100', () => {
  assert.equal(ACTIVE_FORK_EDITION, FORK_EDITION.STANDARD)
  assert.equal(DEFAULT_MAX_FORKS, 5)
  assert.equal(DEFAULT_MAX_FORK_WEBS, 5)
  assert.equal(HARD_MAX_FORKS, 100)
  assert.equal(HARD_MAX_FORK_WEBS, 100)
  assert.equal(FORK_WEB_QUOTAS.standard.maxForkWeb, 5)
  assert.equal(FORK_WEB_QUOTAS.standard.maxForks, 5)
  assert.equal(FORK_WEB_QUOTAS.standard.available, true)
  assert.equal(FORK_WEB_QUOTAS.professional.maxForkWeb, 20)
  assert.equal(FORK_WEB_QUOTAS.professional.maxForks, 20)
  assert.equal(FORK_WEB_QUOTAS.professional.available, false)
  assert.equal(FORK_WEB_QUOTAS.team.maxForkWeb, 100)
  assert.equal(FORK_WEB_QUOTAS.team.maxForks, 100)
  assert.equal(FORK_WEB_QUOTAS.team.available, false)
  assert.equal(forkQuotaForEdition('unknown').edition, FORK_EDITION.STANDARD)
})

test('v3.9.10 effective limits clamp to the active edition, never silently to 1', () => {
  assert.equal(effectiveForkWebLimit(100), 5)
  assert.equal(effectiveForkWebLimit(8), 5)
  assert.equal(effectiveForkWebLimit(1), 1)
  assert.equal(effectiveForkLimit(100), 5)
  assert.equal(effectiveForkLimit(8), 5)
  assert.equal(effectiveForkWebLimit(100, FORK_EDITION.PROFESSIONAL), 20)
  assert.equal(effectiveForkLimit(100, FORK_EDITION.PROFESSIONAL), 20)
  assert.equal(effectiveForkWebLimit(100, FORK_EDITION.TEAM), 100)
  assert.equal(effectiveForkLimit(100, FORK_EDITION.TEAM), 100)
})

test('v3.9.10 Config defaults expose the ordinary-edition browser quota', () => {
  const cfg = orchestrator.Config({})
  assert.equal(cfg.maxForks, 5)
  assert.equal(cfg.maxOpenForkBrowsers, 5)
  assert.equal(cfg.singleActiveFork, false)
  assert.equal(orchestrator.Config({ maxForks: 100 }).maxForks, 100)
  assert.equal(orchestrator.Config({ maxOpenForkBrowsers: 100 }).maxOpenForkBrowsers, 100)
})

test('v3.9.10 browser admission reads the effective quota, not a raw 1 adapter', () => {
  const root = new URL('..', import.meta.url)
  const orchestratorSource = fs.readFileSync(new URL('./src/plugins/orchestrator.mjs', root), 'utf8')
  const clientSource = fs.readFileSync(new URL('./client.js', root), 'utf8')
  assert.match(orchestratorSource, /const max = effectiveMaxOpenForkBrowsers\(\)/)
  assert.doesNotMatch(orchestratorSource, /Number\(cfg\.maxOpenForkBrowsers\) \|\| 1/)
  assert.match(orchestratorSource, /browsers: \(\(\) => \{/)
  assert.match(clientSource, /并发配额关闭/)
  assert.match(clientSource, /Web \$\{browserUsed\}\/\$\{browserLimit\}/)
})

test('v3.9.10 status reports both task and browser capacity for the active edition', async () => {  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-v3910-capacity-'))
  const forker = {
    async spawn() { throw new Error('no-spawn-in-capacity-test') },
    status() { return { running: false } },
    list() { return [] },
  }
  const ctx = makeCtx({ services: { [SERVICE.forker]: forker, webServer: makeWebServerStub() } })
  try {
    orchestrator.apply(ctx, {
      dataRoot,
      forksRoot: path.join(dataRoot, 'forks'),
      routes: { enabled: false },
      authToken: TEST_AUTH_TOKEN,
      allowMultiFork: true,
      maxForks: 8,
      maxOpenForkBrowsers: 100,
    })
    const status = ctx.get(SERVICE.orchestrator).status()
    assert.equal(status.capacity.edition, FORK_EDITION.STANDARD)
    assert.equal(status.capacity.limit, 5)
    assert.equal(status.capacity.slots, 5)
    assert.equal(status.capacity.hardMax, 100)
    assert.equal(status.capacity.browsers.limit, 5)
    assert.equal(status.capacity.browsers.hardMax, 100)
    assert.equal(status.capacity.browsers.defaultLimit, 5)
    assert.equal(status.capacity.browsers.used, 0)
  } finally {
    try { ctx.dispose() } catch { /* ignore */ }
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
})
