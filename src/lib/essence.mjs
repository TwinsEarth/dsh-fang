// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang v2.10.0 — Essence 覆盖层合并库。
//
// 术语：
//   镜像（mirror）   = 只读基础 profile（DSH 版本 + 基础插件集），唯一可升级/回退的层；
//   原身（essence）  = 镜像之上的可写覆盖层：装插件、改设置、登录账户、建会话；
//   分身（derived）  = 从原身派生的临时实例（不落盘配置，只持久化会话数据）。
//
// 本模块只做原身覆盖层：overlay（原身意图） × mirror base（镜像基础） → merged（物化 profile）。
// 不接 HTTP、不接 UI；由 orchestrator 的 essence 服务与后续 P3 分身派生调用。
//
// 零依赖：YAML 复用 rule-registry 的 parseYamlSubset；写出用 JSON（JSON 是合法 YAML）。
// 合并是“尽力而为”：fatal 冲突不抛异常，而是记录 conflicts 并由 manager 决定是否物化。

import path from 'node:path'
import fs from 'node:fs'

import {
  ensureDir,
  exists,
  readJson,
  writeJsonAtomic,
  sha256,
  digestTree,
  copyTree,
  removeTree,
} from '../kernel/index.mjs'
import { parseYamlSubset } from './rule-registry.mjs'

export const ESSENCE_VERSION = '1.0.0'

/** VIP 配额表：原身数 / 子原身数 / 活跃会话数。归档会话不限。 */
export const VIP_QUOTAS = Object.freeze({
  free: Object.freeze({ maxEssences: 5, maxSubEssences: 5, maxActiveSessions: 10 }),
  vip10: Object.freeze({ maxEssences: 10, maxSubEssences: 10, maxActiveSessions: 10 }),
  vip30: Object.freeze({ maxEssences: 30, maxSubEssences: 30, maxActiveSessions: 30 }),
  vip50: Object.freeze({ maxEssences: 50, maxSubEssences: 50, maxActiveSessions: 50 }),
  vip100: Object.freeze({ maxEssences: 100, maxSubEssences: 100, maxActiveSessions: 100 }),
})

export const VIP_TIERS = Object.freeze(Object.keys(VIP_QUOTAS))

export const CONFLICT_KIND = Object.freeze({
  MISSING_PLUGIN: 'missing-plugin',
  LOCKED_PLUGIN_OVERRIDDEN: 'locked-plugin-overridden',
  LOCKED_PLUGIN_DISABLED: 'locked-plugin-disabled',
  VERSION_INCOMPATIBLE: 'version-incompatible',
  DUPLICATE_ID: 'duplicate-id',
})

export const CONFLICT_SEVERITY = Object.freeze({ FATAL: 'fatal', WARNING: 'warning' })

export const ESSENCE_STATUS = Object.freeze({ READY: 'ready', CONFLICTED: 'conflicted', STALE: 'stale' })

