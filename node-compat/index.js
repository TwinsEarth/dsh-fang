// SPDX-License-Identifier: AGPL-3.0-or-later
// First bundle in the profile: make globalThis.fetch a data property before any
// experimental bundle (notably experimental-inspector) observes it.
export const name = 'fang-node-compat'

export function apply() {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
    if (!descriptor || typeof descriptor.get !== 'function') return
    if (descriptor.configurable !== true) return
    const value = descriptor.get.call(globalThis)
    Object.defineProperty(globalThis, 'fetch', {
      value,
      writable: true,
      configurable: true,
      enumerable: descriptor.enumerable === true,
    })
  } catch { /* compatibility must never block boot */ }
}
