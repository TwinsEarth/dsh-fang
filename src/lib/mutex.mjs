// SPDX-License-Identifier: AGPL-3.0-or-later
// dsh-Fang v2.12.0 — per-key 串行锁（零依赖）。
// 用途：同一原身的 ensureFresh/重算串行化；不同 key 互不阻塞。
// 失败不阻断链：then(fn, fn) 保证前一个任务 reject 后下一个仍执行。

export class KeyedMutex {
  constructor() {
    /** @type {Map<string, Promise<unknown>>} */
    this.chains = new Map()
  }

  /**
   * @template T
   * @param {string} key
   * @param {() => (T|Promise<T>)} fn
   * @returns {Promise<T>}
   */
  run(key, fn) {
    const previous = this.chains.get(key) ?? Promise.resolve()
    const next = previous.then(fn, fn).finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key)
    })
    this.chains.set(key, next)
    return next
  }

  /** 当前是否还有排队/执行中的 key（诊断用）。 */
  size() {
    return this.chains.size
  }
}
