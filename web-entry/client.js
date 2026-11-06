// SPDX-License-Identifier: AGPL-3.0-or-later
// Plugin-settings entry for dsh-Fang: opens the PC Electron panel and offers a
// mother backup action. Sidebar/main panel live in the fang client half itself.
window.__ModuleLoader__.load({
  id: '@twinsearth/dsh-fang-web-entry',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    function openPanel() {
      try { window.location.href = 'dsh-fang://open' } catch { /* host blocked custom protocol */ }
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
        }, '打开瓮城桌面'),
        h('button', {
          type: 'button',
          'data-fang-entry': 'backup-mother',
          onClick: backupMother,
          style: { height: 32, padding: '0 12px', borderRadius: 8, cursor: 'pointer' },
        }, '备份母体'),
        backup ? h('span', { role: 'status', style: { opacity: .75, fontSize: 12 } }, backup) : null,
        h('span', { style: { opacity: .7, fontSize: 12 } }, 'PC 端可选；Web 侧边栏「瓮城」已完整可用'))
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
