// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// Client DOM test: 真正在 jsdom 里挂载收件箱，覆盖分组/折叠/ACK/409/批量部分失败/SSE 合并。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// jsdom 是 devDependency；干净的 CI checkout 可能没装。跳过而不是让整套测试红。
let JSDOM = null
try { ({ JSDOM } = await import('jsdom')) } catch { /* optional */ }
if (!JSDOM) {
  test('client-inbox-dom: skipped (jsdom not installed)', (t) => t.skip('jsdom not installed'))
} else {

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const waitFor = async (fn, { timeout = 2000, interval = 10 } = {}) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error('waitFor timeout')
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async text() { return JSON.stringify(body) },
    async json() { return body },
  }
}

function streamResponse(frames) {
  let index = 0
  const encoder = new TextEncoder()
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          async read() {
            if (index < frames.length) return { done: false, value: encoder.encode(frames[index++]) }
            return new Promise(() => {}) // keep stream open like SSE
          },
          async cancel() {},
        }
      },
    },
  }
}

function makeHarness({ tickets = [], onResolve = null, onAbandon = null, sseFrames = [], services = {}, essences = null } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'dangerously' })
  const { window } = dom
  window.TextDecoder = TextDecoder
  window.TextEncoder = TextEncoder
  const calls = []
  window.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (String(url).includes('/fang/api/auth-token')) return jsonResponse({ token: 'test-token' })
    if (essences && String(url).includes('/fang/api/essence/list')) {
      return jsonResponse({ ok: true, essences, defaultId: essences[0]?.id ?? '', staleCount: 0 })
    }
    if (String(url).includes('/fang/api/decisions/events')) return streamResponse(sseFrames)
    if (String(url).includes('/fang/api/decisions/ai')) return jsonResponse({ ok: true, configured: false, providers: [] })
    if (String(url).includes('/fang/api/decisions/resolve')) {
      const body = JSON.parse(init.body || '{}')
      return onResolve ? onResolve(body) : jsonResponse({ ok: true, ticket: { id: body.id ?? 'x', status: 'resolved' } })
    }
    if (String(url).includes('/fang/api/decisions/abandon')) {
      const body = JSON.parse(init.body || '{}')
      return onAbandon ? onAbandon(body) : jsonResponse({ ok: true, results: (body.ids ?? [body.id]).map((id) => ({ id, ok: true })) })
    }
    if (String(url).includes('/fang/api/decisions')) {
      const parsed = new URL(String(url), 'http://localhost/')
      const since = Number(parsed.searchParams.get('since') || 0)
      const items = tickets.filter((ticket) => Number(ticket.rev) > since)
      const rev = Math.max(1, ...tickets.map((ticket) => Number(ticket.rev) || 0))
      return jsonResponse({ ok: true, items, rev, counts: {} })
    }
    return jsonResponse({ ok: true })
  }
  const ReactStub = {
    useRef: (value) => ({ current: value }),
    useEffect: () => {},
    createElement: (type, props, ...children) => ({ type, props, children }),
  }
  const registrations = []
  const ctx = {
    ...services,
    slots: {
      inject(_name, callback) { callback(); return () => {} },
      register(meta, render) { registrations.push({ meta, render }); return () => {} },
    },
    layout: { selectPanel() {} },
  }
  window.__ModuleLoader__ = {
    load({ factory }) {
      plugin = factory((name) => {
        if (name === 'react') return ReactStub
        throw new Error(`unexpected require: ${name}`)
      })
    },
  }
  window.__FANG_TEST_HOOK__ = true
  let plugin = null
  window.eval(source)
  assert.ok(plugin, 'client plugin factory must be captured')
  const dispose = plugin.apply(ctx)
  return { dom, window, plugin, registrations, calls, dispose, ReactStub }
}

