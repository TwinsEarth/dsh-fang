// SPDX-License-Identifier: AGPL-3.0-or-later
// DSH Web entries: one sidebar icon and one plugin-config link. Both open the PC
// Electron panel through dsh-fang://open; no fang control panel is rendered here.
window.__ModuleLoader__.load({
  id: '@twinsearth/dsh-fang-web-entry',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    function openPanel() {
      // 顶层导航保留真实用户激活，Chromium 才会把自定义协议交给系统处理。
      try { window.location.href = 'dsh-fang://open' } catch { /* host blocked custom protocol */ }
    }

    function GateIcon({ size = 18 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true',
        style: { display: 'block', flex: 'none' },
      },
      h('path', { d: 'M5 21V8a7 7 0 0 1 14 0v13', fill: 'none', stroke: '#C8102E', strokeWidth: 2.2, strokeLinecap: 'round' }),
      h('path', { d: 'M3 21h18', fill: 'none', stroke: '#C8102E', strokeWidth: 2.2, strokeLinecap: 'round' }),
      h('path', { d: 'M9 21v-6a3 3 0 0 1 6 0v6', fill: 'none', stroke: '#C8102E', strokeWidth: 2, strokeLinecap: 'round' }))
    }

    function WengchengEntry() {
      const [backup, setBackup] = React.useState('')
      const backupMother = async () => {
        setBackup('备份中…')
        try {
          const auth = await fetch('/fang/api/auth-token', { headers: { accept: 'application/json' } }).then((r) => r.json())
          const res = await fetch('/fang/api/mirror/backup', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-fang-auth': String(auth?.token || '') },
            body: JSON.stringify({ bucket: 'restore', label: '插件设置备份' }),
          })
          setBackup(res.ok ? '已创建母体备份' : `备份失败（${res.status}）`)
        } catch (error) {
          setBackup('备份失败：' + String(error?.message ?? error))
        }
      }
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
        h('button', {
          type: 'button',
          'data-fang-entry': 'backup-mother',
          onClick: backupMother,
          style: { height: 32, padding: '0 12px', borderRadius: 8, cursor: 'pointer' },
        }, '备份母体'),
        backup ? h('span', { role: 'status', style: { opacity: .75, fontSize: 12 } }, backup) : null,
        h('span', { style: { opacity: .7, fontSize: 12 } }, '需要在 PC 安装 dsh-fang 桌面端'))
    }

    function WengchengSidebarEntry({ size = 18, active } = {}) {
      return h('span', {
        title: '瓮城',
        'aria-label': '瓮城',
        'data-fang-entry': 'sidebar',
        style: { display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: active ? 1 : .82 },
      }, h(GateIcon, { size }))
    }

    function FangLaunchPanel() {
      return h('div', {
        'data-fang-entry': 'launch-panel',
        style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 240, padding: 24 },
      },
      h(GateIcon, { size: 40 }),
      h('div', { style: { fontSize: 16, fontWeight: 700 } }, '瓮城桌面控制台'),
      h('button', { type: 'button', onClick: openPanel, style: { height: 34, padding: '0 14px', borderRadius: 8, cursor: 'pointer', fontWeight: 600 } }, '打开瓮城桌面'),
      h('div', { style: { opacity: .65, fontSize: 12 } }, '点击按钮唤起 PC 端 dsh-fang（需要桌面端已安装）'))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'fang-sidebar-entry',
          label: '瓮城',
          order: 100,
        }, WengchengSidebarEntry))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'fang-sidebar-entry',
          id: 'fang-launch-panel',
          order: 100,
        }, FangLaunchPanel))
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
