// SPDX-License-Identifier: AGPL-3.0-or-later
// src/lib/node-compat.mjs — Node/Electron 宿主兼容垫片。
//
// 2026-11-22：DSH experimental-inspector 在 Node 26 上报
//   "inspector: globalThis.fetch is an accessor and cannot be observed safely"
// Node 的 fetch 是 accessor；inspector 用属性观察方式包裹它时拒绝。把 fetch 归一成
// 数据属性（value=原 getter 绑定），不改变行为，只让观察者可以安全包装。
export function normalizeFetchDescriptor(target = globalThis) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, 'fetch')
    if (!descriptor || typeof descriptor.get !== 'function') return { ok: true, changed: false }
    if (descriptor.configurable !== true) return { ok: false, changed: false, error: 'fetch-not-configurable' }
    const value = descriptor.get.call(target)
    Object.defineProperty(target, 'fetch', {
      value,
      writable: true,
      configurable: true,
      enumerable: descriptor.enumerable === true,
    })
    return { ok: true, changed: true }
  } catch (error) {
    return { ok: false, changed: false, error: String(error?.message ?? error) }
  }
}