function mountInbox(harness) {
  const registration = harness.registrations.find((item) => item.meta?.name === 'sidebar.right.pane.tab' && item.meta?.key === 'fang-decision-inbox')
  assert.ok(registration, 'inbox tab slot must be registered')
  const element = typeof registration.render === 'function' ? registration.render({}) : registration.render
  const mount = element?.props?.mount
  assert.equal(typeof mount, 'function', 'tab slot must expose a DOM mount')
  const host = harness.window.document.createElement('div')
  harness.window.document.body.append(host)
  mount(host)
  return host
}

function mountSlot(harness, name, key = null) {
  const registration = harness.registrations.find((item) => item.meta?.name === name && (key === null || item.meta?.key === key))
  assert.ok(registration, `${name} slot must be registered`)
  const element = typeof registration.render === 'function' ? registration.render({}) : registration.render
  const mount = element?.props?.mount
  assert.equal(typeof mount, 'function', `${name} slot must expose a DOM mount`)
  const host = harness.window.document.createElement('div')
  harness.window.document.body.append(host)
  mount(host)
  return host
}

const baseTicket = {
  id: 'dec_a', rev: 1, level: 'yellow', status: 'pending',
  title: 'Alpha decision', context: 'ctx a',
  source: { sessionId: 's1', agentRole: 'worker' },
  options: [{ value: 'go', label: 'Go' }, { value: 'stop', label: 'Stop' }],
  createdAt: Date.now(), expiresAt: null, isBlocking: false,
}
const greenTicket = {
  id: 'dec_g', rev: 1, level: 'green', status: 'pending',
  title: 'Green FYI', context: 'ctx g',
  source: { sessionId: 's2', agentRole: 'worker' },
  options: [], createdAt: Date.now(), expiresAt: null, isBlocking: false,
}
const blueTicket = {
  id: 'dec_b', rev: 1, level: 'blue', status: 'pending',
  title: 'Blue optimize', context: 'ctx b',
  source: { sessionId: 's3', agentRole: 'pm' },
  options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
  createdAt: Date.now(), expiresAt: null, isBlocking: false,
}
const redTicket = {
  id: 'dec_r', rev: 1, level: 'red', status: 'pending',
  title: 'Red blocking', context: 'ctx r',
  source: { sessionId: 's4', agentRole: 'system' },
  options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }],
  createdAt: Date.now(), expiresAt: null, isBlocking: true,
  execution: { status: 'done', actionId: 'confirm_restart' },
}
const archivedTicket = {
  id: 'dec_arch', rev: 1, level: 'gray', status: 'resolved',
  title: 'Archived past', context: 'ctx old',
  source: { sessionId: 's5', agentRole: 'worker' },
  options: [], createdAt: Date.now() - 1000, resolvedAt: Date.now(), expiresAt: null, isBlocking: false,
}

