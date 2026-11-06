// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.9 分身 = 生产盘：派生 profile 里关闭插件安装 / 设置入口。
// 只锁定在当前 DSH 组合里确认存在的条目 id；DSH_FANG_FORK_CONFIG_LOCK=0 可整体关闭。
import fs from 'node:fs'
import path from 'node:path'

export const FORK_LOCKED_ENTRY_IDS = Object.freeze([
  'plugin-manager',
  'tool-plugin-manager',
  'config-editor',
  'ui-settings',
  'ui-settings-account',
  'ui-settings-general',
])

export const PROFILE_CONFIG_FILES = Object.freeze(['package.json', 'cordis.yml', 'cordis.patch.yml'])

/** 把分身 profile 的配置文件设为只读（防止误写；不防有意绕过）。 */
export function setProfileConfigReadonly(profileDir, readonly = true) {
  if (String(process.env.DSH_FANG_FORK_PROFILE_RO ?? '1') === '0') return { ok: true, skipped: true, changed: [] }
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

export function applyForkConfigLock(profileDir, options = {}) {
  if (String(process.env.DSH_FANG_FORK_CONFIG_LOCK ?? '1') === '0') return { ok: true, skipped: true }
  const file = path.join(String(profileDir), 'cordis.patch.yml')
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { text = '' }
  const lines = []
  for (const id of (options.ids ?? FORK_LOCKED_ENTRY_IDS)) {
    const present = new RegExp(`(^|\\n)\\s*-\\s*id:\\s*${id}\\s*$`, 'm').test(text)
    if (present) continue
    lines.push(`- id: ${id}`, '  disabled: true')
  }
  if (lines.length === 0) return { ok: true, entries: 0 }
  const prefix = text.length === 0 ? '' : (text.endsWith('\n') ? text : text + '\n')
  fs.writeFileSync(file, `${prefix}# fang: fork is production-only (plugin install / settings disabled)\n${lines.join('\n')}\n`, 'utf8')
  return { ok: true, entries: lines.length / 2 }
}
