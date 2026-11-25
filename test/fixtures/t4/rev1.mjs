// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T4 fixture — demo plugin revision 1 (real ESM file; hot-reloader imports it via ?rev=<sha256>).
// The marker below proves which code bytes are actually running: rev1 and rev2 differ.
const MARKER = 'rev1'
const FILE = 'rev1.mjs'

const trace = (globalThis.__fangT4Trace ??= [])
trace.push({ event: 'evaluate', marker: MARKER, file: FILE, url: import.meta.url })

export const name = 't4-demo'
export const marker = MARKER

export function apply(ctx, config = {}) {
  trace.push({ event: 'apply', marker: MARKER, file: FILE, pluginConfig: config })
  ctx.effect(() => {
    trace.push({ event: 'effect-registered', marker: MARKER, file: FILE })
    return () => trace.push({ event: 'disposed', marker: MARKER, file: FILE })
  })
  // A stable identity for assertions: same bytes => same object shape, different rev => different marker.
  return { marker: MARKER, file: FILE, config }
}