test('client DOM: inbox groups, collapse, ACK, batch partial failure and SSE merge', async () => {
  const sseFrames = [
    'event: ticket\ndata: ' + JSON.stringify({ type: 'created', rev: 2, ids: ['dec_live'], ticket: { ...baseTicket, id: 'dec_live', rev: 2, title: 'Beta live', level: 'red' } }) + '\n\n',
  ]
  const harness = makeHarness({
    tickets: [baseTicket, greenTicket, blueTicket, redTicket, archivedTicket],
    sseFrames,
    onResolve: (body) => {
      if (Array.isArray(body.ids)) {
        return jsonResponse({ ok: false, results: body.ids.map((id) => ({ id, ok: false, reason: 'explicit-choice-required' })) })
      }
      return jsonResponse({ ok: true, ticket: { id: body.id, status: 'resolved' } })
    },
  })
  try {
    const host = mountInbox(harness)
    await waitFor(() => host.textContent.includes('Alpha decision'))
    // 五色分组都存在；绿/灰默认折叠。
    for (const level of ['red', 'yellow', 'blue', 'green', 'gray']) {
      assert.ok(host.querySelector(`.fang-inbox-group[data-level="${level}"] .fang-inbox-group-head`), `${level} group must exist`)
    }
    assert.equal(host.querySelector('.fang-inbox-group[data-level="green"] [data-inbox-id]'), null, 'green collapsed by default')
    assert.equal(host.querySelector('.fang-inbox-group[data-level="gray"] [data-inbox-id]'), null, 'gray collapsed by default')
    assert.match(host.textContent, /动作 confirm_restart：已执行/, 'action execution status must be visible')
    // 灰色分组展开后出现归档票。
    host.querySelector('.fang-inbox-group[data-level="gray"] .fang-inbox-group-head').click()
    await waitFor(() => host.textContent.includes('Archived past'))

    // 绿色分组默认折叠：先展开再验证 ACK 按钮。
    const greenGroup = host.querySelector('.fang-inbox-group[data-level="green"] .fang-inbox-group-head')
    assert.ok(greenGroup, 'green group head must exist')
    greenGroup.click()
    await waitFor(() => host.textContent.includes('Green FYI'))

    // 折叠：点黄色分组头后条目消失，再点恢复。
    const groupHead = host.querySelector('.fang-inbox-group[data-level="yellow"] .fang-inbox-group-head')
    assert.ok(groupHead, 'yellow group head must exist')
    groupHead.click()
    await waitFor(() => !host.textContent.includes('Alpha decision'))
    groupHead.click()
    await waitFor(() => host.textContent.includes('Alpha decision'))

    // ACK：绿色无选项 ticket 的「知道了」走 __ACK__。
    const ackButton = [...host.querySelectorAll('[data-inbox-id="dec_g"] button')].find((node) => node.textContent === '知道了')
    assert.ok(ackButton, 'green ACK button must exist')
    ackButton.click()
    await waitFor(() => harness.calls.some((call) => call.url.includes('/decisions/resolve') && JSON.parse(call.init.body).option === '__ACK__'))

    // 批量部分失败：勾选黄色项 → 处理选中 → 确认 → 失败逐条 UI。
    const checkbox = host.querySelector('[data-inbox-id="dec_a"] input[type="checkbox"]')
    assert.ok(checkbox, 'item checkbox must exist')
    checkbox.click()
    const batchButton = [...host.querySelectorAll('button')].find((node) => node.textContent === '处理选中')
    batchButton.click()
    const confirm = await waitFor(() => host.querySelector('.fang-inbox-confirm'))
    const confirmButton = [...confirm.querySelectorAll('button')].find((node) => node.textContent === '处理')
    confirmButton.click()
    await waitFor(() => host.querySelector('.fang-inbox-batch-fail'))
    assert.match(host.textContent, /批量操作有 1 项失败/)
    assert.match(host.textContent, /explicit-choice-required|红色|阻塞/)

    // SSE：实时合并新 ticket（红色强提醒也在 document.body 出现）。
    try {
      await waitFor(() => host.textContent.includes('Beta live'))
    } catch (error) {
      console.log('DEBUG DOM:', host.textContent)
      throw error
    }
    assert.ok(harness.window.document.querySelector('[data-fang-red-alerts]'), 'red alert stack must appear')
  } finally {
    try { harness.dispose?.() } catch { /* ignore */ }
    harness.dom.window.close()
  }
})

test('client source: full decision center is not rendered by the main panel', () => {
  assert.equal(source.includes('function renderDecisionCenter'), false, 'old main-panel renderer must stay removed')
  assert.ok(source.includes('sidebar.right.pane.tab'), 'inbox must have an independent sidebar tab')
  assert.ok(source.includes('__renderDecisionMini'), 'right-panel mini is a separate lightweight view')
})

