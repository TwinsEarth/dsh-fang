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
import { KeyedMutex } from './mutex.mjs'
import { Semaphore } from './semaphore.mjs'

export const ESSENCE_VERSION = '1.0.0'

/** v3.0.4 官方推荐原身（内置、锁定、快速派生默认基底）。 */
export const OFFICIAL_ESSENCE_ID = 'essence-official-dev'
export const OFFICIAL_ESSENCE_NAME = '开发者推荐（官方）'
export const OFFICIAL_ESSENCE_MIN_TIER = 'vip100'
/** 官方推荐原身预装的默认插件条目（v3.0.7：自定义清单，安装≠激活）。 */
export const DEFAULT_OFFICIAL_PATCH_ENTRIES = Object.freeze([
  // 安装但不激活
  Object.freeze({ id: 'official-2xray', name: '@twinsearth/dsh-2xray', disabled: true }),
  Object.freeze({ id: 'official-agency-agents', name: '@michengai/dsh-agency-agents', disabled: true }),
  Object.freeze({ id: 'official-better-sidebar', name: 'dsh-better-sidebar', disabled: true }),
  Object.freeze({ id: 'official-context', name: 'dsh-context', disabled: true }),
  Object.freeze({ id: 'official-modlens', name: '@liustack/modlens', disabled: true }),
  Object.freeze({ id: 'official-modsearch', name: '@liustack/modsearch', disabled: true }),
  // 安装并激活
  Object.freeze({ id: 'official-dshmarket', name: 'dshmarket', disabled: false }),
  Object.freeze({ id: 'official-im2a', name: '@twinsearth/dsh-im2a-plugin', disabled: false }),
  Object.freeze({ id: 'official-openviking-memory', name: '@openviking/dsh-memory-plugin', disabled: false }),
  Object.freeze({ id: 'official-w2m', name: '@twinsearth/w2m-dsh-plugin', disabled: false }),
])

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

