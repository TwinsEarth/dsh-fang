// SPDX-License-Identifier: AGPL-3.0-or-later
// Fork full-home export/import (folder based, no zip dependency).
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

export const FORK_EXPORT_FORMAT = 'dsh-fang-fork-export/v1'
const SKIP_ROOT = new Set(['tmp', 'node_modules'])
const SKIP_ANY = new Set(['node_modules'])

function copyFiltered(from, to, relative = '') {
  const stat = fs.lstatSync(from)
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(from)
    try { fs.symlinkSync(target, to, 'junction') } catch { /* best effort */ }
    return { files: 1, bytes: 0 }
  }
  if (stat.isDirectory()) {
    const name = path.basename(from)
    if (SKIP_ANY.has(name)) return { files: 0, bytes: 0 }
    fs.mkdirSync(to, { recursive: true })
    let files = 0
    let bytes = 0
    for (const entry of fs.readdirSync(from)) {
      if (!relative && SKIP_ROOT.has(entry)) continue
      const child = copyFiltered(path.join(from, entry), path.join(to, entry), path.join(relative, entry))
      files += child.files
      bytes += child.bytes
    }
    return { files, bytes }
  }
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  return { files: 1, bytes: stat.size }
}

export function exportForkHome({ homeDir, destDir, task }) {
  const src = path.resolve(String(homeDir ?? ''))
  const dest = path.resolve(String(destDir ?? ''))
  if (!fs.existsSync(path.join(src, 'profiles'))) return { ok: false, error: 'fork-home-invalid', detail: src }
  fs.mkdirSync(dest, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = path.join(dest, `fang-${String(task?.taskId ?? 'fork')}-${stamp}`)
  fs.mkdirSync(outDir, { recursive: true })
  const copied = copyFiltered(src, path.join(outDir, 'home'))
  const manifest = {
    format: FORK_EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    taskId: task?.taskId ?? '',
    title: task?.title ?? '',
    profile: task?.profile ?? '',
    coreMode: task?.coreMode ?? 'stock',
    sourceEssenceId: task?.syncSourceId ?? task?.essenceId ?? 'essence-official-dev',
    files: copied.files,
    bytes: copied.bytes,
    nonce: randomBytes(8).toString('hex'),
  }
  const json = `${JSON.stringify(manifest, null, 2)}\n`
  fs.writeFileSync(path.join(outDir, 'manifest.json'), json)
  fs.writeFileSync(path.join(outDir, 'manifest.sha256'), `${createHash('sha256').update(json).digest('hex')}  manifest.json\n`)
  fs.writeFileSync(path.join(outDir, 'IMPORT-GUIDE.md'), [
    '# 瓮城分身导出包',
    '',
    `- 分身：${manifest.title}（${manifest.taskId}）`,
    `- 导出时间：${manifest.exportedAt}`,
    `- 文件数：${manifest.files}，字节：${manifest.bytes}`,
    '',
    '在母体面板「分身工作区」点该分身的「导入」，选择本文件夹即可恢复为一个新分身。',
    '导出不包含 `node_modules` 与 `tmp`；导入后由瓮城重新移植依赖并启动。',
  ].join('\n'))
  return { ok: true, dir: outDir, files: copied.files, bytes: copied.bytes, manifest }
}

export function readForkExport(sourceDir) {
  const dir = path.resolve(String(sourceDir ?? ''))
  const manifestPath = path.join(dir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) return { ok: false, error: 'manifest-missing', detail: manifestPath }
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { return { ok: false, error: 'manifest-invalid' } }
  if (manifest?.format !== FORK_EXPORT_FORMAT) return { ok: false, error: 'format-unsupported', detail: manifest?.format ?? '' }
  const homeDir = path.join(dir, 'home')
  if (!fs.existsSync(path.join(homeDir, 'profiles'))) return { ok: false, error: 'home-missing', detail: homeDir }
  return { ok: true, dir, homeDir, manifest }
}