test('client DOM: keyboard navigation selects, resolves, refreshes and clears', async () => {
  const harness = makeHarness({ tickets: [baseTicket, blueTicket] })
  try {
    const host = mountInbox(harness)
    await waitFor(() => host.textContent.includes('Alpha decision'))
    const root = host.querySelector('.fang-inbox[data-zone="decision-inbox"]')
    const key = (name, extra = {}) => root.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: name, bubbles: true, ...extra }))

    key('ArrowDown')
    key('x')
    await waitFor(() => host.querySelector('[data-inbox-id="dec_a"] input[type="checkbox"]')?.checked === true)
    assert.match(host.textContent, /已选 1/)

    key('Enter')
    await waitFor(() => harness.calls.some((call) => call.url.includes('/decisions/resolve') && JSON.parse(call.init.body).option === 'go'))

    const before = harness.calls.filter((call) => call.url.includes('/fang/api/decisions?')).length
    key('r')
    await waitFor(() => harness.calls.filter((call) => call.url.includes('/fang/api/decisions?')).length > before)

    key('Escape')
    await waitFor(() => /已选 0/.test(host.textContent))
  } finally {
    try { harness.dispose?.() } catch { /* ignore */ }
    harness.dom.window.close()
  }
})

test('client DOM: unread count is pending count and stays in sync in all three places', async () => {
  const harness = makeHarness({ tickets: [baseTicket, greenTicket, blueTicket, redTicket, archivedTicket] })
  try {
    const seat = mountSlot(harness, 'sidebar.footer.action')
    const title = mountSlot(harness, 'sidebar.right.pane.tab.title')
    const inbox = mountInbox(harness)
    const badge = await waitFor(() => seat.querySelector('.fang-inbox-badge'))
    await waitFor(() => badge.textContent === '4')
    assert.notEqual(badge.style.display, 'none')
    const tabCount = title.querySelector('.fang-inbox-unread')
    const inboxCount = inbox.querySelector('.fang-inbox-unread')
    assert.equal(tabCount?.textContent, '4')
    assert.equal(inboxCount?.textContent, '4')
    assert.match(inbox.textContent, /待处理 4/)
    // 打开收件箱会 markSeen；pending 口径不应因此变 0（三处仍同步）。
    inbox.click()
    await waitFor(() => inbox.textContent.includes('已选 0'))
    assert.equal(seat.querySelector('.fang-inbox-badge').textContent, '4')
    assert.equal(title.querySelector('.fang-inbox-unread')?.textContent, '4')
    assert.equal(inbox.querySelector('.fang-inbox-unread')?.textContent, '4')
    assert.match(inbox.textContent, /待处理 4/)
  } finally {
    try { harness.dispose?.() } catch { /* ignore */ }
    harness.dom.window.close()
  }
})

test('client DOM: footer seat opens fallback drawer, Esc closes', async () => {
  const harness = makeHarness({ tickets: [baseTicket] })
  try {
    const seat = mountSlot(harness, 'sidebar.footer.action')
    const button = await waitFor(() => seat.querySelector('[data-fang-entry="decision-inbox"]'))
    assert.match(String(button.title || button.getAttribute('aria-label') || ''), /收件箱/)
    button.click()
    const drawer = await waitFor(() => harness.window.document.querySelector('[data-fang-inbox-drawer]'))
    assert.ok(harness.window.document.querySelector('[data-fang-inbox-backdrop]'), 'fallback drawer must have a backdrop')
    await waitFor(() => drawer.textContent.includes('Alpha decision'))
    harness.window.document.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await waitFor(() => !harness.window.document.querySelector('[data-fang-inbox-drawer]'))
    assert.equal(harness.window.document.querySelector('[data-fang-inbox-backdrop]'), null)
  } finally {
    try { harness.dispose?.() } catch { /* ignore */ }
    harness.dom.window.close()
  }
})

test('client DOM: footer seat prefers host right-pane openTab over local drawer', async () => {
  const opened = []
  const sidebarRight = { openTab(kind, options) { opened.push({ kind, options }) } }
  const harness = makeHarness({ tickets: [baseTicket], services: { sidebarRight } })
  try {
    const seat = mountSlot(harness, 'sidebar.footer.action')
    const button = await waitFor(() => seat.querySelector('[data-fang-entry="decision-inbox"]'))
    button.click()
    await waitFor(() => opened.length === 1)
    assert.equal(opened[0].kind, 'fangDecisionInbox')
    assert.equal(harness.window.document.querySelector('[data-fang-inbox-drawer]'), null, 'no local drawer when host right pane exists')
  } finally {
    try { harness.dispose?.() } catch { /* ignore */ }
    harness.dom.window.close()
  }
})

