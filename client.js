// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang Client 半 ——「瓮城」的可见入口（UI 重设计：层级 / 状态语义 / 两栏工作台）。
//
// 三处入口（同一个 Client 模块，同一个门禁行 @local/dsh-fang）：
//   1) 左侧导航栏 sidebar.panellist：红色城门图标 + 「瓮城」，单击由外壳 selectPanel 打开面板；
//      双击图标 = 快速派生（把 5–20s 的等待变成一次双击，面板里给结果卡兜底）。
//   2) main 面板 key='fang'：3:7 分屏——左=母体项目&会话，右=分身项目&会话，两栏独立滚动。
//   3) 输入框 dock 徽标：单击开面板、双击快速派生；异常时徽标直接显示「异常 n」。
//
// 事实约束（2026-11-01 实测 Slots 拓扑）：
//   * sidebar.panellist 的登记项只接收 {id, order, label}；图标 = 登记项组件本身
//     （外壳 renderSlot('sidebar.panellist', {size, active}, {only:id})），所以红门图标可行。
//   * 行点击归外壳所有（onClick → selectPanel），插件不能接管单击；双击只能在图标这一层挂。
//   * 面板组件从 main 的标准 props 拿 useSessions 等 hooks；这里仍用 /fang/api/* 拉数据，
//     避免依赖未文档化的 hook 形状。
//
// 2026-11-01 UI 重设计（仅 UI 层，不改 src/ 运行时与协议）：
//   * 会话标题降级：服务端不返回 title/titleSource/preview 时，不再把 workspaceTitle 当标题
//     （旧表现在整列都是「GPT」）；改为「未命名会话 + 短 ID」，并如实标注标题来源。
//   * 错误可读可重试：api() 保留 HTTP 状态 / content-type / 响应片段；非 JSON 与 404 分别解释；
//     分身会话错误按任务独立重试，不拖垮整列；旧宿主缺路由时给出一句话诊断。
//   * 状态语义：任务状态 = 运行生命周期；适配器健康 = 独立徽章。running + adapter 失联
//     = 「适配器失联 · 疑似僵尸分身」，卡片红色描边 + 就近的打开/归档操作。
//   * 层级：顶栏品牌 → 状态组 → 主操作（实心红 CTA）→ 次操作（刷新）；每栏「标题 / 副标题 / 计数」
//     两行头；会话行 58px 高，标题 14px、元信息 11.5px 显式行高，避免宿主 line-height 把行撑散。
//   * 可用性：会话搜索、分组折叠、两栏回到顶部、键盘 Enter/Space 选择、Esc 取消选中、
//     focus-visible 等效焦点环、小屏（≤980px）上下堆叠且两栏仍各自滚动。
//
// v2.6.2 分类折叠（左=母体 项目/对话，右=分身 任务/项目）：
//   * 三个分区：进行中（默认展开）/ 已归档（默认折叠）/ 临时（默认折叠）；
//   * 进行中会话最多先显示 7 条，其余折叠成「展开剩余 N 个」；归档与临时分区默认折叠；
//   * 临时 = 空会话（没有用户消息，无法继续开发）+ 快速派生任务（空白、未继承会话）；
//     顶栏「隐藏/显示临时内容」可整组隐藏，偏好存 localStorage（fang.panel.showTemporary）；
//   * 判定只用宿主已返回的事实（archived / empty / 任务标题），不改协议、不新增接口。
//
// v2.6.6 分身 Web UI 模式：
//   * 分身的 profile 也包含本 bundle 的 client 半，但母体 API（/fang/api/*）在分身里不存在
//     （orchestrator 是 mother-only）。以前面板会把这些 404 渲染成「不可读」故障；
//   * 现在先探测宿主角色：/fang/api/status 200 = 母体；否则 /fang/adapter/hello 200/401 = 分身；
//   * 分身里只渲染一段说明（不请求母体 API），dock 徽标隐藏；母体里行为不变。
//
// 颜色只走宿主 token（--dsw-alias-*）+ 插件艺术色 --fang-gate-accent，不写死主题底色。

