// SPDX-License-Identifier: AGPL-3.0-or-later
// Composer journal (v0.1.5): 持久化未发送草稿 + 官方排队队列的只读镜像，
// 通过 fang HTTP API 落盘；恢复必须由用户显式点击，插件本身永不发送消息。
//
// v0.1.5 修复「队列必丢」：
//   1) journal key 不再塌缩到 "/"：优先 slot 的 SessionId，其次页面探测，
//      最后退化为「本页实例键」（写进 sessionStorage，跨刷新稳定），绝不共用 "/"；
//   2) 队列变化即写：MutationObserver 盯 [data-queue-dock] + 15s 兜底 + 关闭前 flush；
//   3) 恢复 UI 增加「历史快照」：即使主 journal 被覆盖，也能从 append-only 历史里挑一份恢复；
//   4) 写入后回读校验：发现乱码（"????" 且原文含非 ASCII）会标记并重试一次；
//   5) 服务端有 /fang/api/composer/journal/history，按会话过滤。
window.__ModuleLoader__.load({
  id: '@twinsearth/dsh-fang-queue-journal',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const DEBOUNCE_MS = 250
    const FALLBACK_MS = 15_000

    /** 从 URL 里尝试取会话 id（兼容多种路由形态）。 */
    function sessionKeyFromUrl() {
      const hash = String(location.hash || '').replace(/^#/, '')
      const fromHash = /sessions?\/([^/?#]+)/.exec(hash)
      const fromPath = /sessions?\/([^/?#]+)/.exec(location.pathname)
      const q = new URLSearchParams(location.search).get('session') || new URLSearchParams(location.search).get('sessionId')
      return String(q || fromHash?.[1] || fromPath?.[1] || '').slice(0, 200)
    }

    /** 从 DOM 上找宿主暴露的会话 id（DSH 可能在容器上打 data 属性）。 */
    function sessionKeyFromDom() {
      const selectors = ['[data-session-id]', '[data-sessionid]', '[data-current-session]', '[data-active-session]']
      for (const selector of selectors) {
        const el = document.querySelector(selector)
        const value = el?.getAttribute(selector.replace(/[[\]]/g, '').split('=')[0]) || ''
        const attr = selector.slice(1, -1)
        const v = el?.getAttribute(attr)
        if (v) return String(v).slice(0, 200)
      }
      return ''
    }

    /** 本页实例键：sessionStorage 里稳定存在，避免多会话挤在同一个 key。 */
    function instanceKey() {
      try {
        const cached = sessionStorage.getItem('fang-queue-journal-instance')
        if (cached) return cached
        const generated = 'page:' + Math.random().toString(36).slice(2, 10) + ':' + Date.now().toString(36)
        sessionStorage.setItem('fang-queue-journal-instance', generated)
        return generated
      } catch { return 'page:unknown' }
    }

    let activeKey = ''
    let activeSessionId = ''
    function resolveKey() {
      // 优先级：slot 给的 SessionId > DOM > URL > 本页实例键（绝不使用 "/"）
      if (activeSessionId) return activeSessionId
      const fromUrl = sessionKeyFromUrl()
      const fromDom = sessionKeyFromDom()
      const key = String(fromDom || fromUrl || instanceKey())
      activeKey = key === '/' || key === '' ? instanceKey() : key
      return activeKey
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
      const key = keyOverride || resolveKey()
      const res = await fetch(method === 'POST' ? '/fang/api/composer/journal' : '/fang/api/composer/journal?key=' + encodeURIComponent(key), {
        method,
        headers: { 'content-type': 'application/json', 'x-fang-auth': token },
        body: method === 'POST'
          ? JSON.stringify({ key, sessionId: activeSessionId || undefined, sessionKey: key, path: location.hash || location.pathname, ...entry })
          : undefined,
      })
      if (!res.ok) return null
      try { return await res.json() } catch { return null }
    }

    async function journalHistory(limit = 10) {
      const token = await fangToken()
      if (!token) return []
      try {
        const res = await fetch('/fang/api/composer/journal/history?limit=' + Number(limit) + '&sessionKey=' + encodeURIComponent(resolveKey()), {
          headers: { accept: 'application/json', 'x-fang-auth': token },
        })
        if (!res.ok) return []
        const body = await res.json()
        return Array.isArray(body?.items) ? body.items : []
      } catch { return [] }
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
    const QUEUE_ACTION_LABELS = /^(插话发送|编辑排队消息|删除排队消息|保存排队消息|取消编辑|发送中…|排队消息图片|queued message image|edit queued message|remove queued message|save queued message|cancel edit|sending…|steer|恢复全部|恢复草稿|队列 \d+|历史 \d+|清除)$/i

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
      const docks = document.querySelectorAll('[data-queue-dock]')
      for (const dock of docks) {
        for (const row of dock.querySelectorAll('li')) pushText(queueRowText(row))
      }
      if (docks.length > 0) return out

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

    /** v3.1.22：排除瓮城自己的 UI（恢复条/历史条），否则按钮文案会被误当成排队消息。 */
    function insideFangOwnUi(el) {
      try { return Boolean(el?.closest?.('[data-fang-entry]')) } catch { return false }
    }

    function scanQueue() {
      const found = scanQueueDock()
      const cleaned = found.filter((item) => String(item?.text || '').trim())
      if (cleaned.length > 0) return cleaned.slice(-100)
      if (found.length > 0) return found.slice(-100)
      const seen = new Set()
      const out = []
      const nodes = document.querySelectorAll('[class*="queue" i], [data-testid*="queue" i], [aria-label*="queue" i], [class*="pending" i], [data-testid*="pending" i], [aria-label*="排队"], [title*="排队"]')
      for (const el of nodes) {
        if (insideFangOwnUi(el)) continue
        const text = String(el.innerText || '').trim()
        if (!text || text.length > 4000 || seen.has(text)) continue
        seen.add(text)
        out.push({ text, at: Date.now() })
      }
      return out.slice(-100)
    }

    /** 回读校验：确认服务端存下来的队列文本与本地一致（并检测 "????" 乱码）。 */
    async function verifySaved(expectedQueue) {
      const body = await journalRequest('GET')
      const saved = Array.isArray(body?.entry?.queue) ? body.entry.queue.map((item) => String(item?.text || '')) : []
      const expected = expectedQueue.map((item) => String(item?.text || ''))
      const sameLength = saved.length === expected.length
      const sameText = sameLength && saved.every((text, index) => text === expected[index])
      const looksMojibake = saved.some((text) => /\?{3,}/.test(text) && !/\?{3,}/.test(expected[saved.indexOf(text)] || ''))
      return { ok: sameText && !looksMojibake, sameLength, sameText, looksMojibake, saved }
    }

    function JournalDock(props) {
      const sessionId = String(props?.sessionId || '')
      const [entry, setEntry] = React.useState(null)
      const [history, setHistory] = React.useState([])
      const [status, setStatus] = React.useState('')
      const [showQueue, setShowQueue] = React.useState(false)
      const [showHistory, setShowHistory] = React.useState(false)

      React.useEffect(() => {
        activeSessionId = sessionId
        setEntry(null)
        setShowQueue(false)
        setShowHistory(false)
        let alive = true
        journalRequest('GET').then(async (body) => {
          if (alive) setEntry(body?.entry ?? null)
        }).catch(() => {})
        journalHistory(10).then((items) => { if (alive) setHistory(items) }).catch(() => {})
        return () => { alive = false }
      }, [sessionId])

      const queue = Array.isArray(entry?.queue) ? entry.queue : []
      const hasEntry = Boolean(entry && (entry.draft || queue.length))

      if (!hasEntry && history.length === 0) return null

      const restoreItems = async (items, draft) => {
        const draftText = String(draft || '')
        const draftOk = draftText ? setDraftViaApi(props, draftText) : true
        if (!draftOk) { setStatus('未找到输入框，请先打开会话'); return }
        if (items.length === 0) {
          await journalRequest('POST', { draft: '', queue: [] })
          setEntry(null)
          setStatus('草稿已放入官方输入框')
          return
        }
        if (!sessionId) { setStatus('草稿已恢复；队列需要先选中会话'); return }
        const restored = await queueRestore(sessionId, items)
        if (!restored.ok) {
          setStatus(restored.error === 'session-not-live'
            ? '草稿已恢复；会话未运行，队列保留待重试'
            : '草稿已恢复；队列恢复失败：' + restored.error)
          return
        }
        await journalRequest('POST', { draft: '', queue: [] })
        setEntry(null)
        setStatus(`已恢复 ${restored.queued} 条排队消息${restored.failed ? `（${restored.failed} 条失败）` : ''}`)
      }

      const rowText = (item) => {
        const text = String(item?.text || '').replace(/\s+/g, ' ').trim()
        return text.length > 140 ? text.slice(0, 137) + '…' : text
      }

      const snapshotLabel = (snap) => {
        const at = String(snap?.updatedAt || '')
        const count = Array.isArray(snap?.queue) ? snap.queue.length : 0
        return `${at ? at.replace('T', ' ').slice(0, 16) : '?'} · ${count} 条`
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
        hasEntry ? h('button', {
          type: 'button',
          title: `恢复草稿${queue.length ? `，并把这 ${queue.length} 条排队消息放回官方输入队列` : ''}`,
          'aria-label': '恢复全部草稿与队列',
          onClick: () => { void restoreItems(queue, entry?.draft) },
          style: { height: 26, padding: '0 8px', borderRadius: 7, cursor: 'pointer' },
        }, queue.length ? `恢复全部 (${queue.length + (entry?.draft ? 1 : 0)})` : '恢复草稿') : null,
        hasEntry && queue.length > 0 ? h('button', {
          type: 'button', title: '展开保存的排队消息列表', 'aria-expanded': showQueue ? 'true' : 'false',
          onClick: () => setShowQueue((value) => !value),
          style: { height: 26, padding: '0 8px', borderRadius: 7, cursor: 'pointer' },
        }, `队列 ${queue.length}`) : null,
        history.length > 0 ? h('button', {
          type: 'button', title: '从历史快照中挑选一份恢复（主记录被覆盖时的兜底）',
          'aria-expanded': showHistory ? 'true' : 'false',
          onClick: () => setShowHistory((value) => !value),
          style: { height: 26, padding: '0 8px', borderRadius: 7, cursor: 'pointer' },
        }, `历史 ${history.length}`) : null,
        hasEntry ? h('button', {
          type: 'button', title: '清除本地保存的草稿与排队快照', 'aria-label': '清除草稿',
          onClick: async () => { await journalRequest('POST', { draft: '', queue: [] }); setEntry(null); setStatus('已清除记录') },
          style: { height: 26, padding: '0 8px', borderRadius: 7, cursor: 'pointer' },
        }, '清除') : null,
      ),
      showQueue && queue.length > 0 ? h('div', {
        role: 'list', style: { display: 'grid', gap: 4, maxHeight: 180, overflow: 'auto', padding: '2px 0' },
      }, ...queue.map((item, index) => h('div', {
        role: 'listitem', key: `${index}:${item?.at || ''}`, title: String(item?.text || ''),
        style: { padding: '3px 6px', border: '1px solid rgba(127,127,127,.22)', borderRadius: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      }, `${index + 1}. ${rowText(item)}`))) : null,
      showHistory && history.length > 0 ? h('div', {
        role: 'list', style: { display: 'grid', gap: 4, maxHeight: 200, overflow: 'auto', padding: '2px 0' },
      }, ...history.slice(0, 10).map((snap, index) => h('div', {
        role: 'listitem', key: `h${index}:${snap?.updatedAt || ''}`,
        style: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px', border: '1px solid rgba(127,127,127,.22)', borderRadius: 6 },
      }, h('span', { style: { flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, snapshotLabel(snap)),
      h('button', {
        type: 'button', title: '把这份快照里的队列放回官方队列',
        onClick: async () => { await restoreItems(Array.isArray(snap?.queue) ? snap.queue : [], '') },
        style: { height: 22, padding: '0 6px', borderRadius: 6, cursor: 'pointer' },
      }, '恢复')))) : null,
      h('span', {
        role: 'status', 'aria-live': 'polite',
        style: status ? { padding: '1px 2px', opacity: .8 } : { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' },
      }, status))
    }

    let saveTimer = null
    let lastSignature = ''
    let flushTimer = null

    function commitSave() {
      const text = readComposer(findComposer())
      const queue = scanQueue()
      const signature = JSON.stringify({ key: resolveKey(), text, queue: queue.map((item) => item.text) })
      if (signature === lastSignature) return
      lastSignature = signature
      void (async () => {
        const saved = await journalRequest('POST', { draft: text, queue })
        if (!saved) return
        const check = await verifySaved(queue)
        if (!check.ok) {
          // 回读不一致（或被截断/乱码）：重试一次，并把诊断留在控制台
          try { window.console?.warn?.('[fang-queue-journal] 回读校验未通过', check) } catch { /* ignore */ }
          const retried = await journalRequest('POST', { draft: text, queue })
          if (retried) await verifySaved(queue)
        }
      })()
    }

    function scheduleSave() {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => { saveTimer = null; commitSave() }, DEBOUNCE_MS)
    }

    /** 关闭/切页前同步 flush：fetch keepalive 保证请求活着离开页面。 */
    function flushNow() {
      const text = readComposer(findComposer())
      const queue = scanQueue()
      const signature = JSON.stringify({ key: resolveKey(), text, queue: queue.map((item) => item.text) })
      if (signature === lastSignature) return
      lastSignature = signature
      void (async () => {
        const token = await fangToken()
        if (!token) return
        try {
          fetch('/fang/api/composer/journal', {
            method: 'POST',
            keepalive: true,
            headers: { 'content-type': 'application/json', 'x-fang-auth': token },
            body: JSON.stringify({ key: resolveKey(), sessionKey: resolveKey(), sessionId: activeSessionId || undefined, draft: text, queue, path: location.hash || location.pathname }),
          })
        } catch { /* ignore */ }
      })()
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'fang-queue-journal',
          order: 90,
        }, JournalDock))

        // ① 草稿输入：捕获阶段监听，避免被宿主 stopPropagation 吞掉
        document.addEventListener('input', (event) => {
          const target = event.target
          if (!target || (target.tagName !== 'TEXTAREA' && target.getAttribute?.('contenteditable') !== 'true')) return
          scheduleSave()
        }, true)

        // ② 队列变化：只盯 QueueDock（body 全量只用 childList，避免 characterData 风暴）
        try {
          const queueObserver = new MutationObserver(() => scheduleSave())
          queueObserver.observe(document.body, { childList: true, subtree: true })
          // 有 [data-queue-dock] 时再额外盯 characterData（行文本可能原地更新）
          const docksObserver = new MutationObserver(() => scheduleSave())
          for (const dock of document.querySelectorAll('[data-queue-dock]')) {
            docksObserver.observe(dock, { childList: true, subtree: true, characterData: true })
          }
          queueObserver.__docksObserver = docksObserver
        } catch { /* DOM unavailable */ }

        // ③ 15s 兜底（覆盖“宿主重渲染后新 dock 未被观察到”的情况）
        flushTimer = setInterval(() => scheduleSave(), FALLBACK_MS)
        try { flushTimer?.unref?.() } catch { /* browser timer */ }

        // ④ 关闭/切页前 flush
        const onPageHide = () => flushNow()
        const onVisibility = () => { if (document.visibilityState === 'hidden') flushNow() }
        window.addEventListener('pagehide', onPageHide)
        document.addEventListener('visibilitychange', onVisibility)
        window.addEventListener('beforeunload', onPageHide)
      },
    }
  },
})
