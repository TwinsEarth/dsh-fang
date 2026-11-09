// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// boot-guard — 启动前/发布前插件树自检（fail-loud 之前拦住）：
//   * 解析 fang bundle 的 cordis.patch.yml 行（id/name）；
//   * 检查 id 重复、模块可解析、子进程 isolation import() 且导出 apply()；
//   * 可选：把失败行 disabled:true 合并进 profile 的 cordis.patch.yml（安全模式）。
// 原则：任何一项失败都只报告/禁用，不修改 DSH 核心文件；写 profile 前必须备份。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

import { parseYamlSubset } from './rule-registry.mjs'

export const FANG_PACKAGE_NAMES = Object.freeze(['@twinsearth/dsh-fang', '@local/dsh-fang'])
export const SMOKE_TIMEOUT_MS = 8000

/** 找到 profile 里已安装的 fang 包目录（发布名优先，其次本地 link 名）。 */
export function findFangPackageDir(profileDir) {
  for (const name of FANG_PACKAGE_NAMES) {
    const candidate = path.join(String(profileDir ?? ''), 'node_modules', ...name.split('/'))
    try { if (fs.statSync(candidate).isDirectory()) return candidate } catch { /* next */ }
  }
  return null
}

/** 解析 bundle patch → 行数组 [{id, name}]。 */
export function readBundleRows(pkgDir) {
  const file = path.join(String(pkgDir ?? ''), 'cordis.patch.yml')
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return { ok: false, error: 'patch-missing', rows: [] } }
  const parsed = parseYamlSubset(text)
  const value = parsed?.value
  const insert = Array.isArray(value) ? value.flatMap((item) => Array.isArray(item?.insert) ? item.insert : []) : (Array.isArray(value?.insert) ? value.insert : [])
  const rows = insert.filter((row) => row && typeof row === 'object' && row.id).map((row) => ({
    id: String(row.id), name: row.name === undefined ? null : String(row.name),
  }))
  return { ok: parsed.errors.length === 0, error: parsed.errors.length ? `patch-parse:${parsed.errors[0]}` : null, rows, parseErrors: parsed.errors }
}

