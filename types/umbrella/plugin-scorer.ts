// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// PluginScorer（TS 参考实现）— 对应运行时 `src/lib/umbrella.mjs` 的 `assessPlugin`。
//
// 本类**不扫源码**：静态证据的唯一来源是注入的 `ScorerPort`（运行时就是 `fangScorer`
// 服务）。它只负责三件事：
//   1. 指纹缓存（入口 mtime / inline 源码 hash）—— 热更新不改版本号也能失效；
//   2. 失败往坏里判（no scorer / 无输入 / scorer 抛错 → E + degraded）；
//   3. 记住每个插件的等级，供动作评分取用。
//
// 与设计稿的差异：缓存键是「插件身份」，不是 `pluginId@version`。理由见 types/README.md。

import { LruCache } from './cache.js'
import { joinPath } from './paths.js'
import type {
  CacheStats,
  Clock,
  FingerprintPort,
  PluginAssessment,
  PluginAssessmentInput,
  PluginGrade,
  ScorerAssessment,
  ScorerPort,
} from './types.js'

const DEFAULT_CLOCK: Clock = { now: () => Date.now() }
const UNKNOWN_VERSION = '0.0.0'

export interface PluginScorerOptions {
  /** `fangScorer` 服务（缺失时一律 E + degraded）。 */
  readonly scorer: ScorerPort | null
  /** mtime / hash 端口（Node 下用 node:fs 与 node:crypto 实现）。 */
  readonly fingerprints: FingerprintPort
  readonly cacheCapacity?: number
  readonly clock?: Clock
}

interface CacheEntry {
  readonly assessment: PluginAssessment
  readonly entryFile: string | null
  readonly fingerprint: string
}

/** 任意输入 → 合法等级；认不出的按 E（失败往坏里判）。 */
export function normalizeGrade(value: unknown): PluginGrade {
  const text = String(value ?? '').trim().toUpperCase()
  return text === 'A' || text === 'B' || text === 'C' || text === 'D' || text === 'E' ? text : 'E'
}

