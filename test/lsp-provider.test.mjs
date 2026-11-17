// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// B-6 路线 A：母体 LSP provider 适配（ctx.lsp 能力缝）单测。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DELEGATE_ERROR } from '../src/lib/contract-delegation.mjs'
import {
  LSP_PROVIDER_MOTHER,
  advertisedActionsFromSeam,
  checkWorkspaceRoot,
  collectForkWorkspaceRoots,
  describeLspProvider,
  lspAuditRecord,
  mapLspError,
  normalizeLspResult,
  queryMotherLsp,
  resolveLspAllowedRoots,
} from '../src/lib/lsp-provider.mjs'

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fang-lsp-root-'))
}

function fakeSeam(handler) {
  const calls = []
  return {
    calls,
    query: async (request, signal) => {
      calls.push(request)
      return handler(request, signal)
    },
  }
}

test('B-6 provider: descriptor distinguishes mother / test-hook / fork-local and advertises only real capabilities', () => {
  const mother = describeLspProvider({ lspService: { query: async () => ({}) } })
  assert.equal(mother.available, true)
  assert.equal(mother.default, LSP_PROVIDER_MOTHER)
  assert.deepEqual(mother.actions, ['definition', 'references', 'implementation', 'hover'])
  assert.deepEqual(mother.services, { mother: true, 'fork-local': false, 'test-hook': false })
  assert.equal(mother.providers.mother.mode, 'delegated')
  assert.equal(mother.providers.mother.source, 'mother-process')
  assert.equal(mother.providers.mother.available, true)
  assert.deepEqual(mother.providers['fork-local'].actions, [], 'fork-local advertises nothing while not installed')

  const partial = describeLspProvider({ lspService: { query: async () => ({}) }, supportedActions: ['definition', 'hover'] })
  assert.deepEqual(partial.actions, ['definition', 'hover'], 'advertise the intersection only')

  const none = describeLspProvider({})
  assert.equal(none.available, false)
  assert.equal(none.default, null)
  assert.deepEqual(none.actions, [], 'no provider → nothing advertised')
  assert.deepEqual(none.nonProduction, [], 'no test seam → no non-production marker')

  const hook = describeLspProvider({ hooksEnabled: true })
  assert.equal(hook.default, 'test-hook')
  assert.deepEqual(hook.actions, [], 'test seam is not a real provider capability')
  assert.deepEqual(hook.nonProduction, ['test-hook'], 'test seam must be marked non-production')

  const fork = describeLspProvider({ forkLocal: true, forkLspInfo: { available: true, packages: ['@twinsearth/dsh-lsp'] } })
  assert.equal(fork.default, 'fork-local')
  assert.deepEqual(fork.actions, [], 'fork-local advertises only once installed')
  assert.deepEqual(fork.nonProduction, [], 'fork-local is a real provider, not a test seam')
  assert.equal(fork.providers['fork-local'].mode, 'local')
  assert.equal(fork.providers['fork-local'].source, 'fork-worktree')
  assert.deepEqual(fork.providers['fork-local'].actions, ['definition', 'references', 'implementation', 'hover'], 'installed fork-local provides the four read ops locally')
  assert.equal(fork.providers['fork-local'].detail.available, true)
})

test('B-6 provider: advertisedActionsFromSeam intersects declared capabilities with the four seam ops', () => {
  assert.deepEqual(advertisedActionsFromSeam(null), [])
  assert.deepEqual(advertisedActionsFromSeam({ query: async () => ({}) }), ['definition', 'references', 'implementation', 'hover'])
  assert.deepEqual(advertisedActionsFromSeam({ query: async () => ({}), supportedOperations: ['goToDefinition', 'hover'] }), ['definition', 'hover'])
  assert.deepEqual(advertisedActionsFromSeam({ query: async () => ({}), capabilities: ['findReferences'] }), ['references'])
})

test('B-6 root policy: empty allowlist denies; outside roots deny; file escaping denies; inside accepts', () => {
  const root = tempRoot()
  const file = path.join(root, 'src', 'index.ts')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'export const x = 1\n')

  const empty = checkWorkspaceRoot({ workspaceRoot: root, file, allowedRoots: [] })
  assert.equal(empty.ok, false)
  assert.equal(empty.code, DELEGATE_ERROR.INVALID)
  assert.equal(empty.reason, 'allowlist-empty')

  const outside = checkWorkspaceRoot({ workspaceRoot: root, file, allowedRoots: [path.join(os.tmpdir(), 'other-root')] })
  assert.equal(outside.ok, false)
  assert.equal(outside.code, DELEGATE_ERROR.INVALID)
  assert.equal(outside.reason, 'root-not-allowed')

  const escape = checkWorkspaceRoot({ workspaceRoot: root, file: path.join(os.tmpdir(), 'outside.ts'), allowedRoots: [root] })
  assert.equal(escape.ok, false)
  assert.equal(escape.code, DELEGATE_ERROR.INVALID)
  assert.equal(escape.reason, 'file-outside-root')

  const ok = checkWorkspaceRoot({ workspaceRoot: root, file: 'src/index.ts', allowedRoots: [root] })
  assert.equal(ok.ok, true)
  assert.equal(ok.workspaceRoot, fs.realpathSync.native(root))
  assert.equal(ok.file, fs.realpathSync.native(file))

  const missingRoot = checkWorkspaceRoot({ workspaceRoot: '', file, allowedRoots: [root] })
  assert.equal(missingRoot.ok, false)
  assert.equal(missingRoot.code, DELEGATE_ERROR.INVALID)
  assert.equal(missingRoot.reason, 'workspace-root-missing')
})

