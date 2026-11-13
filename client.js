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
      'capture-failed': '从母体生成元主失败：母体 profile 不可读或补丁解析失败（详情见下方）。',
      'not-pending': '该票已被处理（可能刚被其他人/另一个标签页处理），请刷新后再看。',
      'explicit-choice-required': '红色/阻塞票需要逐条显式处理，不能被批量代选。',
      'session-daily-quota-exceeded': '该会话今日创建决策票已达上限；请先处理已有票，或换会话。',
      'ai-schema-invalid': 'AI 返回结构不符合 schema，已拒绝写入这张票的建议；可重试。',
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
    function readNumberPref(key, fallback) {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return fallback
        const raw = window.localStorage.getItem(key)
        const n = Number(raw)
        return raw !== null && Number.isFinite(n) ? n : fallback
      } catch { return fallback }
    }
    function writeNumberPref(key, value) {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return
        window.localStorage.setItem(key, String(value))
      } catch { /* 隐私模式 */ }
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
    // v3.0.8 诊断日志：面板内所有错误集中展示，供开发/调试查看。
    const diagLog = []
    function diag(level, message, detail = '') {
      const entry = {
        at: Date.now(),
        level: String(level || 'bad'),
        message: String(message ?? ''),
        detail: String(detail ?? '').slice(0, 2000),
      }
      diagLog.push(entry)
      if (diagLog.length > 3000) diagLog.shift()
      try { window.__fangUiLog?.push?.({ kind: 'diag', level: entry.level, message: entry.message }) } catch { /* ignore */ }
      try { window.dispatchEvent(new CustomEvent('fang:diag')) } catch { /* ignore */ }
    }

    async function api(path, options) {
      const url = String(path)
      // Absolute / scheme-relative URLs must never reach fetch(): the install token
      // would travel to a foreign origin. The panel only talks to its own /fang API.
      if (!url.startsWith('/') || url.startsWith('//')) {
        const message = 'api() 只接受同源相对路径：' + url
        diag('bad', message)
        return { status: 0, body: { ok: false, error: 'invalid-api-path' }, diagnostic: { url, message } }
      }
      const request = { ...(options ?? {}) }
      let token = await ensureFangAuthToken()
      const buildHeaders = () => ({
        ...(request.headers ?? {}),
        'content-type': 'application/json',
        accept: 'application/json',
        ...(token ? { 'x-fang-auth': token } : {}),
      })
      let res
      try {
        res = await fetch(url, { ...request, headers: buildHeaders() })
      } catch (error) {
        const message = String(error?.message ?? error)
        diag('bad', '网络请求失败：' + url, message)
        return { status: 0, body: null, diagnostic: { url, message } }
      }
      // A host restart can rotate the install token; retry once with the public
      // /fang/api/auth-token bootstrap instead of leaving the panel stuck at 401.
      if (res.status === 401) {
        fangAuthToken = ''
        const fresh = await ensureFangAuthToken()
        if (fresh && fresh !== token) {
          token = fresh
          try {
            res = await fetch(url, { ...request, headers: buildHeaders() })
          } catch { /* keep the original 401 below */ }
        }
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

    // ── Web 端角色徽标（母体 / 元主 / 分身）──────────────────────────────
    // 同一个 Fang 插件同时运行在三种 Web 实例里；侧栏 HARNESS 右侧用红字标出当前身份，
    // 避免“每次进来不知道是哪个”。宿主侧栏品牌行是 DSH 壳自己的 DOM，单槽
    // （sidebar.brand.name）替换会抹掉官方词标，因此这里在词标后**追加**一个只读徽标，
    // 并在宿主重渲染把节点摘掉时自动补回。
    const WEB_ROLE_LABEL = Object.freeze({ mother: '母体', essence: '元主', fork: '分身' })
    const WEB_ROLE_BADGE_ID = 'fang-web-role-badge'
    async function detectWebRole() {
      // 母体：/fang/api/status 由母体路由提供，role=mother。
      try {
        const status = await api('/fang/api/status')
        if (status.status === 200 && status.body && status.body.ok !== false) {
          const role = String(status.body.role ?? 'mother')
          if (role === 'mother') return 'mother'
        }
      } catch { /* fall through to identity route */ }
      // 元主 / 分身：fork 角色的 adapter 带 Bearer 鉴权，浏览器拿不到 token，
      // 因此用公开只读的 /fang/adapter/identity（v3.1.14 起）。
      try {
        const identity = await api('/fang/adapter/identity')
        if (identity.status === 200 && identity.body) {
          const kind = String(identity.body.kind ?? '')
          if (kind === 'mother' || kind === 'essence' || kind === 'fork') return kind
        }
      } catch { /* fall through to legacy hello */ }
      // 兼容旧宿主（adapter 无 identity 路由）：尝试 hello（可能 401），旧运行态按 rt- 前缀兜底。
      try {
        const hello = await api('/fang/adapter/hello')
        if (hello.status === 200 && hello.body) {
          const kind = String(hello.body.kind ?? '')
          if (kind === 'mother' || kind === 'essence' || kind === 'fork') return kind
          const taskId = String(hello.body.taskId ?? '')
          return /^rt-/.test(taskId) ? 'essence' : 'fork'
        }
      } catch { /* unknown */ }
      return ''
    }
    function mountWebRoleBadge() {
      if (typeof document === 'undefined') return () => {}
      try { injectStyle(document) } catch { /* style optional */ }
      let role = ''
      let timer = 0
      let observer = null
      let observed = null
      let fallbackEl = null
      let reported = false

      // v3.1.17：客户端自报「已加载」，仅时间戳（供 /fang/adapter/identity 的 clientLoaded）。
      const reportLoaded = () => {
        if (reported) return
        reported = true
        try {
          void fetch('/fang/adapter/client-report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
            .catch(() => { /* 老宿主没有该路由：忽略 */ })
        } catch { /* ignore */ }
      }

      const findBrandName = () => {
        const candidates = document.querySelectorAll('[class*="brandName"]')
        for (const node of candidates) {
          if (node && node.parentElement && node.closest('[class*="brand"], [class*="brandIdentity"]')) return node
        }
        return candidates[0] ?? null
      }
      const paint = (el) => {
        if (!el) return
        const label = WEB_ROLE_LABEL[role] ?? ''
        const hidden = label === ''
        const title = label ? ('当前 Web 端：' + label) : '正在识别 Web 端身份…'
        // Idempotent: the mutation observer watches this parent, so rewriting an
        // unchanged text node would feed itself and spin forever.
        if (el.textContent !== label) el.textContent = label
        if (el.hidden !== hidden) el.hidden = hidden
        if (el.dataset.fangWebRole !== role) el.dataset.fangWebRole = role
        for (const kind of ['mother', 'essence', 'fork']) {
          el.classList.toggle('fang-web-role--' + kind, role === kind)
        }
        if (el.title !== title) el.title = title
        if (el.getAttribute('aria-label') !== title) el.setAttribute('aria-label', title)
      }

      const createBadge = () => {
        const el = document.createElement('span')
        el.id = WEB_ROLE_BADGE_ID
        el.className = 'fang-web-role'
        el.setAttribute('role', 'status')
        el.setAttribute('aria-live', 'polite')
        return el
      }

      /** 首选：宿主侧栏品牌词标右侧。 */
      const placeInBrand = () => {
        if (!document || !document.body) return false
        const existing = document.getElementById(WEB_ROLE_BADGE_ID)
        if (existing && existing.isConnected && existing.parentElement && existing !== fallbackEl) { paint(existing); return true }
        const brandName = findBrandName()
        if (!brandName || !brandName.parentElement) return false
        if (fallbackEl) { try { fallbackEl.remove() } catch { /* ignore */ } fallbackEl = null }
        const el = createBadge()
        brandName.parentElement.insertBefore(el, brandName.nextSibling)
        paint(el)
        observe(brandName.parentElement)
        return true
      }

      /**
       * 兜底（v3.1.17）：品牌槽不存在或被宿主整段移除时，挂到 body 右上角固定角标。
       * 只在 3 次重试仍失败后启用，避免与正常挂载抢位置。
       */
      const placeFallback = () => {
        if (!document || !document.body) return false
        if (fallbackEl && fallbackEl.isConnected) { paint(fallbackEl); return true }
        const el = createBadge()
        el.classList.add('fang-web-role--fallback')
        el.style.position = 'fixed'
        el.style.top = '8px'
        el.style.right = '12px'
        el.style.zIndex = '2147483000'
        el.style.padding = '2px 8px'
        el.style.borderRadius = '10px'
        el.style.fontSize = '11px'
        el.style.fontWeight = '600'
        el.style.pointerEvents = 'none'
        el.style.background = 'rgba(0,0,0,.55)'
        document.body.append(el)
        fallbackEl = el
        paint(el)
        observe(document.body)
        return true
      }

      const observe = (node) => {
        if (!node) return
        if (observed === node && observer) return
        if (observer) { try { observer.disconnect() } catch { /* ignore */ } }
        observer = new MutationObserver(() => {
          try { if (!placeInBrand()) placeFallback() } catch { /* ignore */ }
        })
        try { observer.observe(node, { childList: true, subtree: true }) } catch { /* ignore */ }
        observed = node
      }

      const install = () => {
        const ok = placeInBrand()
        if (ok) { if (timer) { clearInterval(timer); timer = 0 } return true }
        return false
      }

      reportLoaded()

      // 3 次重试（250ms 间隔）后才兜底；宿主侧栏渲染通常在第一帧后就绪。
      if (!install()) {
        let tries = 0
        timer = setInterval(() => {
          tries += 1
          const done = install()
          if (!done && tries >= 3) {
            clearInterval(timer)
            timer = 0
            placeFallback()
          } else if (done) {
            clearInterval(timer)
            timer = 0
          }
        }, 250)
      }

      void (async () => {
        const detected = await detectWebRole()
        if (!detected) return
        role = detected
        if (!install()) placeFallback()
      })()

      return () => {
        if (timer) { clearInterval(timer); timer = 0 }
        if (observer) { try { observer.disconnect() } catch { /* ignore */ } observer = null }
        void observed
        try { document.getElementById(WEB_ROLE_BADGE_ID)?.remove() } catch { /* ignore */ }
        try { fallbackEl?.remove() } catch { /* ignore */ }
        fallbackEl = null
      }
    }

    function resolveMotherOrigin() {
      // In the Electron shell the panel origin is the loopback proxy, which only
      // serves /fang/api/*; the mother portal lives on the upstream DSH origin.
      try {
        const desktop = typeof window !== 'undefined' ? window.__fangDesktopUpstream : ''
        if (typeof desktop === 'string' && /^https?:\/\//i.test(desktop)) return desktop.replace(/\/+$/, '')
      } catch { /* ignore */ }
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
    async function openMotherPortal() {
      // 母体 Web 就是 DSH 客户端本身。Electron 壳优先把 DSH 桌面窗口置前，
      // 而不是打开没有 token 的裸 HTTP URL（那会 401）。
      if (window.fangShell?.focusMother) {
        try {
          const result = await window.fangShell.focusMother()
          if (result?.ok) return
        } catch { /* fall through */ }
      }
      const token = new URLSearchParams(location.search).get('token') || ''
      const origin = resolveMotherOrigin()
      if (!window.fangShell && token && origin) {
        try {
          const win = window.open(`${origin}/?token=${encodeURIComponent(token)}`, '_blank', 'noopener')
          if (win) return
        } catch { /* popup blocked */ }
      }
      // Web 端：母体 Web 就是当前 DSH 客户端，切回瓮城控制台视图即可。
      try {
        window.dispatchEvent(new CustomEvent('fang:mother-portal'))
      } catch { /* ignore */ }
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
      inbox: (size = 14) => glyph(['M4 5h16v14H4z', 'M4 13h4l2 3h4l2-3h4'], size),
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
  position:relative;color-scheme:light;height:100%;min-height:0;box-sizing:border-box;overflow:hidden;
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
.fang-body{position:relative;display:grid;grid-template-columns:minmax(320px,50fr) minmax(0,50fr);gap:16px;align-items:stretch;height:100%;min-height:0;flex:1 1 auto;overflow:hidden}
.fang-body.is-resizing{cursor:col-resize;user-select:none}
.fang-body.is-resizing *{user-select:none}
.fang-split-handle{position:absolute;top:0;bottom:0;left:50%;width:10px;transform:translateX(-50%);cursor:col-resize;z-index:6;border-radius:6px;background:transparent;touch-action:none}
.fang-split-handle::after{content:"";position:absolute;top:50%;left:50%;width:3px;height:46px;transform:translate(-50%,-50%);border-radius:3px;background:var(--f-border-strong,var(--f-border));opacity:.55;transition:opacity .15s,background .15s}
.fang-split-handle:hover::after,.fang-split-handle:focus-visible::after,.fang-body.is-resizing .fang-split-handle::after{opacity:1;background:var(--f-blue,#3b82f6)}
.fang-split-handle:focus-visible{outline:2px solid var(--f-blue,#3b82f6);outline-offset:2px}
@media (max-width:1100px){.fang-console{overflow:auto}.fang-body{grid-template-columns:1fr;align-items:start;height:auto;flex:1 0 auto;overflow:visible}.fang-split-handle{display:none}}
.panel{background:var(--f-surface);border:1px solid var(--f-border);border-radius:var(--f-radius-panel);
  box-shadow:var(--f-shadow-card);display:flex;flex-direction:column;min-height:0;overflow:hidden;
  height:100%;max-height:100%}
@media (max-width:1100px){.panel{height:auto;max-height:62vh}}
.panel-head{flex:0 0 auto;padding:16px 16px 10px;display:flex;flex-direction:column;gap:10px}
.panel-title-row{display:flex;align-items:center;gap:10px;min-height:28px}
.panel-title{font-size:20px;font-weight:600;letter-spacing:-.014em;line-height:26px;margin:0}
.panel-sub{font-size:11.5px;color:var(--f-text-3);line-height:16px}
.panel-count{margin-left:auto;display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;
  border:1px solid var(--f-border);border-radius:999px;background:var(--f-surface-2);
  font-size:11px;color:var(--f-text-3);font-variant-numeric:tabular-nums;white-space:nowrap}
.panel-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;
  scrollbar-gutter:stable;padding:0 10px 14px;
  scrollbar-width:thin;scrollbar-color:rgba(16,17,20,.32) rgba(16,17,20,.06)}
.panel-scroll::-webkit-scrollbar{width:12px;height:12px}
.panel-scroll::-webkit-scrollbar-track{background:rgba(16,17,20,.05);border-radius:999px}
.panel-scroll::-webkit-scrollbar-thumb{background:rgba(16,17,20,.30);border:3px solid #fff;border-radius:999px;background-clip:padding-box}
.panel-scroll::-webkit-scrollbar-thumb:hover{background:rgba(16,17,20,.46);border:2px solid #fff;background-clip:padding-box}

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
.essence-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px;padding:6px 8px}
.essence-card{display:flex;flex-direction:column;gap:6px;box-sizing:border-box;min-width:0;
  border:1px solid var(--f-border);border-radius:10px;background:var(--f-surface);
  padding:9px 11px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
.essence-card-head{display:flex;align-items:center;gap:6px;min-height:24px;flex-wrap:wrap}
.essence-card-name{font-family:"Microsoft YaHei","微软雅黑",sans-serif;font-size:16px;font-weight:600;
  line-height:24px;color:var(--f-text);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.essence-card-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;line-height:20px;color:var(--f-text-3)}
.essence-card-times{display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.essence-card-actions{display:inline-flex;align-items:center;gap:2px;margin-left:auto}
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
/* Web 端角色徽标：母体 / 元主 / 分身 —— 挂在侧栏品牌词右侧，仅用于识别当前实例身份。 */
.fang-web-role{display:inline-flex;align-items:center;height:18px;margin-left:7px;padding:0 6px;border-radius:6px;
  border:1px solid transparent;background:transparent;color:#C8102E;
  font-size:11.5px;font-weight:700;letter-spacing:.02em;line-height:1;white-space:nowrap;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;vertical-align:middle;
  -webkit-app-region:no-drag;user-select:none}
.fang-web-role--mother{border-color:rgba(200,16,46,.32);background:rgba(200,16,46,.07);color:#C8102E}
.fang-web-role--essence{border-color:rgba(10,107,224,.32);background:rgba(10,107,224,.08);color:#0A6BE0}
.fang-web-role--fork{border-color:rgba(23,128,61,.32);background:rgba(23,128,61,.08);color:#17803D}
.fang-web-role[hidden]{display:none}
.fang-web-role--unknown{visibility:hidden}
/* 决策中继：每个会话右侧的待选悬浮按钮 + 从右向左滑出的决策栏（v3.1.13）。 */
.fang-relay-fab{position:fixed;right:18px;top:52%;transform:translateY(-50%);z-index:2147482900;display:inline-flex;align-items:center;gap:7px;height:36px;padding:0 12px;border-radius:999px;border:1px solid rgba(200,16,46,.35);background:#fff;color:#C8102E;box-shadow:0 8px 24px -8px rgba(200,16,46,.45);cursor:pointer;font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;-webkit-app-region:no-drag;user-select:none}
.fang-relay-fab:hover{background:#FFF5F7}
.fang-relay-fab[hidden]{display:none}
.fang-relay-fab.is-empty{opacity:.55;border-color:rgba(16,17,20,.18);color:#6E6E73;box-shadow:0 6px 18px -10px rgba(16,17,20,.35)}
.fang-relay-fab.is-empty:hover{opacity:.85;background:#F5F5F7}
.fang-relay-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:#C8102E;color:#fff;font-size:11px;font-weight:700}
/* v3.1.28：靠右贴边吸附 + 垂直居中；关闭态整体停在屏幕右侧外，打开时从右往左飞入 */
.fang-relay-panel{position:fixed;top:50%;right:0;left:auto;bottom:auto;height:33vh;min-height:220px;max-height:33vh;width:min(420px,94vw);z-index:2147483000;background:#fff;border:1px solid rgba(16,17,20,.12);border-right:none;border-radius:16px 0 0 16px;box-shadow:-18px 0 48px -16px rgba(16,17,20,.28);transform:translateX(102%) translateY(-50%);opacity:0;transition:transform .26s cubic-bezier(.22,.61,.36,1),opacity .2s ease;display:flex;flex-direction:column;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.45;color:#1D1D1F}
.fang-relay-panel.is-open{transform:translateX(0) translateY(-50%);opacity:1;pointer-events:auto}
.fang-relay-backdrop{display:none}
.fang-relay-head{display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid rgba(16,17,20,.08);flex:0 0 auto}
.fang-relay-title{font-size:14px;font-weight:700}
.fang-relay-sub{font-size:11.5px;color:#86868B}
.fang-relay-close{margin-left:auto;width:28px;height:28px;border-radius:8px;border:1px solid rgba(16,17,20,.12);background:#fff;color:#5F6368;cursor:pointer;font-size:15px;line-height:1}
.fang-relay-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:12px 14px 18px;display:flex;flex-direction:column;gap:10px}
.fang-relay-empty{font-size:12px;color:#86868B;padding:18px 6px;text-align:center}
.fang-relay-ticket{border:1px solid rgba(16,17,20,.1);border-radius:12px;padding:10px 11px;background:#FAFAFC;display:flex;flex-direction:column;gap:7px}
.fang-relay-ticket-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.fang-relay-level{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:6px;font-size:10.5px;font-weight:700;letter-spacing:.02em;background:#F2F2F5;color:#5F6368}
.fang-relay-level--red{background:rgba(200,16,46,.08);color:#C8102E}
.fang-relay-level--yellow{background:rgba(180,83,9,.1);color:#B45309}
.fang-relay-level--blue{background:rgba(10,107,224,.08);color:#0A6BE0}
.fang-relay-level--green{background:rgba(23,128,61,.08);color:#17803D}
.fang-relay-ticket-title{font-size:13px;font-weight:600;color:#1D1D1F}
.fang-relay-context{font-size:12px;color:#5F6368;white-space:pre-wrap;max-height:96px;overflow:auto;overscroll-behavior:contain}
.fang-relay-options{display:flex;flex-direction:column;gap:6px}
.fang-relay-option{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:1px solid rgba(16,17,20,.12);background:#fff;border-radius:9px;padding:8px 10px;cursor:pointer;font:inherit;font-size:12.5px;color:#1D1D1F}
.fang-relay-option:hover{border-color:rgba(200,16,46,.4);background:#FFF7F8}
.fang-relay-option:disabled{opacity:.55;cursor:default}
.fang-relay-key{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;background:#F2F2F5;color:#5F6368;font-weight:700;font-size:11px;flex:0 0 auto}
.fang-relay-custom{display:flex;gap:6px;margin-top:2px}
.fang-relay-input{flex:1 1 auto;min-width:0;height:32px;border-radius:9px;border:1px solid rgba(16,17,20,.14);padding:0 9px;font:inherit;font-size:12.5px;background:#fff;color:#1D1D1F}
.fang-relay-input:focus{outline:2px solid rgba(200,16,46,.25);outline-offset:-1px}
.fang-relay-submit{flex:0 0 auto;height:32px;padding:0 11px;border-radius:9px;border:1px solid #C8102E;background:#C8102E;color:#fff;font:600 12.5px/1 inherit;cursor:pointer}
.fang-relay-submit:disabled{opacity:.5;cursor:default}
.fang-relay-msg{font-size:11.5px;color:#B45309}
.fang-relay-error{font-size:11.5px;color:#C8102E}
@media (prefers-reduced-motion:reduce){.fang-relay-panel{transition:none}.fang-relay-backdrop{transition:none}}

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
  .text-action,.task-actions .text-action,.fork-actions .text-action{display:inline-block}
  .fork-card:hover{transform:none}
  .btn:hover{background:transparent}
  .btn--ghost:hover{background:var(--f-surface);border-color:var(--f-border)}
  .text-action:hover{background:transparent}
  .expand-btn{width:34px;height:34px}
  .btn--sm{height:34px;min-height:34px}
  .section-title{min-height:34px}
}
.btn--sm{min-height:34px}
.expand-btn{width:34px;height:34px;min-width:34px}
.section-title{min-height:34px;min-width:34px}
.fork-actions .btn,.fork-actions .text-action{min-height:34px}
@media (prefers-reduced-motion:reduce){
  .fang-console *,.fang-console *::before,.fang-console *::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
}

/* ── 决策收件箱（独立侧边栏入口 + 右侧抽屉 / 独立 Slot）────────────────── */
.fang-inbox{
  --f-inbox-border:rgba(16,17,20,.1);--f-inbox-text:#1D1D1F;--f-inbox-text2:#5F6368;--f-inbox-surface:#fff;--f-inbox-surface2:#FAFAFC;
  position:relative;display:flex;flex-direction:column;min-height:0;height:100%;background:var(--f-inbox-surface);color:var(--f-inbox-text);
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;font-size:13px;line-height:1.45;
}
.fang-inbox *{box-sizing:border-box}
.fang-inbox button,.fang-inbox input,.fang-inbox select{font-family:inherit}
.fang-inbox-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--f-inbox-border);flex:0 0 auto}
.fang-inbox-title{font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px;min-width:0}
.fang-inbox-unread{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:#C8102E;color:#fff;font-size:11px;font-weight:600}
.fang-inbox-actions{margin-left:auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.fang-inbox-btn{height:26px;padding:0 8px;border-radius:8px;border:1px solid rgba(16,17,20,.14);background:#fff;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.fang-inbox-btn:hover{background:#F2F2F5}
.fang-inbox-btn:disabled{opacity:.5;cursor:default}
.fang-inbox-btn--primary{background:#0A6BE0;border-color:#0A6BE0;color:#fff}
.fang-inbox-btn--primary:hover{background:#0857B8}
.fang-inbox-btn--danger{color:#C8102E;border-color:rgba(200,16,46,.3)}
.fang-inbox-ai{padding:8px 12px;border-bottom:1px solid var(--f-inbox-border);font-size:12px;color:var(--f-inbox-text2);flex:0 0 auto}
.fang-inbox-ai summary{cursor:pointer;color:var(--f-inbox-text2)}
.fang-inbox-ai-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;align-items:center}
.fang-inbox-ai input,.fang-inbox-ai select{height:26px;padding:0 6px;border-radius:7px;border:1px solid rgba(16,17,20,.14);font:inherit;font-size:12px;background:#fff;color:#1D1D1F}
.fang-inbox-ai-status{font-size:11px;color:#6E6E73;margin-top:2px}
.fang-inbox-ai-test{font-size:11.5px;margin-top:6px;padding:5px 8px;border-radius:7px;background:#F2F2F5;color:#5F6368}
.fang-inbox-ai-test--ok{background:rgba(23,128,61,.08);color:#17803D}
.fang-inbox-ai-test--err{background:rgba(200,16,46,.07);color:#C8102E}
.fang-inbox-ai-test--testing{background:rgba(10,107,224,.07);color:#0857B8}
.fang-inbox-ai-risks{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.fang-inbox-ai-tag{font-size:10px;font-weight:700;color:#8A5A00;background:rgba(180,83,9,.1);border-radius:4px;padding:0 4px;margin-right:5px}
.fang-inbox-ai-stream{font-size:11px;color:#0857B8;background:rgba(10,107,224,.05);border-radius:6px;padding:4px 6px;margin-top:4px;white-space:pre-wrap;max-height:120px;overflow:auto}.fang-inbox-risk{font-size:10.5px;padding:1px 5px;border-radius:5px;background:#F2F2F5;color:#5F6368}
.fang-inbox-risk--low{background:rgba(23,128,61,.1);color:#17803D}
.fang-inbox-risk--medium{background:rgba(180,83,9,.1);color:#9A4A06}
.fang-inbox-risk--high{background:rgba(200,16,46,.09);color:#C8102E}
.fang-inbox-ai-missing{font-size:10.5px;color:#8A5A00;margin-top:3px}
.fang-inbox-exec{font-size:10.5px;margin-top:3px;color:#5F6368}
.fang-inbox-exec--done{color:#17803D}
.fang-inbox-exec--failed{color:#C8102E}
.fang-inbox-exec--running{color:#0857B8}
.fang-inbox-toolbar{display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid var(--f-inbox-border);flex-wrap:wrap;flex:0 0 auto}
.fang-inbox-hint{font-size:11.5px;color:#86868B}
.fang-inbox-body{flex:1 1 auto;min-height:0;overflow:auto;padding:8px 10px 16px;display:flex;flex-direction:column;gap:8px}
.fang-inbox-group{border:1px solid var(--f-inbox-border);border-radius:12px;overflow:hidden;background:#fff}
.fang-inbox-group-head{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border:0;background:var(--f-inbox-surface2);cursor:pointer;font:inherit;text-align:left;color:inherit}
.fang-inbox-group-toggle{display:flex;align-items:center;gap:8px;flex:1;min-width:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;padding:0;cursor:pointer}
.fang-inbox-group-check{flex:none;margin:0;accent-color:#0A6BE0;cursor:pointer}
.fang-inbox-group-head b{font-size:12.5px}
.fang-inbox-group-head .n{margin-left:auto;font-size:11.5px;color:#6E6E73}
.fang-inbox-group[data-level="red"] .fang-inbox-group-head{background:rgba(200,16,46,.06);color:#C8102E}
.fang-inbox-group[data-level="yellow"] .fang-inbox-group-head{background:rgba(180,83,9,.07);color:#9A4A06}
.fang-inbox-group[data-level="blue"] .fang-inbox-group-head{background:rgba(10,107,224,.06);color:#0857B8}
.fang-inbox-group[data-level="green"] .fang-inbox-group-head{background:rgba(23,128,61,.06);color:#17803D}
.fang-inbox-group[data-level="gray"] .fang-inbox-group-head{color:#6E6E73}
.fang-inbox-item{display:flex;gap:8px;padding:8px 10px;border-top:1px solid rgba(16,17,20,.06);align-items:flex-start}
.fang-inbox-item[data-level="red"]{border-left:3px solid #C8102E}
.fang-inbox-item[data-level="yellow"]{border-left:3px solid #B45309}
.fang-inbox-item[data-level="blue"]{border-left:3px solid #0A6BE0}
.fang-inbox-item[data-level="green"]{border-left:3px solid #17803D}
.fang-inbox-item[data-level="gray"]{border-left:3px solid #C7C7CC;opacity:.72}
.fang-inbox-item.is-active{background:#F2F6FF;outline:2px solid rgba(10,107,224,.35);outline-offset:-2px}
.fang-inbox-check{margin-top:2px;flex:0 0 auto}
.fang-inbox-main{min-width:0;flex:1 1 auto}
.fang-inbox-item-title{font-size:12.5px;font-weight:600;line-height:1.35;overflow-wrap:anywhere}
.fang-inbox-item-context{font-size:12px;color:#5F6368;margin-top:2px;white-space:pre-wrap;max-height:72px;overflow:hidden}
.fang-inbox-meta{font-size:11px;color:#86868B;margin-top:3px}
.fang-inbox-item-actions{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.fang-inbox-item-actions .fang-inbox-btn{height:24px;padding:0 7px;font-size:11.5px}
.fang-inbox-ai-advice{font-size:11.5px;color:#0857B8;background:rgba(10,107,224,.06);border-radius:6px;padding:4px 6px;margin-top:4px;white-space:pre-wrap}
.fang-inbox-empty{padding:28px 16px;text-align:center;color:#86868B;font-size:12px}
.fang-inbox-err{margin:8px 10px;padding:8px 10px;border-radius:8px;background:rgba(200,16,46,.07);color:#C8102E;font-size:12px}
.fang-inbox-seat{display:inline-flex;align-items:center;justify-content:center;position:relative;width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer}
.fang-inbox-seat:hover{background:rgba(127,127,127,.1)}
.fang-inbox-seat .fang-inbox-badge{position:absolute;top:-3px;right:-4px;min-width:15px;height:15px;padding:0 3px;border-radius:999px;background:#C8102E;color:#fff;font-size:9.5px;line-height:15px;text-align:center;font-weight:600}
.fang-decision-mini{margin:0 0 12px;border:1px solid var(--f-border,rgba(16,17,20,.1));border-radius:14px;background:var(--f-surface,#fff);overflow:hidden;box-shadow:0 2px 8px rgba(16,17,20,.05)}
.fang-decision-mini-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--f-border,rgba(16,17,20,.1))}
.fang-decision-mini-head b{font-size:13px}
.fang-decision-mini-count{font-size:11px;color:var(--f-text-3,#8A8A8E)}
.fang-decision-mini-spacer{flex:1}
.fang-decision-mini-refresh{height:24px;padding:0 8px;border-radius:7px;border:1px solid var(--f-border,rgba(16,17,20,.14));background:transparent;color:inherit;font-size:11px;cursor:pointer}
.fang-decision-mini-body{padding:6px 10px 10px;display:flex;flex-direction:column;gap:6px;max-height:340px;overflow:auto}
.fang-decision-mini-group{border-radius:9px;background:rgba(127,127,127,.04)}
.fang-decision-mini-group[data-level="red"]{background:rgba(200,16,46,.05)}
.fang-decision-mini-group-head{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:0;background:transparent;color:inherit;font-size:12px;cursor:pointer;text-align:left}
.fang-decision-mini-group-head span{margin-left:auto;font-size:10.5px;color:var(--f-text-3,#8A8A8E)}
.fang-decision-mini-list{display:flex;flex-direction:column;gap:6px;padding:0 8px 8px}
.fang-decision-mini-item{border-left:3px solid rgba(16,17,20,.18);padding:4px 0 4px 8px}
.fang-decision-mini-item[data-level="red"],.fang-decision-mini-group[data-level="red"] .fang-decision-mini-item{border-left-color:#C8102E}
.fang-decision-mini-item[data-level="yellow"]{border-left-color:#B45309}
.fang-decision-mini-item[data-level="blue"]{border-left-color:#0A6BE0}
.fang-decision-mini-title{font-size:12.5px;font-weight:600;overflow-wrap:anywhere}
.fang-decision-mini-meta{font-size:10.5px;color:var(--f-text-3,#8A8A8E);margin-top:1px;overflow-wrap:anywhere}
.fang-decision-mini-context{font-size:11px;color:var(--f-text-2,#5F6368);margin-top:2px;overflow-wrap:anywhere}
.fang-decision-mini-actions{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.fang-decision-mini-actions .fang-inbox-btn{height:22px;font-size:11px;padding:0 7px}
.fang-inbox-drawer{position:fixed;top:0;right:0;bottom:0;width:min(420px,92vw);z-index:2147483001;background:#fff;border-left:1px solid rgba(16,17,20,.12);box-shadow:-18px 0 48px rgba(0,0,0,.18);transform:translateX(100%);transition:transform .18s ease;display:flex;flex-direction:column}
.fang-inbox-drawer.is-open{transform:none}
.fang-inbox-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.26);z-index:2147483000;animation:fang-fade .15s ease}
.fang-inbox-stream{font-size:11px;color:#17803D;white-space:nowrap}
.fang-inbox-seat.has-red .fang-inbox-badge{animation:fang-inbox-pulse 1.2s ease-in-out infinite}
@keyframes fang-inbox-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.18)}}
.fang-red-alert-stack{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483002;display:flex;flex-direction:column;gap:8px;width:min(560px,92vw)}
.fang-inbox-red-alert{background:#fff;border:1px solid rgba(200,16,46,.4);border-left:5px solid #C8102E;border-radius:12px;box-shadow:0 16px 40px rgba(200,16,46,.22);padding:10px 12px;animation:fang-rise .18s ease}
.fang-inbox-red-alert-title{display:flex;align-items:center;gap:6px;color:#C8102E;font-weight:700;font-size:13px}
.fang-inbox-red-alert-body{font-size:13px;font-weight:600;margin-top:2px;color:#1D1D1F}
.fang-inbox-red-alert-context{font-size:11.5px;color:#6E6E73;margin-top:2px}
.fang-inbox-red-alert-actions{display:flex;gap:6px;margin-top:7px}
.fang-inbox-batch-fail{margin:0 0 8px;padding:8px 10px;border:1px solid rgba(180,83,9,.35);background:rgba(180,83,9,.06);border-radius:10px;font-size:12px}
.fang-inbox-batch-fail-title{font-weight:700;color:#9A4A06;margin-bottom:4px}
.fang-inbox-batch-fail-row{display:flex;gap:8px;justify-content:space-between;padding:3px 0;border-top:1px dashed rgba(180,83,9,.2)}
.fang-inbox-batch-fail-row b{font-weight:600;overflow-wrap:anywhere}
.fang-inbox-batch-fail-row span{color:#6E6E73;white-space:nowrap}
.fang-inbox-batch-fail-actions{display:flex;gap:6px;margin-top:6px}
.fang-inbox-confirm{position:absolute;inset:0;z-index:5;background:rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center;padding:16px}
.fang-inbox-confirm-card{width:min(420px,100%);background:#fff;border-radius:14px;box-shadow:0 18px 48px rgba(0,0,0,.24);padding:14px 16px}
.fang-inbox-confirm-title{font-size:14px;font-weight:700;color:#1D1D1F}
.fang-inbox-confirm-msg{font-size:12.5px;color:#5F6368;margin-top:6px;line-height:1.5}
.fang-inbox-confirm-detail{font-size:11.5px;color:#6E6E73;background:#FAFAFC;border-radius:8px;padding:6px 8px;margin-top:6px;white-space:pre-wrap;max-height:120px;overflow:auto}
.fang-inbox-confirm-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
@media (prefers-reduced-motion:reduce){.fang-inbox-drawer{transition:none}.fang-inbox-seat.has-red .fang-inbox-badge{animation:none}}
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
    /**
     * 重命名写通道（v3.0.7）：
     * - task:<taskId>    → POST /fang/api/tasks/rename
     * - essence:<id>     → POST /fang/api/essence/rename
     * - 其他             → PATCH /fang/api/workspaces/:key（旧宿主）或本地别名
     * 404/405 退化为本地别名；409 = 其他客户端已改；网络错误不回退。
     */
    async function saveAlias(key, value, baseAliasRev) {
      const rawKey = String(key ?? '')
      const post = (route, payload) => api(route, { method: 'POST', body: JSON.stringify(payload) })
      if (rawKey.startsWith('task:')) {
        const result = await post('/fang/api/tasks/rename', { taskId: rawKey.slice(5), title: value })
        if (result.status === 200 && result.body?.ok !== false) return { scope: 'host' }
        if (result.status === 409) {
          const error = new Error('conflict')
          error.conflict = String(result.body?.conflict ?? result.body?.title ?? '')
          throw error
        }
        if (result.status === 404 || result.status === 405) { await saveAliasLocal(rawKey, value); return { scope: 'local' } }
        throw new Error(result.body?.error || (result.status ? 'http-' + result.status : 'network'))
      }
      if (rawKey.startsWith('essence:')) {
        const result = await post('/fang/api/essence/rename', { essenceId: rawKey.slice(8), name: value })
        if (result.status === 200 && result.body?.ok !== false) return { scope: 'host' }
        if (result.status === 409) {
          const error = new Error('conflict')
          error.conflict = String(result.body?.conflict ?? result.body?.name ?? '')
          throw error
        }
        if (result.status === 404 || result.status === 405) { await saveAliasLocal(rawKey, value); return { scope: 'local' } }
        throw new Error(result.body?.error || (result.status ? 'http-' + result.status : 'network'))
      }
      const result = await api('/fang/api/workspaces/' + encodeURIComponent(rawKey), {
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
        collapsedTasks: new Set(),
        // 主工作区比例：元宝工作区 / 分身工作区，默认 50:50，可拖动中间手柄调整。
        splitRatio: (() => {
          const n = readNumberPref('fang.panel.split', 0.5)
          return Math.min(0.75, Math.max(0.25, Number.isFinite(n) ? n : 0.5))
        })(),
        showTemporary: readPref('fang.panel.showTemporary', true),
        // 母体会话只读投影：默认只看最近 20 条，可切 50 / 全部（偏好存本机）。
        sessionWindow: (() => {
          try {
            const raw = window?.localStorage?.getItem('fang.panel.sessionWindow')
            if (raw === 'all') return 'all'
            const size = Number(raw)
            return Number.isFinite(size) && size >= 5 ? Math.min(200, Math.floor(size)) : 20
          } catch { return 20 }
        })(),
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
        approvals: { state: 'idle', items: [], failed: [], degraded: false, error: '', at: 0 },
        forkSupervision: { state: 'idle', data: null, error: '', at: 0 },
        decisions: { state: 'idle', items: [], counts: {}, rev: 0, error: '', at: 0 },
        decisionAi: { state: 'idle', configured: false, provider: null, model: null, providers: [], error: '' },
        decisionOpen: { green: false, gray: false },
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
        if (tone === 'bad' || tone === 'warn') diag(tone, text)
        if (toastTimer) window.clearTimeout(toastTimer)
        toastTimer = window.setTimeout(() => { if (alive) { S.toast = null; render() } }, options.sticky ? 8000 : 4200)
        if (tone === 'bad') announce(text, 'assertive')
        if (alive) render(true)
      }
      const setNotice = (notice) => { S.notice = notice; render() }
      const onFangNotice = (event) => notify('warn', String(event?.detail || ''))
      window.addEventListener('fang:notice', onFangNotice)
      const onMotherPortal = () => {
        S.view = 'console'
        setNotice({ tone: 'ok', title: '母体 Web', message: '母体 Web 就是当前 DSH 客户端，已切回瓮城控制台视图。' })
      }
      window.addEventListener('fang:mother-portal', onMotherPortal)

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
        // 分身 Web UI 不请求任何母体 API；404 是预期，不应落成错误状态/横幅。
        const role = await detectRole()
        if (!alive) return
        if (role !== 'mother') {
          S.lastRefreshAt = Date.now()
          if (options.manual) S.refreshing = false
          if (!options.silent) schedule()
          return
        }
        refreshingLock = true
        const seq = ++refreshSeq
        if (options.manual) { S.refreshing = true; schedule() }
        try {
          const [statusRes, tasksRes, sessionsRes, essenceRes, approvalsRes, supervisionRes] = await Promise.all([
            api('/fang/api/status').catch((error) => ({ status: 0, body: null, diagnostic: { message: String(error?.message ?? error) } })),
            api('/fang/api/tasks').catch((error) => ({ status: 0, body: null, diagnostic: { message: String(error?.message ?? error) } })),
            api(`/fang/api/sessions?limit=${S.sessionWindow === 'all' ? 1000 : S.sessionWindow}`).catch((error) => ({ status: 0, body: null, diagnostic: { message: String(error?.message ?? error) } })),
            api('/fang/api/essence/list').catch((error) => ({ status: 0, body: null, diagnostic: { message: String(error?.message ?? error) } })),
            api('/fang/api/approvals').catch((error) => ({ status: 0, body: null, diagnostic: { message: String(error?.message ?? error) } })),
            api('/fang/api/forks/supervision').catch((error) => ({ status: 0, body: null, diagnostic: { message: String(error?.message ?? error) } })),
          ])
          if (!alive || seq !== refreshSeq) return
          if (supervisionRes.status === 200 && supervisionRes.body?.ok) {
            S.forkSupervision = { state: 'ready', data: supervisionRes.body, error: '', at: Date.now() }
          } else {
            S.forkSupervision = {
              ...S.forkSupervision, state: 'error',
              error: supervisionRes.body?.error || (supervisionRes.status ? 'http-' + supervisionRes.status : 'network'),
              at: Date.now(),
            }
          }
          if (approvalsRes.status === 200 && approvalsRes.body && approvalsRes.body.ok !== false) {
            S.approvals = {
              state: 'ready',
              items: Array.isArray(approvalsRes.body.items) ? approvalsRes.body.items : [],
              failed: Array.isArray(approvalsRes.body.failed) ? approvalsRes.body.failed : [],
              degraded: approvalsRes.body.degraded === true,
              error: '', at: Date.now(),
            }
          } else {
            S.approvals = {
              ...S.approvals,
              state: 'error',
              error: approvalsRes.body?.error || (approvalsRes.status ? 'http-' + approvalsRes.status : 'network'),
              at: Date.now(),
            }
          }

          if (essenceRes.status === 200 && essenceRes.body && Array.isArray(essenceRes.body.essences)) {
            S.essenceList = { data: essenceRes.body, error: '', at: Date.now() }
          } else {
            S.essenceList = { data: null, error: essenceRes.body?.error || (essenceRes.status ? 'http-' + essenceRes.status : 'network'), at: Date.now() }
          }

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

      function setSessionWindow(next) {
        const normalized = next === 'all' ? 'all' : Math.max(5, Math.min(200, Math.floor(Number(next) || 20)))
        S.sessionWindow = normalized
        try { window.localStorage?.setItem('fang.panel.sessionWindow', String(normalized)) } catch { /* ignore */ }
        void refresh({ manual: true })
      }

      async function deriveTask(payload) {
      // v3.1.23：元主派生必须绑定一个会话（不允许空白快速派生出来源不明的一次性分身）。
      if (!String(payload?.sessionId ?? '').trim()) {
        try {
          if ((await detectWebRole()) === 'essence') {
            setNotice({ tone: 'warn', title: '元主派生需要先选择一个会话', message: '请在左侧会话列表中选中一个进行中的会话，再点「从此会话派生」。' })
            return
          }
        } catch { /* 识别失败则按原行为 */ }
      }
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
            actions: result.taskId ? [{ label: '打开分身', onClick: () => void openTask({ taskId: result.taskId }) }] : [],
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
              setNotice({ tone: 'ok', title: '已还原存档', message: `${task.title || task.taskId} 已重新启动 · 端口 ${body.port ?? '—'}`, actions: [{ label: '打开分身', onClick: () => void openTask({ taskId: task.taskId }) }] })
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

      function captureEssence() {
        if (isBusy()) return
        const profile = String(S.status?.data?.mother?.profile || 'desktop')
        askPrompt({
          title: '从母体生成元主',
          label: '新元主名称',
          value: `${profile} 元主`,
          confirmLabel: '生成',
          hint: '复制母体 profile 的可写层：插件补丁、依赖与设置；不复制凭据、会话和 node_modules。生成后可在元主区设为默认派生基底。',
          onConfirm: async (name) => {
            const trimmed = String(name ?? '').trim()
            if (!trimmed) { S.modal.error = '请填写元主名称'; render(true); return false }
            S.busy = 'essence:capture'
            const result = await api('/fang/api/essence/capture', { method: 'POST', body: JSON.stringify({ name: trimmed }) })
            S.busy = ''
            const body = result.body
            if (result.status === 200 && body?.ok) {
              const status = String(body.status ?? '')
              const conflicts = Array.isArray(body.conflicts) ? body.conflicts.length : 0
              const captured = body.captured ?? {}
              setNotice({
                tone: status === 'ready' ? 'ok' : 'warn',
                title: status === 'ready' ? '元主已生成' : '元主已生成（有冲突）',
                message: `「${body.meta?.name || trimmed}」· 补丁 ${captured.patchEntries ?? 0} 条 · 依赖 ${captured.dependencies ?? 0} 个 · 设置 ${captured.settings ?? 0} 组 · 捆绑 ${captured.bundles ?? 0} 个`,
                detail: conflicts > 0 ? `${conflicts} 条合并冲突：元主已物化，但需要人工处理后再用于派生。` : '',
              })
            } else {
              const code = body?.error || (result.status ? 'http-' + result.status : 'network')
              setNotice({ tone: 'bad', title: '生成元主失败', message: failureHint(code), detail: body?.detail || diagnosticText(result.diagnostic) })
            }
            await refresh()
          },
        })
      }

      // 升级链路 2.1：克隆母体 profile 到镜像（先自动备份，克隆后元主待同步）。
      function cloneMotherProfile() {
        if (isBusy()) return
        askConfirm({
          tone: 'info',
          title: '克隆母体到镜像？',
          confirm: 'clone-mother',
          message: '读取本机母体 profile（package.json / cordis.patch.yml / cordis.yml / settings），覆盖镜像 active/profile，并先自动备份当前镜像。\n\n克隆后所有元主会变成「🔼 待同步」——不会自动改它们的配置。',
          confirmLabel: '克隆母体',
          onConfirm: async () => {
            S.busy = 'mirror:clone'
            const result = await api('/fang/api/mirror/clone-profile', { method: 'POST', body: JSON.stringify({}) })
            S.busy = ''
            const body = result.body
            if (result.status === 200 && body?.ok) {
              setNotice({
                tone: 'ok', title: '母体已克隆到镜像',
                message: `版本 ${body.version} · ${(body.files || []).length} 个文件 → active/profile`,
                detail: body.backup ? `已自动备份：${body.backup.id}` : '',
              })
            } else {
              const code = body?.error || (result.status ? 'http-' + result.status : 'network')
              setNotice({ tone: 'bad', title: '克隆母体失败', message: failureHint(code), detail: body?.detail || diagnosticText(result.diagnostic) })
            }
            await refresh()
          },
        })
      }

      // 升级链路 3：把元主 overlay 重放到当前镜像（配置不动）。
      async function syncEssence(essenceId) {
        if (isBusy()) return
        S.busy = 'essence:sync:' + essenceId
        const result = await api('/fang/api/essence/sync', { method: 'POST', body: JSON.stringify({ essenceId }) })
        S.busy = ''
        const body = result.body
        if (result.status === 200 && body?.ok) {
          setNotice({ tone: body.status === 'ready' ? 'ok' : 'warn', title: '元主已同步', message: `${essenceId} · ${body.status}${body.recomputed ? '（已重新物化）' : '（无需重算）'}` })
        } else {
          setNotice({ tone: 'bad', title: '元主同步失败', message: failureHint(body?.error || 'sync-failed'), detail: body?.detail || diagnosticText(result.diagnostic) })
        }
        await refresh()
      }

      async function syncEssences() {
        if (isBusy()) return
        S.busy = 'essence:sync:all'
        const result = await api('/fang/api/essence/sync', { method: 'POST', body: JSON.stringify({}) })
        S.busy = ''
        const body = result.body
        if (result.status === 200 && body?.ok) {
          setNotice({
            tone: (body.conflicted || []).length > 0 ? 'warn' : 'ok',
            title: '元主批量同步完成',
            message: `重算 ${(body.recomputed || []).length} · 跳过 ${(body.skipped || []).length} · 冲突 ${(body.conflicted || []).length} · 失败 ${(body.failed || []).length}`,
            detail: (body.failed || []).length ? (body.failed || []).map((item) => `${item.id}: ${item.error}`).join('\n') : '',
          })
        } else {
          setNotice({ tone: 'bad', title: '元主批量同步失败', message: failureHint(body?.error || 'sync-failed'), detail: body?.detail || diagnosticText(result.diagnostic) })
        }
        await refresh()
      }

      // 原身运行态：隔离 home 的配置态实例（不写母体 sessions）。
      async function essenceRuntime(action, essenceId) {
        if (isBusy()) return
        S.busy = 'essence:runtime:' + essenceId
        const result = await api('/fang/api/essence/runtime', { method: 'POST', body: JSON.stringify({ action, essenceId }) })
        S.busy = ''
        const body = result.body
        if (result.status === 200 && body?.ok) {
          setNotice({
            tone: 'ok',
            title: action === 'stop' ? '元主运行时已停止' : '元主运行时已启动',
            message: action === 'stop'
              ? '进程已停止（overlay 与数据保留）'
              : `端口 ${body.port ?? '—'} · 隔离 home：${body.sandboxHome ?? '—'}`,
          })
        } else {
          setNotice({ tone: 'bad', title: '元主运行态操作失败', message: failureHint(body?.error || 'runtime-failed'), detail: body?.detail || diagnosticText(result.diagnostic) })
        }
        await refresh()
      }

      // v3.1.30：DEPRECATED —— 打开元主已改为无对话直接启动（见 openEssence）。
      // 保留此函数只为兼容未来可能的多会话入口；元主与派生都不再调用它。
      // 打开前选会话：多选 1–5 个进行中会话（归档会话不出现）。
      function showSessionPicker(sessions, onPick) {
        const doc = document
        const select = h('select', {
          multiple: true, size: 8,
          style: { width: '100%', minHeight: 160, marginTop: 10, font: '12px/1.4 inherit', borderRadius: 8, padding: 6 },
        }, ...sessions.map((session) => h('option', { value: session.sessionId },
          `${session.title || session.sessionId}${session.workspaceTitle ? ' · ' + session.workspaceTitle : ''}`)))
        const hint = h('div', { style: { fontSize: 12, opacity: .7, marginTop: 6 } },
          'Ctrl/⌘ 多选，最多 5 个**进行中**会话；归档会话不会出现在这里。')
        const btn = (label, primary) => h('button', {
          type: 'button',
          style: {
            height: 30, padding: '0 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12,
            border: primary ? '1px solid #17803D' : '1px solid rgba(255,255,255,.24)',
            background: primary ? '#17803D' : 'transparent', color: '#fff',
          },
        }, label)
        const startBtn = btn('启动并导入', true)
        const skipBtn = btn('仅启动', false)
        const cancelBtn = btn('取消', false)
        const card = h('div', {
          role: 'dialog', 'aria-modal': 'true',
          style: { width: 'min(560px, 92vw)', padding: 18, borderRadius: 14, background: '#1D1D1F', color: '#fff' },
        },
        h('div', { style: { fontSize: 14, fontWeight: 600 } }, '打开元主 Web：导入进行中会话'),
        hint,
        select,
        h('div', { style: { display: 'flex', gap: 8, marginTop: 14 } }, startBtn, skipBtn, cancelBtn))
        const backdrop = h('div', {
          style: {
            position: 'fixed', inset: 0, zIndex: 2147483000, display: 'flex',
            alignItems: 'center', justifyContent: 'center', padding: 24, background: 'rgba(0,0,0,.55)',
          },
        }, card)
        const close = () => backdrop.remove()
        startBtn.addEventListener('click', () => {
          const ids = [...(select.selectedOptions || [])].map((option) => option.value)
          if (ids.length > 5) { hint.textContent = '最多选择 5 个会话'; return }
          close()
          onPick(ids)
        })
        skipBtn.addEventListener('click', () => { close(); onPick([]) })
        cancelBtn.addEventListener('click', close)
        backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close() })
        doc.body.appendChild(backdrop)
      }

      function showDerivePicker(sessions, essenceName, onPick) {
        const doc = document
        const select = h('select', {
          size: Math.min(8, Math.max(4, sessions.length)),
          style: { width: '100%', minHeight: 150, marginTop: 10, font: '12px/1.4 inherit', borderRadius: 8, padding: 6 },
        }, ...sessions.map((session) => h('option', { value: session.sessionId },
          `${session.title || session.sessionId}${session.workspaceTitle ? ' · ' + session.workspaceTitle : ''}`)))
        const hint = h('div', { style: { fontSize: 12, opacity: .7, marginTop: 6 } },
          '选择一个进行中的 DSH 会话，整目录复制进新分身的沙箱（归档会话不列出）。')
        const btn = (label, primary) => h('button', {
          type: 'button',
          style: {
            height: 30, padding: '0 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12,
            border: primary ? '1px solid #17803D' : '1px solid rgba(255,255,255,.24)',
            background: primary ? '#17803D' : 'transparent', color: '#fff',
          },
        }, label)
        const startBtn = btn('派 生', true)
        const cancelBtn = btn('取消', false)
        const card = h('div', {
          role: 'dialog', 'aria-modal': 'true',
          style: { width: 'min(560px, 92vw)', padding: 18, borderRadius: 14, background: '#1D1D1F', color: '#fff' },
        },
        h('div', { style: { fontSize: 14, fontWeight: 600 } }, `派生分身 · 基于「${essenceName}」`),
        hint,
        select,
        h('div', { style: { display: 'flex', gap: 8, marginTop: 14 } }, startBtn, cancelBtn))
        const backdrop = h('div', {
          style: {
            position: 'fixed', inset: 0, zIndex: 2147483000, display: 'flex',
            alignItems: 'center', justifyContent: 'center', padding: 24, background: 'rgba(0,0,0,.55)',
          },
        }, card)
        const close = () => backdrop.remove()
        startBtn.addEventListener('click', () => {
          const picked = String(select.value || '')
          if (!picked) { hint.textContent = '请选择一个会话'; return }
          close()
          onPick(picked)
        })
        cancelBtn.addEventListener('click', close)
        backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close() })
        doc.body.appendChild(backdrop)
      }

      /**
       * v3.1.32：绿色「派生新分身」。
       *   1) 自动关联默认元主（开发者推荐的模板）；没有默认则取第一个活跃元主；
       *   2) 弹窗选择一个进行中会话（一次只能导入一个，与服务端 derive 的硬校验一致）。
       */
      async function deriveQuick() {
        if (isBusy()) return
        S.busy = 'derive:quick'
        let essence = null
        try {
          const listed = await api('/fang/api/essence/list')
          const data = listed.body ?? {}
          const essences = Array.isArray(data.essences) ? data.essences.filter((item) => item && item.archived !== true) : []
          const defaultId = String(data.defaultId ?? '')
          essence = essences.find((item) => String(item.id) === defaultId) ?? essences[0] ?? null
        } catch { essence = null }
        S.busy = ''
        if (!essence) {
          setNotice({
            tone: 'warn',
            title: '还没有可用的元主模板',
            message: '先「克隆母体」生成一个元主，或在元主列表里设置默认元主，再派生分身。',
          })
          return
        }
        S.busy = 'derive:quick:sessions'
        const res = await api('/fang/api/sessions?limit=200')
        S.busy = ''
        const sessions = Array.isArray(res.body?.sessions)
          ? res.body.sessions.filter((session) => session.archived !== true)
          : []
        if (sessions.length === 0) {
          setNotice({ tone: 'warn', title: '没有可导入的会话', message: '先在 DSH 里开一个对话，再派生分身。' })
          return
        }
        showDerivePicker(sessions, essence.name || essence.id, async (sessionId) => {
          const session = sessions.find((item) => String(item.sessionId) === String(sessionId))
          const title = String(session?.title || essence.name || '派生分身').slice(0, 60)
          S.busy = 'derive:quick:run'
          const out = await api('/fang/api/tasks/create', {
            method: 'POST',
            body: JSON.stringify({ title, essenceId: essence.id, importSession: { sessionId } }),
          })
          S.busy = ''
          if (out.status === 200 && out.body?.ok) {
            setNotice({
              tone: 'ok',
              title: '已派生分身',
              message: `模板「${essence.name || essence.id}」· 会话 ${short(String(sessionId), 8)}${out.body?.port ? ' · 端口 ' + out.body.port : ''}`,
              actions: out.body?.taskId ? [{ label: '打开分身', onClick: () => void openTask({ taskId: out.body.taskId }) }] : [],
            })
          } else {
            setNotice({
              tone: 'bad',
              title: '派生失败',
              message: failureHint(out.body?.error || 'http-' + out.status),
              detail: out.body?.detail || '',
              actions: [{ label: '重试', onClick: () => void deriveQuick() }],
            })
          }
          await refresh()
        })
      }
      async function deriveFromEssence(essence) {
        if (isBusy()) return
        S.busy = 'essence:derive:' + essence.id
        const res = await api('/fang/api/sessions?limit=200')
        S.busy = ''
        const sessions = Array.isArray(res.body?.sessions)
          ? res.body.sessions.filter((session) => session.archived !== true)
          : []
        if (sessions.length === 0) {
          setNotice({ tone: 'warn', title: '没有可复制的会话', message: '先在 DSH 里有一个进行中的会话，再派生。' })
          return
        }
        showDerivePicker(sessions, essence.name || essence.id, async (sessionId) => {
          const session = sessions.find((item) => String(item.sessionId) === String(sessionId))
          const title = String(session?.title || essence.name || '派生分身').slice(0, 60)
          S.busy = 'essence:derive:run:' + essence.id
          const out = await api('/fang/api/tasks/create', {
            method: 'POST',
            body: JSON.stringify({ title, essenceId: essence.id, importSession: { sessionId } }),
          })
          S.busy = ''
          if (out.status === 200 && out.body?.ok) {
            setNotice({ tone: 'ok', title: '已派生分身', message: `模板「${essence.name || essence.id}」· 会话 ${short(String(sessionId), 8)}` })
          } else {
            setNotice({ tone: 'bad', title: '派生失败', message: failureHint(out.body?.error || 'http-' + out.status), detail: out.body?.detail || '' })
          }
          await refresh()
        })
      }

      async function startEssenceRuntime(essenceId, sessionIds) {
        S.busy = 'essence:start:' + essenceId
        const started = await api('/fang/api/essence/runtime', {
          method: 'POST',
          body: JSON.stringify({ action: 'start', essenceId, sessionIds }),
        })
        S.busy = ''
        if (started.status === 200 && started.body?.ok) {
          const imported = Array.isArray(started.body.importedSessions) ? started.body.importedSessions.length : 0
          setNotice({ tone: 'ok', title: '元主 Web 已启动', message: `端口 ${started.body.port ?? '—'} · 导入会话 ${imported} 个` })
          if (started.body.url) { try { window.open(String(started.body.url), '_blank', 'noopener') } catch { /* 弹层被拦 */ } }
        } else {
          setNotice({ tone: 'bad', title: '启动元主 Web 失败', message: failureHint(started.body?.error || 'runtime-failed'), detail: started.body?.detail || '' })
        }
        await refresh()
      }

      // 打开&设置：已在跑 → 直接开带 token 的 URL；没跑 → **无对话直接启动**再打开。
      // v3.1.30：元主 Web 本身不允许会话（会话按钮与工作区已隐藏），
      // 因此打开元主时不再要求/提示导入进行中会话——「导入一个会话」只属于派生分身。
      async function openEssence(essenceId) {
        if (isBusy()) return
        S.busy = 'essence:open:' + essenceId
        const st = await api(`/fang/api/essence/runtime?essenceId=${encodeURIComponent(essenceId)}`)
        const runtime = st.body?.runtime ?? null
        const running = Boolean(runtime && (runtime.running === true || String(runtime.status) === 'running'))
        S.busy = ''
        if (running) {
          const opened = await api(`/fang/api/essence/runtime/open?essenceId=${encodeURIComponent(essenceId)}`)
          if (opened.status === 200 && opened.body?.url) { try { window.open(String(opened.body.url), '_blank', 'noopener') } catch { /* 弹层被拦 */ } }
          else setNotice({ tone: 'bad', title: '无法打开元主 Web', message: '实例在跑但拿不到带 token 的地址' })
          return
        }
        // 直接启动：不导入任何会话（元主是「插件控制台」，不是对话工作区）。
        void startEssenceRuntime(essenceId, [])
      }

      async function copyEssence(essence) {
        if (isBusy()) return
        askPrompt({
          title: '复制元主', label: '新元主名称', value: `${essence.name || essence.id} 副本`, confirmLabel: '复制',
          hint: '深复制该元主的整份沙盒目录（overlay + merged + 自定义数据）到新文件夹；不复制凭据、运行态与备份。',
          onConfirm: async (name) => {
            const trimmed = String(name ?? '').trim()
            if (!trimmed) { S.modal.error = '请填写名称'; render(true); return false }
            const result = await api('/fang/api/essence/copy', { method: 'POST', body: JSON.stringify({ essenceId: essence.id, name: trimmed }) })
            if (result.status === 200 && result.body?.ok) setNotice({ tone: 'ok', title: '元主已复制', message: trimmed })
            else setNotice({ tone: 'bad', title: '复制失败', message: failureHint(result.body?.error || 'http-' + result.status) })
            await refresh()
          },
        })
      }

      function archiveEssence(essence) {
        if (isBusy()) return
        askConfirm({
          tone: 'info', title: '归档元主？', confirm: 'essence-archive',
          message: `「${essence.name || essence.id}」将归档：只改元数据，不删目录；归档后不能派生/配置。`,
          confirmLabel: '归档',
          onConfirm: async () => {
            const result = await api('/fang/api/essence/archive', { method: 'POST', body: JSON.stringify({ essenceId: essence.id, archived: true }) })
            if (result.status === 200 && result.body?.ok) setNotice({ tone: 'ok', title: '元主已归档', message: essence.name || essence.id })
            else setNotice({ tone: 'bad', title: '归档失败', message: failureHint(result.body?.error || 'http-' + result.status) })
            await refresh()
          },
        })
      }

      async function stopEssenceRuntime(essence) {
        if (isBusy()) return
        S.busy = 'essence:stop'
        const result = await api('/fang/api/essence/runtime', { method: 'POST', body: JSON.stringify({ action: 'stop', essenceId: essence.id }) })
        S.busy = ''
        if (result.status === 200 && result.body?.ok) setNotice({ tone: 'ok', title: '运行实例已停止', message: essence.name || essence.id })
        else setNotice({ tone: 'bad', title: '停止失败', message: failureHint(result.body?.error || 'http-' + result.status), detail: result.body?.detail || '' })
        await refresh()
      }

      async function openBranches(task) {
        if (isBusy()) return
        S.busy = 'branches:' + task.taskId
        const res = await api('/fang/api/tasks/branches?taskId=' + encodeURIComponent(task.taskId))
        S.busy = ''
        const body = res.body ?? {}
        S.modal = {
          kind: 'branches',
          taskId: task.taskId,
          taskTitle: task.title || task.taskId,
          sessionId: body.sessionId ?? '',
          activeBranchId: body.activeBranchId ?? '',
          branches: Array.isArray(body.branches) ? body.branches : [],
          error: res.status === 200 && body.ok === true ? '' : failureHint(body.error || 'http-' + res.status),
        }
        render(true)
      }

      async function forkBranch(task) {
        if (isBusy()) return
        S.busy = 'branch-fork:' + task.taskId
        const res = await api('/fang/api/tasks/branches/fork', { method: 'POST', body: JSON.stringify({ taskId: task.taskId }) })
        S.busy = ''
        if (res.status === 200 && res.body?.ok) {
          setNotice({ tone: 'ok', title: '已派生分支', message: res.body.branch?.branchId || '' })
          await openBranches(task)
        } else {
          setNotice({ tone: 'bad', title: '派生分支失败', message: failureHint(res.body?.error || 'http-' + res.status), detail: res.body?.detail || '' })
          render(true)
        }
      }

      async function activateBranch(task, branchId) {
        if (isBusy()) return
        S.busy = 'branch-activate:' + task.taskId
        const res = await api('/fang/api/tasks/branches/activate', { method: 'POST', body: JSON.stringify({ taskId: task.taskId, branchId }) })
        S.busy = ''
        if (res.status === 200 && res.body?.ok) setNotice({ tone: 'ok', title: '已激活分支', message: branchId })
        else setNotice({ tone: 'bad', title: '激活分支失败', message: failureHint(res.body?.error || 'http-' + res.status) })
        await openBranches(task)
      }

      function unfreezeEssence(essence) {
        if (isBusy()) return
        askConfirm({
          tone: 'info', title: '还原（解冻）元主？', confirm: 'essence-unfreeze',
          message: `「${essence.name || essence.id}」将从冻结态恢复为活跃：可打开/设置/派生；备份内容不变，删除仍可用。`,
          confirmLabel: '还原',
          onConfirm: async () => {
            S.busy = 'essence:unfreeze'
            const result = await api('/fang/api/essence/archive', { method: 'POST', body: JSON.stringify({ essenceId: essence.id, archived: false }) })
            S.busy = ''
            if (result.status === 200 && result.body?.ok) setNotice({ tone: 'ok', title: '元主已还原（解冻）', message: essence.name || essence.id })
            else setNotice({ tone: 'bad', title: '还原失败', message: failureHint(result.body?.error || 'http-' + result.status), detail: result.body?.detail || '' })
            await refresh()
          },
        })
      }

      function deleteEssence(essence) {
        if (isBusy()) return
        if (essence.archived !== true) {
          setNotice({ tone: 'warn', title: '需先归档才能删除', message: '元主必须先归档（冻结）后，删除按钮才可用。' })
          return
        }
        // 两次确认：第一次说明后果，第二次必须输入元主名称。
        askConfirm({
          tone: 'bad', title: '删除元主？', confirm: 'delete-once',
          message: `「${essence.name || essence.id}」已冻结。删除会移除 essences/${essence.id}（overlay + merged），不可撤销，也不会删除会话。`,
          confirmLabel: '继续',
          onConfirm: () => {
            askConfirm({
              tone: 'bad', title: '再次确认：永久删除', confirm: 'delete', strong: true,
              expected: String(essence.name || essence.id),
              message: `最后一步：输入「${essence.name || essence.id}」以永久删除该元主。`,
              confirmLabel: '永久删除',
              onConfirm: async () => {
                S.busy = 'essence:delete:' + essence.id
                const result = await api('/fang/api/essence/delete', { method: 'POST', body: JSON.stringify({ essenceId: essence.id }) })
                S.busy = ''
                if (result.status === 200 && result.body?.ok) setNotice({ tone: 'ok', title: '元主已删除', message: essence.name || essence.id })
                else setNotice({ tone: 'bad', title: '删除元主失败', message: failureHint(result.body?.error || 'http-' + result.status), detail: result.body?.detail || '' })
                await refresh()
              },
            })
          },
        })
      }

      async function saveBlob(blob, suggestedName) {
        try {
          if (typeof window.showSaveFilePicker === 'function') {
            const handle = await window.showSaveFilePicker({
              suggestedName,
              types: [{ description: '元主整包', accept: { 'application/json': ['.json'] } }],
            })
            const writable = await handle.createWritable()
            await writable.write(blob)
            await writable.close()
            return { ok: true, mode: 'picker' }
          }
        } catch (error) {
          if (String(error?.name) === 'AbortError') return { ok: false, aborted: true }
        }
        const link = h('a', { href: URL.createObjectURL(blob), download: suggestedName })
        document.body.appendChild(link)
        link.click()
        link.remove()
        return { ok: true, mode: 'download' }
      }

      async function downloadEssence(essence) {
        try {
          const token = await ensureFangAuthToken()
          const res = await fetch(`/fang/api/essence/download?essenceId=${encodeURIComponent(essence.id)}&full=1`, {
            headers: token ? { 'x-fang-auth': token } : {},
          })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          const blob = await res.blob()
          const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
          const name = `essence-${String(essence.name || essence.id).replace(/[\\/:*?"<>|\s]+/g, '-')}-${stamp}.json`
          const saved = await saveBlob(blob, name)
          if (saved.aborted) return
          setNotice({
            tone: 'ok',
            title: '元主整包已下载',
            message: `${name}（${Math.round(blob.size / 1024)} KB）`,
            detail: saved.mode === 'picker' ? '已保存到你选择的文件夹；包内含 IMPORT-GUIDE.md 与 manifest.json。' : '已保存到下载目录；包内含导入引导与清单。',
          })
        } catch (error) {
          setNotice({ tone: 'bad', title: '下载元主失败', message: String(error?.message ?? error) })
        }
      }

      async function essenceBackup(essence) {
        const result = await api('/fang/api/essence/backup', { method: 'POST', body: JSON.stringify({ essenceId: essence.id }) })
        if (result.status === 200 && result.body?.ok) setNotice({ tone: 'ok', title: '元主已备份', message: `Backup/ · ${Math.round((result.body.bytes || 0) / 1024)} KB（只保留一份）` })
        else setNotice({ tone: 'bad', title: '备份失败', message: failureHint(result.body?.error || 'backup-failed'), detail: result.body?.detail || '' })
        await refresh()
      }

      async function essenceRestore(essence) {
        if (isBusy()) return
        askConfirm({
          tone: 'info', title: '还原最新备份？', confirm: 'essence-restore',
          message: `用「${essence.name || essence.id}/Backup」覆盖当前 overlay 与 merged，还原后需重新同步/派生。`,
          confirmLabel: '还原',
          onConfirm: async () => {
            const result = await api('/fang/api/essence/restore', { method: 'POST', body: JSON.stringify({ essenceId: essence.id }) })
            if (result.status === 200 && result.body?.ok) setNotice({ tone: 'ok', title: '已还原最新备份', message: essence.name || essence.id })
            else setNotice({ tone: 'bad', title: '还原失败', message: failureHint(result.body?.error || 'restore-failed'), detail: result.body?.detail || '' })
            await refresh()
          },
        })
      }

      function essenceImport() {
        const input = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } })
        input.addEventListener('change', async () => {
          const file = input.files?.[0]
          input.remove()
          if (!file) return
          try {
            const bundle = JSON.parse(await file.text())
            S.busy = 'essence:import'
            const result = await api('/fang/api/essence/import', { method: 'POST', body: JSON.stringify({ bundle }) })
            S.busy = ''
            if (result.status === 200 && result.body?.ok) setNotice({ tone: 'ok', title: '元主已导入', message: `${result.body.essence?.name || '导入的元主'} · ${result.body.files} 个文件` })
            else setNotice({ tone: 'bad', title: '导入失败', message: failureHint(result.body?.error || 'import-failed'), detail: result.body?.detail || '' })
            await refresh()
          } catch (error) {
            S.busy = ''
            setNotice({ tone: 'bad', title: '导入失败', message: String(error?.message ?? error) })
          }
        })
        document.body.appendChild(input)
        input.click()
      }

      // 单个元主详情页：设置 / 插件 / 运行日志 三个 tab。
      async function loadEssenceDetail() {
        const modal = S.modal
        if (!modal || modal.kind !== 'essence') return
        const result = await api(`/fang/api/essence/detail?essenceId=${encodeURIComponent(modal.essenceId)}`)
        if (!S.modal || S.modal !== modal) return
        modal.loading = false
        if (result.status === 200 && result.body?.ok) modal.detail = result.body
        else modal.error = result.body?.error || 'http-' + result.status
        render(true)
      }

      function openEssenceDetail(essence) {
        lockScroll()
        S.modal = { kind: 'essence', essenceId: essence.id, tab: 'settings', detail: null, loading: true, error: '' }
        render(true)
        void loadEssenceDetail()
      }

      async function openTask(task) {
        const taskId = String(task?.taskId ?? '')
        if (!taskId) { notify('warn', '该分身没有 taskId，无法打开。'); return }
        const result = await api(`/fang/api/tasks/open-url?taskId=${encodeURIComponent(taskId)}`)
        if (result.status === 200 && result.body?.url) {
          try { window.open(result.body.url, '_blank', 'noopener'); return } catch { /* 弹层被拦 */ }
        }
        const code = result.body?.error || (result.status ? 'http-' + result.status : 'network')
        if (code === 'not-running') {
          notify('warn', '分身已停止，正在启动…')
          let restored = await api('/fang/api/tasks/restore', { method: 'POST', body: JSON.stringify({ taskId }) })
          // A stopped (but not archived) fork cannot be restored directly; archive it
          // first (keeps home), then restore spawns from the same home.
          if (restored.body?.error === 'not-archived' && String(task?.status || '') !== 'running') {
            const archived = await api('/fang/api/tasks/archive', { method: 'POST', body: JSON.stringify({ taskId }) })
            if (archived.status === 200 && archived.body?.ok !== false) {
              restored = await api('/fang/api/tasks/restore', { method: 'POST', body: JSON.stringify({ taskId }) })
            }
          }
          if (restored.status !== 200 || restored.body?.ok === false) {
            notify('bad', `启动分身失败：${restored.body?.error || 'restore-failed'}`)
            return
          }
          for (let i = 0; i < 20; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 800))
            const retry = await api(`/fang/api/tasks/open-url?taskId=${encodeURIComponent(taskId)}`)
            if (retry.status === 200 && retry.body?.url) {
              try { window.open(retry.body.url, '_blank', 'noopener'); return } catch { /* 弹层被拦 */ }
            }
          }
          notify('warn', '分身已启动，但 Web URL 尚未就绪；稍后点“打开”再试。')
          return
        }
        notify('bad', `打开分身失败：${code}`)
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
          const conflict = error?.conflict ? String(error.conflict) : ''
          if (conflict) {
            // 409：保留 draft，允许用户改名后重试，不静默丢弃输入
            S.editing = { ...editing, value, busy: false }
            notify('bad', `名称已被其他客户端改为「${conflict}」；可修改后重试`)
            announce('名称冲突，已保留草稿', 'assertive')
            S.lastAliasError = String(error?.conflict ?? 'conflict')
            render(true)
            window.requestAnimationFrame(() => {
              const input = view.querySelector('[data-edit-input]')
              if (input) { input.focus(); input.select() }
            })
            return
          }
          S.editing = null
          notify('bad', `重命名失败，已恢复「${editing.original}」`)
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

      async function decideApproval(item, outcome) {
        if (isBusy()) return
        const key = `${item?.source ?? ''}:${item?.taskId ?? ''}:${item?.approvalId ?? ''}`
        S.busy = 'approval:' + key
        schedule(true)
        const result = await api('/fang/api/approvals/decide', {
          method: 'POST',
          body: JSON.stringify({
            source: item?.source,
            taskId: item?.taskId ?? null,
            approvalId: item?.approvalId,
            outcome,
            by: 'fang-ui',
          }),
        })
        S.busy = ''
        if (result.status === 200 && result.body?.ok !== false) {
          setNotice({
            tone: 'ok',
            title: outcome === 'approved' ? '已批准' : '已拒绝',
            message: `${item?.source === 'mother' ? '母体' : '分身'} · ${item?.title || item?.approvalId || ''}`,
          })
        } else if (result.status === 409) {
          setNotice({ tone: 'warn', title: '已被处理', message: '该审批项已结算或不存在，列表将刷新。' })
        } else {
          setNotice({
            tone: 'bad',
            title: '审批操作失败',
            message: failureHint(result.body?.error || (result.status ? 'http-' + result.status : 'network')),
            detail: diagnosticText(result.diagnostic),
          })
        }
        await refresh({ manual: true })
      }

      async function decisionAction(ticket, action, option) {
        if (isBusy()) return
        const key = `decision:${ticket?.id ?? ''}`
        S.busy = key
        schedule(true)
        const path = action === 'abandon' ? '/fang/api/decisions/abandon' : '/fang/api/decisions/resolve'
        const result = await api(path, {
          method: 'POST',
          body: JSON.stringify({ id: ticket?.id, option, by: 'fang-ui' }),
        })
        S.busy = ''
        if (result.status === 200 && result.body?.ok !== false) {
          setNotice({ tone: 'ok', title: action === 'abandon' ? '已放弃' : '已处理', message: ticket?.title || ticket?.id || '' })
        } else if (result.status === 409) {
          setNotice({ tone: 'warn', title: '已被处理', message: '该决策已结算或过期，列表将刷新。' })
        } else {
          setNotice({ tone: 'bad', title: '决策操作失败', message: failureHint(result.body?.error || (result.status ? 'http-' + result.status : 'network')) })
        }
        await refresh({ manual: true })
      }

      async function decisionBatch(level) {
        if (isBusy()) return
        const items = (S.decisions?.items ?? []).filter((item) => item.status === 'pending' && item.level === level)
        if (!items.length) return
        S.busy = `decision-batch:${level}`
        schedule(true)
        const result = await api('/fang/api/decisions/resolve', {
          method: 'POST',
          body: JSON.stringify({ ids: items.map((item) => item.id), by: 'fang-ui' }),
        })
        S.busy = ''
        if (result.status === 200 && result.body?.ok !== false) {
          setNotice({ tone: 'ok', title: '已批量处理', message: `${level} · ${items.length} 项` })
        } else {
          setNotice({ tone: 'bad', title: '批量处理失败', message: failureHint(result.body?.error || 'http-' + result.status) })
        }
        await refresh({ manual: true })
      }

      async function saveDecisionAi() {
        const read = (name) => String(view.querySelector(`[data-ai-field="${name}"]`)?.value ?? '').trim()
        const provider = read('provider') || 'deepseek'
        const apiKey = read('apiKey')
        const model = read('model')
        const baseUrl = read('baseUrl')
        if (!apiKey) { setNotice({ tone: 'warn', title: '需要 API Key', message: '请填入你自己的模型 API Key；只保存在宿主内存，不写入仓库。' }); return }
        const result = await api('/fang/api/decisions/ai/config', {
          method: 'POST',
          body: JSON.stringify({ provider, apiKey, model: model || undefined, baseUrl: baseUrl || undefined }),
        })
        if (result.status === 200 && result.body?.ok !== false) {
          setNotice({ tone: 'ok', title: 'AI 已启用', message: `${result.body.provider || provider} · ${result.body.model || model}` })
        } else {
          setNotice({ tone: 'bad', title: 'AI 配置失败', message: failureHint(result.body?.error || result.body?.reason || 'http-' + result.status) })
        }
        await refresh({ manual: true })
      }

      async function adviseDecision(ticket) {
        if (isBusy()) return
        S.busy = `decision-ai:${ticket?.id ?? ''}`
        schedule(true)
        const result = await api('/fang/api/decisions/ai/advise', { method: 'POST', body: JSON.stringify({ id: ticket?.id }) })
        S.busy = ''
        if (result.status === 200 && result.body?.ok !== false) {
          setNotice({ tone: 'ok', title: 'AI 建议已生成', message: result.body.advice?.summary || ticket?.title || '' })
        } else {
          setNotice({ tone: 'bad', title: 'AI 建议失败', message: failureHint(result.body?.error || result.body?.reason || 'http-' + result.status) })
        }
        await refresh({ manual: true })
      }

      async function setForkSupervision(patch = {}) {
        const res = await api('/fang/api/forks/supervision', { method: 'POST', body: JSON.stringify(patch) })
        if (res.status === 200 && res.body?.ok) {
          S.forkSupervision = { state: 'ready', data: res.body, error: '', at: Date.now() }
          setNotice({ tone: 'ok', title: '分身看护已更新', message: `自动启动 ${res.body.effective?.autostartForks ? '开' : '关'} · 崩溃重启 ${res.body.effective?.supervise ? '开' : '关'}` })
        } else {
          S.forkSupervision = {
            ...S.forkSupervision, state: 'error',
            error: res.body?.error || (res.status ? 'http-' + res.status : 'network'), at: Date.now(),
          }
          setNotice({ tone: 'bad', title: '分身看护更新失败', message: failureHint(S.forkSupervision.error) })
        }
        schedule(true)
        return res
      }

      const app = {
        state: S, view, render, schedule, refresh, deriveTask, openMother, closeModal,
        archiveTask, restoreTask, deleteArchive, promoteTask, openTask, copyText, captureEssence,
        cloneMotherProfile, syncEssence, syncEssences, setSessionWindow, essenceRuntime,
        decideApproval,
        setForkSupervision,
        decisionAction,
        decisionBatch,
        saveDecisionAi,
        adviseDecision,
        openEssence, copyEssence, archiveEssence, deleteEssence, downloadEssence, essenceImport,
        essenceBackup, essenceRestore, openEssenceDetail, unfreezeEssence, stopEssenceRuntime,
        openBranches, forkBranch, activateBranch, deriveFromEssence, deriveQuick,
        beginRename, commitRename, cancelRename, selectSession, toggleSet, toggleForkGroup,
        toggleTemporary, setView: (next) => { S.view = next; schedule(true) },
        loadForkSessions, loadMirror, mirrorAction, loadLink, probeMother, notify, announce,
        backupMother: () => mirrorAction('backup', async () => (await api('/fang/api/mirror/backup', {
          method: 'POST', body: JSON.stringify({ bucket: 'restore', label: '手动备份' }),
        })).body),
        diagnostics: {
          list: () => diagLog.slice(-3000),
          push: (level, message, detail) => diag(level, message, detail),
          clear: () => { diagLog.length = 0; try { window.dispatchEvent(new CustomEvent('fang:diag')) } catch { /* ignore */ } },
        },
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
          window.removeEventListener('fang:notice', onFangNotice)
          window.removeEventListener('fang:mother-portal', onMotherPortal)
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
      }, leading, opts.iconOnly ? null : label, opts.spin ? icon('spinner', 13) : null, trailing)
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
      const restart = data?.restart
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
        item('neutral', '母体', '1', '母体只读：控制台只读会话元数据，不写入、不改写母体会话。'),
        h('span', { class: 'stat-sep', 'aria-hidden': 'true' }),
        item('neutral', '元主', String(S.essenceList?.data?.essences?.length ?? '—'), '元主数量（来自 /fang/api/essence/list）'),
        h('span', { class: 'stat-sep', 'aria-hidden': 'true' }),
        item('neutral', '分身', String(S.tasks.items.filter((task) => String(task.status) !== 'archived').length), '当前未归档分身数量（来自 /fang/api/tasks）'),
        h('span', { class: 'stat-sep', 'aria-hidden': 'true' }),
        item(ready > 0 ? 'ok' : 'neutral', '就绪', data ? `${ready}/${max}` : '—', `适配器已握手的分身 ${ready} 个 / 上限 ${max} 个。`),
        h('span', { class: 'stat-sep', 'aria-hidden': 'true' }),
        item(running > 0 ? 'bad' : 'neutral', '未握手', data ? String(running) : '—', `进程在跑但适配器未握手的分身 ${running} 个；大于 0 时按三色模型标红。`),
        ...(restart?.available ? [
          h('span', { class: 'stat-sep', 'aria-hidden': 'true' }),
          item(
            restart.redLineAutoAllowed ? 'bad' : (restart.state && restart.state !== 'idle' ? 'warn' : 'neutral'),
            '重启守卫',
            restart.mode ? String(restart.mode) : '—',
            `重启守卫：state=${restart.state ?? '—'} · mode=${restart.mode ?? '—'} · authMode=${restart.authMode ?? '—'} · strictRedLine=${restart.strictRedLine === false ? 'false（红灯可自动放行）' : 'true'} · 决策层不执行`,
          ),
        ] : []),
        total > 0 ? h('span', { class: 'stat-sep', 'aria-hidden': 'true' }) : null,
        total > 0 ? item('neutral', '项目', String(total), `当前分身项目总数 ${total}（含临时与存档）。`) : null)
    }

    function renderSlotStrip(cap) {
      const limit = Math.max(0, Math.min(7, Number(cap?.limit ?? 5)))
      const slots = []
      for (let index = 0; index < 7; index += 1) {
        const enabled = index < limit
        slots.push(h('span', {
          class: 'slot', role: 'listitem', 'data-slot': String(index),
          'data-enabled': enabled ? 'true' : 'false',
          ...(enabled ? {} : { 'data-reason': '超出当前配额（锁定）' }),
          title: enabled ? `槽位 ${index + 1}` : `槽位 ${index + 1}：超出当前配额，锁定`,
          style: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: '18px', height: '18px', marginRight: '2px', borderRadius: '5px',
            fontSize: '10px', border: '1px solid var(--f-border)',
            opacity: enabled ? '1' : '.45',
          },
        }, String(index + 1)))
      }
      return h('div', {
        class: 'slot-strip', 'data-zone': 'slots', role: 'list', 'aria-label': '分身槽位',
        style: { display: 'inline-flex', alignItems: 'center', marginLeft: '4px' },
      }, ...slots)
    }

    function toggleMotherPalette(anchor, app) {
      const host = anchor?.parentElement
      if (!host) return
      const existing = host.querySelector('[data-zone="palette"]')
      if (existing) { existing.remove(); return }
      const palette = h('div', {
        class: 'mother-palette', 'data-zone': 'palette', role: 'menu',
        style: {
          position: 'absolute', right: '0', top: 'calc(100% + 6px)', zIndex: '40',
          display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px',
          minWidth: '190px', background: 'var(--f-surface)', border: '1px solid var(--f-border)',
          borderRadius: '12px', boxShadow: '0 12px 32px rgba(0,0,0,.18)',
        },
      },
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-btn-id': 'mother-open', onClick: () => openMotherPortal() }, '打开母体 Web'),
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-btn-id': 'mother-backup', onClick: () => app.backupMother() }, '备份当前母体'))
      host.style.position = 'relative'
      host.appendChild(palette)
      if (!window.__fangPaletteEsc) {
        window.__fangPaletteEsc = true
        document.addEventListener('keydown', (event) => {
          if (event.key !== 'Escape') return
          document.querySelectorAll('[data-zone="palette"]').forEach((node) => node.remove())
        })
      }
      palette.querySelector('button')?.focus()
    }

    function renderHeader(S, app) {
      const data = S.status.data
      const restart = data?.restart
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
          restart?.available && restart.redLineAutoAllowed
            ? chip('warn', '红灯自动放行', {
              title: 'strictRedLine=false：auto 授权模式下红灯可被策略自动放行。这只到决策层；execution.executed 恒为 false，真正重启仍由外部 supervisor 的 armed 清单决定。',
              state: 'red-line-auto-allowed',
              danger: true,
            })
            : null,
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
          button('收件箱', {
            variant: 'ghost', size: 'sm', icon: icon('inbox', 14),
            title: '决策收件箱：独立抽屉；红/黄/蓝/绿/灰分组、未读计数、键盘导航与批量处理',
            onClick: () => openInboxExternally?.(), fk: 'inbox', dataBtnId: 'M-06',
          }),
          button('刷新', {
            variant: 'ghost', size: 'sm', icon: icon('refresh', 14), busy: S.refreshing,
            title: '重新读取母体状态、分身任务与母体会话', onClick: () => void app.refresh({ manual: true }), fk: 'refresh', dataBtnId: 'M-03',
          }),
          (() => {
            const motherButton = button('Mother', {
              variant: 'ghost', size: 'sm', icon: icon('globe', 14),
              title: '母体浮窗：版本、备份、升级与连接自检（只读优先，写操作均二次确认）',
              onClick: (event) => toggleMotherPalette(event?.currentTarget, app),
              fk: 'mother', dataBtnId: 'M-04',
            })
            motherButton.addEventListener('dblclick', (event) => {
              event.preventDefault()
              openMotherPortal()
            })
            return motherButton
          })(),
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
              // v3.1.32：绿色按钮 = 默认元主 + 选一个进行中会话（不再直接发无会话请求）
              void app.deriveQuick()
            },
            fk: 'derive',
          })),
        version ? h('span', { class: 'fh-version', title: '母体版本' }, version) : null)
    }

    // ── 全局提示（派生结果 / 动作结果 / 接口错误）───────────────────────────
    // 待批区：只读母体聚合接口；不直接跨 fork adapter
    // 瓮城·决策中心：注意力分级面板。红色置顶；绿/灰默认折叠；所有操作等接口返回。
    function renderApprovals(S, app) {
      const state = S.approvals || { state: 'idle', items: [], failed: [], degraded: false, error: '' }
      if (state.state === 'error' && state.items.length === 0) {
        return [h('div', { class: 'notice notice--warn', role: 'status' },
          h('div', { class: 'notice-main' },
            h('div', { class: 'notice-title' }, icon('alert', 14), '待批信息不可用'),
            h('div', { class: 'notice-text' }, failureHint(state.error || 'network'))))]
      }
      if (state.items.length === 0 && state.failed.length === 0) return []
      const toneOf = (risk) => risk === 'red' ? 'bad' : risk === 'yellow' ? 'warn' : risk === 'blue' ? 'info' : 'ok'
      const ttlText = (deadlineAt) => {
        const at = Number(deadlineAt)
        if (!Number.isFinite(at) || at <= 0) return '无期限'
        const left = at - Date.now()
        if (left <= 0) return '已到期'
        const seconds = Math.ceil(left / 1000)
        return seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)}m`
      }
      const rows = state.items.map((item) => {
        const key = `${item.source}:${item.taskId ?? ''}:${item.approvalId}`
        const busy = S.busy === 'approval:' + key
        const orphaned = item.state === 'orphaned'
        return h('div', {
          class: 'notice', role: 'listitem', 'data-approval-key': key, 'data-approval-state': item.state,
          style: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', marginTop: 4 },
        },
        chip(toneOf(item.risk), item.source === 'mother' ? '母体' : '分身'),
        h('div', { class: 'notice-main', style: { minWidth: 0, flex: 1 } },
          h('div', { class: 'notice-title', style: { fontSize: 13 } }, clampText(item.title) || item.approvalId || '未命名审批'),
          h('div', { class: 'notice-text', style: { fontSize: 12 } },
            `${item.kind || 'approval'} · ${orphaned ? '已中断（重启前）' : '剩余 ' + ttlText(item.deadlineAt)}${item.taskId ? ' · ' + short(item.taskId, 10) : ''}`)),
        orphaned ? null : button('批准', {
          size: 'sm', variant: 'primary', busy,
          disabled: busy,
          onClick: () => void app.decideApproval(item, 'approved'),
        }),
        orphaned ? null : button('拒绝', {
          size: 'sm', variant: 'ghost', busy,
          disabled: busy,
          onClick: () => void app.decideApproval(item, 'denied'),
        }))
      })
      return [h('div', {
        class: 'notice notice--info', role: 'region', 'aria-label': '待批事项',
        'data-zone': 'approvals', style: { padding: '8px 10px' },
      },
      h('div', { class: 'notice-main' },
        h('div', { class: 'notice-title' }, icon('alert', 14), `待批 ${state.items.length}`,
          state.failed.length > 0 ? h('span', { class: 'chip', title: '部分来源不可用；不显示假 pending' }, '部分不可用') : null),
        state.failed.length > 0
          ? h('div', { class: 'notice-text' }, `前端不可用：${state.failed.map((entry) => entry.taskId || '母体').join('、')}`)
          : null,
        h('div', { role: 'list', style: { marginTop: 4 } }, ...rows)))]
    }

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

    /**
     * 元宝卡片：一个独立方框，两行信息（名称 / 生成+同步时间），操作图标收在第二行右侧。
     */
    function renderEssenceCard(S, app, essence, defaultEssenceId) {
      const name = essence.name || essence.id
      const created = Number(essence.createdAt) > 0 ? fmtClock(essence.createdAt) : '—'
      const synced = Number(essence.lastSyncAt ?? essence.lastMergedAt) > 0
        ? fmtClock(essence.lastSyncAt ?? essence.lastMergedAt)
        : '从未'
      const action = (label, iconName, options = {}) => button(label, {
        size: 'sm', variant: 'ghost', iconOnly: true, icon: icon(iconName, 12),
        ariaLabel: label, title: options.title || label, dataBtnId: options.dataBtnId,
        disabled: options.disabled, fk: options.fk, onClick: options.onClick,
      })
      const actions = [
        essence.stale && essence.locked !== true
          ? action('同步', 'refresh', { dataBtnId: 'E-03', title: '重放该元主的插件/设置到新母体（配置不变）', onClick: () => void app.syncEssence(essence.id) })
          : null,
        essence.archived === true ? null : action('派生', 'plus', { dataBtnId: 'E-05', title: '派生：以该元主为模板创建分身', onClick: () => void app.deriveFromEssence(essence) }),
        essence.archived === true
          ? action('还原', 'refresh', { dataBtnId: 'E-15', title: '解冻（恢复活跃态），不还原备份内容', onClick: () => void app.unfreezeEssence(essence) })
          : action(essence.runtime?.running === true ? '停止' : '打开', essence.runtime?.running === true ? 'disc' : 'play', {
            dataBtnId: 'E-06',
            title: essence.runtime?.running === true ? '停止该元主的运行实例' : '打开&设置：启动隔离配置态实例',
            onClick: () => essence.runtime?.running === true ? void app.stopEssenceRuntime(essence) : void app.openEssence(essence.id),
          }),
        essence.runtime?.running === true && essence.archived !== true
          ? action('进入', 'external', { dataBtnId: 'E-21', title: '在新标签打开运行中的实例', onClick: () => void app.openEssence(essence.id) })
          : null,
        essence.archived === true
          ? null
          : action('复制', 'copy', { dataBtnId: 'E-07', title: '深复制整份沙盒到新文件夹（不含凭据/备份）', disabled: essence.actions?.copy?.enabled === false, onClick: () => void app.copyEssence(essence) }),
        essence.archived === true
          ? null
          : action('归档', 'archive', { dataBtnId: 'E-08', title: '归档元主（冻结，只改元数据）', disabled: essence.actions?.archive?.enabled === false, onClick: () => void app.archiveEssence(essence) }),
        action('删除', 'trash', { dataBtnId: 'E-09', title: '永久删除 essences/<id>（须先归档；不删会话）', disabled: essence.actions?.delete?.enabled === false, onClick: () => void app.deleteEssence(essence) }),
        essence.archived === true
          ? null
          : action('备份', 'disc', { dataBtnId: 'E-12', title: '在 essences/<id>/Backup 存档（只保留一份）', onClick: () => void app.essenceBackup(essence) }),
        essence.archived === true
          ? null
          : action('还原备份', 'refresh', { dataBtnId: 'E-13', title: '用最新 Backup 覆盖当前 overlay/merged（需二次确认）', onClick: () => void app.essenceRestore(essence) }),
        essence.archived === true
          ? null
          : action('下载', 'download', { dataBtnId: 'E-10', title: '下载元主整包 JSON（不含凭据）', disabled: essence.actions?.download?.enabled === false, onClick: () => void app.downloadEssence(essence) }),
      ].filter(Boolean)

      return h('div', { class: 'essence-card', 'data-essence-id': essence.id, role: 'listitem' },
        h('div', { class: 'essence-card-head' },
          h('span', { class: 'essence-card-name' },
            essence.locked
              ? h('span', { title: name }, name)
              : editableText(S, app, { key: 'essence:' + essence.id, label: '元主', value: name })),
          essence.id === defaultEssenceId ? chip('info', '默认', { dot: false }) : null,
          essence.locked ? chip('neutral', '锁定', { dot: false }) : null,
          essence.stale ? chip('warn', '🔼 待同步', { dot: false, title: '母体镜像已变化，此元主仍在旧镜像上' }) : null,
          essence.status === 'conflicted' ? chip('bad', '冲突', { dot: false }) : null,
          essence.archived === true ? chip('neutral', '冻结', { dot: false, title: '已归档（冻结）：只能还原或删除' }) : null),
        h('div', { class: 'essence-card-meta' },
          h('span', { class: 'essence-card-times' },
            h('span', null, `生成 ${created}`),
            h('span', { title: '最后一次与母体同步时间' }, `同步 ${synced}`)),
          h('span', { style: { flex: '1' } }),
          h('div', { class: 'essence-card-actions' }, ...actions)))
    }

    function renderMotherPanel(S, app) {
      const freshness = freshnessOf(S)
      const all = S.sessions.items
      const query = S.query.trim().toLowerCase()
      const filtered = query ? all.filter((session) => sessionSearchText(session).includes(query)) : all
      // 空会话（无用户消息）不进列表：它们没有任何内容可看。
      const visible = filtered.filter((session) => session?.empty !== true)
      const groups = groupMotherWorkspaces(visible, S.aliases)
      const split = classifyMotherSessions(visible)
      const selected = all.find((session) => String(session.sessionId) === S.selectedSessionId) || null
      const countText = query
        ? `${visible.length}/${all.length}`
        : `${visible.length}${S.sessions.total > all.length ? '/' + S.sessions.total : ''}`
      const sessionState = S.sessions.state

      const head = h('div', { class: 'panel-head' },
        h('div', { class: 'panel-title-row' },
          h('h2', { class: 'panel-title' }, '母体'),
          h('span', { class: 'panel-sub' }, '元主 · 项目 & 会话'),
          h('span', { class: 'panel-count', title: '已加载 / 宿主返回的会话总数' }, `${countText} 会话`),
          (() => {
            const stale = Number(S.essenceList?.data?.staleCount) || 0
            const update = S.mirror?.data?.updateAvailable === true
            const conflicted = (S.essenceList?.data?.essences || []).filter((item) => item.status === 'conflicted').length
            const tone2 = (conflicted > 0) ? 'red' : (stale > 0 || update) ? 'yellow' : 'green'
            const label2 = tone2 === 'red' ? '红灯' : tone2 === 'yellow' ? '黄灯' : '绿灯'
            const reasons = []
            if (update) reasons.push('母体有新版本')
            if (stale > 0) reasons.push(`${stale} 个元主待同步`)
            if (conflicted > 0) reasons.push(`${conflicted} 个元主冲突`)
            return h('span', {
              class: 'chip', 'data-lamp': tone2,
              title: reasons.length ? reasons.join('；') : '母体 / 元主 / 分身状态正常',
              style: { display: 'inline-flex', alignItems: 'center', gap: 6 },
            },
            h('span', { 'aria-hidden': 'true', style: { width: 8, height: 8, borderRadius: '50%', background: tone2 === 'red' ? '#C8102E' : tone2 === 'yellow' ? '#B45309' : '#17803D' } }),
            label2)
          })()),
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
            button('克隆母体', {
              size: 'sm', variant: 'quiet', dataBtnId: 'M-07',
              title: '把本机母体 profile（package.json / cordis.patch.yml / settings）克隆到镜像 active/，先自动备份；克隆后元主会黄灯待同步',
              onClick: () => void app.cloneMotherProfile(),
            }),
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
          h('span', { class: 'session-window', 'data-zone': 'session-window', style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            h('span', { class: 'hint' }, '显示'),
            ...[[20, '20'], [50, '50'], ['all', '全部']].map(([value, label]) => {
              const on = S.sessionWindow === value
              return h('button', {
                type: 'button',
                'data-window': String(value),
                'aria-pressed': on ? 'true' : 'false',
                title: value === 'all' ? '加载宿主返回的全部会话（只读投影）' : `只显示最近 ${label} 条会话`,
                onClick: () => app.setSessionWindow(value),
                style: {
                  height: 22, padding: '0 7px', borderRadius: 6, cursor: 'pointer', fontSize: 11,
                  border: '1px solid ' + (on ? 'rgba(127,127,127,.55)' : 'transparent'),
                  background: on ? 'rgba(127,127,127,.16)' : 'transparent',
                  color: 'inherit',
                },
              }, label)
            })),
          h('span', { class: 'spacer' }),
          h('span', null, `临时 ${split.temporary.length} · 归档 ${split.archived.length}`),
          h('span', { title: '没有写接口的动作会明确禁用并说明原因，不会假装成功' }, '只读')))

      const scroll = h('div', { class: 'panel-scroll', 'data-sk': 'left' })

      if (sessionState === 'loading' && all.length === 0) {
        scroll.append(h('div', { class: 'loading-line' }, icon('spinner', 14), '正在读取母体会话…'))
      } else if (sessionState === 'error' && all.length === 0) {
        scroll.append(emptyBlock('母体会话不可读', failureHint(S.sessions.error), [
          button('重试', { size: 'sm', variant: 'ghost', onClick: () => void app.refresh({ manual: true }) }),
        ]))
      } else if (visible.length === 0) {
        scroll.append(emptyBlock(
          query ? `没有匹配「${clampText(S.query, 20)}」的会话` : '还没有母体会话',
          query ? '搜索标题、会话 ID 或工作区名；Esc 清空搜索。' : '在本机开一个新对话后刷新，它会出现在这里。选择会话是只读元数据，母体会话不会被改写。',
          query ? [button('清除搜索', { size: 'sm', variant: 'ghost', onClick: () => { S.query = ''; app.schedule(true) } })] : [button('刷新', { size: 'sm', variant: 'ghost', onClick: () => void app.refresh({ manual: true }) })],
        ))
      } else {
        // 元主工作区的新建/归档/删除/下载是宿主职责：DOM 中不出现这些控件（不是禁用）。
        scroll.append(h('div', { class: 'section-head' },
          h('span', { class: 'section-title', style: { cursor: 'default' } }, '元主'),
          h('span', { class: 'section-sub' }, `${groups.length} 个工作区 · ${visible.length} 条会话`),
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

      const essences = Array.isArray(S.essenceList?.data?.essences) ? S.essenceList.data.essences : []
      const defaultEssenceId = String(S.essenceList?.data?.defaultId ?? '')
      const staleCount = Number(S.essenceList?.data?.staleCount) || 0
      const essenceHead = h('div', { class: 'section-head', 'data-zone': 'essence-head' },
        h('span', { class: 'section-title', style: { cursor: 'default' } }, '元主'),
        h('span', { class: 'section-sub' }, `${essences.length} 个 · 默认 ${defaultEssenceId ? short(defaultEssenceId, 18) : '—'}${staleCount > 0 ? ` · ${staleCount} 待同步` : ''}`),
        h('span', { class: 'spacer' }),
        staleCount > 0
          ? button('全部同步', {
            size: 'sm', variant: 'ghost', dataBtnId: 'E-02',
            title: '把所有待同步元主重放到新母体：只重建底层，用户插件配置与设置保持不变',
            onClick: () => void app.syncEssences(),
          })
          : null,
        button('导入', {
          size: 'sm', variant: 'ghost', dataBtnId: 'E-11',
          title: '导入元主整包（自己或他人下载的 JSON）：生成新元主文件夹并重算，可直接继续开发',
          onClick: () => void app.essenceImport(),
        }),
        button('从母体生成元主', {
          size: 'sm', variant: 'ghost', dataBtnId: 'E-01',
          title: '克隆母体 profile 的可写层（插件补丁/依赖/设置）生成新元主；不复制凭据与会话',
          onClick: () => void app.captureEssence(),
        }))
      const essenceList = h('div', { class: 'essence-list', 'data-zone': 'essence-list' },
        essences.length === 0
          ? h('span', { class: 'hint' }, '还没有自定义元主；点上方「从母体生成元主」克隆当前母体配置。')
          : null,
        ...essences.map((essence) => renderEssenceCard(S, app, essence, defaultEssenceId)))

      // v3.1.9：元主工作区只有一个滚动容器 —— 元主卡片（可能很多）与母体会话列表一起
      // 滚动，鼠标滚轮/拖动滚动条都作用在同一列；否则卡片区会把会话滚动区挤到 0 高。
      scroll.prepend(essenceList)
      scroll.prepend(essenceHead)

      return h('section', { class: 'panel', 'data-zone': 'mother', 'data-freshness': freshness, 'aria-labelledby': 'fang-mother-title' },
        head,
        h('div', { class: 'mother-slots' }, renderSlotStrip(projectCapacity(S.status.data, S.tasks.items))),
        scroll)
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
    /**
     * 右侧工作区内的「决策中心」区域：红置顶、黄/蓝分组、绿/灰默认折叠；
     * 操作后重新拉取（不乐观删除）；409 显示「已被处理」。
     */
    function renderDecisionMini() {
      const section = h('div', { class: 'fang-decision-mini', 'data-zone': 'decision-mini' })
      const state = {
        loading: true, items: [], error: '', notice: '', busy: false,
        collapsed: new Set(['green', 'gray']),
      }
      const LEVELS_MINI = [
        { level: 'red', label: '红色 · 阻塞', tone: 'red' },
        { level: 'yellow', label: '黄色', tone: 'yellow' },
        { level: 'blue', label: '蓝色', tone: 'blue' },
        { level: 'green', label: '绿色', tone: 'green' },
        { level: 'gray', label: '灰色归档', tone: 'gray' },
      ]
      const remaining = (expiresAt) => {
        if (!expiresAt) return '无期限'
        const diff = Number(expiresAt) - Date.now()
        if (diff <= 0) return '已过期'
        const minutes = Math.max(1, Math.round(diff / 60000))
        if (minutes < 60) return `剩余 ${minutes} 分钟`
        return `剩余 ${Math.floor(minutes / 60)} 小时`
      }
      const sourceLabel = (item) => {
        const source = item?.source ?? {}
        return String(source.rawSource || source.agentRole || 'unknown')
          + (source.taskName ? ` · ${source.taskName}` : '')
          + (source.sessionId && source.sessionId !== 'unknown' ? ` · ${source.sessionId}` : '')
      }
      const itemsFor = (level) => level === 'gray'
        ? state.items.filter((item) => item.status !== 'pending')
        : state.items.filter((item) => item.status === 'pending' && item.level === level)

      const load = async () => {
        const result = await api('/fang/api/decisions?includeArchived=1')
        if (result.status === 200 && result.body?.ok !== false) {
          state.items = Array.isArray(result.body.items) ? result.body.items : []
          state.error = ''
        } else {
          state.error = result.body?.error || (result.status ? 'http-' + result.status : 'network')
        }
        state.loading = false
        render()
      }
      const act = async (item, option) => {
        if (state.busy) return
        state.busy = true
        state.notice = ''
        render()
        const result = option === null
          ? await api('/fang/api/decisions/abandon', { method: 'POST', body: JSON.stringify({ id: item.id, by: 'fang-panel' }) })
          : await api('/fang/api/decisions/resolve', { method: 'POST', body: JSON.stringify({ id: item.id, option, by: 'fang-panel' }) })
        if (result.status === 409) state.notice = '该票已被处理（可能刚被其他人/另一标签页处理），已刷新'
        else if (result.status !== 200 || result.body?.ok === false) state.notice = '操作失败：' + failureHint(result.body?.reason || result.body?.error || ('http-' + result.status))
        state.busy = false
        await load() // 不做乐观删除：无论成功失败都重新拉取
      }

      function render() {
        const pending = state.items.filter((item) => item.status === 'pending')
        const head = h('div', { class: 'fang-decision-mini-head' },
          h('b', null, '决策中心'),
          h('span', { class: 'fang-decision-mini-count' }, pending.length ? `${pending.length} 待处理` : '暂无待处理'),
          h('span', { class: 'fang-decision-mini-spacer' }),
          h('button', { type: 'button', class: 'fang-decision-mini-refresh', title: '重新拉取', onClick: () => { if (!state.busy) void load() } }, '刷新'))
        const body = h('div', { class: 'fang-decision-mini-body' })
        if (state.notice) body.append(h('div', { class: 'notice notice--warn', role: 'status' }, state.notice))
        if (state.loading) body.append(h('div', { class: 'loading-line' }, icon('spinner', 13), '正在读取决策…'))
        else if (state.error) body.append(h('div', { class: 'notice notice--bad', role: 'alert' }, '决策中心不可用：' + failureHint(state.error)))
        else {
          for (const meta of LEVELS_MINI) {
            const items = itemsFor(meta.level)
            if (!items.length) continue
            const collapsed = state.collapsed.has(meta.level)
            const group = h('div', { class: 'fang-decision-mini-group', 'data-level': meta.level },
              h('button', {
                type: 'button', class: 'fang-decision-mini-group-head',
                'aria-expanded': collapsed ? 'false' : 'true',
                onClick: () => {
                  if (collapsed) state.collapsed.delete(meta.level)
                  else state.collapsed.add(meta.level)
                  render()
                },
              }, h('b', null, meta.label), h('span', null, `${items.length} 项 · ${collapsed ? '展开' : '收起'}`)))
            if (!collapsed) {
              const list = h('div', { class: 'fang-decision-mini-list' })
              for (const item of items.slice(0, 30)) {
                const actions = h('div', { class: 'fang-decision-mini-actions' })
                for (const option of (item.options || []).slice(0, 4)) {
                  actions.append(h('button', {
                    type: 'button', class: 'fang-inbox-btn' + (option.isRecommended ? ' fang-inbox-btn--primary' : ''),
                    disabled: state.busy || item.status !== 'pending',
                    onClick: () => void act(item, option.value),
                  }, option.label || option.value))
                }
                if (item.status === 'pending') {
                  actions.append(h('button', {
                    type: 'button', class: 'fang-inbox-btn fang-inbox-btn--danger', disabled: state.busy,
                    onClick: () => void act(item, null),
                  }, '放弃/忽略'))
                }
                list.append(h('div', { class: 'fang-decision-mini-item', 'data-inbox-id': item.id, 'data-level': item.level },
                  h('div', { class: 'fang-decision-mini-title' }, inboxText(item.title) || item.id),
                  h('div', { class: 'fang-decision-mini-meta' }, `${sourceLabel(item)} · ${remaining(item.expiresAt)}`),
                  item.context ? h('div', { class: 'fang-decision-mini-context' }, inboxText(item.context, 240)) : null,
                  actions))
              }
              group.append(list)
            }
            body.append(group)
          }
          if (!pending.length && !itemsFor('gray').length) body.append(h('div', { class: 'loading-line' }, '没有待处理决策。'))
        }
        section.replaceChildren(head, body)
      }

      render()
      void load()
      const timer = setInterval(() => {
        if (!section.isConnected) { clearInterval(timer); return }
        if (!state.busy) void load()
      }, 5000)
      timer.unref?.()
      return section
    }

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
      scroll.append(renderDecisionMini())

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
          ? [button('派生新分身', { size: 'sm', variant: 'primary', onClick: () => void app.deriveQuick() })]
          : []))
      } else {
        for (const task of tasks) body.append(renderForkCard(S, app, task, { archived: key === 'archived' }))
      }
      group.append(body)
      return group
    }

    function formatBytes(value) {
      const bytes = Number(value)
      if (!Number.isFinite(bytes) || bytes <= 0) return '—'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`
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
      const folded = S.collapsedTasks?.has(taskId) ?? false
      const toggleFold = (event) => {
        const btn = event?.currentTarget
        const nextFolded = btn ? btn.getAttribute('aria-expanded') !== 'false' : !S.collapsedTasks.has(taskId)
        if (nextFolded) S.collapsedTasks.add(taskId)
        else S.collapsedTasks.delete(taskId)
        // 同步更新 DOM，避免等到下一次轮询才反映折叠状态
        if (btn) btn.setAttribute('aria-expanded', nextFolded ? 'false' : 'true')
        const body = document.getElementById('task-body-' + taskId)
        if (body) {
          body.hidden = nextFolded
          if (nextFolded) body.setAttribute('hidden', '')
          else body.removeAttribute('hidden')
        }
        schedule()
      }

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
        h('button', {
          type: 'button', class: 'expand-btn', 'data-fk': 'task-fold:' + taskId,
          'aria-expanded': folded ? 'false' : 'true',
          'aria-controls': 'task-body-' + taskId,
          title: folded ? '展开分身' : '折叠分身',
          onClick: toggleFold,
        }, icon('chevron', !folded, 14)),
        h('div', { class: 'fork-head-main' },
          h('div', { class: 'fork-title' }, editableText(S, app, {
            key: 'task:' + taskId,
            label: '分身',
            value: S.aliases['task:' + taskId] || clampText(task.title) || `分身 ${short(taskId, 8)}`,
          })),
          h('div', { class: 'fork-chips' },
            chip(health.tone, health.label, { state: health.phase, danger: health.tone === 'bad' && health.anomaly }),
            archived ? null : chip(health.adapterTone, health.adapterLabel, { health: health.adapter }),
            task.importedSession ? chip('info', '已导入会话', { title: '派生时导入了母体会话历史/摘要' }) : null,
            task.essenceDeleted ? chip('warn', '原身已删除（仅运行/归档）', { title: '来源原身已删除：不能再从该原身派生，但本分身可继续运行/归档/还原/删除' }) : null)),
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
            button('分支', {
              size: 'sm', variant: 'ghost', dataBtnId: 'C-06',
              title: '物理分支：在分身内 fork 当前会话，挂回同一分身（可多分支、可激活）',
              onClick: () => void app.openBranches(task),
              fk: 'branches:' + taskId,
            }),
            textAction('提升插件', {              title: '把分身里验证过的插件目录提升到母体（需目录名）', dataBtnId: 'C-02',
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

      const bodyWrap = h('div', { id: 'task-body-' + taskId, hidden: folded })
      bodyWrap.append(h('div', { class: 'fork-info', 'data-zone': 'task-info', style: { display: 'flex', gap: '10px', flexWrap: 'wrap', fontSize: '12px', opacity: '.85' } },
        h('span', null, '对话 ' + (task.sessionTitle || '—')),
        h('span', null, '创建 ' + fmtShortClock(task.createdAt ?? task.startedAt)),
        h('span', null, '更新 ' + fmtShortClock(task.updatedAt)),
        h('span', null, '体积 ' + formatBytes(task.projectBytes))))
      bodyWrap.append(meta)
      card.append(head, bodyWrap)

      if (health.anomaly) {
        bodyWrap.append(h('div', { class: 'fork-warn', role: 'note' },
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
        bodyWrap.append(sub)
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
          kv('上次同步', data.sync?.lastSyncAt ? fmtClock(data.sync.lastSyncAt) : '从未'),
          kv('自动同步', (() => { const v = String(data.preferences?.syncIntervalHours ?? 'off'); return v === 'off' ? '关闭' : `${v} 小时` })()),
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
          button('克隆母体', {
            size: 'sm', variant: 'quiet', dataBtnId: 'M-07',
            title: '把本机母体 profile（package.json / cordis.patch.yml / settings）克隆到镜像 active/profile，先自动备份',
            onClick: () => void app.mirrorAction('clone', async () => (await api('/fang/api/mirror/clone-profile', { method: 'POST', body: '{}' })).body),
          }),
          button('空白母体', {
            size: 'sm', variant: 'quiet', dataBtnId: 'M-08',
            title: '重置为初始盘（清空 active/profile）；会先自动备份，需重新克隆或升级',
            onClick: () => {
              S.modal.pending = {
                text: '把镜像重置为空白母体（初始盘）？会先自动备份；之后需要重新克隆或升级才能恢复基础配置。',
                run: () => app.mirrorAction('blank', async () => (await api('/fang/api/mirror/blank', { method: 'POST', body: '{}' })).body),
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

        section.append(h('div', { class: 'glass-section-title', style: { marginTop: '4px' } }, '母体自动同步',
          ...(['off', '6', '12', '24'].map((value) => button(value === 'off' ? '关闭' : value + 'h', {
            size: 'sm', variant: String(data.preferences?.syncIntervalHours ?? 'off') === value ? 'config' : 'quiet',
            title: value === 'off' ? '关闭自动同步' : `每 ${value} 小时从本机母体 profile 同步到镜像（同步前自动备份）`,
            onClick: () => void app.mirrorAction('sync:' + value, async () => (await api('/fang/api/mirror/preferences/set', { method: 'POST', body: JSON.stringify({ syncIntervalHours: value }) })).body),
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

    // 元主详情页（设置 / 插件 / 运行日志）
    function renderEssenceModal(S, app) {
      const modal = S.modal
      const detail = modal.detail
      const meta = detail?.meta ?? null
      const tabs = [['settings', '设置'], ['plugins', '插件'], ['logs', '运行日志']]
      const body = h('div', { class: 'glass-body' })
      if (modal.loading) {
        body.append(h('div', { class: 'loading-line' }, icon('spinner', 14), '读取元主详情…'))
      } else if (modal.error) {
        body.append(h('div', { class: 'notice notice--warn' }, h('div', { class: 'notice-main' },
          h('div', { class: 'notice-title' }, icon('alert', 14), '读取失败'),
          h('div', { class: 'notice-text' }, failureHint(modal.error) + ' · ' + modal.error))))
      } else if (detail) {
        if (modal.tab === 'settings') {
          const rows = [
            ['状态', String(meta.status ?? 'unknown')],
            ['等级', String(meta.tier ?? '—')],
            ['插件条目', String(detail.overlay?.patchEntries?.length ?? 0)],
            ['设置项', (detail.overlay?.settings || []).join(', ') || '—'],
            ['备份', detail.backup ? '有（Backup/，只保留一份）' : '无'],
            ['进行中会话', `${detail.sessions?.used ?? 0} / ${detail.sessions?.limit ?? 10}${detail.sessions?.over ? '（已满，归档后再开）' : ''}`],
            ['运行态', detail.runtime?.running ? `运行中 · :${detail.runtime.port ?? '—'} · pid ${detail.runtime.pid ?? '—'}` : '未运行'],
            ['镜像指纹', String(meta.lastMergedFingerprint ?? '—').slice(0, 16)],
            ['归档', meta.archived === true ? '已冻结（只能删除）' : '活跃'],
          ]
          body.append(h('div', { style: { display: 'grid', gap: 6, padding: '6px 2px' } },
            ...rows.map(([key, value]) => h('div', { style: { display: 'flex', gap: 12 } },
              h('span', { style: { width: 88, opacity: .65 } }, key),
              h('span', null, value)))))
        } else if (modal.tab === 'plugins') {
          const entries = detail.overlay?.patchEntries || []
          body.append(entries.length
            ? h('div', null, ...entries.map((entry) => h('div', {
              style: { display: 'flex', gap: 8, alignItems: 'center', padding: '5px 0', borderBottom: '1px solid rgba(127,127,127,.15)' },
            },
            h('b', { style: { fontFamily: 'var(--f-mono)' } }, entry.id),
            h('span', { class: 'hint' }, entry.name || ''),
            entry.disabled ? h('span', { class: 'chip' }, '禁用') : null)))
            : h('div', { class: 'hint' }, '该元主还没有插件补丁条目；在「打开」起的实例里安装插件后再同步。'))
        } else {
          body.append(h('pre', {
            style: { maxHeight: '46vh', overflow: 'auto', fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', margin: 0 },
          }, detail.logs || '（暂无运行日志；先点「打开」启动该元主的隔离实例）'))
        }
      }
      const tabBar = h('div', { class: 'panel-tools', style: { borderTop: 'none' } },
        ...tabs.map(([id, label]) => button(label, {
          size: 'sm', variant: modal.tab === id ? 'primary' : 'ghost',
          onClick: () => { if (!S.modal || S.modal.kind !== 'essence') return; S.modal.tab = id; render(true) },
        })))
      const closeBtn = button('关闭', { size: 'sm', variant: 'quiet', onClick: () => app.closeModal() })
      const id = modal.essenceId
      return h('div', {
        class: 'overlay', 'data-overlay': '1',
        onClick: (event) => { if (event.target === event.currentTarget) app.closeModal() },
      },
      h('div', { class: 'glass', role: 'dialog', 'aria-modal': 'true', style: { width: 'min(880px, 94vw)' } },
        h('div', { class: 'glass-head' },
          h('div', { class: 'glass-head-main' },
            h('div', { class: 'glass-title', id: 'fang-essence-title' }, icon('gate', 16), meta?.name || id),
            h('div', { class: 'glass-sub' }, `${id} · ${meta?.archived === true ? '冻结' : '活跃'}${meta?.locked === true ? ' · 官方锁定' : ''}`)),
          closeBtn),
        tabBar,
        body,
        h('div', { class: 'glass-foot' },
          button('打开', { size: 'sm', variant: 'ghost', onClick: () => { app.closeModal(); void app.openEssence(id) } }),
          button('同步', { size: 'sm', variant: 'ghost', onClick: () => { app.closeModal(); void app.syncEssence(id) } }),
          button('备份', { size: 'sm', variant: 'ghost', onClick: () => { const name = S.modal?.detail?.meta?.name; app.closeModal(); void app.essenceBackup({ id, name }) } }),
          button('下载', { size: 'sm', variant: 'ghost', onClick: () => { const name = S.modal?.detail?.meta?.name; app.closeModal(); void app.downloadEssence({ id, name }) } }))))
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
      const inputId = 'fang-confirm-input'
      const reasonId = 'fang-confirm-reason'
      // 输入框是就地改 DOM 的，点击时必须以输入框当前值为准，
      // 否则首次渲染算出的 matches=false 会把「已输入正确名称」的点击吞掉。
      const inputValue = () => {
        if (!modal.strong) return ''
        const node = app.view.querySelector('#' + inputId)
        return String(node?.value ?? modal.typed ?? '').trim()
      }
      const confirmed = () => !modal.strong || inputValue() === expected
      const level = modal.strong ? 'strong' : 'once'
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
              disabled: modal.strong,
              describedBy: modal.strong ? reasonId : undefined,
              onClick: () => {
                if (!confirmed()) {
                  // 名称还没对上：把焦点送回输入框，别让点击静默丢失。
                  const node = app.view.querySelector('#' + inputId)
                  if (node) node.focus({ preventScroll: true })
                  return
                }
                const run = modal.onConfirm
                app.closeModal()
                void run()
              },
            })),
          modal.strong
            ? h('span', { class: 'live', id: reasonId, role: 'status' }, '名称不匹配，删除按钮保持禁用。')
            : null))
    }

    function renderBranchModal(S, app) {
      const modal = S.modal
      const branches = Array.isArray(modal.branches) ? modal.branches : []
      return h('div', { class: 'overlay', 'data-overlay': '1', onClick: (event) => { if (event.target === event.currentTarget) app.closeModal() } },
        h('div', { class: 'glass', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'fang-branch-title' },
          h('div', { class: 'glass-head' },
            h('div', { class: 'glass-head-main' },
              h('div', { class: 'glass-title', id: 'fang-branch-title' }, '分支 · ' + (modal.taskTitle || '')),
              h('div', { class: 'glass-sub' }, '会话 ' + (modal.sessionId || '—') + ' · 当前分支 ' + (modal.activeBranchId || '—'))),
            button('', { variant: 'quiet', size: 'sm', iconOnly: true, icon: icon('close', 15), ariaLabel: '关闭', onClick: () => app.closeModal() })),
          h('div', { class: 'glass-body' },
            modal.error ? h('div', { class: 'hint', style: { color: 'var(--f-red)' }, role: 'alert' }, modal.error) : null,
            h('div', { style: { display: 'flex', gap: 8, margin: '4px 0 12px' } },
              button('派生分支', { size: 'sm', variant: 'primary', dataBtnId: 'B-01', onClick: () => void app.forkBranch({ taskId: modal.taskId, title: modal.taskTitle }) }),
              button('刷新', { size: 'sm', variant: 'ghost', onClick: () => void app.openBranches({ taskId: modal.taskId, title: modal.taskTitle }) })),
            branches.length === 0
              ? h('p', { class: 'glass-sub' }, '还没有分支。派生分支会在分身内 fork 当前会话（物理分支，子会话挂回同一分身）。')
              : h('div', { style: { display: 'grid', gap: 6 } },
                branches.map((branch) => h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', border: '1px solid var(--f-border)', borderRadius: 10 } },
                  h('span', null,
                    String(branch.branchId) + ' · ' + String(branch.status ?? '')
                    + (branch.sessionId ? ' · ' + short(String(branch.sessionId), 8) : '')
                    + (branch.branchId === modal.activeBranchId ? ' · 当前' : '')),
                  branch.branchId !== modal.activeBranchId && branch.status === 'active'
                    ? button('激活', { size: 'sm', variant: 'ghost', onClick: () => void app.activateBranch({ taskId: modal.taskId, title: modal.taskTitle }, branch.branchId) })
                    : null,
                  button('打开分身', {
                    size: 'sm', variant: 'ghost', title: '打开分身 Web UI（DSH 暂不支持会话深链，子会话在左侧会话列表中）',
                    onClick: () => void app.openTask({ taskId: modal.taskId, title: modal.taskTitle }),
                  }),
                  branch.sessionId ? button('复制会话 ID', {
                    size: 'sm', variant: 'ghost', title: branch.sessionId,
                    onClick: () => {
                      const text = String(branch.sessionId || '')
                      const done = () => setNotice({ tone: 'ok', title: '已复制会话 ID', message: short(text, 12) })
                      try { void navigator.clipboard.writeText(text).then(done, done) } catch { done() }
                    },
                  }) : null)))),
          h('div', { class: 'glass-foot' },
            button('关闭', { size: 'sm', variant: 'ghost', onClick: () => app.closeModal() }))))
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

    function renderForkSupervision(S, app) {
      const sv = S.forkSupervision || { state: 'idle' }
      if (sv.state === 'idle') return null
      if (sv.state === 'error') {
        return h('div', { class: 'notice notice--warn', role: 'status', 'data-zone': 'fork-supervision' },
          h('div', { class: 'notice-main' },
            h('div', { class: 'notice-title' }, '分身看护不可用'),
            h('div', { class: 'notice-text' }, failureHint(sv.error || 'network'))),
          button('重试', { size: 'sm', variant: 'ghost', onClick: () => void app.refresh({ manual: true }) }))
      }
      const data = sv.data || {}
      const eff = data.effective || {}
      const persisted = data.persisted || {}
      const toggle = (key, label, checked, title) => h('label', {
        class: 'supervision-toggle', title, style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' },
      },
      h('input', {
        type: 'checkbox', checked: checked === true, 'data-supervision': key,
        onChange: () => void app.setForkSupervision({ [key]: !checked }),
      }), label)
      return h('div', { class: 'notice notice--info', role: 'status', 'data-zone': 'fork-supervision', style: { padding: '8px 10px' } },
        h('div', { class: 'notice-main', style: { width: '100%' } },
          h('div', { class: 'notice-title' }, '分身看护'),
          h('div', { class: 'notice-text', style: { display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', marginTop: 4 } },
            toggle('autostartForks', '自动启动分身（watchdog 下次启动生效）', eff.autostartForks === true),
            toggle('supervise', '崩溃自动重启（立即生效）', eff.supervise === true),
            h('span', { style: { color: 'var(--f-text-3)' } },
              `持久化：${persisted.exists ? '已保存' : '默认值'}${data.forker?.enabled === true ? ' · forker 看护中' : ''}`))))
    }

    function renderApp(S, app) {
      const frag = document.createDocumentFragment()
      // 分身 Web UI 只有一条宿主机说明：母体 API 的 404 是预期，不渲染任何错误横幅/母体控件。
      if (S.role.value === 'fork') {
        frag.append(renderHostNotice(S, app))
        return frag
      }
      frag.append(renderHeader(S, app))
      for (const node of renderNotices(S, app)) frag.append(node)
      for (const node of renderApprovals(S, app)) frag.append(node)
      const forkSupervisionNode = renderForkSupervision(S, app)
      if (forkSupervisionNode) frag.append(forkSupervisionNode)
      // 决策中心已移出主面板：独立「收件箱」侧栏入口 + 右侧抽屉 / sidebar.right.pane.tab。

      if (S.role.value === 'mother') {
        const body = h('div', { class: 'fang-body', 'aria-busy': S.refreshing ? 'true' : undefined })
        body.append(renderMotherPanel(S, app), renderForkPanel(S, app))
        // 中间拖动手柄：默认 50:50，可拖动/键盘方向键调整，双击恢复 50:50（偏好存本机）。
        const handle = h('div', {
          class: 'fang-split-handle',
          role: 'separator',
          'aria-orientation': 'vertical',
          'aria-label': '调整元宝工作区与分身工作区比例',
          'aria-valuemin': '25',
          'aria-valuemax': '75',
          tabindex: '0',
          title: '拖动调整比例；双击恢复 50:50',
        })
        const applyRatio = (ratio, persist = false) => {
          const clamped = Math.min(0.75, Math.max(0.25, Number.isFinite(ratio) ? ratio : 0.5))
          S.splitRatio = clamped
          const left = (clamped * 100).toFixed(2)
          const right = ((1 - clamped) * 100).toFixed(2)
          // fr 会先扣除 gap 再按比例分配，避免 50% + gap 溢出。
          body.style.gridTemplateColumns = `minmax(320px, ${left}fr) minmax(0, ${right}fr)`
          handle.style.left = left + '%'
          handle.setAttribute('aria-valuenow', String(Math.round(clamped * 100)))
          if (persist) writeNumberPref('fang.panel.split', clamped)
        }
        applyRatio(S.splitRatio)
        const onMove = (event) => {
          const x = event.touches ? event.touches[0]?.clientX : event.clientX
          if (typeof x !== 'number') return
          const rect = body.getBoundingClientRect()
          if (rect.width > 0) applyRatio((x - rect.left) / rect.width)
        }
        const stop = () => {
          body.classList.remove('is-resizing')
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('touchmove', onMove)
          document.removeEventListener('mouseup', stop)
          document.removeEventListener('touchend', stop)
          writeNumberPref('fang.panel.split', S.splitRatio)
        }
        const start = (event) => {
          event.preventDefault()
          body.classList.add('is-resizing')
          document.addEventListener('mousemove', onMove)
          document.addEventListener('touchmove', onMove, { passive: false })
          document.addEventListener('mouseup', stop, { once: true })
          document.addEventListener('touchend', stop, { once: true })
        }
        handle.addEventListener('mousedown', start)
        handle.addEventListener('touchstart', start, { passive: false })
        handle.addEventListener('dblclick', () => applyRatio(0.5, true))
        handle.addEventListener('keydown', (event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          applyRatio(S.splitRatio + (event.key === 'ArrowLeft' ? -0.02 : 0.02), true)
        })
        body.append(handle)
        frag.append(body)
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
          else if (S.modal.kind === 'essence') frag.append(renderEssenceModal(S, app))
        else if (S.modal.kind === 'branches') frag.append(renderBranchModal(S, app))
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

    function mountDiagnostics(app, host) {
      const doc = host?.ownerDocument ?? document
      const parent = host ?? doc.body
      if (host) { host.style.position = host.style.position || 'relative' }
      const btn = doc.createElement('button')
      btn.id = 'fang-diag-btn'
      btn.setAttribute('data-btn-id', 'LOG-01')
      btn.type = 'button'
      btn.textContent = '日志'
      Object.assign(btn.style, {
        position: 'absolute', right: '16px', bottom: '16px', zIndex: '9999',
        height: '34px', padding: '0 12px', borderRadius: '10px',
        border: '1px solid rgba(127,127,127,.4)', background: '#fff', color: '#111',
        font: '600 13px/1 system-ui, sans-serif', cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,.18)',
      })
      const overlay = doc.createElement('div')
      overlay.id = 'fang-diag-panel'
      overlay.hidden = true
      Object.assign(overlay.style, {
        position: 'absolute', right: '16px', bottom: '58px', zIndex: '9999',
        width: 'min(520px, calc(100vw - 32px))', maxHeight: '60vh', overflow: 'auto',
        background: '#fff', color: '#111', border: '1px solid rgba(127,127,127,.35)',
        borderRadius: '12px', boxShadow: '0 12px 40px rgba(0,0,0,.25)', padding: '10px',
        font: '12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace',
      })
      const head = doc.createElement('div')
      head.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap'
      const title = doc.createElement('strong')
      title.textContent = '瓮城日志'
      let filter = 'all'
      let limit = 100
      const filterButtons = []
      const makeFilter = (key, label, id) => {
        const b = doc.createElement('button')
        b.type = 'button'; b.textContent = label; b.setAttribute('data-btn-id', id)
        b.style.cssText = 'height:24px;padding:0 8px;border-radius:7px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;cursor:pointer;font:inherit'
        b.onclick = () => { filter = key; limit = 100; renderLogs() }
        filterButtons.push({ key, b })
        return b
      }
      const spacer = doc.createElement('span')
      spacer.style.flex = '1'
      const clear = doc.createElement('button')
      clear.type = 'button'; clear.textContent = '清空'; clear.setAttribute('data-btn-id', 'LOG-02')
      clear.onclick = () => { app.diagnostics.clear(); limit = 100 }
      const close = doc.createElement('button')
      close.type = 'button'; close.textContent = '关闭'; close.setAttribute('data-btn-id', 'LOG-03')
      close.onclick = () => { overlay.hidden = true }
      head.append(title, makeFilter('all', '全部', 'LOG-05'), makeFilter('bad', '错误', 'LOG-06'), makeFilter('warn', '警告', 'LOG-07'), spacer, clear, close)
      const list = doc.createElement('div')
      const loadMore = doc.createElement('button')
      loadMore.type = 'button'; loadMore.setAttribute('data-btn-id', 'LOG-04')
      loadMore.style.cssText = 'margin-top:8px;height:30px;width:100%;border-radius:8px;border:1px dashed rgba(127,127,127,.45);background:transparent;color:inherit;cursor:pointer;font:inherit'
      loadMore.onclick = () => { limit += 300; renderLogs() }
      overlay.append(head, list, loadMore)
      function renderLogs() {
        const all = app.diagnostics.list()
        const entries = all.filter((entry) => filter === 'all' || entry.level === filter).slice().reverse()
        list.replaceChildren()
        btn.textContent = all.length ? `日志 (${all.length})` : '日志'
        for (const { key, b } of filterButtons) {
          b.style.background = key === filter ? 'rgba(127,127,127,.18)' : 'transparent'
          b.style.fontWeight = key === filter ? '700' : '400'
        }
        if (!entries.length) {
          const empty = doc.createElement('div')
          empty.textContent = filter === 'all' ? '暂无报错或警告' : (filter === 'bad' ? '暂无错误' : '暂无警告')
          empty.style.opacity = '.6'
          list.append(empty)
          loadMore.hidden = true
          return
        }
        for (const entry of entries.slice(0, limit)) {
          const row = doc.createElement('div')
          row.setAttribute('data-fang-log-row', '1')
          row.style.cssText = 'padding:6px 0;border-top:1px solid rgba(127,127,127,.18);white-space:pre-wrap;word-break:break-word'
          const when = new Date(entry.at).toLocaleTimeString()
          row.textContent = `[${when}] ${entry.level} · ${entry.message}${entry.detail ? '\n' + entry.detail : ''}`
          if (entry.level === 'bad') row.style.color = '#b42318'
          else if (entry.level === 'warn') row.style.color = '#b54708'
          list.append(row)
        }
        const remaining = entries.length - Math.min(limit, entries.length)
        loadMore.hidden = remaining <= 0
        loadMore.textContent = remaining > 0 ? `加载更多（剩余 ${remaining}）` : ''
      }
      btn.onclick = () => { overlay.hidden = !overlay.hidden; renderLogs() }
      const onDiag = () => renderLogs()
      const onError = (event) => app.diagnostics.push('bad', event.message || 'window error', `${event.filename || ''}:${event.lineno || ''}`)
      const onRejection = (event) => app.diagnostics.push('bad', 'unhandledrejection', String(event.reason?.message ?? event.reason ?? ''))
      window.addEventListener('fang:diag', onDiag)
      window.addEventListener('error', onError)
      window.addEventListener('unhandledrejection', onRejection)
      parent.append(btn, overlay)
      renderLogs()
      return () => {
        window.removeEventListener('fang:diag', onDiag)
        window.removeEventListener('error', onError)
        window.removeEventListener('unhandledrejection', onRejection)
        btn.remove()
        overlay.remove()
      }
    }

    function mountConnectionInfo(app, host) {
      const doc = host?.ownerDocument ?? document
      const parent = host ?? doc.body
      if (host) { host.style.position = host.style.position || 'relative' }
      const trigger = doc.createElement('button')
      trigger.id = 'fang-conn-trigger'
      trigger.type = 'button'
      trigger.setAttribute('data-btn-id', 'CONN-00')
      trigger.textContent = '连接信息'
      Object.assign(trigger.style, {
        position: 'absolute', left: '16px', bottom: '16px', zIndex: '9999',
        height: '34px', padding: '0 12px', borderRadius: '10px',
        border: '1px solid rgba(127,127,127,.4)', background: '#fff', color: '#111',
        font: '600 13px/1 system-ui, sans-serif', cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,.18)',
      })
      const popup = doc.createElement('div')
      popup.id = 'fang-conn-popup'
      popup.hidden = true
      Object.assign(popup.style, {
        position: 'absolute', left: '16px', bottom: '58px', zIndex: '9999',
        display: 'none', alignItems: 'center', gap: '6px', maxWidth: 'calc(100vw - 32px)',
        padding: '6px 8px', borderRadius: '10px', background: '#fff', color: '#111',
        border: '1px solid rgba(127,127,127,.35)', boxShadow: '0 4px 14px rgba(0,0,0,.14)',
        font: '12px/1.4 ui-monospace, Consolas, monospace',
      })
      const label = doc.createElement('span')
      label.id = 'fang-conn-url'
      label.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:42vw'
      // Web 模式需要第二行显示安装 token；桌面模式保持原来的单行样子。
      const labelWrap = doc.createElement('div')
      labelWrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;min-width:0'
      labelWrap.append(label)
      const eye = doc.createElement('button')
      eye.type = 'button'
      eye.setAttribute('data-btn-id', 'CONN-01')
      eye.textContent = '显示'
      const copy = doc.createElement('button')
      copy.type = 'button'
      copy.setAttribute('data-btn-id', 'CONN-02')
      copy.textContent = '复制'
      const close = doc.createElement('button')
      close.type = 'button'
      close.setAttribute('data-btn-id', 'CONN-03')
      close.textContent = '关闭'
      for (const btn of [eye, copy, close]) {
        btn.style.cssText = 'height:28px;padding:0 8px;border-radius:8px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;cursor:pointer;font:inherit'
      }
      let full = ''
      let baseUrl = ''
      let tokenValue = ''
      let tokenLabel = null
      let copyToken = null
      let revealed = false
      let opened = false
      let loaded = false
      const mask = (url) => {
        try {
          const token = new URL(url).searchParams.get('token') || ''
          return String(url).replace(/([?&]token=)[^&]*/, (_, prefix) => prefix + '•'.repeat(Math.min(16, token.length || 8)))
        } catch { return url }
      }
      // 桌面壳里 token 由主进程保管；纯 Web 里没有 fangShell，
      // 连接地址就是当前页面地址本身（同源打开，token 已在地址栏里）。
      const isDesktopShell = () => typeof window !== 'undefined' && typeof window.fangShell?.revealToken === 'function'
      const resolveFull = async () => {
        if (full) return full
        if (isDesktopShell()) {
          try {
            const info = await window.fangShell.revealToken()
            if (info?.token) { full = baseUrl + '/?token=' + encodeURIComponent(String(info.token)); return full }
          } catch { /* 主进程拒绝就退回页面地址 */ }
        }
        try {
          const result = await api('/fang/api/connection')
          const url = result?.body?.url
          if (typeof url === 'string' && url) { full = url; return full }
        } catch { /* 宿主没这个路由时继续兜底 */ }
        if (typeof location !== 'undefined' && location.href) full = String(location.href)
        return full
      }
      const maskedText = () => {
        if (full) return mask(full)
        if (baseUrl) return baseUrl + '/?token=••••••••'
        return '连接信息加载中…'
      }
      const render = () => {
        popup.hidden = !opened
        popup.style.display = opened ? 'flex' : 'none'
        if (!opened) { label.textContent = ''; label.title = ''; if (tokenLabel) { tokenLabel.textContent = ''; tokenLabel.title = '' } return }
        label.textContent = full && revealed ? full : maskedText()
        label.title = revealed ? full : ''
        if (tokenLabel) {
          tokenLabel.textContent = tokenValue
            ? (revealed ? tokenValue : 'Token ' + '•'.repeat(Math.min(16, tokenValue.length)))
            : 'Token 未获取（宿主未就绪）'
          tokenLabel.title = revealed ? tokenValue : ''
        }
        eye.textContent = revealed ? '隐藏' : '显示'
      }
      const load = async () => {
        if (loaded) return
        loaded = true
        try {
          const info = await window.fangShell?.desktopInfo?.()
          if (info?.upstream) baseUrl = String(info.upstream).replace(/\/+$/, '')
        } catch { /* ignore */ }
        if (!baseUrl) baseUrl = String(location.origin || '')
        // 宿主侧 /fang/api/connection 给出带进程 token 的完整地址；
        // 拿不到就用当前页面地址兜底（同源，能用就能复制）。
        try {
          const result = await api('/fang/api/connection')
          const url = result?.body?.url
          if (typeof url === 'string' && url) full = url
        } catch { /* ignore */ }
        if (!isDesktopShell()) {
          // 纯 Web：宿主没有桌面壳桥，token 走同源的 /fang/api/auth-token。
          try {
            const result = await api('/fang/api/auth-token')
            const token = result?.body?.token
            if (typeof token === 'string' && token) tokenValue = token
          } catch { /* ignore */ }
          tokenLabel = doc.createElement('span')
          tokenLabel.id = 'fang-conn-token'
          tokenLabel.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:42vw;color:#6E6E73'
          labelWrap.append(tokenLabel)
          copyToken = doc.createElement('button')
          copyToken.type = 'button'
          copyToken.setAttribute('data-btn-id', 'CONN-04')
          copyToken.textContent = '复制 Token'
          copyToken.style.cssText = 'height:28px;padding:0 8px;border-radius:8px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;cursor:pointer;font:inherit'
          copyToken.onclick = async () => {
            if (!tokenValue) { app.notify('warn', '还没拿到 Token：宿主可能未就绪'); return }
            const ok = await writeClipboard(tokenValue)
            app.notify(ok ? 'ok' : 'warn', ok ? '已复制 Token' : '复制失败：浏览器未授权剪贴板')
          }
          popup.insertBefore(copyToken, close)
          if (!full && typeof location !== 'undefined' && location.href) full = String(location.href)
        }
      }
      // 老 Electron / 无剪贴板权限时退回 execCommand。
      const writeClipboard = async (text) => {
        try { await navigator.clipboard.writeText(text); return true } catch { /* fall through */ }
        try {
          const area = doc.createElement('textarea')
          area.value = text
          area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
          doc.body.appendChild(area)
          area.select()
          const ok = doc.execCommand('copy')
          area.remove()
          return Boolean(ok)
        } catch { return false }
      }
      trigger.onclick = async () => {
        opened = !opened
        if (opened) await load()
        revealed = false
        render()
      }
      eye.onclick = async () => {
        if (!revealed) {
          const text = await resolveFull()
          if (!text) { app.notify('warn', '还没拿到连接地址：宿主可能未就绪'); return }
        }
        revealed = !revealed
        render()
      }
      copy.onclick = async () => {
        const text = await resolveFull()
        if (!text) { app.notify('warn', '还没拿到连接地址：宿主可能未就绪'); return }
        const ok = await writeClipboard(text)
        app.notify(ok ? 'ok' : 'warn', ok ? '已复制连接地址' : '复制失败：浏览器未授权剪贴板')
      }
      close.onclick = () => { opened = false; revealed = false; render() }
      popup.append(labelWrap, eye, copy, close)
      parent.append(trigger, popup)
      render()
      return () => { trigger.remove(); popup.remove() }
    }

    // ── 决策收件箱（独立侧栏入口 + 右侧抽屉 / 独立 Slot）────────────────────
    // 数据与渲染都不依赖「瓮城」主面板：右侧 slot / 抽屉挂载时自轮询 /fang/api/decisions。
    const DECISION_INBOX = Object.freeze({ id: 'fang-decision-inbox', kind: 'fangDecisionInbox', label: '收件箱' })
    /** 插件 apply 时注入；主面板 Header 用它兜底打开收件箱（侧栏 Slot 不可用时）。 */
    let openInboxExternally = null
    const INBOX_LEVELS = Object.freeze([
      { level: 'red', label: '紧急决策', hint: '会阻塞 Agent' },
      { level: 'yellow', label: '建议决策', hint: '影响方向/进度' },
      { level: 'blue', label: '日常建议', hint: '可按推荐处理' },
      { level: 'green', label: '通知与汇报', hint: '默认折叠' },
      { level: 'gray', label: '已归档 / 过期', hint: '只读' },
    ])
    const INBOX_POLL_MS = 5000
    const inboxText = (value, max = 420) => {
      const text = String(value ?? '').trim()
      return text.length > max ? text.slice(0, max - 1) + '…' : text
    }
    function inboxButton(label, onClick, options = {}) {
      const node = h('button', {
        type: 'button',
        class: 'fang-inbox-btn' + (options.primary ? ' fang-inbox-btn--primary' : '') + (options.danger ? ' fang-inbox-btn--danger' : ''),
        disabled: options.disabled === true,
        title: options.title,
        'aria-label': options.ariaLabel,
      }, label)
      if (typeof onClick === 'function') node.addEventListener('click', (event) => { event.preventDefault(); onClick(event) })
      return node
    }

    const INBOX_SEEN_KEY = 'fang.inbox.seenRev'
    function readInboxSeenRev() {
      try {
        const value = Number(window?.localStorage?.getItem(INBOX_SEEN_KEY))
        return Number.isFinite(value) && value > 0 ? value : 0
      } catch { return 0 }
    }
    function writeInboxSeenRev(rev) {
      try { window?.localStorage?.setItem(INBOX_SEEN_KEY, String(rev)) } catch { /* local only */ }
    }

    /** 红色强提醒：页面内红色横幅 + 标题闪烁 +（已授权时）系统通知；同一 ticket 只提醒一次。 */
    function showRedDecisionAlert(ticket, store) {
      const doc = typeof document !== 'undefined' ? document : null
      if (!doc || !ticket?.id) return
      let stack = doc.querySelector('[data-fang-red-alerts]')
      if (!stack) {
        stack = h('div', { class: 'fang-red-alert-stack', 'data-fang-red-alerts': '1' })
        doc.body.append(stack)
      }
      if (stack.querySelector(`[data-red-ticket="${ticket.id}"]`)) return
      const remove = () => { node.remove(); if (!stack.childElementCount) stack.remove() }
      const node = h('div', {
        class: 'fang-inbox-red-alert', role: 'alert', 'data-red-ticket': ticket.id,
      },
      h('div', { class: 'fang-inbox-red-alert-title' }, icon('alert', 15), '红色决策待处理'),
      h('div', { class: 'fang-inbox-red-alert-body' }, inboxText(ticket.title, 120)),
      ticket.context ? h('div', { class: 'fang-inbox-red-alert-context' }, inboxText(ticket.context, 160)) : null,
      h('div', { class: 'fang-inbox-red-alert-actions' },
        inboxButton('打开收件箱', () => { remove(); store.openHandler?.() }, { primary: true }),
        inboxButton('关闭', remove)))
      stack.append(node)
      // 标题闪烁（不改回原值前先记下），10s 后恢复。
      try {
        const base = String(doc.title || '').replace(/^● 红色决策 · /, '')
        doc.title = '● 红色决策 · ' + base
        clearTimeout(showRedDecisionAlert._titleTimer)
        showRedDecisionAlert._titleTimer = setTimeout(() => {
          const current = String(doc.title || '')
          if (current.startsWith('● 红色决策 · ')) doc.title = current.replace('● 红色决策 · ', '')
        }, 10000)
      } catch { /* ignore */ }
      // 系统通知只在用户已授权时发；不在这里自动申请权限（避免打扰）。
      try {
        if (typeof window !== 'undefined' && window.Notification?.permission === 'granted') {
          const notice = new window.Notification('红色决策待处理', { body: inboxText(ticket.title, 120), tag: ticket.id, renotify: false })
          notice.onclick = () => { try { window.focus() } catch { /* ignore */ } remove() }
        }
      } catch { /* notification optional */ }
    }

    /** 收件箱唯一数据源：侧栏未读徽标 / 右侧 tab / 抽屉 共用。 */
    function createDecisionInboxStore() {
      const S = {
        state: 'idle', items: [], rev: 0, error: '', at: 0,
        streamState: 'idle', seenRev: readInboxSeenRev(), redPending: 0,
        selected: new Set(), collapsed: new Set(['green', 'gray']),
        batchFailures: [], batchFailuresKind: null,
        busy: '', notice: '',
        ai: { state: 'idle', configured: false, provider: null, model: null, providers: [], error: '' },
        aiTest: { state: 'idle', ok: null, message: '', latencyMs: 0 },
        aiStream: { id: '', text: '', state: '' },
      }
      const listeners = new Set()
      let timer = null
      let inflight = null
      let streamAbort = null
      let reconnectTimer = null
      let disposed = false
      let openHandler = null
      const emit = () => { for (const fn of [...listeners]) { try { fn(S) } catch { /* listener must not break */ } } }
      const pending = () => S.items.filter(item => item.status === 'pending')
      const ticketRev = (item) => Number(item?.rev) || 0
      // 未读计数 = pending 数：侧栏 badge、tab 标题、收件箱标题三处共用同一口径。
      // seenRev 仍保留用于“新 ticket 提醒”去重，但不参与 badge 计数。
      const unread = () => pending().length
      const syncBadges = () => {
        S.redPending = pending().filter(item => item.level === 'red').length
      }
      const snapshot = () => S
      const inboxOnScreen = () => {
        try {
          const doc = typeof document !== 'undefined' ? document : null
          if (!doc) return false
          if (doc.visibilityState === 'hidden') return false
          const node = doc.querySelector('[data-zone="decision-inbox"]')
          if (!node) return false
          return node.getClientRects?.().length > 0
        } catch { return false }
      }
      const markSeen = () => {
        const maxRev = S.items.reduce((max, item) => Math.max(max, ticketRev(item)), S.seenRev)
        if (maxRev <= S.seenRev) return
        S.seenRev = maxRev
        writeInboxSeenRev(maxRev)
        syncBadges()
        emit()
      }
      const mergeTickets = (incoming) => {
        const byId = new Map(S.items.map(item => [item.id, item]))
        const freshRed = []
        for (const item of incoming) {
          if (!item || !item.id) continue
          if (!byId.has(item.id) && item.status === 'pending' && item.level === 'red') freshRed.push(item)
          byId.set(item.id, item)
        }
        S.items = [...byId.values()]
        S.rev = S.items.reduce((max, item) => Math.max(max, ticketRev(item)), S.rev)
        syncBadges()
        return freshRed
      }
      const alertTarget = { get openHandler() { return openHandler } }
      const alertFresh = (freshRed) => {
        if (!freshRed.length) return
        if (inboxOnScreen()) { markSeen(); return }
        for (const ticket of freshRed) showRedDecisionAlert(ticket, alertTarget)
      }

      async function refresh() {
        if (inflight) return inflight
        inflight = (async () => {
          const query = '/fang/api/decisions?includeArchived=1' + (S.rev > 0 ? '&since=' + encodeURIComponent(String(S.rev)) : '')
          const [decisions, ai] = await Promise.all([
            api(query).catch((error) => ({ status: 0, body: null, diagnostic: { message: String(error?.message ?? error) } })),
            api('/fang/api/decisions/ai').catch(() => ({ status: 0, body: null })),
          ])
          if (decisions.status === 200 && decisions.body?.ok !== false) {
            const incoming = Array.isArray(decisions.body.items) ? decisions.body.items : []
            const freshRed = mergeTickets(incoming)
            S.rev = Math.max(S.rev, Number(decisions.body.rev) || 0)
            S.state = 'ready'; S.error = ''
            alertFresh(freshRed)
          } else {
            S.state = S.items.length ? 'stale' : 'error'
            S.error = decisions.body?.error || (decisions.status ? 'http-' + decisions.status : 'network')
          }
          if (ai.status === 200 && ai.body?.ok !== false) S.ai = { ...S.ai, ...ai.body, state: 'ready', error: '' }
          else S.ai = { ...S.ai, state: 'error', error: ai.body?.error || 'ai-unavailable' }
          const alive = new Set(pending().map(item => item.id))
          for (const id of [...S.selected]) if (!alive.has(id)) S.selected.delete(id)
          S.at = Date.now()
          emit()
        })()
        try { return await inflight } finally { inflight = null }
      }

      /** SSE：bus 事件 → 立即合并；断线 2.5s 重连；轮询仅作降级。 */
      async function connectStream() {
        if (disposed || streamAbort) return
        const controller = new AbortController()
        streamAbort = controller
        try {
          const token = await ensureFangAuthToken()
          const response = await fetch('/fang/api/decisions/events', {
            headers: { accept: 'text/event-stream', 'x-fang-auth': token },
            cache: 'no-store',
            signal: controller.signal,
          })
          if (!response.ok || !response.body?.getReader) throw new Error('stream-unavailable')
          S.streamState = 'open'
          emit()
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let index = buffer.indexOf('\n\n')
            while (index >= 0) {
              handleStreamFrame(buffer.slice(0, index))
              buffer = buffer.slice(index + 2)
              index = buffer.indexOf('\n\n')
            }
          }
          throw new Error('stream-closed')
        } catch (error) {
          if (controller.signal.aborted || disposed) return
          streamAbort = null
          S.streamState = 'retry'
          emit()
          clearTimeout(reconnectTimer)
          reconnectTimer = setTimeout(() => { if (!disposed && !streamAbort) void connectStream() }, 2500)
        }
      }

      function handleStreamFrame(raw) {
        let event = 'message'
        const dataLines = []
        for (const line of String(raw ?? '').split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
        }
        if (!dataLines.length) return
        let payload = null
        try { payload = JSON.parse(dataLines.join('\n')) } catch { return }
        if (event === 'ready') {
          S.streamState = 'open'
          S.rev = Math.max(S.rev, Number(payload?.rev) || 0)
          S.at = Date.now()
          emit()
          return
        }
        if (event === 'ticket' && payload?.ticket?.id) {
          const freshRed = mergeTickets([payload.ticket])
          S.state = 'ready'; S.error = ''
          S.at = Date.now()
          alertFresh(freshRed)
          emit()
        }
      }

      function start() {
        if (timer) return
        syncBadges()
        void refresh()
        void connectStream()
        // 降级轮询：SSE 正常时也低频兜底（SSE 掉线时由重连补齐，最多 30s 的空窗）。
        timer = setInterval(() => {
          try { if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return } catch { /* ignore */ }
          if (S.streamState === 'open') return
          void refresh()
        }, INBOX_POLL_MS)
      }
      function stop() {
        disposed = true
        if (timer) clearInterval(timer)
        timer = null
        clearTimeout(reconnectTimer)
        reconnectTimer = null
        try { streamAbort?.abort() } catch { /* ignore */ }
        streamAbort = null
      }
      function subscribe(fn) { listeners.add(fn); try { fn(S) } catch { /* ignore */ } return () => listeners.delete(fn) }
      async function act(label, run) {
        if (S.busy) return null
        S.busy = label; S.notice = ''; emit()
        try {
          const result = await run()
          if (result?.status === 200 && result.body?.ok !== false) {
            S.notice = result.body?.ok === false ? '' : 'ok'
          } else {
            S.notice = 'err:' + (result?.body?.error || result?.body?.reason || (result?.status ? 'http-' + result.status : 'network'))
          }
          return result
        } finally {
          S.busy = ''
          await refresh().catch(() => {})
        }
      }
      async function runBatch(label, request) {
        if (S.busy) return null
        const ids = [...S.selected].filter(id => pending().some(item => item.id === id))
        if (!ids.length) { S.notice = 'err:no-selected'; emit(); return null }
        S.busy = label; S.notice = ''; S.batchFailures = []
        S.batchFailuresKind = label === 'batch-archive' ? 'archive' : 'resolve'
        emit()
        try {
          const result = await request(ids)
          const rows = Array.isArray(result?.body?.results) ? result.body.results : []
          S.batchFailures = rows
            .filter(row => row.ok === false)
            .map(row => ({
              id: String(row.id ?? ''),
              reason: String(row.reason ?? 'failed'),
              title: String(S.items.find(item => item.id === row.id)?.title ?? row.id ?? ''),
            }))
          if (result?.status === 200) S.notice = S.batchFailures.length ? '' : 'ok'
          else S.notice = 'err:' + (result?.body?.error || (result?.status ? 'http-' + result.status : 'network'))
          return result
        } finally {
          S.busy = ''
          await refresh().catch(() => {})
        }
      }
      async function runAiTest(input) {
        S.aiTest = { state: 'testing', ok: null, message: '正在测试连接…', latencyMs: 0 }
        S.busy = 'ai-test'; emit()
        try {
          const result = await api('/fang/api/decisions/ai/test', { method: 'POST', body: JSON.stringify(input ?? {}) })
          const body = result?.body ?? {}
          if (result?.status === 200 && body.ok !== false) {
            S.aiTest = {
              state: 'ok', ok: true,
              message: `连接成功 · ${body.provider || input?.provider || 'AI'} / ${body.model || '—'} · ${Number(body.latencyMs) || 0}ms`,
              latencyMs: Number(body.latencyMs) || 0,
            }
          } else {
            S.aiTest = {
              state: 'err', ok: false,
              message: failureHint(body.reason || body.error || (result?.status ? 'http-' + result.status : 'network')),
              latencyMs: 0,
            }
          }
          return result
        } catch (error) {
          S.aiTest = { state: 'err', ok: false, message: String(error?.message ?? error), latencyMs: 0 }
          return null
        } finally {
          S.busy = ''
          emit()
        }
      }
      async function saveAiWithTest(input) {
        // 保存前先真实调用一次；测试失败绝不启用（避免“保存即启用”的假成功）。
        const tested = await runAiTest(input)
        if (!(tested?.status === 200 && tested.body?.ok !== false)) {
          S.notice = 'err:ai-test-failed'; emit(); return null
        }
        return act('ai-config', () => api('/fang/api/decisions/ai/config', {
          method: 'POST', body: JSON.stringify(input ?? {}),
        }))
      }
      async function runAdviseStream(id) {
        if (S.busy) return null
        S.busy = 'ai-advise-stream'
        S.aiStream = { id: String(id), text: '', state: 'running' }
        emit()
        try {
          const token = await ensureFangAuthToken()
          const response = await fetch('/fang/api/decisions/ai/advise/stream', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-fang-auth': token },
            body: JSON.stringify({ id }),
          })
          if (!response.ok || !response.body?.getReader) {
            S.aiStream = { id: '', text: '', state: '' }
            S.busy = ''
            emit()
            return act('ai-advise', () => api('/fang/api/decisions/ai/advise', { method: 'POST', body: JSON.stringify({ id }) }))
          }
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let index = buffer.indexOf('\n\n')
            while (index >= 0) {
              const raw = buffer.slice(0, index)
              buffer = buffer.slice(index + 2)
              index = buffer.indexOf('\n\n')
              let event = 'message'
              const dataLines = []
              for (const line of raw.split('\n')) {
                if (line.startsWith('event:')) event = line.slice(6).trim()
                else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
              }
              if (!dataLines.length) continue
              let payload = null
              try { payload = JSON.parse(dataLines.join('\n')) } catch { continue }
              if (event === 'delta' && typeof payload?.text === 'string') {
                S.aiStream = { ...S.aiStream, text: payload.text.slice(0, 4000), state: 'running' }
                emit()
              } else if (event === 'error') {
                S.notice = 'err:' + (payload?.reason || payload?.error || 'ai-failed')
              }
            }
          }
          S.aiStream = { id: S.aiStream.id, text: S.aiStream.text, state: 'done' }
          return true
        } catch (error) {
          S.notice = 'err:' + String(error?.message ?? error)
          return null
        } finally {
          S.busy = ''
          emit()
          await refresh().catch(() => {})
        }
      }
      return {
        id: DECISION_INBOX.id,
        kind: DECISION_INBOX.kind,
        state: S,
        pending, unread, snapshot, start, stop, subscribe, refresh,
        markSeen,
        streamState: () => S.streamState,
        setOpenHandler(fn) { openHandler = typeof fn === 'function' ? fn : null },
        get openHandler() { return openHandler },
        toggleSelected(id) { if (S.selected.has(id)) S.selected.delete(id); else S.selected.add(id); emit() },
        setNotice(text) { S.notice = String(text ?? ''); emit() },
        clearSelected() { S.selected.clear(); emit() },
        toggleCollapsed(level) { if (S.collapsed.has(level)) S.collapsed.delete(level); else S.collapsed.add(level); emit() },
        collapseAll(all) { S.collapsed = new Set(all ? INBOX_LEVELS.map(item => item.level) : []); emit() },
        /** 分组头三态全选：未选 → 全选；部分/全选 → 全选；全选再点 → 清空本组。 */
        toggleGroupSelected(level) {
          const items = pending().filter(item => item.level === level)
          if (!items.length) return
          const all = items.every(item => S.selected.has(item.id))
          for (const item of items) {
            if (all) S.selected.delete(item.id)
            else S.selected.add(item.id)
          }
          emit()
        },
        selectRecommended() {
          for (const item of pending()) {
            if (item.level === 'green' || item.options?.some(option => option.isRecommended)) S.selected.add(item.id)
          }
          emit()
        },
        selectAllPending() {
          for (const item of pending()) S.selected.add(item.id)
          emit()
        },
        clearBatchFailures() { S.batchFailures = []; emit() },
        resolve(id, option) {
          return act('resolve', () => api('/fang/api/decisions/resolve', {
            method: 'POST', body: JSON.stringify({ id, option, by: 'fang-inbox' }),
          }))
        },
        /** v3.1.13：会话内直接输入决定（不要求命中预置选项）。 */
        resolveCustom(id, text) {
          const custom = String(text ?? '').trim()
          if (!custom) return Promise.resolve({ ok: false, error: 'custom-required' })
          return act('resolve-custom', () => api('/fang/api/decisions/resolve', {
            method: 'POST', body: JSON.stringify({ id, custom: custom.slice(0, 2000), by: 'fang-relay' }),
          }))
        },
        abandon(id) {
          return act('abandon', () => api('/fang/api/decisions/abandon', {
            method: 'POST', body: JSON.stringify({ id, by: 'fang-inbox' }),
          }))
        },
        resolveSelected() {
          return runBatch('batch-resolve', (ids) => api('/fang/api/decisions/resolve', {
            method: 'POST', body: JSON.stringify({ ids, by: 'fang-inbox' }),
          }))
        },
        archiveSelected() {
          return runBatch('batch-archive', (ids) => api('/fang/api/decisions/abandon', {
            method: 'POST', body: JSON.stringify({ ids, by: 'fang-inbox' }),
          }))
        },
        retryFailures() {
          const ids = [...new Set(S.batchFailures.map(failure => failure.id))]
            .filter(id => pending().some(item => item.id === id))
          const kind = S.batchFailuresKind === 'archive' ? 'archive' : 'resolve'
          S.batchFailures = []
          S.selected = new Set(ids)
          emit()
          if (!ids.length) return Promise.resolve(null)
          const path = kind === 'archive' ? '/fang/api/decisions/abandon' : '/fang/api/decisions/resolve'
          return runBatch(kind === 'archive' ? 'batch-archive' : 'batch-resolve', (nextIds) => api(path, {
            method: 'POST', body: JSON.stringify({ ids: nextIds, by: 'fang-inbox' }),
          }))
        },
        configureAi(input) {
          return act('ai-config', () => api('/fang/api/decisions/ai/config', {
            method: 'POST', body: JSON.stringify(input),
          }))
        },
        testAi(input) { return runAiTest(input) },
        saveAiWithTest(input) { return saveAiWithTest(input) },
        adviseStream(id) { return runAdviseStream(id) },
        advise(id) {
          return act('ai-advise', () => api('/fang/api/decisions/ai/advise', {
            method: 'POST', body: JSON.stringify({ id }),
          }))
        },
      }
    }

    // ── 会话内决策中继（v3.1.13）────────────────────────────────────────
    // 每个会话右侧悬浮一个「待选」按钮（仅母体角色、仅当该会话有待决策时出现）；
    // 点击从右向左滑出决策栏：预置选项按 A/B/C/D 展示，也可直接输入决定。
    const RELAY_LEVEL_LABEL = Object.freeze({ red: '红', yellow: '黄', blue: '蓝', green: '绿', gray: '灰' })
    function relayPendingFor(store, sessionId) {
      const items = typeof store?.pending === 'function' ? store.pending() : []
      return (Array.isArray(items) ? items : []).filter((ticket) => {
        const source = ticket?.source && typeof ticket.source === 'object' ? ticket.source : {}
        return String(source.sessionId ?? '') === String(sessionId)
      })
    }
    function mountDecisionRelay(host, store, sessionId) {
      if (typeof document === 'undefined' || !store || !sessionId) return () => {}
      const doc = host?.ownerDocument ?? document
      try { injectStyle(doc) } catch { /* style optional */ }
      const sid = String(sessionId)
      const state = { open: false, busy: false, error: '', customs: new Map() }
      let fab = null
      let countEl = null
      let panel = null
      let backdrop = null
      let unsubscribe = null
      let keyHandler = null
      let onDocPointerDown = null
      let disposed = false
      const current = () => relayPendingFor(store, sid)
      const setOpen = (next) => {
        state.open = next === true
        if (panel) panel.classList.toggle('is-open', state.open)
        if (backdrop) backdrop.classList.toggle('is-open', state.open)
        if (state.open) render()
      }
      const onKey = (event) => {
        if (state.open && (event.key === 'Escape' || event.key === 'Esc')) { event.stopPropagation(); setOpen(false) }
      }
      const submitOption = async (ticket, option) => {
        if (state.busy) return
        state.busy = true; state.error = ''
        render()
        try {
          const result = await store.resolve(ticket.id, option?.value)
          if (result && result.ok === false) state.error = '提交失败：' + String(result.reason ?? result.error ?? 'resolve-failed')
          else {
            state.customs.delete(String(ticket.id))
            if (typeof store.refresh === 'function') await Promise.resolve(store.refresh()).catch(() => {})
            // 选完立刻收起为小浮标（用户要求：不占工作区）
            setOpen(false)
          }
        } catch (error) { state.error = '提交失败：' + String(error?.message ?? error) } finally {
          state.busy = false
          render()
        }
      }
      const submitCustom = async (ticket) => {
        if (state.busy) return
        const text = String(state.customs.get(String(ticket.id)) ?? '').trim()
        if (!text) { state.error = '请先输入你的决定'; render(); return }
        state.busy = true; state.error = ''
        render()
        try {
          if (typeof store.resolveCustom !== 'function') throw new Error('resolve-custom-unavailable')
          const result = await store.resolveCustom(ticket.id, text)
          if (result && result.ok === false) state.error = '提交失败：' + String(result.reason ?? result.error ?? 'resolve-failed')
          else {
            state.customs.delete(String(ticket.id))
            if (typeof store.refresh === 'function') await Promise.resolve(store.refresh()).catch(() => {})
            // 选完立刻收起为小浮标（用户要求：不占工作区）
            setOpen(false)
          }
        } catch (error) { state.error = '提交失败：' + String(error?.message ?? error) } finally {
          state.busy = false
          render()
        }
      }
      const optionButton = (ticket, option, index) => {
        const key = index < 26 ? String.fromCharCode(65 + index) : String(index + 1)
        const label = String(option?.label ?? option?.value ?? '选项')
        return h('button', {
          type: 'button', class: 'fang-relay-option', disabled: state.busy || undefined,
          'data-option-key': key, title: option?.isRecommended ? ('推荐：' + label) : label,
          onClick: () => void submitOption(ticket, option),
        }, h('span', { class: 'fang-relay-key' }, key), h('span', { class: 'fang-relay-option-label' }, label))
      }
      const ticketNode = (ticket) => {
        const level = String(ticket?.level ?? 'gray')
        const options = Array.isArray(ticket?.options) ? ticket.options : []
        const id = String(ticket?.id ?? '')
        const inputValue = state.customs.get(id) ?? ''
        return h('div', { class: 'fang-relay-ticket', 'data-decision-id': id },
          h('div', { class: 'fang-relay-ticket-head' },
            h('span', { class: 'fang-relay-level fang-relay-level--' + level }, RELAY_LEVEL_LABEL[level] ?? level),
            h('span', { class: 'fang-relay-ticket-title' }, String(ticket?.title ?? '待决策'))),
          ticket?.context ? h('div', { class: 'fang-relay-context' }, String(ticket.context)) : null,
          h('div', { class: 'fang-relay-options' },
            options.length > 0
              ? options.map((option, index) => optionButton(ticket, option, index))
              : [h('button', {
                  type: 'button', class: 'fang-relay-option', disabled: state.busy || undefined,
                  onClick: () => void submitOption(ticket, { value: '__ACK__' }),
                }, h('span', { class: 'fang-relay-key' }, '✓'), h('span', null, '确认收到（ACK）'))]),
          h('div', { class: 'fang-relay-custom' },
            h('input', {
              class: 'fang-relay-input', placeholder: '或输入你的决定…', 'aria-label': '输入决定',
              value: inputValue,
              onInput: (event) => state.customs.set(id, String(event.target?.value ?? '')),
              onKeydown: (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submitCustom(ticket) } },
            }),
            h('button', { type: 'button', class: 'fang-relay-submit', disabled: state.busy || undefined, onClick: () => void submitCustom(ticket) }, '提交')))
      }
      function render() {
        if (disposed) return
        const tickets = current()
        if (countEl && fab) {
          countEl.textContent = tickets.length > 99 ? '99+' : String(tickets.length)
          // v3.1.24：入口常驻（0 时半透明），否则用户"一整天都看不到决策中心"
          fab.hidden = false
          fab.classList.toggle('is-empty', tickets.length === 0)
          fab.setAttribute('aria-label', tickets.length > 0 ? `当前会话有 ${tickets.length} 个待决策` : '当前会话没有待决策（点击查看决策中心）')
        }
        if (!panel) return
        const head = h('div', { class: 'fang-relay-head' },
          h('span', { class: 'fang-relay-title' }, '决策中继'),
          h('span', { class: 'fang-relay-sub' }, `会话 ${short(sid, 10)} · ${tickets.length} 个待选`),
          h('button', { type: 'button', class: 'fang-relay-close', title: '关闭', 'aria-label': '关闭决策中继', onClick: () => setOpen(false) }, '×'))
        const body = h('div', { class: 'fang-relay-body' })
        if (tickets.length === 0) {
          body.append(h('div', { class: 'fang-relay-empty' }, '当前会话没有待决策；有新的阻塞问题时这里会自动出现。'))
        } else {
          for (const ticket of tickets) body.append(ticketNode(ticket))
        }
        if (state.error) body.append(h('div', { class: 'fang-relay-error', role: 'alert' }, state.error))
        panel.replaceChildren(head, body)
      }
      const ensureChrome = () => {
        if (fab || disposed) return
        countEl = h('span', { class: 'fang-relay-count' }, '0')
        fab = h('button', {
          type: 'button', class: 'fang-relay-fab', title: '决策中继：当前会话的待决策',
          'aria-label': '打开当前会话决策中继', 'aria-haspopup': 'dialog',
        }, h('span', { 'aria-hidden': 'true', style: { fontSize: '15px', lineHeight: 1 } }, '◈'), h('span', null, '待选'), countEl)
        panel = h('aside', { class: 'fang-relay-panel', role: 'dialog', 'aria-modal': 'false', 'aria-label': '当前会话决策中继' })
        doc.body.append(fab, panel)
        fab.addEventListener('click', () => setOpen(!state.open))
        // 用户要求：不遮挡会话/工作区，点浮窗以外任何地方即收起为小浮标
        onDocPointerDown = (event) => {
          if (disposed || !state.open) return
          const target = event.target
          try {
            if (panel && panel.contains(target)) return
            if (fab && fab.contains(target)) return
            setOpen(false)
          } catch { /* ignore */ }
        }
        doc.addEventListener('pointerdown', onDocPointerDown, true)
        keyHandler = onKey
        doc.addEventListener('keydown', keyHandler, true)
        unsubscribe = typeof store.subscribe === 'function' ? store.subscribe(render) : null
        render()
      }
      void (async () => {
        try {
          const role = await detectWebRole()
          if (disposed || role !== 'mother') return
          ensureChrome()
        } catch { /* 非母体或识别失败：不显示中继 */ }
      })()
      return () => {
        disposed = true
        if (unsubscribe) { try { unsubscribe() } catch { /* ignore */ } unsubscribe = null }
        if (keyHandler) { try { doc.removeEventListener('keydown', keyHandler, true) } catch { /* ignore */ } keyHandler = null }
        if (onDocPointerDown) { try { doc.removeEventListener('pointerdown', onDocPointerDown, true) } catch { /* ignore */ } onDocPointerDown = null }
        for (const node of [fab, backdrop, panel]) { try { node?.remove() } catch { /* ignore */ } }
        fab = null; backdrop = null; panel = null; countEl = null
      }
    }

    function mountInboxTitle(host, store) {
      const doc = host.ownerDocument
      injectStyle(doc)
      const render = () => {
        const n = store.unread()
        host.replaceChildren(h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600 } },
          '收件箱',
          n > 0 ? h('span', { class: 'fang-inbox-unread' }, n > 99 ? '99+' : String(n)) : null))
      }
      const unsubscribe = store.subscribe(render)
      render()
      return () => { unsubscribe(); host.replaceChildren() }
    }

    /** 左侧栏独立入口：图标 + 未读红点；点击打开右侧收件箱。 */
    function mountInboxSeat(host, store, open) {
      const doc = host.ownerDocument
      injectStyle(doc)
      const badge = h('span', { class: 'fang-inbox-badge', 'aria-hidden': 'true' })
      const button = h('button', {
        type: 'button', class: 'fang-inbox-seat',
        'data-fang-entry': 'decision-inbox',
        title: '决策收件箱', 'aria-label': '决策收件箱',
        onClick: (event) => { event.preventDefault(); event.stopPropagation(); open() },
      }, icon('inbox', 17), badge)
      host.replaceChildren(button)
      const render = () => {
        const n = store.unread()
        badge.textContent = n > 99 ? '99+' : String(n)
        badge.style.display = n > 0 ? 'block' : 'none'
        button.classList.toggle('has-red', store.state.redPending > 0)
        button.title = store.state.redPending > 0
          ? `决策收件箱：${n} 条待处理，其中 ${store.state.redPending} 条红色待处理`
          : (n > 0 ? `决策收件箱：${n} 条待处理` : '决策收件箱：暂无待处理')
      }
      const unsubscribe = store.subscribe(render)
      render()
      return () => { unsubscribe(); host.replaceChildren() }
    }

    function openInboxDrawer(store) {
      const doc = typeof document !== 'undefined' ? document : null
      if (!doc) return
      const existing = doc.querySelector('[data-fang-inbox-drawer]')
      if (existing) { existing.classList.add('is-open'); existing.querySelector('button')?.focus?.(); return }
      const backdrop = h('div', { class: 'fang-inbox-backdrop', 'data-fang-inbox-backdrop': '1' })
      const panel = h('aside', { class: 'fang-inbox-drawer', 'data-fang-inbox-drawer': '1', role: 'dialog', 'aria-modal': 'true', 'aria-label': '决策收件箱' })
      let teardown = null
      const close = () => {
        try { teardown?.() } catch { /* ignore */ }
        backdrop.remove(); panel.remove()
        doc.removeEventListener('keydown', onKey, true)
        try { window.removeEventListener('resize', onResize) } catch { /* ignore */ }
      }
      const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); close() } }
      const onResize = () => { if (!doc.body.contains(panel)) close() }
      backdrop.addEventListener('click', close)
      doc.body.append(backdrop, panel)
      teardown = mountDecisionInbox(panel, store, { drawer: true, onClose: close })
      doc.addEventListener('keydown', onKey, true)
      try { window.addEventListener('resize', onResize) } catch { /* ignore */ }
      try {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => panel.classList.add('is-open'))
        else panel.classList.add('is-open')
      } catch { panel.classList.add('is-open') }
      try {
        const active = doc.activeElement
        if (active && typeof active.blur === 'function') active.blur()
      } catch { /* ignore */ }
    }

    /** 收件箱主体：可折叠分组 + 未读计数 + 键盘导航 + 批量操作。 */
    function mountDecisionInbox(host, store, options = {}) {
      const doc = host.ownerDocument
      injectStyle(doc)
      const state = store.state
      let activeId = ''
      let disposed = false
      let aiOpen = false
      const root = h('div', {
        class: 'fang-inbox', tabindex: 0, role: 'region', 'aria-label': '决策收件箱',
        'data-zone': 'decision-inbox', 'data-drawer': options.drawer ? '1' : '0',
      })
      host.replaceChildren(root)
      try { host.style.height = host.style.height || '100%' } catch { /* ignore */ }
      try { host.style.minHeight = '0' } catch { /* ignore */ }

      const focusRoot = () => { try { root.focus({ preventScroll: true }) } catch { root.focus?.() } }
      const pickOption = (item) => {
        const recommended = item.options?.find(option => option.isRecommended)
        if (recommended) return recommended.value
        if (item.options?.length) return item.options[0].value
        return '__ACK__'
      }
      const sourceText = (item) => {
        const source = item?.source || {}
        const role = source.agentRole || 'worker'
        const trusted = source.roleTrusted === true || String(source.roleSource || '').startsWith('host:')
        const name = source.taskName || (source.sessionId && source.sessionId !== 'unknown' ? short(source.sessionId, 10) : '')
        return `${role}${trusted ? '' : '（自报）'}${name ? ' · ' + name : ''}`
      }
      const visiblePending = () => {
        const list = []
        for (const level of INBOX_LEVELS) {
          if (level.level === 'gray' || state.collapsed.has(level.level)) continue
          for (const item of state.items) {
            if (item.status === 'pending' && item.level === level.level) list.push(item)
          }
        }
        return list
      }

      function itemNode(item, archived = false) {
        const selected = state.selected.has(item.id)
        const busy = state.busy === 'resolve' || state.busy === 'abandon' || state.busy === 'batch'
        const node = h('div', {
          class: 'fang-inbox-item' + (activeId === item.id ? ' is-active' : ''),
          'data-level': item.level, 'data-inbox-id': item.id, role: 'listitem',
          onClick: () => { activeId = item.id; render() },
        },
        archived ? null : h('input', {
          type: 'checkbox', class: 'fang-inbox-check', checked: selected,
          'aria-label': `选择：${item.title || item.id}`,
          onClick: (event) => event.stopPropagation(),
          onChange: () => { store.toggleSelected(item.id); focusRoot() },
        }),
        h('div', { class: 'fang-inbox-main' },
          h('div', { class: 'fang-inbox-item-title' }, inboxText(item.title) || item.id,
            item.budgetDemoted ? h('span', { class: 'chip', style: { marginLeft: 6, fontSize: 10 }, title: '全库 pending red 超限，已降级为黄色' }, '预算降级') : null,
            item.attentionDemoted
              ? h('span', {
                class: 'chip', style: { marginLeft: 6, fontSize: 10 },
                title: `注意力配额不足（${item.attentionQuota?.scope === 'source' ? '来源' : '全库'} ${item.attentionQuota?.used ?? '?'}/${item.attentionQuota?.limit ?? '?'}），已降一级`,
              }, '注意力降级')
              : null),
          item.context ? h('div', { class: 'fang-inbox-item-context' }, inboxText(item.context)) : null,
          h('div', { class: 'fang-inbox-meta' }, `${sourceText(item)} · ${fmtRelative(item.createdAt)}${item.expiresAt ? ' · 到期 ' + fmtRelative(item.expiresAt) : ''}`),
          item.ai ? h('div', { class: 'fang-inbox-ai-advice' },            h('span', { class: 'fang-inbox-ai-tag' }, 'AI · 未核实'),
            `${item.ai.summary || ''}${item.ai.recommendation ? ' · 推荐：' + item.ai.recommendation : ''}`,
            Array.isArray(item.ai.optionRisks) && item.ai.optionRisks.length
              ? h('div', { class: 'fang-inbox-ai-risks' },
                ...item.ai.optionRisks.map(risk => h('span', {
                  class: 'fang-inbox-risk fang-inbox-risk--' + String(risk.risk || 'unknown'),
                  title: risk.reason || '',
                }, `${risk.value}: ${({ low: '低', medium: '中', high: '高' })[risk.risk] || risk.risk}`)))
              : null,
            Array.isArray(item.ai.missingInfo) && item.ai.missingInfo.length
              ? h('div', { class: 'fang-inbox-ai-missing' }, '缺失信息：' + item.ai.missingInfo.join('、'))
              : null) : null,
          item.execution
            ? h('div', {
              class: 'fang-inbox-exec fang-inbox-exec--' + String(item.execution.status || 'unknown'),
              title: item.execution.error || '',
            }, `动作 ${item.execution.actionId || '?'}：${({ running: '执行中…', done: '已执行', failed: '执行失败' })[item.execution.status] || item.execution.status}`)
            : null,
          state.aiStream?.id === item.id && state.aiStream.text
            ? h('div', { class: 'fang-inbox-ai-stream' }, state.aiStream.text)
            : null,
          archived ? null : h('div', { class: 'fang-inbox-item-actions' },
            ...(item.options?.length
              ? item.options.slice(0, 5).map(option => inboxButton(option.label || option.value, () => void store.resolve(item.id, option.value), {
                primary: option.isRecommended === true, disabled: busy,
              }))
              : [inboxButton('知道了', () => void store.resolve(item.id, '__ACK__'), { primary: true, disabled: busy })]),
            inboxButton('AI 建议', () => void store.adviseStream(item.id), { title: 'AI 建议（流式，失败自动回落一次性）', disabled: busy || state.ai.configured !== true }),
            inboxButton('忽略', () => void store.abandon(item.id), { danger: true, disabled: busy }))))
        return node
      }

      function aiPanel() {
        const ai = state.ai || {}
        const configured = ai.configured === true
        const persistence = ai.persistence || {}
        const quota = ai.quota || {}
        const circuit = ai.circuit || {}
        const testState = state.aiTest || { state: 'idle', message: '' }
        const readFields = () => ({
          provider: String(root.querySelector('[data-inbox-ai="provider"]')?.value || 'deepseek'),
          apiKey: String(root.querySelector('[data-inbox-ai="apiKey"]')?.value || '').trim(),
          model: String(root.querySelector('[data-inbox-ai="model"]')?.value || '').trim() || undefined,
          baseUrl: String(root.querySelector('[data-inbox-ai="baseUrl"]')?.value || '').trim() || undefined,
        })
        const persistenceText = persistence.enabled === false
          ? 'Key 持久化：关闭（仅内存）'
          : (persistence.available
            ? `Key 持久化：${persistence.backend}${persistence.saved ? ' · 已保存' : ''}`
            : `Key 持久化：不可用（${persistence.reason || 'backend-unavailable'}）→ 仅内存`)
        const hostText = ai.endpointHost ? ` · 发往 ${ai.endpointHost}` : ''
        const quotaText = `今日 AI：${quota.used ?? 0}/${quota.limit ? quota.limit : '∞'}`
        const usage = ai.usage || {}
        const tokenText = (usage.promptTokens || usage.completionTokens)
          ? `tokens ${Number(usage.promptTokens || 0) + Number(usage.completionTokens || 0)}${usage.costMicros !== null && usage.costMicros !== undefined ? ` · $${(Number(usage.costMicros) / 1e6).toFixed(4)}` : ''}`
          : ''
        const circuitText = circuit.state === 'open'
          ? `熔断：开（${Math.ceil((circuit.retryAfterMs || 0) / 1000)}s）`
          : '熔断：关'
        return h('details', { class: 'fang-inbox-ai', open: aiOpen, onToggle: (event) => { aiOpen = event.target.open } },
          h('summary', null, configured ? `AI：${ai.provider || 'custom'} / ${ai.model || '—'}` : 'AI 智能建议（需配置自有 API Key）'),
          h('div', { class: 'fang-inbox-ai-status' }, `${persistenceText}${hostText} · ${quotaText}${tokenText ? ' · ' + tokenText : ''} · ${circuitText}`),
          h('div', { class: 'fang-inbox-ai-row' },
            h('select', { 'data-inbox-ai': 'provider', 'aria-label': '模型提供商' },
              ...((Array.isArray(ai.providers) && ai.providers.length ? ai.providers : [{ id: 'deepseek', label: 'DeepSeek' }]).map(provider =>
                h('option', { value: provider.id }, provider.label || provider.id)))),
            h('input', {
              'data-inbox-ai': 'apiKey', type: 'password', autocomplete: 'off',
              placeholder: configured ? '新 API Key（更换时填写）' : 'API Key', 'aria-label': '模型 API Key',
            }),
            h('input', { 'data-inbox-ai': 'model', type: 'text', placeholder: '模型（可留空）', autocomplete: 'off', 'aria-label': '模型名' }),
            h('input', { 'data-inbox-ai': 'baseUrl', type: 'url', placeholder: 'Base URL（可留空）', autocomplete: 'off', 'aria-label': '模型 Base URL' }),
            inboxButton('测试连接', () => {
              const fields = readFields()
              if (!fields.apiKey) { store.setNotice('err:api-key-required'); return }
              void store.testAi(fields)
            }),
            inboxButton(configured ? '测试并更换' : '测试并保存启用', () => {
              const fields = readFields()
              if (!fields.apiKey) { store.setNotice('err:api-key-required'); return }
              void store.saveAiWithTest(fields)
            }, { primary: true })),
          testState.message
            ? h('div', { class: 'fang-inbox-ai-test fang-inbox-ai-test--' + String(testState.state || 'idle') }, testState.message)
            : null)
      }

      function groupNode(levelMeta) {
        const level = levelMeta.level
        const archived = level === 'gray'
        const items = state.items.filter(item => archived ? item.status !== 'pending' : (item.status === 'pending' && item.level === level))
        if (!items.length) return null
        const collapsed = state.collapsed.has(level)
        const unread = archived ? 0 : items.length
        const allSelected = !archived && items.every(item => state.selected.has(item.id))
        const someSelected = !archived && !allSelected && items.some(item => state.selected.has(item.id))
        let check = null
        if (!archived) {
          check = h('input', {
            type: 'checkbox', class: 'fang-inbox-group-check', 'data-group-select': level,
            checked: allSelected || undefined,
            title: allSelected ? `取消全选「${levelMeta.label}」` : `全选「${levelMeta.label}」（${items.length} 项）`,
            'aria-label': `全选${levelMeta.label}分组`,
            onClick: (event) => event.stopPropagation(),
            onChange: () => { store.toggleGroupSelected(level); focusRoot() },
          })
          check.indeterminate = someSelected
        }
        return h('div', { class: 'fang-inbox-group', 'data-level': level },
          h('div', {
            class: 'fang-inbox-group-head',
            onClick: (event) => {
              if (event.target?.closest?.('input')) return
              store.toggleCollapsed(level); focusRoot()
            },
          },
          check,
          h('button', {
            type: 'button', class: 'fang-inbox-group-toggle',
            'aria-expanded': collapsed ? 'false' : 'true',
          },
          h('b', null, levelMeta.label),
          h('span', { style: { fontSize: 11, color: 'inherit', opacity: .8 } }, levelMeta.hint),
          h('span', { class: 'n' }, `${unread} 项 · ${collapsed ? '展开' : '收起'}`))),
          collapsed ? null : h('div', { role: 'list' }, ...items.slice(0, archived ? 80 : 200).map(item => itemNode(item, archived))))
      }

      /** 批量确认弹窗：返回 Promise<boolean>；Esc/取消/点遮罩 = false。 */
      function confirmBatchDialog({ title, message, detail, confirmLabel = '确认', danger = false }) {
        return new Promise((resolve) => {
          const overlay = h('div', { class: 'fang-inbox-confirm', role: 'presentation' })
          const finish = (value) => {
            try { overlay.remove() } catch { /* ignore */ }
            try { root.removeEventListener('keydown', onConfirmKey, true) } catch { /* ignore */ }
            resolve(value)
          }
          const onConfirmKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false) } }
          const card = h('div', { class: 'fang-inbox-confirm-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
            h('div', { class: 'fang-inbox-confirm-title' }, title),
            h('div', { class: 'fang-inbox-confirm-msg' }, message),
            detail ? h('div', { class: 'fang-inbox-confirm-detail' }, detail) : null,
            h('div', { class: 'fang-inbox-confirm-actions' },
              inboxButton('取消', () => finish(false)),
              inboxButton(confirmLabel, () => finish(true), { primary: !danger, danger })))
          overlay.append(card)
          overlay.addEventListener('click', (event) => { if (event.target === overlay) finish(false) })
          root.append(overlay)
          root.addEventListener('keydown', onConfirmKey, true)
          try { card.querySelector('button')?.focus?.() } catch { /* ignore */ }
        })
      }

      async function runBatchWithConfirm(kind) {
        const ids = [...state.selected]
        if (!ids.length) { store.setNotice('err:no-selected'); return }
        const selectedItems = state.items.filter((item) => ids.includes(item.id))
        const redCount = selectedItems.filter((item) => item.level === 'red' || item.isBlocking === true).length
        const ok = await confirmBatchDialog({
          title: kind === 'archive' ? '批量归档选中项？' : '批量按推荐处理选中项？',
          message: `将处理 ${ids.length} 项${redCount > 0 ? `，其中 ${redCount} 项是红色/阻塞项（服务端会拒绝，需逐条处理）` : ''}。`,
          detail: selectedItems.slice(0, 3).map((item) => `· ${item.title || item.id}`).join('\n') + (ids.length > 3 ? `\n… 另有 ${ids.length - 3} 项` : ''),
          confirmLabel: kind === 'archive' ? '归档' : '处理',
          danger: kind === 'archive',
        })
        if (!ok) return
        if (kind === 'archive') void store.archiveSelected()
        else void store.resolveSelected()
      }

      function render() {
        if (disposed) return
        const pending = store.pending()
        const selectedCount = state.selected.size
        const unread = pending.length
        const head = h('div', { class: 'fang-inbox-head' },
          h('div', { class: 'fang-inbox-title' }, icon('inbox', 16), '收件箱',
            unread > 0 ? h('span', { class: 'fang-inbox-unread' }, unread > 99 ? '99+' : String(unread)) : null),
          h('div', { class: 'fang-inbox-actions' },
            inboxButton('刷新', () => void store.refresh(), { disabled: state.busy !== '' }),
            inboxButton(state.collapsed.size ? '展开全部' : '收起全部', () => { store.collapseAll(state.collapsed.size === 0); focusRoot() }),
            options.drawer ? inboxButton('关闭', () => options.onClose?.()) : null))
        const toolbar = h('div', { class: 'fang-inbox-toolbar' },
          h('span', { class: 'fang-inbox-hint' }, `待处理 ${unread} · 已选 ${selectedCount}`),
          h('span', { class: 'fang-inbox-stream', title: state.streamState === 'open' ? 'SSE 实时推送已连接' : 'SSE 未连接，使用低频轮询兜底' },
            state.streamState === 'open' ? '● 实时' : '○ 轮询'),
          inboxButton('处理选中', () => void runBatchWithConfirm('resolve'), { primary: true, disabled: selectedCount === 0 || state.busy !== '' }),
          inboxButton('归档选中', () => void runBatchWithConfirm('archive'), { danger: true, disabled: selectedCount === 0 || state.busy !== '' }),
          inboxButton('全选', () => { store.selectAllPending(); focusRoot() }, { disabled: pending.length === 0, title: '全选所有待处理 ticket' }),
          inboxButton('全选可推荐', () => { store.selectRecommended(); focusRoot() }, { disabled: pending.length === 0 }),
          inboxButton('清空选择', () => { store.clearSelected(); focusRoot() }, { disabled: selectedCount === 0 }),
          h('span', { class: 'fang-inbox-hint', style: { marginLeft: 'auto' } }, '↑↓ 选择 · Enter 处理 · X 勾选 · Shift+A 全选 · Esc 关闭'))
        const body = h('div', { class: 'fang-inbox-body', role: 'list' })
        // 批量失败逐条 UI：服务端返回 results[]，逐条展示 id/标题/原因，可重试。
        if (state.batchFailures.length) {
          body.prepend(h('div', { class: 'fang-inbox-batch-fail', role: 'alert' },
            h('div', { class: 'fang-inbox-batch-fail-title' }, `批量操作有 ${state.batchFailures.length} 项失败（其余已处理）`),
            ...state.batchFailures.map((failure) => h('div', { class: 'fang-inbox-batch-fail-row', 'data-fail-id': failure.id },
              h('b', null, failure.title || failure.id),
              h('span', null, failureHint(failure.reason)))),
            h('div', { class: 'fang-inbox-batch-fail-actions' },
              inboxButton('重试失败项', () => void store.retryFailures(), { primary: true }),
              inboxButton('关闭', () => { store.clearBatchFailures(); focusRoot() }))))
        }
        if (state.state === 'loading' && !state.items.length) body.append(h('div', { class: 'fang-inbox-empty' }, icon('spinner', 16), ' 正在读取收件箱…'))
        else if (state.state === 'error' && !state.items.length) {
          body.append(h('div', { class: 'fang-inbox-err', role: 'alert' }, `收件箱不可用：${failureHint(state.error || 'network')}`))
        } else if (!state.items.length) {
          body.append(h('div', { class: 'fang-inbox-empty' },
            '收件箱是空的。', h('br'), '决策中心创建的红/黄/蓝/绿 ticket 会出现在这里。'))
        } else {
          for (const meta of INBOX_LEVELS) {
            const node = groupNode(meta)
            if (node) body.append(node)
          }
        }
        if (state.error && state.items.length) body.prepend(h('div', { class: 'fang-inbox-err', role: 'status' }, `刷新失败：${failureHint(state.error)}（显示上次结果）`))
        if (state.notice && String(state.notice).startsWith('err:')) {
          body.prepend(h('div', { class: 'fang-inbox-err', role: 'status' }, failureHint(String(state.notice).slice(4))))
        }
        // 确认弹窗不能被一次 store 刷新（SSE/轮询）从 DOM 里替换掉。
        const openConfirm = root.querySelector(':scope > .fang-inbox-confirm')
        root.replaceChildren(head, aiPanel(), toolbar, body)
        if (openConfirm) root.append(openConfirm)
      }

      const onKeyDown = (event) => {
        const tag = String(event.target?.tagName || '').toUpperCase()
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
        const list = visiblePending()
        const currentIndex = list.findIndex(item => item.id === activeId)
        if (event.key === 'ArrowDown' || event.key === 'j') {
          event.preventDefault()
          const next = list[Math.min(list.length - 1, currentIndex + 1)] || list[0]
          if (next) { activeId = next.id; render(); root.querySelector(`[data-inbox-id="${activeId}"]`)?.scrollIntoView?.({ block: 'nearest' }) }
          return
        }
        if (event.key === 'ArrowUp' || event.key === 'k') {
          event.preventDefault()
          const prev = list[Math.max(0, currentIndex - 1)] || list[list.length - 1]
          if (prev) { activeId = prev.id; render(); root.querySelector(`[data-inbox-id="${activeId}"]`)?.scrollIntoView?.({ block: 'nearest' }) }
          return
        }
        if (event.key === 'Enter') {
          const item = list.find(entry => entry.id === activeId)
          if (!item) return
          event.preventDefault()
          void store.resolve(item.id, pickOption(item))
          return
        }
        if (event.key === 'x' || event.key === 'X') {
          const item = list.find(entry => entry.id === activeId)
          if (item) { event.preventDefault(); store.toggleSelected(item.id) }
          return
        }
        if (event.key === 'a' || event.key === 'A') {
          event.preventDefault()
          if (event.shiftKey) store.selectAllPending()
          else store.selectRecommended()
          return
        }
        if (event.key === 'r' || event.key === 'R') { event.preventDefault(); void store.refresh(); return }
        if (event.key === 'Escape') {
          event.preventDefault()
          if (state.selected.size) store.clearSelected()
          else if (options.drawer) options.onClose?.()
        }
      }
      root.addEventListener('keydown', onKeyDown)
      root.addEventListener('click', () => { focusRoot(); store.markSeen() })
      root.addEventListener('focus', () => store.markSeen())
      const unsubscribe = store.subscribe(render)
      render()
      // 收件箱在屏幕上 = 已读：未读红点只在「没看」时亮。
      try { store.markSeen() } catch { /* ignore */ }
      try { root.focus({ preventScroll: true }) } catch { /* ignore */ }
      return () => {
        disposed = true
        try { unsubscribe() } catch { /* ignore */ }
        try { root.removeEventListener('keydown', onKeyDown) } catch { /* ignore */ }
        host.replaceChildren()
      }
    }

    function mountPanel(host) {
      // Electron: remember the real upstream origin so "打开母体 Web" does not
      // open the loopback proxy (which intentionally serves only /fang/api/*).
      try {
        window.fangShell?.desktopInfo?.().then((info) => {
          if (info && typeof info.upstream === 'string' && /^https?:\/\//i.test(info.upstream)) {
            window.__fangDesktopUpstream = info.upstream.replace(/\/+$/, '')
          }
        }).catch(() => {})
      } catch { /* web host: no shell bridge */ }
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
      const unmountDiagnostics = mountDiagnostics(app, host)
      const unmountConnection = mountConnectionInfo(app, host)
      try { host.ownerDocument?.getElementById('fang-fallback')?.remove() } catch { /* ignore */ }
      return () => { unmountConnection(); unmountDiagnostics(); app.destroy() }
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
        try {
          window.dispatchEvent(new CustomEvent('fang:notice', {
            detail: '瓮城面板未在当前视图打开；请从 DSH 左侧栏「瓮城」进入，或使用 PC 端。',
          }))
        } catch { /* ignore */ }
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

    // ── 截图（内置客户端模块，不再作为独立子插件）──────────────────────────
    // 结果一律落在一个 body 级预览层里：看得见、能复制、说得清失败原因。
    // 面板未挂载时 fang:notice 没有监听者，所以失败提示不能只靠事件。
    const SHOT_NAME = () => `wengcheng-${Date.now()}.png`
    let shotOverlay = null

    function closeShotOverlay() {
      if (!shotOverlay) return
      try { shotOverlay.off() } catch { /* ignore */ }
      try { shotOverlay.node.remove() } catch { /* ignore */ }
      try { URL.revokeObjectURL(shotOverlay.url) } catch { /* ignore */ }
      shotOverlay = null
    }

    function showShotOverlay({ blob = null, message = '', hint = '', extraActions = [] } = {}) {
      closeShotOverlay()
      const doc = typeof document !== 'undefined' ? document : null
      if (!doc?.body) return
      const url = blob ? URL.createObjectURL(blob) : ''
      const status = h('div', {
        style: { fontSize: 13, lineHeight: 1.5, color: '#EFEFEF', whiteSpace: 'pre-wrap' },
        text: message,
      })
      const actions = h('div', { style: { display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' } })
      const mkBtn = (label, primary) => h('button', {
        type: 'button',
        style: {
          height: 30, padding: '0 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12,
          border: primary ? '1px solid #17803D' : '1px solid rgba(255,255,255,.24)',
          background: primary ? '#17803D' : 'transparent', color: '#fff',
        },
      }, label)
      if (blob) {
        const copyBtn = mkBtn('复制到剪贴板', true)
        copyBtn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
            copyBtn.textContent = '已复制 ✓'
            status.textContent = '已复制到剪贴板，在输入框里 Ctrl+V 即可粘贴图片。'
          } catch (error) {
            status.textContent = '复制失败：' + String(error?.message ?? error) + '\n可点「下载 PNG」，或右键预览图选「复制图片」。'
          }
        })
        const dlBtn = mkBtn('下载 PNG', false)
        dlBtn.addEventListener('click', () => {
          const link = h('a', { href: url, download: SHOT_NAME() })
          doc.body.appendChild(link)
          link.click()
          link.remove()
          status.textContent = '已下载 PNG，去浏览器的下载目录取文件。'
        })
        actions.append(copyBtn, dlBtn)
      }
      for (const extra of Array.isArray(extraActions) ? extraActions : []) {
        if (!extra || typeof extra.onClick !== 'function') continue
        const btn = mkBtn(String(extra.label ?? '操作'), extra.primary === true)
        btn.setAttribute('data-fang-shot-action', String(extra.label ?? 'action'))
        btn.addEventListener('click', () => { try { extra.onClick() } catch { /* ignore */ } })
        actions.append(btn)
      }
      const closeBtn = mkBtn('关闭', false)
      actions.append(closeBtn)
      const preview = blob ? h('img', {
        src: url,
        alt: '截图预览',
        style: { display: 'block', width: '100%', maxHeight: '58vh', objectFit: 'contain', borderRadius: 10, background: '#111', marginTop: 12 },
      }) : null
      const parts = [
        h('div', { style: { fontSize: 14, fontWeight: 600, color: '#fff', marginBottom: 8 } }, '瓮城截图'),
        status,
      ]
      if (preview) parts.push(preview)
      if (hint) parts.push(h('div', { style: { marginTop: 8, fontSize: 12, color: '#9A9AA0' }, text: hint }))
      parts.push(actions)
      const card = h('div', {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '瓮城截图',
        style: {
          width: 'min(760px, 92vw)', padding: 18, borderRadius: 14, background: '#1D1D1F',
          boxShadow: '0 24px 64px -12px rgba(0,0,0,.6)', pointerEvents: 'auto',
        },
      }, parts)
      const backdrop = h('div', {
        style: {
          position: 'fixed', inset: 0, zIndex: 2147483000, display: 'flex',
          alignItems: 'center', justifyContent: 'center', padding: 24,
          background: 'rgba(0,0,0,.55)', pointerEvents: 'auto',
        },
      }, card)
      backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeShotOverlay() })
      closeBtn.addEventListener('click', () => closeShotOverlay())
      const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); closeShotOverlay() } }
      doc.addEventListener('keydown', onKey, true)
      doc.body.appendChild(backdrop)
      shotOverlay = { node: backdrop, url, off: () => doc.removeEventListener('keydown', onKey, true) }
    }

    // DSH 桌面端的渲染进程是 Electron：没有 setDisplayMediaRequestHandler 时
    // getDisplayMedia 会直接 reject，用户看到的就是「没有选择共享内容」。
    // 第一次 getDisplayMedia 被拒后记住：这个窗口没有共享选择器，之后直接走系统截图。
    let webCaptureBlocked = false
    const isEmbeddedDesktop = () => {
      try { return /Electron\//i.test(String(navigator?.userAgent ?? '')) } catch { return false }
    }

    /** 调 Windows「屏幕截图」URI（与 Win+Shift+S 同一入口）；被拦截时返回 false。 */
    function requestSystemSnip() {
      try {
        const link = h('a', { href: 'ms-screenclip:', rel: 'noopener', style: { display: 'none' } })
        document.body.appendChild(link)
        link.click()
        link.remove()
        return true
      } catch { return false }
    }

    async function readClipboardImage() {
      try {
        if (!navigator.clipboard?.read) return { ok: false, error: '当前环境不支持读取剪贴板图片' }
        const items = await navigator.clipboard.read()
        for (const item of items) {
          const type = (item.types || []).find((candidate) => String(candidate).startsWith('image/'))
          if (type) return { ok: true, blob: await item.getType(type) }
        }
        return { ok: false, error: '剪贴板里还没有图片（先按 Win+Shift+S 截图）' }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    }

    async function readClipboardIntoOverlay() {
      const result = await readClipboardImage()
      if (!result.ok) {
        showShotOverlay({
          message: '读取剪贴板失败：' + result.error,
          hint: '先按 Win+Shift+S 拖选区域截图，再回来点「读取剪贴板」；也可以直接 Ctrl+V 粘贴。',
        })
        return
      }
      showShotOverlay({
        blob: result.blob,
        message: '已从剪贴板读到截图：直接 Ctrl+V 就能粘贴到输入框。',
        hint: '要换一张，再按一次 Win+Shift+S。',
      })
    }

    function showSnipGuidance(reason) {
      showShotOverlay({
        message: reason || '这个窗口不提供网页屏幕共享选择器，浏览器抓屏不可用。',
        hint: '按 Win+Shift+S 拖选区域，截图会直接进剪贴板，然后 Ctrl+V 粘贴；也可以点下面的按钮。',
        extraActions: [
          {
            label: '打开系统截图', primary: true,
            onClick: () => {
              const ok = requestSystemSnip()
              showShotOverlay({
                message: ok ? '已请求打开 Windows 截图：拖选区域后点「读取剪贴板」。' : '系统截图没有打开：请直接按 Win+Shift+S。',
                hint: ok ? '截完图直接 Ctrl+V 粘贴；或点「读取剪贴板」先预览。' : '',
                extraActions: [{ label: '读取剪贴板', primary: true, onClick: () => void readClipboardIntoOverlay() }],
              })
            },
          },
          { label: '读取剪贴板', onClick: () => void readClipboardIntoOverlay() },
        ],
      })
    }

    async function captureScreenshot() {
      if (typeof window.fangShell?.captureScreen === 'function') {
        try {
          const result = await window.fangShell.captureScreen()
          if (result?.ok) notifyScreenshot('已截图并复制到剪贴板，可直接 Ctrl+V 粘贴')
          else showShotOverlay({ message: '桌面端没有拿到屏幕图像。', hint: '可改用 Win+Shift+S 截图后粘贴。' })
          return Boolean(result?.ok)
        } catch (error) {
          showShotOverlay({ message: '截图失败：' + String(error?.message ?? error) })
          return false
        }
      }
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
        showSnipGuidance('当前页面不支持网页截屏。')
        return false
      }
      // Electron 宿主不会弹共享选择器：先走系统截图（Ctrl+X ≈ Win+Shift+S），别再让用户看失败框。
      if (isEmbeddedDesktop() || webCaptureBlocked) {
        const requested = requestSystemSnip()
        showShotOverlay({
          message: requested
            ? '已请求 Windows 系统截图（等同 Win+Shift+S）：拖选区域后，直接 Ctrl+V 粘贴。'
            : '这个窗口不能网页抓屏。请按 Win+Shift+S 截图。',
          hint: 'DSH 桌面端不提供屏幕共享选择器，所以浏览器抓屏会直接失败；系统截图走的是 Windows 自己的剪贴板。',
          extraActions: requested
            ? [{ label: '读取剪贴板', primary: true, onClick: () => void readClipboardIntoOverlay() }]
            : [{ label: '打开系统截图', primary: true, onClick: () => { requestSystemSnip() } }, { label: '读取剪贴板', onClick: () => void readClipboardIntoOverlay() }],
        })
        return requested
      }
      let stream = null
      try {
        // 浏览器会弹一次「选择要共享的内容」，选当前标签页/窗口/屏幕均可。
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
        const video = document.createElement('video')
        video.srcObject = stream
        video.muted = true
        await video.play()
        await new Promise((resolve) => { if (video.videoWidth) resolve(); else video.onloadedmetadata = resolve })
        const canvas = document.createElement('canvas')
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        canvas.getContext('2d').drawImage(video, 0, 0)
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
        if (!blob) throw new Error('截图内容为空')
        webCaptureBlocked = false
        let copied = false
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
          copied = true
        } catch { /* 预览层里还有手动复制按钮 */ }
        showShotOverlay({
          blob,
          message: copied
            ? '已截图并复制到剪贴板，在输入框里 Ctrl+V 即可粘贴。'
            : '已截到图，但浏览器拒绝了自动写入剪贴板，请点下面的「复制到剪贴板」。',
          hint: copied ? '' : '也可以点「下载 PNG」，或右键预览图选「复制图片」。',
        })
        return true
      } catch (error) {
        const name = String(error?.name ?? '')
        if (name === 'NotAllowedError') {
          webCaptureBlocked = true
          showSnipGuidance('浏览器拒绝了屏幕捕获：这个窗口没有共享选择器。')
        } else if (name === 'AbortError') {
          showShotOverlay({
            message: '截图已取消（没有选择共享内容）。',
            hint: '再按一次 Ctrl+X 重试，或改用 Win+Shift+S 截图后 Ctrl+V 粘贴。',
          })
        } else {
          showShotOverlay({ message: '截图失败：' + String(error?.message ?? error), hint: '可以改用 Win+Shift+S 截图后 Ctrl+V 粘贴。' })
        }
        return false
      } finally {
        for (const track of stream?.getTracks?.() ?? []) { try { track.stop() } catch { /* ignore */ } }
      }
    }

    function notifyScreenshot(message) {
      try { window.dispatchEvent(new CustomEvent('fang:notice', { detail: message })) } catch { /* ignore */ }
    }

    function isScreenshotShortcut(event) {
      const key = String(event?.key || '').toLowerCase()
      if (key !== 'x' || !event.ctrlKey || event.altKey || event.metaKey) return false
      return true
    }

    // 插槽返回的必须是 React 元素；直接返回 DOM 节点会让宿主判为异常而关掉该项。
    function ScreenshotDock() {
      return React.createElement(DomMount, {
        style: { display: 'inline-flex', alignItems: 'center' },
        mount: (host) => {
          const btn = h('button', {
            type: 'button',
            'data-fang-entry': 'screenshot',
            title: '截图并复制到剪贴板：Ctrl+X（桌面端走 Windows 系统截图，浏览器走屏幕共享）',
            style: {
              height: 26, padding: '0 8px', borderRadius: 7, cursor: 'pointer',
              border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit', fontSize: 12,
            },
          }, '截图 Ctrl+X')
          btn.addEventListener('click', () => { void captureScreenshot() })
          host.replaceChildren(btn)
          return () => { host.replaceChildren() }
        },
      })
    }


    /**
     * v3.1.19：分身 Web 的界面收敛。
     *
     * 1) 隐藏左侧栏「插件」入口 —— 分身里不允许进入插件设置页（避免用户在一次性沙箱里
     *    改动宿主插件配置，导致下一次派生继承脏配置）。
     * 2) 「启动」类按钮在分身里变成真正无操作：capture 阶段拦下点击，
     *    宿主处理器不执行 → 不切换面板、不弹提醒、不打印错误。
     *    （此前用户点「启动」会收到一条无法处理的报错，属噪音。）
     *
     * 只在 role === 'fork' 时生效；母体/元主不受影响。
     */

    /**
     * v3.1.23：元主（essence）Web 的界面收敛。
     *
     * 用户要求：
     * 1) 元主端不允许执行会话 / 任务 / 指令（派生与调度由房主 Router 负责）；
     * 2) 元主派生新分身必须选一个会话，分身内不允许新建会话（只能分叉会话）；
     * 3) 元主 Web 隐藏「工作区」「新会话」，只保留 插件安装/设置 与 系统设置，
     *    默认进入即打开插件设置页。
     *
     * 实现方式：DOM 收敛 + 事件拦截 + 一次性落地页跳转；不依赖宿主内部 API。
     */
    function mountEssenceUiLocks() {
      if (typeof document === 'undefined' || !document.body) return () => {}
      const doc = document
      let disposed = false
      let active = false
      let observer = null
      const NAV_HIDDEN = ['工作区', '新会话', '新建会话', 'Workspace', 'New session', 'New Session']
      const NOTICE_ID = 'fang-essence-notice'

      const clean = (text) => String(text || '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim()
      const isPanelRow = (node) => {
        try {
          if (!node || node.tagName !== 'BUTTON') return false
          if (/panelRow/i.test(String(node.className || ''))) return true
          return Boolean(node.closest('nav, aside, [class*="sidebar"], [class*="sideBar"], [class*="sider"]'))
        } catch { return false }
      }
      const matchNav = (text) => {
        const value = clean(text)
        if (!value) return false
        // 实机发现：宿主会把快捷键拼在文案后面（「新会话Ctrl+Alt+N」），
        // 因此按「标签前缀」匹配，而不是要求空格分隔。
        return NAV_HIDDEN.some((label) => value === label || value.startsWith(label))
      }
      const isPluginNav = (text) => {
        const value = clean(text)
        return value === '插件' || value === 'Plugins' || /^插件(\s|$)/.test(value) || /^Plugins?(\s|$)/.test(value)
      }

      const hideNavRows = () => {
        if (disposed || !active) return
        for (const node of doc.querySelectorAll('button')) {
          if (!isPanelRow(node)) continue
          const text = clean(node.textContent)
          if (!matchNav(text)) continue
          if (node.dataset.fangEssenceHidden === '1' && node.hidden) continue
          node.dataset.fangEssenceHidden = '1'
          node.hidden = true
          node.setAttribute('aria-hidden', 'true')
          node.style.setProperty('display', 'none', 'important')
          // 有些宿主用父级容器承载整行（工作区整块），一并收掉
          const row = node.closest('[class*="panelRow"],[class*="workspaceRow"],[data-workspace-row]')
          if (row && row !== node) {
            row.hidden = true
            row.dataset.fangEssenceHidden = '1'
            row.style.setProperty('display', 'none', 'important')
          }
        }
      }

      /**
       * v3.1.23 实机补充：等工作区不是单个按钮，而是「工作区」分组标题 + 若干工作区行。
       * 元主只做插件控制台，因此整段收起：标题所在分组 + 所有工作区行。
       */
      const hideWorkspaceBlock = () => {
        if (disposed || !active) return
        // ① 分组标题：文本恰好是「工作区」的任意元素（标题/按钮/标签）
        for (const node of doc.querySelectorAll('div,span,h2,h3,button,a')) {
          const text = clean(node.textContent)
          if (text !== '工作区' && text !== 'Workspace') continue
          const blockNode = node.closest('[class*="panelRow"],[class*="workspaceRow"],[class*="section"],[class*="group"]') || node.parentElement
          if (!blockNode || blockNode === doc.body) continue
          if (blockNode.dataset.fangEssenceHidden === '1') continue
          blockNode.dataset.fangEssenceHidden = '1'
          blockNode.hidden = true
          blockNode.setAttribute('aria-hidden', 'true')
          blockNode.style.setProperty('display', 'none', 'important')
        }
        // ② 工作区行（默认工作区 / 某个工作区名）
        for (const node of doc.querySelectorAll('button,div,li')) {
          if (!node || node.dataset.fangEssenceHidden === '1') continue
          const text = clean(node.textContent)
          if (!/^(默认工作区|工作区|Workspace)/.test(text)) continue
          if (!node.closest('[class*="sidebar"],[class*="sideBar"],[class*="sider"],nav,aside')) continue
          node.dataset.fangEssenceHidden = '1'
          node.hidden = true
          node.setAttribute('aria-hidden', 'true')
          node.style.setProperty('display', 'none', 'important')
        }
      }

      /** 隐藏输入区：元主不执行会话/指令（避免误以为能在这里跑任务）。 */
      const hideComposer = () => {
        if (disposed || !active) return
        for (const textarea of doc.querySelectorAll('textarea')) {
          const box = textarea.closest('[class*="composer"],[class*="Composer"]') || textarea.parentElement?.parentElement
          if (!box) continue
          if (box.dataset.fangEssenceHidden === '1') continue
          box.dataset.fangEssenceHidden = '1'
          box.hidden = true
          box.setAttribute('aria-hidden', 'true')
          box.style.setProperty('display', 'none', 'important')
        }
        for (const node of doc.querySelectorAll('button')) {
          const label = clean(node.getAttribute?.('aria-label') || node.textContent)
          if (!/^(发送|Send|发送消息)$/.test(label)) continue
          if (node.dataset.fangEssenceHidden === '1') continue
          node.dataset.fangEssenceHidden = '1'
          node.hidden = true
          node.style.setProperty('display', 'none', 'important')
        }
      }

      const insertNotice = () => {
        if (disposed || !active) return
        if (doc.getElementById(NOTICE_ID)) return
        const notice = doc.createElement('div')
        notice.id = NOTICE_ID
        notice.setAttribute('data-fang-essence-notice', '1')
        notice.setAttribute('role', 'status')
        notice.textContent = '元主 Web：仅插件安装/设置与系统设置可用；会话、任务与指令请在母体或分身中执行。'
        notice.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483000;max-width:min(520px,60vw);' +
          'padding:8px 12px;border-radius:10px;border:1px solid rgba(10,107,224,.25);background:rgba(232,241,253,.96);' +
          'color:#0B3E8E;font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 2px 8px rgba(16,17,20,.08)'
        doc.body.appendChild(notice)
      }

      /** 默认落地页 = 插件设置页（点一次侧栏「插件」，只做一次）。 */
      let landed = false
      const landOnPlugins = () => {
        if (disposed || !active || landed) return
        const button = [...doc.querySelectorAll('button')].find((node) => isPanelRow(node) && isPluginNav(clean(node.textContent)))
        if (!button) return
        landed = true
        try { button.click() } catch { /* ignore */ }
        doc.documentElement?.setAttribute?.('data-fang-essence-landing', 'plugins')
      }

      const onClickCapture = (event) => {
        if (!active || disposed) return
        const button = event.target && typeof event.target.closest === 'function' ? event.target.closest('button') : null
        if (!button) return
        const text = clean(button.textContent)
        if (isPanelRow(button) && matchNav(text)) {
          event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); return
        }
        const label = clean(button.getAttribute?.('aria-label') || '')
        if (/^(发送|Send)$/.test(label) || /^(发送|Send)$/.test(text)) {
          event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation()
        }
      }

      const onKeyDown = (event) => {
        if (!active || disposed) return
        if (event.key !== 'Enter' || event.shiftKey) return
        const target = event.target
        const inComposer = Boolean(target && typeof target.closest === 'function' && target.closest('[class*="composer"],[class*="Composer"],textarea'))
        if (!inComposer) return
        event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation()
      }

      const apply = () => {
        if (disposed) return
        hideNavRows()
        hideWorkspaceBlock()
        hideComposer()
        insertNotice()
        landOnPlugins()
      }
      const start = () => {
        if (disposed || active) return
        active = true
        apply()
        try {
          observer = new MutationObserver(() => apply())
          observer.observe(doc.body, { childList: true, subtree: true })
        } catch { /* ignore */ }
        doc.addEventListener('click', onClickCapture, true)
        doc.addEventListener('keydown', onKeyDown, true)
        // 宿主首屏渲染有先后：分几次重试落地页与隐藏
        for (const delay of [300, 800, 1500, 3000]) setTimeout(apply, delay)
        doc.documentElement?.setAttribute?.('data-fang-essence-locks', 'applied')
      }

      void detectWebRole().then((role) => {
        if (disposed) return
        if (role === 'essence') start()
      }).catch(() => { /* 识别失败则不启用 */ })

      return () => {
        disposed = true
        active = false
        try { observer?.disconnect() } catch { /* ignore */ }
        try { doc.removeEventListener('click', onClickCapture, true) } catch { /* ignore */ }
        try { doc.removeEventListener('keydown', onKeyDown, true) } catch { /* ignore */ }
        try { doc.getElementById(NOTICE_ID)?.remove() } catch { /* ignore */ }
        for (const node of doc.querySelectorAll('[data-fang-essence-hidden="1"]')) {
          try { node.hidden = false; node.style.removeProperty('display'); node.removeAttribute('aria-hidden'); delete node.dataset.fangEssenceHidden } catch { /* ignore */ }
        }
        doc.documentElement?.removeAttribute?.('data-fang-essence-locks')
      }
    }

    function mountForkUiLocks() {
      if (typeof document === 'undefined' || !document.body) return () => {}
      const doc = document
      let disposed = false
      let active = false
      let timer = 0
      let observer = null
      const NAV_TEXTS = ['插件', '新会话', '新建会话']
      const ACTION_TEXTS = ['启动', '启动插件', '开始使用', '启用']

      /** v3.1.20：宿主侧栏行类名会随版本变化，不再只认 panelRow。 */
      const isPanelRow = (node) => {
        try {
          if (!node || node.tagName !== 'BUTTON') return false
          const cls = String(node.className || '')
          if (/panelRow/i.test(cls)) return true
          // 兜底：侧栏/导航容器内的按钮
          return Boolean(node.closest('nav, aside, [class*="sidebar"], [class*="sideBar"], [class*="sider"]'))
        } catch { return false }
      }

      /** 插件入口的文本判定（中英 + 少量变体），容忍零宽字符与多余空白。 */
      const isPluginNavText = (text) => {
        const clean = String(text || '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim()
        if (!clean) return false
        if (clean === '插件' || clean === 'Plugins' || clean === 'Plugin') return true
        // 「插件」后面可能跟计数徽标，例如「插件 3」
        return /^插件(\s|$)/.test(clean) || /^Plugins?(\s|$)/.test(clean)
      }

      const hidePluginNav = () => {
        if (disposed || !active) return
        for (const node of doc.querySelectorAll('button')) {
          if (!isPanelRow(node)) continue
          const navText = String(node.textContent || '').trim()
          if (!isPluginNavText(navText) && !/^新会话|^新建会话/.test(navText)) continue
          if (node.dataset.fangForkHidden === '1' && node.hidden) continue
          node.dataset.fangForkHidden = '1'
          node.hidden = true
          node.setAttribute('aria-hidden', 'true')
          node.style.setProperty('display', 'none', 'important')
        }
      }

      const onClickCapture = (event) => {
        if (!active || disposed) return
        const target = event.target
        const button = target && typeof target.closest === 'function' ? target.closest('button') : null
        if (!button) return
        const text = String(button.textContent || '').trim()
        // ① 侧栏「插件」入口：双重保险（DOM 已隐藏，这里再拦一次点击/键盘激活）
        if (isPanelRow(button) && isPluginNavText(text)) {
          event.preventDefault()
          event.stopPropagation()
          event.stopImmediatePropagation()
          return
        }
        // ② 插件页「启动」：无操作（不切换、不提醒、不报错）
        const isAction = ACTION_TEXTS.some((label) => text === label || text.startsWith(label))
        if (!isAction) return
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        // ③ 万一宿主已被别处触发过提示，把残留的错误气泡收掉（仅限含错误语义的气泡）
        setTimeout(() => {
          if (disposed) return
          for (const node of doc.querySelectorAll('[role="alert"],[class*="toast"],[class*="Toast"]')) {
            const body = String(node.textContent || '')
            if (!/失败|错误|异常|无法|不能|不可|不允许|拒绝|failed|error/i.test(body)) continue
            if (node.dataset.fangForkAlertHidden === '1') continue
            node.dataset.fangForkAlertPrevDisplay = node.style.display || ''
            node.dataset.fangForkAlertHidden = '1'
            node.style.setProperty('display', 'none', 'important')
          }
        }, 60)
      }

      const activate = () => {
        if (active || disposed) return
        active = true
        hidePluginNav()
        try {
          doc.documentElement?.setAttribute('data-fang-fork-locks', 'applied')
          window.__fangForkLocks = { applied: true, at: Date.now() }
        } catch { /* ignore */ }
        doc.addEventListener('click', onClickCapture, true)
        try {
          observer = new MutationObserver(() => { hidePluginNav() })
          observer.observe(doc.body, { childList: true, subtree: true })
        } catch { observer = null }
        timer = setInterval(hidePluginNav, 1500)
        try { timer && timer.unref && timer.unref() } catch { /* ignore */ }
        hidePluginNav()
      }

      void (async () => {
        try {
          const role = await detectWebRole()
          if (disposed || role !== 'fork') return
          activate()
        } catch { /* 识别失败：保持原样，不误伤母体 */ }
      })()

      return () => {
        disposed = true
        active = false
        if (timer) { clearInterval(timer); timer = 0 }
        try { observer?.disconnect() } catch { /* ignore */ }
        observer = null
        try { doc.removeEventListener('click', onClickCapture, true) } catch { /* ignore */ }
        // 恢复被隐藏的入口与提示，避免热卸载后宿主界面残缺
        for (const node of doc.querySelectorAll('button[data-fang-fork-hidden="1"]')) {
          try {
            node.hidden = false
            node.removeAttribute('aria-hidden')
            node.style.removeProperty('display')
            delete node.dataset.fangForkHidden
          } catch { /* ignore */ }
        }
        for (const node of doc.querySelectorAll('[data-fang-fork-alert-hidden="1"]')) {
          try {
            const prev = node.dataset.fangForkAlertPrevDisplay || ''
            if (prev) node.style.display = prev
            else node.style.removeProperty('display')
            delete node.dataset.fangForkAlertPrevDisplay
            delete node.dataset.fangForkAlertHidden
          } catch { /* ignore */ }
        }
      }
    }


    /**
     * v3.1.19：元主 / 分身 Web 的「关闭二次确认」。
     *
     * 右上角直接关闭很容易误触（尤其是把分身窗口当临时浏览器用时）。
     * 这里注册 beforeunload：浏览器会弹出原生「离开此网站？」确认框，
     * 用户确认后才真正关闭；母体（主会话）不注册，避免打断正常主机操作。
     */
    function mountCloseConfirm() {
      if (typeof window === 'undefined') return () => {}
      let installed = false
      let disposed = false
      const onBeforeUnload = (event) => {
        try {
          event.preventDefault()
          // 现代浏览器忽略自定义文案，但仍要求设置 returnValue 才会弹确认框
          event.returnValue = '确认关闭瓮城窗口？未保存的分身状态会丢失。'
        } catch { /* ignore */ }
        return event.returnValue
      }
      const activate = () => {
        if (installed || disposed) return
        installed = true
        window.addEventListener('beforeunload', onBeforeUnload)
        // 兜底：宿主若用 history/路由隐藏关闭入口，键盘快捷键也走同一确认
        window.addEventListener('unload', () => {}, { once: true })
      }
      void (async () => {
        try {
          const role = await detectWebRole()
          if (disposed) return
          // 母体是主机式长驻窗口，不打断；元主/分身需要确认
          if (role === 'essence' || role === 'fork') activate()
        } catch { /* ignore */ }
      })()
      return () => {
        disposed = true
        if (!installed) return
        installed = false
        try { window.removeEventListener('beforeunload', onBeforeUnload) } catch { /* ignore */ }
      }
    }

    // ── 插件入口 ──────────────────────────────────────────────────────────
    // v3.1.23：jsdom 回归用钩子桥（只在测试模式挂到 window，正常运行时不存在）
    if (typeof window !== 'undefined' && window.__FANG_TEST_HOOK__) {
      window.__fangTestHooks = window.__fangTestHooks || {}
      Object.assign(window.__fangTestHooks, {
        __mountEssenceUiLocks: mountEssenceUiLocks,
        __mountForkUiLocks: mountForkUiLocks,
        __mountCloseConfirm: mountCloseConfirm,
        __detectWebRole: detectWebRole,
      })
    }

    return {
      mountPanel,
      ...(typeof window !== 'undefined' && window.__FANG_TEST_HOOK__ ? { __renderDecisionMini: renderDecisionMini, __mountWebRoleBadge: mountWebRoleBadge, __detectWebRole: detectWebRole, __mountForkUiLocks: mountForkUiLocks, __mountEssenceUiLocks: mountEssenceUiLocks, __mountCloseConfirm: mountCloseConfirm, __mountDecisionRelay: mountDecisionRelay } : {}),
      inject: ['slots'],
      apply(ctx) {
        const disposers = []
        // v3.1.12：侧栏 HARNESS 右侧的 Web 端身份徽标（母体 / 元主 / 分身）。
        disposers.push(mountWebRoleBadge())
        // v3.1.19：分身 Web 界面收敛（隐藏「插件」入口 + 「启动」无操作）。
        disposers.push(mountForkUiLocks())
        // v3.1.23：元主 Web 界面收敛（隐藏工作区/新会话、只留插件与系统设置、默认落地插件页）。
        disposers.push(mountEssenceUiLocks())
        // v3.1.19：元主 / 分身 Web 关闭前二次确认（防误触）。
        disposers.push(mountCloseConfirm())
        // 母体 Web = DSH 主会话视图；Web 端直接切回 conversation 面板。
        const goMother = () => {
          try {
            if (ctx?.layout && typeof ctx.layout.selectPanel === 'function') ctx.layout.selectPanel('conversation')
          } catch { /* fall back to panel notice */ }
        }
        window.addEventListener('fang:mother-portal', goMother)
        disposers.push(() => window.removeEventListener('fang:mother-portal', goMother))
        const onScreenshotKey = (event) => {
          if (!isScreenshotShortcut(event)) return
          event.preventDefault()
          event.stopPropagation()
          void captureScreenshot()
        }
        window.addEventListener('keydown', onScreenshotKey, true)
        disposers.push(() => window.removeEventListener('keydown', onScreenshotKey, true))
        disposers.push(ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'fang-screenshot-inline',
          order: 91,
        }, ScreenshotDock)))
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
          style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minWidth: 0, minHeight: 0, height: '100%', overflow: 'hidden' },
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
        // ── 决策收件箱：独立侧栏入口 + 右侧抽屉 / 独立 Slot ─────────────────
        const inbox = createDecisionInboxStore()
        inbox.start()
        disposers.push(() => { try { inbox.stop() } catch { /* ignore */ } })
        // v3.1.13：每个会话右侧的决策中继（母体角色且该会话有待决策时显示）。
        disposers.push(ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'fang-decision-relay',
          order: 60,
          label: '决策中继',
        }, (props) => React.createElement(DomMount, {
          mount: (mountHost) => mountDecisionRelay(mountHost, inbox, String(props?.sessionId ?? '')),
          style: { display: 'none' },
        }))))
        openInboxExternally = () => openInbox()
        const tryService = (name) => {
          try { if (ctx && typeof ctx === 'object' && ctx[name]) return ctx[name] } catch { /* ignore */ }
          try { if (typeof ctx?.get === 'function') return ctx.get(name) } catch { /* ignore */ }
          return null
        }
        let sidebarRight = tryService('sidebarRight')
        let sidebarRightTabs = tryService('sidebarRightTabs')
        if ((!sidebarRight || !sidebarRightTabs) && typeof ctx?.inject === 'function') {
          try {
            ctx.inject(['sidebarRight'], (scope) => {
              sidebarRight = sidebarRight || scope?.sidebarRight || (typeof scope?.get === 'function' ? scope.get('sidebarRight') : null)
            })
          } catch { /* old host: drawer fallback below */ }
          try {
            ctx.inject(['sidebarRightTabs'], (scope) => {
              sidebarRightTabs = sidebarRightTabs || scope?.sidebarRightTabs || (typeof scope?.get === 'function' ? scope.get('sidebarRightTabs') : null)
            })
          } catch { /* old host */ }
        }
        const openInbox = () => {
          // 用户手势里申请通知权限（不能在自动提醒里弹权限框）。
          try {
            if (typeof window !== 'undefined' && window.Notification && window.Notification.permission === 'default') {
              void window.Notification.requestPermission()
            }
          } catch { /* notification optional */ }
          try {
            if (sidebarRight && typeof sidebarRight.openTab === 'function') {
              sidebarRight.openTab(DECISION_INBOX.kind, { params: {} })
              return
            }
          } catch { /* fall through to local drawer */ }
          openInboxDrawer(inbox)
        }
        inbox.setOpenHandler(openInbox)
        openInboxExternally = () => openInbox()
        if (sidebarRightTabs && typeof sidebarRightTabs.register === 'function') {
          try {
            const disposeTabType = sidebarRightTabs.register({
              id: DECISION_INBOX.id,
              kind: DECISION_INBOX.kind,
              priority: 'builtin',
              title: () => '收件箱',
            })
            disposers.push(() => { try { disposeTabType?.() } catch { /* ignore */ } })
          } catch { /* old host */ }
        }
        disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: DECISION_INBOX.id,
        }, () => React.createElement(DomMount, {
          mount: (host) => mountDecisionInbox(host, inbox),
          style: { display: 'block', height: '100%', minHeight: 0 },
        }))))
        disposers.push(ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: DECISION_INBOX.id,
        }, () => React.createElement(DomMount, {
          mount: (host) => mountInboxTitle(host, inbox),
          style: { display: 'inline-flex', alignItems: 'center' },
        }))))
        disposers.push(ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'fang-inbox',
          order: 80,
          label: '收件箱',
        }, () => React.createElement(DomMount, {
          mount: (host) => mountInboxSeat(host, inbox, openInbox),
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

