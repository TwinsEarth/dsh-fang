// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang kernel — ids, tiny event bus, process resource sampling, exit codes.
import { randomUUID } from 'node:crypto'

export function newId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function newUuid() {
  return randomUUID()
}

/** Deterministic, dependency-free event bus (no Node emitter semantics to leak). */
export function createBus() {
  const map = new Map()
  return {
    on(topic, fn) {
      if (typeof fn !== 'function') return () => {}
      if (!map.has(topic)) map.set(topic, new Set())
      map.get(topic).add(fn)
      return () => map.get(topic)?.delete(fn)
    },
    off(topic, fn) {
      map.get(topic)?.delete(fn)
    },
    emit(topic, payload) {
      const set = map.get(topic)
      if (!set) return 0
      let n = 0
      for (const fn of [...set]) {
        try { fn(payload); n++ } catch { /* a listener must never break the emitter */ }
      }
      return n
    },
    listenerCount(topic) {
      return map.get(topic)?.size ?? 0
    },
    clear(topic) {
      if (topic === undefined) map.clear()
      else map.delete(topic)
    },
  }
}

/**
 * Process-wide bus shared by the 1 + 9 plugins. Every module imports this from the
 * kernel, and the kernel module instance is shared inside one host process, so plugins
 * can talk without a service handshake. Topic names live in `types.mjs` (AUDIT / FORK_*).
 */
export const bus = createBus()

/** Handle/resource census used by the health window (leak detection). */
export function sampleResources() {
  const counts = {}
  try {
    for (const t of process.getActiveResourcesInfo()) counts[t] = (counts[t] ?? 0) + 1
  } catch { /* platform without the API */ }
  return counts
}

export function totalResources(counts) {
  let n = 0
  for (const v of Object.values(counts ?? {})) n += v
  return n
}

export function diffResources(before, after) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  const added = {}
  const removed = {}
  for (const k of keys) {
    const d = (after?.[k] ?? 0) - (before?.[k] ?? 0)
    if (d > 0) added[k] = d
    else if (d < 0) removed[k] = -d
  }
  return {
    added,
    removed,
    leakedRefed: Object.values(added).reduce((a, b) => a + b, 0),
    freed: Object.values(removed).reduce((a, b) => a + b, 0),
  }
}

export const EXIT = {
  OK: 0,
  ERROR: 1,
  /** "guard allowed this restart" — the fork/supervisor contract. */
  RESTART: 75,
}

export const RISK_RANK = { blue: 1, yellow: 2, red: 3 }

export function riskAtLeast(risk, bar) {
  return (RISK_RANK[risk] ?? 0) >= (RISK_RANK[bar] ?? 99)
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