test('B-6 query: maps contract action to seam operation; 0-based position passes through; locations normalize to 1-based {path,line,character}', async () => {
  const seam = fakeSeam(async () => ({ kind: 'locations', locations: [{ uri: 'file:///x.ts', range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } }], resolvedWorkspaceUri: 'file:///ws/' }))
  const result = await queryMotherLsp({
    lspService: seam,
    invoke: { action: 'definition', file: 'src/index.ts', line: 12, character: 3 },
    workspaceRoot: '/tmp/ws',
  })
  assert.equal(result.ok, true)
  assert.deepEqual(seam.calls[0], {
    operation: 'goToDefinition',
    filePath: 'src/index.ts',
    position: { line: 12, character: 3 },
    workspaceRoot: '/tmp/ws',
  })
  assert.equal(result.result.provider, LSP_PROVIDER_MOTHER)
  assert.equal(result.result.kind, 'locations')
  assert.match(result.result.locations[0].path, /x\.ts$/)
  assert.equal(result.result.locations[0].line, 2, '1-based display')
  assert.equal(result.result.locations[0].character, 3, '1-based display')
  assert.equal(result.result.truncated, false)
  assert.equal(result.result.resolvedWorkspaceUri, 'file:///ws/')
})

test('B-6 query: hover normalizes to {contents}; references maps correctly', async () => {
  const seam = fakeSeam(async () => ({ kind: 'hover', hover: { contents: 'const x: number', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } }))
  const result = await queryMotherLsp({ lspService: seam, invoke: { action: 'references', file: 'x.ts', line: 1, character: 1 }, workspaceRoot: '/w' })
  assert.equal(result.ok, true)
  assert.equal(result.result.kind, 'hover')
  assert.equal(result.result.contents, 'const x: number')
  assert.equal(seam.calls[0].operation, 'findReferences')
})

test('B-6 result limits: locations/hover are trimmed by maxLocations/maxResultChars and marked truncated', async () => {
  const locations = Array.from({ length: 5 }, (_, index) => ({ uri: `file:///f${index}.ts`, range: { start: { line: index, character: 0 }, end: { line: index, character: 1 } } }))
  const seam = fakeSeam(async () => ({ kind: 'locations', locations }))
  const trimmed = await queryMotherLsp({ lspService: seam, invoke: { action: 'references', file: 'x.ts', line: 0, character: 0 }, workspaceRoot: '/w', limits: { maxLocations: 2, maxResultChars: 8 } })
  assert.equal(trimmed.result.locations.length, 2)
  assert.equal(trimmed.result.totalLocations, 5)
  assert.equal(trimmed.result.truncated, true)

  const hoverSeam = fakeSeam(async () => ({ kind: 'hover', hover: { contents: '0123456789' } }))
  const hover = await queryMotherLsp({ lspService: hoverSeam, invoke: { action: 'hover', file: 'x.ts', line: 0, character: 0 }, workspaceRoot: '/w', limits: { maxLocations: 2, maxResultChars: 8 } })
  assert.equal(hover.result.contents, '01234567')
  assert.equal(hover.result.truncated, true)
})

test('B-6 query: seam failures map to contract error codes; missing service / bad action are explicit', async () => {
  const unavailable = await queryMotherLsp({ lspService: null, invoke: { action: 'hover', file: 'x.ts', line: 1, character: 1 }, workspaceRoot: '/w' })
  assert.equal(unavailable.ok, false)
  assert.equal(unavailable.code, DELEGATE_ERROR.UNAVAILABLE)

  const badAction = await queryMotherLsp({ lspService: fakeSeam(async () => ({ kind: 'hover', hover: null })), invoke: { action: 'diagnostics', file: 'x.ts', line: 1, character: 1 }, workspaceRoot: '/w' })
  assert.equal(badAction.ok, false)
  assert.equal(badAction.code, DELEGATE_ERROR.UNSUPPORTED)

  const thrown = await queryMotherLsp({
    lspService: fakeSeam(async () => { const error = new Error('no provider'); error.code = 'LSP_UNAVAILABLE'; throw error }),
    invoke: { action: 'definition', file: 'x.ts', line: 1, character: 1 },
    workspaceRoot: '/w',
  })
  assert.equal(thrown.ok, false)
  assert.equal(thrown.code, DELEGATE_ERROR.UNAVAILABLE)
  assert.equal(thrown.detail.lspCode, 'LSP_UNAVAILABLE')

  const invalid = await queryMotherLsp({
    lspService: fakeSeam(async () => { const error = new Error('outside'); error.code = 'LSP_FILE_OUTSIDE_WORKSPACE'; throw error }),
    invoke: { action: 'definition', file: '../x.ts', line: 1, character: 1 },
    workspaceRoot: '/w',
  })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, DELEGATE_ERROR.INVALID)
})

