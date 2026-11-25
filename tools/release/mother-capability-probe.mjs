#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// Mother-side capability probe for B contract delegation readiness.
// Read-only. Answers: does the running mother actually provide the services a
// delegated capability depends on (e.g. fang.session.list -> sessionCatalog)?
//
// Usage:
//   node tools/release/mother-capability-probe.mjs --base http://127.0.0.1:50895 \
//     [--token-file <dataDir>/fang-auth.json] [--token <token>] [--json]
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
const headers = token ? { 'x-fang-auth': String(token) } : {}

async function probe(pathname) {
  try {
    const response = await fetch(`${base}${pathname}`, { headers, signal: AbortSignal.timeout(15000) })
    const text = await response.text()
    let body = null
    try { body = JSON.parse(text) } catch { body = null }
    return { path: pathname, status: response.status, ok: response.ok, body, sample: text.slice(0, 600) }
  } catch (error) {
    return { path: pathname, status: 0, ok: false, error: String(error?.message ?? error) }
  }
}

const status = await probe('/fang/api/status')
const sessions = await probe('/fang/api/sessions?limit=5')
const contractHealth = await probe('/fang/api/contract/health')

const services = status.body?.services ?? {}
const sessionItems = Array.isArray(sessions.body?.sessions) ? sessions.body.sessions : []
const sessionCatalogReady = services.sessionCatalog === true || (sessions.ok === true && Array.isArray(sessions.body?.sessions))
const contractMethods = Array.isArray(contractHealth.body?.methods) ? contractHealth.body.methods : []

// B-6 LSP probe (delegation): capability.list lspProvider + optional real definition/hover.
let lsp = null
if (token && contractMethods.includes('fang.capability.list')) {
  let sequence = 0
  const invoke = async (method, params = null) => {
    const envelope = {
      protocol: 'fang-master', protocolVersion: 1,
      id: `probe-${Date.now().toString(36)}-${++sequence}`,
      method, params,
      meta: { at: Date.now(), delegate: true, source: 'mother-capability-probe' },
    }
    try {
      const response = await fetch(`${base}/fang/api/contract/invoke`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', authorization: '' },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(30000),
      })
      const body = await response.json().catch(() => null)
      return { status: response.status, body }
    } catch (error) {
      return { status: 0, body: null, error: String(error?.message ?? error) }
    }
  }
  const caps = await invoke('fang.capability.list')
  const provider = caps.body?.result?.lspProvider ?? null
  lsp = { provider }
  const workspaceRoot = arg('workspace-root', '')
  const definitionFile = arg('definition-file', arg('file', ''))
  if (provider?.available === true && workspaceRoot && definitionFile) {
    const line = Number.parseInt(arg('line', '0'), 10) || 0
    const character = Number.parseInt(arg('character', '0'), 10) || 0
    const params = { tool: 'lsp', action: 'definition', file: definitionFile, line, character, workspaceRoot }
    const definition = await invoke('fang.tool.invoke', params)
    const hover = await invoke('fang.tool.invoke', { ...params, action: 'hover' })
    lsp.definition = { ok: definition.body?.ok === true, body: definition.body, status: definition.status }
    lsp.hover = { ok: hover.body?.ok === true, body: hover.body, status: hover.status }
  }
}


const report = {
  generatedAt: new Date().toISOString(),
  base,
  authenticated: Boolean(token),
  mother: { role: status.body?.role ?? null, version: status.body?.version ?? null, status: status.status },
  services,
  contract: {
    version: contractHealth.body?.contractVersion ?? null,
    methods: contractMethods,
    hasDelegation: contractMethods.some((m) => m === 'fang.capability.list'),
  },
  readiness: {
    'fang.orchestrator.status': status.ok === true,
    'fang.session.list': sessionCatalogReady === true,
    'fang.capability.list': contractMethods.some((m) => m === 'fang.capability.list'),
    ...(lsp ? { 'fang.tool.invoke:lsp': lsp.provider?.available === true } : {}),
  },
  lsp,
  evidence: {
    sessionsStatus: sessions.status,
    sessionsSample: sessionItems.slice(0, 3).map((s) => ({ sessionId: s.sessionId, title: s.title ?? null, updatedAt: s.updatedAt ?? null })),
    statusError: status.ok ? null : status.error ?? status.sample ?? null,
  },
}

const lspLines = lsp ? [
  `lsp: provider.available=${lsp.provider?.available === true} default=${lsp.provider?.default ?? 'n/a'} actions=${(lsp.provider?.actions ?? []).join(',') || '(none)'} providers=${Object.keys(lsp.provider?.providers ?? {}).join(',') || '(none)'}`,
  ...(lsp.definition ? [`lsp.definition: ${lsp.definition.ok ? 'PASS' : 'FAIL'} ${JSON.stringify(lsp.definition.body?.result ?? lsp.definition.body?.error ?? { status: lsp.definition.status }).slice(0, 300)}`] : []),
  ...(lsp.hover ? [`lsp.hover: ${lsp.hover.ok ? 'PASS' : 'FAIL'} ${JSON.stringify(lsp.hover.body?.result ?? lsp.hover.body?.error ?? { status: lsp.hover.status }).slice(0, 300)}`] : []),
] : ['lsp: SKIP (no token or delegation methods absent)']

console.log(hasFlag('json') ? JSON.stringify(report, null, 2) : [
  `mother ${base} role=${report.mother.role} version=${report.mother.version} status=${report.mother.status} auth=${report.authenticated}`,
  `contract version=${report.contract.version ?? 'n/a'} methods=${contractMethods.length} delegation=${report.contract.hasDelegation}`,
  `readiness: ${Object.entries(report.readiness).map(([k, v]) => `${k}=${v ? 'READY' : 'MISSING'}`).join(' | ')}`,
  ...lspLines,
  `evidence: /fang/api/sessions -> ${sessions.status} (${sessionItems.length} item(s))`,
].join('\n'))

const requireLsp = hasFlag('require-lsp')
const lspReady = lsp?.provider?.available === true
process.exit(sessionCatalogReady && (!requireLsp || lspReady) ? 0 : 1)
