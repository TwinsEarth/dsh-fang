// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang v2.11.0 — 母体镜像管理（零依赖）。
//
// 目录（文件夹 1）：
//   <mirrorRoot>/
//     active/                正在运行的镜像内容（唯一可被升级/回退替换的层）
//     backup/<id>/           自动备份（按 backupIntervalHours 滚动）
//     restore/<id>/          手动恢复点
//     backups.json           备份索引（id/label/createdAt/sizeBytes/version/kind/bucket）
//     meta.json              version/installedAt/backupIntervalHours/lastBackupAt/nextBackupAt
//     mirror-locked.json     锁定插件清单（由 EssenceManager 读取；可选）
//
// 语义：
//   * 备份 = 复制 active/ 到 backup|restore/<id>/，索引与 meta 同步；
//   * 恢复 = 先自动备份当前 active/，再用快照替换 active/，最后更新 meta.version；
//   * 升级 = 官方源取最新版 → 自动备份 → 下载到 staging → 原子替换 → 失败自动回退；
//     未配置官方源时 upgrade 显式返回 official-source-unavailable（绝不假装成功）。

import fs from 'node:fs'
import path from 'node:path'

import {
  ensureDir,
  exists,
  readJson,
  writeJsonAtomic,
  sha256,
  copyTree,
  removeTree,
  listFiles,
} from '../kernel/index.mjs'

export const MIRROR_VERSION = '1.0.0'

export const BACKUP_INTERVAL_HOURS = Object.freeze([6, 12, 24])
export const DEFAULT_BACKUP_INTERVAL_HOURS = 24
export const BACKUP_BUCKET = Object.freeze({ AUTO: 'backup', MANUAL: 'restore' })
export const UPGRADE_STAGE = Object.freeze({
  CHECKING: 'checking', BACKING_UP: 'backing-up', DOWNLOADING: 'downloading',
  SWAPPING: 'swapping', FINALIZING: 'finalizing', DONE: 'done', FAILED: 'failed',
})

const HOUR_MS = 3_600_000
const BACKUP_ID_RE = /^\d{10,16}-[a-z0-9]{4,12}$/

/** @param {unknown} value */
function normalizeIntervalHours(value) {
  const hours = Number(value)
  return BACKUP_INTERVAL_HOURS.includes(hours) ? hours : DEFAULT_BACKUP_INTERVAL_HOURS
}

/** @param {number} bytes */
function directorySize(bytes) {
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0
}

/**
 * 计算目录大小（递归）。
 * @param {string} dir
 * @returns {number}
 */
function dirSize(dir) {
  if (!exists(dir)) return 0
  let total = 0
  for (const relative of listFiles(dir, { max: 200000 })) {
    try { total += fs.statSync(path.join(dir, relative)).size } catch { /* 文件在遍历中被删：忽略 */ }
  }
  return total
}

/**
 * 递归复制目录（不跟随符号链接；目标必须不存在或为空）。
 * @param {string} from @param {string} to
 */
function copyDir(from, to) {
  if (!exists(from)) throw new Error(`mirror: source not found: ${from}`)
  ensureDir(to)
  copyTree(from, to)
}

export class MirrorManager {
  /**
   * @param {{mirrorRoot: string, officialSource?: {getLatestVersion:Function, download:Function}|null,
   *   logger?: {info?:Function, warn?:Function}, now?: () => number,
   *   usageProvider?: () => {activeEssenceCount?: number, activeSessionCount?: number}}} options
   */
  constructor(options) {
    this.mirrorRoot = String(options.mirrorRoot ?? '')
    if (this.mirrorRoot.length === 0) throw new Error('MirrorManager: mirrorRoot required')
    this.officialSource = options.officialSource ?? null
    this.logger = options.logger ?? {}
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.usageProvider = typeof options.usageProvider === 'function' ? options.usageProvider : null
    // v3.0.9：升级成功后的副作用钩子（由协调器注入；异步触发，不阻塞 upgrade 返回）
    this.postUpgradeHook = typeof options.postUpgradeHook === 'function' ? options.postUpgradeHook : null
    // v3.0.3：客户端升级后的兼容性门禁；失败时保持子插件关闭（默认策略）
    this.compatGate = typeof options.compatGate === 'function' ? options.compatGate : null
    this.onCompatResult = typeof options.onCompatResult === 'function' ? options.onCompatResult : null
  }

