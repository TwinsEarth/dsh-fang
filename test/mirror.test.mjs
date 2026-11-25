// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v2.11.0 — 母体镜像管理：备份/恢复/升级/回退/自动备份，全部在本机临时目录验证。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { MirrorManager, BACKUP_INTERVAL_HOURS, UPGRADE_STAGE } from '../src/lib/mirror.mjs'
import { tmpDir } from './helpers.mjs'

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

function makeSource(versions, options = {}) {
  let latest = versions[0]
  return {
    getLatestVersion() { return latest },
    setLatest(next) { latest = next },
    download(version, dest) {
      if (options.failDownload === true) throw new Error('download failed')
      fs.mkdirSync(dest, { recursive: true })
      writeJson(path.join(dest, 'version.json'), { version })
      fs.writeFileSync(path.join(dest, 'mirror.txt'), `mirror ${version}`, 'utf8')
    },
  }
}

function makeMirror(version = '2.10.0', options = {}) {
  const root = tmpDir('fang-mirror-')
  const mirrorRoot = path.join(root, 'mirror')
  writeJson(path.join(mirrorRoot, 'active', 'version.json'), { version })
  fs.writeFileSync(path.join(mirrorRoot, 'active', 'mirror.txt'), `mirror ${version}`, 'utf8')
  const manager = new MirrorManager({
    mirrorRoot,
    officialSource: options.officialSource ?? null,
    logger: options.logger,
    now: options.now,
  })
  return { root, mirrorRoot, manager }
}

test('mirror: 初始状态读取 active 版本并补齐布局', () => {
  const { manager, mirrorRoot } = makeMirror('2.10.0')
  const status = manager.getStatus()
  assert.equal(status.currentVersion, '2.10.0')
  assert.equal(status.updateAvailable, false)
  assert.deepEqual(status.backups, [])
  assert.equal(fs.existsSync(path.join(mirrorRoot, 'backup')), true)
  assert.equal(fs.existsSync(path.join(mirrorRoot, 'restore')), true)
})

test('mirror: 自动备份与手动备份分别落入 backup/ 与 restore/', () => {
  const { manager } = makeMirror('2.10.0')
  const auto = manager.backup({ bucket: 'backup' })
  const manual = manager.backup({ bucket: 'restore', label: '手动点' })
  assert.equal(auto.bucket, 'backup')
  assert.equal(auto.kind, 'auto')
  assert.equal(manual.bucket, 'restore')
  assert.equal(manual.kind, 'manual')
  assert.equal(manual.label, '手动点')
  assert.equal(manager.listBackups().length, 2)
  assert.equal(manager.readMeta().lastBackupAt, manual.createdAt)
})

test('mirror: 备份表头版本与内容大小自洽', () => {
  const { manager, mirrorRoot } = makeMirror('2.10.0')
  const entry = manager.backup({ bucket: 'backup' })
  const dir = path.join(mirrorRoot, 'backup', entry.id)
  assert.equal(fs.existsSync(path.join(dir, 'mirror.txt')), true)
  assert.equal(entry.sizeBytes > 0, true)
  assert.equal(entry.version, '2.10.0')
})

test('mirror: 备份间隔只接受 6/12/24，并重算 nextBackupAt', () => {
  const { manager } = makeMirror('2.10.0')
  assert.equal(manager.setBackupInterval(6).ok, true)
  assert.equal(manager.readMeta().backupIntervalHours, 6)
  assert.equal(manager.setBackupInterval(8).ok, false)
  assert.match(manager.setBackupInterval(8).reason, /invalid interval/)
  assert.deepEqual(BACKUP_INTERVAL_HOURS, [6, 12, 24])
})

