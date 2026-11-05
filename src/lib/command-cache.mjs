// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang v2.6.3 — 幂等命令缓存（in-flight 合并 + completed LRU 淘汰）。
//
// 契约：docs/COMMAND-CACHE.md、docs/PROTOCOL-V3.md §6.2。
// 设计要点：
//   * 两态：running（value 是同一个 promise）/ completed（value 是结果）；
//   * 同一 commandId 并发提交 → 第二个调用等待同一个 promise，不重复执行副作用；
//   * LRU：Map 插入顺序即使用顺序；run() 命中会 touch，纯 get() 不 touch；
//   * 淘汰：只淘汰 completed，跳过 running；全是 running 时允许临时超限，
//     等 in-flight 完成后自动收敛；
//   * 失败契约：fn 返回的业务失败（CommandResult.status='rejected'）**缓存**；
//     fn 抛错（传输层/编程错误，命令可能没执行）**不缓存并移除**，允许重试重新执行；
//   * 缓存不实现超时：超时属于命令层（AbortController），缓存层只在得到最终结果后决策。
export const COMMAND_CACHE_DEFAULT_CAPACITY = 500

/**
 * @typedef {{state:'running', promise:Promise<any>|null, startedAt:number}} RunningEntry
 * @typedef {{state:'completed', result:any, completedAt:number}} CompletedEntry
 * @typedef {RunningEntry|CompletedEntry} CacheEntry
 */

/**
 * @typedef {object} CommandCacheOptions
 * @property {number} [capacity=500] 容量上限（>=1）；超限时只淘汰 completed 项
 * @property {(commandId:string, entry:CompletedEntry)=>void} [onEvict] 淘汰回调（异常被隔离）
 * @property {()=>number} [now=Date.now] 时钟注入（测试用）
 */

export class CommandCache {
  /** @param {CommandCacheOptions} [options] */
  constructor({ capacity = COMMAND_CACHE_DEFAULT_CAPACITY, onEvict = null, now = Date.now } = {}) {
    const cap = Math.floor(Number(capacity))
    if (!Number.isFinite(cap) || cap < 1) {
      throw new RangeError('command cache capacity must be an integer >= 1')
    }
    this.capacity = cap
    this.onEvict = typeof onEvict === 'function' ? onEvict : null
    this.now = typeof now === 'function' ? now : Date.now
    /** @type {Map<string, CacheEntry>} */
    this.entries = new Map()
    this.counters = { executions: 0, hits: 0, dedupHits: 0, evictions: 0, droppedOnError: 0 }
  }

  /**
   * 幂等执行：同一 commandId 至多执行一次。
   * - completed 命中 → 返回缓存结果（并 touch）；
   * - running 命中 → 返回同一个 promise（并 touch，不重复执行 fn）；
   * - 未命中 → 执行 fn，完成后写 completed；fn 抛错则移除并抛出。
   *
   * 说明：fn 必须把「业务失败」转成结果对象返回；只有「命令没有执行到」的
   * 传输层/编程错误才允许抛错（这样重试才会重新执行）。
   *
   * @param {string} commandId
   * @param {() => Promise<any>} fn
   * @returns {Promise<any>}
   */
  run(commandId, fn) {
    const id = normalizeCommandId(commandId)
    if (typeof fn !== 'function') throw new TypeError('command cache run() requires a function')

    const existing = this.entries.get(id)
    if (existing) {
      this.counters.hits += 1
      this.touch(id)
      if (existing.state === 'completed') return Promise.resolve(existing.result)
      this.counters.dedupHits += 1
      return existing.promise
    }

    /** @type {RunningEntry} */
    const entry = { state: 'running', promise: null, startedAt: this.now() }
    const promise = Promise.resolve()
      .then(() => {
        this.counters.executions += 1
        return fn()
      })
      .then(
        (result) => {
          // 只有「本次执行」仍然占着这个 commandId 时才落缓存（防御未来 running 失效语义变化）
          const current = this.entries.get(id)
          if (current === entry) {
            this.entries.set(id, { state: 'completed', result, completedAt: this.now() })
            this.evictIfNeeded()
          }
          return result
        },
        (error) => {
          const current = this.entries.get(id)
          if (current === entry) {
            this.entries.delete(id)
            this.counters.droppedOnError += 1
          }
          throw error
        },
      )

    entry.promise = promise
    this.entries.set(id, entry)
    this.evictIfNeeded()
    // 给 promise 挂一个空 handler：调用方忽略返回值时不会出现 unhandled rejection；
    // 错误仍会通过上面返回的 promise 交给调用方。
    promise.catch(() => {})
    return promise
  }

  /** 纯查询：只返回 completed 的结果，不改变 LRU 顺序。 */
  get(commandId) {
    const entry = this.entries.get(String(commandId ?? ''))
    return entry && entry.state === 'completed' ? entry.result : undefined
  }

  /** 是否已有缓存项（running 或 completed 都算）。 */
  has(commandId) {
    return this.entries.has(String(commandId ?? ''))
  }

  /** 手动失效：只对 completed 生效；running 不可失效（避免副作用重复）。 */
  invalidate(commandId) {
    const id = String(commandId ?? '')
    const entry = this.entries.get(id)
    if (!entry || entry.state !== 'completed') return false
    this.entries.delete(id)
    return true
  }

  /**
   * 清空所有 completed 项，保留 running。
   * running 的 promise 还在飞，完成后仍会落缓存（它确实已经执行过）。
   * @returns {number} 被清掉的 completed 数量
   */
  clear() {
    const completedIds = []
    for (const [id, entry] of this.entries) {
      if (entry.state === 'completed') completedIds.push(id)
    }
    for (const id of completedIds) this.entries.delete(id)
    return completedIds.length
  }

  /** 当前项数（可能暂时超过 capacity：全是 running 时）。 */
  size() {
    return this.entries.size
  }

  /** 容量与状态统计（用于诊断/测试）。 */
  stats() {
    let running = 0
    let completed = 0
    for (const entry of this.entries.values()) {
      if (entry.state === 'running') running += 1
      else completed += 1
    }
    return {
      total: this.entries.size,
      running,
      completed,
      capacity: this.capacity,
      overCapacity: Math.max(0, this.entries.size - this.capacity),
      ...this.counters,
    }
  }

  /** 把项移到 Map 末尾（最近使用）。 */
  touch(commandId) {
    const id = String(commandId ?? '')
    const entry = this.entries.get(id)
    if (!entry) return false
    this.entries.delete(id)
    this.entries.set(id, entry)
    return true
  }

  /**
   * 容量收敛：从 Map 头开始找最久未用的 completed 项淘汰。
   * running 项不可淘汰；全是 running 时直接返回（允许临时超限）。
   */
  evictIfNeeded() {
    while (this.entries.size > this.capacity) {
      let victimId = null
      for (const [id, entry] of this.entries) {
        if (entry.state === 'completed') {
          victimId = id
          break
        }
      }
      if (victimId === null) return
      const victim = this.entries.get(victimId)
      this.entries.delete(victimId)
      this.counters.evictions += 1
      if (this.onEvict) {
        try {
          this.onEvict(victimId, victim)
        } catch {
          /* 淘汰回调异常不得中断容量收敛 */
        }
      }
    }
  }
}

/** commandId 必须是非空字符串（Adapter 侧已用正则校验格式）。 */
function normalizeCommandId(commandId) {
  const id = String(commandId ?? '').trim()
  if (!id) throw new TypeError('command cache requires a non-empty commandId')
  return id
}

export const _internals = { normalizeCommandId }
