// SPDX-License-Identifier: AGPL-3.0-or-later
// Close-reason taxonomy for the managed browser. The raw reason stays in the
// audit/log; the kind is the stable value the UI and crash reader can group by.

export const CLOSE_REASON_KINDS = Object.freeze([
  'user',
  'idle',
  'capacity',
  'host-memory',
  'host-panic',
  'browser-oom',
  'browser-heap',
  'dom-limit',
  'crash-loop',
])

export function classifyCloseReason(reason) {
  const raw = String(reason ?? '').trim().toLowerCase()
  // Host Commit pressure must be classified before the generic browser
  // "memory-limit" pattern: `host-commit-low-browser-memory-limit` contains
  // both "host-commit" and "memory-limit", but the browser itself is not over
  // its own ceiling. v3.10.0 and earlier collapsed this into browser-oom, so
  // the task card falsely said "内存保护关闭" when only the host was low.
  if (/^host-panic|host-panic/.test(raw)) return 'host-panic'
  if (/host-commit|commit-free|host-emergency/.test(raw)) return 'host-memory'
  if (/crash-loop/.test(raw)) return 'crash-loop'
  if (/max-open-fork-browsers|capacity|quota/.test(raw)) return 'capacity'
  if (/dom|node-limit|dom-limit/.test(raw)) return 'dom-limit'
  if (/heap-limit/.test(raw)) return 'browser-heap'
  if (/oom|memory-limit|memory-guard/.test(raw)) return 'browser-oom'
  if (/idle/.test(raw)) return 'idle'
  return 'user'
}
