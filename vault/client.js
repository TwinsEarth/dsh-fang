// SPDX-License-Identifier: AGPL-3.0-or-later
// Independent Vault client half: inject 导出/导入 into every fork tab bar.
// It uses the main panel's authenticated bridge; no token handling here.
window.__ModuleLoader__.load({
  id: '@twinsearth/dsh-fang-vault',
  factory() {
    const BUTTONS = [
      { key: 'vault-export', label: '导出', title: '导出该分身为 Vault 文件夹（可选工作区快照）', action: 'exportTask' },
      { key: 'vault-import', label: '导入', title: '从 Vault 文件夹导入为新分身，并重新移植依赖', action: 'importTask' },
    ]
    function buttonFor(card, spec) {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.vault = spec.key
      button.className = 'btn btn--sm btn--ghost'
      button.textContent = spec.label
      button.title = spec.title
      button.style.marginInlineStart = '4px'
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        const bridge = window.__fangVaultBridge
        if (!bridge || typeof bridge[spec.action] !== 'function') {
          window.alert?.('瓮城 Vault 桥接不可用：请刷新母体页面')
          return
        }
        if (spec.action === 'exportTask') void bridge.exportTask({ taskId: card.dataset.task })
        else void bridge.importTask()
      })
      return button
    }
    function inject() {
      for (const card of document.querySelectorAll('[data-task]')) {
        const actions = card.querySelector('.fork-actions')
        if (!actions) continue
        // 母体自带按钮已存在时不再重复注入；独立子插件只做兼容补位。
        if (actions.querySelector('[data-btn-id="C-08"]')) continue
        for (const spec of BUTTONS) {
          if (actions.querySelector(`[data-vault="${spec.key}"]`)) continue
          actions.appendChild(buttonFor(card, spec))
        }
      }
    }
    const observer = new MutationObserver(() => inject())
    observer.observe(document.documentElement, { childList: true, subtree: true })
    inject()
    return { inject }
  },
})
