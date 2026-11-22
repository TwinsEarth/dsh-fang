// SPDX-License-Identifier: AGPL-3.0-or-later
// src/lib/install-snapshot.mjs — P2：每版本独立、不可变的 DSH 安装快照。
//
// 目标：分身使用自己的安装副本，而不是 DSH Desktop 正在运行的 D:\DSH 安装树。
// 实现：在安装卷上创建 `.fang-installs/dsh-<version>-<hash>`，对安装文件做 hardlink
// （同卷零拷贝；安装升级写入新 inode，旧快照保持原版本）。每个分身的 CLI 指向自己的
// 快照路径，母体升级/替换安装文件不会改变运行中分身解析到的代码。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { ensureDir, exists, hardlinkTree } from '../kernel/index.mjs'

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** Derive the install root from a `<root>/resources/runtime/cli/bin/dsh.cmd` path. */
export function installRootOf(cliPath) {
  const resolved = path.resolve(String(cliPath ?? ''))
  const resources = path.resolve(path.dirname(resolved), '../../..')
  return path.dirname(resources)
}

function readMarker(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/**
 * Ensure an immutable install snapshot for the given launcher.
 * @param {{cliPath:string, version:string, rootDir?:string, force?:boolean}} options
 * @returns {{ok:boolean, cliPath:string, root:string|null, created:boolean, fallback:boolean, error?:string}}
 */
export function ensureInstallSnapshot({ cliPath, version, rootDir = '', force = false } = {}) {
  const original = String(cliPath ?? '').trim()
  if (!original) return { ok: false, cliPath: '', root: null, created: false, fallback: true, error: 'no-cli-path' }
  let root
  try { root = installRootOf(original) } catch { root = '' }
  if (!root || !exists(original)) return { ok: false, cliPath: original, root: null, created: false, fallback: true, error: 'install-root-missing' }
  const appAsar = path.join(root, 'resources', 'app.asar')
  let stat = null
  try { stat = fs.statSync(appAsar) } catch { /* non-asar install */ }
  const fingerprint = sha256(`${version}:${stat?.size ?? 0}:${stat?.mtimeMs ?? 0}`).slice(0, 12)
  const snapshotsDir = path.resolve(rootDir || path.join(root, '.fang-installs'))
  const snapshotRoot = path.join(snapshotsDir, `dsh-${version}-${fingerprint}`)
  const markerFile = path.join(snapshotRoot, '.fang-install-snapshot.json')
  const marker = readMarker(markerFile)
  if (!force && marker?.version === version && exists(path.join(snapshotRoot, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'))) {
    return { ok: true, cliPath: path.join(snapshotRoot, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'), root: snapshotRoot, created: false, fallback: false }
  }
  try {
    ensureDir(snapshotsDir)
    const tmp = `${snapshotRoot}.tmp-${process.pid}-${Date.now()}`
    fs.rmSync(tmp, { recursive: true, force: true })
    ensureDir(tmp)
    // Copy the install root's top-level entries except the snapshot store itself.
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.name === path.basename(snapshotsDir)) continue
      const from = path.join(root, entry.name)
      const to = path.join(tmp, entry.name)
      if (entry.isDirectory()) {
        ensureDir(to)
        hardlinkTree(from, to)
      } else if (entry.isFile()) {
        ensureDir(path.dirname(to))
        try { fs.linkSync(from, to) } catch { fs.copyFileSync(from, to) }
      }
    }
    fs.writeFileSync(path.join(tmp, '.fang-install-snapshot.json'), JSON.stringify({
      at: new Date().toISOString(), version, fingerprint, sourceRoot: root, sourceCli: original,
    }, null, 2) + '\n')
    fs.rmSync(snapshotRoot, { recursive: true, force: true })
    fs.renameSync(tmp, snapshotRoot)
    return { ok: true, cliPath: path.join(snapshotRoot, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'), root: snapshotRoot, created: true, fallback: false }
  } catch (error) {
    return { ok: false, cliPath: original, root: null, created: false, fallback: true, error: String(error?.message ?? error) }
  }
}
