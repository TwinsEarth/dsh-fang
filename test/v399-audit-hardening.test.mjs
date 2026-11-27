// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.9.9 audit hardening guards: each assertion covers a real defect found in the
// 2026-11-27 full-file review, not a style preference.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { closeManagedBrowser } from '../src/lib/browser-guard.mjs'

const REPO = path.resolve(import.meta.dirname, '..')
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8')

test('memory watchdog checks PID identity before it can taskkill a fork', () => {
  const src = read('src/plugins/orchestrator.mjs')
  const block = src.slice(src.indexOf('if (overKill && overGrowth)'), src.indexOf('return { ...tree, killed: true }'))
  assert.match(block, /readProcessIdentity\(rootPid\)/)
  assert.match(block, /matchesProcessIdentity\(beforeKill\.row, identity\)/)
  assert.match(block, /fork-memory-kill-skipped/)
  assert.ok(block.indexOf('matchedBeforeKill.ok !== true') < block.indexOf('killProcessTree(rootPid)'), 'reuse check must precede the direct kill')
  assert.match(block, /afterStop\.ok === true && matchesProcessIdentity\(afterStop\.row, identity\)\.ok === true/, 're-check after forker.stop before the fallback taskkill')
})

test('forker stale registry rows are PID-fingerprinted before taskkill', () => {
  const src = read('src/plugins/forker.mjs')
  assert.match(src, /const stalePidMatchesRecord = \(rec\)/)
  assert.match(src, /if \(!rec\?\.child && !identityVerified && !stalePidMatchesRecord\(rec\)\) return false/)
  assert.match(src, /const staleAlive = !rec\.child && rec\.pid \? stalePidMatchesRecord\(rec\) : false/)
  assert.match(src, /killed: wasRunning \|\| staleAlive/)
})