test('mirror: restore 先自动备份当前 active，再替换并更新版本', () => {
  const { manager, mirrorRoot } = makeMirror('2.10.0')
  const old = manager.backup({ bucket: 'restore', label: '旧版' })
  // 模拟镜像被升级到 2.11.0 后，准备回退
  writeJson(path.join(mirrorRoot, 'active', 'version.json'), { version: '2.11.0' })
  fs.writeFileSync(path.join(mirrorRoot, 'active', 'mirror.txt'), 'mirror 2.11.0', 'utf8')
  manager.writeMeta({ ...manager.readMeta(), version: '2.11.0' })

  const result = manager.restore(old.id)
  assert.equal(result.ok, true)
  assert.equal(result.from, '2.11.0')
  assert.equal(result.to, '2.10.0')
  assert.equal(manager.readMeta().version, '2.10.0')
  // 恢复前自动备份了 2.11.0
  const backups = manager.listBackups()
  assert.ok(backups.some(entry => entry.version === '2.11.0'))
})

test('mirror: 恢复不存在的备份返回结构化错误，不抛异常', () => {
  const { manager } = makeMirror('2.10.0')
  const result = manager.restore('0000000000000-abcdef12')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'backup-not-found')
})

test('mirror: 非法 backupId 被拒绝', () => {
  const { manager } = makeMirror('2.10.0')
  assert.throws(() => manager.assertBackupId('../etc/passwd'), /invalid backup id/)
  assert.throws(() => manager.restore('../../x'), /invalid backup id/)
})

test('mirror: 删除备份目录与索引同步', () => {
  const { manager, mirrorRoot } = makeMirror('2.10.0')
  const entry = manager.backup({ bucket: 'backup' })
  assert.equal(fs.existsSync(path.join(mirrorRoot, 'backup', entry.id)), true)
  assert.deepEqual(manager.deleteBackup(entry.id), { ok: true, removed: true })
  assert.equal(fs.existsSync(path.join(mirrorRoot, 'backup', entry.id)), false)
  assert.equal(manager.listBackups().length, 0)
  assert.equal(manager.deleteBackup(entry.id).ok, false)
})

test('mirror: 未配置官方源时 checkUpdate/upgrade 明确降级', async () => {
  const { manager } = makeMirror('2.10.0')
  assert.equal(manager.checkUpdate().ok, false)
  assert.equal(manager.checkUpdate().reason, 'official-source-unavailable')
  const result = await manager.upgrade()
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'official-source-unavailable')
  assert.equal(result.rolledBack, false)
})

test('mirror: 已是最新时 upgrade 为成功 no-op', async () => {
  const source = makeSource(['2.10.0'])
  const { manager } = makeMirror('2.10.0', { officialSource: source })
  assert.equal(manager.checkUpdate().available, false)
  const result = await manager.upgrade()
  assert.equal(result.ok, true)
  assert.equal(result.reason, 'already-latest')
  assert.equal(result.backupId, null)
})

test('mirror: 升级成功 → 备份、替换 active、写 version.json', async () => {
  const source = makeSource(['2.11.0'])
  const { manager, mirrorRoot } = makeMirror('2.10.0', { officialSource: source })
  assert.equal(manager.checkUpdate().available, true)
  const stages = []
  const result = await manager.upgrade({ onProgress: stage => stages.push(stage) })
  assert.equal(result.ok, true)
  assert.equal(result.from, '2.10.0')
  assert.equal(result.to, '2.11.0')
  assert.equal(typeof result.backupId, 'string')
  assert.equal(manager.readMeta().version, '2.11.0')
  const versionFile = JSON.parse(fs.readFileSync(path.join(mirrorRoot, 'active', 'version.json'), 'utf8'))
  assert.equal(versionFile.version, '2.11.0')
  assert.equal(manager.listBackups().some(entry => entry.version === '2.10.0'), true)
  assert.deepEqual(stages, [
    UPGRADE_STAGE.CHECKING, UPGRADE_STAGE.BACKING_UP, UPGRADE_STAGE.DOWNLOADING,
    UPGRADE_STAGE.SWAPPING, UPGRADE_STAGE.FINALIZING, UPGRADE_STAGE.DONE,
  ])
})

