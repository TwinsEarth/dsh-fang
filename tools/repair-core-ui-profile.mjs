#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Repair a stopped DSH profile's `ui-theme disabled: true` rows.
//
// Dry run (default):
//   node tools/repair-core-ui-profile.mjs --profile C:\...\essence-runtime
// Apply (writes a .bak-<ts> next to the patch):
//   node tools/repair-core-ui-profile.mjs --profile C:\...\essence-runtime --apply
//
// Stop the runtime/host before apply; DSH keeps the profile open while booted.
import fs from 'node:fs'
import path from 'node:path'

import { repairCoreUiPatchFile } from '../src/lib/core-ui-profile.mjs'

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name)
  return index >= 0 ? String(process.argv[index + 1] ?? fallback) : fallback
}

const profile = arg('--profile')
const fileArg = arg('--file')
const apply = process.argv.includes('--apply')
const patchFile = fileArg || (profile ? path.join(profile, 'cordis.patch.yml') : '')
if (!patchFile) {
  console.error('usage: node tools/repair-core-ui-profile.mjs --profile <dir> [--apply]')
  process.exit(2)
}
if (!fs.existsSync(patchFile)) {
  console.error(`missing patch: ${patchFile}`)
  process.exit(2)
}
const out = repairCoreUiPatchFile(patchFile, { apply })
console.log(JSON.stringify(out, null, 2))
if (out.ok !== true) process.exit(1)
if (out.forced > 0 && !apply) {
  console.log('dry-run: re-run with --apply after stopping the runtime/host')
}
