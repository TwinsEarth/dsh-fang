// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.9 分身 = 生产盘：派生 profile 里关闭插件安装 / 设置入口。
// 只锁定在当前 DSH 组合里确认存在的条目 id；DSH_FANG_FORK_CONFIG_LOCK=0 可整体关闭。
import fs from 'node:fs'
import path from 'node:path'

export const FORK_LOCKED_ENTRY_IDS = Object.freeze([
  // 只禁用不影响 DSH 客户端服务图的条目。
  // 禁用 config-editor / ui-settings 会移除 configForms 服务，导致 locale 及之后
  // 50 个客户端插件永久 pending（实测：web boot 50 entries did not activate）。
  'tool-plugin-manager',
  // 只隐藏设置页的插件清单；不能禁用 ui-plugin-manager：它提供 pluginNavigation，
  // 禁掉会让 dsh-client-ui-plugin-recommendations 永久 pending（v3.1.5 实测）。
  'ui-settings-plugin-inventory',
])

/** DSH first-run notice needs a durable ui-settings-general config form in every fork profile. */
const WELCOME_NOTICE_ENTRY = Object.freeze({
  id: 'ui-settings-general',
  name: '@deepseek-ai/dsh-client-ui-settings-general',
  config: Object.freeze({ welcomeNoticeVersion: '2026-09-28.1' }),
})

// cordis.yml 不加只读：DSH 启动时会打开它做规范化写入，只读会导致 EPERM 启动失败。
export const PROFILE_CONFIG_FILES = Object.freeze(['package.json', 'cordis.patch.yml'])

/** v3.1.5 曾错误禁用 ui-plugin-manager（它提供 pluginNavigation）；升级时自动移除该历史锁。 */
export const LEGACY_LOCKED_ENTRY_IDS = Object.freeze(['ui-plugin-manager'])

/**
 * 把分身 profile 的配置文件设为只读（防止误写；不防有意绕过）。 */
export function setProfileConfigReadonly(profileDir, readonly = true) {
  if (String(process.env.DSH_FANG_FORK_PROFILE_RO ?? '1') === '0') return { ok: true, skipped: true, changed: [] }
  // essence-runtime 是元主的配置态实例：DSH 设置/内置插件开关需要原子写 package.json。
  // 只对真正的分身（生产盘）保持只读；否则点「启用」会 EPERM rename package.json.tmp。
  if (readonly && path.basename(String(profileDir)) === 'essence-runtime') {
    return { ok: true, skipped: true, runtime: true, changed: [] }
  }
  const changed = []
  for (const name of PROFILE_CONFIG_FILES) {
    const file = path.join(String(profileDir), name)
    try {
      fs.chmodSync(file, readonly ? 0o444 : 0o644)
      changed.push(name)
    } catch { /* 文件不存在/平台不支持则跳过 */ }
  }
  return { ok: true, changed }
}

/**
 * Essence-derived profiles serialize their patch as a JSON object `{ insert: [...] }`.
 * Appending YAML lines after that object produces invalid YAML (the v3.0.10 spawn-failed
 * bug). Return the semantic entry array when the file is JSON, so the lock can be merged
 * structurally instead.
 * @param {string} text
 * @returns {Array<Record<string, unknown>> | null}
 */
function jsonPatchEntries(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  let value
  try { value = JSON.parse(trimmed) } catch { return null }
  if (Array.isArray(value)) return value.length === 0 ? null : value
  if (value !== null && typeof value === 'object' && Array.isArray(value.insert)) return [value]
  return null
}

/** Add the lock rows and the onboarding row without duplicating ids. */
function withLockRows(entries, ids) {
  const out = entries.slice()
  let added = 0
  for (const id of ids) {
    if (!out.some((entry) => entry !== null && typeof entry === 'object' && entry.id === id)) {
      out.push({ id, disabled: true })
      added += 1
    }
  }
  if (!out.some((entry) => entry !== null && typeof entry === 'object' && entry.id === WELCOME_NOTICE_ENTRY.id)) {
    out.push({ ...WELCOME_NOTICE_ENTRY, config: { ...WELCOME_NOTICE_ENTRY.config } })
  }
  return { entries: out, added }
}