test('removeTree returns false when a locked child survives, and reap retries', () => {
  const fsx = read('src/kernel/fsx.mjs')
  assert.match(fsx, /return allChildrenRemoved && !exists\(target\)/)
  const forker = read('src/plugins/forker.mjs')
  assert.match(forker, /const removeHomeTree = \(homeDir, \{ attempts = 20, delayMs = 100 \}/)
  assert.match(forker, /const removed = hadHome \? removeHomeTree\(homeDir\) : false/)
  assert.match(forker, /if \(rec\.pid && stalePidMatchesRecord\(rec\)\) \{/)
  assert.match(forker, /error: 'stop-failed'/)
})

test('adapter public identity/client-report keep Host/Origin/Sec-Fetch-Site checks', () => {
  const src = read('src/plugins/adapter.mjs')
  const identity = src.slice(src.indexOf('path: `${prefix}${ADAPTER_ROUTE.IDENTITY}`'), src.indexOf('path: `${prefix}${ADAPTER_ROUTE.CLIENT_REPORT}`'))
  const report = src.slice(src.indexOf('path: `${prefix}${ADAPTER_ROUTE.CLIENT_REPORT}`'), src.indexOf('routePath(ADAPTER_ROUTE.HELLO)'))
  assert.match(identity, /checkRequestAuth\(req, \{ token: adapterToken, publicRoute: true \}\)/)
  assert.match(report, /checkRequestAuth\(req, \{ token: adapterToken, publicRoute: true \}\)/)
  assert.match(report, /content-type-required/)
})

test('fallback compose validates each child Config instead of accepting z.object({})', () => {
  const src = read('src/compose.mjs').replace(/\/\/.*$/gm, '')
  assert.equal(/z\.object\(\{\}\)/.test(src), false, 'no unvalidated child configs')
  for (const key of ['auditor', 'forker', 'bufferKeeper', 'scorer', 'umbrella', 'healer', 'router', 'approver', 'hotReloader', 'restartGuard', 'adapter', 'orchestrator', 'sessionBridge', 'sessionSync', 'sessionRouter', 'sessionCatalog', 'decisionCenter']) {
    assert.match(src, new RegExp(`${key}: ${key}\\.Config`), `compose must reuse ${key}.Config`)
  }
})

test('http-auth only accepts the DSH shell host app, not any dsh-app prefix', () => {
  const src = read('src/lib/http-auth.mjs')
  assert.ok(src.includes("^dsh-app:\\/\\/app"), 'origin regex must pin host app')
  assert.equal(/raw\.startsWith\('dsh-app:\/\/'\)/.test(src), false)
})

test('invalid configured port pools fail closed instead of silently reverting', () => {
  const src = read('src/plugins/forker.mjs')
  assert.match(src, /if \(!portPool\) throw new Error\('invalid portPool: start\/end must be integers within 1\.\.65535 and start <= end'\)/)
})

test('memory watchdog identity mismatch leaves a durable orphan with a panel reclaim path', () => {
  const src = read('src/plugins/orchestrator.mjs')
  assert.match(src, /task\.orphan = \{[\s\S]*?status: 'unresolved'/)
  assert.match(src, /memoryKill: f\.memoryKill \?\? null,[\s\S]*?orphan: f\.orphan \?\? null/)
  assert.match(src, /const reclaimOrphan = async \(task, \{ source = 'manual' \} = \{\}\)/)
  assert.match(src, /async reprobeTaskOrphan\(taskId\)/)
  assert.match(src, /route\('POST', `\$\{prefix\}\/api\/tasks\/reprobe`/)
  assert.match(src, /canReprobeOrphan: t\.orphan\?\.status === 'unresolved'/)
  assert.match(src, /data-act="reprobe"/)
  assert.match(src, /fork-orphan-reclaimed/)
  assert.match(read('src/lib/permissions.mjs'), /'\/api\/tasks\/reprobe': 'task-enqueue'/)
})

test('managed browser close checks the capture-time PID identity before taskkill', () => {
  const src = read('src/lib/browser-guard.mjs')
  assert.match(src, /identity = null \}\)/)
  assert.match(src, /skipped: 'identity-required'/)
  assert.match(src, /identity\.tokens/)
  assert.match(src, /skipped: 'pid-identity-mismatch'/)
  const orch = read('src/plugins/orchestrator.mjs')
  assert.match(orch, /closeManagedBrowser\(\{ pid: browser\.pid, port: browser\.port, graceMs: cfg\.gracefulBrowserCloseMs, identity: browserCloseIdentity\(browser\) \}\)/)
  assert.match(orch, /closeManagedBrowser\(\{ pid: task\.browser\.pid, port: task\.browser\.port, graceMs: cfg\.gracefulBrowserCloseMs, identity: browserCloseIdentity\(task\.browser\) \}\)/)
  assert.match(orch, /pidIdentity: \{[\s\S]*source: 'spawn-provisional'/)
})

test('managed browser close refuses a bare PID without any capture-time fingerprint', async () => {
  const out = await closeManagedBrowser({ pid: 424242, port: 1 })
  assert.equal(out.ok, false)
  assert.equal(out.skipped, 'identity-required')
  assert.equal(out.error, 'identity-required')
})

test('permissions second gate is wired into orchestrator and adapter, auto keeps mother/fork behavior', () => {
  const orch = read('src/plugins/orchestrator.mjs')
  assert.match(orch, /from '\.\.\/lib\/permissions\.mjs'/)
  assert.match(orch, /permissionEnv: z\.union\(/)
  assert.match(orch, /const permissionEnv = resolvePermissionEnv\(\{ envType: cfg\.permissionEnv, role \}\)/)
  assert.match(orch, /const enforcePermission = \(req, pathname, res\)/)
  assert.ok(orch.indexOf('if (enforcePermission(req, pathname, res)) return') < orch.indexOf('return await handler(req, res)'), 'permission gate must run before the route handler')
  const adapter = read('src/plugins/adapter.mjs')
  assert.match(adapter, /from '\.\.\/lib\/permissions\.mjs'/)
  assert.match(adapter, /const permissionAction = permissionActionForAdapterOp\(op\)/)
  assert.match(adapter, /code: PERMISSION_DENIED/)
})

test('publish-npm treats HTTP 202 as accepted and only prints PUBLISHED after registry confirmation', () => {
  const src = read('tools/release/publish-npm.mjs')
  assert.match(src, /retryHttpJson/)
  assert.match(src, /SUBMITTED .*HTTP \$\{res\.status\}/)
  assert.match(src, /UNCONFIRMED/)
  assert.match(src, /predicate: \(r\) => r\.status === 200 && String\(r\.data\?\.version \?\? ''\) === pkg\.version/)
  assert.equal(/if \(res\.status === 200 \|\| res\.status === 201 \|\| res\.status === 202\) \{\s*console\.log\(`\\nPUBLISHED/.test(src), false, '202 must never be printed as PUBLISHED directly')
})

test('verify-release --at-head pins tag^{commit} to HEAD and checks docs are inside the tag', () => {
  const src = read('tools/git/verify-release.mjs')
  assert.match(src, /const atHead = flag\('--at-head'\)/)
  assert.match(src, /tag: tag\^\{commit\} == HEAD/)
  assert.match(src, /docs: tag 内文档与 HEAD 一致/)
  assert.match(src, /docs\/AUDIT-v\$\{version\}\.md/)
})

test('release-order refuses a tag that predates the final docs commit', () => {
  const src = read('tools/release/release-order.mjs').replace(/\/\/.*$/gm, '')
  assert.match(src, /check\('tag points at HEAD \(docs committed before tag\)'/)
  assert.match(src, /check\(`tag contains current \$\{doc\}`/)
  assert.match(src, /docs\/AUDIT-v\$\{fangVersion\}\.md/)
})
