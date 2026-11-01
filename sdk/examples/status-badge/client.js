// SPDX-License-Identifier: MIT
// Example client half: read dsh-Fang's public read-only HTTP surface and show it in the dock.
// This demonstrates the recommended third-party integration: HTTP only, no host internals.
window.__ModuleLoader__.load({
  id: '@fang-example/status-badge',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    function StatusBadge() {
      const [view, setView] = React.useState({ state: 'loading', text: '瓮城 …' })
      React.useEffect(() => {
        let alive = true
        const poll = async () => {
          try {
            const res = await fetch('/fang/api/status', { headers: { accept: 'application/json' } })
            if (!res.ok) throw new Error('status ' + res.status)
            const body = await res.json()
            if (!alive) return
            const ready = body?.tasks?.ready ?? 0
            const max = body?.tasks?.max ?? '?'
            setView({ state: 'ok', text: `瓮城 ${ready}/${max}`, version: body?.version })
          } catch {
            if (alive) setView({ state: 'off', text: '瓮城离线' })
          }
        }
        poll()
        const timer = setInterval(poll, 10000)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      const color = view.state === 'ok'
        ? 'var(--dsw-alias-state-success, #22c55e)'
        : view.state === 'off'
          ? 'var(--dsw-alias-state-warning, #9ca3af)'
          : 'var(--dsw-alias-state-business-primary, #2563eb)'
      return h('div', {
        title: view.version ? `dsh-Fang ${view.version}` : 'dsh-Fang 状态（第三方插件示例）',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 999,
          fontSize: 11, color: 'var(--dsw-alias-label-secondary, #888)',
          border: '1px solid var(--dsw-alias-border, rgba(127,127,127,.3))',
        },
      },
      h('span', { 'aria-hidden': true, style: { width: 6, height: 6, borderRadius: '50%', background: color } }),
      h('span', null, view.text))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        return ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'fang-example-status-badge',
          order: 70,
        }, (props) => h(StatusBadge, { ...props, ctx })))
      },
    }
  },
})