test('mirror: 下载失败 → 自动回滚且版本不变', async () => {
  const source = makeSource(['2.11.0'], { failDownload: true })
  const { manager } = makeMirror('2.10.0', { officialSource: source })
  const result = await manager.upgrade({ onProgress: () => {} })
  assert.equal(result.ok, false)
  assert.equal(result.rolledBack, true)
  assert.equal(manager.readMeta().version, '2.10.0')
  assert.equal(manager.listBackups().length, 1) // 升级前备份仍在
})

test('mirror: autoBackup=false 时升级失败不产生备份', async () => {
  const source = makeSource(['2.11.0'], { failDownload: true })
  const { manager } = makeMirror('2.10.0', { officialSource: source })
  const result = await manager.upgrade({ autoBackup: false, autoRollback: false })
  assert.equal(result.ok, false)
  assert.equal(result.backupId, null)
  assert.equal(manager.listBackups().length, 0)
})

test('mirror: 官方源抛错时 upgrade 返回结构化失败', async () => {
  const broken = { getLatestVersion() { throw new Error('registry down') }, download() {} }
  const { manager } = makeMirror('2.10.0', { officialSource: broken })
  const result = await manager.upgrade()
  assert.equal(result.ok, false)
  assert.match(result.reason, /fetch-latest-failed/)
})

test('mirror: maybeAutoBackup 到期前不备份、到期后备份', () => {
  let clock = 1_000_000
  const { manager } = makeMirror('2.10.0', { now: () => clock })
  manager.ensureLayout()
  manager.setBackupInterval(24)
  const meta = manager.readMeta()
  assert.equal(manager.maybeAutoBackup(meta.nextBackupAt - 1).backedUp, false)
  clock = meta.nextBackupAt + 1
  const due = manager.maybeAutoBackup(clock)
  assert.equal(due.backedUp, true)
  assert.equal(manager.listBackups().length, 1)
  // 备份后 nextBackupAt 被推后（时钟已前进）
  assert.equal(manager.readMeta().nextBackupAt > meta.nextBackupAt, true)
})

test('mirror: getStatus 带磁盘占用与资源计数（usageProvider）', () => {
  const root = tmpDir('fang-mirror-usage-')
  const mirrorRoot = path.join(root, 'mirror')
  writeJson(path.join(mirrorRoot, 'active', 'version.json'), { version: '2.10.0' })
  const manager = new MirrorManager({
    mirrorRoot,
    usageProvider: () => ({ activeEssenceCount: 3, activeSessionCount: 7 }),
  })
  const status = manager.getStatus()
  assert.equal(status.activeEssenceCount, 3)
  assert.equal(status.activeSessionCount, 7)
  assert.equal(status.diskUsageBytes > 0, true)
})

// ── R13：getStatus 不得把 async 官方源 String(Promise) 成 "[object Promise]" ─────────
// 旧实现同步调用 async getLatestVersion() → officialLatest="[object Promise]"、
// updateAvailable 恒 true、rejection 未处理可崩进程。修复后 getStatus 只读缓存，
// 刷新由 async refreshOfficialLatest() 完成（await + string 校验 + catch 一切异常）。

function makeAsyncSource(getLatestVersion) {
  return { getLatestVersion, download() {} }
}

test('mirror R13: getStatus 不触发官方源请求，缓存前 officialLatest 为 null', () => {
  let calls = 0
  const source = makeAsyncSource(async () => { calls += 1; return '9.9.9' })
  const { manager } = makeMirror('2.10.0', { officialSource: source })
  const status = manager.getStatus()
  assert.equal(calls, 0, '同步 getStatus 不得调用官方源')
  assert.equal(status.officialLatest, null)
  assert.equal(status.updateAvailable, false)
  assert.deepEqual(status.officialSource, { latest: null, checkedAt: null, error: null })
  assert.equal(JSON.stringify(status).includes('[object Promise]'), false)
})

