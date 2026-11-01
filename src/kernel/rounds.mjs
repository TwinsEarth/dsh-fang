// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang kernel — round (hot-update transaction) core.
// Zero node dependencies: every filesystem call comes through an injected fsApi,
// so the same logic runs under node:fs in the host and under a memory FS in a browser.
//
// fsApi contract (node:fs compatible subset):
//   readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, copyFileSync,
//   unlinkSync, existsSync

const SKIP_NAMES = new Set(['changes.json', '.age.json', '.rounds'])

function hashHex(bytes) {
  const data = typeof bytes === 'string' ? bytes : bufferLikeToString(bytes)
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i) & 0xff
    h1 = (h1 ^ c) * 16777619 >>> 0
    h2 = (h2 + c * (i + 1)) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

function bufferLikeToString(b) {
  if (b == null) return ''
  if (typeof b === 'string') return b
  if (typeof b.toString === 'function') {
    const s = b.toString('utf8')
    if (typeof s === 'string' && !/^\[object/.test(s)) return s
  }
  if (b instanceof Uint8Array) return Array.from(b).map(x => String.fromCharCode(x)).join('')
  return String(b)
}

export function createRounds(fsApi) {
  const fs = fsApi
  const join = (...parts) => parts.filter(p => p != null && p !== '').join('/').replace(/\/+/g, '/')
  const parentOf = (p) => { const i = p.lastIndexOf('/'); return i > 0 ? p.slice(0, i) : '.' }
  const roundsDirOf = (stagingDir, name) => stagingDir + '/' + name + '/.rounds'

  const fileDigests = (dir) => {
    const out = {}
    const walk = (d, rel = '') => {
      let names = []
      try { names = fs.readdirSync(d) ?? [] } catch { return }
      for (const n of names) {
        const r = rel ? rel + '/' + n : n
        if (SKIP_NAMES.has(r) || SKIP_NAMES.has(n)) continue
        const p = d + '/' + n
        let st
        try { st = fs.statSync(p) } catch { continue }
        if (st && typeof st.isDirectory === 'function' && st.isDirectory()) { walk(p, r); continue }
        try { out[r] = hashHex(fs.readFileSync(p)) } catch { /* unreadable: skip */ }
      }
    }
    walk(dir)
    return out
  }

  const copyTreeInto = (srcDir, dstDir) => {
    try { fs.mkdirSync(dstDir, { recursive: true }) } catch { /* ignore */ }
    let names = []
    try { names = fs.readdirSync(srcDir) ?? [] } catch { return }
    for (const n of names) {
      if (SKIP_NAMES.has(n)) continue
      const p = srcDir + '/' + n
      let st
      try { st = fs.statSync(p) } catch { continue }
      if (st && typeof st.isDirectory === 'function' && st.isDirectory()) { copyTreeInto(p, dstDir + '/' + n); continue }
      try {
        fs.mkdirSync(parentOf(dstDir + '/' + n), { recursive: true })
        fs.copyFileSync(p, dstDir + '/' + n)
      } catch { /* ignore */ }
    }
  }

  const beginRound = ({ stagingDir, name, note = '', now = () => new Date().toISOString() }) => {
    const stageDir = stagingDir + '/' + name
    if (!fs.existsSync(stageDir)) return { ok: false, phase: 'not-in-staging' }
    const roundId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
    const dir = roundsDirOf(stagingDir, name) + '/' + roundId
    const preDir = dir + '/pre'
    try { copyTreeInto(stageDir, preDir) } catch (e) {
      return { ok: false, phase: 'copy-failed', error: String(e?.message ?? e) }
    }
    const manifest = { roundId, name, note: String(note ?? ''), at: now(), files: fileDigests(preDir) }
    try { fs.writeFileSync(dir + '/manifest.json', JSON.stringify(manifest, null, 2)) } catch { /* ignore */ }
    return { ok: true, phase: 'round-open', roundId, files: Object.keys(manifest.files).length }
  }

  const listRounds = ({ stagingDir, name }) => {
    let ids = []
    try { ids = fs.readdirSync(roundsDirOf(stagingDir, name)) ?? [] } catch { return [] }
    const out = []
    for (const id of ids) {
      const dir = roundsDirOf(stagingDir, name) + '/' + id
      let m = null
      try { m = JSON.parse(bufferLikeToString(fs.readFileSync(dir + '/manifest.json'))) } catch { /* ignore */ }
      if (m) out.push({ ...m, dir })
    }
    return out.sort((a, b) => (a.at < b.at ? 1 : -1))
  }

  const resetRound = ({ stagingDir, name, roundId } = {}) => {
    const errors = []
    const safeCopy = (src, dst) => {
      try {
        if (!fs.existsSync(src)) { errors.push({ src, error: 'missing-source' }); return false }
        fs.mkdirSync(parentOf(dst), { recursive: true })
        fs.copyFileSync(src, dst)
        return true
      } catch (e) { errors.push({ src, error: String(e?.message ?? e) }); return false }
    }
    const safeUnlink = (p) => {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); return true } catch (e) {
        errors.push({ path: p, error: String(e?.message ?? e) }); return false
      }
    }
    try {
      const rounds = listRounds({ stagingDir, name })
      if (!rounds.length) return { ok: false, phase: 'no-rounds', touched: [], errors }
      const target = roundId ? rounds.find(r => r.roundId === roundId) : rounds[0]
      if (!target) return { ok: false, phase: 'round-not-found', available: rounds.map(r => r.roundId), touched: [], errors }

      const stageDir = stagingDir + '/' + name
      const preDir = target.dir + '/pre'
      const pre = fileDigests(preDir)
      const cur = fileDigests(stageDir)

      if (Object.keys(pre).length === 0 && Object.keys(cur).length > 0) {
        return {
          ok: false, phase: 'round-corrupt', roundId: target.roundId,
          manifestFiles: Object.keys(target.files ?? {}).length,
          currentFiles: Object.keys(cur).length, touched: [], errors,
        }
      }

      const manifest = target.files && typeof target.files === 'object' ? target.files : null
      const inManifest = (p) => !!manifest && Object.prototype.hasOwnProperty.call(manifest, p)
      const touched = []

      for (const [p, d] of Object.entries(cur)) {
        if (pre[p] === d) continue
        if (inManifest(p)) {
          if (pre[p] !== undefined) {
            if (safeCopy(preDir + '/' + p, stageDir + '/' + p)) touched.push({ path: p, action: 'restored' })
          } else {
            errors.push({ path: p, error: 'pre-image-missing' })
            touched.push({ path: p, action: 'kept-missing-preimage' })
          }
        } else if (pre[p] !== undefined) {
          if (safeCopy(preDir + '/' + p, stageDir + '/' + p)) touched.push({ path: p, action: 'restored' })
        } else {
          if (safeUnlink(stageDir + '/' + p)) touched.push({ path: p, action: 'removed' })
        }
      }
      for (const p of Object.keys(pre)) {
        if (cur[p] !== undefined) continue
        if (safeCopy(preDir + '/' + p, stageDir + '/' + p)) touched.push({ path: p, action: 'recovered' })
      }
      const after = fileDigests(stageDir)
      const clean = Object.keys(pre).length === Object.keys(after).length &&
        Object.entries(pre).every(([k, v]) => after[k] === v)
      return { ok: errors.length === 0, phase: 'reset', roundId: target.roundId, touched, clean, errors }
    } catch (e) {
      return { ok: false, phase: 'threw', error: String(e?.message ?? e), touched: [], errors }
    }
  }

  return { fileDigests, copyTreeInto, beginRound, listRounds, resetRound, roundsDirOf, join }
}
