// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// dsh-Fang Client 半 ——「瓮城」控制台（v4 视觉定稿：Apple 风三区）。
//
// 实现约束（本轮硬要求）：
//   * 零构建：无 JSX、无打包、无 Tailwind；UI 全部由本文件的 h() 创建原生 DOM。
//   * 不新增依赖：仅宿主插槽契约要求 factory 返回 React 元素，故保留一个 15 行的
//     挂载壳（DomMount）；它不做布局、不持有状态，UI 本身与 React 无关。
//     如果宿主未来允许插槽返回 DOM 节点，直接去掉 DomMount 即可。
//   * 视觉：顶部 Header（品牌 / Stats / 动作）→ 左 30% 元主区 → 右 70% 分身区；
//     白卡、圆角、柔和阴影、毛玻璃浮窗（Mother / 确认 / 输入）。
//   * 颜色语义：绿 = 派生/健康，蓝 = 运行/母体身份，红 = 派发/破坏性，橘 = 配置/警告。
//
// 数据面（只读为主，写操作全部走宿主已有路由）：
//   GET  /fang/api/status          母体版本、适配器就绪数、配额上限
//   GET  /fang/api/tasks           分身任务（生命周期 + 适配器健康两枚徽章）
//   GET  /fang/api/tasks/sessions  某个分身的会话（按卡独立重试）
//   GET  /fang/api/sessions        母体会话目录（元主 = 工作区，会话挂在元主下）
//   GET  /fang/api/essence/list    原身/元主配额信息（本次不渲染，保留能力探测）
//   POST /fang/api/derive          派生（从会话继续 / 空白快速派生）
//   POST /fang/api/tasks/archive|restore|archive/delete|promote
//   GET/POST /fang/api/mirror/*    母体镜像（备份 / 恢复 / 升级 / 间隔）
//   GET/POST /fang/api/mother-link* 母体连接描述与只读探测
//
// 视觉事实（参考图，2026-11-03 定稿）：
//   * 页面底色 #F5F5F7，白卡 #FFFFFF，1px 描边 rgba(16,17,20,.08)；
//   * Header 是独立浮起的白色圆角胶囊，内部三段：品牌 / Stats / 动作；
//   * 左卡“元主”是母体工作区槽位（实心卡 + 虚线空槽），右卡“分身”按
//     进行中 / 临时 / 已归档分组，卡片左侧 4px 色条 + 状态胶囊；
//   * 不写死宿主主题色：颜色只来自本文件的 --fang-* token（见 injectStyle）。

