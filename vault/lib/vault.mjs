// SPDX-License-Identifier: AGPL-3.0-or-later
// Vault: curated per-fork export/import. Pure filesystem library, no Cordis/DSH imports.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const VAULT_FORMAT = 'dsh-fang-vault/v1'
export const DEFAULT_OPTIONS = Object.freeze({
  sessions: true,
  metadata: true,
  derived: true,
  collaboration: true,
  profile: true,
  lineage: true,
  logs: true,
  secrets: true,
  workspace: false,
  workspaceSnapshot: false,
})

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function copyTreeFiltered(from, to, { skip = new Set() } = {}) {
  const st = fs.lstatSync(from)
  if (st.isSymbolicLink()) {
    const target = fs.readlinkSync(from)
    try { fs.symlinkSync(target, to, 'junction') } catch { /* ignore */ }
    return { files: 1, bytes: 0 }
  }
  if (st.isDirectory()) {
    if (skip.has(path.basename(from))) return { files: 0, bytes: 0 }
    fs.mkdirSync(to, { recursive: true })
    let files = 0
    let bytes = 0
    for (const name of fs.readdirSync(from)) {
      const r = copyTreeFiltered(path.join(from, name), path.join(to, name), { skip })
      files += r.files
      bytes += r.bytes
    }
    return { files, bytes }
  }
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  return { files: 1, bytes: st.size }
}

function copyIfExists(from, to) {
  if (!fs.existsSync(from)) return { files: 0, bytes: 0 }
  return copyTreeFiltered(from, to)
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function sessionRows(homeDir) {
  const root = path.join(homeDir, 'sessions')
  const rows = []
  if (!fs.existsSync(root)) return rows
  for (const workspaceKey of fs.readdirSync(root)) {
    const dir = path.join(root, workspaceKey)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const sessionId of fs.readdirSync(dir)) {
      const log = path.join(dir, sessionId, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(log)) continue
      rows.push({ workspaceKey, sessionId, log, bytes: fs.statSync(log).size })
    }
  }
  return rows
}

