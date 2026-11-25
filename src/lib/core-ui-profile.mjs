// SPDX-License-Identifier: AGPL-3.0-or-later
// One-shot repair for a profile whose cordis.patch.yml still says
// `ui-theme disabled: true`. The orchestrator also self-heals on every runtime
// start, but this file-level helper is for a stopped runtime/profile.
import fs from 'node:fs'
import path from 'node:path'

import { parsePatchEntries, serializePatchEntries } from './essence.mjs'
import { enforceCoreUiEntries, findDisabledCoreUiEntries } from './core-ui-plugins.mjs'

/**
 * @param {string} patchFile
 * @param {{apply?: boolean, now?: Date}} [options]
 * @returns {{ok: boolean, file: string, forced: number, changed: boolean, backup?: string, disabled?: number, error?: string}}
 */
export function repairCoreUiPatchFile(patchFile, options = {}) {
  const file = path.resolve(String(patchFile ?? ''))
  try {
    if (!fs.existsSync(file)) return { ok: false, file, forced: 0, changed: false, error: 'patch-file-missing' }
    const text = fs.readFileSync(file, 'utf8')
    const parsed = parsePatchEntries(text)
    if (parsed.errors?.length) return { ok: false, file, forced: 0, changed: false, error: `patch-parse-failed:${parsed.errors[0]}` }
    const before = findDisabledCoreUiEntries(parsed.entries).length
    const out = enforceCoreUiEntries(parsed.entries)
    if (out.forced === 0) return { ok: true, file, forced: 0, changed: false, disabled: before }
    if (options.apply !== true) return { ok: true, file, forced: out.forced, changed: false, disabled: before, preview: true }
    const stamp = (options.now instanceof Date ? options.now : new Date()).toISOString().replace(/[:.]/g, '-')
    const backup = `${file}.bak-${stamp}`
    fs.copyFileSync(file, backup)
    fs.writeFileSync(file, serializePatchEntries(out.entries), 'utf8')
    return { ok: true, file, forced: out.forced, changed: true, disabled: 0, backup }
  } catch (error) {
    return { ok: false, file, forced: 0, changed: false, error: String(error?.message ?? error) }
  }
}
