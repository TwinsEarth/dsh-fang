// SPDX-License-Identifier: AGPL-3.0-or-later
// Remove macOS AppleDouble / Finder sidecars from the whole plugin tree.
// They are metadata forks, never part of the plugin. `npm pack` must not ship
// them, and an already-installed copy may still contain leftovers from a
// macOS-generated tarball; postinstall cleans both cases.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn'])

function isSidecar(name) {
  return name === '.DS_Store' || name.startsWith('._')
}

/**
 * Recursively remove AppleDouble sidecars under `rootDir`.
 * Symlinks are never followed or removed; only regular files inside the root
 * are touched. Returns the removed paths relative to `rootDir`.
 */
export function cleanAppleDouble(rootDir) {
  const root = path.resolve(rootDir)
  if (!fs.existsSync(root)) return []
  const removed = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full)
        continue
      }
      if (!entry.isFile() || !isSidecar(entry.name)) continue
      try {
        fs.rmSync(full, { force: true })
        removed.push(path.relative(root, full))
      } catch {
        // Best effort: a locked sidecar must not fail the install.
      }
    }
  }
  walk(root)
  return removed
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const removed = cleanAppleDouble(packageRoot)
  for (const name of removed) console.log(`removed AppleDouble sidecar: ${name}`)
  console.log(`cleaned ${removed.length} AppleDouble sidecar(s)`)
}