/** @param {unknown} tier @returns {string} */
function normalizeTier(tier) {
  const text = String(tier ?? '')
  return VIP_TIERS.includes(text) ? text : 'free'
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/**
 * 原身（顶层）配额检查。
 * @param {string} tier VIP 等级
 * @param {number} currentTopLevel 当前顶层原身数
 * @param {number} [requested] 本次新增数量
 * @returns {{ok:boolean, reason?:string, current:number, limit:number, requested:number}}
 */
export function checkEssenceQuota(tier, currentTopLevel, requested = 1) {
  const quota = VIP_QUOTAS[normalizeTier(tier)]
  const current = Math.max(0, Number(currentTopLevel) || 0)
  const want = Math.max(1, Number(requested) || 1)
  const ok = current + want <= quota.maxEssences
  return {
    ok,
    current,
    limit: quota.maxEssences,
    requested: want,
    ...(ok ? {} : { reason: `essence quota exceeded: ${current}/${quota.maxEssences}, tier=${normalizeTier(tier)}` }),
  }
}

/**
 * 子原身配额检查（每个原身独立计数）。
 * @param {string} tier VIP 等级
 * @param {number} currentSiblings 该父原身下已有子原身数
 * @param {number} [requested] 本次新增数量
 * @returns {{ok:boolean, reason?:string, current:number, limit:number, requested:number}}
 */
export function checkSubEssenceQuota(tier, currentSiblings, requested = 1) {
  const quota = VIP_QUOTAS[normalizeTier(tier)]
  const current = Math.max(0, Number(currentSiblings) || 0)
  const want = Math.max(1, Number(requested) || 1)
  const ok = current + want <= quota.maxSubEssences
  return {
    ok,
    current,
    limit: quota.maxSubEssences,
    requested: want,
    ...(ok ? {} : { reason: `sub-essence quota exceeded: ${current}/${quota.maxSubEssences}, tier=${normalizeTier(tier)}` }),
  }
}

/**
 * 活跃会话配额检查（每个原身独立；归档会话不限）。
 * @param {string} tier VIP 等级
 * @param {number} currentActive 当前活跃会话数
 * @returns {{ok:boolean, reason?:string, current:number, limit:number, requested:number}}
 */
export function checkActiveSessionQuota(tier, currentActive) {
  const quota = VIP_QUOTAS[normalizeTier(tier)]
  const current = Math.max(0, Number(currentActive) || 0)
  const ok = current < quota.maxActiveSessions
  return {
    ok,
    current,
    limit: quota.maxActiveSessions,
    requested: 1,
    ...(ok ? {} : { reason: `active session quota exceeded: ${current}/${quota.maxActiveSessions}, tier=${normalizeTier(tier)}; archive old sessions first` }),
  }
}

// ===========================================================================
// cordis.patch.yml 解析：支持根列表（- insert: [...]）与 { insert: [...] }
// 复用 rule-registry 的零依赖 YAML 子集解析器；也接受纯 JSON（JSON 是合法 YAML）。
// ===========================================================================

/**
 * @param {unknown} value
 * @returns {Array<Record<string, unknown>>}
 */
function extractPatchEntries(value) {
  /** @type {Array<Record<string, unknown>>} */
  const entries = []
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== null && typeof item === 'object' && Array.isArray(item.insert)) {
        for (const entry of item.insert) {
          if (entry !== null && typeof entry === 'object') entries.push(entry)
        }
      } else if (item !== null && typeof item === 'object' && typeof item.id === 'string') {
        entries.push(item)
      }
    }
    return entries
  }
  const object = asObject(value)
  if (Array.isArray(object.insert)) {
    for (const entry of object.insert) {
      if (entry !== null && typeof entry === 'object') entries.push(entry)
    }
  }
  return entries
}

/**
 * 解析一份 patch 文本。
 * @param {string} text
 * @returns {{ entries: Array<Record<string, unknown>>, errors: string[] }}
 */
export function parsePatchEntries(text) {
  const raw = String(text ?? '').trim()
  if (raw.length === 0) return { entries: [], errors: [] }
  try {
    return { entries: extractPatchEntries(JSON.parse(raw)), errors: [] }
  } catch {
    // 不是 JSON：走 YAML 子集解析
  }
  const parsed = parseYamlSubset(raw)
  const errors = Array.isArray(parsed.errors) ? parsed.errors.map(error => String(error?.message ?? error)) : []
  return { entries: extractPatchEntries(parsed.value), errors }
}

/**
 * 序列化 patch 条目为可被 DSH loader 读取的文本（JSON 是合法 YAML）。
 * @param {Array<Record<string, unknown>>} entries
 * @returns {string}
 */
export function serializePatchEntries(entries) {
  return `${JSON.stringify({ insert: entries }, null, 2)}\n`
}

// ===========================================================================
// 纯合并逻辑
// ===========================================================================

/** @typedef {'fatal'|'warning'} ConflictSeverity */
/**
 * @typedef {object} Conflict
 * @property {string} kind
 * @property {ConflictSeverity} severity
 * @property {string} pluginId
 * @property {string} message
 * @property {unknown} [mirrorValue]
 * @property {unknown} [essenceValue]
 */
/**
 * @typedef {object} MergeResult
 * @property {Array<Record<string, unknown>>} mergedPatchEntries
 * @property {Record<string, unknown>} mergedPackageJson
 * @property {Record<string, unknown>} mergedSettings
 * @property {Conflict[]} conflicts
 * @property {boolean} hasFatal
 */

/** @param {unknown} a @param {unknown} b @returns {boolean} */
function hasConfigDiff(a, b) {
  if (a === b) return false
  if (a === undefined || b === undefined) return true
  if (a === null || b === null) return true
  return JSON.stringify(a) !== JSON.stringify(b)
}

