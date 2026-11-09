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

    // The official slot prop gives us the real SessionId. The URL may not carry
    // one (DSH keeps the selected Session in client state), so using the URL as
    // the journal key collapses every session onto "/" and only the last draft
    // survives. Prefer the SessionId; keep the URL only as a compatibility key.
    let activeKey = ''
    let activeSessionId = ''

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
      const key = keyOverride || activeKey || activeSessionId || sessionKey()
      const res = await fetch(method === 'POST' ? '/fang/api/composer/journal' : '/fang/api/composer/journal?key=' + encodeURIComponent(key), {
        method,
        headers: { 'content-type': 'application/json', 'x-fang-auth': token },
        body: method === 'POST'
          ? JSON.stringify({ key, sessionId: activeSessionId || undefined, path: location.hash || location.pathname, ...entry })
          : undefined,
      })
      if (!res.ok) return null
      return res.json()
    }

    async function queueRestore(sessionId, items) {
      const token = await fangToken()
      if (!token) return { ok: false, error: 'auth-unavailable' }
      const res = await fetch('/fang/api/composer/queue', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fang-auth': token },
        body: JSON.stringify({
          sessionId,
          items: items.slice(0, 100).map((item) => ({ text: String(item?.text ?? '').slice(0, 4000) })),
        }),
      })
      let body = null
      try { body = await res.json() } catch { /* non-json */ }
      if (!res.ok) return { ok: false, error: body?.error || 'http-' + res.status, detail: body?.detail || '' }
      return { ok: true, queued: Number(body?.queued) || 0, failed: Number(body?.failed) || 0 }
    }

    function findComposer() {
      const nodes = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
        .filter((el) => {
          if (el.closest?.('[data-fang-entry]')) return false
          const r = el.getBoundingClientRect()
          return r.width > 80 && r.height > 16
        })
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

    function setDraftViaApi(props, text) {
      try {
        if (props?.inputActions && typeof props.inputActions.setDraft === 'function') {
          props.inputActions.setDraft(String(text || ''))
          return true
        }
      } catch { /* fall back to the DOM */ }
      return writeComposer(String(text || ''))
    }

    const QUEUE_COUNT_RE = /(\d+)\s*(条排队消息|queued messages|件のキュー済みメッセージ|mensagens na fila|messages en file d'attente|nachrichten in der warteschlange|сообщения в очереди|mensajes en cola|mensagens na fila)/i
    const QUEUE_ACTION_LABELS = /^(插话发送|编辑排队消息|删除排队消息|保存排队消息|取消编辑|发送中…|排队消息图片|queued message image|edit queued message|remove queued message|save queued message|cancel edit|sending…|steer)$/i

    /** 从 QueueDock 行里去掉操作按钮，只留消息正文。 */
    function queueRowText(row) {
      try {
        const clone = row.cloneNode(true)
        for (const node of clone.querySelectorAll('button, [role="button"]')) node.remove()
        const lines = String(clone.innerText || clone.textContent || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !QUEUE_ACTION_LABELS.test(line))
        return lines.join(' ').trim()
      } catch { return '' }
    }

    /**
     * DSH QueueDock 的 CSS 是 hashed class（F07MqG_*），不能靠 class*=queue。
     * 以 header 的“N 条排队消息”文案定位，再通过 aria-controls 找到列表。
     */
    function scanQueueDock() {
      const out = []
      const seen = new Set()
      const pushText = (text) => {
        const value = String(text || '').trim()
        if (!value || value.length > 4000 || seen.has(value)) return
        seen.add(value)
        out.push({ text: value, at: Date.now() })
      }
      // DSH 自带 QueueDock 的稳定锚点：data-queue-dock；每行是 li。
      const docks = document.querySelectorAll('[data-queue-dock]')
      for (const dock of docks) {
        for (const row of dock.querySelectorAll('li')) pushText(queueRowText(row))
      }
      if (docks.length > 0) return out

      // 兼容：通过 header 的“N 条排队消息”文案 + aria-controls 定位。
      const headers = [...document.querySelectorAll('button[aria-controls], [role="button"][aria-controls]')]
        .filter((el) => QUEUE_COUNT_RE.test(String(el.textContent || '')))
      for (const header of headers) {
        const listId = header.getAttribute('aria-controls')
        const list = (listId ? document.getElementById(listId) : null) || header.parentElement?.querySelector('ul')
        if (!list) continue
        for (const row of list.querySelectorAll('li')) pushText(queueRowText(row))
      }
      return out
    }

    function scanQueue() {
      const found = scanQueueDock()
      if (found.length > 0) return found.slice(-100)
      // 旧 DOM / 自定义队列仍走宽松选择器
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

    function JournalDock(props) {
      const sessionId = String(props?.sessionId || '')
      const [entry, setEntry] = React.useState(null)
      const [status, setStatus] = React.useState('')
      const [showQueue, setShowQueue] = React.useState(false)

      React.useEffect(() => {
        activeSessionId = sessionId
        activeKey = sessionId || sessionKey()
        setEntry(null)
        setShowQueue(false)
        let alive = true
        journalRequest('GET').then(async (body) => {
          let found = body?.entry ?? null
          // Migration: older builds keyed everything under "/".
          if (!found && activeKey !== '/') {
            const legacy = await journalRequest('GET', null, '/').catch(() => null)
            found = legacy?.entry ?? null
          }
          if (alive) setEntry(found)
        }).catch(() => {})
        return () => { alive = false }
      }, [sessionId])

      if (!entry || (!entry.draft && !(entry.queue || []).length)) return null

      const queue = Array.isArray(entry.queue) ? entry.queue : []
      const restoreAll = async () => {
        const draft = String(entry.draft || '')
        const draftOk = draft ? setDraftViaApi(props, draft) : true
        if (!draftOk) {
          setStatus('未找到输入框，请先打开会话')
          return
        }
        if (queue.length > 0) {
          if (!sessionId) {
            setStatus('草稿已恢复；队列需要先选中会话')
            return
          }
          const restored = await queueRestore(sessionId, queue)
          if (!restored.ok) {
            setStatus(restored.error === 'session-not-live'
              ? '草稿已恢复；会话未运行，队列保留待重试'
              : '草稿已恢复；队列恢复失败：' + restored.error)
            return
          }
          await journalRequest('POST', { draft: '', queue: [] })
          setEntry(null)
          setStatus(`已恢复草稿，并把 ${restored.queued} 条排队消息放回官方队列${restored.failed ? `（${restored.failed} 条失败）` : ''}`)
          return
        }
        await journalRequest('POST', { draft: '', queue: [] })
        setEntry(null)
        setStatus('草稿已放入官方输入框')
      }

      const clear = async () => {
        await journalRequest('POST', { draft: '', queue: [] })
        setEntry(null)
        setStatus('已清除记录')
      }

      const rowText = (item) => {
        const text = String(item?.text || '').replace(/\s+/g, ' ').trim()
        return text.length > 140 ? text.slice(0, 137) + '…' : text
      }

      return h('div', {
        'data-fang-entry': 'queue-journal',
        style: {
          display: 'inline-flex', flexDirection: 'column', gap: 6, margin: '2px 0', maxWidth: '100%',
          padding: '3px 6px', border: '1px solid rgba(127,127,127,.3)', borderRadius: 9,
          fontSize: 12, background: 'rgba(127,127,127,.06)',
        },
      },
      h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h('button', {
          type: 'button',
          title: `恢复草稿${queue.length ? `，并把这 ${queue.length} 条排队消息放回官方输入队列` : ''}`,
          'aria-label': '恢复全部草稿与队列',
          onClick: () => { void restoreAll() },
          style: { height: 26, padding: '0 8px', borderRadius: 7, cursor: 'pointer' },
        }, queue.length ? `恢复全部 (${queue.length + (entry.draft ? 1 : 0)})` : '恢复草稿'),
        queue.length > 0 ? h('button', {
          type: 'button',
          title: '展开保存的排队消息列表',
          'aria-expanded': showQueue ? 'true' : 'false',
          onClick: () => setShowQueue((value) => !value),
          style: { height: 26, padding: '0 8px', borderRadius: 7, cursor: 'pointer' },
        }, `队列 ${queue.length}`) : null,
        h('button', {
          type: 'button', title: '清除本地保存的草稿与排队快照', 'aria-label': '清除草稿',
          onClick: () => { void clear() },
          style: { height: 26, padding: '0 8px', borderRadius: 7, cursor: 'pointer' },
        }, '清除'),
      ),
      showQueue && queue.length > 0 ? h('div', {
        role: 'list',
        style: { display: 'grid', gap: 4, maxHeight: 180, overflow: 'auto', padding: '2px 0' },
      }, ...queue.map((item, index) => h('div', {
        role: 'listitem',
        key: `${index}:${item?.at || ''}`,
        title: String(item?.text || ''),
        style: { padding: '3px 6px', border: '1px solid rgba(127,127,127,.22)', borderRadius: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      }, `${index + 1}. ${rowText(item)}`))) : null,
      h('span', {
        role: 'status', 'aria-live': 'polite',
        style: status ? { padding: '1px 2px', opacity: .8 } : { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' },
      }, status))
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