test('client DOM: group header checkbox is tri-state select-all', async () => {
  const redTwo = { ...redTicket, id: 'dec_r2', rev: 2, title: 'Red second', isBlocking: true }
  const harness = makeHarness({ tickets: [redTicket, redTwo, baseTicket] })
  try {
    const host = mountInbox(harness)
    await waitFor(() => host.textContent.includes('Red blocking'))
    const redCheck = () => host.querySelector('.fang-inbox-group[data-level="red"] [data-group-select="red"]')
    let check = redCheck()
    assert.ok(check, 'red group must have a select-all checkbox')
    assert.equal(check.checked, false)
    assert.equal(check.indeterminate, false)

    // 选一条 → 分组头变 indeterminate（三态中间态）
    host.querySelector('[data-inbox-id="dec_r"] input[type="checkbox"]').click()
    await waitFor(() => redCheck().indeterminate === true)
    check = redCheck()
    assert.equal(check.checked, false)
    assert.equal(check.indeterminate, true)

    // 点分组头 → 全选本组（checked，indeterminate 清除）
    check.click()
    await waitFor(() => redCheck().checked === true && redCheck().indeterminate === false)
    assert.equal(host.querySelector('[data-inbox-id="dec_r"] input[type="checkbox"]').checked, true)
    assert.equal(host.querySelector('[data-inbox-id="dec_r2"] input[type="checkbox"]').checked, true)

    // 再点 → 清空本组
    redCheck().click()
    await waitFor(() => redCheck().checked === false && redCheck().indeterminate === false)
    assert.equal(host.querySelector('[data-inbox-id="dec_r"] input[type="checkbox"]').checked, false)

    // 分组头仍可折叠（checkbox 不触发折叠）
    host.querySelector('.fang-inbox-group[data-level="red"] .fang-inbox-group-head').click()
    await waitFor(() => !host.textContent.includes('Red blocking'))

    // 一键展开/收起全部（红/黄/蓝/绿/灰都受影响；绿/灰默认折叠）
    const expandAll = [...host.querySelectorAll('button')].find((node) => node.textContent === '展开全部')
    assert.ok(expandAll, 'expand-all button must exist after collapsing red')
    expandAll.click()
    await waitFor(() => host.textContent.includes('Red second') && host.textContent.includes('Alpha decision'))
    const collapseAll = [...host.querySelectorAll('button')].find((node) => node.textContent === '收起全部')
    assert.ok(collapseAll, 'collapse-all button must exist after expand-all')
    collapseAll.click()
    await waitFor(() => !host.textContent.includes('Red second') && !host.textContent.includes('Alpha decision'))
  } finally {
    try { harness.dispose?.() } catch { /* ignore */ }
    harness.dom.window.close()
  }
})

test('client DOM: rev/since incremental refresh merges only deltas', async () => {
  const tickets = [{ ...baseTicket }]
  const harness = makeHarness({ tickets })
  try {
    const host = mountInbox(harness)
    await waitFor(() => host.textContent.includes('Alpha decision'))
    tickets.push({ ...baseTicket, id: 'dec_delta', rev: 2, title: 'Delta two', level: 'blue' })
    const refresh = [...host.querySelectorAll('button')].find((node) => node.textContent === '刷新')
    assert.ok(refresh, 'refresh button must exist')
    refresh.click()
    await waitFor(() => host.textContent.includes('Delta two'))
    const listCalls = harness.calls.filter((call) => call.url.includes('includeArchived=1'))
    assert.ok(listCalls.length >= 2, 'refresh must issue a delta request')
    assert.match(listCalls[listCalls.length - 1].url, /since=1/)
  } finally {
    try { harness.dispose?.() } catch { /* ignore */ }
    harness.dom.window.close()
  }
})