export function exportVault({ homeDir, destDir, task, options = {} }) {
  const opts = { ...DEFAULT_OPTIONS, ...(options ?? {}) }
  const home = path.resolve(String(homeDir ?? ''))
  if (!fs.existsSync(path.join(home, 'profiles'))) return { ok: false, error: 'fork-home-invalid', detail: home }
  const dest = path.resolve(String(destDir ?? ''))
  fs.mkdirSync(dest, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = path.join(dest, `FangVault-${task?.taskId ?? 'fork'}-${stamp}`)
  fs.mkdirSync(path.join(root, '00_MANIFEST'), { recursive: true })
  const files = []
  const add = (name, result) => { if (result?.files) files.push({ name, ...result }) }
  const sessionIndex = []

  if (opts.sessions) {
    for (const row of sessionRows(home)) {
      const targetDir = path.join(root, '10_SESSIONS', row.sessionId)
      fs.mkdirSync(targetDir, { recursive: true })
      const target = path.join(targetDir, 'session.v4.jsonl.zstd')
      fs.copyFileSync(row.log, target)
      const meta = {
        sessionId: row.sessionId,
        workspaceKey: row.workspaceKey,
        title: '',
        bytes: row.bytes,
        sha256: sha256File(row.log),
      }
      const ws = readJson(path.join(home, 'storages', 'workspace.json'), {})
      const table = ws?.tables?.workspaces ?? {}
      for (const item of Object.values(table)) {
        if (Array.isArray(item?.sessionIds) && item.sessionIds.includes(row.sessionId)) meta.title = item.title ?? ''
      }
      if (opts.metadata) writeJson(path.join(targetDir, 'session.meta.json'), meta)
      add(`sessions/${row.sessionId}`, { files: 1, bytes: row.bytes })
      sessionIndex.push(meta)
    }
  }

  if (opts.metadata) {
    add('workspace-index', copyIfExists(path.join(home, 'storages', 'workspace.json'), path.join(root, '50_RUNTIME_DATA', 'storages', 'workspace.json')))
  }
  if (opts.derived) {
    add('derived', copyIfExists(path.join(home, 'storages'), path.join(root, '50_RUNTIME_DATA', 'storages')))
  }
  if (opts.profile) {
    add('profile', copyIfExists(path.join(home, 'profiles'), path.join(root, '40_FORK_PROFILE')))
    add('headless-patch', copyIfExists(path.join(home, 'profiles', String(task?.profile ?? ''), 'fang-headless.patch.yml'), path.join(root, '40_FORK_PROFILE', String(task?.profile ?? ''), 'fang-headless.patch.yml')))
  }
  if (opts.collaboration) {
    add('collaboration', copyIfExists(path.join(home, 'xclient'), path.join(root, '50_RUNTIME_DATA', 'xclient')))
    add('fang', copyIfExists(path.join(home, 'fang'), path.join(root, '50_RUNTIME_DATA', 'fang')))
  }
  if (opts.lineage) {
    add('attachments', copyIfExists(path.join(home, 'attachments'), path.join(root, '20_ATTACHMENTS')))
    add('fang-seeds', copyIfExists(path.join(home, 'fang-seeds'), path.join(root, '50_RUNTIME_DATA', 'fang-seeds')))
    add('fang-meta', copyIfExists(path.join(home, 'fang-meta.json'), path.join(root, '50_RUNTIME_DATA', 'fang-meta.json')))
  }
  if (opts.derived) add('llm-deepseek', copyIfExists(path.join(home, 'llm-deepseek'), path.join(root, '50_RUNTIME_DATA', 'llm-deepseek')))
  if (opts.logs) add('logs', copyIfExists(path.join(home, 'logs'), path.join(root, '60_LOGS')))
  if (opts.secrets) {
    add('credentials', copyIfExists(path.join(home, '.credentials.yaml'), path.join(root, '70_SECRETS', '.credentials.yaml')))
    add('device-key', copyIfExists(path.join(home, 'xclient', 'device.key'), path.join(root, '70_SECRETS', 'device.key')))
  }
  if (opts.workspace && opts.workspaceSnapshot && task?.workspacePath) {
    add('workspace-snapshot', copyIfExists(String(task.workspacePath), path.join(root, '30_WORKSPACES', 'snapshot')))
  }

  const manifest = {
    format: VAULT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    taskId: task?.taskId ?? '',
    title: task?.title ?? '',
    profile: task?.profile ?? '',
    coreMode: task?.coreMode ?? 'stock',
    sourceEssenceId: task?.syncSourceId ?? task?.essenceId ?? 'essence-official-dev',
    options: opts,
    sessions: sessionIndex,
    files,
  }
  writeJson(path.join(root, '00_MANIFEST', 'manifest.json'), manifest)
  const manifestBytes = fs.readFileSync(path.join(root, '00_MANIFEST', 'manifest.json'))
  fs.writeFileSync(path.join(root, '00_MANIFEST', 'checksums.sha256'), `${createHash('sha256').update(manifestBytes).digest('hex')}  manifest.json\n`)
  fs.writeFileSync(path.join(root, '00_MANIFEST', 'IMPORT-GUIDE.md'), [
    '# 瓮城 Vault 导出包',
    '',
    `- 分身：${manifest.title}（${manifest.taskId}）`,
    `- 导出时间：${manifest.exportedAt}`,
    `- 会话：${sessionIndex.length}`,
    '',
    '在母体面板分身工作区点「导入」，选择本文件夹（含 00_MANIFEST/manifest.json）。',
    '工作区项目文件默认不导出；需要时在导出对话框勾选。',
  ].join('\n'))
  return { ok: true, dir: root, files: files.reduce((n, x) => n + x.files, 0), bytes: files.reduce((n, x) => n + x.bytes, 0), manifest }
}

export function readVault(sourceDir) {
  const dir = path.resolve(String(sourceDir ?? ''))
  const manifestFile = path.join(dir, '00_MANIFEST', 'manifest.json')
  if (!fs.existsSync(manifestFile)) return { ok: false, error: 'manifest-missing', detail: manifestFile }
  const manifest = readJson(manifestFile, null)
  if (manifest?.format !== VAULT_FORMAT) return { ok: false, error: 'format-unsupported', detail: manifest?.format ?? '' }
  return { ok: true, dir, manifest }
}

export function importVault({ sourceDir, homeDir, profile }) {
  const parsed = readVault(sourceDir)
  if (!parsed.ok) return parsed
  const home = path.resolve(String(homeDir ?? ''))
  fs.mkdirSync(home, { recursive: true })
  const copy = (relative, target) => copyIfExists(path.join(parsed.dir, relative), path.join(home, target))
  const result = { ok: true, source: parsed.dir, files: 0, bytes: 0, warnings: [] }
  const merge = (r) => { result.files += r.files; result.bytes += r.bytes }
  merge(copy('10_SESSIONS', 'sessions'))
  // 导出按 sessionId 平铺；DSH 需要 sessions/<workspaceKey>/<sessionId>。
  for (const row of Array.isArray(parsed.manifest?.sessions) ? parsed.manifest.sessions : []) {
    const from = path.join(home, 'sessions', String(row.sessionId ?? ''))
    const to = path.join(home, 'sessions', String(row.workspaceKey ?? ''), String(row.sessionId ?? ''))
    if (row.sessionId && row.workspaceKey && fs.existsSync(from) && !fs.existsSync(to)) {
      fs.mkdirSync(path.dirname(to), { recursive: true })
      try { fs.renameSync(from, to) } catch { result.warnings.push(`session-move-failed:${row.sessionId}`) }
    }
  }
  merge(copy('20_ATTACHMENTS', 'attachments'))
  merge(copy('40_FORK_PROFILE', 'profiles'))
  if (profile) {
    const old = fs.readdirSync(path.join(home, 'profiles'))[0]
    const target = path.join(home, 'profiles', profile)
    if (old && old !== profile) {
      try { fs.renameSync(path.join(home, 'profiles', old), target) } catch { result.warnings.push('profile-rename-failed') }
    }
  }
  merge(copy('50_RUNTIME_DATA/storages', 'storages'))
  merge(copy('50_RUNTIME_DATA/xclient', 'xclient'))
  merge(copy('50_RUNTIME_DATA/fang', 'fang'))
  merge(copy('50_RUNTIME_DATA/fang-seeds', 'fang-seeds'))
  merge(copy('50_RUNTIME_DATA/fang-meta.json', 'fang-meta.json'))
  merge(copy('50_RUNTIME_DATA/llm-deepseek', 'llm-deepseek'))
  merge(copy('60_LOGS', 'logs'))
  merge(copy('70_SECRETS', '.'))
  return result
}