export function applyForkConfigLock(profileDir, options = {}) {
  if (String(process.env.DSH_FANG_FORK_CONFIG_LOCK ?? '1') === '0') return { ok: true, skipped: true }
  // 自动修复 v3.1.5 遗留的 ui-plugin-manager disabled:true（会断 pluginNavigation）。
  try { clearForkConfigLock(profileDir, { ids: LEGACY_LOCKED_ENTRY_IDS }) } catch { /* best effort */ }
  const file = path.join(String(profileDir), 'cordis.patch.yml')
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { text = '' }
  const ids = options.ids ?? FORK_LOCKED_ENTRY_IDS
  // JSON object/array patches are semantic entry lists; merge them structurally. Appending
  // YAML text after `{ insert: [...] }` would make the whole file unparsable.
  const jsonEntries = jsonPatchEntries(text)
  if (jsonEntries !== null) {
    const merged = withLockRows(jsonEntries, ids)
    fs.writeFileSync(file, `${JSON.stringify(merged.entries, null, 2)}\n`, 'utf8')
    return { ok: true, entries: merged.added }
  }
  // 模板里的 `[]`（空 YAML 数组）必须去掉，否则追加 `- id:` 会变成非法 YAML。
  const kept = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*\[\s*\]\s*(#.*)?$/.test(line))
  text = kept.join('\n')
  const lines = []
  for (const id of ids) {
    const present = new RegExp(`(^|\\n)\\s*-\\s*id:\\s*${id}\\s*$`, 'm').test(text)
    if (present) continue
    lines.push(`- id: ${id}`, '  disabled: true')
  }
  if (!new RegExp(`(^|\\n)\\s*-\\s*id:\\s*${WELCOME_NOTICE_ENTRY.id}\\s*$`, 'm').test(text)) {
    lines.push(
      `- id: ${WELCOME_NOTICE_ENTRY.id}`,
      `  name: "${WELCOME_NOTICE_ENTRY.name}"`,
      '  config:',
      `    welcomeNoticeVersion: ${WELCOME_NOTICE_ENTRY.config.welcomeNoticeVersion}`,
    )
  }
  if (lines.length === 0) return { ok: true, entries: 0 }
  const prefix = text.trim().length === 0 ? '' : (text.endsWith('\n') ? text : text + '\n')
  const comment = text.includes('# fang: fork is production-only')
    ? '' : '# fang: fork is production-only (plugin install / settings disabled)\n'
  fs.writeFileSync(file, `${prefix}${comment}${lines.join('\n')}\n`, 'utf8')
  return { ok: true, entries: ids.length }
}

/**
 * 解除 fork 生产盘锁（只删 disabled:true 的锁定行，不碰其他配置）。
 * 元宝运行态 essence-runtime 是配置实例，升级后需要清掉历史 provision 写入的锁。
 */
export function clearForkConfigLock(profileDir, options = {}) {
  const file = path.join(String(profileDir), 'cordis.patch.yml')
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return { ok: true, removed: 0 } }
  const ids = options.ids ?? FORK_LOCKED_ENTRY_IDS
  const jsonEntries = jsonPatchEntries(text)
  if (jsonEntries !== null) {
    const wanted = new Set(ids)
    const kept = jsonEntries.filter((entry) => !(entry && typeof entry === 'object' && wanted.has(entry.id) && entry.disabled === true))
    if (kept.length === jsonEntries.length) return { ok: true, removed: 0 }
    fs.writeFileSync(file, `${JSON.stringify(kept, null, 2)}\n`, 'utf8')
    return { ok: true, removed: jsonEntries.length - kept.length }
  }
  let removed = 0
  for (const id of ids) {
    const escaped = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(^|\\n)\\s*-\\s*id:\\s*${escaped}\\s*\\n\\s*disabled:\\s*true\\s*(?=\\n|$)`, 'g')
    text = text.replace(re, (match, lead) => { removed += 1; return lead })
  }
  if (removed > 0) fs.writeFileSync(file, text, 'utf8')
  return { ok: true, removed }
}
