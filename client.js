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

    function FangPanel() {
      const [status, setStatus] = useState({ state: 'loading', data: null, error: '' })
      const [sessions, setSessions] = useState({ state: 'loading', items: [], error: '' })
      const [tasks, setTasks] = useState({ state: 'loading', items: [] })
      const [selected, setSelected] = useState(null) // {kind:'session'|'task', item}
      const [derive, setDerive] = useState(state.derive)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')

      const refresh = useCallback(async () => {
        const [s, t, sess] = await Promise.all([
          api('/fang/api/status').catch((e) => ({ status: 0, body: { error: String(e?.message ?? e) } })),
          api('/fang/api/tasks').catch(() => ({ status: 0, body: { tasks: [] } })),
          api('/fang/api/sessions').catch(() => ({ status: 0, body: { sessions: [] } })),
        ])
        if (s.status === 200 && s.body?.ok !== false) setStatus({ state: 'ready', data: s.body, error: '' })
        else setStatus({ state: 'error', data: null, error: s.body?.error ?? 'status-unavailable' })
        setTasks({ state: 'ready', items: Array.isArray(t.body?.tasks) ? t.body.tasks : [] })
        const sessionItems = Array.isArray(sess.body?.sessions) ? sess.body.sessions : Array.isArray(sess.body?.items) ? sess.body.items : []
        setSessions({ state: sess.status === 200 ? 'ready' : 'error', items: sessionItems, error: sess.body?.error ?? '' })
      }, [])

      useEffect(() => { refresh(); const timer = setInterval(refresh, 5000); return () => clearInterval(timer) }, [refresh])
      useEffect(() => subscribe(setDerive), [])

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

      const data = status.data
      const running = data?.tasks?.running ?? 0
      const ready = data?.tasks?.ready ?? 0
      const max = data?.tasks?.max ?? '?'
      const adapterMode = data?.role ?? 'mother'

      return h('div', { style: { padding: '24px 28px', maxWidth: 980, margin: '0 auto', color: TEXT, font: FONT } },
        // 门楣
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
          h('span', { style: { display: 'inline-flex', width: 28, height: 28 } }, h(GateGlyph, { size: 24, active: true })),
          h('h1', { style: { margin: 0, fontSize: 20, fontWeight: 600 } }, '瓮城'),
          h(Chip, null, adapterMode === 'mother' ? '母体只读' : adapterMode),
          h(Chip, null, `${ready}/${max} 就绪`),
          h(Chip, null, `${running} 运行中`),
          h('span', { style: { flex: 1 } }),
          h(Btn, { primary: true, disabled: !!busy, onClick: () => startDerive({ title: '快速派生' }, 'derive') }, busy === 'derive' ? '派生中…' : '派生新分身'),
          h(Btn, { onClick: refresh, disabled: !!busy }, '刷新')),
        status.state === 'error'
          ? h('div', { style: { marginTop: 12, padding: '8px 12px', border: `1px solid ${BORDER}`, borderRadius: 8, color: TEXT2 } },
            `母体状态不可读 —— /fang/api/status: ${status.error}`, ' ',
            h(Btn, { onClick: refresh }, '重试'))
          : null,
        notice ? h('div', { style: { marginTop: 12, fontSize: 13, color: TEXT2 } }, notice) : null,

        // 最近一次快速派生结果（弹窗被拦时这里是兜底链接）
        derive && !derive.pending && derive.ok
          ? h('div', { style: { marginTop: 12, padding: '10px 12px', border: `1px solid ${BORDER}`, borderLeft: `3px solid ${ACCENT}`, borderRadius: 8, fontSize: 13, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' } },
            h('span', null, `分身已就绪 · 端口 ${derive.port ?? '—'}`),
            derive.url ? h('a', { href: derive.url, target: '_blank', rel: 'noopener', style: { color: 'inherit' } }, '打开分身 ↗') : null,
            h(Btn, { onClick: () => { state.derive = null; state.notify() } }, '知道了'))
          : null,

        // 继续开发：会话
        h('h2', { style: { fontSize: 14, fontWeight: 600, margin: '22px 0 6px', color: TEXT2 } }, '继续开发 · 已有会话'),
        sessions.state === 'ready' && sessions.items.length === 0
          ? h('div', { style: { padding: '10px 2px', fontSize: 13, color: TEXT2 } }, '还没有可继续的会话。开一个新对话后，它会出现在这里。')
          : sessions.state === 'error'
            ? h('div', { style: { padding: '10px 2px', fontSize: 13, color: TEXT2 } }, `会话目录不可读：${sessions.error || 'unknown'}`)
            : sessions.items.slice(0, 8).map((s) => h(Row, {
              key: 's:' + s.sessionId,
              selected: selected?.kind === 'session' && selected.item.sessionId === s.sessionId,
              onClick: () => setSelected({ kind: 'session', item: s }),
            },
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.title || s.workspaceTitle || '未命名会话'),
              h('div', { style: { fontSize: 12, color: TEXT2, fontFamily: MONO } },
                `${short(s.sessionId, 12)} · ${fmtTime(s.updatedAt)}${s.workspaceTitle ? ' · ' + s.workspaceTitle : ''}${s.archived ? ' · 已归档' : ''}`)),
            h('span', { style: { fontSize: 12, color: TEXT2 } }, '选择'))),

        // 继续开发：任务
        h('h2', { style: { fontSize: 14, fontWeight: 600, margin: '22px 0 6px', color: TEXT2 } }, '继续开发 · 任务'),
        tasks.items.length === 0
          ? h('div', { style: { padding: '10px 2px', fontSize: 13, color: TEXT2 } }, '还没有分身。点右上「派生新分身」，或双击左侧瓮城图标快速派生。')
          : tasks.items.map((t) => h(Row, {
            key: 't:' + t.taskId,
            selected: selected?.kind === 'task' && selected.item.taskId === t.taskId,
            onClick: () => setSelected({ kind: 'task', item: t }),
          },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t.title),
            h('div', { style: { fontSize: 12, color: TEXT2, fontFamily: MONO } },
              `${short(t.taskId, 12)} · ${t.status} · 端口 ${t.port ?? '—'} · adapter ${t.adapter?.ok ? 'ready' : (t.adapter?.error || 'down')}${t.seed?.sessionId ? ' · 种子 ' + short(t.seed.sessionId, 8) : ''}`)),
          h('span', { style: { display: 'flex', gap: 6 } },
            t.url ? h('a', { href: t.url, target: '_blank', rel: 'noopener', onClick: (e) => e.stopPropagation(), style: { fontSize: 12, color: 'inherit' } }, '打开') : null,
            h(Btn, { onClick: (e) => { e.stopPropagation(); archiveTask(t.taskId) }, disabled: !!busy }, '归档')))),

        // 选中确认条
        selected
          ? h('div', { style: { marginTop: 14, padding: '12px 14px', border: `1px solid ${BORDER}`, borderLeft: `3px solid ${ACCENT}`, borderRadius: 8 } },
            h('div', { style: { fontSize: 13, marginBottom: 8 } },
              selected.kind === 'session'
                ? `继续「${selected.item.title || '未命名会话'}」：将派生 1 个分身，注入手写摘要种子（lineage，不改母体会话）。`
                : `继续任务「${selected.item.title}」：打开既有分身，或在其上继续开发。`),
            h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
              h(Btn, { onClick: () => setSelected(null) }, '取消'),
              selected.kind === 'session'
                ? h(Btn, {
                  primary: true,
                  disabled: !!busy,
                  onClick: () => startDerive({ sessionId: selected.item.sessionId, title: `从会话继续 · ${selected.item.title || short(selected.item.sessionId, 8)}` }, 'derive-session'),
                }, busy === 'derive-session' ? '派生中…' : '继续开发 →')
                : h(Btn, {
                  primary: true,
                  onClick: () => { if (selected.item.url) window.open(selected.item.url, '_blank', 'noopener') },
                }, '打开分身 →')))
          : null,

        // 页脚
        h('div', { style: { marginTop: 24, paddingTop: 12, borderTop: `1px solid ${BORDER}`, fontSize: 12, color: TEXT2, display: 'flex', gap: 12, flexWrap: 'wrap' } },
          h('span', null, '双击左侧「瓮城」图标或输入框徽标 = 快速派生；单击 = 打开本面板。'),
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