/** @param {unknown} a @param {unknown} b */
function deepMerge(a, b) {
  const base = asObject(a)
  const patch = asObject(b)
  /** @type {Record<string, unknown>} */
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key]
    if (value !== null && typeof value === 'object' && !Array.isArray(value)
      && current !== null && typeof current === 'object' && !Array.isArray(current)) {
      out[key] = deepMerge(current, value)
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * 版本区间兼容判断：主版本相同视为兼容；无法解析时保守视为不兼容（除非完全相等）。
 * @param {string} a @param {string} b @returns {boolean}
 */
function areVersionsCompatible(a, b) {
  if (a === b) return true
  const matchA = /^[\^~]?(\d+)/.exec(String(a))
  const matchB = /^[\^~]?(\d+)/.exec(String(b))
  if (matchA === null || matchB === null) return false
  return matchA[1] === matchB[1]
}

/**
 * 按 id 合并 patch 条目。
 * 语义：镜像条目保序；原身同 id 覆盖 config（深合并）、可禁用非锁定项、可新增条目；
 * 锁定项禁止禁用/覆盖（fatal，镜像配置保留）。
 * @param {Array<Record<string, unknown>>} mirrorEntries
 * @param {Array<Record<string, unknown>>} overlayEntries
 * @param {Iterable<string>} lockedIds
 * @param {Conflict[]} conflicts
 * @returns {Array<Record<string, unknown>>}
 */
function mergePatchEntries(mirrorEntries, overlayEntries, lockedIds, conflicts) {
  const locked = lockedIds instanceof Set ? lockedIds : new Set(lockedIds)
  /** @type {Map<string, Record<string, unknown>>} */
  const byId = new Map()
  for (const entry of mirrorEntries) {
    const id = String(entry.id ?? '')
    if (id.length === 0) continue
    byId.set(id, entry)
  }

  const seenInOverlay = new Set()
  for (const entry of overlayEntries) {
    const id = String(entry.id ?? '')
    if (id.length === 0) {
      conflicts.push({
        kind: CONFLICT_KIND.MISSING_PLUGIN, severity: CONFLICT_SEVERITY.WARNING,
        pluginId: '<unknown>', message: '原身 patch 条目缺少 id，已忽略', essenceValue: entry,
      })
      continue
    }
    if (seenInOverlay.has(id)) {
      conflicts.push({
        kind: CONFLICT_KIND.DUPLICATE_ID, severity: CONFLICT_SEVERITY.WARNING,
        pluginId: id, message: `原身 patch 中 ${id} 重复出现，后者生效`,
      })
    }
    seenInOverlay.add(id)

    const mirrorEntry = byId.get(id)
    if (locked.has(id)) {
      if (entry.disabled === true) {
        conflicts.push({
          kind: CONFLICT_KIND.LOCKED_PLUGIN_DISABLED, severity: CONFLICT_SEVERITY.FATAL,
          pluginId: id, message: `插件 ${id} 是镜像锁定项，不能被原身禁用`,
          mirrorValue: mirrorEntry, essenceValue: entry,
        })
        continue
      }
      if (mirrorEntry !== undefined && hasConfigDiff(mirrorEntry.config, entry.config)) {
        conflicts.push({
          kind: CONFLICT_KIND.LOCKED_PLUGIN_OVERRIDDEN, severity: CONFLICT_SEVERITY.FATAL,
          pluginId: id, message: `插件 ${id} 是镜像锁定项，配置不能被原身覆盖`,
          mirrorValue: mirrorEntry.config, essenceValue: entry.config,
        })
      }
      continue
    }

    if (mirrorEntry === undefined) {
      byId.set(id, { ...entry })
      continue
    }
    if (entry.disabled === true) {
      byId.delete(id)
      continue
    }
    byId.set(id, {
      ...mirrorEntry,
      ...entry,
      config: deepMerge(mirrorEntry.config ?? {}, entry.config ?? {}),
    })
  }

  return Array.from(byId.values())
}

/**
 * 合并 package.json：依赖并集；主版本不兼容 → fatal，保留镜像版本；兼容 → 原身 pin 胜。
 * 非依赖字段：镜像为底、原身覆盖（浅合并）。
 * @param {Record<string, unknown>} mirrorPkg
 * @param {Record<string, unknown>} overlayPkg
 * @param {Conflict[]} conflicts
 * @returns {Record<string, unknown>}
 */
function mergePackageJson(mirrorPkg, overlayPkg, conflicts) {
  const mirrorDeps = asObject(mirrorPkg.dependencies)
  const overlayDeps = asObject(overlayPkg.dependencies)
  /** @type {Record<string, string>} */
  const mergedDeps = {}
  for (const [name, range] of Object.entries(mirrorDeps)) mergedDeps[name] = String(range)

  for (const [name, range] of Object.entries(overlayDeps)) {
    const next = String(range)
    const existing = mergedDeps[name]
    if (existing === undefined) { mergedDeps[name] = next; continue }
    if (existing === next) continue
    if (areVersionsCompatible(existing, next)) { mergedDeps[name] = next; continue }
    conflicts.push({
      kind: CONFLICT_KIND.VERSION_INCOMPATIBLE, severity: CONFLICT_SEVERITY.FATAL,
      pluginId: name, message: `依赖 ${name} 版本不兼容：镜像 ${existing} vs 原身 ${next}`,
      mirrorValue: existing, essenceValue: next,
    })
  }

  const merged = { ...mirrorPkg, ...overlayPkg, dependencies: mergedDeps }
  return merged
}

/**
 * 合并镜像基础 profile 与原身覆盖层（纯函数，不碰磁盘）。
 * @param {{ patchEntries: Array<Record<string, unknown>>, packageJson: Record<string, unknown>, lockedPluginIds: Iterable<string> }} mirror
 * @param {{ patchEntries: Array<Record<string, unknown>>, packageJson: Record<string, unknown>, settings?: Record<string, unknown> }} overlay
 * @returns {MergeResult}
 */
export function mergeProfiles(mirror, overlay) {
  /** @type {Conflict[]} */
  const conflicts = []
  const mergedPatchEntries = mergePatchEntries(
    mirror.patchEntries ?? [], overlay.patchEntries ?? [], mirror.lockedPluginIds ?? [], conflicts,
  )
  const mergedPackageJson = mergePackageJson(asObject(mirror.packageJson), asObject(overlay.packageJson), conflicts)
  const mirrorSettings = asObject(asObject(mirror.packageJson).settings)
  const mergedSettings = deepMerge(mirrorSettings, asObject(overlay.settings))
  const hasFatal = conflicts.some(conflict => conflict.severity === CONFLICT_SEVERITY.FATAL)
  return { mergedPatchEntries, mergedPackageJson, mergedSettings, conflicts, hasFatal }
}

// ===========================================================================
// EssenceManager：磁盘布局、物化、状态
// ===========================================================================

/**
 * @typedef {object} EssenceManagerOptions
 * @property {string} essencesRoot 文件夹 2 根（essences/）
 * @property {string} [mirrorProfileDir] 镜像基础 profile 目录（默认 <mirrorRoot>/active/profile）
 * @property {string} [mirrorRoot] 镜像根（用于读 meta.json / mirror-locked.json）
 * @property {Iterable<string>} [mirrorLockedIds] 锁定项（优先于 mirror-locked.json）
 * @property {{info?:Function, warn?:Function}} [logger]
 * @property {() => number} [now]
 */

export class EssenceManager {
  /** @param {EssenceManagerOptions} options */
  constructor(options) {
    this.essencesRoot = String(options.essencesRoot ?? '')
    if (this.essencesRoot.length === 0) throw new Error('EssenceManager: essencesRoot required')
    this.mirrorRoot = options.mirrorRoot ? String(options.mirrorRoot) : path.join(this.essencesRoot, '..', 'mirror')
    this.mirrorProfileDir = options.mirrorProfileDir
      ? String(options.mirrorProfileDir)
      : path.join(this.mirrorRoot, 'active', 'profile')
    this.mirrorLockedIds = new Set(options.mirrorLockedIds ?? [])
    this.logger = options.logger ?? {}
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
  }

  // ── 读取 ────────────────────────────────────────────────────────────────

  /** @returns {Array<{id:string, name:string, tier:string, parentId:string|null, createdAt:number, updatedAt:number, lastMergedFingerprint:string|null, status:string, conflictCount?:number}>} */
  list() {
    if (!exists(this.essencesRoot)) return []
    /** @type {any[]} */
    const out = []
    for (const entry of fs.readdirSync(this.essencesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('essence-')) continue
      try { out.push(this.readMeta(this.essenceRoot(entry.name))) } catch { /* 半成品目录跳过 */ }
    }
    out.sort((a, b) => a.createdAt - b.createdAt)
    return out
  }

  /** @param {string} parentId @returns {any[]} */
  listChildren(parentId) {
    return this.list().filter(meta => meta.parentId === parentId)
  }

  /** @param {string} essenceId @returns {string} */
  essenceRoot(essenceId) {
    return path.join(this.essencesRoot, this.assertId(essenceId))
  }

  /** @param {string} essenceId @returns {string} 物化后的 profile 目录（供派生实例 --profile 使用） */
  mergedProfileDir(essenceId) {
    return path.join(this.essenceRoot(essenceId), 'merged', 'profile')
  }

  /** @param {string} essenceId */
  getMeta(essenceId) {
    return this.readMeta(this.essenceRoot(essenceId))
  }

  /** @param {string} essenceId @returns {Conflict[]} */
  getConflicts(essenceId) {
    return /** @type {Conflict[]} */ (readJson(path.join(this.essenceRoot(essenceId), 'conflicts.json'), []))
  }

  // ── 写 ──────────────────────────────────────────────────────────────────

  /**
   * 创建原身。
   * @param {{name:string, tier?:string, parentId?:string|null}} options
   * @returns {any} meta
   */
  create(options) {
    const name = String(options?.name ?? '').trim()
    if (name.length === 0) throw new Error('essence name required')
    const tier = normalizeTier(options?.tier)
    const parentId = options?.parentId ? String(options.parentId) : null
    if (parentId !== null) {
      const parent = this.getMeta(parentId)
      if (parent.parentId !== null) throw new Error('只允许两级原身：子原身不能再有自己的子原身')
    }
    const quota = parentId === null
      ? checkEssenceQuota(tier, this.list().filter(meta => meta.parentId === null).length)
      : checkSubEssenceQuota(tier, this.listChildren(parentId).length)
    if (!quota.ok) throw new Error(String(quota.reason))

    const id = `essence-${this.now()}-${sha256(`${name}:${this.now()}:${Math.random()}`).slice(0, 6)}`
    const root = this.essenceRoot(id)
    ensureDir(path.join(root, 'overlay', 'settings'))
    ensureDir(path.join(root, 'overlay', 'credentials'))
    ensureDir(path.join(root, 'merged', 'profile'))
    const meta = {
      id, name, tier, parentId,
      createdAt: this.now(), updatedAt: this.now(),
      lastMergedFingerprint: null, status: ESSENCE_STATUS.READY,
    }
    this.writeMeta(root, meta)
    this.recompute(id)
    return this.getMeta(id)
  }

  /**
   * 修改覆盖层并重算（mutator 直接改 overlay 对象；save 由 manager 完成）。
   * @param {string} essenceId
   * @param {(overlay: {patchEntries:Array<Record<string,unknown>>, packageJson:Record<string,unknown>, settings:Record<string,unknown>, credentialsPath:string}) => (void|Promise<void>)} mutator
   * @returns {any} meta
   */
  async update(essenceId, mutator) {
    const root = this.essenceRoot(essenceId)
    const overlay = this.loadOverlay(root)
    await mutator(overlay)
    this.saveOverlay(root, overlay)
    this.recompute(essenceId)
    return this.getMeta(essenceId)
  }

  /**
   * 删除原身（有子原身时拒绝）。
   * @param {string} essenceId
   * @returns {{removed:boolean}}
   */
  remove(essenceId) {
    const meta = this.getMeta(essenceId)
    if (meta.parentId === null) {
      const children = this.listChildren(essenceId)
      if (children.length > 0) throw new Error(`essence ${essenceId} has ${children.length} sub-essences; remove them first`)
    }
    removeTree(this.essenceRoot(essenceId))
    return { removed: true }
  }

  /** @param {string} essenceId @param {string} tier */
  setTier(essenceId, tier) {
    const root = this.essenceRoot(essenceId)
    const meta = this.readMeta(root)
    const next = { ...meta, tier: normalizeTier(tier), updatedAt: this.now() }
    this.writeMeta(root, next)
    return this.getMeta(essenceId)
  }

  // ── 合并与物化 ──────────────────────────────────────────────────────────

  /** 读取镜像基础快照（patch/package/json/locked/fingerprint）。 */
  loadMirror() {
    const root = this.mirrorProfileDir
    ensureDir(root)
    const patchText = exists(path.join(root, 'cordis.patch.yml'))
      ? fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
      : ''
    const parsed = parsePatchEntries(patchText)
    const packageJson = asObject(readJson(path.join(root, 'package.json'), {}))
    const lockedFromFile = this.readLockedFromMirror()
    const lockedPluginIds = new Set([...this.mirrorLockedIds, ...lockedFromFile])
    const tree = digestTree(root)
    const fingerprint = sha256(JSON.stringify(tree))
    let version = 'unknown'
    try { version = String(readJson(path.join(this.mirrorRoot, 'meta.json'), {}).version ?? 'unknown') } catch { version = 'unknown' }
    return {
      root, version, fingerprint, packageJson,
      patchEntries: parsed.entries,
      parseErrors: parsed.errors,
      lockedPluginIds,
    }
  }

  /** 读取原身覆盖层（*_test 可直接构造）。 */
  loadOverlay(root) {
    const overlayRoot = path.join(root, 'overlay')
    ensureDir(overlayRoot)
    const patchText = exists(path.join(overlayRoot, 'cordis.patch.yml'))
      ? fs.readFileSync(path.join(overlayRoot, 'cordis.patch.yml'), 'utf8')
      : ''
    const parsed = parsePatchEntries(patchText)
    const settings = {}
    const settingsDir = path.join(overlayRoot, 'settings')
    if (exists(settingsDir)) {
      for (const file of fs.readdirSync(settingsDir)) {
        if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue
        const text = fs.readFileSync(path.join(settingsDir, file), 'utf8')
        const name = file.replace(/\.ya?ml$/, '')
        try { settings[name] = JSON.parse(text) } catch {
          const subset = parseYamlSubset(text)
          settings[name] = subset.value
        }
      }
    }
    return {
      root: overlayRoot,
      patchEntries: parsed.entries,
      packageJson: asObject(readJson(path.join(overlayRoot, 'package.json'), {})),
      settings,
      credentialsPath: path.join(overlayRoot, 'credentials'),
      parseErrors: parsed.errors,
    }
  }

  /**
   * 重算单个原身：合并 → 失败则标记 conflicted 并保留上一次物化结果；成功则重建 merged/profile。
   * @param {string} essenceId
   * @returns {MergeResult & { status: string, fingerprint: string }}
   */
  recompute(essenceId) {
    const root = this.essenceRoot(essenceId)
    const meta = this.readMeta(root)
    const mirror = this.loadMirror()
    const overlay = this.loadOverlay(root)
    const result = mergeProfiles(mirror, overlay)
    const parseErrors = [...(mirror.parseErrors ?? []), ...(overlay.parseErrors ?? [])]
    if (parseErrors.length > 0) {
      result.conflicts.push({
        kind: CONFLICT_KIND.MISSING_PLUGIN, severity: CONFLICT_SEVERITY.FATAL,
        pluginId: '<patch>', message: `patch 解析错误：${parseErrors.join('; ')}`,
      })
      result.hasFatal = true
    }

    if (result.hasFatal) {
      writeJsonAtomic(path.join(root, 'conflicts.json'), result.conflicts)
      this.writeMeta(root, {
        ...meta, status: ESSENCE_STATUS.CONFLICTED, updatedAt: this.now(),
        lastMergeConflicts: result.conflicts.length,
      })
      this.logger?.warn?.(`[essence] ${essenceId} has fatal conflicts`, {
        fatal: result.conflicts.filter(conflict => conflict.severity === 'fatal').length,
      })
      return { ...result, status: ESSENCE_STATUS.CONFLICTED, fingerprint: mirror.fingerprint }
    }

    this.materializeMerged(root, mirror, overlay, result)
    if (exists(path.join(root, 'conflicts.json'))) fs.rmSync(path.join(root, 'conflicts.json'), { force: true })
    this.writeMeta(root, {
      ...meta, status: ESSENCE_STATUS.READY, updatedAt: this.now(),
      lastMergedFingerprint: mirror.fingerprint, lastMergeConflicts: result.conflicts.length,
    })
    return { ...result, status: ESSENCE_STATUS.READY, fingerprint: mirror.fingerprint }
  }

  /** 镜像升级后批量重算。 @returns {{recomputed:string[], conflicted:string[]}} */
  recomputeAll() {
    const recomputed = []
    const conflicted = []
    for (const meta of this.list()) {
      const result = this.recompute(meta.id)
      if (result.status === ESSENCE_STATUS.CONFLICTED) conflicted.push(meta.id)
      else recomputed.push(meta.id)
    }
    return { recomputed, conflicted }
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  /** @param {string} value @returns {string} */
  assertId(value) {
    const id = String(value ?? '')
    if (!/^essence-[A-Za-z0-9-]+$/.test(id)) throw new Error(`invalid essence id: ${id}`)
    return id
  }

  /** @param {string} root */
  readMeta(root) {
    return asObject(readJson(path.join(root, 'meta.json'), {}))
  }

  /** @param {string} root @param {Record<string, unknown>} meta */
  writeMeta(root, meta) {
    ensureDir(root)
    writeJsonAtomic(path.join(root, 'meta.json'), meta)
  }

  /** 读取镜像锁定项文件（可选 `<mirrorRoot>/mirror-locked.json`，支持数组或 {locked:[...]}）。 */
  readLockedFromMirror() {
    const file = path.join(this.mirrorRoot, 'mirror-locked.json')
    if (!exists(file)) return []
    const raw = readJson(file, [])
    if (Array.isArray(raw)) return raw.map(String)
    return Array.isArray(raw?.locked) ? raw.locked.map(String) : []
  }

  /** @param {string} root @param {Record<string, unknown>} overlay */
  saveOverlay(root, overlay) {
    const overlayRoot = path.join(root, 'overlay')
    ensureDir(overlayRoot)
    fs.writeFileSync(path.join(overlayRoot, 'cordis.patch.yml'), serializePatchEntries(overlay.patchEntries), 'utf8')
    writeJsonAtomic(path.join(overlayRoot, 'package.json'), overlay.packageJson)
    const settingsDir = path.join(overlayRoot, 'settings')
    ensureDir(settingsDir)
    for (const [name, value] of Object.entries(overlay.settings)) {
      fs.writeFileSync(path.join(settingsDir, `${name}.yaml`), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    }
  }

  /**
   * 物化 merged/profile：镜像骨架 + 合并后的 patch/package/settings + 原身凭据（镜像凭据剔除）。
   */
  materializeMerged(root, mirror, overlay, result) {
    const mergedRoot = path.join(root, 'merged')
    const mergedProfile = path.join(mergedRoot, 'profile')
    if (exists(mergedRoot)) removeTree(mergedRoot)
    ensureDir(mergedProfile)
    copyTree(mirror.root, mergedProfile)
    fs.writeFileSync(path.join(mergedProfile, 'cordis.patch.yml'), serializePatchEntries(result.mergedPatchEntries), 'utf8')
    writeJsonAtomic(path.join(mergedProfile, 'package.json'), result.mergedPackageJson)
    const settingsDir = path.join(mergedProfile, 'settings')
    ensureDir(settingsDir)
    for (const [name, value] of Object.entries(result.mergedSettings)) {
      fs.writeFileSync(path.join(settingsDir, `${name}.yaml`), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    }
    // 凭据只属于原身：先剔除镜像可能带入的 credentials，再复制原身凭据
    const mergedCredentials = path.join(mergedProfile, 'credentials')
    if (exists(mergedCredentials)) removeTree(mergedCredentials)
    if (exists(overlay.credentialsPath)) copyTree(overlay.credentialsPath, mergedCredentials)
    writeJsonAtomic(path.join(mergedRoot, 'fingerprint.json'), {
      mirrorVersion: mirror.version,
      mirrorFingerprint: mirror.fingerprint,
      mergedAt: this.now(),
      conflicts: result.conflicts.length,
    })
  }
}

export const _internals = Object.freeze({
  mergePatchEntries, mergePackageJson, deepMerge, hasConfigDiff, areVersionsCompatible,
  extractPatchEntries, normalizeTier,
})
