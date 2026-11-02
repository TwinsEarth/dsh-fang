// SPDX-License-Identifier: AGPL-3.0-or-later
// dsh-Fang v3.0.8 — schema 驱动的镜像偏好存储（零依赖）。
//
// 一个字段 = 一条 schema 描述符（kind/default/min/max/step/options/migrate）；
// PreferencesStore 只做通用的“读文件 → 逐字段迁移+校验 → 补默认值 → 需要时写回”。
// 新增字段只改 PREFERENCES_SCHEMA；UI 可基于 schema 声明式渲染。
//
// 向后兼容：
//   * 旧文件缺失的新字段自动补默认值并写回；
//   * 旧值经 migrate/coerce 修正后写回，并报告 migrated 字段；
//   * 未知字段被丢弃并报告 droppedUnknown；
//   * 损坏 JSON 不覆盖原文件（保留证据），返回默认值。

import fs from 'node:fs'
import path from 'node:path'

import { ensureDir, readJson, writeJsonAtomic } from '../kernel/index.mjs'
/** @typedef {{kind:'number', defaultValue:number, min:number, max:number, step:number, unit?:string, migrate?:Function}} NumberField */
/** @typedef {{kind:'enum', defaultValue:string, options:Array<{value:string,label:string}>, migrate?:Function}} EnumField */
/** @typedef {{kind:'boolean', defaultValue:boolean, migrate?:Function}} BooleanField */

export const PREFERENCES_SCHEMA = Object.freeze({
  activeIdleTimeoutMs: Object.freeze({
    kind: 'number', label: '对话框交互超时', unit: 'ms',
    description: '无交互超过此时长后降低状态轮询频率',
    defaultValue: 30_000, min: 5_000, max: 300_000, step: 5_000,
    // 旧版本只接受 15/30/60s；其他值视为无效 → 用默认值
    migrate: (raw) => ([15_000, 30_000, 60_000].includes(raw) ? raw : undefined),
  }),
  pollIntervalMs: Object.freeze({
    kind: 'number', label: '活跃轮询间隔', unit: 'ms',
    description: '对话框打开时的状态刷新频率',
    defaultValue: 5_000, min: 1_000, max: 60_000, step: 1_000,
  }),
  idlePollIntervalMs: Object.freeze({
    kind: 'number', label: '空闲轮询间隔', unit: 'ms',
    description: '无交互时的状态刷新频率',
    defaultValue: 60_000, min: 30_000, max: 600_000, step: 10_000,
  }),
  backupRetentionDays: Object.freeze({
    kind: 'number', label: '备份保留天数', unit: 'day',
    description: '超过此天数的自动备份会被清理；手动恢复点不受影响',
    defaultValue: 30, min: 1, max: 365, step: 1,
  }),
  idleDowngradeNotification: Object.freeze({
    kind: 'enum', label: '空闲降级提示',
    description: '用户离开后是否显示提示',
    defaultValue: 'silent',
    options: Object.freeze([
      { value: 'silent', label: '静默' },
      { value: 'toast', label: '轻提示' },
      { value: 'banner', label: '横幅' },
    ]),
  }),
  strictConflictMode: Object.freeze({
    kind: 'boolean', label: '严格冲突模式',
    description: '开启后任何原身冲突都会阻止派生，而不是自动跳过',
    defaultValue: false,
  }),
})

export const PREFERENCES_KEYS = Object.freeze(Object.keys(PREFERENCES_SCHEMA))

/** 由 schema 生成默认偏好（新字段自动出现在这里）。 */
export function buildDefaultPreferences(schema = PREFERENCES_SCHEMA) {
  const out = {}
  for (const [key, field] of Object.entries(schema)) out[key] = field.defaultValue
  return out
}

/**
 * 校验/对齐单个字段；非法返回 undefined。
 * @param {NumberField|EnumField|BooleanField} field
 * @param {unknown} value
 */
export function coerceField(field, value) {
  if (field.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    if (value < field.min || value > field.max) return undefined
    return Math.round((value - field.min) / field.step) * field.step + field.min
  }
  if (field.kind === 'enum') {
    if (typeof value !== 'string') return undefined
    return field.options.some(option => option.value === value) ? value : undefined
  }
  if (field.kind === 'boolean') return typeof value === 'boolean' ? value : undefined
  return undefined
}