  activeDir() { return path.join(this.mirrorRoot, 'active') }
  backupDir() { return path.join(this.mirrorRoot, 'backup') }
  restoreDir() { return path.join(this.mirrorRoot, 'restore') }
  metaPath() { return path.join(this.mirrorRoot, 'meta.json') }
  indexPath() { return path.join(this.mirrorRoot, 'backups.json') }

  /** 初始化目录与 meta（幂等；不覆盖已有 meta）。 */
  ensureLayout() {
    ensureDir(this.activeDir())
    ensureDir(this.backupDir())
    ensureDir(this.restoreDir())
    if (!exists(this.metaPath())) {
      this.writeMeta({
        version: this.detectActiveVersion(),
        installedAt: this.now(),
        backupIntervalHours: DEFAULT_BACKUP_INTERVAL_HOURS,
        lastBackupAt: null,
        nextBackupAt: null,
      })
    }
    if (!exists(this.indexPath())) writeJsonAtomic(this.indexPath(), [])
    return this.getStatus()
  }

  /** @returns {{version:string, installedAt:number, backupIntervalHours:number, lastBackupAt:number|null, nextBackupAt:number|null}} */
  readMeta() {
    const raw = readJson(this.metaPath(), {})
    return {
      version: String(raw.version ?? 'unknown'),
      installedAt: Number(raw.installedAt) || 0,
      backupIntervalHours: normalizeIntervalHours(raw.backupIntervalHours),
      lastBackupAt: raw.lastBackupAt === null || raw.lastBackupAt === undefined ? null : Number(raw.lastBackupAt),
      nextBackupAt: raw.nextBackupAt === null || raw.nextBackupAt === undefined ? null : Number(raw.nextBackupAt),
    }
  }

  /** @param {ReturnType<MirrorManager['readMeta']>} meta */
  writeMeta(meta) {
    ensureDir(this.mirrorRoot)
    writeJsonAtomic(this.metaPath(), meta)
  }