test('mirror R13: refreshOfficialLatest 缓存 async 官方最新版，状态不再出现 Promise', async () => {
  let calls = 0
  const source = makeAsyncSource(async () => { calls += 1; return '9.9.9' })
  const { manager } = makeMirror('2.10.0', { officialSource: source })
  const refreshed = await manager.refreshOfficialLatest()
  assert.equal(calls, 1)
  assert.equal(refreshed.latest, '9.9.9')
  assert.equal(refreshed.error, null)
  assert.equal(refreshed.refreshed, true)

  const status = manager.getStatus()
  assert.equal(status.officialLatest, '9.9.9')
  assert.equal(status.updateAvailable, true)
  assert.equal(status.officialSource.latest, '9.9.9')
  assert.equal(status.officialSource.error, null)
  assert.equal(typeof status.officialSource.checkedAt, 'number')
  assert.equal(typeof status.officialLatest, 'string')
  assert.equal(String(status.officialLatest).includes('Promise'), false)
  assert.equal(status.officialLatest instanceof Promise, false)
  assert.equal(JSON.stringify(status).includes('[object Promise]'), false)
})

test('mirror R13: 官方源 async reject 时 refreshOfficialLatest 不抛并记录 error', async () => {
  const source = makeAsyncSource(async () => { throw new Error('network down') })
  const { manager } = makeMirror('2.10.0', { officialSource: source })
  const refreshed = await manager.refreshOfficialLatest()
  assert.equal(refreshed.latest, null)
  assert.match(refreshed.error, /network down/)

  assert.doesNotThrow(() => manager.getStatus())
  const status = manager.getStatus()
  assert.match(status.officialSource.error, /network down/)
  assert.equal(status.officialLatest, null)
  assert.equal(status.updateAvailable, false)
  assert.equal(status.officialLatest instanceof Promise, false)
  assert.equal(JSON.stringify(status).includes('[object Promise]'), false)
})

test('mirror R13: refreshOfficialLatest 在 maxAge 内复用缓存、maxAgeMs=0 强制刷新', async () => {
  let calls = 0
  const source = makeAsyncSource(async () => { calls += 1; return calls === 1 ? '9.9.9' : '10.0.0' })
  const { manager } = makeMirror('2.10.0', { officialSource: source })
  await manager.refreshOfficialLatest()
  const cached = await manager.refreshOfficialLatest()
  assert.equal(calls, 1, 'maxAge 内不得重复请求官方源')
  assert.equal(cached.refreshed, false)
  assert.equal(cached.latest, '9.9.9')

  const forced = await manager.refreshOfficialLatest({ maxAgeMs: 0 })
  assert.equal(calls, 2, 'maxAgeMs=0 必须强制请求')
  assert.equal(forced.refreshed, true)
  assert.equal(forced.latest, '10.0.0')
  assert.equal(manager.getStatus().officialLatest, '10.0.0')
})

test('mirror R13: 官方源返回非字符串时只记录 error，不把对象当版本', async () => {
  const source = makeAsyncSource(async () => ({ version: '9.9.9' }))
  const { manager } = makeMirror('2.10.0', { officialSource: source })
  const refreshed = await manager.refreshOfficialLatest()
  assert.match(refreshed.error, /expected non-empty string/)
  const status = manager.getStatus()
  assert.equal(status.officialLatest, null)
  assert.match(status.officialSource.error, /expected non-empty string/)
  assert.equal(JSON.stringify(status).includes('[object Promise]'), false)
})

test('mirror R13: 官方源同步抛错也被捕获，失败时保留上次成功版本', async () => {
  let mode = 'ok'
  const source = makeAsyncSource(() => {
    if (mode === 'fail') throw new Error('boom sync')
    return '9.9.9'
  })
  const { manager } = makeMirror('2.10.0', { officialSource: source })
  await manager.refreshOfficialLatest()
  assert.equal(manager.getStatus().officialLatest, '9.9.9')

  mode = 'fail'
  const failed = await manager.refreshOfficialLatest({ maxAgeMs: 0 })
  assert.match(failed.error, /boom sync/)
  const status = manager.getStatus()
  assert.equal(status.officialLatest, '9.9.9', '失败时保留上次成功版本')
  assert.equal(status.updateAvailable, true)
  assert.match(status.officialSource.error, /boom sync/)
})
