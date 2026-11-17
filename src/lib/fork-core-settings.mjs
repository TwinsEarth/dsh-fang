// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// Fork core settings (P1): the mother panel switch that decides which DSH core a
// newly provisioned/restarted FORK runs on. Host and essence never read this.
//
// File: <dataDir>/fork-core.json
//   { "mode": "stock" | "accelerated",
//     "sessionMode": "new" | "inherit",
//     "updatedAt": ISO, "updatedBy": string }
import fs from 'node:fs'
import path from 'node:path'
import { readJson, writeJsonAtomic } from '../kernel/index.mjs'

export const FORK_CORE_FILE = 'fork-core.json'
export const FORK_CORE_MODES = Object.freeze(['stock', 'accelerated'])
export const FORK_SESSION_MODES = Object.freeze(['new', 'inherit'])
export const DEFAULT_FORK_CORE = Object.freeze({ mode: 'stock', sessionMode: 'new' })

/** Normalise one mode value; unknown input falls back to the safe default. */
export function normalizeForkCoreMode(value) {
  const text = String(value ?? '').trim()
  return FORK_CORE_MODES.includes(text) ? text : DEFAULT_FORK_CORE.mode
}

/** Normalise the session policy; `new` is the safe default for accelerated forks. */
export function normalizeForkSessionMode(value) {
  const text = String(value ?? '').trim()
  return FORK_SESSION_MODES.includes(text) ? text : DEFAULT_FORK_CORE.sessionMode
}

/** Pure: coerce a persisted object (or null) into the settings shape. */
export function normalizeForkCoreSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  return {
    mode: normalizeForkCoreMode(input.mode),
    sessionMode: normalizeForkSessionMode(input.sessionMode),
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : null,
    updatedBy: typeof input.updatedBy === 'string' ? input.updatedBy : null,
  }
}

/** Read `<dataDir>/fork-core.json`; a missing/corrupt file means stock/new. */
export function readForkCoreSettings(dataDir, { readImpl = readJson } = {}) {
  const file = path.join(String(dataDir ?? ''), FORK_CORE_FILE)
  try {
    return normalizeForkCoreSettings(readImpl(file, null))
  } catch {
    return normalizeForkCoreSettings(null)
  }
}

/**
 * Persist the settings atomically (delegated to the kernel writer).
 * @returns {{ok:true, settings:object} | {ok:false, error:string}}
 */
export function writeForkCoreSettings(dataDir, patch = {}, { at = new Date().toISOString(), by = '' } = {}) {
  const dir = String(dataDir ?? '').trim()
  if (!dir) return { ok: false, error: 'no-data-dir' }
  const current = readForkCoreSettings(dir)
  const next = normalizeForkCoreSettings({
    mode: patch.mode === undefined ? current.mode : patch.mode,
    sessionMode: patch.sessionMode === undefined ? current.sessionMode : patch.sessionMode,
    updatedAt: at,
    updatedBy: String(by ?? '').slice(0, 120) || current.updatedBy,
  })
  try {
    fs.mkdirSync(dir, { recursive: true })
    writeJsonAtomic(path.join(dir, FORK_CORE_FILE), next)
    return { ok: true, settings: next }
  } catch (error) {
    return { ok: false, error: 'write-failed', detail: String(error?.message ?? error) }
  }
}
