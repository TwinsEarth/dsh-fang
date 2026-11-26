// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.9.4 closure tests: essence quota 3/6, fork slots 8/62, SafeMode 2345/999,
// pagefile advisory-only, message inbox, and profile bundle modules manifest.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  Config, DEFAULT_MAX_FORKS, HARD_MAX_FORKS, SAFE_MODE_AUTO_CLEAR_COMMIT_MB,
  FORK_COMMIT_HARD_MIN_MB, evaluateSafeModeReset, shouldAutoClearSafeMode,
  decidePagefileBootPolicy,
} from '../src/plugins/orchestrator.mjs'
import { ESSENCE_HARD_MAX, ESSENCE_QUOTA_DEFAULT, VIP_QUOTAS } from '../src/lib/essence.mjs'
import { evaluatePagefileSingleFork } from '../src/lib/memory-guard.mjs'
import { ensureEssenceRuntimePnpmConfig, ensureModulesManifest, readModulesManifest } from '../src/lib/pnpm-store.mjs'

const root = path.resolve(import.meta.dirname, '..')
const orchestratorSource = fs.readFileSync(path.join(root, 'src/plugins/orchestrator.mjs'), 'utf8')
const client = fs.readFileSync(path.join(root, 'client.js'), 'utf8')

test('v3.9.4: essence quota is 3 by default and hard-capped at 6 for every tier', () => {
  assert.equal(ESSENCE_QUOTA_DEFAULT, 3)
  assert.equal(ESSENCE_HARD_MAX, 6)
  assert.equal(VIP_QUOTAS.free.maxEssences, 3)
  for (const tier of ['vip10', 'vip30', 'vip50', 'vip100']) {
    assert.equal(VIP_QUOTAS[tier].maxEssences, 6, `${tier}.maxEssences`)
    assert.equal(VIP_QUOTAS[tier].maxSubEssences, 6, `${tier}.maxSubEssences`)
  }
  assert.match(orchestratorSource, /capacity: \{ slots: ESSENCE_HARD_MAX, hardMax: ESSENCE_HARD_MAX, defaultLimit: ESSENCE_QUOTA_DEFAULT/)
})

test('v3.9.4: fork capacity defaults to 8 and hard-caps at 62', () => {
  assert.equal(DEFAULT_MAX_FORKS, 8)
  assert.equal(HARD_MAX_FORKS, 62)
  assert.equal(Config({}).maxForks, 8)
  assert.equal(Config({ maxForks: 62 }).maxForks, 62)
  assert.match(orchestratorSource, /capacity: \{[\s\S]{0,180}hardMax: HARD_MAX_FORKS/)
  assert.match(client, /const CAPACITY_SLOTS = 62/)
  assert.match(client, /const CAPACITY_LIMIT = 8/)
  assert.match(client, /const ESSENCE_CAPACITY_SLOTS = 6/)
  assert.match(client, /const ESSENCE_CAPACITY_LIMIT = 3/)
})

test('v3.9.4: SafeMode thresholds are 2345 auto-clear and 999 hard fork floor', () => {
  assert.equal(SAFE_MODE_AUTO_CLEAR_COMMIT_MB, 2345)
  assert.equal(FORK_COMMIT_HARD_MIN_MB, 999)
  const healthy = { ok: true, supported: true, commitFreeMB: 2345, pageFileMB: 4096, hasPageFile: true }
  assert.equal(shouldAutoClearSafeMode(healthy), true)
  assert.equal(shouldAutoClearSafeMode({ ...healthy, commitFreeMB: 2344 }), false)
  assert.equal(shouldAutoClearSafeMode({ ...healthy, reason: 'host-emergency:commit-free-emergency' }, { reason: 'host-emergency:commit-free-emergency' }), true)
  assert.equal(shouldAutoClearSafeMode(healthy, { reason: 'host-emergency:manual-panic' }), false)
  assert.equal(shouldAutoClearSafeMode(healthy, { reason: 'crash-loop-10m' }), false)
  // At/above 2345 the reset is allowed without force.
  assert.equal(evaluateSafeModeReset(healthy).ok, true)
  // Below 2345 manual reset requires force; user may force even below 999.
  assert.equal(evaluateSafeModeReset({ ...healthy, commitFreeMB: 1000 }).ok, false)
  assert.equal(evaluateSafeModeReset({ ...healthy, commitFreeMB: 1000 }, { force: true }).ok, true)
  assert.equal(evaluateSafeModeReset({ ...healthy, commitFreeMB: 998 }, { force: true }).ok, true)
  // Default config carries the new thresholds.
  assert.equal(Config({}).memoryMinFreeMB, 999)
  assert.equal(Config({}).hostCriticalFreeMB, 2345)
  assert.match(orchestratorSource, /error: critical \? 'commit-critical' : 'memory-low'/)
  assert.match(orchestratorSource, /if \(safeMode && shouldAutoClearSafeMode\(memory/)
})

test('v3.9.4: pagefile absence is advisory-only and never forces a single fork', () => {
  const memory = { ok: true, supported: true, hasPageFile: false, pageFileMB: 0, commitFreeMB: 4096 }
  assert.equal(decidePagefileBootPolicy(memory).singleForkOnly, false)
  assert.equal(evaluatePagefileSingleFork(memory, { activeForks: 1 }).ok, true)
  assert.equal(evaluatePagefileSingleFork(memory, { activeForks: 1 }).limited, false)
  assert.equal(evaluatePagefileSingleFork(memory, { activeForks: 1 }).advisory, 'pagefile-missing')
  assert.equal(orchestratorSource.includes('singleForkOnly: true'), false)
  assert.equal(orchestratorSource.includes('max = pagefileMissing === true ? 1'), false)
})

test('v3.9.4: all toasts/banners are closable and archived after 30s; critical memory popup is 7s', () => {
  assert.match(client, /const NOTICE_INBOX_DELAY_MS = 30000/)
  assert.match(client, /MESSAGE_INBOX_KEY = 'fang\.messageInbox\.v1'/)
  assert.match(client, /function renderMessageInboxModal\(S, app\)/)
  assert.match(client, /message-inbox/)
  assert.match(client, /durationMs: 7000/)
  // Toasts have an explicit close button; key banners do too.
  assert.match(client, /onClick: \(\) => app\.dismissToast\(toast\)/)
  assert.match(client, /app\.dismissBanner\?\.\('banner:pagefile'/)
  assert.match(client, /app\.dismissBanner\?\.\('banner:safe-mode'/)
  assert.match(client, /app\.dismissBanner\?\.\('banner:host-pressure'/)
  assert.match(client, /app\.dismissBanner\?\.\('banner:disk-hygiene'/)
  assert.match(client, /function armModalArchive\(\)/)
  assert.match(client, /if \(modalArchiveFor === modal\) return/)
  assert.match(client, /if \(modal\.kind === 'messageInbox'\) return/)
  assert.equal(client.includes('未启用页面文件，已强制单分身'), false)
})

test('v3.9.4: runtime profile gets .modules.yaml so pnpm cannot move bundles into .ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-v394-modules-'))
  try {
    const sourceModules = path.join(dir, 'source', 'node_modules')
    const targetModules = path.join(dir, 'target', 'node_modules')
    const targetProfile = path.join(dir, 'target')
    fs.mkdirSync(sourceModules, { recursive: true })
    fs.writeFileSync(path.join(sourceModules, '.modules.yaml'), JSON.stringify({
      storeDir: path.join(dir, 'store'),
      virtualStoreDir: path.join(sourceModules, '.pnpm'),
      layoutVersion: 5,
      packageManager: 'pnpm@11.0.0',
      nodeLinker: 'hoisted',
      hoistedDependencies: {},
      hoistedLocations: {},
    }, null, 2))
    fs.mkdirSync(targetModules, { recursive: true })

    const created = ensureModulesManifest(targetModules, { sourceModulesDir: sourceModules, profileDir: targetProfile })
    assert.equal(created.created, true)
    assert.equal(fs.existsSync(path.join(targetModules, '.modules.yaml')), true)
    const manifest = readModulesManifest(targetModules)
    assert.equal(manifest.virtualStoreDir, path.join(targetModules, '.pnpm'))

    const config = ensureEssenceRuntimePnpmConfig({
      profileDir: targetProfile, modulesDir: targetModules, sourceModulesDir: sourceModules,
      manifestSourceDir: sourceModules,
    })
    assert.equal(config.ok, true)
    assert.equal(fs.existsSync(path.join(targetProfile, 'pnpm-workspace.yaml')), true)
    assert.match(orchestratorSource, /manifestSourceDir: path\.join\(templateDir\(\), 'node_modules'\)/)
    assert.match(orchestratorSource, /copied\.push\(name \+ ':ignored'\)/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
