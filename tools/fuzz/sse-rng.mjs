// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// 可复现的种子随机数：SplitMix32 初始化 + XorShift128 生成。
// 同一 seed → 同一序列；崩溃报告只需 seed + iteration 即可重放。

export class SplitMix32 {
  /** @param {number} seed */
  constructor(seed) {
    this.state = Number(seed) >>> 0
  }

  /** @returns {number} uint32 */
  next() {
    this.state = (this.state + 0x9e3779b9) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad)
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97)
    return (t ^ (t >>> 15)) >>> 0
  }
}

export class XorShift128 {
  /** @param {number} seed */
  constructor(seed) {
    const sm = new SplitMix32(seed)
    this.x = sm.next()
    this.y = sm.next()
    this.z = sm.next()
    this.w = sm.next()
    if ((this.x | this.y | this.z | this.w) === 0) this.x = 0x9e3779b9
  }

  /** @returns {number} uint32 */
  next() {
    const t = this.x ^ (this.x << 11)
    this.x = this.y
    this.y = this.z
    this.z = this.w
    this.w = (this.w ^ (this.w >>> 19)) ^ (t ^ (t >>> 8))
    return this.w >>> 0
  }

  /** @param {number} maxExclusive @returns {number} */
  int(maxExclusive) {
    if (!(maxExclusive > 0)) return 0
    return this.next() % maxExclusive
  }

  /** @returns {number} [0,1) */
  float() {
    return this.next() / 0x100000000
  }

  /** @param {number} [p] @returns {boolean} */
  bool(p = 0.5) {
    return this.float() < p
  }

  /** @template T @param {readonly T[]} arr @returns {T} */
  pick(arr) {
    return arr[this.int(arr.length)]
  }
}