/** 在隔离子进程 import 模块，确认可加载且导出 apply。 */
export function smokeModule(moduleUrl, { timeoutMs = SMOKE_TIMEOUT_MS } = {}) {
  const script = `
    const url = process.argv[1];
    import(url).then((m) => {
      process.stdout.write(JSON.stringify({ ok: typeof m.apply === 'function', hasApply: typeof m.apply === 'function', name: m.name ?? null }));
    }).catch((e) => {
      process.stdout.write(JSON.stringify({ ok: false, hasApply: false, error: String(e && e.message || e).slice(0, 500) }));
    });
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, moduleUrl], {
    encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
  })
  if (result.error?.code === 'ETIMEDOUT' || result.signal) return { ok: false, error: 'timeout' }
  const line = String(result.stdout ?? '').trim().split('\n').filter(Boolean).pop()
  if (!line) return { ok: false, error: String(result.stderr ?? '').trim().slice(0, 500) || `exit=${result.status}` }
  try { return JSON.parse(line) } catch { return { ok: false, error: line.slice(0, 500) } }
}

/** 读取已安装 fang 包的 package.json name（用于区分“本包行”和可选子插件行）。 */
export function readPackageName(pkgDir) {
  try { return String(JSON.parse(fs.readFileSync(path.join(String(pkgDir ?? ''), 'package.json'), 'utf8')).name ?? '') } catch { return '' }
}

/** 读取 package 的入口（exports["."]/main/ src/index.mjs），用于更新候选包冒烟。 */
export function readPackageEntry(packageDir) {
  const dir = String(packageDir ?? '')
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    const exported = pkg?.exports?.['.']
    const candidate = typeof exported === 'string'
      ? exported
      : (exported && typeof exported === 'object' && typeof exported.default === 'string' ? exported.default : null)
    const entry = candidate || pkg.main || './src/index.mjs'
    return path.resolve(dir, entry)
  } catch { return null }
}

/** 更新候选包冒烟：入口存在 + 隔离子进程 import + 导出 apply；失败即禁止转正。 */
export function smokePackage(packageDir, { timeoutMs = SMOKE_TIMEOUT_MS } = {}) {
  const dir = String(packageDir ?? '')
  const entry = readPackageEntry(dir)
  if (!entry) return { ok: false, error: 'package-json-missing', packageDir: dir }
  try { if (!fs.statSync(entry).isFile()) return { ok: false, error: 'entry-missing', entry } } catch { return { ok: false, error: 'entry-missing', entry } }
  const result = smokeModule(pathToFileURL(entry).href, { timeoutMs })
  return { ...result, entry, packageDir: dir }
}

/**
 * 检查行：重复 id、模块解析、隔离 import 冒烟。
 * 本包行失败 = block；可选子插件（如 @twinsearth/dsh-fang-web-entry）缺失/失败 = warn。
 * @returns {{ok:boolean, findings:Array<{code,level,id?,detail?}>, checked:number}}
 */
export function checkBundleRows(rows, { profileDir, ownPackage = '', timeoutMs = SMOKE_TIMEOUT_MS } = {}) {
  const findings = []
  const seen = new Set()
  let checked = 0
  const requireFrom = createRequire(path.join(String(profileDir ?? ''), 'package.json'))
  const isOwnRow = (name) => {
    const own = String(ownPackage ?? '').trim()
    if (!own) return true
    return name === own || name.startsWith(`${own}/`)
  }
  for (const row of rows) {
    if (seen.has(row.id)) {
      findings.push({ code: 'duplicate-id', level: 'block', id: row.id, detail: row.id })
      continue
    }
    seen.add(row.id)
    if (!row.name) {
      findings.push({ code: 'row-name-missing', level: 'warn', id: row.id })
      continue
    }
    checked += 1
    const optional = !isOwnRow(row.name)
    let resolved = null
    try { resolved = requireFrom.resolve(row.name) } catch (error) {
      findings.push({
        code: 'module-unresolved', level: optional ? 'warn' : 'block', id: row.id,
        detail: `${row.name}: ${String(error?.message ?? error).slice(0, 200)}`,
      })
      continue
    }
    const smoke = smokeModule(pathToFileURL(resolved).href, { timeoutMs })
    if (!smoke.ok) {
      findings.push({ code: 'module-smoke-failed', level: optional ? 'warn' : 'block', id: row.id, detail: String(smoke.error ?? 'no apply()').slice(0, 300) })
    }
  }
  return { ok: findings.every((finding) => finding.level !== 'block'), findings, checked }
}

const jsonPatchEntries = (text) => {
  const trimmed = String(text ?? '').trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    const value = JSON.parse(trimmed)
    if (Array.isArray(value)) return value
    if (value && typeof value === 'object' && Array.isArray(value.insert)) return value.insert
  } catch { /* yaml */ }
  return null
}

/**
 * 把 disabled 行合并进 profile 的 cordis.patch.yml；先写 .bak-<ts> 备份。
 * 只接受 id（禁用行）；不会删除/改写已有行。
 */
export function applyDisabledRows(profileDir, ids) {
  const dir = String(profileDir ?? '')
  if (!dir) return { ok: false, error: 'profile-dir-required' }
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))]
  if (!wanted.length) return { ok: false, error: 'no-ids' }
  const file = path.join(dir, 'cordis.patch.yml')
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { text = '' }
  try { fs.mkdirSync(dir, { recursive: true }); if (text) fs.writeFileSync(`${file}.bak-${Date.now()}`, text, 'utf8') } catch { /* backup best-effort */ }
  const asJson = jsonPatchEntries(text)
  if (asJson !== null) {
    const existing = new Set(asJson.map((entry) => entry && typeof entry === 'object' ? String(entry.id ?? '') : ''))
    const merged = asJson.slice()
    let added = 0
    for (const id of wanted) {
      if (existing.has(id)) continue
      merged.push({ id, disabled: true })
      added += 1
    }
    fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    return { ok: true, added, file, format: 'json' }
  }
  const kept = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => !/^\s*\[\s*\]\s*(#.*)?$/.test(line))
  const body = kept.join('\n')
  const lines = []
  for (const id of wanted) {
    if (new RegExp(`(^|\\n)\\s*-\\s*id:\\s*${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(body)) continue
    lines.push(`- id: ${id}`, '  disabled: true')
  }
  if (!lines.length) return { ok: true, added: 0, file, format: 'yaml' }
  const prefix = body.trim().length === 0 ? '' : (body.endsWith('\n') ? body : body + '\n')
  fs.writeFileSync(file, `${prefix}${lines.join('\n')}\n`, 'utf8')
  return { ok: true, added: wanted.length, file, format: 'yaml' }
}
