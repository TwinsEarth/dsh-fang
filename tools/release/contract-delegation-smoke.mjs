#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// B 契约委托冒烟（只读探测 + 委托调用；对运行中的母体执行，不启动/重启任何进程）。
// 覆盖：capability.list / session.list / session.events / tool.invoke(lsp 读+写) /
//       chat.import(dryRun 两次一致性 + 真实导入审批拒绝)。
//
// 用法：
//   node tools/release/contract-delegation-smoke.mjs --base http://127.0.0.1:50895 \
//     --token-file <dataDir>/fang-auth.json [--json]
//
// 退出码：0 全绿（含允许的 SKIP）；1 有 FAIL；2 环境不具备（未配 token / 母体无委托方法）。
import fs from 'node:fs'

const argv = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? String(argv[index + 1] ?? '') : fallback
}
const hasFlag = (name) => argv.includes(`--${name}`)

const base = arg('base', 'http://127.0.0.1:50895').replace(/\/+$/, '')
const tokenFile = arg('token-file', '')
let token = arg('token', '')
if (!token && tokenFile) {
  try { token = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token ?? '' } catch { token = '' }
}
if (!token) {
  console.error('SKIP contract delegation smoke: no token (--token/--token-file)')
  process.exit(2)
}
const headers = { 'x-fang-auth': token, authorization: '', 'content-type': 'application/json' }

const results = []
const record = (id, ok, detail, skipped = false) => {
  results.push({ id, ok, skipped, detail })
  const tag = skipped ? 'SKIP' : ok ? 'PASS' : 'FAIL'
  console.log(`${tag}  ${id}  ${detail}`)
}

async function http(pathname, options = {}) {
  try {
    const response = await fetch(`${base}${pathname}`, { ...options, signal: AbortSignal.timeout(20000) })
    const text = await response.text()
    let body = null
    try { body = JSON.parse(text) } catch { body = null }
    return { status: response.status, ok: response.ok, body, raw: text.slice(0, 400) }
  } catch (error) {
    return { status: 0, ok: false, body: null, error: String(error?.message ?? error) }
  }
}

const health = await http('/fang/api/contract/health', { headers: { 'x-fang-auth': token } })
const methods = Array.isArray(health.body?.methods) ? health.body.methods : []
record('contract health reachable', health.status === 200 && health.body?.ok === true,
  `status=${health.status} version=${health.body?.contractVersion ?? 'n/a'} methods=${methods.length}`)
if (!methods.includes('fang.capability.list')) {
  record('delegation methods present', false, `mother ${health.body?.version ?? ''} has no fang.capability.list (older build; restart 3.5.0)`, true)
  console.log(results.some((r) => r.skipped) ? 'SKIP contract delegation smoke: mother lacks delegation methods' : '')
  process.exit(2)
}

let sequence = 0
const invoke = async (method, params = null) => {
  const envelope = {
    protocol: 'fang-master',
    protocolVersion: 1,
    id: `smoke-${inlineId()}-${++sequence}`,
    method,
    params,
    meta: { at: Date.now(), delegate: true, source: 'contract-smoke' },
  }
  const response = await http('/fang/api/contract/invoke', {
    method: 'POST',
    headers: { 'x-fang-auth': token, 'content-type': 'application/json', authorization: '' },
    body: JSON.stringify(envelope),
  })
  return { status: response.status, ok: response.body?.ok === true, body: response.body, raw: response.raw }
}
function inlineId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

// 1) capability list
const capList = await invoke('fang.capability.list')
const caps = Array.isArray(capList.body?.result?.capabilities) ? capList.body.result.capabilities : []
record('capability.list', capList.status === 200 && capList.ok && caps.length > 0, `caps=${caps.map((c) => c.method).join(',')}`.slice(0, 220))

// 2) session.list（服务缺失允许 contract-unavailable）
const sessionList = await invoke('fang.session.list', { limit: 3 })
const sessionCode = sessionList.body?.error?.code ?? null
record('session.list', sessionList.status === 200 && (sessionList.ok || sessionCode === 'contract-unavailable'), `ok=${sessionList.ok} code=${sessionCode ?? ''}`)

// 3) session.events（有界读；无会话 id 时允许 contract-unavailable）
const firstSession = Array.isArray(sessionList.body?.result?.sessions) ? sessionList.body.result.sessions[0] : null
const events = await invoke('fang.session.events', { sessionId: firstSession?.sessionId ?? 'session-smoke-probe', limit: 3 })
const eventsCode = events.body?.error?.code ?? null
record('session.events', events.status === 200 && (events.ok || eventsCode === 'contract-unavailable'), `ok=${events.ok} code=${eventsCode ?? ''}`)

// 4) tool.invoke：读子命令成功或未放行 SKIP；写子命令必须 approval-required 或未放行 SKIP
const lspRead = await invoke('fang.tool.invoke', { tool: 'lsp', action: 'diagnostics', file: 'smoke.mjs' })
if (lspRead.body?.error?.code === 'contract-unsupported') record('tool.invoke lsp diagnostics', true, 'capability not whitelisted on this mother', true)
else record('tool.invoke lsp diagnostics', lspRead.status === 200 && lspRead.ok && lspRead.body?.result?.ok === true, `ok=${lspRead.ok} code=${lspRead.body?.error?.code ?? ''} provider=${lspRead.body?.result?.provider ?? ''}`)

const lspWrite = await invoke('fang.tool.invoke', { tool: 'lsp', action: 'format', file: 'smoke.mjs' })
if (lspWrite.body?.error?.code === 'contract-unsupported') record('tool.invoke lsp format needs approval', true, 'capability not whitelisted on this mother', true)
else record('tool.invoke lsp format needs approval', lspWrite.status === 200 && lspWrite.body?.error?.code === 'contract-approval-required', `status=${lspWrite.status} code=${lspWrite.body?.error?.code ?? ''}`)

// 5) chat.import：dryRun 两次一致；真实导入 approval-required（或未放行 SKIP）
const dryParams = { source: 'deepseek', sessionId: firstSession?.sessionId ?? 'session-smoke-probe', dryRun: true }
const dry1 = await invoke('fang.chat.import', dryParams)
const dry2 = await invoke('fang.chat.import', dryParams)
if (dry1.body?.error?.code === 'contract-unsupported') record('chat.import dryRun deterministic', true, 'capability not whitelisted on this mother', true)
else record('chat.import dryRun deterministic', dry1.ok && dry2.ok && JSON.stringify(dry1.body?.result) === JSON.stringify(dry2.body?.result), `digest=${dry1.body?.result?.digest ?? ''} found=${dry1.body?.result?.found ?? ''}`)

const realImport = await invoke('fang.chat.import', { ...dryParams, dryRun: false })
if (realImport.body?.error?.code === 'contract-unsupported') record('chat.import real needs approval', true, 'capability not whitelisted on this mother', true)
else record('chat.import real needs approval', realImport.status === 200 && realImport.body?.error?.code === 'contract-approval-required', `status=${realImport.status} code=${realImport.body?.error?.code ?? ''}`)

const failed = results.filter((r) => !r.ok && !r.skipped)
if (hasFlag('json')) console.log(JSON.stringify({ base, results }, null, 2))
console.log(`${failed.length ? 'RED' : 'GREEN'}  contract delegation smoke ${results.length - failed.length}/${results.length}`)
process.exit(failed.length ? 1 : 0)