test('B-6 provider: collectForkWorkspaceRoots reads every fork workspace index (explicit registration)', () => {
  const homeA = tempRoot()
  const homeB = tempRoot()
  const wsA = path.join(homeA, 'ws-a')
  const wsB = path.join(homeB, 'ws-b')
  fs.mkdirSync(path.join(homeA, 'storages'), { recursive: true })
  fs.mkdirSync(path.join(homeB, 'storages'), { recursive: true })
  fs.writeFileSync(path.join(homeA, 'storages', 'workspace.json'), JSON.stringify({ global: { workspaceIds: ['w1', 'w2'] }, tables: { workspaces: { w1: { path: wsA }, w2: { path: wsA } } } }))
  fs.writeFileSync(path.join(homeB, 'storages', 'workspace.json'), JSON.stringify({ global: { workspaceIds: ['w3'] }, tables: { workspaces: { w3: { path: wsB } } } }))
  const roots = collectForkWorkspaceRoots([homeA, homeB, path.join(homeA, 'missing-fork')])
  assert.deepEqual(roots.sort(), [wsA, wsB].sort())
})

test('B-6 roots: configured + fork workspace roots merge with dedupe; fork auto-registration is switchable', () => {
  const merged = resolveLspAllowedRoots({ configuredRoots: ['C:/mother'], forkRoots: ['C:/fork-ws', 'C:/mother'], includeForkWorktrees: true })
  assert.deepEqual(merged, ['C:/mother', 'C:/fork-ws'])
  const configuredOnly = resolveLspAllowedRoots({ configuredRoots: ['C:/mother'], forkRoots: ['C:/fork-ws'], includeForkWorktrees: false })
  assert.deepEqual(configuredOnly, ['C:/mother'])
})

test('B-6 audit: lsp attempt records workspaceRoot/outcome/provider', () => {
  const record = lspAuditRecord({ action: 'definition', workspaceRoot: 'C:/ws', outcome: 'ok', latencyMs: 12.4 })
  assert.equal(record.capability, 'fang.tool.invoke')
  assert.equal(record.tool, 'lsp')
  assert.equal(record.action, 'definition')
  assert.equal(record.provider, LSP_PROVIDER_MOTHER)
  assert.equal(record.workspaceRoot, 'C:/ws')
  assert.equal(record.outcome, 'ok')
  assert.equal(record.latencyMs, 12)
  const denied = lspAuditRecord({ action: 'hover', workspaceRoot: 'C:/outside', outcome: 'denied', error: DELEGATE_ERROR.UNAUTHORIZED })
  assert.equal(denied.error, DELEGATE_ERROR.UNAUTHORIZED)
})

test('B-6 contract error mapping: exact seam → delegation codes (visible detail preserved)', () => {
  // 契约口径（B-6 修订）：这些映射是契约的一部分，不得静默漂移。
  const cases = [
    ['LSP_UNAVAILABLE', DELEGATE_ERROR.UNAVAILABLE],
    ['LSP_FILE_OUTSIDE_WORKSPACE', DELEGATE_ERROR.INVALID],
    ['LSP_INVALID_PROVIDER', DELEGATE_ERROR.INVALID],
    ['LSP_MALFORMED_RESPONSE', DELEGATE_ERROR.UNAVAILABLE],
    ['LSP_SERVER_ERROR', DELEGATE_ERROR.UNAVAILABLE],
  ]
  for (const [seamCode, expected] of cases) {
    const mapped = mapLspError({ code: seamCode, message: 'seam failure' })
    assert.equal(mapped.code, expected, `${seamCode} must map to ${expected}`)
    assert.equal(mapped.detail.lspCode, seamCode)
    assert.match(mapped.message, /lsp provider error/)
    assert.equal(mapped.detail.serverMessage, 'seam failure')
  }
  const unknown = mapLspError(new Error('plain'))
  assert.equal(unknown.code, DELEGATE_ERROR.UNAVAILABLE)

  const normalized = normalizeLspResult(null, { action: 'hover', operation: 'hover' })
  assert.equal(normalized.kind, 'unknown')
  assert.equal(normalized.provider, LSP_PROVIDER_MOTHER)
})
