// SPDX-License-Identifier: AGPL-3.0-or-later
// dsh-Fang v3.1.0 — 用户交互 poke（框架无关）。
//
// 消费者（如打开的镜像设置对话框）在挂载时调用 installInteractionPoke(store, {target})，
// 鼠标/键盘/滚动/触摸等轻量交互会节流触发 store.pokeActive()，让 store 保持高频档；
// 30s 无交互后 store 自动降回 idle 间隔。
// 不监听 click：点击路径本身会调用 refresh/acquireActive，无需额外 poke。

export const INTERACTION_EVENTS = Object.freeze([
  'mousemove', 'mousedown', 'wheel', 'scroll', 'keydown', 'touchstart',
])

/**
 * @param {{pokeActive: Function}} store
 * @param {{target?: EventTarget|null, throttleMs?: number, now?: () => number,
 *   timers?: {setTimeout: Function, clearTimeout: Function}}} [options]
 * @returns {() => void} dispose
 */
export function installInteractionPoke(store, options = {}) {
  const target = options.target ?? (typeof window !== 'undefined' ? window : null)
  if (target === null || target === undefined || typeof target.addEventListener !== 'function') {
    return () => {}
  }
  const throttleMs = Math.max(0, Number(options.throttleMs) || 1_000)
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const timers = options.timers ?? { setTimeout, clearTimeout }
  let lastPokeAt = 0
  let trailing = null
  let disposed = false

  const fire = () => {
    if (disposed) return
    lastPokeAt = now()
    store.pokeActive()
  }

  const onEvent = () => {
    if (disposed) return
    const elapsed = now() - lastPokeAt
    if (elapsed >= throttleMs) { fire(); return }
    if (trailing !== null) return
    trailing = timers.setTimeout(() => {
      trailing = null
      fire()
    }, throttleMs - elapsed)
    trailing?.unref?.()
  }

  for (const eventName of INTERACTION_EVENTS) target.addEventListener(eventName, onEvent, { passive: true })

  return () => {
    disposed = true
    for (const eventName of INTERACTION_EVENTS) {
      try { target.removeEventListener(eventName, onEvent) } catch { /* 已移除 */ }
    }
    if (trailing !== null) {
      timers.clearTimeout(trailing)
      trailing = null
    }
  }
}