function finiteNumber(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export class PluginScorer {
  private readonly cache: LruCache<string, CacheEntry>
  private readonly grades = new Map<string, PluginGrade>()
  private readonly scorer: ScorerPort | null
  private readonly fingerprints: FingerprintPort
  private readonly clock: Clock
  private readonly counters = { hits: 0, misses: 0, evictions: 0, invalidations: 0, pluginScans: 0 }

  constructor(options: PluginScorerOptions) {
    this.scorer = options.scorer
    this.fingerprints = options.fingerprints
    this.clock = options.clock ?? DEFAULT_CLOCK
    this.cache = new LruCache<string, CacheEntry>(
      options.cacheCapacity ?? 200,
      () => {
        this.counters.evictions += 1
      },
    )
  }

  /** 插件评分：缓存命中只做一次 fingerprint 校验，不重扫。 */
  assess(input: PluginAssessmentInput = {}): PluginAssessment {
    const started = this.clock.now()
    const key = this.keyOf(input)
    if (key === null) {
      return this.failedAssessment({
        pluginId: 'unknown',
        version: UNKNOWN_VERSION,
        reason: 'no-scoring-input',
        started,
      })
    }

    if (input.refresh !== true) {
      const hit = this.cache.peek(key)
      if (hit !== undefined) {
        if (!this.isStale(hit)) {
          this.counters.hits += 1
          this.cache.set(key, hit) // 刷新 LRU 顺序
          return { ...hit.assessment, fromCache: true }
        }
        this.cache.delete(key)
      }
    }

    this.counters.misses += 1
    this.counters.pluginScans += 1

    const scored = this.runScorer(input)
    const entryFile = this.entryFileOf(scored)
    const fingerprint = this.fingerprintOf(input, entryFile)
    const grade = normalizeGrade(scored.grade)
    const assessment: PluginAssessment = {
      pluginId: this.pluginIdOf(input),
      version: String(input.version ?? input.pkg?.['version'] ?? UNKNOWN_VERSION),
      grade,
      score: finiteNumber(scored.S, 100),
      color: typeof scored.color === 'string' ? scored.color : grade === 'A' ? 'green' : grade === 'B' ? 'blue' : grade === 'C' ? 'yellow' : 'red',
      veto: scored.veto === true,
      degraded: scored.degraded === true || isScorerFailure(scored),
      signals: (scored.signals ?? []).map((s) => ({ id: String(s.id), weight: finiteNumber(s.weight, 0) })),
      reasons: [...(scored.reasons ?? [])],
      basis: scored.basis ?? null,
      entry: scored.entry ?? null,
      dir: scored.dir ?? input.dir ?? null,
      cachedAt: started,
      fingerprint,
      durationMs: Math.max(0, this.clock.now() - started),
      fromCache: false,
    }

    this.grades.set(assessment.pluginId, assessment.grade)
    if (this.cache.has(key)) {
      this.cache.delete(key)
      this.counters.invalidations += 1
    }
    this.cache.set(key, { assessment, entryFile, fingerprint })
    return assessment
  }

  cachedGrade(pluginId: string): PluginGrade | null {
    return this.grades.get(String(pluginId)) ?? null
  }

  cacheStats(): CacheStats {
    return {
      hits: this.counters.hits,
      misses: this.counters.misses,
      evictions: this.counters.evictions,
      invalidations: this.counters.invalidations,
      pluginScans: this.counters.pluginScans,
      size: this.cache.size,
      capacity: this.cache.limit,
    }
  }

  /** 按 pluginId 或缓存键（`id:` / `dir:` / `src:` 前缀）失效，返回删掉的条目数。 */
  invalidate(keyOrPluginId: string): number {
    const text = String(keyOrPluginId ?? '')
    let removed = 0
    for (const key of [...this.cache.keys()]) {
      if (key === text || key.endsWith(`:${text}`)) {
        this.cache.delete(key)
        removed += 1
      }
    }
    if (this.grades.delete(text)) removed += 1
    this.counters.invalidations += removed
    return removed
  }

  clear(): number {
    const size = this.cache.size
    this.cache.clear()
    this.grades.clear()
    this.counters.invalidations += size
    return size
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private keyOf(input: PluginAssessmentInput): string | null {
    if (typeof input.pluginId === 'string' && input.pluginId.length > 0) return `id:${input.pluginId}`
    if (typeof input.dir === 'string' && input.dir.length > 0) return `dir:${input.dir}`
    if (typeof input.source === 'string') return `src:${this.fingerprints.hash(input.source)}`
    return null
  }

  private pluginIdOf(input: PluginAssessmentInput): string {
    if (typeof input.pluginId === 'string' && input.pluginId.length > 0) return input.pluginId
    if (typeof input.dir === 'string' && input.dir.length > 0) {
      const parts = input.dir.replace(/\\/g, '/').split('/').filter((p) => p.length > 0)
      return parts.length > 0 ? String(parts[parts.length - 1]) : input.dir
    }
    return 'inline'
  }

  private entryFileOf(scored: ScorerAssessment): string | null {
    if (typeof scored.dir !== 'string' || scored.dir.length === 0) return null
    if (typeof scored.entry !== 'string' || scored.entry.length === 0) return null
    return joinPath(scored.dir, scored.entry)
  }

  private fingerprintOf(input: PluginAssessmentInput, entryFile: string | null): string {
    if (entryFile !== null) {
      return this.fingerprints.fileMtime(entryFile) ?? 'missing-entry'
    }
    return this.fingerprints.hash(String(input.source ?? ''))
  }

  /** 入口文件 mtime 变了就算 stale；没有入口文件（inline 源码）时键里已含 hash。 */
  private isStale(entry: CacheEntry): boolean {
    if (entry.entryFile === null) return false
    const current = this.fingerprints.fileMtime(entry.entryFile)
    if (current === null) return true
    return current !== entry.fingerprint
  }

  private runScorer(input: PluginAssessmentInput): ScorerAssessment {
    const scorer = this.scorer
    if (scorer === null) return failure('scorer-unavailable')
    const opts = { environment: String(input.environment ?? 'mother') }
    try {
      if (typeof input.source === 'string' && scorer.scoreSource !== undefined) {
        return scorer.scoreSource(input.source, input.pkg ?? {}, opts) ?? failure('scorer-empty-result')
      }
      if (typeof input.dir === 'string' && scorer.scoreDir !== undefined) {
        return scorer.scoreDir(input.dir, input.manifest ?? null, opts) ?? failure('scorer-empty-result')
      }
      return failure('no-scoring-input')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return failure(`scorer-error:${message}`)
    }
  }

  private failedAssessment(args: {
    readonly pluginId: string
    readonly version: string
    readonly reason: string
    readonly started: number
  }): PluginAssessment {
    return {
      pluginId: args.pluginId,
      version: args.version,
      grade: 'E',
      score: 100,
      color: 'red',
      veto: false,
      degraded: true,
      signals: [],
      reasons: [args.reason],
      basis: null,
      entry: null,
      dir: null,
      cachedAt: args.started,
      fingerprint: null,
      durationMs: Math.max(0, this.clock.now() - args.started),
      fromCache: false,
    }
  }
}

function failure(reason: string): ScorerAssessment {
  return {
    grade: 'E',
    S: 100,
    color: 'red',
    veto: false,
    degraded: true,
    signals: [],
    reasons: [reason],
    basis: null,
  }
}

function isScorerFailure(scored: ScorerAssessment): boolean {
  const reasons = scored.reasons ?? []
  return reasons.some((r) => typeof r === 'string' && r.startsWith('scorer-'))
}
