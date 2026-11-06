// SPDX-License-Identifier: AGPL-3.0-or-later
// Composer journal: capture the unsent draft and a read-only mirror of the
// composer queue, persist them through the fang HTTP API, and offer recovery
// only after an explicit user click. This plugin never sends a message.
window.__ModuleLoader__.load({
  id: '@twinsearth/dsh-fang-queue-journal',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const DEBOUNCE_MS = 400

    function sessionKey() {
      const hash = String(location.hash || '').replace(/^#/, '')
      const fromHash = /sessions?\/([^/?#]+)/.exec(hash)
      const fromPath = /sessions?\/([^/?#]+)/.exec(location.pathname)
      const q = new URLSearchParams(location.search).get('session')
      const value = String(q || fromHash?.[1] || fromPath?.[1] || hash || location.pathname || '/')
      return value.slice(0, 200)
    }

    let tokenCache = { at: 0, token: '' }
    async function fangToken() {
      if (tokenCache.token && Date.now() - tokenCache.at < 30_000) return tokenCache.token
      try {
        const res = await fetch('/fang/api/auth-token', { headers: { accept: 'application/json' } })
        const body = await res.json()
        tokenCache = { at: Date.now(), token: String(body?.token || '') }
      } catch { tokenCache = { at: Date.now(), token: '' } }
      return tokenCache.token
    }

    async function journalRequest(method, entry, keyOverride) {
      const token = await fangToken()
      if (!token) return null
      const key = keyOverride || sessionKey()
      const res = await fetch(method === 'POST' ? '/fang/api/composer/journal' : '/fang/api/composer/journal?key=' + encodeURIComponent(key), {
        method,
        headers: { 'content-type': 'application/json', 'x-fang-auth': token },
        body: method === 'POST' ? JSON.stringify({ key, path: location.hash || location.pathname, ...entry }) : undefined,
      })
      if (!res.ok) return null
      return res.json()
    }

    function findComposer() {
      const nodes = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
        .filter((el) => {
          if (el.closest?.('[data-fang-entry]')) return false
          const r = el.getBoundingClientRect()
          return r.width > 80 && r.height > 16
        })
      // Prefer the largest (the main composer), not a hidden side field.
      return nodes.sort((a, b) => {
        const ra = a.getBoundingClientRect()
        const rb = b.getBoundingClientRect()
        return (rb.width * rb.height) - (ra.width * ra.height)
      })[0] || null
    }

    function readComposer(el) {
      if (!el) return ''
      return el.tagName === 'TEXTAREA' ? String(el.value || '') : String(el.innerText || '')
    }

    function writeComposer(text) {
      const el = findComposer()
      if (!el) return false
      el.focus()
      if (el.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        if (setter) setter.call(el, text)
        else el.value = text
        el.dispatchEvent(new Event('input', { bubbles: true }))
      } else {
        try {
          document.execCommand('selectAll', false, null)
          document.execCommand('insertText', false, text)
        } catch { /* fall back */ }
        if (!String(el.innerText || '').includes(text.slice(0, 20))) {
          el.textContent = text
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
        }
      }
      el.focus()
      return true
    }

    function scanQueue() {
      const seen = new Set()
      const out = []
      const nodes = document.querySelectorAll('[class*="queue" i], [data-testid*="queue" i], [aria-label*="queue" i], [class*="pending" i], [data-testid*="pending" i], [aria-label*="排队"], [title*="排队"]')
      for (const el of nodes) {
        const text = String(el.innerText || '').trim()
        if (!text || text.length > 4000 || seen.has(text)) continue
        seen.add(text)
        out.push({ text, at: Date.now() })
      }
      return out.slice(-100)
    }

    function JournalDock() {
      const [entry, setEntry] = React.useState(null)
      const [notice, setNotice] = React.useState('')
      React.useEffect(() => {
        let alive = true
        journalRequest('GET').then(async (body) => {
          let found = body?.entry ?? null
          // Migration: older builds keyed everything under "/".
          if (!found && sessionKey() !== '/') {
            const legacy = await journalRequest('GET', null, '/').catch(() => null)
            found = legacy?.entry ?? null
          }
          if (alive) setEntry(found)
        }).catch(() => {})
        return () => { alive = false }
      }, [])
      if (!entry || (!entry.draft && !(entry.queue || []).length)) return null
      const restore = () => {
        const ok = writeComposer(String(entry.draft || ''))
        setNotice(ok ? '草稿已放入输入框，请检查后手动发送' : '未找到输入框，请先打开会话')
      }
      const copyQueue = async () => {
        const text = (entry.queue || []).map((item, i) => `${i + 1}. ${item.text}`).join('\n')
        try { await navigator.clipboard.writeText(text); setNotice('队列快照已复制') } catch { setNotice('复制失败') }
      }
      return h('div', {
        'data-fang-entry': 'queue-journal',
        style: {
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '4px 0',
          padding: '6px 10px', border: '1px solid rgba(127,127,127,.35)', borderRadius: 10,
          fontSize: 12, background: 'rgba(127,127,127,.06)',
        },
      },
      h('span', { style: { fontWeight: 600 } }, '瓮城：发现上次未发送内容'),
      entry.draft ? h('span', { style: { opacity: .7 } }, `草稿 ${entry.draft.length} 字`) : null,
      (entry.queue || []).length ? h('span', { style: { opacity: .7 } }, `排队快照 ${entry.queue.length} 条`) : null,
      entry.draft ? h('button', { type: 'button', onClick: restore, style: { height: 26, padding: '0 8px', borderRadius: 7, cursor: 'pointer' } }, '恢复草稿') : null,
      (entry.queue || []).length ? h('button', { type: 'button', onClick: copyQueue, style: { height: 26, padding: '0 8px', borderRadius: 7, cursor: 'pointer' } }, '复制队列快照') : null,
      h('button', {
        type: 'button',
        onClick: async () => {
          await journalRequest('POST', { draft: '', queue: [] })
          setEntry(null)
          setNotice('已清除记录')
        },
        style: { height: 26, padding: '0 8px', borderRadius: 7, cursor: 'pointer' },
      }, '清除'),
      notice ? h('span', { role: 'status', style: { opacity: .7 } }, notice) : null)
    }

    let timer = null
    let lastQueue = ''
    function saveDraft(text) {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const queue = scanQueue()
        const signature = JSON.stringify(queue.map((q) => q.text))
        if (!text && signature === lastQueue) return
        lastQueue = signature
        void journalRequest('POST', { draft: text, queue })
      }, DEBOUNCE_MS)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'fang-queue-journal',
          order: 90,
        }, JournalDock))
        document.addEventListener('input', (event) => {
          const target = event.target
          if (!target || (target.tagName !== 'TEXTAREA' && target.getAttribute?.('contenteditable') !== 'true')) return
          saveDraft(readComposer(target))
        }, true)
        try {
          const observer = new MutationObserver(() => saveDraft(readComposer(findComposer())))
          observer.observe(document.body, { childList: true, subtree: true, characterData: true })
        } catch { /* DOM unavailable */ }
      },
    }
  },
})
