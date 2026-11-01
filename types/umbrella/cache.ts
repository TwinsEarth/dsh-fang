// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// 通用 LRU（Map 插入序 + 命中后重插）。保护伞只缓存**插件评分**：
// 动作评分不缓存，因为 args 的语义等价性不可判定（见 types/README.md）。

export type EvictHook<K, V> = (key: K, value: V) => void

export class LruCache<K, V> {
  private readonly map = new Map<K, V>()
  private readonly capacity: number
  private readonly onEvict: EvictHook<K, V> | undefined

  constructor(capacity: number, onEvict?: EvictHook<K, V>) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`LruCache capacity must be a positive integer, got ${String(capacity)}`)
    }
    this.capacity = capacity
    this.onEvict = onEvict
  }

  get(key: K): V | undefined {
    const value = this.map.get(key)
    if (value === undefined) return undefined
    // 命中即刷新顺序
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  /** 只看不刷新（stale 检查用，避免把「已过期」也当成活跃命中）。 */
  peek(key: K): V | undefined {
    return this.map.get(key)
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next()
      if (oldest.done === true) break
      const key0 = oldest.value
      const value0 = this.map.get(key0)
      this.map.delete(key0)
      if (value0 !== undefined) this.onEvict?.(key0, value0)
    }
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  delete(key: K): boolean {
    return this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  keys(): IterableIterator<K> {
    return this.map.keys()
  }

  get size(): number {
    return this.map.size
  }

  get limit(): number {
    return this.capacity
  }
}