  /** @returns {Array<{id:string,label:string|null,createdAt:number,sizeBytes:number,version:string,kind:string,bucket:string}>} */
  listBackups() {
    const list = readJson(this.indexPath(), [])
    if (!Array.isArray(list)) return []
    return list
      .filter(entry => entry !== null && typeof entry === 'object')
      .map(entry => ({
        id: String(entry.id ?? ''),
        label: entry.label === undefined ? null : entry.label,
        createdAt: Number(entry.createdAt) || 0,
        sizeBytes: directorySize(Number(entry.sizeBytes) || 0),
        version: String(entry.version ?? 'unknown'),
        kind: entry.kind === 'manual' ? 'manual' : 'auto',
        bucket: entry.bucket === BACKUP_BUCKET.MANUAL ? BACKUP_BUCKET.MANUAL : BACKUP_BUCKET.AUTO,
      }))
      .filter(entry => entry.id.length > 0)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** 当前镜像版本（无法判断时 unknown）。 */
  detectActiveVersion() {
    const version = readJson(path.join(this.activeDir(), 'version.json'), null)
    if (version !== null && typeof version === 'object' && typeof version.version === 'string') return version.version
    try { return String(readJson(this.metaPath(), {}).version ?? 'unknown') } catch { return 'unknown' }
  }

  /**
   * 完整状态（供 UI / 路由）。
   * @returns {Record<string, unknown>}
   */
  getStatus() {
    this.ensureLayoutWithoutRecursion()
    const meta = this.readMeta()
    let latest = null
    if (this.officialSource !== null && typeof this.officialSource.getLatestVersion === 'function') {
      try { latest = String(this.officialSource.getLatestVersion() ?? null) } catch { latest = null }
    }
    const usage = this.usageProvider === null ? {} : (this.usageProvider() ?? {})
    return {
      ok: true,
      meta,
      currentVersion: meta.version,
      officialLatest: latest,
      updateAvailable: latest !== null && latest !== meta.version,
      backups: this.listBackups(),
      activeEssenceCount: Number(usage.activeEssenceCount ?? 0) || 0,
      activeSessionCount: Number(usage.activeSessionCount ?? 0) || 0,
      diskUsageBytes: dirSize(this.mirrorRoot),
    }
  }

  /** getStatus 内部调用；只补齐目录，避免递归。 */
  ensureLayoutWithoutRecursion() {
    ensureDir(this.backupDir())
    ensureDir(this.restoreDir())
    if (!exists(this.indexPath())) writeJsonAtomic(this.indexPath(), [])
    if (!exists(this.metaPath())) {
      this.writeMeta({
        version: this.detectActiveVersion(), installedAt: this.now(),
        backupIntervalHours: DEFAULT_BACKUP_INTERVAL_HOURS, lastBackupAt: null, nextBackupAt: null,
      })
    }
  }

  /**
   * 备份当前 active 到 backup|restore/<id>/。
   * @param {{label?: string, bucket?: 'backup'|'restore'}} [options]
   * @returns {Record<string, unknown>} 备份条目
   */
  backup(options = {}) {
    this.ensureLayout()
    const bucket = options.bucket === BACKUP_BUCKET.MANUAL || options.bucket === 'restore'
      ? BACKUP_BUCKET.MANUAL
      : BACKUP_BUCKET.AUTO
    const meta = this.readMeta()
    const createdAt = this.now()
    const id = `${String(createdAt).padStart(13, '0')}-${sha256(`${createdAt}:${this.mirrorRoot}:${Math.random()}`).slice(0, 8)}`
    const target = path.join(bucket === BACKUP_BUCKET.MANUAL ? this.restoreDir() : this.backupDir(), id)
    if (exists(target)) throw new Error(`mirror: backup id collision: ${id}`)
    copyDir(this.activeDir(), target)
    const entry = {
      id,
      label: typeof options.label === 'string' && options.label.trim().length > 0 ? options.label.trim() : null,
      createdAt,
      sizeBytes: dirSize(target),
      version: meta.version,
      kind: bucket === BACKUP_BUCKET.MANUAL ? 'manual' : 'auto',
      bucket,
    }
    const index = this.listBackups()
    index.unshift(entry)
    writeJsonAtomic(this.indexPath(), index)
    this.writeMeta({
      ...meta,
      lastBackupAt: createdAt,
      nextBackupAt: createdAt + meta.backupIntervalHours * HOUR_MS,
    })
    this.logger?.info?.(`[mirror] backup ${bucket} ${id} (${entry.sizeBytes} bytes)`)
    return entry
  }

  /**
   * 恢复某个备份：默认先自动备份当前 active，再替换，更新 meta.version。
   * @param {string} backupId
   * @returns {{ok:boolean, from?:string, to?:string, preBackupId?:string, reason?:string}}
   */
  restore(backupId) {
    return this.restoreSnapshot(backupId, { preBackup: true })
  }

  /**
   * 恢复实现；升级失败时的内部回滚不再额外备份（升级前备份已存在）。
   * @param {string} backupId
   * @param {{preBackup?: boolean}} [options]
   * @returns {{ok:boolean, from?:string, to?:string, preBackupId?:string, reason?:string}}
   */
  restoreSnapshot(backupId, options = {}) {
    const preBackup = options.preBackup !== false
    this.ensureLayout()
    const id = this.assertBackupId(backupId)
    const entry = this.listBackups().find(item => item.id === id)
    if (entry === undefined) return { ok: false, reason: 'backup-not-found' }
    const source = path.join(entry.bucket === BACKUP_BUCKET.MANUAL ? this.restoreDir() : this.backupDir(), id)
    if (!exists(source)) return { ok: false, reason: 'backup-content-missing', backupId: id }
    const meta = this.readMeta()
    const pre = preBackup ? this.backup({ label: `pre-restore-${id}`, bucket: BACKUP_BUCKET.AUTO }) : null
    try {
      this.swapActive(source)
      this.writeMeta({ ...meta, version: entry.version, installedAt: this.now(), lastBackupAt: this.now() })
      this.logger?.info?.(`[mirror] restored ${id} (${meta.version} → ${entry.version})`)
      return {
        ok: true, from: meta.version, to: entry.version,
        ...(pre === null ? {} : { preBackupId: pre.id }),
      }
    } catch (error) {
      return {
        ok: false, reason: String(error instanceof Error ? error.message : error),
        backupId: id, ...(pre === null ? {} : { preBackupId: pre.id }),
      }
    }
  }

  /** @param {string} backupId @returns {{ok:boolean, removed?:boolean, reason?:string}} */
  deleteBackup(backupId) {
    const id = this.assertBackupId(backupId)
    const entry = this.listBackups().find(item => item.id === id)
    if (entry === undefined) return { ok: false, reason: 'backup-not-found' }
    removeTree(path.join(entry.bucket === BACKUP_BUCKET.MANUAL ? this.restoreDir() : this.backupDir(), id))
    writeJsonAtomic(this.indexPath(), this.listBackups().filter(item => item.id !== id))
    return { ok: true, removed: true }
  }

  /** @param {number} hours 6 | 12 | 24 */
  setBackupInterval(hours) {
    const next = Number(hours)
    if (!BACKUP_INTERVAL_HOURS.includes(next)) {
      return { ok: false, reason: `invalid interval: ${hours} (allowed: ${BACKUP_INTERVAL_HOURS.join(',')})` }
    }
    this.ensureLayout()
    const meta = this.readMeta()
    const last = meta.lastBackupAt ?? this.now()
    this.writeMeta({ ...meta, backupIntervalHours: next, nextBackupAt: last + next * HOUR_MS })
    return { ok: true, backupIntervalHours: next }
  }

  /** 到期自动备份（由 orchestrator 的定时器调用；now 可注入便于测试）。 */
  maybeAutoBackup(now = this.now()) {
    this.ensureLayoutWithoutRecursion()
    const meta = this.readMeta()
    if (meta.nextBackupAt === null) {
      const last = meta.lastBackupAt ?? now
      this.writeMeta({ ...meta, nextBackupAt: last + meta.backupIntervalHours * HOUR_MS })
      return { ok: true, backedUp: false, reason: 'scheduled-first' }
    }
    if (now < meta.nextBackupAt) return { ok: true, backedUp: false, reason: 'not-due' }
    try {
      const entry = this.backup({ bucket: BACKUP_BUCKET.AUTO })
      return { ok: true, backedUp: true, entry }
    } catch (error) {
      this.logger?.warn?.(`[mirror] auto backup failed: ${error instanceof Error ? error.message : error}`)
      return { ok: false, backedUp: false, reason: String(error instanceof Error ? error.message : error) }
    }
  }

  /** 检查更新（仅查询官方源，不下发下载）。 */
  checkUpdate() {
    this.ensureLayoutWithoutRecursion()
    const current = this.readMeta().version
    if (this.officialSource === null) return { ok: false, current, latest: null, available: false, reason: 'official-source-unavailable' }
    const settle = (latest) => ({ ok: true, current, latest: String(latest ?? null), available: latest !== null && latest !== current })
    try {
      const latest = this.officialSource.getLatestVersion()
      if (latest && typeof latest.then === 'function') {
        return latest.then(settle).catch((error) => ({
          ok: false, current, latest: null, available: false,
          reason: String(error instanceof Error ? error.message : error),
        }))
      }
      return settle(latest)
    } catch (error) {
      return { ok: false, current, latest: null, available: false, reason: String(error instanceof Error ? error.message : error) }
    }
  }

  /**
   * 升级：备份 → 下载 staging → 原子替换 → 写 meta；失败自动回退。
   * @param {{autoBackup?: boolean, autoRollback?: boolean, onProgress?: (stage: string) => void}} [options]
   * @returns {Promise<Record<string, unknown>>}
   */
  async upgrade(options = {}) {
    const autoBackup = options.autoBackup !== false
    const autoRollback = options.autoRollback !== false
    const progress = typeof options.onProgress === 'function' ? options.onProgress : null
    const stage = (name) => { try { progress?.(name) } catch { /* 观察者异常不影响升级 */ } }

    this.ensureLayout()
    const from = this.readMeta().version
    if (this.officialSource === null || typeof this.officialSource.download !== 'function') {
      return { ok: false, from, to: from, backupId: null, rolledBack: false, reason: 'official-source-unavailable' }
    }
    stage(UPGRADE_STAGE.CHECKING)
    let latest
    try { latest = String((await Promise.resolve(this.officialSource.getLatestVersion())) ?? '') } catch (error) {
      return { ok: false, from, to: from, backupId: null, rolledBack: false, reason: `fetch-latest-failed: ${error instanceof Error ? error.message : error}` }
    }
    if (latest.length === 0) return { ok: false, from, to: from, backupId: null, rolledBack: false, reason: 'latest-version-unknown' }
    if (latest === from) return { ok: true, from, to: from, backupId: null, rolledBack: false, reason: 'already-latest' }

    let backupId = null
    if (autoBackup) {
      stage(UPGRADE_STAGE.BACKING_UP)
      backupId = this.backup({ label: `pre-upgrade-${latest}`, bucket: BACKUP_BUCKET.AUTO }).id
    }

    const staging = path.join(this.mirrorRoot, `.staging-${this.now()}-${sha256(`${latest}:${Math.random()}`).slice(0, 6)}`)
    try {
      stage(UPGRADE_STAGE.DOWNLOADING)
      await Promise.resolve(this.officialSource.download(latest, staging))
      stage(UPGRADE_STAGE.SWAPPING)
      this.swapActive(staging)
      stage(UPGRADE_STAGE.FINALIZING)
      this.writeMeta({
        ...this.readMeta(), version: latest, installedAt: this.now(),
        lastBackupAt: backupId === null ? this.readMeta().lastBackupAt : this.now(),
      })
      writeJsonAtomic(path.join(this.activeDir(), 'version.json'), { version: latest })
      // v3.0.3：客户端升级后先跑 compat 门禁；未通过则保持子插件关闭并跳过重算
      let compat = null
      if (this.compatGate !== null) {
        try {
          compat = await this.compatGate({ from, to: latest, backupId })
        } catch (error) {
          compat = {
            ok: false,
            checkedAt: Date.now(),
            findings: [{ code: 'compat-gate-threw', severity: 'error', message: String(error instanceof Error ? error.message : error) }],
          }
        }
        try { this.onCompatResult?.(compat, { from, to: latest }) } catch { /* 观察者异常隔离 */ }
        if (compat === null || compat.ok !== true) {
          stage(UPGRADE_STAGE.FAILED)
          this.logger?.warn?.('[mirror] compat gate failed; sub-plugins stay disabled', {
            findings: Array.isArray(compat?.findings) ? compat.findings.length : 0,
          })
          return {
            ok: true, from, to: latest, backupId, rolledBack: false,
            reason: 'compat-gate-failed', compat, postUpgradeTriggered: false,
          }
        }
      }
      stage(UPGRADE_STAGE.DONE)
      this.logger?.info?.(`[mirror] upgraded ${from} → ${latest}`)
      const result = { ok: true, from, to: latest, backupId, rolledBack: false }
      if (compat !== null) result.compat = compat
      if (this.postUpgradeHook !== null) {
        result.postUpgradeTriggered = true
        void this.runPostUpgrade({ from, to: latest, backupId })
      }
      return result
    } catch (error) {
      const reason = String(error instanceof Error ? error.message : error)
      this.logger?.warn?.(`[mirror] upgrade failed: ${reason}`)
      if (autoRollback && backupId !== null) {
        const rollback = this.restoreSnapshot(backupId, { preBackup: false })
        stage(UPGRADE_STAGE.FAILED)
        return {
          ok: false, from, to: from, backupId, rolledBack: rollback.ok === true,
          reason: rollback.ok === true ? reason : `${reason}; rollback failed: ${rollback.reason}`,
        }
      }
      stage(UPGRADE_STAGE.FAILED)
      return { ok: false, from, to: from, backupId, rolledBack: false, reason }
    } finally {
      if (exists(staging)) removeTree(staging)
    }
  }

  /**
   * 触发升级后副作用（fire-and-forget）：钩子失败只记 warn，不影响升级结果。
   * @param {{from: string, to: string, backupId: string|null}} input
   */
  async runPostUpgrade(input) {
    try {
      this.logger?.info?.('[mirror] triggering post-upgrade hook', input)
      await this.postUpgradeHook(input)
      this.logger?.info?.('[mirror] post-upgrade hook completed', input)
    } catch (error) {
      this.logger?.warn?.('[mirror] post-upgrade hook failed', {
        error: String(error instanceof Error ? error.message : error), ...input,
      })
    }
  }

  /** @param {unknown} value @returns {string} */
  assertBackupId(value) {
    const id = String(value ?? '')
    if (!BACKUP_ID_RE.test(id)) throw new Error(`invalid backup id: ${id}`)
    return id
  }

  /** 用 source 目录原子替换 active/（先拷到临时目录，再删旧、改名）。 */
  swapActive(source) {
    const stagingCopy = path.join(this.mirrorRoot, `.swap-${this.now()}-${sha256(`${source}:${Math.random()}`).slice(0, 6)}`)
    try {
      ensureDir(stagingCopy)
      copyTree(source, stagingCopy)
      if (exists(this.activeDir())) removeTree(this.activeDir())
      fs.renameSync(stagingCopy, this.activeDir())
    } finally {
      if (exists(stagingCopy)) removeTree(stagingCopy)
    }
  }
}

export const _internals = Object.freeze({ dirSize, copyDir, normalizeIntervalHours, BACKUP_ID_RE })