/** v3.0.9：冻结（archived）的元主只能删除，其它操作一律拒绝。 */
function assertNotFrozen(meta) {
  if (meta && meta.archived === true) throw new Error(`essence ${meta.id} is archived/frozen（已冻结，只能删除）`)
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
    this.mutex = new KeyedMutex()
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

  /**
   * 幂等确保 merged/profile 最新：镜像指纹未变且状态 ready 时跳过重算。
   * 同一原身的并发调用按 key 串行，只有第一个真正重算（后续看到指纹已匹配直接返回）。
   * @param {string} essenceId
   * @returns {Promise<{meta: Record<string, unknown>, recomputed: boolean}>}
   */
  async ensureFresh(essenceId) {
    return this.mutex.run(essenceId, async () => {
      const root = this.essenceRoot(essenceId)
      const meta = this.readMeta(root)
      const mirror = this.loadMirror()
      if (meta.status === ESSENCE_STATUS.READY && meta.lastMergedFingerprint === mirror.fingerprint) {
        return { meta, recomputed: false }
      }
      this.recompute(essenceId)
      return { meta: this.readMeta(root), recomputed: true }
    })
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
    if (options?.skipQuota !== true) {
      const quota = parentId === null
        ? checkEssenceQuota(tier, this.list().filter(meta => meta.parentId === null).length)
        : checkSubEssenceQuota(tier, this.listChildren(parentId).length)
      if (!quota.ok) throw new Error(String(quota.reason))
    }

    const requestedId = options?.id === undefined ? '' : String(options.id)
    const id = requestedId.length > 0
      ? requestedId
      : `essence-${this.now()}-${sha256(`${name}:${this.now()}:${Math.random()}`).slice(0, 6)}`
    const root = this.essenceRoot(id)
    // v3.0.5/B6：create-only —— 已存在的原身不能被 create() 覆盖/抢占
    if (exists(path.join(root, 'meta.json'))) throw new Error(`essence already exists: ${id}`)
    ensureDir(path.join(root, 'overlay', 'settings'))
    ensureDir(path.join(root, 'overlay', 'credentials'))
    ensureDir(path.join(root, 'merged', 'profile'))
    const officialSeed = options?.official === true
    const meta = {
      id, name, tier, parentId,
      createdAt: this.now(), updatedAt: this.now(),
      lastMergedFingerprint: null, status: ESSENCE_STATUS.READY,
      locked: officialSeed && options?.locked === true,
      official: officialSeed,
    }
    this.writeMeta(root, meta)
    const defaultEntries = Array.isArray(options?.defaultPatchEntries) ? options.defaultPatchEntries : []
    if (defaultEntries.length > 0) {
      const overlay = this.loadOverlay(root)
      overlay.patchEntries = [...defaultEntries.map(entry => ({ ...entry })), ...overlay.patchEntries]
      this.saveOverlay(root, overlay)
    }
    this.recompute(id)
    return this.getMeta(id)
  }

  /**
   * 确保“官方推荐原身”存在（首次启动 seed，幂等；锁定不可删改）。
   * @param {{defaultPatchEntries?: Array<Record<string, unknown>>}} [options]
   * @returns {any} meta
   */
  ensureOfficialEssence(options = {}) {
    const root = this.essenceRoot(OFFICIAL_ESSENCE_ID)
    if (exists(path.join(root, 'meta.json'))) {
      const meta = this.getMeta(OFFICIAL_ESSENCE_ID)
      // v3.0.5/B6：已存在的官方原身必须是 locked+official；被篡改则修复（不删除数据）
      if (meta.locked !== true || meta.official !== true) {
        this.writeMeta(root, { ...meta, locked: true, official: true, updatedAt: this.now() })
        return this.getMeta(OFFICIAL_ESSENCE_ID)
      }
      return meta
    }
    return this.create({
      id: OFFICIAL_ESSENCE_ID,
      name: OFFICIAL_ESSENCE_NAME,
      tier: OFFICIAL_ESSENCE_MIN_TIER,
      locked: true,
      official: true,
      skipQuota: true,
      defaultPatchEntries: options?.defaultPatchEntries ?? DEFAULT_OFFICIAL_PATCH_ENTRIES,
    })
  }

  /**
   * 从母体 profile 生成元主（v3.0.9）：把母体的**可写层**克隆成新元主的覆盖层。
   *
   * 克隆范围（只读母体）：
   *   * `cordis.patch.yml` → overlay patch entries（插件安装/启用/配置）
   *   * `package.json` → overlay 的 name/private/type/dsh/dependencies（可关）
   *   * `settings/*.yaml` → overlay settings（可关）
   * 绝不复制：credentials、sessions、storages、logs、node_modules（B8 边界）。
   *
   * @param {string} profileDir 母体 profile 目录（必须含 package.json）
   * @param {{name?:string, tier?:string, parentId?:string|null, includeDependencies?:boolean,
   *   includeSettings?:boolean, defaultPatchEntries?:Array<Record<string,unknown>>, skipQuota?:boolean}} [options]
   * @returns {{meta:any, captured:Record<string,unknown>, conflicts:Conflict[], status:string}}
   */
  captureFromProfile(profileDir, options = {}) {
    const dir = path.resolve(String(profileDir ?? '').trim())
    if (dir.length === 0) throw new Error('capture: mother profile dir required')
    const packageFile = path.join(dir, 'package.json')
    if (!exists(packageFile)) throw new Error(`capture: mother profile has no package.json: ${dir}`)
    // 元主自己的物化目录不能当母体（否则是自我叠加）。
    const relative = path.relative(path.resolve(this.essencesRoot), dir)
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      throw new Error('capture: refusing to clone from an essence directory')
    }
    const profilePkg = asObject(readJson(packageFile, {}))
    const patchText = exists(path.join(dir, 'cordis.patch.yml'))
      ? fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
      : ''
    const parsed = parsePatchEntries(patchText)
    if (parsed.errors.length > 0) {
      throw new Error(`capture: mother patch parse failed: ${parsed.errors.join('; ')}`)
    }
    const fallbackName = typeof profilePkg.name === 'string' && profilePkg.name.length > 0
      ? `${profilePkg.name} 元主` : `${path.basename(dir)} 元主`
    const name = String(options?.name ?? '').trim() || fallbackName

    const created = this.create({
      name,
      tier: options?.tier,
      parentId: options?.parentId ?? null,
      skipQuota: options?.skipQuota === true,
    })
    const root = this.essenceRoot(created.id)
    const overlay = this.loadOverlay(root)
    const seedEntries = Array.isArray(options?.defaultPatchEntries)
      ? options.defaultPatchEntries.map(entry => ({ ...entry })) : []
    overlay.patchEntries = [...seedEntries, ...parsed.entries, ...overlay.patchEntries]
    if (options?.includeDependencies !== false) {
      overlay.packageJson = { ...this.selectProfilePackage(profilePkg), ...overlay.packageJson }
    }
    if (options?.includeSettings !== false) {
      Object.assign(overlay.settings, this.readProfileSettings(dir))
    }
    this.saveOverlay(root, overlay)
    const merge = this.recompute(created.id)
    const bundles = asObject(profilePkg.dsh).profile?.bundles
    const captured = {
      profileDir: dir,
      profileName: typeof profilePkg.name === 'string' ? profilePkg.name : null,
      patchEntries: parsed.entries.length,
      dependencies: Object.keys(asObject(overlay.packageJson.dependencies)).length,
      bundles: Array.isArray(bundles) ? bundles.length : 0,
      settings: Object.keys(overlay.settings).length,
      credentialsCopied: false,
    }
    return { meta: this.getMeta(created.id), captured, conflicts: merge.conflicts, status: merge.status }
  }

  /** 提取可安全复制进元主 overlay 的 profile package.json 字段（不含 scripts/devDeps）。 */
  selectProfilePackage(profilePkg) {
    /** @type {Record<string, unknown>} */
    const picked = {}
    for (const key of ['name', 'private', 'type']) {
      if (profilePkg?.[key] !== undefined) picked[key] = profilePkg[key]
    }
    const dsh = asObject(profilePkg?.dsh)
    if (Object.keys(dsh).length > 0) picked.dsh = dsh
    const deps = asObject(profilePkg?.dependencies)
    if (Object.keys(deps).length > 0) picked.dependencies = deps
    return picked
  }

  /** 读取母体 profile 的 settings/*.yaml（仅为覆盖层，不碰其他目录）。 */
  readProfileSettings(profileDir) {
    /** @type {Record<string, unknown>} */
    const settings = {}
    const settingsDir = path.join(String(profileDir), 'settings')
    if (!exists(settingsDir)) return settings
    for (const file of fs.readdirSync(settingsDir)) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue
      const text = fs.readFileSync(path.join(settingsDir, file), 'utf8')
      const name = file.replace(/\.ya?ml$/, '')
      try { settings[name] = JSON.parse(text) } catch {
        settings[name] = parseYamlSubset(text).value
      }
    }
    return settings
  }

  /**
   * 修改覆盖层并重算（mutator 直接改 overlay 对象；save 由 manager 完成）。
   * @param {string} essenceId
   * @param {(overlay: {patchEntries:Array<Record<string,unknown>>, packageJson:Record<string,unknown>, settings:Record<string,unknown>, credentialsPath:string}) => (void|Promise<void>)} mutator
   * @returns {any} meta
   */
  async update(essenceId, mutator) {
    const root = this.essenceRoot(essenceId)
    const meta = this.readMeta(root)
    if (meta.locked === true) throw new Error(`essence ${essenceId} is locked（官方推荐原身不支持修改设置）`)
    assertNotFrozen(meta)
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
    if (meta.locked === true) throw new Error(`essence ${essenceId} is locked（官方推荐原身不可删除）`)
    // v3.0.9 规则：先归档（冻结）才允许删除，删除本身不可撤销。
    if (meta.archived !== true) throw new Error(`essence ${essenceId} is not archived; archive it before deleting`)
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
    if (meta.locked === true) throw new Error(`essence ${essenceId} is locked（官方推荐原身等级不可修改）`)
    assertNotFrozen(meta)
    const next = { ...meta, tier: normalizeTier(tier), updatedAt: this.now() }
    this.writeMeta(root, next)
    return this.getMeta(essenceId)
  }

  // ── v3.0.6 元主 CRUD / 默认元主 / 导出 ────────────────────────────────
  /** 重命名（locked 拒绝；1–80 字符）。 */
  rename(essenceId, name) {
    const trimmed = String(name ?? '').trim()
    if (trimmed.length === 0 || trimmed.length > 80) throw new Error('essence name must be 1..80 chars')
    const root = this.essenceRoot(essenceId)
    const meta = this.readMeta(root)
    if (meta.locked === true) throw new Error(`essence ${essenceId} is locked（官方推荐原身不可重命名）`)
    assertNotFrozen(meta)
    const next = { ...meta, name: trimmed, updatedAt: this.now() }
    this.writeMeta(root, next)
    return this.getMeta(essenceId)
  }

  /** 归档/取消归档（locked 拒绝；归档只改元数据，不删目录）。 */
  archive(essenceId, archived = true) {
    const root = this.essenceRoot(essenceId)
    const meta = this.readMeta(root)
    if (meta.locked === true) throw new Error(`essence ${essenceId} is locked（官方推荐原身不可归档）`)
    const next = {
      ...meta,
      archived: archived === true,
      archivedAt: archived === true ? this.now() : null,
      updatedAt: this.now(),
    }
    this.writeMeta(root, next)
    return this.getMeta(essenceId)
  }

  /** 设置默认派生元主（快速派生使用）。 */
  setDefault(essenceId) {
    const meta = this.getMeta(essenceId)
    ensureDir(this.essencesRoot)
    writeJsonAtomic(path.join(this.essencesRoot, 'default.json'), { essenceId: meta.id, updatedAt: this.now() })
    return { essenceId: meta.id, name: meta.name }
  }

  getDefault() {
    const doc = readJson(path.join(this.essencesRoot, 'default.json'), null)
    const id = typeof doc?.essenceId === 'string' ? doc.essenceId : OFFICIAL_ESSENCE_ID
    try {
      const meta = this.getMeta(id)
      return { essenceId: meta.id, name: meta.name, official: meta.official === true }
    } catch {
      return { essenceId: OFFICIAL_ESSENCE_ID, name: OFFICIAL_ESSENCE_NAME, official: true }
    }
  }

  /**
   * 复制元主（overlay 配置 + 设置；**不复制 credentials**，B8）。
   * @param {string} essenceId
   * @param {{name?: string}} [options]
   */
  copy(essenceId, options = {}) {
    const source = this.getMeta(essenceId)
    assertNotFrozen(source)
    const sourceRoot = this.essenceRoot(essenceId)
    const name = String(options?.name ?? `${source.name} 副本`).trim()
    const created = this.create({
      name,
      tier: source.tier,
      parentId: source.parentId ?? null,
    })
    const nextRoot = this.essenceRoot(created.id)
    // v3.0.9 深复制：整份沙箱目录（overlay + merged + 自定义数据）到新文件夹。
    // 边界：不复制 credentials（B8）、不复制 runtime（运行态进程目录）、不复制 Backup、不覆盖新 meta。
    const skip = new Set(['meta.json', 'credentials', 'runtime', 'Backup'])
    let copiedFiles = 0
    for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue
      const from = path.join(sourceRoot, entry.name)
      const to = path.join(nextRoot, entry.name)
      if (exists(to)) removeTree(to)
      copyTree(from, to)
      // overlay/credentials 属于登录态，必须剔除（B8）。
      const copiedCredentials = path.join(to, 'credentials')
      if (entry.name === 'overlay' && exists(copiedCredentials)) removeTree(copiedCredentials)
      if (entry.isDirectory()) {
        const walk = (dir) => {
          for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, child.name)
            if (child.isDirectory()) walk(file)
            else if (child.isFile()) copiedFiles += 1
          }
        }
        walk(to)
      } else if (entry.isFile()) copiedFiles += 1
    }
    // 凭据目录在新沙箱里保持为空（不继承任何登录态）。
    ensureDir(path.join(nextRoot, 'overlay', 'credentials'))
    this.recompute(created.id)
    const meta = this.getMeta(created.id)
    return { ...meta, copy: { sourceId: source.id, copiedFiles } }
  }

  /** 元主当前插件条目数（用于面板卡片）。 */
  pluginCount(essenceId) {
    return this.loadOverlay(this.essenceRoot(essenceId)).patchEntries.length
  }

  /**
   * 导出元主配置（overlay：patch/package/settings；**不含凭据**）。
   * 供 `GET /api/essence/download` 返回 JSON 文件；超过 maxBytes 拒绝。
   */
  downloadBundle(essenceId, options = {}) {
    const maxBytes = Math.max(1024, Math.floor(Number(options.maxBytes) || 32 * 1024 * 1024))
    const root = this.essenceRoot(essenceId)
    const meta = this.getMeta(essenceId)
    const full = options.full === true
    const base = full ? root : path.join(root, 'overlay')
    const files = []
    let total = 0
    // full=true：整包导出（跨机迁移）；跳过凭据、运行时 home 与备份目录。
    const skip = new Set(full ? ['credentials', 'runtime', 'Backup'] : ['credentials'])
    const walk = (dir, relative) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue
        // full=true：运行态只导出它的会话沙箱（runtime/home/sessions），不含进程/依赖目录。
        if (full && entry.name === 'runtime') {
          const sessionsDir = path.join(dir, 'runtime', 'home', 'sessions')
          if (exists(sessionsDir)) walk(sessionsDir, 'runtime/home/sessions')
          continue
        }
        const target = path.join(dir, entry.name)
        const rel = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isDirectory()) { walk(target, rel); continue }
        if (!entry.isFile()) continue
        const bytes = fs.readFileSync(target)
        total += bytes.length
        if (total > maxBytes) throw new Error('essence bundle too large')
        files.push({ path: full ? rel : `overlay/${rel}`, base64: bytes.toString('base64') })
      }
    }
    if (exists(base)) walk(base, '')
    if (full) {
      // 迁移引导 + 清单，保证新 PC 拿到包就知道怎么导入。
      const guide = [
        '# dsh-Fang 元主导入引导',
        '',
        '1. 目标机器安装并启用 dsh-Fang（@local/dsh-fang）。',
        '2. 打开瓮城面板 → 元主区 → 「导入」→ 选择本 JSON 文件（或 POST /fang/api/essence/import）。',
        '3. 导入会生成新的 essences/<新id> 并自动重算；凭据不随包迁移，需要重新登录。',
        '4. 打开前建议先执行「同步」，把该元主重放到目标机器当前的母体镜像。',
        '',
        `来源元主：${String(meta?.name ?? '')} (${essenceId})`,
        `导出时间：${new Date(this.now()).toISOString()}`,
        '包格式：dsh-fang-essence-bundle v1',
      ].join('\n')
      const manifest = JSON.stringify({
        format: 'dsh-fang-essence-bundle',
        version: 1,
        createdAt: this.now(),
        sourceId: essenceId,
        name: meta?.name ?? null,
        tier: meta?.tier ?? null,
        files: files.length,
      }, null, 2)
      const appendText = (name, text) => {
        const bytes = Buffer.from(text, 'utf8')
        total += bytes.length
        if (total > maxBytes) throw new Error('essence bundle too large')
        files.push({ path: name, base64: bytes.toString('base64') })
      }
      appendText('IMPORT-GUIDE.md', guide)
      appendText('manifest.json', manifest)
    }
    return { ok: true, essenceId, meta, files, bytes: total, full, createdAt: this.now() }
  }

  /** v3.0.9 备份：essences/<id>/Backup（固定一份，旧备份覆盖）。 */
  backup(essenceId) {
    const root = this.essenceRoot(essenceId)
    assertNotFrozen(this.getMeta(essenceId))
    const target = path.join(root, 'Backup')
    if (exists(target)) removeTree(target)
    copyTree(root, target)
    const nested = path.join(target, 'Backup')
    if (exists(nested)) removeTree(nested)
    let bytes = 0
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(file)
        else if (entry.isFile()) bytes += fs.statSync(file).size
      }
    }
    walk(target)
    return { ok: true, essenceId, backupDir: target, bytes, at: this.now() }
  }

  /** v3.0.9 还原：用 Backup 覆盖当前 overlay/merged/meta（Backup 保留一份）。 */
  restoreBackup(essenceId) {
    assertNotFrozen(this.getMeta(essenceId))
    const root = this.essenceRoot(essenceId)
    const backupDir = path.join(root, 'Backup')
    if (!exists(backupDir)) throw new Error('backup-missing')
    for (const entry of fs.readdirSync(backupDir, { withFileTypes: true })) {
      if (entry.name === 'Backup' || entry.name === 'runtime') continue
      const from = path.join(backupDir, entry.name)
      const to = path.join(root, entry.name)
      if (exists(to)) removeTree(to)
      copyTree(from, to)
    }
    this.recompute(essenceId)
    return { ok: true, essenceId, restored: true, at: this.now() }
  }

  /** v3.0.9 导入：{meta, files:[{path,base64}]} → 新元主目录，可直接继续开发。 */
  importBundle(doc, options = {}) {
    const sourceMeta = asObject(doc?.meta)
    const files = Array.isArray(doc?.files) ? doc.files : []
    if (files.length === 0) throw new Error('bundle has no files')
    const name = String(options?.name ?? sourceMeta.name ?? '导入的元主').trim() || '导入的元主'
    const meta = this.create({
      name,
      tier: options?.tier ?? sourceMeta.tier,
      parentId: options?.parentId ?? null,
      skipQuota: options?.skipQuota === true,
    })
    const root = this.essenceRoot(meta.id)
    for (const file of files) {
      const rel = String(file?.path ?? '')
      if (!rel || rel.includes('..') || path.isAbsolute(rel)) continue
      // 包里的 meta.json / Backup 不能覆盖导入后新建的元数据。
      if (rel === 'meta.json' || rel.startsWith('Backup/') || rel === 'Backup') continue
      const target = path.join(root, rel)
      ensureDir(path.dirname(target))
      fs.writeFileSync(target, Buffer.from(String(file.base64 ?? ''), 'base64'))
    }
    this.recompute(meta.id)
    return { ok: true, essence: this.getMeta(meta.id), files: files.length, sourceId: sourceMeta.id ?? null }
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

  /**
   * 镜像升级后批量重算：只重算 fingerprint 不匹配的原身（ensureFresh），
   * 并发上限 + 单个超时 + 失败隔离 + 进度回调 + AbortSignal。
   * @param {{concurrency?: number, perEssenceTimeoutMs?: number, signal?: AbortSignal, onProgress?: Function}} [options]
   * @returns {Promise<{recomputed: string[], skipped: string[], conflicted: string[], failed: Array<{id: string, error: string}>, aborted: boolean, durationMs: number}>}
   */
  async recomputeAll(options = {}) {
    const startedAt = this.now()
    const concurrency = Math.max(1, Math.floor(Number(options.concurrency) || 4))
    const timeoutMs = Math.max(1, Math.floor(Number(options.perEssenceTimeoutMs) || 60_000))
    const ids = this.list().map(meta => String(meta.id))
    const result = { recomputed: [], skipped: [], conflicted: [], failed: [], aborted: false, durationMs: 0 }
    if (ids.length === 0) {
      result.durationMs = this.now() - startedAt
      return result
    }
    const semaphore = new Semaphore(concurrency)
    let done = 0
    const report = (currentId) => {
      try {
        options.onProgress?.({
          done, total: ids.length, currentId,
          recomputed: result.recomputed.length,
          skipped: result.skipped.length,
          conflicted: result.conflicted.length,
          failed: result.failed.length,
        })
      } catch { /* 观察者异常不影响重算 */ }
    }
    await Promise.all(ids.map(async (id) => {
      await semaphore.acquire()
      try {
        if (options.signal?.aborted) { result.aborted = true; return }
        const fresh = await withTimeout(this.ensureFresh(id), timeoutMs, `recompute timeout for ${id}`)
        if (fresh.meta?.status === ESSENCE_STATUS.CONFLICTED) result.conflicted.push(id)
        else if (fresh.recomputed === true) result.recomputed.push(id)
        else result.skipped.push(id)
      } catch (error) {
        result.failed.push({ id, error: String(error instanceof Error ? error.message : error) })
      } finally {
        done += 1
        report(id)
        semaphore.release()
      }
    }))
    result.durationMs = this.now() - startedAt
    return result
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
    // v3.0.5/B8：凭据永不进入 merged/profile —— 派生 profile 不携带任何 credentials
    const mergedCredentials = path.join(mergedProfile, 'credentials')
    if (exists(mergedCredentials)) removeTree(mergedCredentials)
    writeJsonAtomic(path.join(mergedRoot, 'fingerprint.json'), {
      mirrorVersion: mirror.version,
      mirrorFingerprint: mirror.fingerprint,
      mergedAt: this.now(),
      conflicts: result.conflicts.length,
    })
  }
}

/** Promise 超时包装（v3.0.9：recomputeAll 单原身超时）。 */
function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    timer.unref?.()
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

export const _internals = Object.freeze({
  mergePatchEntries, mergePackageJson, deepMerge, hasConfigDiff, areVersionsCompatible,
  extractPatchEntries, normalizeTier, withTimeout,
})
