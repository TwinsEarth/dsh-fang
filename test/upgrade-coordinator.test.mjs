// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.9 — 升级后重算协调：recomputeAll 并发/超时/失败隔离 + coordinator 去重 + postUpgradeHook。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { Semaphore } from '../src/lib/semaphore.mjs'
import { EssenceManager } from '../src/lib/essence.mjs'
import { MirrorManager } from '../src/lib/mirror.mjs'
import { MirrorUpgradeCoordinator } from '../src/lib/upgrade-coordinator.mjs'
import { tmpDir } from './helpers.mjs'

function makeEssenceFixture() {
  const root = tmpDir('fang-coord-')
  const mirrorRoot = path.join(root, 'mirror')
  const profileDir = path.join(mirrorRoot, 'active', 'profile')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- insert: []\n', 'utf8')
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'mirror', dependencies: {} }), 'utf8')
  fs.writeFileSync(path.join(mirrorRoot, 'meta.json'), JSON.stringify({ version: '3.0.9' }), 'utf8')
  const essencesRoot = path.join(root, 'essences')
  fs.mkdirSync(essencesRoot, { recursive: true })
  const manager = new EssenceManager({ essencesRoot, mirrorRoot })
  return { root, mirrorRoot, profileDir, essencesRoot, manager }
}

test('semaphore: 并发上限与排队唤醒', async () => {
  const semaphore = new Semaphore(2)
  await semaphore.acquire()
  await semaphore.acquire()
  assert.deepEqual(semaphore.stats(), { available: 0, waiting: 0 })
  let acquired = false
  const pending = semaphore.acquire().then(() => { acquired = true })
  assert.equal(acquired, false)
  semaphore.release()
  await pending
  assert.equal(acquired, true)
  semaphore.release()
  semaphore.release()
  assert.deepEqual(semaphore.stats(), { available: 2, waiting: 0 })
})

test('recomputeAll: 指纹未变 → skipped；镜像变化 → recomputed', async () => {
  const { manager, profileDir } = makeEssenceFixture()
  const first = manager.create({ name: 'A' })
  const second = manager.create({ name: 'B' })

  let result = await manager.recomputeAll()
  assert.deepEqual(new Set(result.skipped), new Set([first.id, second.id]))
  assert.deepEqual(result.recomputed, [])

  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'mirror', dependencies: { added: '^1.0.0' },
  }), 'utf8')
  result = await manager.recomputeAll()
  assert.deepEqual(new Set(result.recomputed), new Set([first.id, second.id]))
  assert.equal(result.failed.length, 0)
  assert.equal(result.aborted, false)
})

test('recomputeAll: 单个原身抛错 → failed，其余继续', async () => {
  const { manager } = makeEssenceFixture()
  const broken = manager.create({ name: 'broken' })
  manager.create({ name: 'ok' })
  const originalEnsureFresh = manager.ensureFresh.bind(manager)
  manager.ensureFresh = (id) => (id === broken.id
    ? Promise.reject(new Error('boom'))
    : originalEnsureFresh(id))

  const result = await manager.recomputeAll({ concurrency: 1 })
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0].id, broken.id)
  assert.equal(result.failed[0].error, 'boom')
  assert.equal(result.skipped.length + result.recomputed.length, 1)
})

test('recomputeAll: signal 已 abort → aborted 且不处理', async () => {
  const { manager } = makeEssenceFixture()
  manager.create({ name: 'A' })
  const controller = new AbortController()
  controller.abort()
  const result = await manager.recomputeAll({ signal: controller.signal })
  assert.equal(result.aborted, true)
  assert.deepEqual(result.recomputed, [])
  assert.deepEqual(result.failed, [])
})

test('coordinator: 触发 recomputeAll 并记录进度/结果', async () => {
  const essence = {
    async recomputeAll(options) {
      options.onProgress?.({ done: 1, total: 2, currentId: 'e1', recomputed: 1, skipped: 0, conflicted: 0, failed: 0 })
      return { recomputed: ['e1'], skipped: [], conflicted: [], failed: [], aborted: false, durationMs: 5 }
    },
  }
  const coordinator = new MirrorUpgradeCoordinator({ essence })
  assert.equal(coordinator.getRecomputeStatus().running, false)
  await coordinator.onUpgradeSuccess()
  const status = coordinator.getRecomputeStatus()
  assert.equal(status.running, false)
  assert.equal(status.startedAt !== null, true)
  assert.equal(status.lastResult.recomputed[0], 'e1')
  assert.equal(status.lastError, null)
})

test('coordinator: 并发触发合并为一次批次', async () => {
  let calls = 0
  let release
  const essence = {
    recomputeAll() {
      calls += 1
      return new Promise((resolve) => { release = () => resolve({ recomputed: [], skipped: [], conflicted: [], failed: [], aborted: false, durationMs: 1 }) })
    },
  }
  const coordinator = new MirrorUpgradeCoordinator({ essence })
  const first = coordinator.onUpgradeSuccess()
  const second = coordinator.onUpgradeSuccess()
  release()
  await Promise.all([first, second])
  assert.equal(calls, 1)
  await coordinator.waitForRecompute()
})

test('coordinator: recomputeAll 抛错 → lastError，running=false', async () => {
  const essence = { async recomputeAll() { throw new Error('disk full') } }
  const coordinator = new MirrorUpgradeCoordinator({ essence })
  await coordinator.onUpgradeSuccess()
  const status = coordinator.getRecomputeStatus()
  assert.equal(status.running, false)
  assert.equal(status.lastError, 'disk full')
})

test('mirror postUpgradeHook: 升级成功触发、失败/回滚不触发、钩子异常不影响升级', async () => {
  const root = tmpDir('fang-hook-')
  const mirrorRoot = path.join(root, 'mirror')
  fs.mkdirSync(path.join(mirrorRoot, 'active'), { recursive: true })
  fs.writeFileSync(path.join(mirrorRoot, 'active', 'version.json'), JSON.stringify({ version: '3.0.8' }), 'utf8')

  const makeSource = (downloadThrows = false) => ({
    getLatestVersion() { return '3.0.9' },
    download(version, dest) {
      if (downloadThrows) throw new Error('download failed')
      fs.mkdirSync(dest, { recursive: true })
      fs.writeFileSync(path.join(dest, 'version.json'), JSON.stringify({ version }), 'utf8')
    },
  })

  const hooks = []
  const ok = new MirrorManager({
    mirrorRoot,
    officialSource: makeSource(),
    postUpgradeHook: (input) => { hooks.push(input) },
  })
  const result = await ok.upgrade()
  assert.equal(result.ok, true)
  assert.equal(result.postUpgradeTriggered, true)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(hooks.length, 1)
  assert.equal(hooks[0].to, '3.0.9')

  const failingRoot = tmpDir('fang-hook-fail-')
  const failingMirrorRoot = path.join(failingRoot, 'mirror')
  fs.mkdirSync(path.join(failingMirrorRoot, 'active'), { recursive: true })
  fs.writeFileSync(path.join(failingMirrorRoot, 'active', 'version.json'), JSON.stringify({ version: '3.0.8' }), 'utf8')
  const failing = new MirrorManager({
    mirrorRoot: failingMirrorRoot,
    officialSource: makeSource(true),
    postUpgradeHook: () => { throw new Error('hook broken') },
    logger: { warn() {} },
  })
  const failedResult = await failing.upgrade()
  assert.equal(failedResult.ok, false)
  assert.equal(failedResult.postUpgradeTriggered, undefined)
})
