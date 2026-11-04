// SPDX-License-Identifier: AGPL-3.0-or-later
// DSH Web plugin-config entry: a single link that opens the PC Electron panel.
// No fang control panel is rendered in the browser.
window.__ModuleLoader__.load({
  id: '@twinsearth/dsh-fang-web-entry',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    function WengchengEntry() {
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
        h('a', {
          href: 'dsh-fang://open',
          'data-fang-entry': 'open-pc-panel',
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px',
            borderRadius: 8, border: '1px solid rgba(127,127,127,.35)', textDecoration: 'none',
            color: 'inherit', fontWeight: 600,
          },
        }, '打开瓮城控制台'),
        h('span', { style: { opacity: .7, fontSize: 12 } }, '需要在 PC 安装 dsh-fang 桌面端'))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: '@twinsearth/dsh-fang',
          id: 'fang-web-entry',
          order: 10,
        }, WengchengEntry))
      },
    }
  },
})
