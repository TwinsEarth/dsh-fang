// SPDX-License-Identifier: MIT
// dsh-Fang / DSH plugin template — optional Client half.
//
// Contract: window.__ModuleLoader__.load({ id: <package name>, factory(require) {...} })
// React comes from the browser module table; do not require other DSH client packages.
window.__ModuleLoader__.load({
  id: '@your-scope/dsh-plugin-template',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    function Badge() {
      return h('div', {
        title: 'my-plugin: 输入框下方的一个示例徽标',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '2px 8px', borderRadius: 999, fontSize: 11,
          color: 'var(--dsw-alias-label-secondary, #888)',
          border: '1px solid var(--dsw-alias-border, rgba(127,127,127,.3))',
        },
      }, 'my-plugin')
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        return ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'my-plugin-badge',
          order: 60,
        }, (props) => h(Badge, { ...props, ctx })))
      },
    }
  },
})
