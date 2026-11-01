// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T4 fixture — a plugin that leaks ref'd handles (two setInterval) during init.
// The health window samples process.getActiveResourcesInfo(): +2 Timeout trips a window configured
// with healthMaxNewHandles=1 (tolerating one unit of environment noise), so the new fiber must be
// disposed (cleanup below) while the old fiber is never touched.
const trace = (globalThis.__fangT4Trace ??= [])
trace.push({ event: 'evaluate', marker: 'leak', file: 'leak.mjs' })

export const name = 't4-demo'
export const marker = 'leak'

export function apply(ctx) {
  trace.push({ event: 'apply', marker: 'leak', file: 'leak.mjs' })
  const leaks = (globalThis.__fangT4Leaks ??= [])
  const timers = [
    setInterval(() => {}, 25),
    setInterval(() => {}, 35),
  ] // intentionally ref'd: visible to process.getActiveResourcesInfo() and keep the process awake
  leaks.push(...timers)
  ctx.effect(() => {
    trace.push({ event: 'effect-registered', marker: 'leak', file: 'leak.mjs' })
    return () => {
      for (const t of timers) clearInterval(t)
      for (const t of timers) {
        const i = leaks.indexOf(t)
        if (i >= 0) leaks.splice(i, 1)
      }
      trace.push({ event: 'disposed', marker: 'leak', file: 'leak.mjs' })
    }
  })
  return { marker: 'leak', timers }
}
