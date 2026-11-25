// SPDX-License-Identifier: AGPL-3.0-or-later
// Close-reason taxonomy for the managed browser. The raw reason stays in the
// audit/log; the kind is the stable value the UI and crash reader can group by.

export const CLOSE_REASON_KINDS = Object.freeze([
  'user',
  'idle',
  'browser-oom',
  'dom-limit',
  'host-panic',
  'crash-loop',
])

export function classifyCloseReason(reason) {
  const raw = String(reason ?? '').trim().toLowerCase()
  if (/^host-panic|host-panic/.test(raw)) return 'host-panic'
  if (/crash-loop/.test(raw)) return 'crash-loop'
  if (/dom|node-limit|dom-limit/.test(raw)) return 'dom-limit'
  if (/oom|heap-limit|memory-limit|memory-guard/.test(raw)) return 'browser-oom'
  if (/idle/.test(raw)) return 'idle'
  return 'user'
}
