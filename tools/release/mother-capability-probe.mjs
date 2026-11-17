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
  },
  evidence: {
    sessionsStatus: sessions.status,
    sessionsSample: sessionItems.slice(0, 3).map((s) => ({ sessionId: s.sessionId, title: s.title ?? null, updatedAt: s.updatedAt ?? null })),
    statusError: status.ok ? null : status.error ?? status.sample ?? null,
  },
}

console.log(hasFlag('json') ? JSON.stringify(report, null, 2) : [
  `mother ${base} role=${report.mother.role} version=${report.mother.version} status=${report.mother.status} auth=${report.authenticated}`,
  `contract version=${report.contract.version ?? 'n/a'} methods=${contractMethods.length} delegation=${report.contract.hasDelegation}`,
  `readiness: ${Object.entries(report.readiness).map(([k, v]) => `${k}=${v ? 'READY' : 'MISSING'}`).join(' | ')}`,
  `evidence: /fang/api/sessions -> ${sessions.status} (${sessionItems.length} item(s))`,
].join('\n'))

process.exit(sessionCatalogReady ? 0 : 1)
