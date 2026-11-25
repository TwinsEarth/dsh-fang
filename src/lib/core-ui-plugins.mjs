// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// Boot-critical DSH client UI rows. `ui-theme` is a required service; if its
// patch row says `disabled: true`, layout/sidebar/chat never activate and the
// whole web boot ends with "required entries did not activate". No profile
// merge path is allowed to preserve that kill switch.

export const CORE_UI_PLUGIN_NAMES = Object.freeze([
  '@deepseek-ai/dsh-client-ui-theme',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-chat',
])

const CORE_UI_RE = /^(@deepseek-ai|@twinsearth)\/dsh-client-ui-(theme|layout|sidebar|chat)$/

export function isCoreUiPluginName(name) {
  return CORE_UI_RE.test(String(name ?? '').trim())
}

function isDisabled(value) {
  return value === true || String(value ?? '').trim().toLowerCase() === 'true'
}

/**
 * Force boot-critical UI rows back to enabled while preserving their config.
 * A stale `disabled: true` in an official overlay or a fork's source patch is
 * not a user preference; it is a boot failure.
 *
 * @param {Array<Record<string, unknown>>} entries
 * @returns {{entries: Array<Record<string, unknown>>, forced: number}}
 */
export function enforceCoreUiEntries(entries) {
  const rows = Array.isArray(entries) ? entries : []
  let forced = 0
  const out = rows.map((entry) => {
    if (!isCoreUiPluginName(entry?.name)) return entry
    if (!isDisabled(entry?.disabled)) return entry
    forced += 1
    return { ...entry, disabled: false }
  })
  return { entries: out, forced }
}

/** List rows that are still disabled and would break the next web boot. */
export function findDisabledCoreUiEntries(entries) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => (
    isCoreUiPluginName(entry?.name) && isDisabled(entry?.disabled)
  ))
}
