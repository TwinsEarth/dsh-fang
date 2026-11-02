// SPDX-License-Identifier: AGPL-3.0-or-later
// dsh-Fang v3.0.9 — 简单计数信号量（零依赖），用于 recomputeAll 的并发上限。
// acquire() 在无可用槽位时排队；release() 优先唤醒下一个等待者。

export class Semaphore {
  /** @param {number} limit */
  constructor(limit) {
    const value = Number(limit)
    if (!Number.isFinite(value) || value < 1) throw new RangeError('semaphore limit must be >= 1')
    this.available = Math.floor(value)
    /** @type {Array<() => void>} */
    this.waiters = []
  }

  /** @returns {Promise<void>} */
  acquire() {
    if (this.available > 0) {
      this.available -= 1
      return Promise.resolve()
    }
    return new Promise(resolve => this.waiters.push(resolve))
  }

  release() {
    const next = this.waiters.shift()
    if (next !== undefined) next()
    else this.available += 1
  }

  /** 诊断：可用槽位 + 排队数。 */
  stats() {
    return { available: this.available, waiting: this.waiters.length }
  }
}