test('client DOM: blue/green batch resolve sends selected ids', async () => {
  const harness = makeHarness({
    tickets: [blueTicket, greenTicket],
    onResolve: (body) => jsonResponse({ ok: true, results: body.ids.map((id) => ({ id, ok: true })) }),
  })
  try {
    const host = mountInbox(harness)
    await waitFor(() => host.textContent.includes('Blue optimize'))
    host.querySelector('.fang-inbox-group[data-level="green"] .fang-inbox-group-head').click()
    await waitFor(() => host.textContent.includes('Green FYI'))
    for (const id of ['dec_b', 'dec_g']) {
      const checkbox = host.querySelector(`[data-inbox-id="${id}"] input[type="checkbox"]`)
      assert.ok(checkbox, `${id} checkbox must exist`)
      checkbox.click()
    }
    const batchButton = [...host.querySelectorAll('button')].find((node) => node.textContent === '处理选中')
    batchButton.click()
    const confirm = await waitFor(() => host.querySelector('.fang-inbox-confirm'))
    const confirmButton = [...confirm.querySelectorAll('button')].find((node) => node.textContent === '处理')
    confirmButton.click()
    await waitFor(() => harness.calls.some((call) => call.url.includes('/decisions/resolve') && Array.isArray(JSON.parse(call.init.body).ids)))
    const post = harness.calls.find((call) => call.url.includes('/decisions/resolve') && Array.isArray(JSON.parse(call.init.body).ids))
    assert.deepEqual(JSON.parse(post.init.body).ids.sort(), ['dec_b', 'dec_g'])
  } finally {
    try { harness.dispose?.() } catch { /* ignore */ }
    harness.dom.window.close()
  }
})

test('client DOM: mixed batch success + failure keeps the failed item and shows one failure', async () => {
  const harness = makeHarness({
    tickets: [baseTicket, redTicket],
    onResolve: (body) => jsonResponse({
      ok: false,
      results: body.ids.map((id) => id === 'dec_r'
        ? { id, ok: false, reason: 'explicit-choice-required' }
        : { id, ok: true }),
    }),
  })
  try {
    const host = mountInbox(harness)
    await waitFor(() => host.textContent.includes('Alpha decision'))
    for (const id of ['dec_a', 'dec_r']) {
      const checkbox = host.querySelector(`[data-inbox-id="${id}"] input[type="checkbox"]`)
      assert.ok(checkbox, `${id} checkbox must exist`)
      checkbox.click()
    }
    ;[...host.querySelectorAll('button')].find((node) => node.textContent === '处理选中').click()
    const confirm = await waitFor(() => host.querySelector('.fang-inbox-confirm'))
    ;[...confirm.querySelectorAll('button')].find((node) => node.textContent === '处理').click()
    await waitFor(() => host.querySelector('.fang-inbox-batch-fail'))
    assert.match(host.textContent, /批量操作有 1 项失败/)
    assert.match(host.textContent, /红色\/阻塞票需要逐条显式处理/)
    const post = harness.calls.find((call) => call.url.includes('/decisions/resolve') && Array.isArray(JSON.parse(call.init.body).ids))
    assert.deepEqual(JSON.parse(post.init.body).ids.sort(), ['dec_a', 'dec_r'])
  } finally {
    try { harness.dispose?.() } catch { /* ignore */ }
    harness.dom.window.close()
  }
})

test('client DOM: batch archive sends selected ids and confirms once', async () => {
  const harness = makeHarness({ tickets: [baseTicket, blueTicket] })
  try {
    const host = mountInbox(harness)
    await waitFor(() => host.textContent.includes('Alpha decision'))
    for (const id of ['dec_a', 'dec_b']) {
      host.querySelector(`[data-inbox-id="${id}"] input[type="checkbox"]`).click()
    }
    ;[...host.querySelectorAll('button')].find((node) => node.textContent === '归档选中').click()
    const confirm = await waitFor(() => host.querySelector('.fang-inbox-confirm'))
    ;[...confirm.querySelectorAll('button')].find((node) => node.textContent === '归档').click()
    await waitFor(() => harness.calls.some((call) => call.url.includes('/decisions/abandon') && Array.isArray(JSON.parse(call.init.body).ids)))
    const post = harness.calls.find((call) => call.url.includes('/decisions/abandon') && Array.isArray(JSON.parse(call.init.body).ids))
    assert.deepEqual(JSON.parse(post.init.body).ids.sort(), ['dec_a', 'dec_b'])
  } finally {
    try { harness.dispose?.() } catch { /* ignore */ }
    harness.dom.window.close()
  }
})