if (typeof window !== 'undefined' && window.__ModuleLoader__) {
window.__ModuleLoader__.load({
  id: '@local/dsh-fang',
  factory(require) {
    // React 只用于宿主插槽返回值（slots 契约），UI 不依赖它。见文件头说明。
    const React = require('react')

    // ── 设计 token ────────────────────────────────────────────────────────
    // 与 docs/UX-三区控制台规格-v1.md §1 一一对应；改色只改这里。
    const TOKENS = {
      bg: '#F5F5F7',
      surface: '#FFFFFF',
      surface2: '#FAFAFC',
      surface3: '#F2F2F5',
      border: 'rgba(16, 17, 20, 0.08)',
      borderStrong: 'rgba(16, 17, 20, 0.14)',
      text: '#1D1D1F',
      text2: '#5F6368',
      text3: '#6E6E73',
      text4: '#86868B',
      green: '#17803D',
      greenHover: '#126B33',
      greenWash: 'rgba(23, 128, 61, 0.08)',
      greenLine: 'rgba(23, 128, 61, 0.24)',
      blue: '#0A6BE0',
      blueWash: 'rgba(10, 107, 224, 0.08)',
      blueLine: 'rgba(10, 107, 224, 0.22)',
      red: '#C8102E',
      redHover: '#A80D26',
      redWash: 'rgba(200, 16, 46, 0.07)',
      redLine: 'rgba(200, 16, 46, 0.24)',
      orange: '#B45309',
      orangeWash: 'rgba(180, 83, 9, 0.08)',
      orangeLine: 'rgba(180, 83, 9, 0.24)',
      focus: '#0A6BE0',
      radiusPanel: '24px',
      radiusCard: '18px',
      radiusCtl: '12px',
      radiusPill: '999px',
      shadowCard: '0 1px 2px rgba(16,17,20,.04), 0 10px 28px -16px rgba(16,17,20,.14)',
      shadowPanel: '0 1px 2px rgba(16,17,20,.05), 0 24px 56px -32px rgba(16,17,20,.22)',
      shadowFloat: '0 2px 8px rgba(16,17,20,.06), 0 32px 80px -32px rgba(16,17,20,.32)',
      font: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
      mono: 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace',
    }

    const CAPACITY_SLOTS = 7           // 物理槽位硬上限（capacity.slots）
    const CAPACITY_LIMIT = 5           // 默认准入配额（capacity.limit，1–7）
    const POLL_MS = 5000
    const ACTIVE_SESSION_LIMIT = 7     // 元主展开后默认显示的会话条数
    const MAX_TITLE = 40

    // 状态 → 语义色：只允许 绿（进行中）/ 蓝（非工作的暂停或归档）/ 红（已证实故障）/ 中性（未知）。
    // 橘色只用于“配置类动作”，绝不能出现在状态 chip 上。
    const TONE = {
      neutral: { fg: TOKENS.text3, line: TOKENS.border, wash: 'transparent', dot: TOKENS.text4 },
      ok: { fg: TOKENS.green, line: TOKENS.greenLine, wash: TOKENS.greenWash, dot: TOKENS.green },
      info: { fg: TOKENS.blue, line: TOKENS.blueLine, wash: TOKENS.blueWash, dot: TOKENS.blue },
      warn: { fg: TOKENS.orange, line: TOKENS.orangeLine, wash: TOKENS.orangeWash, dot: TOKENS.orange },
      bad: { fg: TOKENS.red, line: TOKENS.redLine, wash: TOKENS.redWash, dot: TOKENS.red },
    }

    // legacyStatus（v3.0.5）→ phase/tone 的唯一投影表；不得在组件里另写一套。
    const TASK_PROJECTION = {
      ready: { phase: 'running', label: '运行中', tone: 'ok' },
      running: { phase: 'running', label: '运行中', tone: 'ok' },
      provisioning: { phase: 'provisioning', label: '启动中', tone: 'ok' },
      failed: { phase: 'failed', label: '已停止', tone: 'bad' },
      archived: { phase: 'archived', label: '已归档', tone: 'info' },
    }

    const FAILURE_HINTS = {
      'bad-json': '接口返回的不是 JSON（可能是旧版宿主、代理错误页或进程已退出）。',
      'empty-body': '接口返回了空响应。宿主可能正在重启，稍后重试。',
      network: '网络请求没有完成（宿主未启动、页面离线或请求被中断）。',
      'status-unavailable': '/fang/api/status 不可用：宿主侧 dsh-Fang 可能没有加载。',
      'unknown-task': '任务不在当前母体的注册表里（宿主可能重启过，或任务已归档）。',
      'session-catalog-unavailable': '母体会话目录服务未加载，无法列出会话。',
      'sessions-root-missing': '还没有任何母体会话（目录尚未创建）。',
      'index-not-found': '分身的工作区索引尚未生成，标题与分组可能降级。',
      'sessions-unreadable': '会话目录不可读（权限或路径问题）。',
      'quota-exceeded': '分身配额已满：先归档旧分身再派生。',
      'workspace-create-route-missing': '宿主未提供「新建元主」接口（工作区由 DSH 侧创建），本轮不伪造写入。',
      'workspace-repo-route-missing': '宿主未提供元主归档/删除/下载接口；只读展示，不写入。',
      'derive-failed': '派生请求失败。',
      'stop-failed': '分身进程未停止，归档没有生效；任务仍保留。',
      'derived-session-missing': '会话已不在目录中（可能刚被归档），请刷新。',
    }

    // ── 通用工具 ──────────────────────────────────────────────────────────
    const clampText = (value, max = 160) => {
      const text = String(value ?? '').replace(/\s+/g, ' ').trim()
      return text.length > max ? text.slice(0, max - 1) + '…' : text
    }
    const short = (value, size = 8) => {
      const text = String(value ?? '')
      return text.length > size ? text.slice(0, size) : text
    }
    const pad2 = (n) => String(n).padStart(2, '0')
    function fmtClock(ms) {
      const date = new Date(Number(ms))
      if (!ms || Number.isNaN(date.getTime())) return '—'
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }
    function fmtShortClock(ms) {
      const date = new Date(Number(ms))
      if (!ms || Number.isNaN(date.getTime())) return '—'
      return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }
    function fmtRelative(ms) {
      const value = Number(ms)
      if (!value) return '—'
      const diff = Date.now() - value
      if (diff < 60_000) return '刚刚'
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
      return fmtShortClock(value)
    }
    function fmtBytes(bytes) {
      const value = Number(bytes) || 0
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      if (value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MB'
      return (value / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
    }
    function failureHint(code, context) {
      const key = String(code ?? '')
      if (context === 'fork-sessions' && key === 'http-404') {
        return '分身会话接口不存在（HTTP 404）：宿主可能仍是旧版 dsh-Fang。重启母体后再试；分身本身仍可打开。'
      }
      if (FAILURE_HINTS[key]) return FAILURE_HINTS[key]
      const http = /^http-(\d+)$/.exec(key)
      if (http) return `接口返回 HTTP ${http[1]}${http[1] === '404' ? '：路由不存在或对象已不在注册表里' : ''}。`
      return `请求失败：${key || 'unknown'}`
    }
    function diagnosticText(diagnostic) {
      if (!diagnostic) return ''
      return [
        diagnostic.url ? 'URL: ' + diagnostic.url : '',
        diagnostic.status ? 'HTTP: ' + diagnostic.status : '',
        diagnostic.message ? '错误: ' + diagnostic.message : '',
      ].filter(Boolean).join('\n')
    }
    function readPref(key, fallback) {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return fallback
        const raw = window.localStorage.getItem(key)
        return raw === null ? fallback : raw === '1'
      } catch { return fallback }
    }
    function writePref(key, value) {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return
        window.localStorage.setItem(key, value ? '1' : '0')
      } catch { /* 隐私模式：偏好只影响本次会话 */ }
    }

    // ── 标题降级：绝不把工作区名当会话标题 ────────────────────────────────
    function sessionTitleInfo(session) {
      const title = clampText(session?.title)
      const preview = clampText(session?.preview)
      const source = String(session?.titleSource ?? '')
      const workspace = clampText(session?.workspaceTitle)
      if (source === 'session/title' && title) return { text: title, source: 'native' }
      if (preview) return { text: preview, source: 'first-user' }
      if (source === 'first-user' && title) return { text: title, source: 'first-user' }
      if (source === 'workspace' || !title) return { text: '未命名会话', source: 'unnamed' }
      if (workspace && title === workspace) return { text: '未命名会话', source: 'unnamed' }
      return { text: title, source: 'native' }
    }
    const sessionDisplayText = (session) => {
      const info = sessionTitleInfo(session)
      return info.source === 'unnamed' ? `${info.text} · ${short(session?.sessionId, 8)}` : info.text
    }
    function sessionTooltip(session) {
      const info = sessionTitleInfo(session)
      const lines = [info.source === 'unnamed' ? '未命名会话（宿主未返回标题，用短 ID 区分）' : info.text]
      lines.push('会话 ID：' + String(session?.sessionId ?? '—'))
      lines.push('工作区：' + (clampText(session?.workspaceTitle) || '未知'))
      lines.push('更新时间：' + fmtClock(session?.updatedAt))
      if (session?.empty) lines.push('状态：空会话（没有用户消息，无法继续开发）')
      if (session?.archived) lines.push('状态：已归档')
      return lines.join('\n')
    }

    // ── 分类：母体会话 / 分身任务 ─────────────────────────────────────────
    const QUICK_DERIVE_TITLE_RE = /^(?:(?:双击|徽标|重试|面板)?快速派生|派生新分身)$/
    const isTempTask = (task) => QUICK_DERIVE_TITLE_RE.test(String(task?.title ?? '').trim())

    function classifyMotherSessions(items) {
      const active = []
      const archived = []
      const temporary = []
      for (const item of Array.isArray(items) ? items : []) {
        if (item?.archived) archived.push(item)
        else if (item?.empty) temporary.push(item)
        else active.push(item)
      }
      return { active, archived, temporary }
    }
    function classifyTasks(items) {
      const active = []
      const archived = []
      const temporary = []
      for (const item of Array.isArray(items) ? items : []) {
        if (String(item?.status ?? '') === 'archived') archived.push(item)
        else if (isTempTask(item)) temporary.push(item)
        else active.push(item)
      }
      return { active, archived, temporary }
    }
    /** 元主 = 母体工作区：会话按 workspace 聚合，元主卡挂在左栏。 */
    function groupMotherWorkspaces(items, aliases) {
      const map = new Map()
      for (const item of Array.isArray(items) ? items : []) {
        const key = String(item.workspaceId || item.workspaceKey || item.workspaceTitle || 'unknown')
        if (!map.has(key)) {
          map.set(key, {
            key,
            title: clampText(aliases?.[key]) || clampText(item.workspaceTitle) || '未命名元主',
            rawTitle: clampText(item.workspaceTitle) || '未命名元主',
            path: String(item.workspacePath ?? ''),
            sessions: [],
            latestAt: 0,
            archived: 0,
            empty: 0,
          })
        }
        const group = map.get(key)
        group.sessions.push(item)
        if (Number(item.updatedAt) > group.latestAt) group.latestAt = Number(item.updatedAt)
        if (item.archived) group.archived += 1
        if (item.empty) group.empty += 1
      }
      const out = [...map.values()]
      for (const group of out) {
        group.sessions.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
        group.count = group.sessions.length
      }
      return out.sort((a, b) => b.latestAt - a.latestAt || String(a.title).localeCompare(String(b.title)))
    }

    /** 元主卡左侧色点：由 key 稳定派生，不随排序变化。 */
    const DOT_TONES = ['info', 'neutral']
    function dotTone(key) {
      let hash = 0
      const text = String(key ?? '')
      for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) % 997
      return DOT_TONES[hash % DOT_TONES.length]
    }

    /**
     * 三色投影（唯一入口）：UI 只做投影，不自己发明状态。
     * v3.0.5 后端只给 legacyStatus + adapter.ok；契约升级后直接读 phase/health/actions。
     * 规则：failed 红；running 且适配器失联 红；provisioning/running 绿；archived 蓝；未知中性。
     */
    function projectTask(task) {
      const status = String(task?.status ?? '')
      const phase = String(task?.phase ?? TASK_PROJECTION[status]?.phase ?? 'unknown')
      const adapter = String(task?.health?.adapter ?? (task?.adapter?.ok ? 'ok' : status === 'provisioning' ? 'pending' : 'error'))
      const adapterOk = adapter === 'ok'
      const anomaly = phase === 'running' && adapter === 'error'
      const base = TASK_PROJECTION[status] || { label: '状态未知', tone: 'neutral' }
      let tone = base.tone
      let label = base.label
      if (phase === 'failed' || phase === 'crashed') { tone = 'bad'; label = phase === 'crashed' ? '已崩溃' : '启动失败' }
      else if (anomaly) { tone = 'bad'; label = '运行中 · 适配器失联' }
      else if (phase === 'archived') { tone = 'info'; label = '已归档' }
      else if (phase === 'paused' || phase === 'stopping' || phase === 'pausing' || phase === 'completed') { tone = 'info'; label = phase === 'paused' ? '已暂停' : phase === 'stopping' ? '停止中' : phase === 'completed' ? '已完成' : '暂停中' }
      else if (phase === 'provisioning') { tone = 'ok'; label = '启动中' }
      else if (phase === 'running') { tone = 'ok'; label = '运行中' }
      else if (phase === 'unknown' || !status) { tone = 'neutral'; label = '状态未知' }
      return {
        status, phase, tone, label, anomaly,
        active: ['provisioning', 'starting', 'resuming', 'running'].includes(phase),
        archived: phase === 'archived',
        adapterOk,
        adapter: adapterOk ? 'ok' : (adapter === 'pending' ? 'pending' : (phase === 'failed' || phase === 'archived' ? 'n/a' : 'error')),
        adapterLabel: adapterOk ? '适配器就绪' : adapter === 'pending' ? '适配器握手中' : (phase === 'failed' || phase === 'archived' ? '适配器未运行' : '适配器失联'),
        adapterTone: adapterOk ? 'ok' : adapter === 'pending' ? 'neutral' : (phase === 'failed' || phase === 'archived' ? 'neutral' : 'bad'),
      }
    }
    const taskHealth = projectTask;

    /** 容量投影：slots=7 硬上限，limit=5 默认配额；v3.0.5 用 tasks 数兜底并显式标注“估算”。 */
    function projectCapacity(statusData, tasks) {
      const items = Array.isArray(tasks) ? tasks : []
      const capacity = statusData?.capacity || null
      const limit = Number(capacity?.limit ?? statusData?.tasks?.max ?? CAPACITY_LIMIT)
      const slots = Number(capacity?.slots ?? CAPACITY_SLOTS)
      const used = Number(capacity?.used ?? items.filter((task) => String(task.status) !== 'archived').length)
      return {
        slots, limit, used,
        headroom: Math.max(0, limit - used),
        slotFree: Math.max(0, slots - used),
        source: capacity?.source || 'config',
        fresh: capacity?.fresh !== false,
        estimated: !capacity,
        deriveEnabled: capacity?.derive?.enabled ?? used < limit,
        deriveReason: capacity?.derive?.detail || null,
      }
    }

    // ── API（统一鉴权头 + 结构化错误，供 UI 给出可操作原因）─────────────
    let fangAuthToken = ''
    async function ensureFangAuthToken() {
      if (fangAuthToken) return fangAuthToken
      try {
        const res = await fetch('/fang/api/auth-token', { headers: { accept: 'application/json' } })
        if (res.ok) {
          const body = await res.json()
          if (body && typeof body.token === 'string') fangAuthToken = body.token
        }
      } catch { /* 旧宿主没有 auth-token 路由：保持空 token */ }
      return fangAuthToken
    }
    async function api(path, options) {
      const url = String(path)
      const token = await ensureFangAuthToken()
      let res
      try {
        res = await fetch(url, {
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            ...(token ? { 'x-fang-auth': token } : {}),
          },
          ...(options ?? {}),
        })
      } catch (error) {
        return { status: 0, body: null, diagnostic: { url, message: String(error?.message ?? error) } }
      }
      const etag = (res.headers && typeof res.headers.get === 'function' && res.headers.get('etag')) || ''
      if (res.status === 304) return { status: 304, body: null, notModified: true, etag }
      let text = ''
      try { text = await res.text() } catch (error) {
        return { status: res.status, body: null, diagnostic: { url, status: res.status, message: '读取响应失败：' + String(error?.message ?? error) } }
      }
      let body = null
      let parseError = ''
      if (text) {
        try { body = JSON.parse(text) } catch (error) { parseError = String(error?.message ?? error) }
      } else parseError = 'empty-body'
      if (body === null) {
        const code = res.status >= 400 ? 'http-' + res.status : (parseError === 'empty-body' ? 'empty-body' : 'bad-json')
        return { status: res.status, body: { ok: false, error: code }, diagnostic: { url, status: res.status, snippet: clampText(text, 200), parseError } }
      }
      return { status: res.status, body, etag }
    }

    function resolveMotherOrigin() {
      try {
        const transport = typeof globalThis !== 'undefined' ? globalThis.__DSH_TRANSPORT__ : undefined
        const streamBaseUrl = transport && typeof transport.streamBaseUrl === 'string' ? transport.streamBaseUrl : ''
        if (/^https?:\/\//i.test(streamBaseUrl)) return streamBaseUrl.replace(/\/+$/, '')
      } catch { /* ignore */ }
      try {
        const origin = typeof window !== 'undefined' && window.location ? String(window.location.origin ?? '') : ''
        if (/^https?:\/\//i.test(origin)) return origin
      } catch { /* ignore */ }
      return ''
    }
    function openMotherPortal() {
      const origin = resolveMotherOrigin()
      const url = origin ? `${origin}/fang/panel` : '/fang/panel'
      try {
        const win = window.open(url, '_blank', 'noopener')
        if (win) return
      } catch { /* 弹窗被拦 → 同页打开 */ }
      try { window.location.assign(url) } catch { /* ignore */ }
    }

    // ── DOM 构造器 h()：本文件唯一的视图原语 ──────────────────────────────
    // 支持：tag、class、style（对象/字符串）、dataset、aria-*、常见属性、on* 事件、children。
    const escapeSelector = (value) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(String(value)) : String(value).replace(/["\\]/g, '\\$&'))
    const BOOL_ATTRS = new Set(['disabled', 'checked', 'selected', 'readonly', 'required', 'hidden', 'inert'])
    const PROP_ATTRS = new Set(['value', 'placeholder', 'type', 'href', 'target', 'rel', 'title', 'role', 'tabindex', 'aria-label', 'aria-live', 'aria-expanded', 'aria-controls', 'aria-pressed', 'aria-hidden', 'aria-disabled', 'aria-busy', 'aria-describedby', 'aria-labelledby', 'aria-modal', 'name', 'for', 'id', 'autocomplete', 'maxlength', 'inputmode', 'spellcheck'])
    function appendChildren(node, children) {
      for (const child of children) {
        if (child === null || child === undefined || child === false) continue
        if (Array.isArray(child)) { appendChildren(node, child); continue }
        if (child instanceof Node) node.appendChild(child)
        else node.appendChild(node.ownerDocument.createTextNode(String(child)))
      }
    }
    function h(tag, props, ...children) {
      const node = document.createElement(tag)
      const options = props || {}
      for (const [key, value] of Object.entries(options)) {
        if (value === undefined || value === null || value === false) continue
        if (key === 'class' || key === 'className') { node.className = String(value); continue }
        if (key === 'style') {
          if (typeof value === 'string') node.setAttribute('style', value)
          else for (const [prop, val] of Object.entries(value)) {
            if (val === undefined || val === null || val === '') continue
            if (prop.startsWith('--')) node.style.setProperty(prop, String(val))
            else node.style[prop] = typeof val === 'number' && !/unitless|opacity|zIndex|flex|order|lineHeight|fontWeight/i.test(prop)
              ? val + 'px' : String(val)
          }
          continue
        }
        if (key === 'dataset') { for (const [dataKey, dataVal] of Object.entries(value)) node.dataset[dataKey] = String(dataVal); continue }
        if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value)
          continue
        }
        if (BOOL_ATTRS.has(key)) { node[key] = !!value; continue }
        if (PROP_ATTRS.has(key)) {
          if (key === 'tabindex') node.tabIndex = Number(value)
          else node.setAttribute(key, String(value))
          continue
        }
        if (key === 'text') { node.textContent = String(value); continue }
        node.setAttribute(key, String(value))
      }
      appendChildren(node, children)
      return node
    }
    const SVG_NS = 'http://www.w3.org/2000/svg'
    function svg(tag, props, ...children) {
      const node = document.createElementNS(SVG_NS, tag)
      for (const [key, value] of Object.entries(props || {})) {
        if (value === undefined || value === null) continue
        if (key === 'class') node.setAttribute('class', String(value))
        else node.setAttribute(key, String(value))
      }
      for (const child of children) {
        if (child === null || child === undefined) continue
        node.appendChild(child)
      }
      return node
    }
    function glyph(paths, size = 14, width = 1.8) {
      const node = svg('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        'aria-hidden': 'true', focusable: 'false', class: 'fang-icon',
      })
      for (const d of paths) node.appendChild(svg('path', { d }))
      return node
    }
    const ICON = {
      chevron: (open = false, size = 16) => glyph([open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'], size, 2),
      plus: (size = 14) => glyph(['M12 5v14', 'M5 12h14'], size, 2),
      refresh: (size = 14) => glyph(['M20.5 12a8.5 8.5 0 1 1-2.49-6.01', 'M21 4.5V10h-5.5'], size),
      external: (size = 12) => glyph(['M14 4h6v6', 'M20 4l-9 9', 'M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4'], size),
      search: (size = 15) => glyph(['M11 4.5a6.5 6.5 0 1 1 0 13a6.5 6.5 0 0 1 0-13', 'M16 16l6 6'], size),
      close: (size = 14) => glyph(['M6 6l12 12', 'M18 6L6 18'], size, 2),
      check: (size = 13) => glyph(['M5 12.5l4.5 4.5L19 7.5'], size, 2.2),
      alert: (size = 15) => glyph(['M12 3.6 21 20H3L12 3.6Z', 'M12 9.5v4.2', 'M12 17.3h.01'], size),
      copy: (size = 13) => glyph(['M9 9h9v9H9z', 'M15 9V5H5v10h4'], size),
      archive: (size = 13) => glyph(['M4 8h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z', 'M3 4h18v4H3z', 'M10 12h4'], size),
      download: (size = 13) => glyph(['M12 4v10', 'M7.5 10.5 12 15l4.5-4.5', 'M5 19h14'], size),
      trash: (size = 13) => glyph(['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6'], size),
      globe: (size = 14) => glyph(['M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18', 'M3 12h18', 'M12 3c2.4 2.4 3.8 5.6 3.8 9S14.4 18.6 12 21c-2.4-2.4-3.8-5.6-3.8-9S9.6 5.4 12 3'], size),
      disc: (size = 14) => glyph(['M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18', 'M12 9.6a2.4 2.4 0 1 0 0 4.8a2.4 2.4 0 0 0 0-4.8', 'M12 3v6.6', 'M12 14.4V21'], size),
      arrowUp: (size = 14) => glyph(['M12 19V5', 'M6 11l6-6 6 6'], size),
      play: (size = 13) => glyph(['M8 5l11 7-11 7z'], size),
      spinner: (size = 14) => {
        const node = svg('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', class: 'fang-icon fang-spin', 'aria-hidden': 'true', focusable: 'false' })
        node.appendChild(svg('circle', { cx: 12, cy: 12, r: 8.5, stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-dasharray': '38 12' }))
        return node
      },
      gate: (size = 26, color = TOKENS.red) => {
        const node = svg('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })
        node.appendChild(svg('path', { d: 'M4.25 20V11.5a7.75 7.75 0 0 1 15.5 0V20', stroke: color, 'stroke-width': 1.9 }))
        node.appendChild(svg('path', { d: 'M9.5 20v-5.5a2.5 2.5 0 0 1 5 0V20', stroke: 'currentColor', 'stroke-width': 1.8 }))
        node.appendChild(svg('path', { d: 'M2.75 20h18.5', stroke: 'currentColor', 'stroke-width': 1.8, opacity: 0.55 }))
        return node
      },
    }

    // 局部图标缓存：同一图标多次创建无妨，但这里给出稳定工厂，避免拼错路径
    const icon = (name, ...args) => ICON[name](...args)

    // ── 样式：一次注入，类名统一 fang-/fh- 前缀，避免与宿主样式互撞 ──────────
    const STYLE_ID = 'fang-console-v4-style'
    function injectStyle(doc) {
      const target = doc || (typeof document !== 'undefined' ? document : null)
      if (!target || target.getElementById(STYLE_ID)) return
      const style = target.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
.fang-console{
  --f-bg:${TOKENS.bg}; --f-surface:${TOKENS.surface}; --f-surface-2:${TOKENS.surface2}; --f-surface-3:${TOKENS.surface3};
  --f-border:${TOKENS.border}; --f-border-strong:${TOKENS.borderStrong};
  --f-text:${TOKENS.text}; --f-text-2:${TOKENS.text2}; --f-text-3:${TOKENS.text3}; --f-text-4:${TOKENS.text4};
  --f-green:${TOKENS.green}; --f-green-hover:${TOKENS.greenHover}; --f-green-wash:${TOKENS.greenWash}; --f-green-line:${TOKENS.greenLine};
  --f-blue:${TOKENS.blue}; --f-blue-wash:${TOKENS.blueWash}; --f-blue-line:${TOKENS.blueLine};
  --f-red:${TOKENS.red}; --f-red-hover:${TOKENS.redHover}; --f-red-wash:${TOKENS.redWash}; --f-red-line:${TOKENS.redLine};
  --f-orange:${TOKENS.orange}; --f-orange-wash:${TOKENS.orangeWash}; --f-orange-line:${TOKENS.orangeLine};
  --f-focus:${TOKENS.focus}; --f-radius-panel:${TOKENS.radiusPanel}; --f-radius-card:${TOKENS.radiusCard}; --f-radius-ctl:${TOKENS.radiusCtl};
  --f-shadow-card:${TOKENS.shadowCard}; --f-shadow-panel:${TOKENS.shadowPanel}; --f-shadow-float:${TOKENS.shadowFloat};
  --f-font:${TOKENS.font}; --f-mono:${TOKENS.mono};
  position:relative;color-scheme:light;min-height:100%;box-sizing:border-box;
  display:flex;flex-direction:column;gap:16px;padding:18px 20px 22px;
  background:var(--f-bg);color:var(--f-text);font-family:var(--f-font);font-size:13px;line-height:1.5;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
}
.fang-console *,.fang-console *::before,.fang-console *::after{box-sizing:border-box}
.fang-console button,.fang-console input{font-family:inherit}
.fang-icon{display:block;flex:0 0 auto}
.fang-spin{animation:fang-spin .9s linear infinite}
@keyframes fang-spin{to{transform:rotate(360deg)}}
@keyframes fang-fade{from{opacity:0}to{opacity:1}}
@keyframes fang-rise{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}

/* Header */
.fang-head{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:22px;
  border:1px solid var(--f-border);background:rgba(255,255,255,.9);backdrop-filter:blur(18px) saturate(1.4);
  box-shadow:var(--f-shadow-panel);flex:0 0 auto}
.fh-brand{display:flex;align-items:center;gap:10px;min-width:0}
.fh-mark{width:38px;height:38px;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;
  background:linear-gradient(180deg,#FFF7F8,#FFECEF);border:1px solid rgba(200,16,46,.16);color:#8E1022;flex:0 0 auto}
.fh-titles{display:flex;flex-direction:column;gap:0;min-width:0}
.fh-title{font-size:23px;font-weight:700;letter-spacing:-.022em;line-height:28px;margin:0;color:var(--f-text)}
.fh-sub{font-size:10.5px;letter-spacing:.06em;color:var(--f-text-4);line-height:14px;white-space:nowrap}
.fh-stats{display:inline-flex;align-items:center;gap:1px;margin-left:4px;padding:3px;border:1px solid var(--f-border);
  border-radius:999px;background:var(--f-surface-2);min-width:0;overflow:hidden}
.stat{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;
  font-size:11.5px;color:var(--f-text-3);white-space:nowrap}
.stat b{color:var(--f-text);font-weight:600;font-variant-numeric:tabular-nums}
.stat-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:0 0 auto}
.stat-sep{width:1px;height:13px;background:var(--f-border);flex:0 0 auto}
.fh-actions{display:flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap;justify-content:flex-end}
@media (max-width:1240px){.fh-stats{order:3;width:100%;margin:0}.fang-head{flex-wrap:wrap}.fh-actions{margin-left:0;width:100%;justify-content:flex-start}}

/* Buttons */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 13px;
  border-radius:12px;border:1px solid transparent;background:transparent;color:var(--f-text);
  font-size:12.5px;font-weight:500;line-height:1;cursor:pointer;white-space:nowrap;text-decoration:none;
  transition:background .12s ease,border-color .12s ease,color .12s ease,box-shadow .12s ease,transform .12s ease}
.btn:hover{background:var(--f-surface-3)}
.btn:active{transform:translateY(.5px)}
.btn:focus-visible{outline:2px solid var(--f-focus);outline-offset:2px}
.btn[disabled],.btn[aria-disabled="true"]{opacity:.45;cursor:not-allowed}
.btn--sm{height:30px;padding:0 10px;font-size:12px;border-radius:10px}
.btn--lg{height:40px;padding:0 18px;font-size:13.5px;border-radius:13px}
.btn--ghost{background:var(--f-surface);border-color:var(--f-border);box-shadow:0 1px 1px rgba(16,17,20,.03)}
.btn--ghost:hover{background:var(--f-surface-2);border-color:var(--f-border-strong)}
.btn--quiet{color:var(--f-text-3)}
.btn--quiet:hover{color:var(--f-text);background:var(--f-surface-3)}
.btn--primary{background:var(--f-green);color:#fff;box-shadow:0 1px 2px rgba(23,128,61,.26)}
.btn--primary:hover{background:var(--f-green-hover)}
.btn--config{color:#9A4A06;background:var(--f-orange-wash);border-color:var(--f-orange-line)}
.btn--config:hover{background:rgba(180,83,9,.14);border-color:rgba(180,83,9,.4)}
.btn--info{color:#fff;background:var(--f-blue);box-shadow:0 1px 2px rgba(10,107,224,.22)}
.btn--info:hover{background:#0857B8}
.btn--danger{background:var(--f-red);color:#fff;box-shadow:0 1px 2px rgba(200,16,46,.24)}
.btn--danger:hover{background:var(--f-red-hover)}
.btn--danger-quiet{color:var(--f-red)}
.btn--danger-quiet:hover{background:var(--f-red-wash);color:var(--f-red)}
.btn--icon{width:34px;padding:0}
.btn--icon.btn--sm{width:30px}
.btn--block{width:100%}

/* chips */
.chip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:999px;
  border:1px solid var(--f-border);background:var(--f-surface-2);color:var(--f-text-3);
  font-size:11px;font-weight:500;line-height:1;white-space:nowrap}
.chip-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex:0 0 auto}
.chip--ok{color:var(--f-green);background:var(--f-green-wash);border-color:var(--f-green-line)}
.chip--info{color:#0857B8;background:var(--f-blue-wash);border-color:var(--f-blue-line)}
.chip--warn{color:#9A4A06;background:var(--f-orange-wash);border-color:var(--f-orange-line)}
.chip--bad{color:var(--f-red);background:var(--f-red-wash);border-color:var(--f-red-line)}
.chip--neutral{color:var(--f-text-3);background:var(--f-surface-2);border-color:var(--f-border)}

/* layout */
.fang-body{display:grid;grid-template-columns:minmax(300px,3fr) minmax(0,7fr);gap:16px;align-items:start;min-height:0;flex:1 1 auto}
@media (max-width:1100px){.fang-body{grid-template-columns:1fr}}
.panel{background:var(--f-surface);border:1px solid var(--f-border);border-radius:var(--f-radius-panel);
  box-shadow:var(--f-shadow-card);display:flex;flex-direction:column;min-height:0;overflow:hidden;
  max-height:calc(100vh - 132px)}
@media (max-width:1100px){.panel{max-height:none}}
.panel-head{flex:0 0 auto;padding:16px 16px 10px;display:flex;flex-direction:column;gap:10px}
.panel-title-row{display:flex;align-items:center;gap:10px;min-height:28px}
.panel-title{font-size:20px;font-weight:600;letter-spacing:-.014em;line-height:26px;margin:0}
.panel-sub{font-size:11.5px;color:var(--f-text-3);line-height:16px}
.panel-count{margin-left:auto;display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;
  border:1px solid var(--f-border);border-radius:999px;background:var(--f-surface-2);
  font-size:11px;color:var(--f-text-3);font-variant-numeric:tabular-nums;white-space:nowrap}
.panel-scroll{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;padding:0 10px 14px;
  scrollbar-width:thin;scrollbar-color:rgba(16,17,20,.18) transparent}
.panel-scroll::-webkit-scrollbar{width:10px;height:10px}
.panel-scroll::-webkit-scrollbar-thumb{background:rgba(16,17,20,.14);border:3px solid #fff;border-radius:8px}
.panel-scroll::-webkit-scrollbar-thumb:hover{background:rgba(16,17,20,.24)}

/* search */
.search{position:relative;display:flex;align-items:center}
.search-icon{position:absolute;left:11px;color:var(--f-text-4);display:flex;pointer-events:none}
.search input{width:100%;height:38px;padding:0 12px 0 33px;font-size:12.5px;color:var(--f-text);
  background:var(--f-surface-2);border:1px solid var(--f-border);border-radius:12px;outline:none;
  transition:border-color .12s ease,box-shadow .12s ease,background .12s ease}
.search input::placeholder{color:var(--f-text-4)}
.search input:focus{background:#fff;border-color:var(--f-blue);box-shadow:0 0 0 3px rgba(10,107,224,.14)}
.panel-tools{display:flex;align-items:center;gap:8px;padding:0 4px;font-size:11.5px;color:var(--f-text-3);flex-wrap:wrap}
.panel-tools .spacer{flex:1}

/* 元主 */
.section-head{display:flex;align-items:center;gap:8px;padding:8px 6px 6px;position:sticky;top:0;z-index:3;
  background:linear-gradient(#fff 74%,rgba(255,255,255,0))}
.section-title{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:var(--f-text);
  border:0;background:transparent;padding:4px 5px;border-radius:8px;cursor:pointer;font-family:inherit}
.section-title:hover{background:var(--f-surface-3)}
.section-sub{font-size:11px;color:var(--f-text-4)}
.section-head .spacer{flex:1}
.mother-control{display:flex;align-items:center;gap:10px;padding:9px 10px;border:1px solid var(--f-border);
  border-radius:14px;background:var(--f-surface-2)}
.mother-control-mark{width:30px;height:30px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;
  background:linear-gradient(180deg,#FFF7F8,#FFECEF);border:1px solid rgba(200,16,46,.14);color:#8E1022;flex:0 0 auto}
.mother-control-main{min-width:0;flex:1 1 auto;display:flex;flex-direction:column;gap:1px}
.mother-control-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12.5px;font-weight:600;color:var(--f-text)}
.mother-control-sub{font-size:10.5px;color:var(--f-text-4);line-height:15px}
.mother-list{display:flex;flex-direction:column;gap:2px;padding:0 2px}
.mother-row{border:1px solid transparent;border-radius:14px;transition:background .12s ease,border-color .12s ease,box-shadow .12s ease}
.mother-row:hover{background:var(--f-surface-2);border-color:var(--f-border)}
.mother-row.is-open{background:var(--f-surface-2);border-color:var(--f-border)}
.mother-main{display:flex;align-items:center;gap:10px;padding:10px 10px 10px 12px;min-height:52px}
.mother-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;background:var(--f-text-4)}
.mother-dot--info{background:var(--f-blue)}
.mother-dot--ok{background:var(--f-green)}
.mother-dot--warn{background:var(--f-orange)}
.mother-dot--neutral{background:var(--f-text-4)}
.mother-main-text{min-width:0;display:flex;flex-direction:column;gap:1px;flex:1 1 auto}
.mother-title{font-size:14.5px;font-weight:600;line-height:20px;color:var(--f-text);letter-spacing:-.005em}
.mother-meta{font-size:11.5px;color:var(--f-text-3);line-height:16px;font-variant-numeric:tabular-nums;display:flex;gap:6px;flex-wrap:wrap}
.mother-actions{display:flex;align-items:center;gap:1px;flex:0 0 auto}
.text-action{height:28px;padding:0 7px;border:0;border-radius:8px;background:transparent;color:var(--f-text-3);
  font-family:inherit;font-size:11.5px;line-height:1;cursor:pointer;white-space:nowrap}
.text-action:hover{background:rgba(16,17,20,.055);color:var(--f-text)}
.text-action:focus-visible{outline:2px solid var(--f-focus);outline-offset:1px}
.text-action[aria-disabled="true"]{opacity:.38;cursor:not-allowed}
.text-action--danger:hover{background:var(--f-red-wash);color:var(--f-red)}
.expand-btn{width:30px;height:30px;padding:0;border:0;border-radius:9px;background:transparent;color:var(--f-text-4);
  display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.expand-btn:hover{background:rgba(16,17,20,.06);color:var(--f-text)}
.expand-btn:focus-visible{outline:2px solid var(--f-focus);outline-offset:1px}
.expand-btn[aria-expanded="true"] svg{transform:rotate(45deg)}
.expand-btn svg{transition:transform .16s ease}
.sessions{padding:0 10px 8px 31px;display:flex;flex-direction:column;gap:1px}
.session-row{display:flex;align-items:center;gap:8px;padding:7px 8px;border:1px solid transparent;border-radius:10px;
  background:transparent;cursor:pointer;text-align:left;width:100%;font-family:inherit}
.session-row:hover{background:#fff;border-color:var(--f-border)}
.session-row.is-selected{background:#fff;border-color:var(--f-blue-line);box-shadow:0 1px 2px rgba(16,17,20,.05)}
.session-row:focus-visible{outline:2px solid var(--f-focus);outline-offset:1px}
.session-main{min-width:0;display:flex;flex-direction:column;gap:0}
.session-title{font-size:12.5px;line-height:18px;color:var(--f-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.session-meta{font-size:11px;line-height:15px;color:var(--f-text-4);display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.session-flags{margin-left:auto;display:flex;gap:4px;align-items:center;flex:0 0 auto}
.session-more{align-self:flex-start;color:#0857B8;margin:2px 0 0 2px}
.session-cta{margin:2px 10px 8px 31px;padding:8px 10px;border:1px solid var(--f-border);border-radius:12px;
  background:var(--f-surface-2);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.session-cta-text{font-size:11.5px;color:var(--f-text-3);min-width:0;flex:1 1 120px}
.slot-empty{margin:6px 2px 0;min-height:62px;display:flex;align-items:center;gap:10px;padding:10px 12px;
  border:1px dashed var(--f-border-strong);border-radius:14px;background:rgba(255,255,255,.55);color:var(--f-text-4)}
.slot-empty .slot-index{margin-left:auto;font-size:11px;font-variant-numeric:tabular-nums;color:var(--f-text-4);white-space:nowrap}
.slot-empty-text{font-size:11.5px;line-height:16px;min-width:0}
.notice{margin:0 2px 10px;padding:10px 12px;border:1px solid var(--f-border);border-left:3px solid var(--f-text-4);
  border-radius:12px;background:var(--f-surface-2);display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap}
.notice--ok{border-left-color:var(--f-green);background:var(--f-green-wash);border-color:var(--f-green-line)}
.notice--bad{border-left-color:var(--f-red);background:var(--f-red-wash);border-color:var(--f-red-line)}
.notice--warn{border-left-color:var(--f-orange);background:var(--f-orange-wash);border-color:var(--f-orange-line)}
.notice-main{min-width:0;flex:1 1 220px;display:flex;flex-direction:column;gap:2px}
.notice-title{font-size:12.5px;font-weight:600;color:var(--f-text);display:flex;gap:6px;align-items:center}
.notice-text{font-size:11.5px;line-height:17px;color:var(--f-text-2);word-break:break-word}
.notice-actions{display:flex;gap:4px;align-items:center;flex-wrap:wrap}

/* 分身 */
.fork-group{margin-bottom:2px}
.group-head{display:flex;align-items:center;gap:8px;padding:10px 6px 6px;position:sticky;top:0;z-index:3;
  background:linear-gradient(#fff 76%,rgba(255,255,255,0))}
.group-toggle{display:inline-flex;align-items:center;gap:7px;border:0;background:transparent;padding:4px 6px;
  border-radius:8px;font-family:inherit;font-size:13px;font-weight:600;color:var(--f-text);cursor:pointer}
.group-toggle:hover{background:var(--f-surface-3)}
.group-toggle:focus-visible{outline:2px solid var(--f-focus);outline-offset:1px}
.group-count{font-size:11px;color:var(--f-text-4);font-variant-numeric:tabular-nums}
.group-head .spacer{flex:1}
.fork-card{position:relative;margin:6px 4px 10px;padding:14px 16px 12px;border:1px solid var(--f-border);border-radius:18px;
  background:var(--f-surface);box-shadow:var(--f-shadow-card);overflow:hidden;
  transition:box-shadow .18s ease,border-color .18s ease,transform .18s ease}
.fork-card::before{content:"";position:absolute;left:0;top:14px;bottom:14px;width:4px;border-radius:0 4px 4px 0;background:var(--bar,var(--f-border-strong))}
.fork-card[data-bar="ok"]{--bar:var(--f-green)}
.fork-card[data-bar="info"]{--bar:var(--f-blue)}
.fork-card[data-bar="warn"]{--bar:var(--f-orange)}
.fork-card[data-bar="bad"]{--bar:var(--f-red)}
.fork-card.is-anomaly{border-color:var(--f-red-line)}
.fork-card:hover{box-shadow:var(--f-shadow-panel)}
@media (hover:hover){.fork-card:hover{transform:translateY(-1px)}}
.fork-head{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}
.fork-head-main{min-width:0;flex:1 1 260px;display:flex;flex-direction:column;gap:4px}
.fork-title{font-size:17px;font-weight:600;line-height:23px;letter-spacing:-.012em;color:var(--f-text);overflow-wrap:anywhere}
.fork-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.fork-actions{display:flex;align-items:center;gap:4px;flex-wrap:wrap;justify-content:flex-end;margin-left:auto}
.fork-meta{margin-top:8px;display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11.5px;color:var(--f-text-3);
  font-variant-numeric:tabular-nums;align-items:center}
.fork-meta code{font-family:var(--f-mono);font-size:11px;color:var(--f-text-3);background:var(--f-surface-3);
  padding:1px 5px;border-radius:5px}
.fork-warn{margin-top:8px;font-size:11.5px;line-height:17px;color:var(--f-red);display:flex;gap:6px;align-items:flex-start}
.fork-sub{margin-top:10px;padding-top:8px;border-top:1px solid var(--f-border)}
.fork-sub-head{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--f-text-3)}
.fork-sub-head .spacer{flex:1}
.fork-sessions{margin-top:4px;display:flex;flex-direction:column;gap:1px}
.fork-session{display:flex;align-items:center;gap:8px;padding:6px;border-radius:8px}
.fork-session:hover{background:var(--f-surface-2)}
.fork-session-title{font-size:12.5px;color:var(--f-text);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fork-session-meta{font-size:11px;color:var(--f-text-4);margin-left:auto;white-space:nowrap}
.empty{margin:8px 4px;padding:24px 16px;border:1px dashed var(--f-border-strong);border-radius:16px;
  background:rgba(255,255,255,.5);display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center}
.empty-title{font-size:13px;font-weight:600;color:var(--f-text)}
.empty-text{font-size:11.5px;line-height:18px;color:var(--f-text-3);max-width:380px}
.loading-line{padding:18px 8px;font-size:12px;color:var(--f-text-3);display:flex;align-items:center;gap:8px;justify-content:center}

/* 浮窗 / 毛玻璃 */
.overlay{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:22px;
  background:rgba(18,19,22,.28);backdrop-filter:blur(7px);animation:fang-fade .16s ease}
.glass{width:min(620px,100%);max-height:min(84vh,900px);display:flex;flex-direction:column;overflow:hidden;
  border:1px solid rgba(255,255,255,.72);border-radius:24px;
  background:rgba(252,252,253,.86);backdrop-filter:blur(30px) saturate(1.7);
  box-shadow:var(--f-shadow-float),inset 0 1px 0 rgba(255,255,255,.9);
  animation:fang-rise .24s cubic-bezier(.22,.61,.36,1)}
.glass--sm{width:min(460px,100%)}
.glass-head{display:flex;align-items:flex-start;gap:12px;padding:20px 22px 12px;border-bottom:1px solid rgba(16,17,20,.06)}
.glass-head-main{min-width:0;flex:1 1 auto}
.glass-title{font-size:19px;font-weight:600;line-height:26px;color:var(--f-text);display:flex;align-items:center;gap:8px}
.glass-sub{font-size:11.5px;line-height:16px;color:var(--f-text-3);margin-top:2px}
.glass-body{padding:16px 22px;overflow:auto;display:flex;flex-direction:column;gap:14px;flex:1 1 auto;min-height:0}
.glass-foot{padding:12px 22px 18px;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;
  border-top:1px solid rgba(16,17,20,.06)}
.kv{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
@media (max-width:520px){.kv{grid-template-columns:1fr}}
.kv-item{padding:9px 11px;border:1px solid var(--f-border);border-radius:12px;background:rgba(255,255,255,.66)}
.kv-label{font-size:10.5px;color:var(--f-text-3);letter-spacing:.02em}
.kv-value{margin-top:2px;font-size:13px;color:var(--f-text);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.glass-section{display:flex;flex-direction:column;gap:8px}
.glass-section-title{font-size:12px;font-weight:600;color:var(--f-text);display:flex;align-items:center;gap:8px}
.glass-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.backup-row{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--f-border);font-size:11.5px;
  color:var(--f-text-3);flex-wrap:wrap}
.backup-row:last-child{border-bottom:0}
.backup-row .spacer{flex:1}
.hint{font-size:11px;line-height:17px;color:var(--f-text-3)}
.field{display:flex;gap:6px;flex-wrap:wrap}
.field input{flex:1 1 220px;min-width:0;height:34px;padding:0 10px;font-size:12.5px;color:var(--f-text);
  background:#fff;border:1px solid var(--f-border);border-radius:10px;outline:none}
.field input:focus{border-color:var(--f-blue);box-shadow:0 0 0 3px rgba(10,107,224,.14)}
.confirm-body{font-size:12.5px;line-height:19px;color:var(--f-text-2)}
.confirm-body strong{color:var(--f-text)}

/* 页脚 / 版本 / 读档入口 */
.fang-foot{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:2px 6px 0;
  font-size:11px;color:var(--f-text-4);flex:0 0 auto}
.fang-foot .hint{font-size:11px;color:var(--f-text-4);min-width:0;flex:1 1 260px}
.fang-foot-right{display:inline-flex;align-items:center;gap:10px;margin-left:auto}
.fh-version{font-family:var(--f-mono);font-size:10.5px;color:var(--f-text-4);letter-spacing:.02em;
  padding:2px 7px;border:1px solid var(--f-border);border-radius:999px;background:rgba(255,255,255,.6);white-space:nowrap}
.fang-portal-link{display:inline-flex;align-items:center;gap:3px;color:var(--f-text-3);text-decoration:none;
  font-size:11px;padding:2px 4px;border-radius:6px}
.fang-portal-link:hover{color:var(--f-text);background:rgba(16,17,20,.05)}
.fang-portal-link:focus-visible{outline:2px solid var(--f-focus);outline-offset:1px}
.readarch-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:4px 8px 8px}
.readarch-row .hint{flex:1 1 200px}
.notice--info{border-left-color:var(--f-blue);background:var(--f-blue-wash);border-color:var(--f-blue-line)}

/* 侧边图标 / 输入框徽标（宿主内联渲染，不用面板 token 之外的布局） */
.fang-mount{contain:layout style}
.fang-glyph{display:inline-flex;align-items:center;justify-content:center;line-height:0;color:inherit;cursor:pointer}
.fang-glyph svg{width:100%;height:100%}
.fang-badge{display:inline-flex;align-items:center;gap:6px;padding:2px 7px;border-radius:999px;
  border:1px solid rgba(127,127,127,.28);font-size:11px;line-height:16px;color:#5F6368;user-select:none;
  background:transparent;transition:background .12s ease}
.fang-badge:hover{background:rgba(127,127,127,.07)}
.fang-badge-dot{width:6px;height:6px;border-radius:50%;background:#0A6BE0;display:inline-block;flex:0 0 auto}
.fang-badge[data-tone="ok"] .fang-badge-dot{background:#17803D}
.fang-badge[data-tone="warn"] .fang-badge-dot{background:#B45309}
.fang-badge[data-tone="bad"] .fang-badge-dot{background:#C8102E}
.fang-badge-btn{border:0;background:transparent;padding:0;font:inherit;color:inherit;cursor:pointer;line-height:inherit}
.fang-badge-btn:focus-visible{outline:2px solid #0A6BE0;outline-offset:2px;border-radius:3px}
.fang-badge-link{color:#5F6368;text-decoration:none;font-size:10px;line-height:14px;padding:0 4px;
  border-radius:999px;border:1px solid rgba(127,127,127,.28)}
.fang-badge-link:hover{color:#1D1D1F}

/* 就地重命名 */
.edit-text{display:inline;border:0;background:transparent;padding:0;margin:0;font:inherit;color:inherit;
  text-align:left;cursor:text;border-radius:4px;line-height:inherit}
.edit-text:hover{box-shadow:0 0 0 1px var(--f-border-strong)}
.edit-text:focus-visible{outline:2px solid var(--f-focus);outline-offset:2px}
.edit-input{font:inherit;color:var(--f-text);background:#fff;border:1px solid var(--f-blue);border-radius:6px;
  padding:0 5px;margin:-1px -5px;outline:none;box-shadow:0 0 0 3px rgba(10,107,224,.14);min-width:60px;width:100%;line-height:inherit}
.edit-busy{opacity:.55}

/* 容量 / 配额 / 只读边界 */
.capacity{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 6px 0;font-size:11px;color:var(--f-text-3)}
.capacity-label{font-weight:600;color:var(--f-text-2);font-variant-numeric:tabular-nums}
.capacity-dots{display:inline-flex;gap:4px;align-items:center}
.cap-dot{width:16px;height:6px;border-radius:999px;background:var(--f-surface-3);border:1px solid var(--f-border);display:inline-block}
.cap-dot.is-used{background:var(--f-green);border-color:var(--f-green)}
.cap-dot.is-locked{background:transparent;border-style:dashed;border-color:var(--f-border-strong);opacity:.7}
.capacity-note{color:var(--f-text-4);font-variant-numeric:tabular-nums}
.quota-reason{display:inline-flex;align-items:center;height:26px;padding:0 9px;border-radius:999px;
  font-size:11px;color:var(--f-red);background:var(--f-red-wash);border:1px solid var(--f-red-line);white-space:nowrap}
.section-hint{font-size:10.5px;color:var(--f-text-4);border:1px solid var(--f-border);border-radius:999px;
  padding:2px 8px;background:var(--f-surface-2);white-space:nowrap}
.section-foot{padding:10px 8px 2px;margin-top:8px;border-top:1px dashed var(--f-border);
  font-size:10.5px;line-height:16px;color:var(--f-text-4)}

/* toast + live region */
.toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:120;display:flex;align-items:center;gap:8px;
  padding:10px 14px;border-radius:14px;background:rgba(29,29,31,.93);color:#fff;font-size:12.5px;
  box-shadow:0 14px 36px rgba(0,0,0,.26);max-width:min(580px,calc(100vw - 32px));animation:fang-rise .18s ease}
.toast--ok{background:rgba(18,107,51,.95)}
.toast--bad{background:rgba(168,13,38,.96)}
.toast--warn{background:rgba(120,58,6,.95)}
.live{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}

@media (max-width:760px){
  .fang-console{padding:12px 12px 18px}
  .fh-title{font-size:21px}
  .fh-actions{width:100%;justify-content:flex-start}
  .fh-actions .btn{flex:1 1 auto}
  .mother-actions .text-action{display:none}
  .mother-row.is-open .mother-actions .text-action{display:inline-block}
  .panel-title{font-size:18px}
  .overlay{padding:10px;align-items:flex-end}
  .glass{max-height:92vh;border-radius:20px}
}
@media (hover:none){
  .mother-actions .text-action{display:inline-block}
  .fork-card:hover{transform:none}
  .btn:hover{background:transparent}
  .btn--ghost:hover{background:var(--f-surface);border-color:var(--f-border)}
  .text-action:hover{background:transparent}
  .expand-btn{width:34px;height:34px}
  .btn--sm{height:34px}
}
@media (prefers-reduced-motion:reduce){
  .fang-console *,.fang-console *::before,.fang-console *::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
}
      `
      target.head.appendChild(style)
    }


    // ── 本地别名（重命名的持久层）─────────────────────────────────────────
    // 宿主当前没有「重命名元主/会话」的写路由。本轮把重命名定义为“本地别名”：
    // 只写 localStorage，绝不假装已经写回宿主；宿主一旦提供 PUT 路由，
    // 只需替换 saveAlias 的实现，EditableText 的 Enter/Esc/blur/回滚语义不变。
    const ALIAS_PREFIX = 'fang.mother.alias.'
    const ALIAS_ROUTE_PENDING = true
    function loadAliases() {
      const out = {}
      try {
        if (typeof window === 'undefined' || !window.localStorage) return out
        for (let index = 0; index < window.localStorage.length; index += 1) {
          const key = window.localStorage.key(index)
          if (!key || !key.startsWith(ALIAS_PREFIX)) continue
          const value = window.localStorage.getItem(key)
          if (value) out[key.slice(ALIAS_PREFIX.length)] = value
        }
      } catch { /* storage 不可用：别名只在内存 */ }
      return out
    }
    function saveAliasLocal(key, value) {
      return new Promise((resolve, reject) => {
        try {
          if (typeof window === 'undefined' || !window.localStorage) throw new Error('当前环境没有 localStorage')
          window.localStorage.setItem(ALIAS_PREFIX + key, value)
          resolve()
        } catch (error) { reject(error) }
      })
    }

    /**
     * 重命名写通道（目标契约 v3.0.6）：PATCH /fang/api/workspaces/:key
     * 旧宿主没有该路由时（404/405）退化为本地别名并如实告知；网络错误不回退，避免“假成功”。
     * 409 = 其他客户端已改：抛 conflict，由调用方回滚并提示当前值。
     */
    async function saveAlias(key, value, baseAliasRev) {
      const result = await api('/fang/api/workspaces/' + encodeURIComponent(key), {
        method: 'PATCH',
        body: JSON.stringify({ alias: value, baseAliasRev: Number(baseAliasRev) || 0 }),
      })
      if (result.status === 200 && result.body && result.body.ok !== false) {
        return { scope: 'host', aliasRev: result.body.aliasRev ?? null }
      }
      if (result.status === 409) {
        const error = new Error('conflict')
        error.conflict = String(result.body?.conflict ?? result.body?.alias ?? '')
        throw error
      }
      if (result.status === 404 || result.status === 405) {
        await saveAliasLocal(key, value)
        return { scope: 'local' }
      }
      throw new Error(result.body?.error || (result.status ? 'http-' + result.status : 'network'))
    }

    // ── 派生共享 store：面板、侧边图标、输入框徽标共用一次单飞请求 ──────────
    const deriveStore = {
      value: null,        // {pending,at} | {ok,taskId,url,port,adapter,at} | {ok:false,error,message,detail,at}
      inflight: null,
      lastGesture: 0,
      listeners: new Set(),
      notify() { for (const fn of [...this.listeners]) { try { fn(this.value) } catch { /* ignore */ } } },
      subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) },
    }
    function runDerive(payload) {
      if (deriveStore.inflight) return deriveStore.inflight
      deriveStore.value = { pending: true, at: Date.now() }
      deriveStore.notify()
      const run = (async () => {
        try {
          const result = await api('/fang/api/derive', { method: 'POST', body: JSON.stringify(payload) })
          const body = result.body
          if (body?.ok) {
            deriveStore.value = { ok: true, taskId: body.taskId, url: body.url, port: body.port, adapter: body.adapter, at: Date.now() }
            try { if (body.url) window.open(body.url, '_blank', 'noopener') } catch { /* 弹窗被拦 → 面板结果条兜底 */ }
          } else {
            const code = body?.error || (result.status ? 'http-' + result.status : 'network')
            deriveStore.value = { ok: false, error: code, message: failureHint(code), detail: body?.detail || diagnosticText(result.diagnostic), at: Date.now() }
          }
        } catch (error) {
          deriveStore.value = { ok: false, error: 'network', message: failureHint('network'), detail: String(error?.message ?? error), at: Date.now() }
        } finally {
          deriveStore.inflight = null
          deriveStore.notify()
        }
        return deriveStore.value
      })()
      deriveStore.inflight = run
      return run
    }
    function quickDerive(title) {
      const now = Date.now()
      if (now - deriveStore.lastGesture < 2000) return deriveStore.inflight ?? Promise.resolve(deriveStore.value)
      deriveStore.lastGesture = now
      return runDerive({ title: title || '快速派生' })
    }

    // ── 控制台应用 ────────────────────────────────────────────────────────
    function createConsole(host) {
      injectStyle(host.ownerDocument)
      const previous = host.querySelector('.fang-console')
      if (previous) previous.remove()

      const S = {
        role: { value: 'unknown', error: '', at: 0 },
        status: { state: 'loading', data: null, error: '', diagnostic: null, at: 0 },
        tasks: { state: 'loading', items: [], error: '', diagnostic: null, at: 0 },
        sessions: { state: 'loading', items: [], total: 0, degraded: [], error: '', diagnostic: null, at: 0 },
        forkSessions: new Map(),
        query: '',
        selectedSessionId: '',
        expanded: new Set(),
        collapsed: new Set(['temporary']),
        showTemporary: readPref('fang.panel.showTemporary', true),
        view: 'console',
        busy: '',
        refreshing: false,
        notice: null,
        derive: deriveStore.value,
        modal: null,
        editing: null,
        toast: null,
        aliases: loadAliases(),
        mirror: { state: 'idle', data: null, error: '', busy: '', etag: '' },
        link: { state: 'idle', data: null, error: '', probe: null, target: resolveMotherOrigin(), busy: false },
        lastRefreshAt: 0,
      }

      const root = h('div', { class: 'fang-console', 'data-fang-console': 'v4' })
      const polite = h('div', { class: 'live', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' })
      const assertive = h('div', { class: 'live', role: 'alert', 'aria-live': 'assertive', 'aria-atomic': 'true' })
      const view = h('div', { class: 'fang-view', style: { display: 'contents' } })
      root.append(polite, assertive, view)
      host.append(root)

      let alive = true
      let renderQueued = false
      let refreshingLock = false
      let refreshSeq = 0
      let pollTimer = 0
      let toastTimer = 0
      let deriveTicker = 0
      const forkSeq = new Map()

      let scrollLocked = false
      let scrollLockPrev = ''
      const lockScroll = () => {
        if (scrollLocked) return
        scrollLocked = true
        try {
          const body = host.ownerDocument.body
          scrollLockPrev = body.style.overflow || ''
          body.style.overflow = 'hidden'
        } catch { /* ignore */ }
      }
      const unlockScroll = () => {
        if (!scrollLocked) return
        scrollLocked = false
        try { host.ownerDocument.body.style.overflow = scrollLockPrev } catch { /* ignore */ }
      }
      const announce = (message, mode = 'polite') => {
        const node = mode === 'assertive' ? assertive : polite
        node.textContent = ''
        window.setTimeout(() => { node.textContent = String(message ?? '') }, 30)
      }
      const notify = (tone, text, options = {}) => {
        S.toast = { tone, text, id: Date.now() + Math.random() }
        if (toastTimer) window.clearTimeout(toastTimer)
        toastTimer = window.setTimeout(() => { if (alive) { S.toast = null; render() } }, options.sticky ? 8000 : 4200)
        if (tone === 'bad') announce(text, 'assertive')
        if (alive) render(true)
      }
      const setNotice = (notice) => { S.notice = notice; render() }

      // 渲染：整棵视图重建 + 焦点/滚动/光标恢复；编辑中挂起后台刷新，避免输入被重建。
      function render(force = false) {
        if (!alive) return
        if (S.editing && !force) return
        renderQueued = false
        const doc = host.ownerDocument
        const active = doc.activeElement
        const activeFk = active && view.contains(active) ? active.getAttribute?.('data-fk') : ''
        const selection = active && typeof active.selectionStart === 'number' && activeFk
          ? [active.selectionStart, active.selectionEnd]
          : null
        const scrolls = new Map()
        view.querySelectorAll('[data-sk]').forEach((node) => scrolls.set(node.getAttribute('data-sk'), node.scrollTop))

        view.replaceChildren(renderApp(S, app))

        view.querySelectorAll('[data-sk]').forEach((node) => {
          const top = scrolls.get(node.getAttribute('data-sk'))
          if (top) node.scrollTop = top
        })
        const dialog = S.modal ? view.querySelector('[role="dialog"],[role="alertdialog"]') : null
        const activeInDialog = !!(dialog && active && dialog.contains(active))
        if (S.modal && dialog && !activeInDialog) {
          const initial = dialog.querySelector('[data-autofocus]') || dialog.querySelector('button,input,a[href]')
          if (initial) initial.focus({ preventScroll: true })
        } else if (activeFk) {
          const next = view.querySelector(`[data-fk="${escapeSelector(activeFk)}"]`)
          if (next && typeof next.focus === 'function') {
            next.focus({ preventScroll: true })
            if (selection && typeof next.setSelectionRange === 'function') {
              try { next.setSelectionRange(selection[0], selection[1]) } catch { /* ignore */ }
            }
          }
        }
      }
      function schedule(force = false) {
        if (!alive) return
        if (S.editing && !force) return
        if (force) { render(true); return }
        if (renderQueued) return
        renderQueued = true
        window.requestAnimationFrame(() => { if (alive) render() })
      }

      // ── 数据 ────────────────────────────────────────────────────────────
      async function detectRole(force = false) {
        if (!force && S.role.at) return S.role.value
        const status = await api('/fang/api/status')
        if (status.status === 200 && status.body && status.body.ok !== false) {
          S.role = { value: 'mother', error: '', at: Date.now() }
        } else {
          const hello = await api('/fang/adapter/hello')
          S.role = hello.status === 200 || hello.status === 401
            ? { value: 'fork', error: '', at: Date.now() }
            : { value: 'unknown', error: `status ${status.status} · adapter ${hello.status}`, at: Date.now() }
        }
        return S.role.value
      }

      async function loadForkSessions(taskId) {
        const id = String(taskId ?? '')
        if (!id) return
        const seq = (forkSeq.get(id) || 0) + 1
        forkSeq.set(id, seq)
        S.forkSessions.set(id, { ...(S.forkSessions.get(id) || { items: [] }), state: 'loading', busy: true })
        schedule()
        const result = await api('/fang/api/tasks/sessions?taskId=' + encodeURIComponent(id) + '&limit=20')
        if (!alive || forkSeq.get(id) !== seq) return
        if (result.status === 200 && result.body && result.body.ok !== false) {
          const items = Array.isArray(result.body.sessions) ? result.body.sessions : []
          S.forkSessions.set(id, {
            state: 'ready', items, busy: false, at: Date.now(),
            total: Number(result.body.total) || items.length,
            degraded: Array.isArray(result.body.degraded) ? result.body.degraded : [],
          })
        } else {
          const code = result.body?.error || (result.status ? 'http-' + result.status : 'network')
          S.forkSessions.set(id, { state: 'error', items: [], busy: false, error: code, diagnostic: result.diagnostic || null })
        }
        schedule()
      }

      async function refresh(options = {}) {
        if (refreshingLock) return
        refreshingLock = true
        const seq = ++refreshSeq
        if (options.manual) { S.refreshing = true; schedule() }
        try {
          const [statusRes, tasksRes, sessionsRes] = await Promise.all([
            api('/fang/api/status').catch((error) => ({ status: 0, body: null, diagnostic: { message: String(error?.message ?? error) } })),
            api('/fang/api/tasks').catch((error) => ({ status: 0, body: null, diagnostic: { message: String(error?.message ?? error) } })),
            api('/fang/api/sessions').catch((error) => ({ status: 0, body: null, diagnostic: { message: String(error?.message ?? error) } })),
          ])
          if (!alive || seq !== refreshSeq) return

          if (statusRes.status === 200 && statusRes.body && typeof statusRes.body === 'object' && !statusRes.body.error) {
            S.status = { state: 'ready', data: statusRes.body, error: '', diagnostic: null, at: Date.now() }
          } else {
            const code = statusRes.body?.error || (statusRes.status ? 'http-' + statusRes.status : 'network')
            S.status = { ...S.status, state: 'error', error: code, diagnostic: statusRes.diagnostic || null }
          }

          let taskItems = []
          if (tasksRes.status === 200 && Array.isArray(tasksRes.body?.tasks)) {
            taskItems = tasksRes.body.tasks
            S.tasks = { state: 'ready', items: taskItems, error: '', diagnostic: null, at: Date.now() }
          } else {
            const code = tasksRes.body?.error || (tasksRes.status ? 'http-' + tasksRes.status : 'network')
            S.tasks = { ...S.tasks, state: 'error', error: code, diagnostic: tasksRes.diagnostic || null }
          }

          if (sessionsRes.status === 200 && sessionsRes.body && sessionsRes.body.ok !== false) {
            const body = sessionsRes.body
            const items = Array.isArray(body.sessions) ? body.sessions : []
            const degraded = Array.isArray(body.degraded) ? body.degraded : []
            const softEmpty = body.readable === false && degraded.includes('sessions-root-missing')
            const readable = body.readable !== false || softEmpty
            S.sessions = {
              state: readable ? 'ready' : 'error', items, total: Number(body.total) || items.length, degraded,
              error: readable ? '' : (degraded[0] || 'sessions-unreadable'), diagnostic: sessionsRes.diagnostic || null, at: Date.now(),
            }
          } else {
            const code = sessionsRes.body?.error || (sessionsRes.status ? 'http-' + sessionsRes.status : 'network')
            S.sessions = { ...S.sessions, state: 'error', error: code, diagnostic: sessionsRes.diagnostic || null }
          }

          S.lastRefreshAt = Date.now()
          if (!options.silent) schedule()
          // 分身会话：首次出现时预热一次（拿到会话数），之后只为展开的卡片刷新；
          // 失败按卡独立，不拖垮整列，也不做 N+1 的每 5 秒全量轮询。
          const targets = taskItems.filter((task) => ['ready', 'running', 'failed'].includes(String(task?.status ?? ''))
            && (S.expanded.has('fork:' + task.taskId) || !S.forkSessions.has(String(task.taskId))))
          for (const task of targets) void loadForkSessions(task.taskId)
        } finally {
          refreshingLock = false
          if (alive && options.manual) { S.refreshing = false; schedule() }
        }
      }

      function startPolling() {
        if (pollTimer) return
        pollTimer = window.setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          if (S.modal) return
          void refresh({ silent: true })
        }, POLL_MS)
      }

      // ── 动作 ────────────────────────────────────────────────────────────
      const isBusy = () => S.busy !== ''

      async function deriveTask(payload) {
        if (deriveStore.inflight) return
        deriveStore.lastGesture = Date.now()
        S.notice = null
        const result = await runDerive(payload)
        if (!alive) return
        if (result?.ok) {
          S.selectedSessionId = ''
          setNotice({
            tone: 'ok', title: payload?.sessionId ? '已派发：从会话继续' : '已派生新分身',
            message: `${result.taskId}${result.port ? ' · 端口 ' + result.port : ''}${result.adapter?.ok ? ' · 适配器已就绪' : ' · 适配器尚未就绪，右栏会标出健康状态'}`,
            actions: result.url ? [{ label: '打开分身', href: result.url }] : [],
          })
          await refresh()
        } else if (result) {
          setNotice({
            tone: 'bad', title: '派生失败', message: result.message || failureHint(result.error),
            detail: result.detail, actions: [{ label: '重试', onClick: () => void deriveTask(payload) }],
          })
        }
      }

      function askConfirm(options) {
        lockScroll()
        S.modal = {
          kind: 'confirm', tone: options.tone || 'bad', title: options.title, message: options.message,
          confirmLabel: options.confirmLabel || '确认', returnFk: document.activeElement?.getAttribute?.('data-fk') || '',
          strong: !!options.strong, expected: String(options.expected || ''), typed: '', confirm: options.confirm || 'once',
          onConfirm: options.onConfirm,
        }
        render(true)
      }
      function askPrompt(options) {
        lockScroll()
        S.modal = {
          kind: 'prompt', title: options.title, label: options.label, value: options.value || '',
          confirmLabel: options.confirmLabel || '确定', hint: options.hint || '', error: '',
          returnFk: document.activeElement?.getAttribute?.('data-fk') || '',
          onConfirm: options.onConfirm,
        }
        render(true)
      }
      function closeModal() {
        const modal = S.modal
        S.modal = null
        unlockScroll()
        render(true)
        const fk = modal?.returnFk
        if (fk) {
          const node = view.querySelector(`[data-fk="${escapeSelector(fk)}"]`)
          if (node) node.focus({ preventScroll: true })
        }
      }

      async function archiveTask(task) {
        if (isBusy()) return
        askConfirm({
          title: '归档分身？',
          confirm: 'archive',
          tone: 'info',
          message: `「${task.title || task.taskId}」\nID ${short(task.taskId, 12)} · 端口 ${task.port ?? '—'} · 会话 ${S.forkSessions.get(String(task.taskId))?.total ?? '—'}\n\n会先 flush 分身缓冲并落审计，然后停止进程；home 保留，可在「读档」里还原或永久删除。`,
          confirmLabel: '归档',
          onConfirm: async () => {
            S.busy = 'archive:' + task.taskId
            setNotice(null)
            const result = await api('/fang/api/tasks/archive', { method: 'POST', body: JSON.stringify({ taskId: task.taskId }) })
            S.busy = ''
            const body = result.body
            if (result.status === 200 && body?.ok) {
              setNotice({ tone: 'ok', title: body.already ? '已在存档中' : '已归档', message: `${task.title || task.taskId} · 进程已停止，存档保留。` })
            } else {
              const code = body?.error || (result.status ? 'http-' + result.status : 'network')
              setNotice({ tone: 'bad', title: code === 'stop-failed' ? '归档失败：进程未停止' : '归档失败', message: failureHint(code), detail: body?.detail || diagnosticText(result.diagnostic) })
            }
            await refresh()
          },
        })
      }

      async function restoreTask(task) {
        if (isBusy()) return
        askConfirm({
          tone: 'info',
          title: '还原存档？',
          confirm: 'restore',
          message: `「${task.title || task.taskId}」会用原存档重新启动（新端口、新 token），存档内容不会丢失。`,
          confirmLabel: '还原',
          onConfirm: async () => {
            S.busy = 'restore:' + task.taskId
            const result = await api('/fang/api/tasks/restore', { method: 'POST', body: JSON.stringify({ taskId: task.taskId }) })
            S.busy = ''
            const body = result.body
            if (result.status === 200 && body?.ok) {
              S.view = 'console'
              setNotice({ tone: 'ok', title: '已还原存档', message: `${task.title || task.taskId} 已重新启动 · 端口 ${body.port ?? '—'}`, actions: body.url ? [{ label: '打开分身', href: body.url }] : [] })
            } else {
              const code = body?.error || (result.status ? 'http-' + result.status : 'network')
              setNotice({ tone: 'bad', title: '还原失败', message: failureHint(code), detail: body?.detail || diagnosticText(result.diagnostic) })
            }
            await refresh()
          },
        })
      }

      async function deleteArchive(task) {
        if (isBusy()) return
        askConfirm({
          title: '永久删除存档？',
          confirm: 'delete',
          strong: true,
          expected: task.title || short(task.taskId, 12),
          message: `将删除「${task.title || task.taskId}」的 home 与存档记录，此操作不可撤销。`,
          confirmLabel: '永久删除',
          onConfirm: async () => {
            S.busy = 'delete:' + task.taskId
            const result = await api('/fang/api/tasks/archive/delete', { method: 'POST', body: JSON.stringify({ taskId: task.taskId }) })
            S.busy = ''
            const body = result.body
            if (result.status === 200 && body?.ok) setNotice({ tone: 'ok', title: '存档已删除', message: `${task.title || task.taskId} 的存档与 home 已删除。` })
            else {
              const code = body?.error || (result.status ? 'http-' + result.status : 'network')
              setNotice({ tone: 'bad', title: '删除存档失败', message: failureHint(code), detail: body?.detail || diagnosticText(result.diagnostic) })
            }
            await refresh()
          },
        })
      }

      function promoteTask(task) {
        if (isBusy()) return
        askPrompt({
          title: '提升插件',
          label: '插件目录名（位于该分身的缓冲区内）',
          confirmLabel: '提升',
          hint: '提升会把分身里验证过的插件目录写入母体；只接受目录名。',
          onConfirm: async (pluginId) => {
            if (!pluginId) { S.modal.error = '请填写插件目录名'; render(true); return false }
            S.busy = 'promote:' + task.taskId
            const result = await api('/fang/api/tasks/promote', { method: 'POST', body: JSON.stringify({ taskId: task.taskId, pluginId }) })
            S.busy = ''
            const body = result.body
            if (body?.ok) setNotice({ tone: 'ok', title: '提升已批准', message: body.note || body.target || `已提升 ${pluginId}` })
            else setNotice({ tone: 'bad', title: '提升被拒', message: failureHint(body?.error || 'unknown'), detail: body?.detail || diagnosticText(result.diagnostic) })
            await refresh()
            return true
          },
        })
      }

      async function openTask(task) {
        const taskId = String(task?.taskId ?? '')
        if (taskId) {
          const result = await api(`/fang/api/tasks/open-url?taskId=${encodeURIComponent(taskId)}`)
          if (result.status === 200 && result.body?.url) {
            try { window.open(result.body.url, '_blank', 'noopener'); return } catch { /* 弹层被拦 */ }
          }
        }
        if (!task?.url) { notify('warn', '该分身没有可打开的 URL（可能已停止）；可归档回收。'); return }
        try { window.open(task.url, '_blank', 'noopener') } catch { /* ignore */ }
      }

      async function copyText(text, label) {
        try {
          await navigator.clipboard.writeText(String(text))
          notify('ok', `已复制${label ? ' ' + label : ''}`)
        } catch { notify('warn', '复制失败：浏览器未授予剪贴板权限') }
      }

      // ── 重命名（双击 / Enter / Esc / blur / 失败回滚）───────────────────
      function beginRename(key, current) {
        if (S.editing) return
        S.editing = { key, value: current, original: current, busy: false }
        render(true)
        window.requestAnimationFrame(() => {
          const input = view.querySelector('[data-edit-input]')
          if (input) { input.focus(); input.select() }
        })
      }
      function cancelRename() {
        if (!S.editing) return
        const key = S.editing.key
        S.editing = null
        render(true)
        const node = view.querySelector(`[data-fk="alias:${escapeSelector(key)}"]`)
        if (node) node.focus({ preventScroll: true })
      }
      async function commitRename() {
        const editing = S.editing
        if (!editing || editing.busy) return
        const value = clampText(editing.value, MAX_TITLE)
        if (!value) { notify('warn', '名称不能为空'); return }
        if (value === editing.original) { cancelRename(); return }
        S.editing = { ...editing, value, busy: true }
        render(true)
        try {
          const outcome = await saveAlias(editing.key, value)
          S.aliases = { ...S.aliases, [editing.key]: value }
          S.editing = null
          if (outcome.scope === 'host') notify('ok', `已重命名为「${value}」（已写回宿主）`)
          else notify('warn', `已保存本地别名「${value}」（宿主未提供写接口，未写回）`)
          announce(`已重命名为 ${value}`)
          render(true)
          const node = view.querySelector(`[data-fk="alias:${escapeSelector(editing.key)}"]`)
          if (node) node.focus({ preventScroll: true })
        } catch (error) {
          S.editing = null
          const conflict = error?.conflict ? String(error.conflict) : ''
          notify('bad', conflict
            ? `名称已被其他客户端改为「${conflict}」，已恢复「${editing.original}」`
            : `重命名失败，已恢复「${editing.original}」`)
          announce('重命名失败，已恢复原名', 'assertive')
          S.lastAliasError = String(error?.message ?? error)
          render(true)
          const node = view.querySelector(`[data-fk="alias:${escapeSelector(editing.key)}"]`)
          if (node) node.focus({ preventScroll: true })
        }
      }

      function toggleTemporary() {
        S.showTemporary = !S.showTemporary
        writePref('fang.panel.showTemporary', S.showTemporary)
        schedule(true)
      }
      function toggleSet(key) {
        if (S.expanded.has(key)) S.expanded.delete(key)
        else S.expanded.add(key)
        schedule()
      }
      function selectSession(session) {
        const id = String(session?.sessionId ?? '')
        S.selectedSessionId = S.selectedSessionId === id ? '' : id
        schedule()
      }
      function toggleForkGroup(key) {
        if (S.collapsed.has(key)) S.collapsed.delete(key)
        else S.collapsed.add(key)
        schedule()
      }

      // ── 母体浮窗数据 ────────────────────────────────────────────────────
      async function loadMirror(force = false) {
        const headers = { accept: 'application/json' }
        if (!force && S.mirror.etag) headers['if-none-match'] = S.mirror.etag
        if (!S.mirror.data) { S.mirror.state = 'loading'; schedule() }
        const result = await api('/fang/api/mirror/status', { headers })
        if (result.status === 304) { S.mirror.state = 'ready'; schedule(); return }
        if (result.status === 200 && result.body && result.body.ok !== false) {
          if (result.etag) S.mirror.etag = result.etag
          S.mirror = { ...S.mirror, state: 'ready', data: result.body, error: '' }
        } else {
          S.mirror = { ...S.mirror, state: 'error', error: String(result.body?.error ?? ('http-' + result.status)) }
        }
        schedule()
      }
      async function mirrorAction(label, run) {
        if (S.mirror.busy) return
        S.mirror = { ...S.mirror, busy: label, error: '' }
        schedule()
        try {
          const out = await run()
          if (out && out.ok === false) S.mirror = { ...S.mirror, error: String(out.error ?? out.reason ?? '操作失败') }
          else notify('ok', label === 'backup' ? '已创建备份' : label === 'upgrade' ? '升级流程已启动' : '操作已完成')
        } catch (error) {
          S.mirror = { ...S.mirror, error: String(error?.message ?? error) }
        } finally {
          S.mirror = { ...S.mirror, busy: '' }
          await loadMirror(true)
        }
      }
      async function loadLink() {
        S.link = { ...S.link, state: 'loading' }
        schedule()
        const result = await api('/fang/api/mother-link')
        if (result.status === 200 && result.body && result.body.ok !== false) S.link = { ...S.link, state: 'ready', data: result.body, error: '' }
        else S.link = { ...S.link, state: 'error', error: String(result.body?.error ?? ('http-' + result.status)) }
        schedule()
      }
      async function probeMother() {
        const target = String(S.link.target ?? '').trim()
        if (!target) return
        S.link = { ...S.link, busy: true, probe: null }
        schedule()
        const result = await api('/fang/api/mother-link/probe', { method: 'POST', body: JSON.stringify({ target }) })
        S.link = { ...S.link, busy: false, probe: result.body ?? { ok: false, error: 'http-' + result.status } }
        schedule()
      }
      function openMother() {
        lockScroll()
        S.modal = { kind: 'mother', title: 'Mother', returnFk: document.activeElement?.getAttribute?.('data-fk') || '' }
        render(true)
        void loadMirror(true)
        if (S.link.state === 'idle') void loadLink()
      }

      // ── 键盘：浮窗 Esc / Tab 焦点陷阱；编辑 Enter/Esc 在输入元素上处理 ──────
      function onRootKeydown(event) {
        if (!S.modal) return
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          closeModal()
          return
        }
        if (event.key !== 'Tab') return
        const dialog = view.querySelector('[role="dialog"],[role="alertdialog"]')
        if (!dialog) return
        const focusables = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
          .filter((node) => !node.hidden && node.getAttribute('aria-hidden') !== 'true')
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
      root.addEventListener('keydown', onRootKeydown)

      // 遮罩点击：只在起点也在遮罩上时关闭（防止浮窗内拖选误关）
      let downOnOverlay = false
      root.addEventListener('mousedown', (event) => { downOnOverlay = event.target?.getAttribute?.('data-overlay') === '1' })
      root.addEventListener('click', (event) => {
        if (!S.modal) return
        if (event.target?.getAttribute?.('data-overlay') === '1' && downOnOverlay) closeModal()
      })

      const unsubscribe = deriveStore.subscribe((value) => { S.derive = value; schedule() })

      const app = {
        state: S, view, render, schedule, refresh, deriveTask, openMother, closeModal,
        archiveTask, restoreTask, deleteArchive, promoteTask, openTask, copyText,
        beginRename, commitRename, cancelRename, selectSession, toggleSet, toggleForkGroup,
        toggleTemporary, setView: (next) => { S.view = next; schedule(true) },
        loadForkSessions, loadMirror, mirrorAction, loadLink, probeMother, notify, announce,
        setEditingValue: (value) => { if (S.editing) S.editing.value = value },
        getEditing: () => S.editing,
        setModalError: (message) => { if (S.modal) { S.modal.error = message; render(true) } },
        getModal: () => S.modal,
        updateLinkTarget: (value) => { S.link = { ...S.link, target: value } },
        refreshAll: async () => { await Promise.all([refresh({ manual: true }), loadMirror(true)]) },
        destroy: () => {
          alive = false
          unlockScroll()
          if (pollTimer) window.clearInterval(pollTimer)
          if (toastTimer) window.clearTimeout(toastTimer)
          if (deriveTicker) window.clearInterval(deriveTicker)
          unsubscribe()
          root.remove()
        },
      }

      // 启动：先探角色；分身 Web UI 不请求母体 API（404 是预期，不是故障）
      void (async () => {
        const role = await detectRole()
        if (!alive) return
        render(true)
        if (role === 'mother') {
          await refresh()
          startPolling()
          deriveTicker = window.setInterval(() => {
            if (!alive || !S.derive?.pending) return
            const line = view.querySelector('[data-derive-elapsed]')
            if (line) line.textContent = `已等待 ${Math.floor((Date.now() - S.derive.at) / 1000)}s · 通常 5–20s`
          }, 1000)
        }
      })()

      render(true)
      return app
    }


    // ── 渲染原语 ──────────────────────────────────────────────────────────
    function chip(tone, text, options = {}) {
      const node = h('span', {
        class: 'chip chip--' + (tone || 'neutral'),
        title: options.title,
        'data-tone': tone,
        'data-state': options.state,
        'data-health': options.health,
        'data-danger': options.danger ? '1' : undefined,
      }, options.dot === false ? null : h('span', { class: 'chip-dot', 'aria-hidden': 'true' }), text)
      return node
    }
    function button(label, options = {}) {
      const opts = options || {}
      const classes = ['btn']
      if (opts.variant) classes.push('btn--' + opts.variant)
      if (opts.size) classes.push('btn--' + opts.size)
      if (opts.iconOnly) classes.push('btn--icon')
      if (opts.block) classes.push('btn--block')
      const iconNode = opts.icon || null
      const leading = opts.iconAfter ? null : iconNode
      const trailing = opts.iconAfter ? iconNode : null
      const node = h('button', {
        type: 'button',
        class: classes.join(' '),
        title: opts.title,
        'aria-label': opts.ariaLabel,
        'aria-busy': opts.busy ? 'true' : undefined,
        'aria-disabled': opts.softDisabled ? 'true' : undefined,
        disabled: opts.disabled ? true : undefined,
        'data-fk': opts.fk,
        'data-btn-id': opts.dataBtnId,
        'data-confirm-level': opts.confirmLevel,
        'data-danger': opts.danger ? '1' : undefined,
        'aria-describedby': opts.describedBy,
        dataset: opts.dataKey ? { key: opts.dataKey } : undefined,
        onClick: opts.onClick,
      }, leading, label, opts.spin ? icon('spinner', 13) : null, trailing)
      if (opts.softDisabled) node.style.opacity = '.45'
      if (opts.iconOnly) {
        node.setAttribute('aria-label', opts.ariaLabel || opts.title || '')
        if (!opts.icon) node.textContent = label
      }
      return node
    }
    function textAction(label, options = {}) {
      const opts = options || {}
      return h('button', {
        type: 'button',
        class: 'text-action' + (opts.danger ? ' text-action--danger' : ''),
        title: opts.title,
        'aria-label': opts.ariaLabel,
        'aria-disabled': opts.softDisabled ? 'true' : undefined,
        'aria-busy': opts.busy ? 'true' : undefined,
        'data-fk': opts.fk,
        'data-btn-id': opts.dataBtnId,
        'data-confirm-level': opts.confirmLevel,
        'data-danger': opts.danger ? '1' : undefined,
        onClick: opts.onClick,
      }, label)
    }
    function sectionToggle(label, expanded, onClick, extra) {
      return h('button', {
        type: 'button', class: 'section-title', 'aria-expanded': expanded ? 'true' : 'false', onClick,
      }, icon('chevron', !expanded, 14), label, extra || null)
    }
    function emptyBlock(title, text, actions) {
      return h('div', { class: 'empty' },
        h('div', { class: 'empty-title' }, title),
        text ? h('div', { class: 'empty-text' }, text) : null,
        actions ? h('div', { class: 'glass-actions', style: { justifyContent: 'center' } }, actions) : null)
    }

    /** EditableText：双击 / Enter / F2 进入编辑；Enter 或失焦提交，Esc 取消，失败回滚。 */
    function editableText(S, app, options) {
      const editing = S.editing && S.editing.key === options.key ? S.editing : null
      if (editing) {
        const input = h('input', {
          class: 'edit-input' + (editing.busy ? ' edit-busy' : ''),
          type: 'text',
          value: editing.value,
          maxlength: MAX_TITLE,
          'data-edit-input': '1',
          'data-fk': 'alias:' + options.key,
          'aria-label': `重命名${options.label}（回车提交，Esc 取消）`,
          'aria-busy': editing.busy ? 'true' : undefined,
          disabled: editing.busy ? true : undefined,
          autocomplete: 'off',
          spellcheck: 'false',
          oninput: (event) => app.setEditingValue(event.target.value),
          onkeydown: (event) => {
            if (event.isComposing || event.keyCode === 229) return
            if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void app.commitRename() }
            else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); app.cancelRename() }
          },
          oncompositionstart: () => { if (S.editing) S.editing.composing = true },
          oncompositionend: () => { if (S.editing) S.editing.composing = false },
          onblur: () => { window.setTimeout(() => { if (app.getEditing() && !app.getEditing().busy) void app.commitRename() }, 120) },
        })
        return input
      }
      return h('button', {
        type: 'button',
        class: 'edit-text',
        'data-fk': 'alias:' + options.key,
        title: `${options.value}\n双击或按 Enter 重命名（本地别名，宿主暂未提供写接口）`,
        'aria-label': `重命名${options.label}：${options.value}`,
        ondblclick: (event) => { event.preventDefault(); app.beginRename(options.key, options.value) },
        onkeydown: (event) => {
          if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); app.beginRename(options.key, options.value) }
        },
      }, options.value)
    }

    // ── 顶部 Header ───────────────────────────────────────────────────────
    function freshnessOf(S) {
      if (S.status.state === 'ready') return 'live'
      return S.status.data ? 'stale' : 'offline'
    }

    function renderStats(S) {
      const data = S.status.data
      const ready = Number(data?.tasks?.ready ?? 0) || 0
      const running = Number(data?.tasks?.running ?? 0) || 0
      const max = data?.tasks?.max ?? '—'
      const total = Number(data?.tasks?.total ?? 0) || 0
      const item = (tone, label, value, title) => h('span', {
        class: 'stat', title, 'data-tone': tone,
        style: { '--dot': TONE[tone]?.dot || TONE.neutral.dot },
      },
      h('span', {
        class: 'stat-dot', 'aria-hidden': 'true',
        style: { background: TONE[tone]?.dot || TONE.neutral.dot, opacity: tone === 'neutral' ? '.55' : '1' },
      }),
      label + ' ', h('b', null, value))
      return h('div', { class: 'fh-stats', role: 'group', 'aria-label': '母体与配额状态' },
        item('neutral', '母体', data?.role === 'fork' ? '分身' : '只读', '母体只读：控制台只读会话元数据，不写入、不改写母体会话。'),
        h('span', { class: 'stat-sep', 'aria-hidden': 'true' }),
        item(ready > 0 ? 'ok' : 'neutral', '就绪', data ? `${ready}/${max}` : '—', `适配器已握手的分身 ${ready} 个 / 上限 ${max} 个。`),
        h('span', { class: 'stat-sep', 'aria-hidden': 'true' }),
        item(running > 0 ? 'bad' : 'neutral', '未握手', data ? String(running) : '—', `进程在跑但适配器未握手的分身 ${running} 个；大于 0 时按三色模型标红。`),
        total > 0 ? h('span', { class: 'stat-sep', 'aria-hidden': 'true' }) : null,
        total > 0 ? item('neutral', '项目', String(total), `当前分身项目总数 ${total}（含临时与存档）。`) : null)
    }

    function renderHeader(S, app) {
      const data = S.status.data
      const cap = projectCapacity(data, S.tasks.items)
      const quotaFull = !cap.deriveEnabled || cap.headroom <= 0
      const reasonId = 'fang-quota-reason'
      const archivedCount = S.tasks.items.filter((task) => String(task.status) === 'archived').length
      const version = data?.version ? 'v' + String(data.version).replace(/^v/, '') : ''

      return h('header', { class: 'fang-head', role: 'banner', 'data-zone': 'header' },
        h('div', { class: 'fh-brand' },
          h('span', { class: 'fh-mark', 'aria-hidden': 'true' }, icon('gate', 24)),
          h('div', { class: 'fh-titles' },
            h('h1', { class: 'fh-title' }, '瓮城'),
            h('span', { class: 'fh-sub' }, '母体 × 分身 · 三区控制台'))),
        renderStats(S),
        h('div', { class: 'fh-actions' },
          quotaFull ? h('span', { class: 'quota-reason', id: reasonId, tabindex: -1, 'data-reason': 'M-05', 'data-reason-code': 'quota-exceeded' }, `配额已满（${cap.used}/${cap.limit}）：先归档旧分身。`) : null,
          button(`${S.view === 'archive' ? '返回面板' : `读档 (${archivedCount})`}`, {
            variant: S.view === 'archive' ? 'ghost' : 'quiet', size: 'sm', dataBtnId: 'M-01',
            title: '读档：查看已归档分身；可还原（重新启动）或永久删除',
            onClick: () => app.setView(S.view === 'archive' ? 'console' : 'archive'),
            fk: 'archive-toggle',
          }),
          button(S.showTemporary ? '隐藏临时内容' : '显示临时内容', {
            variant: 'quiet', size: 'sm',
            title: '临时 = 快速派生的空白分身与空会话；偏好会记住（localStorage）',
            onClick: () => app.toggleTemporary(), fk: 'temp-toggle', dataBtnId: 'M-02',
          }),
          button('刷新', {
            variant: 'ghost', size: 'sm', icon: icon('refresh', 14), busy: S.refreshing,
            title: '重新读取母体状态、分身任务与母体会话', onClick: () => void app.refresh({ manual: true }), fk: 'refresh', dataBtnId: 'M-03',
          }),
          button('Mother', {
            variant: 'ghost', size: 'sm', icon: icon('globe', 14),
            title: '母体浮窗：版本、备份、升级与连接自检（只读优先，写操作均二次确认）',
            onClick: () => app.openMother(), fk: 'mother', dataBtnId: 'M-04',
          }),
          button(quotaFull ? '配额已满' : '派生新分身', {
            variant: 'primary', size: 'lg', icon: icon('plus', 14),
            dataBtnId: 'M-05', confirmLevel: 'none',
            describedBy: quotaFull ? reasonId : undefined,
            title: quotaFull
              ? `配额已满（${cap.used}/${cap.limit}）：先归档旧分身，再派生`
              : `派生一个不继承会话的空白分身（headroom ${cap.headroom}）；绿色 = 派生`,
            softDisabled: quotaFull,
            onClick: () => {
              if (quotaFull) {
                app.notify('warn', `配额已满（${cap.used}/${cap.limit}）：先归档旧分身再派生。`)
                const node = app.view.querySelector('#' + reasonId)
                if (node) node.focus?.()
                return
              }
              void app.deriveTask({ title: '派生新分身' })
            },
            fk: 'derive',
          })),
        version ? h('span', { class: 'fh-version', title: '母体版本' }, version) : null)
    }

    // ── 全局提示（派生结果 / 动作结果 / 接口错误）───────────────────────────
    function renderNotices(S, app) {
      const nodes = []
      const derive = S.derive
      if (derive?.pending) {
        nodes.push(h('div', { class: 'notice notice--info', role: 'status', 'aria-live': 'polite' },
          h('div', { class: 'notice-main' },
            h('div', { class: 'notice-title' }, icon('spinner', 14), '正在派生分身…'),
            h('div', { class: 'notice-text' }, h('span', { 'data-derive-elapsed': '1' }, '已等待 0s · 通常 5–20s'),
              '  结果会落到右栏，也会写进这里。'))))
      } else if (derive && derive.ok === false) {
        nodes.push(h('div', { class: 'notice notice--bad', role: 'alert' },
          h('div', { class: 'notice-main' },
            h('div', { class: 'notice-title' }, icon('alert', 14), '派生失败' + (derive.error ? ` · ${derive.error}` : '')),
            h('div', { class: 'notice-text' }, derive.message || failureHint(derive.error)),
            derive.detail ? h('div', { class: 'notice-text', style: { color: 'var(--f-text-4)' } }, derive.detail) : null),
          h('div', { class: 'notice-actions' },
            button('重试', { size: 'sm', variant: 'ghost', onClick: () => void app.deriveTask({ title: '重试派生' }) }),
            button('知道了', { size: 'sm', variant: 'quiet', onClick: () => { deriveStore.value = null; deriveStore.notify(); app.render(true) } }))))
      }

      const notice = S.notice
      if (notice) {
        nodes.push(h('div', { class: 'notice notice--' + (notice.tone === 'ok' ? 'ok' : notice.tone === 'bad' ? 'bad' : 'warn'), role: 'status' },
          h('div', { class: 'notice-main' },
            h('div', { class: 'notice-title' }, notice.tone === 'ok' ? icon('check', 13) : icon('alert', 14), notice.title),
            h('div', { class: 'notice-text' }, notice.message),
            notice.detail ? h('div', { class: 'notice-text', style: { color: 'var(--f-text-4)', whiteSpace: 'pre-wrap' } }, notice.detail) : null),
          h('div', { class: 'notice-actions' },
            ...(notice.actions || []).map((action, index) => (action.href
              ? h('a', { class: 'btn btn--ghost btn--sm', href: action.href, target: '_blank', rel: 'noopener' }, action.label, icon('external', 11))
              : button(action.label, { size: 'sm', variant: 'ghost', onClick: action.onClick }))),
            button('关闭', { size: 'sm', variant: 'quiet', onClick: () => { S.notice = null; app.schedule(true) } }))))
      }

      const errorCard = (label, slice, onRetry) => {
        if (slice.state !== 'error') return null
        return h('div', { class: 'notice notice--warn', role: 'status' },
          h('div', { class: 'notice-main' },
            h('div', { class: 'notice-title' }, icon('alert', 14), `${label}读取失败 · ${slice.error || 'unknown'}`),
            h('div', { class: 'notice-text' }, failureHint(slice.error) + (slice.at ? `（显示上次成功于 ${fmtShortClock(slice.at)}）` : ''))),
          h('div', { class: 'notice-actions' }, button('重试', { size: 'sm', variant: 'ghost', onClick: onRetry })))
      }
      nodes.push(errorCard('母体状态', S.status, () => void app.refresh({ manual: true })))
      nodes.push(errorCard('分身任务', S.tasks, () => void app.refresh({ manual: true })))
      nodes.push(errorCard('母体会话', S.sessions, () => void app.refresh({ manual: true })))
      return nodes.filter(Boolean)
    }

    // ── 左栏：元主区（工作区槽位 + 会话）──────────────────────────────────
    function sessionSearchText(session) {
      return [sessionTitleInfo(session).text, session.preview, session.sessionId, session.workspaceTitle, session.workspacePath]
        .map((value) => String(value ?? '').toLowerCase()).join(' ')
    }

    function renderMotherPanel(S, app) {
      const freshness = freshnessOf(S)
      const all = S.sessions.items
      const query = S.query.trim().toLowerCase()
      const filtered = query ? all.filter((session) => sessionSearchText(session).includes(query)) : all
      const groups = groupMotherWorkspaces(filtered, S.aliases)
      const split = classifyMotherSessions(filtered)
      const selected = all.find((session) => String(session.sessionId) === S.selectedSessionId) || null
      const countText = query
        ? `${filtered.length}/${all.length}`
        : `${all.length}${S.sessions.total > all.length ? '/' + S.sessions.total : ''}`
      const sessionState = S.sessions.state

      const head = h('div', { class: 'panel-head' },
        h('div', { class: 'panel-title-row' },
          h('h2', { class: 'panel-title' }, '母体'),
          h('span', { class: 'panel-sub' }, '元主 · 项目 & 会话'),
          h('span', { class: 'panel-count', title: '已加载 / 宿主返回的会话总数' }, `${countText} 会话`)),
        (() => {
          const data = S.status.data
          const tone = S.status.state === 'ready' ? 'ok' : data ? 'info' : 'neutral'
          const label = S.status.state === 'ready' ? '运行中' : data ? '状态可能已变' : '离线 / 未知'
          return h('div', { class: 'mother-control', 'data-zone': 'mother-card' },
            h('span', { class: 'mother-control-mark', 'aria-hidden': 'true' }, icon('gate', 17)),
            h('div', { class: 'mother-control-main' },
              h('div', { class: 'mother-control-title' },
                h('span', null, '母体控制面'),
                chip(tone, label, { state: S.status.state === 'ready' ? 'running' : 'unknown' }),
                data?.version ? h('span', { class: 'hint', style: { fontFamily: 'var(--f-mono)' } }, 'v' + String(data.version).replace(/^v/, '')) : null),
              h('div', { class: 'mother-control-sub' }, '只读访问：不写入、不改写母体会话')),
            button('打开门户', {
              size: 'sm', variant: 'quiet', icon: icon('globe', 12), dataBtnId: 'M-06',
              title: '在新窗口打开 /fang/panel 独立门户（不关闭母体）',
              onClick: () => openMotherPortal(),
            }))
        })(),
        h('div', { class: 'search' },
          h('span', { class: 'search-icon', 'aria-hidden': 'true' }, icon('search', 15)),
          h('input', {
            type: 'search',
            value: S.query,
            placeholder: '搜索会话：标题、短 ID 或工作区',
            'aria-label': '搜索母体会话',
            'data-fk': 'search',
            autocomplete: 'off',
            oninput: (event) => { S.query = event.target.value; app.schedule() },
            onkeydown: (event) => { if (event.key === 'Escape' && S.query) { event.preventDefault(); S.query = ''; app.schedule(true) } },
          })),
        h('div', { class: 'panel-tools' },
          h('span', null, `进行中 ${split.active.length}`),
          h('span', { class: 'spacer' }),
          h('span', null, `临时 ${split.temporary.length} · 归档 ${split.archived.length}`),
          h('span', { class: 'spacer' }),
          h('span', { title: '没有写接口的动作会明确禁用并说明原因，不会假装成功' }, '只读')))

      const scroll = h('div', { class: 'panel-scroll', 'data-sk': 'left' })

      if (sessionState === 'loading' && all.length === 0) {
        scroll.append(h('div', { class: 'loading-line' }, icon('spinner', 14), '正在读取母体会话…'))
      } else if (sessionState === 'error' && all.length === 0) {
        scroll.append(emptyBlock('母体会话不可读', failureHint(S.sessions.error), [
          button('重试', { size: 'sm', variant: 'ghost', onClick: () => void app.refresh({ manual: true }) }),
        ]))
      } else if (filtered.length === 0) {
        scroll.append(emptyBlock(
          query ? `没有匹配「${clampText(S.query, 20)}」的会话` : '还没有母体会话',
          query ? '搜索标题、会话 ID 或工作区名；Esc 清空搜索。' : '在本机开一个新对话后刷新，它会出现在这里。选择会话是只读元数据，母体会话不会被改写。',
          query ? [button('清除搜索', { size: 'sm', variant: 'ghost', onClick: () => { S.query = ''; app.schedule(true) } })] : [button('刷新', { size: 'sm', variant: 'ghost', onClick: () => void app.refresh({ manual: true }) })],
        ))
      } else {
        // 元主工作区的新建/归档/删除/下载是宿主职责：DOM 中不出现这些控件（不是禁用）。
        scroll.append(h('div', { class: 'section-head' },
          h('span', { class: 'section-title', style: { cursor: 'default' } }, '元主'),
          h('span', { class: 'section-sub' }, `${groups.length} 个工作区`),
          h('span', { class: 'spacer' }),
          h('span', { class: 'section-hint', title: '工作区 CRUD 属于 DSH 宿主；fang 不复制宿主职责' }, '宿主管理 · 只读')))

        const list = h('div', { class: 'mother-list', role: 'list' })
        for (const group of groups) {
          list.append(renderMotherCard(S, app, group, selected))
        }
        scroll.append(list)
        scroll.append(h('div', { class: 'section-foot' },
          '工作区由 DSH 宿主创建与管理；本面板只读，只有显示名可改（双击名称）。'))
      }

      return h('section', { class: 'panel', 'data-zone': 'mother', 'data-freshness': freshness, 'aria-labelledby': 'fang-mother-title' }, head, scroll)
    }

    function renderMotherCard(S, app, group, selectedSession) {
      const open = S.expanded.has('mother:' + group.key)
      const tone = dotTone(group.key)
      const sessions = group.sessions
      const canExpand = sessions.length > 0

      const title = editableText(S, app, { key: group.key, label: '元主', value: group.title })

      const actions = h('div', { class: 'mother-actions' },
        textAction('复制', {
          title: '复制元主路径：' + (group.path || group.rawTitle),
          dataBtnId: 'W-02',
          onClick: () => void app.copyText(group.path || group.rawTitle, '元主路径'),
        }),
        h('button', {
          type: 'button', class: 'expand-btn',
          'aria-expanded': open ? 'true' : 'false',
          'aria-controls': 'mother-sessions-' + group.key,
          'aria-label': `${open ? '收起' : '展开'}元主「${group.title}」的 ${sessions.length} 个会话`,
          'data-fk': 'mother-toggle:' + group.key,
          'data-btn-id': 'W-03',
          disabled: !canExpand,
          onClick: () => app.toggleSet('mother:' + group.key),
        }, icon('chevron', !open, 16)))

      const meta = h('div', { class: 'mother-meta' },
        h('span', null, `${group.count} 个会话`),
        h('span', { 'aria-hidden': 'true' }, '·'),
        h('span', null, `更新 ${fmtShortClock(group.latestAt)}`),
        group.archived ? h('span', null, `· 归档 ${group.archived}`) : null,
        group.empty ? h('span', null, `· 空 ${group.empty}`) : null)

      const row = h('div', { class: 'mother-row' + (open ? ' is-open' : ''), role: 'listitem', 'data-mother': group.key },
        h('div', { class: 'mother-main' },
          h('span', { class: 'mother-dot mother-dot--' + tone, 'aria-hidden': 'true' }),
          h('div', { class: 'mother-main-text' }, title, meta),
          actions),
        open ? renderMotherSessions(S, app, group, selectedSession) : null)

      return row
    }

    function renderMotherSessions(S, app, group, selectedSession) {
      const wrap = h('div', { class: 'sessions', id: 'mother-sessions-' + group.key, role: 'group', 'aria-label': `元主 ${group.title} 的会话` })
      const allOpen = S.expanded.has('mother-all:' + group.key)
      const limit = allOpen ? group.sessions.length : Math.min(ACTIVE_SESSION_LIMIT, group.sessions.length)
      for (const session of group.sessions.slice(0, limit)) {
        const info = sessionTitleInfo(session)
        const isSelected = String(session.sessionId) === String(selectedSession?.sessionId ?? '')
        wrap.append(h('button', {
          type: 'button',
          class: 'session-row' + (isSelected ? ' is-selected' : ''),
          title: sessionTooltip(session),
          'data-fk': 'session:' + session.sessionId,
          'aria-pressed': isSelected ? 'true' : 'false',
          onClick: () => app.selectSession(session),
        },
        h('span', { class: 'session-main' },
          h('span', { class: 'session-title' }, sessionDisplayText(session)),
          h('span', { class: 'session-meta' },
            h('span', null, '更新 ' + fmtRelative(session.updatedAt)),
            info.source === 'unnamed' ? h('span', null, '· 标题缺失') : null)),
        h('span', { class: 'session-flags' },
          session.empty ? chip('neutral', '空') : null,
          session.archived ? chip('neutral', '已归档') : null,
          isSelected ? chip('info', '已选', { dot: false }) : null)))
      }

      if (!allOpen && group.sessions.length > limit) {
        wrap.append(h('button', {
          type: 'button', class: 'text-action session-more',
          onClick: () => app.toggleSet('mother-all:' + group.key),
        }, `显示其余 ${group.sessions.length - limit} 条会话`))
      }

      if (selectedSession && group.sessions.some((session) => session.sessionId === selectedSession.sessionId)) {
        const titleText = sessionTitleInfo(selectedSession)
        wrap.append(h('div', { class: 'session-cta', role: 'group', 'aria-label': '对已选会话的操作' },
          h('span', { class: 'session-cta-text' }, `已选：${titleText.text}${titleText.source === 'unnamed' ? ` · ${short(selectedSession.sessionId, 8)}` : ''}`),
          button('从此会话派生', {
            size: 'sm', variant: 'primary', icon: icon('plus', 12),
            title: '绿色 = 派生：以该会话的交接摘要派生一个分身（母体会话不被改写）',
            onClick: () => void app.deriveTask({ title: `从会话继续 · ${clampText(titleText.text, 24)}`, sessionId: selectedSession.sessionId }),
          }),
          button('复制 ID', {
            size: 'sm', variant: 'quiet',
            onClick: () => void app.copyText(selectedSession.sessionId, '会话 ID'),
          }),
          button('取消', { size: 'sm', variant: 'quiet', onClick: () => app.selectSession(selectedSession) })))
      }
      return wrap
    }

    function renderCapacityStrip(cap) {
      const dots = []
      for (let index = 0; index < cap.slots; index += 1) {
        const usable = index < cap.limit
        const filled = index < cap.used
        dots.push(h('span', {
          class: 'cap-dot' + (filled ? ' is-used' : '') + (usable ? '' : ' is-locked'),
          title: filled ? `槽位 ${index + 1}：占用` : usable ? `槽位 ${index + 1}：空闲` : `槽位 ${index + 1}：超出当前配额`,
        }))
      }
      return h('div', {
        class: 'capacity', role: 'group',
        'aria-label': `配额 ${cap.used}/${cap.limit}，物理槽位 ${cap.used}/${cap.slots}${cap.estimated ? '（估算）' : ''}`,
        title: cap.estimated ? '宿主未提供 capacity：用任务数估算；契约升级后以服务端为准' : '服务端 capacity 快照',
      },
      h('span', { class: 'capacity-label' }, `配额 ${cap.used}/${cap.limit}`),
      h('span', { class: 'capacity-dots', 'aria-hidden': 'true' }, ...dots),
      h('span', { class: 'capacity-note' }, `槽位 ${cap.used}/${cap.slots}${cap.estimated ? ' · 估算' : ''}`))
    }

    // ── 右栏：分身区 ─────────────────────────────────────────────────────
    function renderForkPanel(S, app) {
      const freshness = freshnessOf(S)
      const all = S.tasks.items
      const split = classifyTasks(all)
      const byCreated = (a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0)
      const active = split.active.sort(byCreated)
      const temporary = split.temporary.sort(byCreated)
      const archived = split.archived.sort(byCreated)
      const cap = projectCapacity(S.status.data, all)
      const showArchive = S.view === 'archive'

      const head = h('div', { class: 'panel-head' },
        h('div', { class: 'panel-title-row' },
          h('h2', { class: 'panel-title', id: 'fang-fork-title' }, '分身'),
          h('span', { class: 'panel-sub' }, '每个任务一个项目 · 会话在分身标签页打开'),
          h('span', { class: 'panel-count', title: `配额 ${cap.used}/${cap.limit}；物理槽位 ${cap.used}/${cap.slots}` },
            `${active.length + temporary.length} 项目 · ${cap.used}/${cap.limit}`),
          h('button', {
            type: 'button', class: 'expand-btn', title: '回到顶部', 'aria-label': '回到分身列表顶部',
            onClick: () => {
              const scroller = app.view.querySelector('.panel-scroll[data-sk="right"]')
              if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' })
            },
          }, icon('arrowUp', 15))),
        h('div', { class: 'panel-tools' },
          h('span', null, `进行中 ${active.length}`),
          h('span', { class: 'spacer' }),
          h('span', null, `临时 ${temporary.length} · 存档 ${archived.length}`),
          h('span', { class: 'spacer' }),
          h('span', { 'data-freshness': freshness }, freshness === 'live' ? '实时' : freshness === 'stale' ? '状态可能已变' : '离线')),
        renderCapacityStrip(cap))

      const scroll = h('div', { class: 'panel-scroll', 'data-sk': 'right' })

      if (S.tasks.state === 'loading' && all.length === 0) {
        scroll.append(h('div', { class: 'loading-line' }, icon('spinner', 14), '正在读取分身任务…'))
      }

      if (showArchive) {
        scroll.append(h('div', { class: 'notice notice--info', role: 'status' },
          h('div', { class: 'notice-main' },
            h('div', { class: 'notice-title' }, '读档：已归档分身'),
            h('div', { class: 'notice-text' }, '存档 = 进程已停止、home 保留。还原会重新启动（新端口、新 token）；永久删除不可撤销。'))))
        scroll.append(renderForkGroup(S, app, 'archived', '已归档', 'neutral', archived, true))
      } else {
        if (archived.length > 0) {
          scroll.append(h('div', { class: 'readarch-row' },
            h('span', { class: 'hint' }, `有 ${archived.length} 个存档（进程已停止，home 保留）。`),
            button('打开读档', { size: 'sm', variant: 'ghost', onClick: () => app.setView('archive') })))
        }
        scroll.append(renderForkGroup(S, app, 'active', '进行中', 'ok', active))
        if (S.showTemporary) scroll.append(renderForkGroup(S, app, 'temporary', '临时', 'info', temporary))
      }

      return h('section', { class: 'panel', 'data-zone': 'derived', 'data-freshness': freshness, 'aria-labelledby': 'fang-fork-title' }, head, scroll)
    }

    function renderForkGroup(S, app, key, label, tone, tasks, forceOpen = false) {
      const collapsed = !forceOpen && S.collapsed.has(key)
      const group = h('div', { class: 'fork-group', 'data-group': key })
      const head = h('div', { class: 'group-head' },
        h('button', {
          type: 'button', class: 'group-toggle',
          'aria-expanded': collapsed ? 'false' : 'true',
          'aria-controls': 'fork-group-' + key,
          'data-fk': 'fork-group:' + key,
          onClick: () => app.toggleForkGroup(key),
        }, icon('chevron', !collapsed, 14), label,
        h('span', { class: 'group-count' }, String(tasks.length)),
        h('span', { class: 'stat-dot', 'aria-hidden': 'true', style: { background: TONE[tone]?.dot || TONE.neutral.dot, opacity: '.9' } })),
        h('span', { class: 'spacer' }),
        key === 'active' ? button('刷新', {
          size: 'sm', variant: 'quiet', icon: icon('refresh', 12), dataBtnId: 'C-06',
          title: '刷新任务列表（不会重启分身）', onClick: () => void app.refresh({ manual: true }),
        }) : null)
      group.append(head)

      const body = h('div', { id: 'fork-group-' + key })
      if (collapsed) body.hidden = true
      if (tasks.length === 0) {
        const copy = key === 'active'
          ? ['还没有进行中的分身', '输入标题派生，或在左侧选中一个母体会话后点「从此会话派生」。']
          : key === 'temporary'
            ? ['没有临时内容', '临时 = 快速派生的空白分身（标题为“快速派生”）与空会话。']
            : ['还没有存档', '归档后的分身会出现在这里，可还原或永久删除。']
        body.append(emptyBlock(copy[0], copy[1], key === 'active'
          ? [button('派生新分身', { size: 'sm', variant: 'primary', onClick: () => void app.deriveTask({ title: '派生新分身' }) })]
          : []))
      } else {
        for (const task of tasks) body.append(renderForkCard(S, app, task, { archived: key === 'archived' }))
      }
      group.append(body)
      return group
    }

    function renderForkCard(S, app, task, options = {}) {
      const health = taskHealth(task)
      const taskId = String(task.taskId ?? '')
      const archived = !!options.archived || String(task.status) === 'archived'
      const expanded = S.expanded.has('fork:' + taskId)
      const sessionsState = S.forkSessions.get(taskId)
      const busyArchive = S.busy === 'archive:' + taskId
      const busyRestore = S.busy === 'restore:' + taskId
      const busyDelete = S.busy === 'delete:' + taskId
      const busyPromote = S.busy === 'promote:' + taskId
      const barTone = health.tone

      const card = h('article', {
        class: 'fork-card' + (health.anomaly ? ' is-anomaly' : ''),
        'data-bar': barTone,
        'data-task': taskId,
        'data-state': health.phase,
        'data-health': health.adapter,
        'aria-label': `分身 ${task.title || taskId}，状态 ${health.label}`,
        'aria-busy': (busyArchive || busyRestore || busyDelete || busyPromote) ? 'true' : undefined,
      })

      const head = h('div', { class: 'fork-head' },
        h('div', { class: 'fork-head-main' },
          h('div', { class: 'fork-title' }, clampText(task.title) || `分身 ${short(taskId, 8)}`),
          h('div', { class: 'fork-chips' },
            chip(health.tone, health.label, { state: health.phase, danger: health.tone === 'bad' && health.anomaly }),
            archived ? null : chip(health.adapterTone, health.adapterLabel, { health: health.adapter }),
            task.importedSession ? chip('info', '已导入会话', { title: '派生时导入了母体会话历史/摘要' }) : null)),
        h('div', { class: 'fork-actions' },
          archived
            ? [button('还原', {
              size: 'sm', variant: 'ghost', icon: icon('refresh', 12), busy: busyRestore, dataBtnId: 'C-04', confirmLevel: 'once',
              title: '用原存档重新启动（新端口、新 token）', onClick: () => void app.restoreTask(task),
              fk: 'restore:' + taskId,
            }),
            button('永久删除', {
              size: 'sm', variant: 'danger-quiet', busy: busyDelete, danger: true, dataBtnId: 'C-05', confirmLevel: 'strong',
              title: '永久删除 home 与存档，不可撤销（需输入名称）', onClick: () => void app.deleteArchive(task),
              fk: 'delete:' + taskId,
            })]
            : [button('打开', {
              size: 'sm', variant: 'ghost', icon: icon('external', 12), iconAfter: true, dataBtnId: 'C-01',
              title: '在新标签页打开分身 Web UI（URL 打开时向宿主换取，不落盘）',
              onClick: () => void app.openTask(task),
              fk: 'open:' + taskId,
            }),
            textAction('提升插件', {
              title: '把分身里验证过的插件目录提升到母体（需目录名）', dataBtnId: 'C-02',
              softDisabled: busyPromote, busy: busyPromote,
              onClick: () => app.promoteTask(task),
            }),
            textAction('归档', {
              title: '归档：flush 缓冲 → 停进程 → home 保留（可在读档里还原）', dataBtnId: 'C-03', confirmLevel: 'once',
              softDisabled: busyArchive, busy: busyArchive,
              onClick: () => void app.archiveTask(task),
            })]))

      const meta = h('div', { class: 'fork-meta' },
        h('code', { title: '任务 ID：' + taskId }, short(taskId, 12)),
        h('span', null, '端口 ' + (task.port ? String(task.port) : '—')),
        task.pid ? h('span', null, 'PID ' + String(task.pid)) : null,
        h('span', null, '创建 ' + fmtShortClock(task.createdAt)),
        health.adapter === 'error' ? h('span', { style: { color: 'var(--f-red)' }, 'data-danger': '1' }, '适配器失联') : null)

      card.append(head, meta)

      if (health.anomaly) {
        card.append(h('div', { class: 'fork-warn', role: 'note' },
          icon('alert', 14),
          h('span', null, '进程在跑但适配器失联（已证实异常）：可打开诊断，或归档回收。')))
      }

      if (!archived) {
        const sub = h('div', { class: 'fork-sub' },
          h('div', { class: 'fork-sub-head' },
            h('button', {
              type: 'button', class: 'text-action', style: { color: 'var(--f-text-2)' },
              'aria-expanded': expanded ? 'true' : 'false',
              'aria-controls': 'fork-sessions-' + taskId,
              'data-fk': 'fork-sessions:' + taskId,
              onClick: () => {
                app.toggleSet('fork:' + taskId)
                if (!S.forkSessions.has(taskId) || S.forkSessions.get(taskId)?.state === 'error') void app.loadForkSessions(taskId)
              },
            }, icon('chevron', !expanded, 13),
            sessionsState
              ? `分身会话 ${sessionsState.total ?? sessionsState.items?.length ?? 0} 个`
              : '分身会话'),
            h('span', { class: 'spacer' }),
            button('刷新', {
              size: 'sm', variant: 'quiet', icon: icon('refresh', 12), busy: sessionsState?.busy, dataBtnId: 'C-07',
              title: '刷新该分身的会话目录（只读）',
              onClick: (event) => { event.stopPropagation(); void app.loadForkSessions(taskId) },
            })))
        if (expanded) {
          sub.append(renderForkSessions(S, app, task, sessionsState))
        }
        card.append(sub)
      }
      return card
    }

    function renderForkSessions(S, app, task, state) {
      const wrap = h('div', { class: 'fork-sessions', id: 'fork-sessions-' + task.taskId })
      if (!state) {
        wrap.append(h('div', { class: 'hint', style: { padding: '6px' } }, '展开后读取该分身的会话目录…'))
        return wrap
      }
      if (state.state === 'loading') {
        wrap.append(h('div', { class: 'loading-line', style: { padding: '8px' } }, icon('spinner', 12), '读取分身会话…'))
        return wrap
      }
      if (state.state === 'error') {
        wrap.append(h('div', { class: 'hint', style: { padding: '6px', color: 'var(--f-red)' } },
          `读取失败：${failureHint(state.error, 'fork-sessions')} `,
          h('button', {
            type: 'button', class: 'text-action', onClick: () => void app.loadForkSessions(task.taskId),
          }, '重试')))
        return wrap
      }
      if (!state.items.length) {
        wrap.append(h('div', { class: 'hint', style: { padding: '6px' } }, '该分身还没有会话（或尚未初始化 sessions 目录）。'))
        return wrap
      }
      for (const session of state.items) {
        const info = sessionTitleInfo(session)
        wrap.append(h('div', { class: 'fork-session' },
          h('span', { class: 'fork-session-title' }, sessionDisplayText(session)),
          h('span', { class: 'fork-session-meta' }, '更新 ' + fmtShortClock(session.updatedAt)),
          button('打开', {
            size: 'sm', variant: 'quiet', icon: icon('external', 11), iconAfter: true,
            title: `打开分身 ${task.title || task.taskId}（会话在分身 Web UI 内打开）`,
            onClick: () => void app.openTask(task),
          })))
      }
      if (state.degraded && state.degraded.length) {
        wrap.append(h('div', { class: 'hint', style: { padding: '6px' } }, '降级：' + state.degraded.join('、')))
      }
      return wrap
    }

    // ── Mother 浮窗（毛玻璃）：概览 / 备份 / 升级 / 连接自检 ────────────────
    function renderMirrorSection(S, app) {
      const mirror = S.mirror
      const data = mirror.data
      const meta = data?.meta || {}
      const backups = Array.isArray(data?.backups) ? data.backups : []
      const pending = S.modal?.pending || null
      const busy = mirror.busy

      const section = h('section', { class: 'glass-section', 'aria-label': '母体镜像与备份' })
      section.append(h('div', { class: 'glass-section-title' }, icon('disc', 14), '母体镜像 · 备份与升级',
        data?.updateAvailable ? chip('warn', '有可用更新') : null))

      if (mirror.state === 'loading' && !data) section.append(h('div', { class: 'hint' }, '读取 /fang/api/mirror/status…'))
      if (mirror.state === 'error') section.append(h('div', { class: 'hint', style: { color: 'var(--f-red)' } }, `读取失败：${mirror.error}`))
      if (mirror.error && mirror.state === 'ready') section.append(h('div', { class: 'hint', style: { color: 'var(--f-red)' } }, `操作失败：${mirror.error}`))

      if (data) {
        section.append(h('div', { class: 'kv' },
          kv('当前版本', String(data.currentVersion || '—')),
          kv('官方最新', data.officialLatest == null ? '未配置官方源' : String(data.officialLatest)),
          kv('上次备份', meta.lastBackupAt ? fmtClock(meta.lastBackupAt) : '从未'),
          kv('下次备份', meta.nextBackupAt ? fmtClock(meta.nextBackupAt) : '未安排'),
          kv('磁盘占用', fmtBytes(Number(data.diskUsageBytes) || 0)),
          kv('自动备份', `${Number(meta.backupIntervalHours) || 24} 小时`)))

        section.append(h('div', { class: 'glass-actions' },
          button(busy === 'backup' ? '备份中…' : '立即备份', {
            size: 'sm', variant: 'config', icon: icon('archive', 13), busy: busy === 'backup',
            onClick: () => void app.mirrorAction('backup', async () => (await api('/fang/api/mirror/backup', { method: 'POST', body: JSON.stringify({ bucket: 'restore', label: '手动备份' }) })).body),
          }),
          button(busy === 'upgrade' ? '升级中…' : data.updateAvailable ? '立即升级' : '无可用更新', {
            size: 'sm', variant: data.updateAvailable ? 'config' : 'quiet', icon: icon('arrowUp', 13), busy: busy === 'upgrade',
            softDisabled: !data.updateAvailable,
            title: data.updateAvailable ? '升级前自动备份，失败自动回滚；不会中断运行中的分身' : '没有可用更新（或未配置官方源）',
            onClick: () => {
              if (!data.updateAvailable) return
              S.modal.pending = {
                text: `升级母体镜像 ${data.currentVersion || '?'} → ${data.officialLatest || '最新'}？升级前自动备份，失败自动回滚。`,
                run: () => app.mirrorAction('upgrade', async () => (await api('/fang/api/mirror/upgrade', { method: 'POST', body: JSON.stringify({ autoBackup: true, autoRollback: true }) })).body),
              }
              app.render(true)
            },
          }),
          button('打开母体门户', {
            size: 'sm', variant: 'quiet', icon: icon('globe', 13),
            title: '在新窗口打开 /fang/panel 独立门户（桌面壳使用真实 HTTP 源）',
            onClick: () => openMotherPortal(),
          })))

        section.append(h('div', { class: 'glass-section-title', style: { marginTop: '4px' } }, '备份间隔',
          ...([6, 12, 24].map((hours) => button(hours + 'h', {
            size: 'sm', variant: Number(meta.backupIntervalHours) === hours ? 'config' : 'quiet',
            title: `每 ${hours} 小时自动备份一次`,
            onClick: () => void app.mirrorAction('interval:' + hours, async () => (await api('/fang/api/mirror/backup-interval', { method: 'POST', body: JSON.stringify({ hours }) })).body),
          })))))

        if (pending) {
          section.append(h('div', { class: 'notice notice--warn', role: 'alertdialog', 'aria-label': '确认操作' },
            h('div', { class: 'notice-main' }, h('div', { class: 'notice-text' }, pending.text)),
            h('div', { class: 'notice-actions' },
              button('取消', { size: 'sm', variant: 'quiet', onClick: () => { S.modal.pending = null; app.render(true) } }),
              button('确认', {
                size: 'sm', variant: 'danger',
                onClick: () => { const run = pending.run; S.modal.pending = null; app.render(true); void run() },
              }))))
        }

        const list = h('div', { class: 'glass-section' },
          h('div', { class: 'glass-section-title' }, `备份（${backups.length}）`,
            button('刷新', {
              size: 'sm', variant: 'quiet', icon: icon('refresh', 12),
              onClick: () => void app.loadMirror(true),
            })))
        if (!backups.length) list.append(h('div', { class: 'hint' }, '暂无备份'))
        for (const entry of backups.slice(0, 6)) {
          list.append(h('div', { class: 'backup-row' },
            chip(entry.bucket === 'restore' ? 'info' : 'neutral', entry.bucket === 'restore' ? '恢复点' : '滚动', { dot: false }),
            h('span', null, `${entry.label || (entry.kind === 'manual' ? '手动备份' : '自动备份')} · ${fmtShortClock(entry.createdAt)} · v${entry.version} · ${fmtBytes(entry.sizeBytes)}`),
            h('span', { class: 'spacer' }),
            button('恢复', {
              size: 'sm', variant: 'quiet',
              onClick: () => {
                S.modal.pending = {
                  text: `恢复到 ${fmtClock(entry.createdAt)} 的备份（v${entry.version}）？当前镜像会先自动备份一份。`,
                  run: () => app.mirrorAction('restore', async () => (await api('/fang/api/mirror/restore', { method: 'POST', body: JSON.stringify({ backupId: entry.id }) })).body),
                }
                app.render(true)
              },
            }),
            button('删除', {
              size: 'sm', variant: 'danger-quiet',
              onClick: () => {
                S.modal.pending = {
                  text: `删除 ${fmtClock(entry.createdAt)} 的备份（${fmtBytes(entry.sizeBytes)}）？不可恢复。`,
                  run: () => app.mirrorAction('delete', async () => (await api('/fang/api/mirror/backup/delete', { method: 'POST', body: JSON.stringify({ backupId: entry.id }) })).body),
                }
                app.render(true)
              },
            })))
        }
        section.append(list)
      }
      return section
    }

    function kv(label, value) {
      return h('div', { class: 'kv-item' },
        h('div', { class: 'kv-label' }, label),
        h('div', { class: 'kv-value' }, value))
    }

    function renderLinkSection(S, app) {
      const link = S.link
      const data = link.data
      const section = h('section', { class: 'glass-section', 'aria-label': '母体连接自检' })
      section.append(h('div', { class: 'glass-section-title' }, icon('globe', 14), '母体连接 · 只读探测'))
      if (link.state === 'loading') section.append(h('div', { class: 'hint' }, '读取 /fang/api/mother-link…'))
      if (link.state === 'error') section.append(h('div', { class: 'hint', style: { color: 'var(--f-red)' } }, `读取失败：${link.error}`))
      if (data) {
        section.append(h('div', { class: 'kv' },
          kv('母体版本', String(data.version || '—')),
          kv('母体 API', String(data.motherApiBase || '/fang/api')),
          kv('分身 Adapter', String(data.adapterBase || '/fang/adapter')),
          kv('令牌策略', String(data.tokenPolicy || '不落盘')),
          kv('共享配置', data.sharedConfig ? `profile 层${data.sharedConfig.profile ? ' · ' + data.sharedConfig.profile : ''}${typeof data.sharedConfig.bundles === 'number' ? ' · ' + data.sharedConfig.bundles + ' 个 bundle' : ''}` : '未提供'),
          kv('源地址', resolveMotherOrigin() || '无法解析（桌面壳注入缺失）')))
      }
      section.append(h('div', { class: 'field' },
        h('input', {
          type: 'url', value: link.target, placeholder: '母体地址，如 http://127.0.0.1:51963',
          'aria-label': '母体地址', autocomplete: 'off',
          oninput: (event) => app.updateLinkTarget(event.target.value),
          onkeydown: (event) => { if (event.key === 'Enter') { event.preventDefault(); void app.probeMother() } },
        }),
        button(link.busy ? '测试中…' : '测试连通', {
          size: 'sm', variant: 'ghost', busy: link.busy,
          title: '只读探测母体 /fang/api/status；不写入任何配置',
          onClick: () => void app.probeMother(),
        })))
      if (link.probe) {
        section.append(h('div', { class: 'hint', style: { color: link.probe.ok ? 'var(--f-green)' : 'var(--f-red)' } },
          link.probe.ok
            ? `连通 · ${link.probe.target || link.target} · ${link.probe.latencyMs ?? 0}ms${link.probe.version ? ' · 版本 ' + link.probe.version : ''}`
            : `不可达 · ${link.probe.error || 'unknown'}${link.probe.message ? ' · ' + link.probe.message : ''}`))
      }
      section.append(h('div', { class: 'hint' }, '探测是跨源只读 GET；失败通常因为母体未开放 CORS，可直接在母体窗口查看。'))
      return section
    }

    function renderMotherModal(S, app) {
      const data = S.status.data
      const mirror = S.mirror.data
      const body = h('div', { class: 'glass-body', role: 'document' })
      const motherPhase = S.status.state === 'ready' ? 'running' : S.status.data ? 'unknown' : 'unknown'
      const motherTone = S.status.state === 'ready' ? 'ok' : S.status.data ? 'info' : 'neutral'
      body.append(h('section', { class: 'glass-section', 'aria-label': '母体卡' },
        h('div', { class: 'glass-section-title' }, icon('gate', 14), '母体卡',
          chip(motherTone, S.status.state === 'ready' ? '运行中' : '离线 / 状态未知', { dot: true, state: S.status.state === 'ready' ? 'running' : 'unknown' }),
          chip(S.status.data ? 'ok' : 'neutral', S.status.data ? '控制面可达' : '不可达', { dot: true })),
        h('div', { class: 'glass-actions' },
          button('打开母体门户', {
            size: 'sm', variant: 'ghost', icon: icon('globe', 13), dataBtnId: 'M-06',
            title: '在新窗口打开 /fang/panel 独立门户（不关闭母体）',
            onClick: () => openMotherPortal(),
          })),
        h('div', { class: 'hint' }, '暂停 / 恢复 / 重启：宿主尚未提供路由，按契约隐藏（capability-missing），不绘制灰键；关闭母体不支持。')))
      body.append(h('div', { class: 'kv' },
        kv('母体角色', data?.role === 'fork' ? '分身' : '母体（只读会话）'),
        kv('母体版本', String(data?.version || mirror?.currentVersion || '—')),
        kv('适配器就绪', `${Number(data?.tasks?.ready ?? 0) || 0} / ${data?.tasks?.max ?? '—'}`),
        kv('运行中', String(Number(data?.tasks?.running ?? 0) || 0)),
        kv('母体会话', String(S.sessions.items.length)),
        kv('最近刷新', S.lastRefreshAt ? fmtClock(S.lastRefreshAt) : '—')))
      body.append(renderMirrorSection(S, app))
      body.append(renderLinkSection(S, app))
      return h('div', {
        class: 'overlay', 'data-overlay': '1', onClick: (event) => { if (event.target === event.currentTarget) app.closeModal() },
      },
      h('div', { class: 'glass', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'fang-mother-modal-title' },
        h('div', { class: 'glass-head' },
          h('div', { class: 'glass-head-main' },
            h('div', { class: 'glass-title', id: 'fang-mother-modal-title' }, icon('gate', 20), 'Mother', chip('neutral', '只读优先', { dot: false })),
            h('div', { class: 'glass-sub' }, '母体状态、镜像备份与升级、连接自检。写操作都会二次确认。')),
          button('', {
            variant: 'quiet', size: 'sm', iconOnly: true, icon: icon('close', 15), ariaLabel: '关闭浮窗',
            title: '关闭（Esc）', onClick: () => app.closeModal(), fk: 'modal-close', dataKey: 'autofocus',
          })),
        body,
        h('div', { class: 'glass-foot' },
          button('刷新全部', {
            size: 'sm', variant: 'ghost', icon: icon('refresh', 13), busy: S.mirror.busy === 'refresh',
            onClick: () => void app.refreshAll(),
          }),
          button('关闭', { size: 'sm', variant: 'quiet', onClick: () => app.closeModal() }))))
    }

    // ── 确认 / 输入 浮窗 ─────────────────────────────────────────────────
    function renderConfirmModal(S, app) {
      const modal = S.modal
      const expected = String(modal.expected || '')
      const matches = !modal.strong || String(modal.typed || '').trim() === expected
      const level = modal.strong ? 'strong' : 'once'
      const inputId = 'fang-confirm-input'
      const reasonId = 'fang-confirm-reason'
      return h('div', { class: 'overlay', 'data-overlay': '1', onClick: (event) => { if (event.target === event.currentTarget) app.closeModal() } },
        h('div', {
          class: 'glass glass--sm', role: 'alertdialog', 'aria-modal': 'true',
          'aria-labelledby': 'fang-confirm-title', 'data-confirm': modal.confirm || 'once', 'data-confirm-level': level,
        },
          h('div', { class: 'glass-head' },
            h('div', { class: 'glass-head-main' },
              h('div', { class: 'glass-title', id: 'fang-confirm-title' }, icon('alert', 18), modal.title),
              h('div', { class: 'glass-sub' }, modal.strong ? '不可撤销：需要输入名称确认' : '该操作会立即提交给宿主')),
            button('', { variant: 'quiet', size: 'sm', iconOnly: true, icon: icon('close', 15), ariaLabel: '取消', onClick: () => app.closeModal() })),
          h('div', { class: 'glass-body' },
            h('div', { class: 'confirm-body', style: { whiteSpace: 'pre-wrap' } }, modal.message),
            modal.strong
              ? h('label', { class: 'glass-sub', for: inputId },
                '输入 ', h('b', null, expected), ' 以确认删除')
              : null,
            modal.strong
              ? h('div', { class: 'field' },
                h('input', {
                  id: inputId, type: 'text', value: modal.typed || '', autocomplete: 'off', spellcheck: 'false',
                  'aria-label': '输入名称以确认删除', 'aria-describedby': reasonId,
                  oninput: (event) => {
                    modal.typed = event.target.value
                    const ok = event.target.value.trim() === expected
                    const btn = app.view.querySelector('[data-fk="confirm-ok"]')
                    if (btn) {
                      btn.disabled = !ok
                      btn.setAttribute('aria-disabled', ok ? 'false' : 'true')
                    }
                    const reason = app.view.querySelector('#' + reasonId)
                    if (reason) reason.textContent = ok ? '可以确认删除。' : '名称不匹配，删除按钮保持禁用。'
                  },
                  onkeydown: (event) => {
                    if (event.isComposing || event.keyCode === 229) return
                    if (event.key === 'Enter' && event.target.value.trim() === expected) {
                      event.preventDefault()
                      const run = modal.onConfirm
                      app.closeModal()
                      void run()
                    }
                  },
                }))
              : null),
          h('div', { class: 'glass-foot' },
            button('取消', {
              size: 'sm', variant: 'ghost', dataKey: 'autofocus', fk: 'confirm-cancel',
              onClick: () => app.closeModal(),
            }),
            button(modal.confirmLabel || '确认', {
              size: 'sm', variant: modal.tone === 'info' ? 'info' : 'danger', fk: 'confirm-ok',
              disabled: !matches,
              describedBy: modal.strong ? reasonId : undefined,
              onClick: () => {
                if (!matches) return
                const run = modal.onConfirm
                app.closeModal()
                void run()
              },
            })),
          modal.strong
            ? h('span', { class: 'live', id: reasonId, role: 'status' }, '名称不匹配，删除按钮保持禁用。')
            : null))
    }

    function renderPromptModal(S, app) {
      const modal = S.modal
      const submit = () => {
        const value = String(modal.value || '').trim()
        if (!value) { app.setModalError('请填写内容'); return }
        const run = modal.onConfirm
        void Promise.resolve(run(value)).then((keepOpen) => { if (!keepOpen) app.closeModal() })
      }
      return h('div', { class: 'overlay', 'data-overlay': '1', onClick: (event) => { if (event.target === event.currentTarget) app.closeModal() } },
        h('div', { class: 'glass glass--sm', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'fang-prompt-title' },
          h('div', { class: 'glass-head' },
            h('div', { class: 'glass-head-main' },
              h('div', { class: 'glass-title', id: 'fang-prompt-title' }, modal.title),
              h('div', { class: 'glass-sub' }, modal.hint || '')),
            button('', { variant: 'quiet', size: 'sm', iconOnly: true, icon: icon('close', 15), ariaLabel: '取消', onClick: () => app.closeModal() })),
          h('div', { class: 'glass-body' },
            h('label', { class: 'glass-sub', for: 'fang-prompt-input' }, modal.label),
            h('div', { class: 'field' },
              h('input', {
                id: 'fang-prompt-input', type: 'text', value: modal.value, 'data-autofocus': '1',
                autocomplete: 'off', spellcheck: 'false',
                'aria-invalid': modal.error ? 'true' : undefined,
                'aria-describedby': modal.error ? 'fang-prompt-error' : undefined,
                oninput: (event) => { modal.value = event.target.value },
                onkeydown: (event) => { if (event.key === 'Enter') { event.preventDefault(); submit() } },
              })),
            modal.error ? h('div', { class: 'hint', id: 'fang-prompt-error', style: { color: 'var(--f-red)' }, role: 'alert' }, modal.error) : null),
          h('div', { class: 'glass-foot' },
            button('取消', { size: 'sm', variant: 'ghost', onClick: () => app.closeModal() }),
            button(modal.confirmLabel || '确定', { size: 'sm', variant: 'primary', onClick: submit }))))
    }

    function renderToast(S) {
      const toast = S.toast
      if (!toast) return null
      return h('div', { class: 'toast toast--' + (toast.tone === 'ok' ? 'ok' : toast.tone === 'bad' ? 'bad' : 'warn'), role: 'status', 'aria-live': 'polite' },
        toast.tone === 'ok' ? icon('check', 14) : icon('alert', 14),
        h('span', null, toast.text))
    }

    // ── 分身 Web UI / 未知宿主 的说明页 ───────────────────────────────────
    function renderHostNotice(S, app) {
      const isFork = S.role.value === 'fork'
      return h('section', { class: 'panel', style: { maxWidth: '760px', margin: '24px auto', width: '100%' } },
        h('div', { class: 'panel-scroll', style: { padding: '28px 24px', overflow: 'visible' } },
          h('div', { class: 'empty', style: { borderStyle: 'solid', borderColor: 'var(--f-border)', background: '#fff', padding: '36px 24px' } },
            h('span', { class: 'fh-mark', style: { width: 46, height: 46, borderRadius: 14 } }, icon('gate', 26)),
            h('div', { class: 'empty-title', style: { fontSize: '15px' } }, isFork ? '当前页面是分身的 Web UI' : '尚未确认宿主角色'),
            h('div', { class: 'empty-text' },
              isFork
                ? '瓮城母体控制台只在母体宿主中可用。这个页面是 dsh-Fang 派生的分身（role=fork），母体接口 /fang/api/* 在这里不存在——这是预期行为，不是插件故障。'
                : `无法确认当前宿主是母体还是分身（${S.role.error || '探测未完成'}）。可能是宿主正在重启，或插件版本与宿主不匹配。`),
            h('div', { class: 'glass-actions', style: { justifyContent: 'center' } },
              button('重新探测', {
                size: 'sm', variant: 'ghost', icon: icon('refresh', 13),
                onClick: async () => { S.role = { value: 'unknown', error: '', at: 0 }; app.render(true); const role = await detectRole(true); if (role === 'mother') void app.refresh() ; app.render(true) },
              }),
              isFork ? button('打开母体门户', { size: 'sm', variant: 'quiet', icon: icon('globe', 13), onClick: () => openMotherPortal() }) : null))))
    }

    // ── 页面装配 ─────────────────────────────────────────────────────────
    function renderFooter(S, app) {
      const version = S.status.data?.version ? 'v' + String(S.status.data.version).replace(/^v/, '') : 'v—'
      return h('footer', { class: 'fang-foot' },
        h('span', { class: 'hint' }, '双击「瓮城」图标或输入框徽标 = 快速派生；单击 = 打开本面板。两栏各自滚动；元主重命名只写本地别名。'),
        h('span', { class: 'fang-foot-right' },
          h('span', { class: 'hint' }, S.lastRefreshAt ? `刷新于 ${fmtClock(S.lastRefreshAt)}` : '等待首次刷新'),
          h('span', { class: 'fh-version', title: '母体版本' }, version),
          h('a', { class: 'fang-portal-link', href: '/fang/panel', target: '_blank', rel: 'noopener' }, '独立门户', icon('external', 11))))
    }

    function renderApp(S, app) {
      const frag = document.createDocumentFragment()
      frag.append(renderHeader(S, app))
      for (const node of renderNotices(S, app)) frag.append(node)

      if (S.role.value === 'mother') {
        frag.append(h('div', { class: 'fang-body', 'aria-busy': S.refreshing ? 'true' : undefined },
          renderMotherPanel(S, app),
          renderForkPanel(S, app)))
        frag.append(renderFooter(S, app))
      } else if (S.role.value === 'fork') {
        frag.append(renderHostNotice(S, app))
      } else {
        frag.append(h('div', { class: 'loading-line' }, icon('spinner', 15), '正在探测宿主角色…'))
      }

      if (S.modal) {
        // 浮窗打开时把页面主体移出可达性树与 Tab 顺序（焦点陷阱的第二道保险）
        for (const node of frag.childNodes) {
          const classes = String(node.getAttribute?.('class') || '')
          if (/(^|\s)fang-(head|body|foot)(\s|$)/.test(classes)) {
            node.setAttribute('inert', '')
            node.setAttribute('aria-hidden', 'true')
          }
        }
        if (S.modal.kind === 'mother') frag.append(renderMotherModal(S, app))
        else if (S.modal.kind === 'confirm') frag.append(renderConfirmModal(S, app))
        else if (S.modal.kind === 'prompt') frag.append(renderPromptModal(S, app))
      }
      const toast = renderToast(S)
      if (toast) frag.append(toast)
      return frag
    }


    // ── 宿主插槽：唯一保留 React 的地方（15 行挂载壳）──────────────────────
    function DomMount(props) {
      const ref = React.useRef(null)
      React.useEffect(() => {
        const host = ref.current
        if (!host) return undefined
        const teardown = props.mount(host)
        return () => { try { if (typeof teardown === 'function') teardown() } catch { /* ignore */ } }
      }, [])
      return React.createElement('div', { ref, className: 'fang-mount', style: props.style || { display: 'block', minWidth: 0 } })
    }

    function mountPanel(host) {
      // v3.0.7 UI 分析日志：记录面板挂载与所有按钮/链接点击，供自动冒烟/诊断读取
      try {
        const doc = host?.ownerDocument ?? document
        window.__fangUiLog = window.__fangUiLog || []
        if (window.__fangUiLog.__bound !== true) {
          doc.addEventListener('click', (ev) => {
            const el = ev.target && ev.target.closest ? ev.target.closest('button, [data-btn-id], a[href]') : null
            if (!el) return
            window.__fangUiLog.push({
              at: Date.now(),
              btnId: el.getAttribute?.('data-btn-id') || null,
              text: String(el.textContent || '').trim().slice(0, 80),
              href: el.getAttribute?.('href') || null,
            })
          }, true)
          window.__fangUiLog.__bound = true
        }
        window.__fangUiLog.push({ at: Date.now(), kind: 'panel-mount' })
      } catch { /* 宿主无 window 时忽略 */ }
      const app = createConsole(host)
      return () => app.destroy()
    }

    // 左侧导航图标：单击由宿主行负责打开面板；双击 = 快速派生（与面板按钮同一单飞）
    function mountGlyph(host, size) {
      const doc = host.ownerDocument
      injectStyle(doc)
      host.replaceChildren()
      const box = h('span', { class: 'fang-glyph', role: 'img', 'aria-label': '瓮城', title: '瓮城：单击打开面板，双击快速派生分身' })
      const svgSize = Math.max(14, Math.min(22, Number(size) || 18))
      box.append(icon('gate', svgSize))
      box.addEventListener('dblclick', (event) => {
        event.preventDefault()
        event.stopPropagation()
        void quickDerive('双击快速派生')
      })
      host.append(box)
      return () => host.replaceChildren()
    }

    // 输入框下方徽标：状态胶囊 + 单击开面板 + 双击快速派生 + 兜底门户
    function mountBadge(host, ctx) {
      const doc = host.ownerDocument
      injectStyle(doc)
      host.replaceChildren()

      const state = { ready: 0, max: 0, running: 0, error: false, loaded: false, pending: false, hidden: false }
      const dot = h('span', { class: 'fang-badge-dot', 'aria-hidden': 'true' })
      const label = h('button', { type: 'button', class: 'fang-badge-btn' }, '瓮城')
      const portal = h('a', {
        class: 'fang-badge-link', href: '/fang/panel', target: '_blank', rel: 'noopener',
        title: '独立兜底门户（面板不可用时的备用入口）', 'aria-label': '打开瓮城独立门户',
      }, '↗')
      const wrap = h('span', { class: 'fang-badge', title: '瓮城：单击打开面板，双击快速派生分身' }, dot, label, portal)
      host.append(wrap)

      const openPanel = () => {
        try {
          const layout = ctx?.layout
          if (layout && typeof layout.selectPanel === 'function') { layout.selectPanel('fang'); return }
        } catch { /* fall through */ }
        try { window.open('/fang/panel', '_blank', 'noopener') } catch { /* ignore */ }
      }
      label.addEventListener('click', openPanel)
      label.addEventListener('dblclick', (event) => {
        event.preventDefault()
        event.stopPropagation()
        void quickDerive('徽标快速派生')
      })

      let alive = true
      let timer = 0
      const paint = () => {
        if (!alive || state.hidden) return
        const anomalies = state.running
        const text = state.error
          ? '瓮城离线'
          : state.pending
            ? '派生中…'
            : anomalies > 0
              ? `瓮城 · ${anomalies} 异常`
              : state.loaded
                ? `瓮城 ${state.ready}/${state.max || '?'}`
                : '瓮城'
        label.textContent = text
        const tone = state.error ? 'warn' : anomalies > 0 ? 'bad' : state.ready > 0 ? 'ok' : 'info'
        wrap.setAttribute('data-tone', tone)
        wrap.title = state.error
          ? '无法读取 /fang/api/status（宿主侧 dsh-Fang 未加载或路由不可用）'
          : anomalies > 0
            ? `瓮城：${anomalies} 个运行中分身的适配器未握手；单击打开面板，双击快速派生`
            : '瓮城：单击打开面板，双击快速派生分身'
      }
      const poll = async () => {
        const result = await api('/fang/api/status')
        if (!alive) return
        if (result.status === 200 && result.body && !result.body.error) {
          const body = result.body
          const list = Array.isArray(body.tasks?.list) ? body.tasks.list : []
          state.ready = Number(body.tasks?.ready) || 0
          state.max = Number(body.tasks?.max) || 0
          state.running = list.length
            ? list.filter((task) => String(task.status) === 'running' && !task.adapter?.ok).length
            : (Number(body.tasks?.running) || 0)
          state.error = false
          state.loaded = true
        } else {
          state.error = true
          state.loaded = true
          // 分身宿主里没有母体 API：徽标直接隐藏，而不是误报“离线”
          const hello = await api('/fang/adapter/hello')
          if (hello.status === 200 || hello.status === 401) {
            state.hidden = true
            wrap.hidden = true
            return
          }
        }
        paint()
      }
      void poll()
      timer = window.setInterval(() => { if (!doc.hidden) void poll() }, 10000)
      const off = deriveStore.subscribe((value) => {
        state.pending = !!value?.pending
        paint()
      })
      paint()
      return () => {
        alive = false
        if (timer) window.clearInterval(timer)
        off()
        host.replaceChildren()
      }
    }

    // ── 插件入口 ──────────────────────────────────────────────────────────
    return {
      mountPanel,
      inject: ['slots'],
      apply(ctx) {
        const disposers = []
        // 左侧导航「瓮城」：图标组件即登记项组件（外壳只给 {size, active}）
        disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'fang',
          order: 90,
          label: '瓮城',
        }, (props) => React.createElement(DomMount, {
          mount: (host) => mountGlyph(host, props?.size),
          style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
        }))))
        // 中列面板：key 必须与 sidebar 条目 id 一致，否则 selectPanel('fang') 不会切
        disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'fang',
        }, () => React.createElement(DomMount, {
          mount: mountPanel,
          style: { display: 'block', minWidth: 0 },
        }))))
        // 输入框下方徽标
        disposers.push(ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'fang-badge',
          order: 88,
        }, (props) => React.createElement(DomMount, {
          mount: (host) => mountBadge(host, props?.ctx ?? ctx),
          style: { display: 'inline-flex', alignItems: 'center' },
        }))))
        return () => {
          for (const dispose of disposers) { try { if (typeof dispose === 'function') dispose() } catch { /* ignore */ } }
        }
      },
    }
  },
    })
}

