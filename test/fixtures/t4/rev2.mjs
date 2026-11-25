// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T4 fixture — demo plugin revision 2.
// Byte-for-byte different from rev1.mjs, so contentHash(?rev=) differs and a *new* ESM module is imported.
const MARKER = 'rev2'
const FILE = 'rev2.mjs'

const trace = (globalThis.__fangT4Trace ??= [])
trace.push({ event: 'evaluate', marker: MARKER, file: FILE, url: import.meta.url })

export const name = 't4-demo'
export const marker = MARKER
export const revision = 2

export function apply(ctx, config = {}) {
  trace.push({ event: 'apply', marker: MARKER, file: FILE, pluginConfig: config })
  ctx.effect(() => {
    trace.push({ event: 'effect-registered', marker: MARKER, file: FILE })
    return () => trace.push({ event: 'disposed', marker: MARKER, file: FILE })
  })
  return { marker: MARKER, file: FILE, revision, config }
}