test('client DOM: right-panel decision mini groups red first, folds green/gray, refetches after 409', async () => {
  const harness = makeHarness({
    tickets: [redTicket, baseTicket, blueTicket, greenTicket, archivedTicket],
    onResolve: () => jsonResponse({ ok: false, error: 'not-pending' }, 409),
  })
  try {
    const section = harness.plugin.__renderDecisionMini()
    const host = harness.window.document.createElement('div')
    host.append(section)
    harness.window.document.body.append(host)
    await waitFor(() => section.textContent.includes('Red blocking'))
    const levels = [...section.querySelectorAll('.fang-decision-mini-group')].map((node) => node.dataset.level)
    assert.equal(levels[0], 'red', 'red group must be first')
    for (const level of ['red', 'yellow', 'blue', 'green', 'gray']) {
      assert.ok(section.querySelector(`.fang-decision-mini-group[data-level="${level}"]`), `${level} group missing`)
    }
    assert.equal(section.querySelector('.fang-decision-mini-group[data-level="green"] .fang-decision-mini-item'), null, 'green collapsed by default')
    assert.equal(section.querySelector('.fang-decision-mini-group[data-level="gray"] .fang-decision-mini-item'), null, 'gray collapsed by default')
    assert.match(section.textContent, /无期限|剩余/)
    assert.match(section.textContent, /worker|system|pm/)

    const optionButton = [...section.querySelectorAll('[data-inbox-id="dec_a"] button')].find((node) => node.textContent === 'Go')
    assert.ok(optionButton, 'option button must render')
    optionButton.click()
    await waitFor(() => /已被处理/.test(section.textContent))
    assert.ok(harness.calls.filter((call) => call.url.includes('includeArchived=1')).length >= 2, 'must refetch after action')
    assert.ok(section.querySelector('[data-inbox-id="dec_a"]'), 'no optimistic delete')
  } finally {
    try { harness.dispose?.() } catch { /* ignore */ }
    harness.dom.window.close()
  }
})

test('client DOM: HTTP 409 shows error and does not fake success', async () => {
  const harness = makeHarness({
    tickets: [baseTicket],
    onResolve: () => jsonResponse({ ok: false, error: 'not-pending' }, 409),
  })
  try {
    const host = mountInbox(harness)
    await waitFor(() => host.textContent.includes('Alpha decision'))
    const go = [...host.querySelectorAll('button')].find((node) => node.textContent === 'Go')
    go.click()
    await waitFor(() => harness.calls.some((call) => call.url.includes('/decisions/resolve')))
    await waitFor(() => /已被处理|not-pending|409/.test(host.textContent))
  } finally {
    try { harness.dispose?.() } catch { /* ignore */ }
    harness.dom.window.close()
  }
})

test('client DOM: essence cards use independent two-row boxes with YaHei 16px name and sync time', () => {
  // 元宝卡片：grid 独立方框；第一行名称；第二行生成/同步时间；操作为图标。
  assert.match(source, /\.essence-list\{display:grid;grid-template-columns:repeat\(auto-fill,minmax\(320px,1fr\)\)/)
  assert.match(source, /\.essence-card\{[^}]*border:1px solid var\(--f-border\)/)
  assert.match(source, /\.essence-card-name\{font-family:"Microsoft YaHei","微软雅黑",sans-serif;font-size:16px/)
  assert.match(source, /function renderEssenceCard/)
  assert.match(source, /essence-card-times/)
  assert.match(source, /生成 \$\{created\}/)
  assert.match(source, /同步 \$\{synced\}/)
  assert.match(source, /essence-card-actions/)
})



} // end jsdom-available block
