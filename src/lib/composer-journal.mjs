// SPDX-License-Identifier: AGPL-3.0-or-later
// Composer journal: persist the user's unsent draft and queued-message mirror so a
// restart/crash can offer recovery. It never sends anything by itself.
import fs from 'node:fs'
import path from 'node:path'

const MAX_DRAFT = 100_000
const MAX_QUEUE = 100
const MAX_ITEM = 4_000

function cleanText(value, limit) {
  return String(value ?? '').replace(/\0/g, '').slice(0, limit)
}

export class ComposerJournal {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'composer-journal.json')
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return raw && typeof raw === 'object' ? raw : {}
    } catch { return {} }
  }

  saveFile(all) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  get(key) {
    const entry = this.load()[String(key)]
    return entry && typeof entry === 'object' ? entry : null
  }

  /** All recoverable journal entries, newest first (bounded by the same 100-session cap). */
  list() {
    const all = this.load()
    return Object.values(all)
      .filter((entry) => entry && typeof entry === 'object')
      .sort((a, b) => String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')))
  }

  save(key, input = {}) {
    const id = cleanText(key, 200)
    if (!id) throw new Error('journal-key-required')
    const queue = Array.isArray(input.queue)
      ? input.queue.slice(-MAX_QUEUE).map((item) => ({
        text: cleanText(item?.text, MAX_ITEM),
        at: Number(item?.at) || Date.now(),
      })).filter((item) => item.text.trim())
      : []
    const entry = {
      key: id,
      draft: cleanText(input.draft, MAX_DRAFT),
      queue,
      path: cleanText(input.path, 500),
      updatedAt: new Date().toISOString(),
    }
    const all = this.load()
    all[id] = entry
    // Keep the journal bounded: 100 sessions is plenty for recovery.
    const keys = Object.keys(all)
    if (keys.length > 100) {
      keys.sort((a, b) => String(all[a]?.updatedAt || '').localeCompare(String(all[b]?.updatedAt || '')))
      for (const stale of keys.slice(0, keys.length - 100)) delete all[stale]
    }
    this.saveFile(all)
    return entry
  }

  remove(key) {
    const all = this.load()
    const id = String(key)
    if (!all[id]) return false
    delete all[id]
    this.saveFile(all)
    return true
  }
}