/**
 * 纯函数：把任意 raw 规范成完整偏好。测试可直接调用。
 * @param {unknown} raw
 * @param {Record<string, NumberField|EnumField|BooleanField>} [schema]
 * @returns {{preferences:Record<string, unknown>, existed:boolean, migrated:string[], droppedUnknown:string[]}}
 */
export function normalizePreferences(raw, schema = PREFERENCES_SCHEMA) {
  const preferences = buildDefaultPreferences(schema)
  const migrated = []
  const droppedUnknown = []
  const missing = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { preferences, existed: false, migrated, droppedUnknown, missing: Object.keys(schema) }
  }
  for (const [key, value] of Object.entries(raw)) {
    const field = schema[key]
    if (field === undefined) { droppedUnknown.push(key); continue }
    let next = value
    if (typeof field.migrate === 'function') {
      next = field.migrate(value)
      if (next === undefined) { migrated.push(key); continue }
    }
    const coerced = coerceField(field, next)
    if (coerced === undefined) { migrated.push(key); continue }
    preferences[key] = coerced
    if (coerced !== value) migrated.push(key)
  }
  for (const key of Object.keys(schema)) {
    if (!(key in raw)) missing.push(key)
  }
  return { preferences, existed: true, migrated, droppedUnknown, missing }
}

export class PreferencesStore {
  /**
   * @param {{mirrorRoot: string, logger?: {warn?: Function},
   *   schema?: Record<string, NumberField|EnumField|BooleanField>}} options
   */
  constructor(options) {
    this.mirrorRoot = String(options?.mirrorRoot ?? '')
    if (this.mirrorRoot.length === 0) throw new Error('PreferencesStore: mirrorRoot required')
    this.logger = options.logger ?? {}
    this.schema = options.schema ?? PREFERENCES_SCHEMA
    this.current = buildDefaultPreferences(this.schema)
    this.loaded = false
  }

  filePath() {
    return path.join(this.mirrorRoot, 'preferences.json')
  }

  /** 读取并规范偏好；缺失/迁移时写回；损坏文件保持原样（保留证据）。 */
  load() {
    this.loaded = true
    const file = this.filePath()
    const existed = fs.existsSync(file)
    let raw = null
    let corrupt = false
    if (existed) {
      try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { corrupt = true }
    }
    const report = normalizePreferences(raw, this.schema)
    this.current = report.preferences
    if (corrupt) {
      this.logger.warn?.('[preferences] corrupt preferences.json; using defaults without overwrite')
      return this.get()
    }
    const shouldPersist = !existed || report.migrated.length > 0
      || report.droppedUnknown.length > 0 || report.missing.length > 0
    if (shouldPersist) this.persist()
    if (report.migrated.length > 0 || report.droppedUnknown.length > 0) {
      this.logger.warn?.('[preferences] normalized', {
        migrated: report.migrated, droppedUnknown: report.droppedUnknown,
      })
    }
    return this.get()
  }

  /** 最近一次 load 的迁移报告（供诊断/测试）。 */
  lastReport() {
    return { migrated: [], droppedUnknown: [], existed: true }
  }

  get() {
    return { ...this.current }
  }

  /**
   * 增量更新：按 schema 校验，非法值抛错且不改内存状态；未知字段忽略。
   * @param {Record<string, unknown>} patch
   */
  update(patch = {}) {
    const next = { ...this.current }
    for (const [key, value] of Object.entries(patch ?? {})) {
      const field = this.schema[key]
      if (field === undefined) continue
      const coerced = coerceField(field, value)
      if (coerced === undefined) {
        throw new RangeError(`invalid value for ${key}: ${JSON.stringify(value)}`)
      }
      next[key] = coerced
    }
    this.current = next
    this.persist()
    return this.get()
  }

  persist() {
    ensureDir(this.mirrorRoot)
    writeJsonAtomic(this.filePath(), this.get())
  }
}