window.__ModuleLoader__.load({
  id: '@local/dsh-fang',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    // ── 视觉常量（颜色只用宿主 token，红色是插件艺术色）────────────────────
    const ACCENT = 'var(--fang-gate-accent, #C62828)'
    const ACCENT_HOVER = '#A81F1F'
    const ACCENT_WASH = 'rgba(198, 40, 40, 0.06)'
    const ACCENT_LINE = 'rgba(198, 40, 40, 0.26)'
    const TEXT = 'var(--dsw-alias-label-primary, var(--dsh-text-primary, #1f2328))'
    const TEXT2 = 'var(--dsw-alias-label-secondary, var(--dsh-text-secondary, #6b7280))'
    const TEXT3 = 'var(--dsw-alias-label-tertiary, var(--dsh-text-tertiary, #8b949e))'
    const BORDER = 'var(--dsw-alias-border, var(--dsh-border, rgba(127,127,127,.28)))'
    const BORDER_SOFT = 'var(--dsw-alias-border-subtle, rgba(127,127,127,.18))'
    const SURFACE = 'var(--dsw-alias-surface, transparent)'
    const SURFACE_SOLID = 'var(--dsw-alias-surface, #ffffff)'
    const RAISED = 'var(--dsw-alias-surface-raised, rgba(127,127,127,.07))'
    const SUCCESS = 'var(--dsw-alias-state-success, #146c3a)'
    const WARNING = 'var(--dsw-alias-state-warning, #8a4b08)'
    const DANGER = 'var(--dsw-alias-state-error, #b3261e)'
    const INFO = 'var(--dsw-alias-state-business-primary, #1f5fbf)'
    const SUCCESS_WASH = 'rgba(20, 108, 58, 0.08)'
    const WARNING_WASH = 'rgba(138, 75, 8, 0.08)'
    const DANGER_WASH = 'rgba(179, 38, 30, 0.07)'
    const INFO_WASH = 'rgba(31, 95, 191, 0.07)'
    const FONT = 'inherit'
    const MONO = 'var(--ds-font-family-code, ui-monospace, Consolas, monospace)'

    const TONE = {
      neutral: { fg: TEXT2, border: BORDER, bg: 'transparent', dot: TEXT3 },
      success: { fg: SUCCESS, border: 'rgba(20, 108, 58, .30)', bg: SUCCESS_WASH, dot: SUCCESS },
      warning: { fg: WARNING, border: 'rgba(138, 75, 8, .30)', bg: WARNING_WASH, dot: WARNING },
      danger: { fg: DANGER, border: 'rgba(179, 38, 30, .32)', bg: DANGER_WASH, dot: DANGER },
      info: { fg: INFO, border: 'rgba(31, 95, 191, .30)', bg: INFO_WASH, dot: INFO },
    }

    // ── 格式化 & 标题降级 ─────────────────────────────────────────────────
    const clampText = (value, max = 0) => {
      const text = String(value ?? '').replace(/\s+/g, ' ').trim()
      return max > 0 && text.length > max ? text.slice(0, max - 1) + '…' : text
    }
    const short = (value, size = 8) => {
      const text = String(value ?? '')
      return text.length > size ? text.slice(-size) : text
    }
    const two = (n) => String(n).padStart(2, '0')
    const fmtTime = (ms) => {
      const date = new Date(Number(ms))
      if (!ms || Number.isNaN(date.getTime())) return '—'
      return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
    }
    const fmtFull = (ms) => {
      const date = new Date(Number(ms))
      if (!ms || Number.isNaN(date.getTime())) return '—'
      return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
    }

    /**
     * 会话标题解析。服务端约定（v2.1.1+）：title / titleSource / preview。
     * 旧宿主或空会话可能只有 workspaceTitle——绝不能把它当成会话标题，
     * 否则整列都会显示成同一个工作区名（这正是一版线上 UI 的「所有标题都是 GPT」）。
     * 降级表达：「未命名会话」+ 短 ID（由行内 chip 承担），并保留来源说明。
     */
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
      // 极旧宿主没有 titleSource：有标题且不等于工作区名时，才当作真标题。
      return { text: title, source: 'native' }
    }
    const fmtBytes = (n) => {
      const v = Number(n)
      if (!Number.isFinite(v) || v <= 0) return ''
      if (v < 1024) return v + ' B'
      if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KiB'
      return (v / (1024 * 1024)).toFixed(1) + ' MiB'
    }
    const importNote = (imported) => {
      if (!imported) return ''
      if (imported.ok) return ` · 已导入历史会话（${fmtBytes(imported.bytes)}）`
      if (imported.reason === 'too-large') return ` · 历史过大（${fmtBytes(imported.bytes)}），仅带交接摘要`
      return ' · 历史未导入，仅带交接摘要'
    }
    const importDetail = (imported) => {
      if (!imported || imported.ok) return ''
      if (imported.reason === 'too-large') return `会话日志 ${fmtBytes(imported.bytes)} 超过导入上限 ${fmtBytes(imported.limit)}；分身可继续，但历史需在母体查看。`
      return `历史会话未能导入（${imported.reason || 'unknown'}）；本次只写入交接摘要。`
    }
    const sessionDisplayText = (session) => {
      const info = sessionTitleInfo(session)
      return info.source === 'unnamed' ? `${info.text} ${short(session?.sessionId, 8)}` : info.text
    }
    function sessionTooltip(session) {
      const info = sessionTitleInfo(session)
      const lines = [info.source === 'unnamed' ? '未命名会话' : info.text]
      if (info.source === 'unnamed') {
        lines.push('服务端没有返回会话标题（旧版宿主未提供 title/preview，或该会话尚无标题）。')
        lines.push('列表用短 ID 区分，不把工作区名伪装成标题。')
      }
      if (info.source === 'first-user') lines.push('标题来源：该会话的首条用户消息。')
      lines.push('会话 ID：' + String(session?.sessionId ?? '—'))
      lines.push('工作区：' + (clampText(session?.workspaceTitle) || '未知') + (session?.workspacePath ? '（' + session.workspacePath + '）' : ''))
      if (session?.createdAt) lines.push('创建时间：' + fmtFull(session.createdAt))
      lines.push('更新时间：' + fmtFull(session?.updatedAt))
      if (session?.empty) lines.push('状态：空会话（没有用户消息，无法继续开发）')
      if (session?.archived) lines.push('状态：已归档')
      if (session?.pinned) lines.push('状态：置顶')
      return lines.join('\n')
    }
    function sessionAria(session, verb) {
      const info = sessionTitleInfo(session)
      const bits = [verb + '会话', info.source === 'unnamed' ? info.text + '，短 ID ' + short(session?.sessionId, 8) : info.text]
      bits.push('工作区 ' + (clampText(session?.workspaceTitle) || '未知'))
      if (session?.createdAt) bits.push('创建于 ' + fmtFull(session.createdAt))
      bits.push('更新于 ' + fmtFull(session?.updatedAt))
      return bits.join('，')
    }

    const groupSessionsByWorkspace = (items) => {
      const groups = new Map()
      for (const item of Array.isArray(items) ? items : []) {
        const key = item.workspaceId || item.workspaceKey || item.workspaceTitle || 'unknown'
        if (!groups.has(key)) {
          groups.set(key, {
            key,
            title: clampText(item.workspaceTitle) || '未命名项目',
            path: item.workspacePath || '',
            sessions: [],
            latestAt: 0,
          })
        }
        const group = groups.get(key)
        group.sessions.push(item)
        if (Number(item.updatedAt) > group.latestAt) group.latestAt = Number(item.updatedAt)
      }
      const out = [...groups.values()]
      for (const group of out) group.sessions.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
      return out.sort((a, b) => b.latestAt - a.latestAt || String(a.title).localeCompare(String(b.title)))
    }

    // ── 面板分类（v2.6.2）：进行中 / 已归档 / 临时 ─────────────────────────────
    //
    // 事实约束：服务端没有「临时」字段，也不该为了 UI 改动协议。这里用两条可解释的
    // 事实定义「临时」，并在分区标题的 tooltip 里写明，用户可整体隐藏临时内容：
    //   * 空会话（没有 user 消息，无法继续开发）：会话 side 的 empty=true；
    //   * 快速派生任务（双击图标/「派生新分身」产生的空白分身，未继承任何会话）：
    //     标题是 快速派生 / 双击快速派生 / 徽标快速派生 / 重试快速派生。
    // 归档优先级最高：同一项既是 archived 又是 empty 时只进「已归档」，不重复计数。
    const PANEL_TEMP_PREF_KEY = 'fang.panel.showTemporary'
    const PANEL_ACTIVE_LIMIT = 7
    const QUICK_DERIVE_TITLE_RE = /^(?:(?:双击|徽标|重试)快速派生|快速派生)$/

    const isArchivedSession = (session) => !!session?.archived
    const isEmptySession = (session) => !!session?.empty
    const isTempTask = (task) => QUICK_DERIVE_TITLE_RE.test(String(task?.title ?? '').trim())

    /** 母体会话三分：归档 > 临时（空会话）> 进行中。返回原对象引用，不改写字段。 */
    function classifyMotherSessions(items) {
      const active = []
      const archived = []
      const temporary = []
      for (const item of Array.isArray(items) ? items : []) {
        if (isArchivedSession(item)) archived.push(item)
        else if (isEmptySession(item)) temporary.push(item)
        else active.push(item)
      }
      return { active, archived, temporary }
    }

    /** 分身任务三分：归档 > 临时（快速派生空白分身）> 进行中。 */
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

    function readPanelBoolPref(key, fallback) {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return fallback
        const raw = window.localStorage.getItem(key)
        return raw === null ? fallback : raw === '1'
      } catch {
        return fallback
      }
    }
    function writePanelBoolPref(key, value) {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return
        window.localStorage.setItem(key, value ? '1' : '0')
      } catch {
        /* 隐私模式/禁用 storage：偏好只在本次会话内生效 */
      }
    }

    // ── 状态语义 ──────────────────────────────────────────────────────────
    const TASK_STATUS_LABEL = { ready: '就绪', running: '运行中', provisioning: '启动中', failed: '已停止', archived: '已归档' }
    /**
     * 后端语义（orchestrator.taskView）：ready = 适配器已握手；running = 进程活着但适配器未握手；
     * failed = 进程不在；archived = 已回收。UI 拆成两枚徽章，避免把「僵尸任务」显示成普通运行中。
     */
    function taskHealth(task) {
      const status = String(task?.status ?? '')
      const adapterOk = !!task?.adapter?.ok
      const anomaly = status === 'running' && !adapterOk
      // 生命周期颜色与健康颜色分开：running 仍是「运行中」（info），异常由适配器徽章/红描边表达。
      let tone = 'neutral'
      let accent = TEXT3
      if (status === 'ready') { tone = 'success'; accent = SUCCESS }
      else if (status === 'running') { tone = 'info'; accent = anomaly ? DANGER : INFO }
      else if (status === 'provisioning') { tone = 'warning'; accent = WARNING }
      else if (status === 'failed') { tone = 'danger'; accent = DANGER }
      const adapterError = String(task?.adapter?.error ?? '')
      const adapterLabel = adapterOk ? '适配器就绪' : (adapterError ? '适配器失联' : '适配器未就绪')
      const adapterTone = adapterOk ? 'success' : (anomaly || status === 'running' || status === 'failed' ? 'danger' : 'warning')
      return {
        status,
        label: TASK_STATUS_LABEL[status] || (status || '未知'),
        tone,
        accent,
        anomaly,
        active: status === 'ready' || status === 'running' || status === 'provisioning',
        adapterOk,
        adapterLabel,
        adapterTone,
        adapterError,
      }
    }
    const shouldLoadForkSessions = (task) => ['ready', 'running', 'failed'].includes(String(task?.status ?? ''))

    // ── 错误文案（把 code 翻译成人能读懂的一句话）──────────────────────────
    const FAILURE_HINTS = {
      'bad-json': '接口返回的内容不是 JSON（可能是旧版宿主、代理错误页或进程已退出）。',
      'empty-body': '接口返回了空响应。宿主可能正在重启，稍后重试。',
      network: '网络请求没有完成（宿主未启动、页面离线或请求被中断）。',
      'status-unavailable': '/fang/api/status 不可用：宿主侧 dsh-Fang 可能没有加载。',
      'unknown-task': '任务不在当前母体的注册表里（宿主可能重启过，或任务已归档）。',
      'session-catalog-unavailable': '母体会话目录服务未加载，无法列出会话。',
      'sessions-root-missing': '该分身还没有 sessions 目录（新派生或 home 尚未初始化）。',
      'index-not-found': '分身的工作区索引尚未生成，标题与分组可能降级。',
      'index-read-failed': '分身的工作区索引损坏，标题与分组可能降级。',
      'sessions-unreadable': '会话目录不可读（权限或路径问题）。',
      'quota-exceeded': '分身配额已满，请先归档旧分身。',
      'session-seed-failed': '会话摘要种子生成失败，派生已中止（fail-closed）。',
      'handler-threw': '宿主处理请求时抛出异常，详见诊断信息。',
      'derive-failed': '派生请求失败。',
    }
    function failureHint(code, context) {
      const key = String(code ?? '')
      if (context === 'fork-sessions-route-missing') {
        return '宿主未提供分身会话接口（见右栏顶部说明）；重启母体后再试。'
      }
      if (key === 'http-404' && context === 'fork-sessions') {
        return '分身会话接口不存在（HTTP 404）：宿主可能仍在运行旧版 dsh-Fang（该路由自面板 v2.2.0 起加入）。重启母体后刷新；分身本身仍可打开。'
      }
      if (FAILURE_HINTS[key]) return FAILURE_HINTS[key]
      const http = /^http-(\d+)$/.exec(key)
      if (http) return `接口返回 HTTP ${http[1]}${http[1] === '404' ? '：路由不存在或对象已不在注册表里（旧宿主 / 已归档）' : ''}。`
      return `请求失败：${key || 'unknown'}`
    }
    function diagnosticText(diagnostic) {
      if (!diagnostic) return ''
      const parts = []
      if (diagnostic.url) parts.push('URL: ' + diagnostic.url)
      if (diagnostic.status) parts.push('HTTP: ' + diagnostic.status)
      if (diagnostic.contentType) parts.push('Content-Type: ' + diagnostic.contentType)
      if (diagnostic.parseError) parts.push('解析: ' + diagnostic.parseError)
      if (diagnostic.snippet) parts.push('响应片段: ' + diagnostic.snippet)
      if (diagnostic.message) parts.push('错误: ' + diagnostic.message)
      return parts.join('\n')
    }

    // ── 单模块级状态：徽标 / 图标 / 面板共享同一次派生 ──────────────────────
    const state = {
      derive: null,           // 最近一次派生结果 { ok, taskId, url, error, at } 或 { pending, at }
      inflight: null,         // 进行中的 Promise（单飞：双击多次只派生一个）
      listeners: new Set(),
      lastGesture: 0,
      notify() { for (const fn of [...this.listeners]) { try { fn(this.derive) } catch { /* ignore */ } } },
    }
    function subscribe(fn) {
      state.listeners.add(fn)
      return () => state.listeners.delete(fn)
    }

    /**
     * 统一的 API 读取：不再把「非 JSON / 空响应」统一压成 bad-json。
     * 保留 status / content-type / 响应片段，供 UI 给出可操作的原因和「查看诊断」。
     */
    async function api(path, options) {
      const url = String(path)
      let res
      try {
        res = await fetch(url, {
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          ...(options ?? {}),
        })
      } catch (e) {
        return { status: 0, body: null, diagnostic: { url, message: String(e?.message ?? e) } }
      }
      const contentType = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || ''
      let text = ''
      try { text = await res.text() } catch (e) {
        return { status: res.status, body: null, diagnostic: { url, status: res.status, contentType, message: '读取响应失败：' + String(e?.message ?? e) } }
      }
      let body = null
      let parseError = ''
      if (text) {
        try { body = JSON.parse(text) } catch (e) { parseError = String(e?.message ?? e) }
      } else {
        parseError = 'empty-body'
      }
      if (body === null) {
        const code = res.status >= 400 ? 'http-' + res.status : (parseError === 'empty-body' ? 'empty-body' : 'bad-json')
        return {
          status: res.status,
          body: { ok: false, error: code },
          diagnostic: { url, status: res.status, contentType, snippet: clampText(text, 200), parseError },
        }
      }
      return { status: res.status, body, diagnostic: { url, status: res.status, contentType } }
    }

    // ── 宿主角色探测（v2.6.6）：母体 host 有 /fang/api/status；分身 host 只有 /fang/adapter/* ──
    // 分身的 profile bundle 也包含本插件的 client 半，所以分身 Web UI 会渲染「瓮城」入口；
    // 但母体 API 在分身里不存在（orchestrator 是 mother-only），不能把 404 当故障刷满面板。
    const HOST_ROLE = { UNKNOWN: 'unknown', MOTHER: 'mother', FORK: 'fork' }
    const hostRoleStore = { state: { role: HOST_ROLE.UNKNOWN, error: '', at: 0 }, listeners: new Set(), inflight: null }
    function setHostRole(role, error = '') {
      hostRoleStore.state = { role, error, at: Date.now() }
      for (const fn of [...hostRoleStore.listeners]) { try { fn(hostRoleStore.state) } catch { /* ignore */ } }
    }
    async function detectHostRole(force = false) {
      if (!force && hostRoleStore.state.at > 0) return hostRoleStore.state
      if (hostRoleStore.inflight) return hostRoleStore.inflight
      hostRoleStore.inflight = (async () => {
        const status = await api('/fang/api/status')
        if (status.status === 200 && status.body && status.body.ok !== false) {
          setHostRole(HOST_ROLE.MOTHER)
          return hostRoleStore.state
        }
        const hello = await api('/fang/adapter/hello')
        // 401 也是证据：路由存在但要求 Bearer（v2.6.1+ 的 Forker 会给分身注入 token）。
        if (hello.status === 200 || hello.status === 401) {
          setHostRole(HOST_ROLE.FORK)
          return hostRoleStore.state
        }
        setHostRole(HOST_ROLE.UNKNOWN, `status ${status.status} · adapter ${hello.status}`)
        return hostRoleStore.state
      })().finally(() => { hostRoleStore.inflight = null })
      return hostRoleStore.inflight
    }
    function useHostRole() {
      const [role, setRole] = useState(hostRoleStore.state)
      useEffect(() => {
        hostRoleStore.listeners.add(setRole)
        if (!hostRoleStore.state.at) void detectHostRole()
        return () => { hostRoleStore.listeners.delete(setRole) }
      }, [])
      return role
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
          const result = await api('/fang/api/derive', { method: 'POST', body: JSON.stringify({ title: title || '快速派生' }) })
          const body = result.body
          if (body?.ok) {
            state.derive = { ok: true, taskId: body.taskId, url: body.url, port: body.port, adapter: body.adapter, at: Date.now() }
            try { if (body.url) window.open(body.url, '_blank', 'noopener') } catch { /* popup blocked → 面板结果卡兜底 */ }
          } else {
            const code = body?.error || (result.status ? 'http-' + result.status : 'network')
            state.derive = {
              ok: false,
              error: code,
              message: failureHint(code),
              detail: body?.detail || diagnosticText(result.diagnostic),
              at: Date.now(),
            }
          }
        } catch (e) {
          state.derive = { ok: false, error: 'network', message: failureHint('network'), detail: String(e?.message ?? e), at: Date.now() }
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

    // ── 小图标（无第三方依赖，跟随 currentColor）────────────────────────────
    function glyph(paths, size = 14, strokeWidth = 1.8) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false',
        style: { display: 'block', flexShrink: 0 },
      }, paths.map((d, index) => h('path', { key: 'p' + index, d })))
    }
    const IconChevron = ({ open = false, size = 14 }) => glyph([open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'], size, 2)
    const IconPlus = ({ size = 13 }) => glyph(['M12 5v14', 'M5 12h14'], size, 2)
    const IconRefresh = ({ size = 13 }) => glyph(['M20.5 12a8.5 8.5 0 1 1-2.49-6.01', 'M21 4.5V10h-5.5'], size)
    const IconExternal = ({ size = 11 }) => glyph(['M14 4h6v6', 'M20 4l-9 9', 'M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4'], size)
    const IconAlert = ({ size = 14 }) => glyph(['M12 3.6 21 20H3L12 3.6Z', 'M12 9.5v4.2', 'M12 17.3h.01'], size)
    const IconArrowUp = ({ size = 14 }) => glyph(['M12 19V5', 'M6 11l6-6 6 6'], size)
    const IconSearch = ({ size = 13 }) => glyph(['M11 4.5a6.5 6.5 0 1 1 0 13a6.5 6.5 0 0 1 0-13', 'M16 16l4 4'], size)
    const IconCheck = ({ size = 12 }) => glyph(['M5 12.5l4.5 4.5L19 7.5'], size, 2.2)

    // ── 红色城门图标：瓮圈(红) + 门洞(currentColor) + 门基(弱化) ──────────────
    function GateGlyph({ size = 18, active, onDoubleClick, quick = false }) {
      const s = Math.max(14, Math.min(22, Number(size) || 18))
      const handle = useMemo(() => makeDoubleTap(() => quickDerive('双击快速派生')), [])
      const interactive = quick || !!onDoubleClick
      return h('span', {
        onDoubleClick: interactive ? (e) => { handle(e); if (onDoubleClick) onDoubleClick(e) } : undefined,
        title: interactive ? '瓮城：单击打开面板，双击快速派生分身' : '瓮城',
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

    // ── 基础组件 ──────────────────────────────────────────────────────────
    function Pill({ tone = 'neutral', dot = false, mono = false, title, children, style }) {
      const palette = TONE[tone] || TONE.neutral
      return h('span', {
        title,
        style: {
          display: 'inline-flex', alignItems: 'center', gap: dot ? 5 : 0,
          height: 20, padding: '0 8px', borderRadius: 999,
          border: `1px solid ${palette.border}`, background: palette.bg,
          color: palette.fg, fontSize: 11, lineHeight: '18px', fontWeight: 500,
          whiteSpace: 'nowrap',
          ...(mono ? { fontFamily: MONO } : {}),
          ...(style || {}),
        },
      },
      dot ? h('span', { 'aria-hidden': 'true', style: { width: 6, height: 6, borderRadius: 999, background: palette.dot, flexShrink: 0 } }) : null,
      children)
    }

    /** 分身 Web UI 的「瓮城」说明页（v2.6.6）：母体 API 不在分身里，别把 404 当故障。 */
    function ForkHostNotice({ role }) {
      return h('div', {
        role: 'region',
        'aria-label': '瓮城 · 分身 Web UI',
        style: {
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 10, minHeight: 340, margin: 12, padding: '36px 22px', textAlign: 'center',
          border: `1px dashed ${BORDER}`, borderRadius: 12, background: 'rgba(127,127,127,.02)',
        },
      },
      h('span', {
        style: {
          display: 'inline-flex', width: 44, height: 44, borderRadius: 12,
          alignItems: 'center', justifyContent: 'center',
          background: ACCENT_WASH, border: `1px solid ${ACCENT_LINE}`,
        },
      }, h(GateGlyph, { size: 26, active: true })),
      h('span', { style: { fontSize: 15, fontWeight: 600, lineHeight: '22px', color: TEXT } }, '当前页面是分身的 Web UI'),
      h('span', { style: { maxWidth: 560, fontSize: 12, lineHeight: '20px', color: TEXT2 } }, '瓮城母体面板只在母体宿主中可用；这个页面是 dsh-Fang 派生的分身（role=fork）。母体接口 /fang/api/* 在分身里不存在，所以这里不显示任务与会话——这是预期行为，不是插件故障。'),
      h('span', { style: { maxWidth: 560, fontSize: 12, lineHeight: '20px', color: TEXT2 } }, '要派生、归档或管理分身，请回到母体窗口的「瓮城」面板；当前标签页继续使用分身自己的会话与工具即可。'),
      role?.error ? h('code', { style: { fontFamily: MONO, fontSize: 10.5, color: TEXT3 } }, 'probe: ' + role.error) : null)
    }

    function Tag({ children, tone = 'neutral', mono = false, title }) {
      const palette = TONE[tone] || TONE.neutral
      return h('span', {
        title,
        style: {
          display: 'inline-flex', alignItems: 'center', height: 16, padding: '0 5px',
          borderRadius: 4, border: `1px solid ${palette.border}`, background: palette.bg,
          color: palette.fg, fontSize: 10.5, lineHeight: '14px', fontWeight: 500,
          whiteSpace: 'nowrap',
          ...(mono ? { fontFamily: MONO } : {}),
        },
      }, children)
    }

    const BTN = {
      primary: { fg: '#ffffff', bg: ACCENT, hoverBg: ACCENT_HOVER, border: 'transparent', hoverBorder: 'transparent' },
      ghost: { fg: TEXT, bg: 'transparent', hoverBg: RAISED, border: BORDER, hoverBorder: BORDER },
      quiet: { fg: TEXT2, bg: 'transparent', hoverBg: RAISED, border: 'transparent', hoverBorder: 'transparent' },
    }

    function Btn({ children, onClick, variant = 'ghost', size = 'md', disabled, title, ariaLabel, style }) {
      const [hover, setHover] = useState(false)
      const [focus, setFocus] = useState(false)
      const palette = BTN[variant] || BTN.ghost
      const dims = size === 'sm'
        ? { height: 28, padding: '0 10px', fontSize: 12, borderRadius: 7 }
        : size === 'lg'
          ? { height: 36, padding: '0 16px', fontSize: 13, borderRadius: 9 }
          : { height: 32, padding: '0 13px', fontSize: 12.5, borderRadius: 8 }
      return h('button', {
        type: 'button',
        onClick,
        disabled: !!disabled,
        title,
        'aria-label': ariaLabel,
        'aria-disabled': disabled ? 'true' : undefined,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onFocus: () => setFocus(true),
        onBlur: () => setFocus(false),
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
          font: FONT,
          ...dims,
          fontWeight: 500, lineHeight: '16px', whiteSpace: 'nowrap',
          cursor: disabled ? 'not-allowed' : 'pointer',
          border: `1px solid ${!disabled && hover ? palette.hoverBorder : palette.border}`,
          background: disabled ? palette.bg : (hover ? palette.hoverBg : palette.bg),
          color: palette.fg,
          opacity: disabled ? 0.45 : 1,
          transition: 'background 120ms ease, border-color 120ms ease, color 120ms ease',
          outline: focus ? `2px solid ${ACCENT}` : 'none',
          outlineOffset: 2,
          ...(style || {}),
        },
      }, children)
    }

    function LinkBtn({ href, onClick, children, tone = 'accent', size = 'md', title, ariaLabel, style }) {
      const [hover, setHover] = useState(false)
      const [focus, setFocus] = useState(false)
      const colors = tone === 'muted' ? { fg: TEXT2, hover: TEXT } : { fg: INFO, hover: TEXT }
      return h('a', {
        href,
        onClick,
        target: href ? '_blank' : undefined,
        rel: href ? 'noopener' : undefined,
        title,
        'aria-label': ariaLabel,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onFocus: () => setFocus(true),
        onBlur: () => setFocus(false),
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 5,
          fontSize: size === 'sm' ? 11.5 : 12, lineHeight: '16px',
          color: hover ? colors.hover : colors.fg, textDecoration: 'none', cursor: 'pointer',
          padding: '2px 4px', margin: '-2px -4px', borderRadius: 5,
          background: hover ? RAISED : 'transparent',
          outline: focus ? `2px solid ${ACCENT}` : 'none', outlineOffset: 2,
          whiteSpace: 'nowrap',
          ...(style || {}),
        },
      }, children)
    }

    function OpenLink({ href, children, title, ariaLabel }) {
      const [hover, setHover] = useState(false)
      const [focus, setFocus] = useState(false)
      return h('a', {
        href: href || undefined,
        target: '_blank',
        rel: 'noopener',
        title,
        'aria-label': ariaLabel,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onFocus: () => setFocus(true),
        onBlur: () => setFocus(false),
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
          height: 28, padding: '0 10px', borderRadius: 7,
          border: `1px solid ${BORDER}`, background: hover ? RAISED : 'transparent',
          color: TEXT, fontSize: 12, lineHeight: '16px', textDecoration: 'none',
          cursor: 'pointer', whiteSpace: 'nowrap',
          outline: focus ? `2px solid ${ACCENT}` : 'none', outlineOffset: 2,
        },
      }, children)
    }

    function SearchField({ value, onChange, placeholder }) {
      const [focus, setFocus] = useState(false)
      return h('div', {
        style: {
          position: 'relative', display: 'flex', alignItems: 'center', height: 32,
          borderRadius: 8,
          border: `1px solid ${focus ? ACCENT : BORDER}`,
          background: focus ? SURFACE : RAISED,
          boxShadow: focus ? `0 0 0 3px ${ACCENT_WASH}` : 'none',
          transition: 'border-color 120ms ease, background 120ms ease',
        },
      },
      h('span', { 'aria-hidden': 'true', style: { position: 'absolute', left: 10, display: 'inline-flex', color: TEXT2 } }, h(IconSearch, { size: 13 })),
      h('input', {
        type: 'text',
        value,
        placeholder,
        'aria-label': '搜索母体会话',
        onFocus: () => setFocus(true),
        onBlur: () => setFocus(false),
        onChange: (e) => onChange(e.target.value),
        onKeyDown: (e) => {
          if (e.key === 'Escape' && value) { e.stopPropagation(); onChange('') }
        },
        style: {
          width: '100%', height: '100%', boxSizing: 'border-box',
          padding: '0 30px 0 30px', border: 'none', outline: 'none',
          background: 'transparent', color: TEXT, font: FONT, fontSize: 12,
        },
      }),
      value
        ? h('button', {
          type: 'button',
          onClick: () => onChange(''),
          'aria-label': '清除会话搜索',
          title: '清除搜索',
          style: {
            position: 'absolute', right: 4, width: 24, height: 24, padding: 0,
            border: 'none', borderRadius: 6, background: 'transparent',
            color: TEXT2, cursor: 'pointer', fontSize: 14, lineHeight: '24px',
          },
        }, '×')
        : null)
    }

    function Callout({ tone = 'warning', title, code, message, detail, actions, role, style }) {
      const palette = TONE[tone] || TONE.warning
      const nodes = Array.isArray(actions) ? actions.filter(Boolean) : (actions ? [actions] : [])
      return h('div', {
        role: role || undefined,
        style: {
          display: 'flex', flexDirection: 'column', gap: 6,
          padding: '10px 12px', borderRadius: 8,
          border: `1px solid ${palette.border}`, borderLeft: `3px solid ${palette.dot}`,
          background: palette.bg, color: TEXT, fontSize: 12, lineHeight: '18px',
          ...(style || {}),
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 } },
        h('span', { 'aria-hidden': 'true', style: { display: 'inline-flex', color: palette.fg, flexShrink: 0 } }, h(IconAlert, { size: 14 })),
        h('span', { style: { fontSize: 12.5, fontWeight: 600, color: TEXT, minWidth: 0, flexShrink: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title),
        code ? h('code', {
          style: {
            fontFamily: MONO, fontSize: 10.5, lineHeight: '16px', padding: '0 6px',
            borderRadius: 4, border: `1px solid ${palette.border}`, color: palette.fg, whiteSpace: 'nowrap',
          },
        }, code) : null,
        nodes.length ? h('span', { style: { flex: 1 } }) : null,
        nodes.length ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginLeft: 'auto' } }, nodes) : null),
      message ? h('div', { style: { paddingLeft: 20, color: TEXT2 } }, message) : null,
      detail
        ? h('details', { style: { paddingLeft: 20, fontSize: 11, lineHeight: '16px', color: TEXT2 } },
          h('summary', { style: { cursor: 'pointer', width: 'fit-content', color: TEXT2, minHeight: 24, display: 'inline-flex', alignItems: 'center' } }, '诊断信息'),
          h('pre', {
            style: {
              margin: '6px 0 0', padding: 8, borderRadius: 6,
              border: `1px solid ${BORDER_SOFT}`, background: 'rgba(127,127,127,.07)',
              fontFamily: MONO, fontSize: 10.5, lineHeight: '15px',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              maxHeight: 140, overflow: 'auto', color: TEXT2,
            },
          }, detail))
        : null)
    }

    function StateBlock({ tone = 'neutral', title, message, actions, dashed = false, compact = false }) {
      const palette = TONE[tone] || TONE.neutral
      const nodes = Array.isArray(actions) ? actions.filter(Boolean) : (actions ? [actions] : [])
      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6,
          margin: '10px 12px', padding: compact ? '10px 12px' : '20px 16px',
          borderRadius: 10,
          border: dashed ? `1px dashed ${BORDER}` : 'none',
          background: dashed ? 'rgba(127,127,127,.025)' : 'transparent',
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
        h('span', { 'aria-hidden': 'true', style: { width: 8, height: 8, borderRadius: 999, background: palette.dot, flexShrink: 0 } }),
        h('span', { style: { fontSize: 13, fontWeight: 600, lineHeight: '18px', color: TEXT } }, title)),
      message ? h('div', { style: { paddingLeft: 16, fontSize: 12, lineHeight: '19px', color: TEXT2 } }, message) : null,
      nodes.length ? h('div', { style: { paddingLeft: 16, display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 } }, nodes) : null)
    }

    /** 单行错误条：用于「已知宿主缺路由」这类只需要一句解释 + 就地重试的状态。 */
    function InlineNote({ tone = 'warning', title, code, message }) {
      const palette = TONE[tone] || TONE.warning
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          padding: '7px 10px', borderRadius: 7,
          border: `1px solid ${palette.border}`, borderLeft: `3px solid ${palette.dot}`,
          background: palette.bg, fontSize: 11.5, lineHeight: '16px',
        },
      },
      h('span', { 'aria-hidden': 'true', style: { display: 'inline-flex', color: palette.fg } }, h(IconAlert, { size: 13 })),
      h('span', { style: { fontWeight: 600, color: TEXT } }, title),
      code ? h('code', { style: { fontFamily: MONO, fontSize: 10.5, color: palette.fg, border: `1px solid ${palette.border}`, borderRadius: 4, padding: '0 5px', whiteSpace: 'nowrap' } }, code) : null,
      message ? h('span', { title: message, style: { flex: '1 1 240px', minWidth: 0, color: TEXT2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, message) : null)
    }

    function CollapseToggle({ expanded, onToggle, label, title }) {
      const [hover, setHover] = useState(false)
      const [focus, setFocus] = useState(false)
      return h('button', {
        type: 'button',
        onClick: onToggle,
        'aria-expanded': !!expanded,
        title: title || (expanded ? '收起' : '展开'),
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onFocus: () => setFocus(true),
        onBlur: () => setFocus(false),
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '2px 4px', border: 'none', borderRadius: 5,
          background: hover ? RAISED : 'transparent',
          color: TEXT2, font: FONT, fontSize: 11, fontWeight: 600, lineHeight: '16px',
          cursor: 'pointer', outline: focus ? `2px solid ${ACCENT}` : 'none', outlineOffset: 1,
        },
      }, h(IconChevron, { open: !!expanded, size: 12 }), label)
    }

    /**
     * 面板分类分区：一个可折叠标题 + 内容。左侧母体（项目/对话）与右侧分身（任务/项目）
     * 共用；tone 只用于标题前的小圆点，不改变内容颜色。
     */
    function FoldSection({ label, count, collapsed, onToggle, title, tone = 'neutral', extra = null, children }) {
      const palette = TONE[tone] || TONE.neutral
      return h('div', { style: { borderTop: `1px solid ${BORDER_SOFT}` } },
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            padding: '4px 10px', background: 'rgba(127,127,127,.025)',
          },
        },
        h(CollapseToggle, {
          expanded: !collapsed,
          onToggle,
          label: `${label} · ${count}`,
          title: title || (collapsed ? `展开${label}` : `收起${label}`),
        }),
        tone !== 'neutral'
          ? h('span', { 'aria-hidden': 'true', style: { width: 6, height: 6, borderRadius: 999, background: palette.dot, flexShrink: 0 } })
          : null,
        extra),
        collapsed ? null : h('div', null, children))
    }

    // ── 响应式 & 计时 hooks ────────────────────────────────────────────────
    function useMediaQuery(query) {
      const getMatch = () => {
        try { return typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false } catch { return false }
      }
      const [match, setMatch] = useState(getMatch)
      useEffect(() => {
        if (typeof window === 'undefined' || !window.matchMedia) return undefined
        let mql
        try { mql = window.matchMedia(query) } catch { return undefined }
        const onChange = (event) => setMatch(!!event.matches)
        setMatch(!!mql.matches)
        if (mql.addEventListener) mql.addEventListener('change', onChange)
        else if (mql.addListener) mql.addListener(onChange)
        return () => {
          if (mql.removeEventListener) mql.removeEventListener('change', onChange)
          else if (mql.removeListener) mql.removeListener(onChange)
        }
      }, [query])
      return match
    }
    function useElapsed(startAt, active) {
      const [now, setNow] = useState(Date.now())
      useEffect(() => {
        if (!active) return undefined
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [active, startAt])
      return active && startAt ? Math.max(0, Math.round((now - Number(startAt)) / 1000)) : 0
    }

    // ── 会话行（母体=选择；分身=直接打开）──────────────────────────────────
    function SessionRow({ session, variant = 'mother', selected, onSelect, onOpen, compact = false, canOpen = true }) {
      const [hover, setHover] = useState(false)
      const [focus, setFocus] = useState(false)
      const isFork = variant === 'fork'
      const info = sessionTitleInfo(session)
      const isUnnamed = info.source === 'unnamed'
      const activate = () => { if (isFork) onOpen?.(); else onSelect?.() }
      const label = isFork ? (canOpen ? '打开' : '不可打开') : (selected ? '已选中' : '选择')
      const actionColor = isFork
        ? (canOpen ? (hover ? TEXT : TEXT2) : TEXT2)
        : (selected || hover ? TEXT : TEXT2)
      const meta = []
      if (isFork) {
        if (session?.createdAt) meta.push('创建 ' + fmtTime(session.createdAt))
        meta.push('更新 ' + fmtTime(session?.updatedAt))
      } else {
        meta.push(clampText(session?.workspaceTitle) || '未知工作区')
        if (session?.createdAt) meta.push('创建 ' + fmtTime(session.createdAt))
        meta.push('更新 ' + fmtTime(session?.updatedAt))
      }
      return h('div', {
        role: 'button',
        tabIndex: 0,
        'aria-pressed': isFork ? undefined : !!selected,
        'aria-label': sessionAria(session, isFork ? '打开' : '选择') + (isFork && !canOpen ? '，该分身暂无地址' : ''),
        title: sessionTooltip(session),
        onClick: activate,
        onKeyDown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate() }
        },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onFocus: () => setFocus(true),
        onBlur: () => setFocus(false),
        style: {
          display: 'flex', alignItems: 'center', gap: 12,
          minHeight: compact ? 50 : 58,
          padding: compact ? '8px 12px' : '9px 12px',
          borderLeft: `2px solid ${selected ? ACCENT : 'transparent'}`,
          borderBottom: `1px solid ${BORDER_SOFT}`,
          background: selected ? ACCENT_WASH : (hover ? RAISED : 'transparent'),
          cursor: 'pointer',
          outline: focus ? `2px solid ${ACCENT}` : 'none',
          outlineOffset: focus ? -2 : 0,
          transition: 'background 120ms ease',
        },
      },
      h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
          h('span', {
            style: {
              fontSize: compact ? 13 : 14, fontWeight: selected ? 600 : 500, lineHeight: '20px',
              color: TEXT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
            },
          }, info.text),
          isUnnamed ? h(Tag, { mono: true, title: '会话标题缺失；用短 ID 区分，避免整列重复工作区名' }, short(session?.sessionId, 8)) : null,
          info.source === 'first-user' ? h(Tag, { title: '标题取自该会话的首条用户消息' }, '首条') : null,
          session?.empty ? h(Tag, { title: '该会话没有用户消息（空会话），无法继续开发' }, '空会话') : null,
          session?.archived ? h(Tag, null, '已归档') : null),
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap',
            fontSize: 11.5, lineHeight: '16px', color: TEXT2, minWidth: 0,
          },
        },
        meta.map((part, index) => h(React.Fragment, { key: 'm' + index },
          index > 0 ? h('span', { 'aria-hidden': 'true', style: { opacity: 0.5 } }, '·') : null,
          h('span', {
            title: index === 0 && !isFork ? (session?.workspacePath || '') : undefined,
            style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: isFork ? '100%' : (index === 0 ? '52%' : 'none') },
          }, part))))),
      h('span', {
        'aria-hidden': 'true',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0,
          fontSize: 11.5, fontWeight: 500, lineHeight: '16px',
          color: actionColor, whiteSpace: 'nowrap', transition: 'color 120ms ease',
        },
      },
      selected ? h('span', { style: { display: 'inline-flex', color: ACCENT } }, h(IconCheck, { size: 12 })) : null,
      label,
      isFork
        ? (canOpen ? h(IconExternal, { size: 10 }) : null)
        : (selected ? null : h(IconChevron, { open: false, size: 12 }))))
    }

    function GroupHeader({ group, collapsed, onToggle }) {
      const [hover, setHover] = useState(false)
      const [focus, setFocus] = useState(false)
      return h('div', {
        style: {
          position: 'sticky', top: 0, zIndex: 2,
          background: SURFACE_SOLID,
          borderTop: `1px solid ${BORDER_SOFT}`,
          borderBottom: `1px solid ${BORDER_SOFT}`,
        },
      },
      h('button', {
        type: 'button',
        onClick: onToggle,
        'aria-expanded': !collapsed,
        title: group.path ? `${group.title}\n${group.path}` : group.title,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onFocus: () => setFocus(true),
        onBlur: () => setFocus(false),
        style: {
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 12px', border: 'none', textAlign: 'left',
          background: hover ? RAISED : 'transparent', color: TEXT, font: FONT, cursor: 'pointer',
          outline: focus ? `2px solid ${ACCENT}` : 'none', outlineOffset: -2,
        },
      },
      h('span', { style: { display: 'inline-flex', color: TEXT2 } }, h(IconChevron, { open: !collapsed, size: 13 })),
      h('span', { style: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: 1 } },
        h('span', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
          h('span', { style: { fontSize: 12, fontWeight: 600, lineHeight: '16px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, group.title),
          h(Tag, null, String(group.sessions.length))),
        group.path
          ? h('span', { style: { fontSize: 10.5, lineHeight: '14px', color: TEXT2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, group.path)
          : null),
      h('span', { style: { fontSize: 10.5, lineHeight: '14px', color: TEXT2, whiteSpace: 'nowrap' } }, collapsed ? '已收起' : fmtTime(group.latestAt))))
    }

    function ScrollTopFab({ onClick, label }) {
      const [hover, setHover] = useState(false)
      const [focus, setFocus] = useState(false)
      return h('button', {
        type: 'button',
        onClick,
        title: label,
        'aria-label': label,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onFocus: () => setFocus(true),
        onBlur: () => setFocus(false),
        style: {
          position: 'absolute', right: 14, bottom: 14, zIndex: 5,
          width: 30, height: 30, borderRadius: 999,
          border: `1px solid ${BORDER}`,
          background: hover ? RAISED : SURFACE_SOLID,
          color: TEXT2, cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 2px 8px rgba(0,0,0,.08)',
          outline: focus ? `2px solid ${ACCENT}` : 'none', outlineOffset: 2,
        },
      }, h(IconArrowUp, { size: 14 }))
    }

    // ── 分身项目卡 ────────────────────────────────────────────────────────
    function TaskCard({ task, fork, collapsed, onToggleSessions, onOpen, onArchive, onRetrySessions, archiving, onOpenSession, routeMissing, isNarrow }) {
      const health = taskHealth(task)
      const sessions = Array.isArray(fork?.items) ? fork.items : []
      const canOpen = Boolean(task.url)
      const statusTitle = health.anomaly
        ? '进程在运行，但适配器握手失败：该分身可能已无响应（僵尸任务）'
        : (health.adapterOk ? '适配器已握手' : '适配器尚未就绪')
      const sessionBadge = fork?.state === 'error'
        ? h(Tag, { tone: 'danger' }, '读取失败')
        : fork?.busy
          ? h(Tag, null, '刷新中')
          : fork?.state === 'ready'
            ? h(Tag, null, sessions.length + ' 个')
            : h(Tag, null, '读取中')
      const emptyMessage = task.status === 'provisioning'
        ? '分身正在启动；握手完成后刷新即可看到它的会话。'
        : '没有可打开的 URL；若它已停止，可归档回收后重新派生。'

      const body = (() => {
        if (!fork) {
          if (task.status === 'provisioning') {
            return h(StateBlock, { tone: 'info', title: '分身正在启动…', message: '启动完成并完成适配器握手后，这里会列出它的会话。' })
          }
          if (!shouldLoadForkSessions(task)) {
            return h(StateBlock, { tone: 'warning', title: '该分身当前不可读', message: `任务状态为「${health.label}」；恢复或归档后可重新读取。` })
          }
          return h(StateBlock, { tone: 'info', title: '正在读取分身会话…', message: '只读读取该分身自己 sessions 目录的元数据。' })
        }
        if (fork.state === 'error') {
          const knownRouteGap = routeMissing && String(fork.error) === 'http-404'
          const errorNote = knownRouteGap
            ? h(InlineNote, {
              tone: 'warning',
              title: '分身会话读取失败',
              code: fork.error,
              message: '宿主未提供该接口（见右栏顶部说明）；重启母体后再试。',
            })
            : h(Callout, {
              tone: 'danger',
              title: '分身会话读取失败',
              code: fork.error,
              message: failureHint(fork.error, 'fork-sessions'),
              detail: diagnosticText(fork.diagnostic),
              actions: [h(Btn, { key: 'retry', size: 'sm', variant: 'ghost', onClick: onRetrySessions, disabled: fork.busy || false }, h(IconRefresh, { size: 11 }), '重试')],
            })
          return h('div', { style: { padding: '10px 12px 12px' } },
            errorNote,
            sessions.length
              ? h('div', { style: { marginTop: 10 } },
                h('div', { style: { fontSize: 10.5, lineHeight: '16px', color: TEXT2, padding: '0 2px 6px' } }, `上次成功读取的 ${sessions.length} 个会话（可能已过期）`),
                sessions.map((session) => h(SessionRow, {
                  key: 'fs:' + session.sessionId,
                  session,
                  variant: 'fork',
                  compact: true,
                  canOpen,
                  onOpen: () => onOpenSession(task, session),
                })))
              : null)
        }
        if (sessions.length === 0) {
          const degradedNote = fork.degraded && fork.degraded.length ? ` 目录降级：${fork.degraded.join('、')}。` : ''
          return h(StateBlock, {
            tone: 'neutral',
            dashed: true,
            title: '该分身还没有会话',
            message: emptyMessage + degradedNote,
            actions: [
              h(Btn, { size: 'sm', variant: 'ghost', key: 'r', onClick: onRetrySessions, disabled: fork.busy || false }, h(IconRefresh, { size: 11 }), '刷新'),
              canOpen ? h(Btn, { size: 'sm', variant: 'ghost', key: 'o', onClick: () => onOpen(task) }, h(IconExternal, { size: 11 }), '打开分身') : null,
            ].filter(Boolean),
          })
        }
        return h('div', null,
          fork.degraded && fork.degraded.length
            ? h('div', { style: { padding: '6px 12px 0', fontSize: 10.5, lineHeight: '16px', color: TEXT2 } }, '目录降级：' + fork.degraded.join('、'))
            : null,
          sessions.map((session) => h(SessionRow, {
            key: 'fs:' + session.sessionId,
            session,
            variant: 'fork',
            compact: true,
            canOpen,
            onOpen: () => onOpenSession(task, session),
          })),
          Number(fork.total) > sessions.length
            ? h('div', { style: { padding: '6px 12px 8px', fontSize: 10.5, lineHeight: '16px', color: TEXT2 } }, `仅显示最近 ${sessions.length} / ${fork.total} 个分身会话`)
            : null)
      })()

      return h('article', {
        'aria-label': '分身项目：' + (task.title || task.taskId),
        style: {
          border: `1px solid ${health.anomaly ? 'rgba(179,38,30,.34)' : BORDER}`,
          borderLeft: `3px solid ${health.accent}`,
          borderRadius: 10, background: SURFACE, overflow: 'hidden',
          boxShadow: '0 1px 2px rgba(0,0,0,.03)',
        },
      },
      h('div', { style: { display: 'flex', alignItems: isNarrow ? 'stretch' : 'flex-start', flexDirection: isNarrow ? 'column' : 'row', gap: isNarrow ? 8 : 12, padding: '12px 14px', flexWrap: 'wrap' } },
        h('div', { style: { flex: isNarrow ? '1 1 auto' : '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 } },
            h('h3', {
              title: task.title || task.taskId,
              style: {
                margin: 0, fontSize: 15, fontWeight: 600, lineHeight: '22px', color: TEXT,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%',
                ...(isNarrow ? { flex: '1 1 100%', width: '100%' } : {}),
              },
            }, task.title || '未命名分身'),
            h(Pill, { tone: health.tone, dot: true }, health.label),
            h(Pill, { tone: health.adapterTone, dot: true, title: statusTitle }, health.adapterLabel)),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 11.5, lineHeight: '16px', color: TEXT2, minWidth: 0 } },
            h('code', {
              title: '任务 ID：' + String(task.taskId ?? ''),
              style: {
                fontFamily: MONO, fontSize: 10.5, color: TEXT2,
                border: `1px solid ${BORDER_SOFT}`, borderRadius: 4, padding: '0 5px', lineHeight: '16px',
                background: 'rgba(127,127,127,.06)', whiteSpace: 'nowrap',
              },
            }, short(task.taskId, 12)),
            h('span', { 'aria-hidden': 'true', style: { opacity: 0.55 } }, '·'),
            h('span', null, '端口 ', h('span', { style: { fontFamily: MONO, color: TEXT } }, task.port ?? '—')),
            h('span', { 'aria-hidden': 'true', style: { opacity: 0.55 } }, '·'),
            h('span', null, '创建 ', fmtTime(task.createdAt)))),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, marginLeft: isNarrow ? 0 : 'auto', justifyContent: isNarrow ? 'flex-end' : 'flex-start', width: isNarrow ? '100%' : 'auto' } },
          canOpen
            ? h(OpenLink, { href: task.url, title: task.url, ariaLabel: '在新标签页打开分身 ' + (task.title || task.taskId) }, h(IconExternal, { size: 11 }), '打开')
            : h(Btn, { size: 'sm', variant: 'ghost', disabled: true, title: '该分身没有可打开的 URL（可能已停止）' }, h(IconExternal, { size: 11 }), '打开'),
          h(Btn, {
            size: 'sm',
            variant: 'quiet',
            disabled: !!archiving,
            title: '归档并回收该分身：先 flush 缓冲并落审计，再删除该分身的 $DSH_HOME。不可撤销。',
            ariaLabel: '归档分身 ' + (task.title || task.taskId),
            onClick: () => onArchive(task),
          }, archiving ? '归档中…' : '归档'))),
      health.anomaly
        ? h('div', { style: { padding: '0 14px 12px' } },
          h(Callout, {
            tone: 'danger',
            title: '适配器失联 · 疑似僵尸分身',
            code: health.adapterError || 'unknown',
            message: '进程还在运行，但适配器握手失败。该分身可能已无响应；仍可尝试打开，确认不再需要时归档回收。',
            detail: [
              'taskId: ' + task.taskId,
              'status: ' + health.status,
              'adapter.error: ' + (health.adapterError || '—'),
              'port: ' + (task.port ?? '—'),
              'pid: ' + (task.pid ?? '—'),
            ].join('\n'),
          }))
        : null,
      h('div', { style: { borderTop: `1px solid ${BORDER_SOFT}`, background: 'rgba(127,127,127,.02)' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px 6px 12px' } },
          h(CollapseToggle, {
            expanded: !collapsed,
            onToggle: onToggleSessions,
            label: '分身会话',
            title: collapsed ? '展开该分身的会话' : '收起该分身的会话',
          }),
          sessionBadge,
          h('span', { style: { flex: 1 } }),
          h(Btn, {
            size: 'sm',
            variant: 'quiet',
            onClick: onRetrySessions,
            disabled: fork?.busy || false,
            title: '重新读取该分身的会话列表（只读）',
            ariaLabel: '刷新该分身的会话列表',
          }, h(IconRefresh, { size: 11 }), '刷新')),
        collapsed ? null : h('div', { 'aria-busy': fork?.busy ? 'true' : undefined }, body)))
    }

    function ArchivedRow({ task, onOpen }) {
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 10px', borderTop: `1px solid ${BORDER_SOFT}`,
          fontSize: 12, color: TEXT2,
        },
      },
      h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: task.title }, task.title || '未命名分身'),
      h('code', { style: { fontFamily: MONO, fontSize: 10.5, color: TEXT2 } }, short(task.taskId, 8)),
      h(Tag, null, '已归档'),
      task.url ? h(Btn, { size: 'sm', variant: 'quiet', onClick: () => onOpen(task), title: task.url }, '打开') : null)
    }

    // ── 控制面板：3:7 分屏（左=母体项目&会话，右=分身项目&会话）───────────────
    function FangPanel() {
      const [status, setStatus] = useState({ state: 'loading', data: null, error: '', diagnostic: null, at: 0 })
      const [sessions, setSessions] = useState({ state: 'loading', items: [], total: 0, degraded: [], error: '', diagnostic: null, at: 0 })
      const [tasks, setTasks] = useState({ state: 'loading', items: [], error: '', diagnostic: null, at: 0 })
      const [forkSessions, setForkSessions] = useState({})
      const [selected, setSelected] = useState(null)
      const [query, setQuery] = useState('')
      const [collapsedGroups, setCollapsedGroups] = useState(() => new Set())
      const [collapsedTasks, setCollapsedTasks] = useState(() => new Set())
      const [archivedCollapsed, setArchivedCollapsed] = useState(true)
      // v2.6.2 分类折叠：左栏（母体 项目/对话）与右栏（分身 任务/项目）各自记住折叠态。
      const [leftActiveCollapsed, setLeftActiveCollapsed] = useState(false)
      const [leftArchivedCollapsed, setLeftArchivedCollapsed] = useState(true)
      const [leftTempCollapsed, setLeftTempCollapsed] = useState(true)
      const [rightActiveCollapsed, setRightActiveCollapsed] = useState(false)
      const [rightTempCollapsed, setRightTempCollapsed] = useState(true)
      const [activeSessionsExpanded, setActiveSessionsExpanded] = useState(false)
      // 「临时内容」整组显示/隐藏，跨会话记住（storage 不可用时只影响本次面板会话）。
      const [showTemporary, setShowTemporary] = useState(() => readPanelBoolPref(PANEL_TEMP_PREF_KEY, true))
      // v2.7.1 读档：顶栏切换存档 UI；存档 = 进程已停止、home 保留的已归档任务。
      const [showArchive, setShowArchive] = useState(false)
      const toggleTemporary = () => {
        setShowTemporary((value) => {
          const next = !value
          writePanelBoolPref(PANEL_TEMP_PREF_KEY, next)
          return next
        })
      }
      const [busy, setBusy] = useState('')
      const [refreshing, setRefreshing] = useState(false)
      const [notice, setNotice] = useState(null)
      const [derive, setDerive] = useState(state.derive)
      const [scrolled, setScrolled] = useState({ left: false, right: false })
      // v2.6.6：分身 Web UI 里没有母体 API，先探测角色再决定是否刷新/渲染母体面板。
      const hostRole = useHostRole()

      const refreshLock = useRef(false)
      const seqRef = useRef({})
      const aliveRef = useRef(true)
      const leftScrollRef = useRef(null)
      const rightScrollRef = useRef(null)

      useEffect(() => {
        aliveRef.current = true
        return () => { aliveRef.current = false }
      }, [])

      /** 单个分身的会话：独立状态 + 独立重试；失败不影响其它项目。 */
      const loadForkSessions = useCallback(async (taskId, opts = {}) => {
        const id = String(taskId ?? '')
        if (!id) return
        const silent = !!opts.silent
        const seq = (seqRef.current[id] || 0) + 1
        seqRef.current[id] = seq
        setForkSessions((prev) => {
          const old = prev[id]
          return { ...prev, [id]: { ...(old || { state: 'loading', items: [], error: '', at: 0 }), busy: !silent } }
        })
        let result
        try {
          result = await api('/fang/api/tasks/sessions?taskId=' + encodeURIComponent(id) + '&limit=20')
        } catch (e) {
          result = { status: 0, body: null, diagnostic: { message: String(e?.message ?? e) } }
        }
        if (!aliveRef.current || seqRef.current[id] !== seq) return
        const ok = result.status === 200 && result.body && result.body.ok !== false
        setForkSessions((prev) => {
          const old = prev[id] || { state: 'loading', items: [] }
          if (ok) {
            const items = Array.isArray(result.body.sessions) ? result.body.sessions : []
            return {
              ...prev,
              [id]: {
                state: 'ready',
                items,
                degraded: Array.isArray(result.body.degraded) ? result.body.degraded : [],
                total: Number(result.body.total) || items.length,
                error: '',
                diagnostic: null,
                at: Date.now(),
                busy: false,
              },
            }
          }
          const code = result.body?.error || (result.status ? 'http-' + result.status : 'network')
          return {
            ...prev,
            [id]: { ...old, state: 'error', busy: false, error: code, diagnostic: result.diagnostic || null },
          }
        })
      }, [])

      const refresh = useCallback(async (opts = {}) => {
        if (refreshLock.current) return
        refreshLock.current = true
        if (opts.manual) setRefreshing(true)
        try {
          const [statusRes, tasksRes, sessionsRes] = await Promise.all([
            api('/fang/api/status').catch((e) => ({ status: 0, body: null, diagnostic: { message: String(e?.message ?? e) } })),
            api('/fang/api/tasks').catch((e) => ({ status: 0, body: null, diagnostic: { message: String(e?.message ?? e) } })),
            api('/fang/api/sessions').catch((e) => ({ status: 0, body: null, diagnostic: { message: String(e?.message ?? e) } })),
          ])
          if (!aliveRef.current) return

          if (statusRes.status === 200 && statusRes.body && typeof statusRes.body === 'object' && !statusRes.body.error) {
            setStatus({ state: 'ready', data: statusRes.body, error: '', diagnostic: null, at: Date.now() })
          } else {
            const code = statusRes.body?.error || (statusRes.status ? 'http-' + statusRes.status : 'network')
            setStatus((prev) => ({ ...prev, state: 'error', error: code, diagnostic: statusRes.diagnostic || null }))
          }

          let taskItems = []
          if (tasksRes.status === 200 && Array.isArray(tasksRes.body?.tasks)) {
            taskItems = tasksRes.body.tasks
            setTasks({ state: 'ready', items: taskItems, error: '', diagnostic: null, at: Date.now() })
          } else {
            const code = tasksRes.body?.error || (tasksRes.status ? 'http-' + tasksRes.status : 'network')
            setTasks((prev) => ({ ...prev, state: 'error', error: code, diagnostic: tasksRes.diagnostic || null }))
          }

          if (sessionsRes.status === 200 && sessionsRes.body && sessionsRes.body.ok !== false) {
            const body = sessionsRes.body
            const items = Array.isArray(body.sessions) ? body.sessions : []
            const degraded = Array.isArray(body.degraded) ? body.degraded : []
            // sessions-root-missing 是「还没有任何会话」的正常空态，不是错误；其余不可读才算错误。
            const softEmpty = body.readable === false && degraded.includes('sessions-root-missing')
            const readable = body.readable !== false || softEmpty
            setSessions({
              state: readable ? 'ready' : 'error',
              items,
              total: Number(body.total) || items.length,
              degraded,
              error: readable ? '' : (degraded[0] || 'sessions-unreadable'),
              diagnostic: sessionsRes.diagnostic || null,
              at: Date.now(),
            })
          } else {
            const code = sessionsRes.body?.error || (sessionsRes.status ? 'http-' + sessionsRes.status : 'network')
            setSessions((prev) => ({ ...prev, state: 'error', error: code, diagnostic: sessionsRes.diagnostic || null }))
          }

          // 分身会话：只对可能还活着的项目拉取；轮询用 silent，避免每 5s 闪一次「刷新中」。
          const targets = taskItems.filter(shouldLoadForkSessions)
          await Promise.all(targets.map((task) => loadForkSessions(task.taskId, { silent: true })))
        } finally {
          refreshLock.current = false
          if (aliveRef.current && opts.manual) setRefreshing(false)
        }
      }, [loadForkSessions])

      useEffect(() => {
        // 只有确认是母体宿主才拉 /fang/api/*；分身 Web UI 里这些接口不存在（404 是预期）。
        if (hostRole.role !== HOST_ROLE.MOTHER) return undefined
        refresh()
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          refresh()
        }, 5000)
        const onVisible = () => { if (typeof document !== 'undefined' && !document.hidden) refresh() }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        const off = subscribe(setDerive)
        return () => {
          clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
          off()
        }
      }, [refresh, hostRole.role])

      useEffect(() => {
        if (!selected) return undefined
        const onKey = (event) => { if (event.key === 'Escape') setSelected(null) }
        if (typeof window !== 'undefined') window.addEventListener('keydown', onKey)
        return () => { if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey) }
      }, [selected])

      const isNarrow = useMediaQuery('(max-width: 980px)')
      const deriveElapsed = useElapsed(derive?.pending ? derive.at : 0, !!derive?.pending)

      // ── 派生 / 归档 / 打开 ──────────────────────────────────────────────
      const startDerive = async (payload, label) => {
        if (busy) return
        setBusy(label)
        setNotice(null)
        try {
          const result = await api('/fang/api/derive', { method: 'POST', body: JSON.stringify(payload) })
          const body = result.body
          if (result.status === 200 && body?.ok) {
            const actions = body.url ? [{ label: '打开分身', href: body.url }] : []
            setNotice({
              tone: 'success',
              title: payload.sessionId ? '已派生：从会话继续' : '已派生新分身',
              message: `${body.taskId}${body.port ? ' · 端口 ' + body.port : ''}${body.adapter?.ok ? ' · 适配器已就绪' : ' · 适配器尚未就绪，请查看右栏健康徽章'}${importNote(body.importedSession)}`,
              detail: importDetail(body.importedSession),
              actions,
            })
            setSelected(null)
            if (body.url) try { window.open(body.url, '_blank', 'noopener') } catch { /* 面板内链接兜底 */ }
            await refresh()
          } else {
            const code = body?.error || (result.status ? 'http-' + result.status : 'network')
            setNotice({
              tone: 'danger',
              title: '派生失败',
              code,
              message: failureHint(code),
              detail: body?.detail || diagnosticText(result.diagnostic),
              actions: [{ label: '重试', onClick: () => startDerive(payload, label) }],
            })
          }
        } catch (e) {
          setNotice({ tone: 'danger', title: '派生失败', code: 'network', message: String(e?.message ?? e) })
        } finally {
          if (aliveRef.current) setBusy('')
        }
      }

      const archiveTask = async (task) => {
        if (busy) {
          setNotice({ tone: 'warning', title: '操作进行中', message: '请等待当前操作完成后再归档。' })
          return
        }
        const ok = typeof window !== 'undefined' && window.confirm
          ? window.confirm(`归档分身「${task.title || task.taskId}」？\n\n会先 flush 分身缓冲并落审计，然后停止分身进程；存档保留在本地，之后可在「读档」里还原或永久删除。`)
          : false
        if (!ok) return
        const label = 'archive:' + task.taskId
        setBusy(label)
        setNotice(null)
        try {
          const result = await api('/fang/api/tasks/archive', { method: 'POST', body: JSON.stringify({ taskId: task.taskId }) })
          const body = result.body
          if (result.status === 200 && body?.ok) {
            const remoteWarn = body.remote && body.remote.ok === false ? `（远端未确认：${body.remote.error || 'unknown'}）` : ''
            setNotice({
              tone: 'success',
              title: body.already ? '已在存档中' : '已归档',
              message: `${task.title || task.taskId} · 进程已停止，存档保留${remoteWarn}；点顶栏「读档」可还原或删除。`,
            })
          } else {
            const code = body?.error || (result.status ? 'http-' + result.status : 'network')
            setNotice({
              tone: 'danger',
              title: body?.error === 'stop-failed' ? '归档失败：分身进程未停止' : '归档失败',
              code,
              message: body?.error === 'stop-failed'
                ? '宿主已尝试停止进程，但确认它仍在运行；归档没有生效，任务仍保留。请重试或检查 Forker 日志。'
                : failureHint(code),
              detail: body?.detail || diagnosticText(result.diagnostic),
            })
          }
          await refresh()
        } catch (e) {
          setNotice({ tone: 'danger', title: '归档失败', code: 'network', message: String(e?.message ?? e) })
        } finally {
          if (aliveRef.current) setBusy('')
        }
      }

      const restoreTask = async (task) => {
        if (busy) {
          setNotice({ tone: 'warning', title: '操作进行中', message: '请等待当前操作完成后再还原。' })
          return
        }
        const ok = typeof window !== 'undefined' && window.confirm
          ? window.confirm(`还原存档「${task.title || task.taskId}」？\n\n会用原存档重新启动分身（新端口、新 token），存档内容不会丢失。`)
          : false
        if (!ok) return
        setBusy('restore:' + task.taskId)
        setNotice(null)
        try {
          const result = await api('/fang/api/tasks/restore', { method: 'POST', body: JSON.stringify({ taskId: task.taskId }) })
          const body = result.body
          if (result.status === 200 && body?.ok) {
            setShowArchive(false)
            setNotice({
              tone: 'success',
              title: '已还原存档',
              message: `${task.title || task.taskId} 已重新启动（端口 ${body.port ?? '—'}${body.adapter?.ok ? ' · 适配器已就绪' : ' · 适配器尚未就绪'}）`,
              actions: body.url ? [{ label: '打开分身', href: body.url }] : [],
            })
          } else {
            const code = body?.error || (result.status ? 'http-' + result.status : 'network')
            setNotice({ tone: 'danger', title: '还原失败', code, message: failureHint(code), detail: body?.detail || diagnosticText(result.diagnostic) })
          }
          await refresh()
        } catch (e) {
          setNotice({ tone: 'danger', title: '还原失败', code: 'network', message: String(e?.message ?? e) })
        } finally {
          if (aliveRef.current) setBusy('')
        }
      }

      const deleteArchiveTask = async (task) => {
        if (busy) {
          setNotice({ tone: 'warning', title: '操作进行中', message: '请等待当前操作完成后再删除存档。' })
          return
        }
        const ok = typeof window !== 'undefined' && window.confirm
          ? window.confirm(`永久删除存档「${task.title || task.taskId}」？\n\n会删除该分身的 $DSH_HOME 与存档记录，不可撤销。`)
          : false
        if (!ok) return
        setBusy('delete-archive:' + task.taskId)
        setNotice(null)
        try {
          const result = await api('/fang/api/tasks/archive/delete', { method: 'POST', body: JSON.stringify({ taskId: task.taskId }) })
          const body = result.body
          if (result.status === 200 && body?.ok) {
            setNotice({ tone: 'success', title: '存档已删除', message: `${task.title || task.taskId} 的存档与 home 已删除。` })
          } else {
            const code = body?.error || (result.status ? 'http-' + result.status : 'network')
            setNotice({ tone: 'danger', title: '删除存档失败', code, message: failureHint(code), detail: body?.detail || diagnosticText(result.diagnostic) })
          }
          await refresh()
        } catch (e) {
          setNotice({ tone: 'danger', title: '删除存档失败', code: 'network', message: String(e?.message ?? e) })
        } finally {
          if (aliveRef.current) setBusy('')
        }
      }

      const openTask = (task) => {
        if (!task?.url) {
          setNotice({ tone: 'warning', title: '无法打开分身', message: '该分身没有可打开的 URL（可能已停止）。不再需要时可归档回收。' })
          return
        }
        try { window.open(task.url, '_blank', 'noopener') } catch { /* ignore */ }
      }

      const openForkSession = (task, session) => {
        if (task?.url) {
          try { window.open(task.url, '_blank', 'noopener'); return } catch { /* fall through */ }
        }
        setNotice({
          tone: 'warning',
          title: '无法打开分身会话',
          message: `分身「${task?.title || task?.taskId || ''}」没有可打开的 URL；会话 ${short(session?.sessionId, 8)} 仍可在宿主恢复后再试。`,
        })
      }

      const toggleGroup = (key) => {
        setCollapsedGroups((prev) => {
          const next = new Set(prev)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }
      const toggleTask = (taskId) => {
        setCollapsedTasks((prev) => {
          const next = new Set(prev)
          if (next.has(taskId)) next.delete(taskId)
          else next.add(taskId)
          return next
        })
      }
      const scrollToTop = (ref) => {
        try {
          const reduce = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ref.current.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' })
        } catch { try { if (ref.current) ref.current.scrollTop = 0 } catch { /* ignore */ } }
      }
      const makeScrollHandler = (side) => (event) => {
        const next = event.currentTarget.scrollTop > 240
        setScrolled((prev) => (prev[side] === next ? prev : { ...prev, [side]: next }))
      }

      // ── 派生结果 / 提示 ─────────────────────────────────────────────────
      const clearDerive = () => { state.derive = null; state.notify() }
      const deriveBar = derive
        ? (derive.pending
          ? h('div', {
            role: 'status', 'aria-live': 'polite',
            style: {
              flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              padding: '7px 12px', borderRadius: 8, border: `1px solid ${BORDER}`,
              background: RAISED, fontSize: 12, lineHeight: '18px', color: TEXT,
            },
          },
          h('span', { 'aria-hidden': 'true', style: { width: 6, height: 6, borderRadius: 999, background: INFO } }),
          h('span', null, '正在派生分身…'),
          h('span', { 'aria-hidden': 'true', style: { color: TEXT2 } }, `已等待 ${deriveElapsed}s · 通常 5–20s`),
          h('span', { style: { flex: 1 } }),
          h('span', { style: { color: TEXT2, fontSize: 11 } }, '双击图标触发的派生结果也会显示在这里'))
          : (derive.ok
            ? h('div', {
              role: 'status', 'aria-live': 'polite',
              style: {
                flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                padding: '8px 12px', borderRadius: 8,
                border: '1px solid rgba(20,108,58,.28)', borderLeft: `3px solid ${SUCCESS}`,
                background: SUCCESS_WASH, fontSize: 12, lineHeight: '18px', color: TEXT,
              },
            },
            h('span', { 'aria-hidden': 'true', style: { display: 'inline-flex', color: SUCCESS } }, h(IconCheck, { size: 13 })),
            h('span', { style: { fontWeight: 600 } }, derive.adapter?.ok ? '分身已就绪' : '分身已启动'),
            h('span', { style: { color: TEXT2 } }, `端口 ${derive.port ?? '—'} · ${derive.taskId ?? ''}`),
            derive.adapter?.ok ? null : h(Tag, { tone: 'warning', title: '适配器尚未握手；右栏会标出异常，可打开或归档处理' }, '适配器待握手'),
            h('span', { style: { flex: 1 } }),
            derive.url ? h(LinkBtn, { href: derive.url, size: 'sm' }, '打开分身', h(IconExternal, { size: 10 })) : null,
            h(Btn, { size: 'sm', variant: 'quiet', onClick: clearDerive }, '知道了'))
            : h(Callout, {
              tone: 'danger',
              title: '快速派生失败',
              code: derive.error,
              message: derive.message || failureHint(derive.error),
              detail: derive.detail,
              role: 'status',
              actions: [
                h(Btn, { key: 'retry', size: 'sm', variant: 'ghost', onClick: () => quickDerive('重试快速派生') }, '重试'),
                h(Btn, { key: 'close', size: 'sm', variant: 'quiet', onClick: clearDerive }, '知道了'),
              ],
            })))
        : null

      const noticeView = notice
        ? h(Callout, {
          tone: notice.tone || 'info',
          title: notice.title,
          code: notice.code,
          message: notice.message,
          detail: notice.detail,
          role: 'status',
          actions: [
            ...(notice.actions || []).map((action, index) => (action.href
              ? h(LinkBtn, { key: 'a' + index, href: action.href, size: 'sm' }, action.label, h(IconExternal, { size: 10 }))
              : h(Btn, { key: 'a' + index, size: 'sm', variant: 'ghost', onClick: action.onClick }, action.label))),
            h(Btn, { key: 'close', size: 'sm', variant: 'quiet', onClick: () => setNotice(null) }, '关闭'),
          ],
        })
        : null

      // ── 状态与计数 ──────────────────────────────────────────────────────
      const data = status.data
      const ready = Number(data?.tasks?.ready ?? 0) || 0
      const running = Number(data?.tasks?.running ?? 0) || 0
      const max = data?.tasks?.max ?? '—'
      const taskSplit = useMemo(() => {
        const split = classifyTasks(Array.isArray(tasks.items) ? tasks.items : [])
        const byCreatedDesc = (a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0)
        return {
          active: split.active.sort(byCreatedDesc),
          archived: split.archived.sort(byCreatedDesc),
          temporary: split.temporary.sort(byCreatedDesc),
        }
      }, [tasks.items])
      const activeTasks = taskSplit.active
      const archivedTasks = taskSplit.archived
      const tempTasks = showTemporary ? taskSplit.temporary : []
      const anomalies = activeTasks.length
        ? activeTasks.filter((task) => String(task.status) === 'running' && !task.adapter?.ok).length
        : (status.state === 'ready' ? running : 0)
      const normalQuery = query.trim().toLowerCase()
      const filteredSessions = useMemo(() => {
        if (!normalQuery) return sessions.items
        return sessions.items.filter((session) => [sessionTitleInfo(session).text, session.preview, session.sessionId, session.workspaceTitle, session.workspacePath]
          .some((value) => String(value ?? '').toLowerCase().includes(normalQuery)))
      }, [sessions.items, normalQuery])
      const motherSplit = useMemo(() => classifyMotherSessions(filteredSessions), [filteredSessions])
      const motherActiveGroups = useMemo(() => groupSessionsByWorkspace(motherSplit.active), [motherSplit])
      const motherArchivedGroups = useMemo(() => groupSessionsByWorkspace(motherSplit.archived), [motherSplit])
      const motherTempGroups = useMemo(() => groupSessionsByWorkspace(motherSplit.temporary), [motherSplit])
      const motherVisibleCount = showTemporary
        ? motherSplit.active.length + motherSplit.archived.length + motherSplit.temporary.length
        : motherSplit.active.length + motherSplit.archived.length
      const titleStats = useMemo(() => {
        let named = 0
        let unnamed = 0
        let firstUser = 0
        for (const session of sessions.items) {
          const info = sessionTitleInfo(session)
          if (info.source === 'unnamed') unnamed += 1
          else if (info.source === 'first-user') firstUser += 1
          else named += 1
        }
        return { named, unnamed, firstUser }
      }, [sessions.items])
      const sessionCountLabel = sessions.state === 'loading' && sessions.items.length === 0
        ? '—'
        : normalQuery
          ? `${filteredSessions.length}/${sessions.items.length}`
          : (sessions.total > sessions.items.length ? `${sessions.items.length}/${sessions.total}` : String(sessions.items.length))

      const statusBanner = status.state === 'error'
        ? h(Callout, {
          tone: data ? 'warning' : 'danger',
          title: data ? '母体状态刷新失败' : '母体状态不可读',
          code: status.error,
          message: data
            ? `正在显示上次成功读取的数据（${fmtTime(status.at)}）。${failureHint(status.error)}`
            : failureHint(status.error),
          detail: diagnosticText(status.diagnostic),
          actions: [h(Btn, { key: 'retry', size: 'sm', variant: 'ghost', onClick: () => refresh({ manual: true }), disabled: refreshing }, h(IconRefresh, { size: 11 }), '重试')],
        })
        : null

      // ── 顶栏 ────────────────────────────────────────────────────────────
      const stat = (label, value, tone, title) => h('span', {
        title,
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '0 10px', height: 28, fontSize: 11, lineHeight: '16px',
          color: TEXT2, whiteSpace: 'nowrap',
        },
      },
      tone && tone !== 'neutral'
        ? h('span', { 'aria-hidden': 'true', style: { width: 6, height: 6, borderRadius: 999, background: (TONE[tone] || TONE.neutral).dot, flexShrink: 0 } })
        : null,
      h('span', null, label + ' '),
      h('span', { style: { color: TEXT, fontWeight: 600 } }, value))

      const stripDivider = h('span', { 'aria-hidden': 'true', style: { width: 1, height: 14, background: BORDER, flexShrink: 0 } })
      const statusStrip = h('div', {
        role: 'group',
        'aria-label': '母体与配额状态',
        style: {
          display: 'flex', alignItems: 'center', flexWrap: 'wrap',
          border: `1px solid ${BORDER}`, borderRadius: isNarrow ? 10 : 999,
          background: 'rgba(127,127,127,.035)', overflow: 'hidden',
          marginLeft: isNarrow ? 0 : 4,
        },
      },
      stat('母体', (data?.role ?? 'mother') === 'mother' ? '只读' : String(data?.role ?? '—'), 'neutral', '母体只读：这里只读取会话元数据，不会写入或改动母体会话。'),
      isNarrow ? null : stripDivider,
      stat('就绪', data ? `${ready}/${max}` : '—', data && ready > 0 ? 'success' : 'neutral', `适配器已握手的分身 ${ready} 个 / 配额上限 ${max} 个。`),
      isNarrow ? null : stripDivider,
      stat('运行中', data ? String(running) : '—', data && running > 0 ? 'warning' : 'neutral', `进程在运行但适配器尚未握手的分身 ${running} 个；大于 0 时右栏会标出异常。`))

      const header = h('header', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', flexShrink: 0 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 } },
          h('span', {
            style: {
              display: 'inline-flex', width: 32, height: 32, borderRadius: 9,
              alignItems: 'center', justifyContent: 'center',
              background: ACCENT_WASH, border: `1px solid ${ACCENT_LINE}`,
            },
          }, h(GateGlyph, { size: 21, active: true })),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 } },
            h('h1', { style: { margin: 0, fontSize: 19, fontWeight: 600, lineHeight: '24px', letterSpacing: '.01em', color: TEXT } }, '瓮城'),
            h('span', { style: { fontSize: 11, lineHeight: '15px', color: TEXT2, letterSpacing: '.04em' } }, '母体 × 分身 · 双生控制台'))),
        statusStrip,
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginLeft: isNarrow ? 0 : 'auto', width: isNarrow ? '100%' : 'auto' } },
          h(Btn, {
            variant: showArchive ? 'primary' : 'quiet',
            size: 'sm',
            onClick: () => setShowArchive((value) => !value),
            title: '读档：查看已归档分身；可还原（重新启动）或永久删除',
          }, showArchive ? '返回面板' : `读档${archivedTasks.length ? ` (${archivedTasks.length})` : ''}`),
          h(Btn, {
            variant: 'quiet',
            size: 'sm',
            onClick: toggleTemporary,
            title: showTemporary
              ? '隐藏临时内容：空会话（没有用户消息）与快速派生任务（空白分身）；偏好会记住'
              : '显示临时内容：空会话（没有用户消息）与快速派生任务（空白分身）；偏好会记住',
          }, showTemporary ? '隐藏临时内容' : '显示临时内容'),
          h(Btn, {
            variant: 'ghost',
            onClick: () => refresh({ manual: true }),
            disabled: refreshing,
            title: '重新读取母体状态、分身任务与母体会话',
            style: isNarrow ? { flex: '1 1 auto' } : undefined,
          }, h(IconRefresh, { size: 13 }), refreshing ? '刷新中…' : '刷新'),
          h(Btn, {
            variant: 'primary',
            size: 'lg',
            onClick: () => startDerive({ title: '快速派生' }, 'derive'),
            disabled: !!busy,
            title: '派生一个不继承会话的空白分身；双击左侧瓮城图标同样可用',
            style: isNarrow ? { flex: '1 1 200px' } : undefined,
          }, h(IconPlus, { size: 13 }), busy === 'derive' ? '派生中…' : '派生新分身')))

      // ── 左栏：母体项目 & 会话 ───────────────────────────────────────────
      const sessionsBanner = sessions.state === 'error'
        ? h(Callout, {
          tone: sessions.items.length ? 'warning' : 'danger',
          title: sessions.items.length ? '会话目录读取失败 · 显示上次结果' : '会话目录不可读',
          code: sessions.error,
          message: sessions.items.length
            ? `上次成功读取于 ${fmtTime(sessions.at)}。${failureHint(sessions.error)}`
            : failureHint(sessions.error),
          detail: diagnosticText(sessions.diagnostic),
          actions: [h(Btn, { key: 'retry', size: 'sm', variant: 'ghost', onClick: () => refresh({ manual: true }), disabled: refreshing }, h(IconRefresh, { size: 11 }), '重试')],
        })
        : null

      const titleNote = !normalQuery && sessions.items.length >= 3 && titleStats.named === 0 && titleStats.firstUser === 0
        ? h('div', {
          style: {
            padding: '7px 12px', fontSize: 10.5, lineHeight: '16px', color: TEXT2,
            borderBottom: `1px solid ${BORDER_SOFT}`, background: 'rgba(127,127,127,.025)',
          },
        }, '会话标题缺失：宿主未返回 title / preview；列表用「未命名会话 + 短 ID」区分，不把工作区名当标题。')
        : null

      const emptyMother = h(StateBlock, {
        dashed: true,
        title: '还没有可继续的母体会话',
        message: '在本机开一个新对话后刷新，它会出现在这里；选择会话只读元数据，母体会话不会被改写。',
        actions: [h(Btn, { key: 'refresh', size: 'sm', variant: 'ghost', onClick: () => refresh({ manual: true }), disabled: refreshing }, h(IconRefresh, { size: 11 }), '刷新')],
      })
      const noMatch = h(StateBlock, {
        dashed: true,
        tone: 'neutral',
        title: `没有匹配「${clampText(query, 24)}」的会话`,
        message: '可以搜索标题、会话 ID、工作区名；也可以清除搜索查看全部已加载会话。',
        actions: [h(Btn, { key: 'clear', size: 'sm', variant: 'ghost', onClick: () => setQuery('') }, '清除搜索')],
      })

      const leftParts = []
      if (sessionsBanner) leftParts.push(h('div', { key: 'err', style: { padding: '10px 10px 0' } }, sessionsBanner))

      /** 一个分类分区内的 workspace 组；limit>0 时只渲染前 limit 条会话（进行中分区用）。 */
      const renderSessionGroups = (groups, { limit = 0, sectionKey = '' } = {}) => {
        const nodes = []
        let shown = 0
        const cap = limit > 0 && !activeSessionsExpanded ? limit : Infinity
        for (const group of groups) {
          if (shown >= cap) break
          const room = cap === Infinity ? group.sessions.length : Math.max(0, cap - shown)
          if (room === 0) break
          const sessions = group.sessions.slice(0, room)
          shown += sessions.length
          // 同一个工作区可能同时出现在「进行中/已归档/临时」三个分区；折叠状态按分区独立。
          const collapseKey = `${sectionKey}:${group.key}`
          nodes.push(h('div', { key: sectionKey + ':g:' + group.key },
            h(GroupHeader, {
              group,
              collapsed: collapsedGroups.has(collapseKey),
              onToggle: () => toggleGroup(collapseKey),
            }),
            collapsedGroups.has(collapseKey)
              ? null
              : h('div', null, sessions.map((session) => h(SessionRow, {
                key: 's:' + session.sessionId,
                session,
                selected: selected?.item?.sessionId === session.sessionId,
                onSelect: () => setSelected({ item: session }),
              })))))
        }
        return { nodes, shown }
      }

      if (sessions.state === 'loading' && sessions.items.length === 0) {
        leftParts.push(h(StateBlock, { key: 'load', tone: 'info', title: '正在读取母体会话…', message: '只读扫描会话目录；不打开会话正文。' }))
      } else if (motherVisibleCount === 0) {
        if (!(sessions.state === 'error' && sessions.items.length === 0)) {
          if (!normalQuery && motherSplit.temporary.length > 0 && !showTemporary) {
            leftParts.push(h(StateBlock, {
              key: 'temp-hidden',
              dashed: true,
              tone: 'neutral',
              title: `当前只有 ${motherSplit.temporary.length} 条临时内容（已隐藏）`,
              message: '临时 = 空会话（没有用户消息，无法继续开发）。可以在顶栏「显示临时内容」中重新打开。',
              actions: [h(Btn, { key: 'show', size: 'sm', variant: 'ghost', onClick: toggleTemporary }, '显示临时内容')],
            }))
          } else {
            leftParts.push(h('div', { key: 'empty' }, normalQuery ? noMatch : emptyMother))
          }
        }
      } else {
        if (titleNote) leftParts.push(h('div', { key: 'note' }, titleNote))
        const activeCollapsed = leftActiveCollapsed
        const activeLimit = PANEL_ACTIVE_LIMIT
        const activeGroupsRender = renderSessionGroups(motherActiveGroups, { limit: activeLimit, sectionKey: 'active' })
        const activeHidden = motherSplit.active.length - activeGroupsRender.shown
        leftParts.push(h('div', { key: 'sections' },
          motherSplit.active.length > 0
            ? h(FoldSection, {
              key: 'active',
              label: '进行中',
              count: motherSplit.active.length,
              collapsed: activeCollapsed,
              onToggle: () => setLeftActiveCollapsed((value) => !value),
              title: activeCollapsed ? '展开进行中的项目 & 对话' : '收起进行中的项目 & 对话',
              tone: 'success',
              extra: activeHidden > 0 || (activeSessionsExpanded && motherSplit.active.length > activeLimit)
                ? h(Btn, {
                  size: 'sm',
                  variant: 'quiet',
                  onClick: () => setActiveSessionsExpanded((value) => !value),
                  title: activeSessionsExpanded ? `只显示前 ${activeLimit} 个会话` : `展开其余 ${activeHidden} 个会话`,
                }, activeSessionsExpanded ? '收起多余会话' : `展开剩余 ${activeHidden} 个`)
                : null,
            }, h('div', null,
              activeGroupsRender.nodes,
              activeHidden > 0
                ? h('div', {
                  style: { padding: '6px 14px 8px', fontSize: 10.5, lineHeight: '16px', color: TEXT2 },
                }, `进行中会话只显示前 ${activeLimit} 个，其余 ${activeHidden} 个已折叠。`)
                : null))
            : null,
          motherSplit.archived.length > 0
            ? h(FoldSection, {
              key: 'archived',
              label: '已归档',
              count: motherSplit.archived.length,
              collapsed: leftArchivedCollapsed,
              onToggle: () => setLeftArchivedCollapsed((value) => !value),
              title: leftArchivedCollapsed ? '展开已归档的项目 & 对话（默认折叠）' : '收起已归档的项目 & 对话',
            }, h('div', null, renderSessionGroups(motherArchivedGroups, { sectionKey: 'archived' }).nodes))
            : null,
          showTemporary && motherSplit.temporary.length > 0
            ? h(FoldSection, {
              key: 'temp',
              label: '临时',
              count: motherSplit.temporary.length,
              collapsed: leftTempCollapsed,
              onToggle: () => setLeftTempCollapsed((value) => !value),
              title: '临时 = 空会话（没有用户消息，无法继续开发）；默认折叠，可在顶栏隐藏整组',
              tone: 'warning',
            }, h('div', null, renderSessionGroups(motherTempGroups, { sectionKey: 'temp' }).nodes))
            : null))
        if (sessions.total > sessions.items.length) {
          leftParts.push(h('div', {
            key: 'trunc',
            style: {
              padding: '8px 14px', fontSize: 10.5, lineHeight: '16px', color: TEXT2,
              borderTop: `1px solid ${BORDER_SOFT}`,
            },
          }, `仅加载最近 ${sessions.items.length} / ${sessions.total} 个会话；搜索只覆盖已加载条目。`))
        }
      }

      const leftHead = h('div', {
        style: {
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
          padding: '9px 14px', borderBottom: `1px solid ${BORDER}`,
        },
      },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: 1 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
          h('h2', { style: { margin: 0, fontSize: 13, fontWeight: 600, lineHeight: '18px', whiteSpace: 'nowrap' } }, '母体')),
        h('span', { style: { fontSize: 11, lineHeight: '15px', color: TEXT2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, '项目 & 会话 · 选中会话后继续开发')),
      h(Pill, {
        tone: 'neutral',
        title: `进行中 ${motherSplit.active.length} · 已归档 ${motherSplit.archived.length}`
          + (showTemporary ? ` · 临时 ${motherSplit.temporary.length}` : ' · 临时已隐藏')
          + `；已加载 ${sessions.items.length} 个会话${sessions.total > sessions.items.length ? `，母体共 ${sessions.total} 个` : ''}`,
      }, `${sessionCountLabel} 会话`))

      const leftSection = h('section', {
        role: 'region',
        'aria-label': '母体项目与会话',
        style: {
          display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0,
          border: `1px solid ${BORDER}`, borderRadius: 12, overflow: 'hidden',
          background: SURFACE, boxShadow: '0 1px 2px rgba(0,0,0,.03)',
          position: 'relative',
          ...(isNarrow ? { height: 'clamp(240px, 44vh, 460px)' } : {}),
        },
      },
      leftHead,
      h('div', { style: { flexShrink: 0, padding: '8px 10px', borderBottom: `1px solid ${BORDER_SOFT}` } },
        h(SearchField, {
          value: query,
          onChange: setQuery,
          placeholder: '搜索会话：标题、短 ID 或工作区',
        })),
      h('div', {
        ref: leftScrollRef,
        'aria-busy': sessions.state === 'loading' ? 'true' : undefined,
        onScroll: makeScrollHandler('left'),
        style: { flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', scrollbarGutter: 'stable', paddingBottom: scrolled.left ? 44 : 0 },
      }, leftParts),
      scrolled.left ? h(ScrollTopFab, { onClick: () => scrollToTop(leftScrollRef), label: '回到会话列表顶部' }) : null)

      // ── 右栏：分身项目 & 会话 ──────────────────────────────────────────
      const forkStates = activeTasks.map((task) => forkSessions[task.taskId]).filter(Boolean)
      const routeMissing = activeTasks.length > 0
        && forkStates.length === activeTasks.length
        && forkStates.every((fork) => fork.state === 'error' && String(fork.error) === 'http-404')

      const routeBanner = routeMissing
        ? h(Callout, {
          tone: 'warning',
          title: '分身会话接口不可用（HTTP 404）',
          code: 'http-404',
          message: `宿主未提供 /fang/api/tasks/sessions（v2.2.0 起加入）。重启母体后再试；分身本身仍可打开。${data?.version ? `宿主版本 ${data.version}。` : ''}`,
          detail: diagnosticText(forkStates[0]?.diagnostic),
          actions: [h(Btn, {
            key: 'retry-all',
            size: 'sm',
            variant: 'ghost',
            onClick: () => { for (const task of activeTasks) loadForkSessions(task.taskId) },
          }, h(IconRefresh, { size: 11 }), '全部重试')],
        })
        : null

      const tasksBanner = tasks.state === 'error'
        ? h(Callout, {
          tone: tasks.items.length ? 'warning' : 'danger',
          title: tasks.items.length ? '分身列表刷新失败 · 显示上次结果' : '分身列表不可读',
          code: tasks.error,
          message: failureHint(tasks.error),
          detail: diagnosticText(tasks.diagnostic),
          actions: [h(Btn, { key: 'retry', size: 'sm', variant: 'ghost', onClick: () => refresh({ manual: true }), disabled: refreshing }, h(IconRefresh, { size: 11 }), '重试')],
        })
        : null

      const emptyRight = h('div', {
        style: {
          border: `1px dashed ${BORDER}`, borderRadius: 12,
          padding: '30px 18px', display: 'flex', flexDirection: 'column',
          alignItems: 'center', textAlign: 'center', gap: 8,
          background: 'rgba(127,127,127,.025)',
        },
      },
      h('span', {
        style: {
          width: 42, height: 42, borderRadius: 12, display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center',
          background: ACCENT_WASH, border: `1px solid ${ACCENT_LINE}`,
        },
      }, h(GateGlyph, { size: 24, active: true })),
      h('span', { style: { fontSize: 14, fontWeight: 600, lineHeight: '20px', color: TEXT } }, '还没有分身'),
      h('span', { style: { fontSize: 12, lineHeight: '19px', color: TEXT2, maxWidth: 440 } }, '派生一个分身后，它会作为一个项目出现在这里，并拥有自己的会话列表。双击左侧「瓮城」图标也能快速派生。'),
      h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 2 } },
        h(Btn, { variant: 'primary', disabled: !!busy, onClick: () => startDerive({ title: '快速派生' }, 'derive') }, h(IconPlus, { size: 13 }), busy === 'derive' ? '派生中…' : '派生新分身'),
        h(Btn, { variant: 'ghost', onClick: () => refresh({ manual: true }), disabled: refreshing }, h(IconRefresh, { size: 12 }), refreshing ? '刷新中…' : '刷新')))

      const rightParts = []
      if (routeBanner) rightParts.push(h('div', { key: 'route', style: { padding: '10px 12px 0' } }, routeBanner))
      if (tasksBanner) rightParts.push(h('div', { key: 'taskserr', style: { padding: '10px 12px 0' } }, tasksBanner))
      if (tasks.state === 'loading' && tasks.items.length === 0) {
        rightParts.push(h(StateBlock, { key: 'loading', tone: 'info', title: '正在读取分身列表…' }))
      } else if (activeTasks.length === 0 && archivedTasks.length === 0 && tempTasks.length === 0) {
        if (tasks.state !== 'error') {
          const hasHiddenTemp = !showTemporary && taskSplit.temporary.length > 0
          rightParts.push(h('div', { key: 'empty', style: { padding: '16px 14px' } },
            hasHiddenTemp
              ? h(StateBlock, {
                dashed: true,
                tone: 'neutral',
                title: `当前只有 ${taskSplit.temporary.length} 个临时任务（已隐藏）`,
                message: '临时 = 快速派生（空白、未继承会话）的分身任务；可在顶栏「显示临时内容」重新打开。',
                actions: [h(Btn, { key: 'show', size: 'sm', variant: 'ghost', onClick: toggleTemporary }, '显示临时内容')],
              })
              : emptyRight))
        }
      } else {
        const taskCards = (items) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: '12px' } },
          items.map((task) => h(TaskCard, {
            key: task.taskId,
            task,
            fork: forkSessions[task.taskId],
            collapsed: collapsedTasks.has(task.taskId),
            onToggleSessions: () => toggleTask(task.taskId),
            onOpen: openTask,
            onArchive: archiveTask,
            onRetrySessions: () => loadForkSessions(task.taskId),
            archiving: busy === 'archive:' + task.taskId,
            onOpenSession: openForkSession,
            routeMissing,
            isNarrow,
          })))
        if (activeTasks.length > 0) {
          rightParts.push(h(FoldSection, {
            key: 'active',
            label: '进行中',
            count: activeTasks.length,
            collapsed: rightActiveCollapsed,
            onToggle: () => setRightActiveCollapsed((value) => !value),
            title: rightActiveCollapsed ? '展开进行中的任务 & 项目' : '收起进行中的任务 & 项目',
            tone: 'success',
          }, taskCards(activeTasks)))
        } else {
          rightParts.push(h('div', { key: 'noactive', style: { padding: '10px 14px 0', fontSize: 12, color: TEXT2 } }, '当前没有进行中的分身。'))
        }
        if (archivedTasks.length > 0) {
          rightParts.push(h('div', {
            key: 'archivehint',
            style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '10px 14px 0', fontSize: 11.5, lineHeight: '18px', color: TEXT2 },
          },
          h('span', null, `有 ${archivedTasks.length} 个存档（进程已停止，home 保留）。`),
          h(Btn, { size: 'sm', variant: 'ghost', onClick: () => setShowArchive(true) }, '打开读档')))
        }
        if (showTemporary && tempTasks.length > 0) {
          rightParts.push(h(FoldSection, {
            key: 'temp',
            label: '临时',
            count: tempTasks.length,
            collapsed: rightTempCollapsed,
            onToggle: () => setRightTempCollapsed((value) => !value),
            title: '临时 = 快速派生（空白、未继承会话）的分身任务；默认折叠，可在顶栏隐藏整组',
            tone: 'warning',
          }, taskCards(tempTasks)))
        }
      }

      const rightHead = h('div', {
        style: {
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
          padding: '9px 14px', borderBottom: `1px solid ${BORDER}`,
        },
      },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: 1 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
          h('h2', { style: { margin: 0, fontSize: 13, fontWeight: 600, lineHeight: '18px', whiteSpace: 'nowrap' } }, '分身'),
          h(Tag, { title: '每个任务是一个项目；项目里是该分身自己的会话' }, '每个任务一个项目')),
        h('span', { style: { fontSize: 11, lineHeight: '15px', color: TEXT2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, '项目 & 会话 · 会话直接在分身标签页打开')),
      h(Pill, {
        tone: anomalies > 0 ? 'danger' : 'neutral',
        dot: anomalies > 0,
        title: anomalies > 0
          ? `${anomalies} 个运行中分身的适配器未握手，需要处理`
          : `进行中 ${activeTasks.length} 个${archivedTasks.length ? `，已归档 ${archivedTasks.length} 个` : ''}${showTemporary && tempTasks.length ? `，临时 ${tempTasks.length} 个` : ''}`,
      }, anomalies > 0 ? `${activeTasks.length} 项目 · ${anomalies} 异常` : `${activeTasks.length} 项目`))

      const rightSection = h('section', {
        role: 'region',
        'aria-label': '分身项目与会话',
        style: {
          display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0,
          border: `1px solid ${BORDER}`, borderRadius: 12, overflow: 'hidden',
          background: SURFACE, boxShadow: '0 1px 2px rgba(0,0,0,.03)',
          position: 'relative',
          ...(isNarrow ? { height: 'clamp(260px, 54vh, 560px)' } : {}),
        },
      },
      rightHead,
      h('div', {
        ref: rightScrollRef,
        'aria-busy': tasks.state === 'loading' ? 'true' : undefined,
        onScroll: makeScrollHandler('right'),
        style: { flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', scrollbarGutter: 'stable', paddingBottom: scrolled.right ? 44 : 0 },
      }, rightParts),
      scrolled.right ? h(ScrollTopFab, { onClick: () => scrollToTop(rightScrollRef), label: '回到分身列表顶部' }) : null)

      // ── 选中确认条（两段式：先选，再确认）────────────────────────────────
      const selectedInfo = selected ? sessionTitleInfo(selected.item) : null
      const selectedBar = selected
        ? h('div', {
          role: 'status',
          'aria-live': 'polite',
          style: {
            flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            padding: '11px 14px', borderRadius: 10,
            border: `1px solid ${ACCENT_LINE}`, borderLeft: `3px solid ${ACCENT}`,
            background: SURFACE_SOLID, boxShadow: '0 2px 10px rgba(0,0,0,.05)',
          },
        },
        h('div', { style: { flex: isNarrow ? '1 1 100%' : '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
          h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 600, letterSpacing: '.04em', color: TEXT2 } },
            h('span', { style: { display: 'inline-flex', color: ACCENT } }, h(IconCheck, { size: 11 })), '已选 · 母体会话'),
          h('div', {
            style: {
              fontSize: 14, fontWeight: 600, lineHeight: '20px', color: TEXT,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          },
          selectedInfo.text,
          selectedInfo.source === 'unnamed'
            ? h('span', { style: { marginLeft: 6, fontFamily: MONO, fontSize: 11, fontWeight: 400, color: TEXT2 } }, short(selected.item.sessionId, 8))
            : null),
          h('div', { style: { fontSize: 12, lineHeight: '18px', color: TEXT2 } },
            selected.item.empty
              ? '该会话没有用户消息，无法继续开发；请选择有内容的会话。'
              : '派生 1 个分身：导入这段历史会话（超过大小上限时只带交接摘要）；母体会话保持只读。')),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginLeft: isNarrow ? 0 : 'auto', justifyContent: isNarrow ? 'flex-end' : 'flex-start', width: isNarrow ? '100%' : 'auto', flexWrap: 'wrap' } },
          h(Btn, { variant: 'quiet', onClick: () => setSelected(null), title: '取消选择（Esc）' }, '取消'),
          h(Btn, {
            variant: 'primary',
            disabled: !!busy || selected.item.empty === true,
            title: selected.item.empty ? '空会话（没有用户消息），无法继续开发' : undefined,
            onClick: () => startDerive({ sessionId: selected.item.sessionId, title: '从会话继续 · ' + sessionDisplayText(selected.item) }, 'derive-session'),
            style: isNarrow ? { flex: 1 } : undefined,
          }, busy === 'derive-session' ? '派生中…' : '继续开发 →')))
        : null

      const isMobile = isNarrow
      const rootStyle = {
        height: isMobile ? 'auto' : '100%',
        minHeight: isMobile ? '100%' : 0,
        display: 'flex', flexDirection: 'column', gap: 12,
        padding: isMobile ? '14px 14px 18px' : '18px 22px 14px',
        boxSizing: 'border-box',
        color: TEXT, font: FONT,
        overflowY: isMobile ? 'auto' : 'hidden',
      }
      const splitStyle = isMobile
        ? { display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gridAutoRows: 'auto', gap: 12 }
        : { flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0,3fr) minmax(0,7fr)', gap: 12 }

      // ── 读档（v2.7.1）：存档 = 进程已停止、home 保留的已归档任务 ─────────
      const archiveView = h('section', {
        role: 'region',
        'aria-label': '瓮城读档',
        style: {
          display: 'flex', flexDirection: 'column', minHeight: 0,
          border: `1px solid ${BORDER}`, borderRadius: 12, overflow: 'hidden',
          background: SURFACE, boxShadow: '0 1px 2px rgba(0,0,0,.03)',
        },
      },
      h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '10px 14px', borderBottom: `1px solid ${BORDER}` },
      },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 } },
        h('h2', { style: { margin: 0, fontSize: 13, fontWeight: 600, lineHeight: '18px' } }, '读档 · 存档管理'),
        h('span', { style: { fontSize: 11, lineHeight: '16px', color: TEXT2 } }, '归档会停止分身进程并保留 home；还原会用存档重新启动，删除会永久移除 home。')),
      h(Tag, { title: '已归档分身数量' }, `${archivedTasks.length} 个存档`)),
      tasks.state === 'error' ? h('div', { style: { padding: '10px 14px 0' } }, tasksBanner) : null,
      h('div', {
        style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 },
      },
      archivedTasks.length === 0
        ? h(StateBlock, {
          dashed: true,
          title: '还没有存档',
          message: '在分身卡片上点「归档」会停止进程并保留存档；之后在这里还原或永久删除。',
        })
        : archivedTasks.map((task) => h('div', {
          key: task.taskId,
          style: {
            border: `1px solid ${BORDER}`, borderRadius: 10, padding: 12, background: RAISED,
            display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0,
          },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 } },
          h('span', { style: { fontSize: 13, fontWeight: 600, color: TEXT, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, task.title || '未命名分身'),
          h(Tag, null, '已归档')),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 11, lineHeight: '17px', color: TEXT2 } },
          h('code', { style: { fontFamily: MONO, fontSize: 10.5 } }, short(task.taskId, 10)),
          h('span', null, `归档于 ${fmtTime(task.archivedAt)}`),
          task.archiveRemote && task.archiveRemote.ok === false
            ? h('span', { style: { color: WARNING } }, `远端未确认：${task.archiveRemote.error || 'unknown'}`)
            : null),
        h('span', { style: { fontSize: 11, lineHeight: '17px', color: TEXT3 } },
          task.homeDir
            ? '存档保留在本地；还原会重新启动分身（新端口、新 token），会话与文件仍在。'
            : '存档 home 已不存在；只能删除记录。'),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h(Btn, {
            size: 'sm',
            variant: 'primary',
            disabled: !!busy || !task.homeDir,
            onClick: () => restoreTask(task),
            title: task.homeDir ? '用该存档重新启动分身' : '存档 home 缺失，无法还原',
          }, busy === 'restore:' + task.taskId ? '还原中…' : '还原'),
          h(Btn, {
            size: 'sm',
            variant: 'ghost',
            disabled: !!busy,
            onClick: () => deleteArchiveTask(task),
            title: '永久删除该存档与 $DSH_HOME（不可撤销）',
            style: { color: DANGER },
          }, busy === 'delete-archive:' + task.taskId ? '删除中…' : '删除存档'))))))

      if (showArchive) {
        return h('div', { role: 'region', 'aria-label': '瓮城读档', style: rootStyle },
          header,
          noticeView,
          h('div', { style: { flex: 1, minHeight: 0, display: 'flex' } }, archiveView))
      }

      // 分身 Web UI：母体 API 不存在，渲染专用说明页，并且不发起 /fang/api/* 请求（v2.6.6）。
      if (hostRole.role === HOST_ROLE.FORK) return h(ForkHostNotice, { role: hostRole })

      return h('div', { role: 'region', 'aria-label': '瓮城控制台', style: rootStyle },
        header,
        statusBanner,
        deriveBar,
        noticeView,
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, flex: isMobile ? '0 0 auto' : '1 1 auto', minHeight: 0 } },
          h('div', { style: splitStyle },
            leftSection,
            isMobile && selectedBar ? selectedBar : null,
            rightSection),
          isMobile ? null : selectedBar),
        h('div', {
          style: {
            flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            fontSize: 11, lineHeight: '16px', color: TEXT2,
          },
        },
        h('span', null, '双击左侧「瓮城」图标或输入框徽标 = 快速派生；单击 = 打开本面板；两栏各自滚动；进行中只先显示 7 条会话，归档/临时默认折叠。'),
        h('span', { style: { flex: 1 } }),
        data?.version ? h('span', { style: { fontFamily: MONO, fontSize: 10.5, color: TEXT2 }, title: '宿主侧 dsh-Fang 版本' }, 'v' + data.version) : null,
        h(LinkBtn, { href: '/fang/panel', tone: 'muted', size: 'sm' }, '独立门户', h(IconExternal, { size: 10 }))))
    }

    // ── 输入框 dock 徽标：状态 + 单手加速器 ────────────────────────────────
    function FangBadge(props) {
      const [view, setView] = useState({ loaded: false, ready: 0, max: 0, running: 0, anomalies: 0, error: false })
      const [derive, setDerive] = useState(state.derive)
      const [hover, setHover] = useState(false)
      const [focus, setFocus] = useState(false)
      const handle = useMemo(() => makeDoubleTap(() => quickDerive('徽标快速派生')), [])
      const hostRole = useHostRole()

      useEffect(() => {
        // 分身 Web UI 没有母体状态接口：不 polling、不显示「瓮城离线」假故障。
        if (hostRole.role !== HOST_ROLE.MOTHER) return undefined
        let alive = true
        const poll = async () => {
          try {
            const result = await api('/fang/api/status')
            if (!alive) return
            const body = result.body
            if (result.status !== 200 || !body || body.error) {
              setView((prev) => ({ ...prev, loaded: true, error: true }))
              return
            }
            const list = Array.isArray(body.tasks?.list) ? body.tasks.list : []
            const anomalies = list.length
              ? list.filter((task) => String(task.status) === 'running' && !task.adapter?.ok).length
              : (Number(body.tasks?.running) || 0)
            setView({
              loaded: true,
              ready: Number(body.tasks?.ready) || 0,
              max: Number(body.tasks?.max) || 0,
              running: Number(body.tasks?.running) || 0,
              anomalies,
              error: false,
            })
          } catch {
            if (alive) setView((prev) => ({ ...prev, loaded: true, error: true }))
          }
        }
        poll()
        const timer = setInterval(poll, 10000)
        const off = subscribe(setDerive)
        return () => { alive = false; clearInterval(timer); off() }
      }, [hostRole.role])

      const openPanel = () => {
        try {
          const layout = props?.ctx?.layout
          if (layout && typeof layout.selectPanel === 'function') { layout.selectPanel('fang'); return }
        } catch { /* fall through */ }
        try { window.open('/fang/panel', '_blank', 'noopener') } catch { /* ignore */ }
      }

      const pending = derive?.pending
      const tone = view.error ? 'warning' : (view.anomalies > 0 ? 'danger' : (view.ready > 0 ? 'success' : 'info'))
      const dotColor = (TONE[tone] || TONE.info).dot
      const label = view.error
        ? '瓮城离线'
        : pending
          ? '派生中…'
          : view.anomalies > 0
            ? `瓮城 · ${view.anomalies} 异常`
            : (view.loaded ? `瓮城 ${view.ready}/${view.max || '?'}` : '瓮城')
      const title = view.error
        ? '无法读取 /fang/api/status（宿主侧 dsh-Fang 未加载或路由不可用）'
        : view.anomalies > 0
          ? `瓮城：${view.anomalies} 个运行中分身的适配器未握手；单击打开面板，双击快速派生`
          : '瓮城：单击打开面板，双击快速派生分身'

      if (hostRole.role === HOST_ROLE.FORK) return null // 分身 Web UI 不显示母体状态徽标

      return h('div', {
        title,
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '2px 8px', borderRadius: 999,
          font: FONT, fontSize: 11, lineHeight: '16px', color: TEXT2,
          border: `1px solid ${view.error ? TONE.warning.border : BORDER}`,
          background: hover ? RAISED : 'transparent',
          userSelect: 'none', transition: 'background 120ms ease',
        },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
      },
      h('span', { 'aria-hidden': 'true', style: { width: 6, height: 6, borderRadius: 999, background: dotColor, display: 'inline-block' } }),
      h('button', {
        type: 'button',
        onClick: openPanel,
        onDoubleClick: handle,
        title,
        onFocus: () => setFocus(true),
        onBlur: () => setFocus(false),
        style: {
          font: 'inherit', color: view.error ? WARNING : TEXT2,
          background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
          outline: focus ? `2px solid ${ACCENT}` : 'none', outlineOffset: 2, borderRadius: 3,
        },
      }, pending ? '派生中…' : label),
      h('a', {
        href: '/fang/panel', target: '_blank', rel: 'noopener',
        title: '独立兜底门户（面板不可用时的备用入口）',
        'aria-label': '打开瓮城独立门户',
        style: {
          marginLeft: 2, padding: '0 5px', borderRadius: 999,
          border: `1px solid ${BORDER}`, color: TEXT2, textDecoration: 'none',
          fontSize: 10, lineHeight: '14px',
        },
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
        }, (props) => h(GateGlyph, { size: props?.size, active: props?.active, quick: true }))))
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
