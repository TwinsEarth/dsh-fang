// SPDX-License-Identifier: AGPL-3.0-or-later
// Remove macOS AppleDouble / Finder sidecars from the package locale directory.
// DSH scans every *.json in <package>/locale and rejects names that are not a
// language id, so a stale `._en.json` would make the whole plugin metadata invalid.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function cleanLocaleSidecars(localeDir) {
  if (!fs.existsSync(localeDir)) return []
  const removed = []
  for (const entry of fs.readdirSync(localeDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (entry.name === '.DS_Store' || entry.name.startsWith('._')) {
      fs.rmSync(path.join(localeDir, entry.name), { force: true })
      removed.push(entry.name)
    }
  }
  return removed
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const localeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../locale')
  for (const name of cleanLocaleSidecars(localeDir)) console.log(`removed locale sidecar: ${name}`)
}
