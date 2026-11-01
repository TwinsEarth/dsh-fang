// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang v2.1.0 Client 半 ——「瓮城」的可见入口。
//
// 三处入口（同一个 Client 模块，同一个门禁行 @local/dsh-fang）：
//   1) 左侧导航栏 sidebar.panellist：红色城门图标 + 「瓮城」，单击由外壳 selectPanel 打开面板；
//      双击图标 = 快速派生（把 5–20s 的等待变成一次双击，面板里给结果卡兜底）。
//   2) main 面板 key='fang'：任务 + 母体已有会话的「选中 → 确认 → 继续开发」两段式。
//   3) 输入框 dock 徽标：单击开面板、双击快速派生（导航行没有 tooltip，可发现性放在这里）。
//
// 事实约束（2026-11-01 实测 Slots 拓扑）：
//   * sidebar.panellist 的登记项只接收 {id, order, label}；图标 = 登记项组件本身
//     （外壳 renderSlot('sidebar.panellist', {size, active}, {only:id})），所以红门图标可行。
//   * 行点击归外壳所有（onClick → selectPanel），插件不能接管单击；双击只能在图标这一层挂。
//   * 面板组件从 main 的标准 props 拿 useSessions 等 hooks；这里仍用 /fang/api/* 拉数据，
//     避免依赖未文档化的 hook 形状。
window.__ModuleLoader__.load({
  id: '@local/dsh-fang',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    // ── 视觉常量（颜色只用宿主 token，红色是插件艺术色）────────────────────
    const ACCENT = 'var(--fang-gate-accent, #C62828)'
    const TEXT = 'var(--dsw-alias-label-primary, var(--dsh-text-primary, #1f2328))'
    const TEXT2 = 'var(--dsw-alias-label-secondary, var(--dsh-text-secondary, #6b7280))'
    const BORDER = 'var(--dsw-alias-border, var(--dsh-border, rgba(127,127,127,.28)))'
    const SURFACE = 'var(--dsw-alias-surface, transparent)'
    const FONT = 'inherit'
    const MONO = 'var(--ds-font-family-code, ui-monospace, Consolas, monospace)'

    const short = (s, n = 8) => String(s ?? '').slice(-n)
    // 会话标题：优先原生 session/title；其次首条用户消息预览；最后才用工作区名（并如实标注来源）
    const sessionLabel = (s) => {
      const title = String(s.title ?? '').trim()
      const source = s.titleSource ?? ''
      if (title && source === 'session/title') return title
      if (s.preview) return String(s.preview)
      if (title) return title
      return s.workspaceTitle || '未命名会话'
    }
    const sessionSourceHint = (s) => {
      const source = s.titleSource ?? ''
      if (source === 'session/title') return ''
      if (source === 'first-user') return ' · 首条消息'
      if (source === 'workspace') return ' · 工作区名'
      return ''
    }
    const fmtTime = (ms) => {
      if (!ms) return '—'
      try { return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) } catch { return '—' }
    }

    // ── 单模块级状态：徽标 / 图标 / 面板共享同一次派生 ──────────────────────
    const state = {
      derive: null,           // 最近一次派生结果 { ok, taskId, url, error, at }
      inflight: null,         // 进行中的 Promise（单飞：双击多次只派生一个）
      listeners: new Set(),
      lastGesture: 0,
      notify() { for (const fn of [...this.listeners]) { try { fn(this.derive) } catch { /* ignore */ } } },
    }
    function subscribe(fn) {
      state.listeners.add(fn)
      return () => state.listeners.delete(fn)
    }

    async function api(path, options) {
      const res = await fetch(path, {
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        ...(options ?? {}),
      })
      let body = null
      try { body = await res.json() } catch { body = { ok: false, error: 'bad-json' } }
      return { status: res.status, body }
    }

    /** 快速派生：双击图标/徽标触发；单飞 + 2s 冷却，结果进共享 store。 */
    function quickDerive(title) {
      const now = Date.now()
      if (now - state.lastGesture < 2000) return state.inflight ?? Promise.resolve(state.derive)
      state.lastGesture = now
      if (state.inflight) return state.inflight
      state.derive = { pending: true, at: now, title }
      state.notify()
      const run = (async () => {
        try {
          const { body } = await api('/fang/api/derive', {
            method: 'POST',
            body: JSON.stringify({ title: title || '快速派生' }),
          })
          if (body?.ok) {
            state.derive = { ok: true, taskId: body.taskId, url: body.url, port: body.port, adapter: body.adapter, at: Date.now() }
            try { if (body.url) window.open(body.url, '_blank', 'noopener') } catch { /* popup blocked → 面板结果卡兜底 */ }
          } else {
            state.derive = { ok: false, error: body?.error ?? 'derive-failed', detail: body?.detail ?? '', at: Date.now() }
          }
        } catch (e) {
          state.derive = { ok: false, error: 'network', detail: String(e?.message ?? e), at: Date.now() }
        } finally {
          state.inflight = null
          state.notify()
        }
        return state.derive
      })()
      state.inflight = run
      return run
    }

    /** 双击判定：400ms 窗口、6px 位移容差、修饰键不成立；命中后触发 quickDerive。 */
    function makeDoubleTap(onDouble) {
      let first = null
      return (event) => {
        if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return
        const now = Date.now()
        const point = { x: event.clientX, y: event.clientY }
        if (first && now - first.t <= 400 && Math.abs(first.x - point.x) <= 6 && Math.abs(first.y - point.y) <= 6) {
          first = null
          try { event.preventDefault(); event.stopPropagation() } catch { /* ignore */ }
          onDouble(event)
        } else {
          first = { t: now, x: point.x, y: point.y }
        }
      }
    }

    // ── 红色城门图标：瓮圈(红) + 门洞(currentColor) + 门基(弱化) ──────────────
    function GateGlyph({ size = 18, active, onDoubleClick }) {
      const s = Math.max(14, Math.min(22, Number(size) || 18))
      const handle = useMemo(() => makeDoubleTap(() => quickDerive('双击快速派生')), [])
      return h('span', {
        onDoubleClick: (e) => { handle(e); if (onDoubleClick) onDoubleClick(e) },
        title: '瓮城：单击打开面板，双击快速派生分身',
        style: { display: 'inline-flex', width: s, height: s, alignItems: 'center', justifyContent: 'center' },
      }, h('svg', {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
        strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: 'false',
        style: { opacity: active ? 1 : 0.92 },
      },
      h('path', { d: 'M4.25 20V11.5a7.75 7.75 0 0 1 15.5 0V20', stroke: ACCENT, strokeWidth: active ? 2 : 1.75 }),
      h('path', { d: 'M9.5 20v-5.5a2.5 2.5 0 0 1 5 0V20', stroke: 'currentColor', strokeWidth: 1.75 }),
      h('path', { d: 'M2.75 20h18.5', stroke: 'currentColor', strokeWidth: 1.75, opacity: 0.55 })))
    }

    // ── 面板：瓮城控制台 ──────────────────────────────────────────────────
    function Chip({ children, tone }) {
      return h('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '1px 8px', borderRadius: 999, border: `1px solid ${BORDER}`,
          fontSize: 12, lineHeight: '18px', color: tone || TEXT2, whiteSpace: 'nowrap',
        },
      }, children)
    }

    function Btn({ children, onClick, primary, disabled, title }) {
      return h('button', {
        type: 'button', onClick, disabled: !!disabled, title,
        style: {
          font: FONT, fontSize: 13, padding: '5px 12px', borderRadius: 8, cursor: disabled ? 'default' : 'pointer',
          border: `1px solid ${primary ? 'transparent' : BORDER}`,
          background: primary ? 'var(--dsw-alias-button-primary, #2563eb)' : 'transparent',
          color: primary ? '#fff' : TEXT, opacity: disabled ? 0.5 : 1,
        },
      }, children)
    }

    function Row({ children, selected, onClick }) {
      return h('div', {
        role: onClick ? 'button' : undefined,
        tabIndex: onClick ? 0 : undefined,
        onClick,
        onKeyDown: onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e) } } : undefined,
        style: {
          display: 'flex', alignItems: 'center', gap: 12, minHeight: 52, padding: '10px 14px',
          borderBottom: `1px solid ${BORDER}`, cursor: onClick ? 'pointer' : 'default',
          background: selected ? 'var(--dsw-alias-surface-raised, rgba(127,127,127,.08))' : 'transparent',
          borderLeft: selected ? `2px solid ${ACCENT}` : '2px solid transparent',
        },
      }, children)
    }

    // ── 控制面板：3:7 分屏（左=母体项目&会话，右=分身项目&会话）───────────────
    /** 按工作区把会话分组（组 = 项目），组内按更新时间倒序。 */
    const groupSessionsByWorkspace = (items) => {
      const groups = new Map()
      for (const item of items) {
        const key = item.workspaceId || item.workspaceKey || item.workspaceTitle || 'unknown'
        if (!groups.has(key)) {
          groups.set(key, {
            key,
            title: item.workspaceTitle || '未命名项目',
            path: item.workspacePath || '',
            sessions: [],
          })
        }
        groups.get(key).sessions.push(item)
      }
      const out = [...groups.values()]
      for (const group of out) group.sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      return out.sort((a, b) => String(a.title).localeCompare(String(b.title)))
    }

    function FangPanel() {
      const [status, setStatus] = useState({ state: 'loading', data: null, error: '' })
      const [sessions, setSessions] = useState({ state: 'loading', items: [], error: '' })
      const [tasks, setTasks] = useState({ state: 'loading', items: [] })
      const [forkSessions, setForkSessions] = useState({})
      const [selected, setSelected] = useState(null)
      const [derive, setDerive] = useState(state.derive)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const [collapsed, setCollapsed] = useState(() => new Set())

      const refresh = useCallback(async () => {
        const [s, t, sess] = await Promise.all([
          api('/fang/api/status').catch((e) => ({ status: 0, body: { error: String(e?.message ?? e) } })),
          api('/fang/api/tasks').catch(() => ({ status: 0, body: { tasks: [] } })),
          api('/fang/api/sessions').catch(() => ({ status: 0, body: { sessions: [] } })),
        ])
        if (s.status === 200 && s.body?.ok !== false) setStatus({ state: 'ready', data: s.body, error: '' })
        else setStatus({ state: 'error', data: null, error: s.body?.error ?? 'status-unavailable' })
        const taskItems = Array.isArray(t.body?.tasks) ? t.body.tasks : []
        setTasks({ state: 'ready', items: taskItems })
        const sessionItems = Array.isArray(sess.body?.sessions) ? sess.body.sessions : []
        setSessions({ state: sess.status === 200 ? 'ready' : 'error', items: sessionItems, error: sess.body?.error ?? '' })
        // 右栏：每个分身自己的会话（只对 ready/running 的分身拉取；失败只影响该分身）
        const activeTasks = taskItems.filter((x) => x.status === 'ready' || x.status === 'running')
        const results = await Promise.allSettled(activeTasks.map(async (task) => {
          const res = await api('/fang/api/tasks/sessions?taskId=' + encodeURIComponent(task.taskId) + '&limit=20')
          return [task.taskId, {
            state: res.status === 200 ? 'ready' : 'error',
            items: Array.isArray(res.body?.sessions) ? res.body.sessions : [],
            error: res.body?.error ?? '',
          }]
        }))
        const map = {}
        for (const entry of results) if (entry.status === 'fulfilled') map[entry.value[0]] = entry.value[1]
        setForkSessions(map)
      }, [])

      useEffect(() => {
        refresh()
        const timer = setInterval(refresh, 5000)
        const off = subscribe(setDerive)
        return () => { clearInterval(timer); off() }
      }, [refresh])

      const startDerive = async (payload, label) => {
        setBusy(label)
        setNotice('')
        try {
          const { body } = await api('/fang/api/derive', { method: 'POST', body: JSON.stringify(payload) })
          if (body?.ok) {
            setNotice(`已派生：${body.taskId}${body.adapter?.ok ? '（Adapter 就绪）' : '（Adapter 未就绪）'}`)
            setSelected(null)
            if (body.url) try { window.open(body.url, '_blank', 'noopener') } catch { /* ignore */ }
            await refresh()
          } else {
            setNotice(`派生失败：${body?.error ?? 'unknown'}${body?.detail ? ' — ' + body.detail : ''}`)
          }
        } catch (e) {
          setNotice(`派生失败：${e?.message ?? e}`)
        } finally { setBusy('') }
      }

      const archiveTask = async (taskId) => {
        if (!window.confirm('归档该任务？会先 flush 分身缓冲并落审计，再删除 $DSH_HOME。')) return
        setBusy('archive:' + taskId)
        const { body } = await api('/fang/api/tasks/archive', { method: 'POST', body: JSON.stringify({ taskId }) })
        setNotice(body?.ok ? `已归档 ${taskId}` : `归档失败：${body?.error ?? 'unknown'}`)
        setBusy('')
        await refresh()
      }

      const toggleTask = (taskId) => {
        setCollapsed((prev) => {
          const next = new Set(prev)
          if (next.has(taskId)) next.delete(taskId)
          else next.add(taskId)
          return next
        })
      }

      const data = status.data
      const running = data?.tasks?.running ?? 0
      const ready = data?.tasks?.ready ?? 0
      const max = data?.tasks?.max ?? '?'
      const readyCount = `${ready}/${max}`

      // ── 左栏：母体项目 & 会话 ───────────────────────────────────────────
      const motherGroups = groupSessionsByWorkspace(sessions.items)
      const motherList = sessions.state === 'error'
        ? h('div', { style: { padding: '14px', fontSize: 13, color: TEXT2 } },
          `会话目录不可读：${sessions.error || 'unknown'}`, ' ',
          h(Btn, { onClick: refresh }, '重试'))
        : motherGroups.length === 0
          ? h('div', { style: { padding: '14px', fontSize: 13, color: TEXT2 } }, '还没有可继续的母体会话。开一个新对话后，它会出现在这里。')
          : motherGroups.map((group) => h('div', { key: 'g:' + group.key },
            h('div', {
              title: group.path || group.title,
              style: {
                padding: '8px 14px 4px', fontSize: 11, letterSpacing: '.04em', textTransform: 'uppercase',
                color: TEXT2, borderTop: '1px solid ' + BORDER, background: 'transparent',
              },
            }, `${group.title} · ${group.sessions.length}`),
            group.sessions.slice(0, 12).map((s) => h(Row, {
              key: 's:' + s.sessionId,
              selected: selected?.kind === 'mother-session' && selected.item.sessionId === s.sessionId,
              onClick: () => setSelected({ kind: 'mother-session', item: s }),
            },
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { title: s.title || s.preview || undefined, style: { fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, sessionLabel(s)),
              h('div', { style: { fontSize: 12, color: TEXT2, fontFamily: MONO } },
                `${short(s.sessionId, 12)} · ${fmtTime(s.updatedAt)}${sessionSourceHint(s)}${s.archived ? ' · 已归档' : ''}`)),
            h('span', { style: { fontSize: 12, color: TEXT2 } }, '选择')))))

      // ── 右栏：分身项目 & 会话 ──────────────────────────────────────────
      const taskBlock = (task) => {
        const isCollapsed = collapsed.has(task.taskId)
        const forks = forkSessions[task.taskId]
        const sessionRows = forks?.state === 'error'
          ? h('div', { style: { padding: '4px 14px 10px 34px', fontSize: 12, color: TEXT2 } }, `分身会话不可读：${forks.error || 'unknown'}`)
          : !forks
            ? h('div', { style: { padding: '4px 14px 10px 34px', fontSize: 12, color: TEXT2 } }, task.status === 'ready' || task.status === 'running' ? '读取分身会话…' : '（分身未运行）')
            : forks.items.length === 0
              ? h('div', { style: { padding: '4px 14px 10px 34px', fontSize: 12, color: TEXT2 } }, '这个分身还没有会话；打开后新开的对话会出现在这里。')
              : forks.items.map((s) => h('div', {
                key: task.taskId + ':' + s.sessionId,
                role: 'button',
                tabIndex: 0,
                onClick: () => setSelected({ kind: 'fork-session', item: s, task }),
                onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected({ kind: 'fork-session', item: s, task }) } },
                style: {
                  display: 'flex', gap: 10, alignItems: 'center', padding: '6px 14px 6px 34px', cursor: 'pointer',
                  borderTop: '1px dashed ' + BORDER,
                  background: selected?.kind === 'fork-session' && selected.item.sessionId === s.sessionId ? 'var(--dsw-alias-surface-raised, rgba(127,127,127,.08))' : 'transparent',
                },
              },
              h('span', { 'aria-hidden': true, style: { width: 6, height: 6, borderRadius: '50%', background: 'var(--dsw-alias-label-tertiary, #bbb)', flexShrink: 0 } }),
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { title: s.title || s.preview || undefined, style: { fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, sessionLabel(s)),
                h('div', { style: { fontSize: 11, color: TEXT2, fontFamily: MONO } },
                  `${short(s.sessionId, 12)} · ${fmtTime(s.updatedAt)}${sessionSourceHint(s)}`)),
              h('span', { style: { fontSize: 11, color: TEXT2 } }, '选择')))

        return h('div', { key: 't:' + task.taskId, style: { borderTop: '1px solid ' + BORDER } },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', padding: '8px 12px' } },
            h('button', {
              type: 'button', onClick: () => toggleTask(task.taskId),
              title: isCollapsed ? '展开分身会话' : '收起分身会话',
              style: { width: 20, height: 20, padding: 0, border: 'none', background: 'transparent', color: TEXT2, cursor: 'pointer', fontSize: 12 },
            }, isCollapsed ? '▸' : '▾'),
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { title: task.title, style: { fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, task.title),
              h('div', { style: { fontSize: 11, color: TEXT2, fontFamily: MONO } },
                `${short(task.taskId, 12)} · ${task.status} · 端口 ${task.port ?? '—'} · adapter ${task.adapter?.ok ? 'ready' : (task.adapter?.error || 'down')}`)),
            task.url ? h('a', { href: task.url, target: '_blank', rel: 'noopener', style: { fontSize: 12, color: 'inherit', textDecoration: 'underline' } }, '打开') : null,
            h(Btn, { onClick: () => archiveTask(task.taskId), disabled: !!busy }, '归档')),
          isCollapsed ? null : h('div', { style: { paddingBottom: 6 } }, sessionRows))
      }

      const rightList = tasks.items.length === 0
        ? h('div', { style: { padding: '14px', fontSize: 13, color: TEXT2 } }, '还没有分身。点右上「派生新分身」，或双击左侧瓮城图标快速派生。')
        : tasks.items.map(taskBlock)

      return h('div', {
        style: {
          height: '100%', display: 'flex', flexDirection: 'column', gap: 10,
          padding: '18px 22px', boxSizing: 'border-box', minHeight: 0,
          color: TEXT, font: FONT,
        },
      },
      // 门楣
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flexShrink: 0 } },
        h('span', { style: { display: 'inline-flex', width: 26, height: 26 } }, h(GateGlyph, { size: 22, active: true })),
        h('h1', { style: { margin: 0, fontSize: 19, fontWeight: 600 } }, '瓮城'),
        h(Chip, null, (data?.role ?? 'mother') === 'mother' ? '母体只读' : String(data?.role)),
        h(Chip, null, `${readyCount} 就绪`),
        h(Chip, null, `${running} 运行中`),
        h('span', { style: { flex: 1 } }),
        h(Btn, { primary: true, disabled: !!busy, onClick: () => startDerive({ title: '快速派生' }, 'derive') }, busy === 'derive' ? '派生中…' : '派生新分身'),
        h(Btn, { onClick: refresh, disabled: !!busy }, '刷新')),
      status.state === 'error'
        ? h('div', { style: { flexShrink: 0, padding: '6px 12px', border: '1px solid ' + BORDER, borderRadius: 8, color: TEXT2, fontSize: 13 } },
          `母体状态不可读 —— /fang/api/status: ${status.error}`, ' ', h(Btn, { onClick: refresh }, '重试'))
        : null,
      notice ? h('div', { style: { flexShrink: 0, fontSize: 12, color: TEXT2 } }, notice) : null,
      derive && !derive.pending && derive.ok
        ? h('div', { style: { flexShrink: 0, padding: '8px 12px', border: '1px solid ' + BORDER, borderLeft: '3px solid ' + ACCENT, borderRadius: 8, fontSize: 12, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', null, `分身已就绪 · 端口 ${derive.port ?? '—'}`),
          derive.url ? h('a', { href: derive.url, target: '_blank', rel: 'noopener', style: { color: 'inherit' } }, '打开分身 ↗') : null,
          h(Btn, { onClick: () => { state.derive = null; state.notify() } }, '知道了'))
        : null,

      // 3:7 分屏：左=母体，右=分身；各栏独立滚动
      h('div', { style: { flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0,3fr) minmax(0,7fr)', gap: 12 } },
        h('section', {
          style: { display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, border: '1px solid ' + BORDER, borderRadius: 10, overflow: 'hidden', background: SURFACE },
        },
        h('div', { style: { flexShrink: 0, padding: '9px 14px', borderBottom: '1px solid ' + BORDER, display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { fontSize: 13, fontWeight: 600 } }, '母体 · 项目 & 会话'),
          h('span', { style: { fontSize: 11, color: TEXT2 } }, '只读'),
          h('span', { style: { flex: 1 } }),
          h(Chip, null, `${sessions.items.length} 会话`)),
        h('div', { style: { flex: 1, minHeight: 0, maxHeight: 'calc(100vh - 260px)', overflowY: 'auto' } }, motherList)),
        h('section', {
          style: { display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, border: '1px solid ' + BORDER, borderRadius: 10, overflow: 'hidden', background: SURFACE },
        },
        h('div', { style: { flexShrink: 0, padding: '9px 14px', borderBottom: '1px solid ' + BORDER, display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { fontSize: 13, fontWeight: 600 } }, '分身 · 项目 & 会话'),
          h('span', { style: { fontSize: 11, color: TEXT2 } }, '每个任务一个项目'),
          h('span', { style: { flex: 1 } }),
          h(Chip, null, `${tasks.items.length} 项目`)),
        h('div', { style: { flex: 1, minHeight: 0, maxHeight: 'calc(100vh - 260px)', overflowY: 'auto' } }, rightList))),

      // 选中确认条（两段式：先选，再确认）
      selected
        ? h('div', { style: { flexShrink: 0, padding: '10px 14px', border: '1px solid ' + BORDER, borderLeft: '3px solid ' + ACCENT, borderRadius: 8, background: 'transparent' } },
          h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
            h('div', { style: { flex: 1, minWidth: 200, fontSize: 12 } },
              selected.kind === 'mother-session'
                ? `继续「${sessionLabel(selected.item)}」：将派生 1 个分身并注入 ≤32KiB 摘要种子（lineage，不改母体会话）。`
                : `继续「${sessionLabel(selected.item)}」：该会话属于分身「${selected.task?.title ?? ''}」，将在该分身标签页里继续。`),
            h(Btn, { onClick: () => setSelected(null) }, '取消'),
            selected.kind === 'mother-session'
              ? h(Btn, {
                primary: true,
                disabled: !!busy,
                onClick: () => startDerive({ sessionId: selected.item.sessionId, title: `从会话继续 · ${sessionLabel(selected.item)}` }, 'derive-session'),
              }, busy === 'derive-session' ? '派生中…' : '继续开发 →')
              : h(Btn, {
                primary: true,
                onClick: () => { if (selected.task?.url) window.open(selected.task.url, '_blank', 'noopener') },
              }, '打开分身 →')))
        : null,

      h('div', { style: { flexShrink: 0, fontSize: 11, color: TEXT2, display: 'flex', gap: 12, flexWrap: 'wrap' } },
        h('span', null, '双击左侧「瓮城」图标或输入框徽标 = 快速派生；单击 = 打开本面板；两栏各自滚动。'),
        h('a', { href: '/fang/panel', target: '_blank', rel: 'noopener', style: { color: 'inherit' } }, '独立门户 ↗')))
    }

    // ── 输入框 dock 徽标：状态 + 单手加速器 ────────────────────────────────
    function FangBadge(props) {
      const [stateView, setStateView] = useState({ loaded: false, ready: 0, max: 0, error: false })
      const [derive, setDerive] = useState(state.derive)
      const handle = useMemo(() => makeDoubleTap(() => quickDerive('徽标快速派生')), [])

      useEffect(() => {
        let alive = true
        const poll = async () => {
          try {
            const res = await fetch('/fang/api/status', { headers: { accept: 'application/json' } })
            if (!res.ok) throw new Error('status ' + res.status)
            const body = await res.json()
            if (!alive) return
            setStateView({ loaded: true, ready: body?.tasks?.ready ?? body?.forks?.running ?? 0, max: body?.tasks?.max ?? 0, error: false })
          } catch {
            if (alive) setStateView((s) => ({ ...s, loaded: true, error: true }))
          }
        }
        poll()
        const timer = setInterval(poll, 10000)
        const off = subscribe(setDerive)
        return () => { alive = false; clearInterval(timer); off() }
      }, [])

      const openPanel = () => {
        try {
          const layout = props?.ctx?.layout
          if (layout && typeof layout.selectPanel === 'function') { layout.selectPanel('fang'); return }
        } catch { /* fall through */ }
        try { window.open('/fang/panel', '_blank', 'noopener') } catch { /* ignore */ }
      }

      const pending = derive?.pending
      const dotColor = stateView.error ? 'var(--dsw-alias-state-warning, #9ca3af)'
        : (stateView.ready > 0 ? 'var(--dsw-alias-state-success, #22c55e)' : 'var(--dsw-alias-state-business-primary, #2563eb)')
      const label = stateView.error ? '瓮城离线' : (stateView.loaded ? `瓮城 ${stateView.ready}${stateView.max ? '/' + stateView.max : ''}` : '瓮城')
      const title = stateView.error
        ? '无法读取 /fang/api/status（宿主侧 dsh-Fang 未加载或路由不可用）'
        : '瓮城：单击打开面板，双击快速派生分身'

      return h('div', { title, style: {
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 999,
        font: FONT, fontSize: 11, lineHeight: '16px', color: TEXT2,
        border: `1px solid ${BORDER}`, background: 'transparent', userSelect: 'none',
      } },
      h('span', { 'aria-hidden': true, style: { width: 6, height: 6, borderRadius: '50%', background: dotColor, display: 'inline-block' } }),
      h('button', {
        type: 'button',
        onClick: openPanel,
        onDoubleClick: handle,
        title,
        style: { font: 'inherit', color: 'inherit', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' },
      }, pending ? '派生中…' : label),
      h('a', {
        href: '/fang/panel', target: '_blank', rel: 'noopener', title: '独立兜底门户',
        style: { marginLeft: 2, padding: '0 6px', borderRadius: 999, border: `1px solid ${BORDER}`, color: 'inherit', textDecoration: 'none', fontSize: 10, opacity: 0.85 },
      }, '↗'))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const disposers = []
        // 左侧导航「瓮城」：图标组件即登记项组件（外壳只给 {size, active}）
        disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'fang',
          order: 90,
          label: '瓮城',
        }, (props) => h(GateGlyph, { size: props?.size, active: props?.active }))))
        // 中列面板：key 必须与 sidebar 条目 id 一致，否则 selectPanel('fang') 不会切
        disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'fang',
        }, FangPanel)))
        // 输入框下方徽标
        disposers.push(ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'fang-badge',
          order: 88,
        }, (props) => h(FangBadge, { ...props, ctx }))))
        return () => {
          for (const dispose of disposers) { try { if (typeof dispose === 'function') dispose() } catch { /* ignore */ } }
        }
      },
    }
  },
})
