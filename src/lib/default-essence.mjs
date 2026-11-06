// SPDX-License-Identifier: AGPL-3.0-or-later
// 新用户默认“元宝”：安装不激活 / 安装并激活 两组插件，以及本机插件配置复制选项。
export const DEFAULT_ESSENCE_NAME = '默认元宝'

export const DEFAULT_ESSENCE_PRESET = Object.freeze({
  version: 1,
  groups: Object.freeze([
    {
      key: 'installed-inactive',
      title: '安装不激活',
      enabled: false,
      specs: Object.freeze([
        '@twinsearth/dsh-2xray',
        '@michengai/dsh-agency-agents',
        'dsh-better-sidebar',
        'dsh-context',
        '@liustack/modlens',
        '@liustack/modsearch',
      ]),
    },
    {
      key: 'installed-active',
      title: '安装并激活',
      enabled: true,
      specs: Object.freeze([
        'dshmarket',
        '@twinsearth/dsh-im2a-plugin',
        '@openviking/dsh-memory-plugin',
        '@twinsearth/w2m-dsh-plugin',
      ]),
    },
  ]),
})

/** 从 pluginManager.listPlugins() 的结果里判断某个包是否已安装（模糊匹配包名末尾）。 */
export function matchInstalled(entries, spec) {
  const wanted = String(spec ?? '').toLowerCase()
  const bare = wanted.includes('/') ? wanted.split('/').pop() : wanted
  for (const entry of entries ?? []) {
    const name = String(entry?.name ?? entry?.id ?? '').toLowerCase()
    if (!name) continue
    if (name === wanted || name.endsWith('/' + bare) || name.includes(bare)) return entry
  }
  return null
}

export function planDefaultEssence(entries) {
  return {
    name: DEFAULT_ESSENCE_NAME,
    version: DEFAULT_ESSENCE_PRESET.version,
    groups: DEFAULT_ESSENCE_PRESET.groups.map((group) => ({
      key: group.key,
      title: group.title,
      enabled: group.enabled,
      plugins: group.specs.map((spec) => {
        const hit = matchInstalled(entries, spec)
        return { spec, installed: Boolean(hit), pluginId: hit?.id ?? null }
      }),
    })),
  }
}
