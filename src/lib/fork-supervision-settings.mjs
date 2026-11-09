// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// fork-supervision-settings — 分身看护的持久化开关（UI 与 watchdog 共用）。
//   <dataDir>/fork-supervision.json
//   { version:1, autostartForks:boolean, supervise:boolean, updatedAt:number }
//
// autostartForks：watchdog 启动时是否请求 /api/forks/autostart
// supervise     ：forker 是否在分身崩溃后按退避重启（运行时可切换）
import fs from 'node:fs'
import path from 'node:path'

const DEFAULTS = Object.freeze({ autostartForks: true, supervise: false })
const FILE_NAME = 'fork-supervision.json'

export function supervisionSettingsFile(dataDir) {
  return path.join(String(dataDir ?? ''), FILE_NAME)
}

function normalize(raw) {
  return {
    version: 1,
    autostartForks: typeof raw?.autostartForks === 'boolean' ? raw.autostartForks : DEFAULTS.autostartForks,
    supervise: typeof raw?.supervise === 'boolean' ? raw.supervise : DEFAULTS.supervise,
    updatedAt: Number.isFinite(Number(raw?.updatedAt)) ? Number(raw.updatedAt) : 0,
  }
}

export function readForkSupervisionSettings(dataDir) {
  const file = supervisionSettingsFile(dataDir)
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { ...normalize(raw), file, exists: true }
  } catch {
    return { ...normalize(null), file, exists: false }
  }
}

export function writeForkSupervisionSettings(dataDir, patch = {}) {
  const dir = String(dataDir ?? '')
  if (!dir) return { ok: false, error: 'data-dir-required' }
  const current = readForkSupervisionSettings(dir)
  const next = normalize({
    autostartForks: typeof patch.autostartForks === 'boolean' ? patch.autostartForks : current.autostartForks,
    supervise: typeof patch.supervise === 'boolean' ? patch.supervise : current.supervise,
    updatedAt: Date.now(),
  })
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = supervisionSettingsFile(dir)
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true, ...next, file }
  } catch (error) {
    return { ok: false, error: 'write-failed', detail: String(error?.message ?? error) }
  }
}
