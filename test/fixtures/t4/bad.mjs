// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T4 fixture — a plugin whose init always throws.
// Proves the reloader returns {ok:false, phase:'init-failed'} AND never touches the previous fiber.
const trace = (globalThis.__fangT4Trace ??= [])
trace.push({ event: 'evaluate', marker: 'bad', file: 'bad.mjs' })

export const name = 't4-demo'
export const marker = 'bad'

export function apply() {
  trace.push({ event: 'apply-threw', marker: 'bad', file: 'bad.mjs' })
  throw new Error('t4-bad: init failed on purpose')
}
