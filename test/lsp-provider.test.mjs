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
  describeLspProvider,
  mapLspError,
  normalizeLspResult,
  queryMotherLsp,
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
  assert.deepEqual(mother.services, { 'mother-lsp': true, 'fork-local': false, 'test-hook': false })

  const partial = describeLspProvider({ lspService: { query: async () => ({}) }, supportedActions: ['definition', 'hover'] })
  assert.deepEqual(partial.actions, ['definition', 'hover'], 'advertise the intersection only')

  const none = describeLspProvider({})
  assert.equal(none.available, false)
  assert.equal(none.default, null)
  assert.deepEqual(none.actions, [], 'no provider → nothing advertised')

  const hook = describeLspProvider({ hooksEnabled: true })
  assert.equal(hook.default, 'test-hook')
  assert.deepEqual(hook.actions, [], 'test seam is not a real provider capability')

  const fork = describeLspProvider({ forkLocal: true })
  assert.equal(fork.default, 'fork-local')
  assert.deepEqual(fork.actions, [], 'fork-local advertises only once installed')
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
  assert.equal(empty.code, DELEGATE_ERROR.UNAUTHORIZED)

  const outside = checkWorkspaceRoot({ workspaceRoot: root, file, allowedRoots: [path.join(os.tmpdir(), 'other-root')] })
  assert.equal(outside.ok, false)
  assert.equal(outside.code, DELEGATE_ERROR.UNAUTHORIZED)

  const escape = checkWorkspaceRoot({ workspaceRoot: root, file: path.join(os.tmpdir(), 'outside.ts'), allowedRoots: [root] })
  assert.equal(escape.ok, false)
  assert.equal(escape.code, DELEGATE_ERROR.INVALID)

  const ok = checkWorkspaceRoot({ workspaceRoot: root, file: 'src/index.ts', allowedRoots: [root] })
  assert.equal(ok.ok, true)
  assert.equal(ok.workspaceRoot, fs.realpathSync.native(root))
  assert.equal(ok.file, fs.realpathSync.native(file))

  const missingRoot = checkWorkspaceRoot({ workspaceRoot: '', file, allowedRoots: [root] })
  assert.equal(missingRoot.ok, false)
  assert.equal(missingRoot.code, DELEGATE_ERROR.INVALID)
})

test('B-6 query: maps contract action to seam operation and 1-based → 0-based position', async () => {
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
    position: { line: 11, character: 2 },
    workspaceRoot: '/tmp/ws',
  })
  assert.equal(result.result.provider, LSP_PROVIDER_MOTHER)
  assert.equal(result.result.kind, 'locations')
  assert.equal(result.result.locations[0].uri, 'file:///x.ts')
  assert.equal(result.result.resolvedWorkspaceUri, 'file:///ws/')
})

test('B-6 query: hover normalizes to content (or null) and references maps correctly', async () => {
  const seam = fakeSeam(async () => ({ kind: 'hover', hover: { contents: 'const x: number', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } }))
  const result = await queryMotherLsp({ lspService: seam, invoke: { action: 'references', file: 'x.ts', line: 1, character: 1 }, workspaceRoot: '/w' })
  assert.equal(result.ok, true)
  assert.equal(result.result.kind, 'hover')
  assert.equal(result.result.hover.contents, 'const x: number')
  assert.equal(seam.calls[0].operation, 'findReferences')
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

test('B-6 error/result normalizers: unknown codes stay readable; malformed result is JSON-safe', () => {
  const mapped = mapLspError({ code: 'LSP_SERVER_ERROR', message: 'boom' })
  assert.equal(mapped.code, DELEGATE_ERROR.UNAVAILABLE)
  assert.equal(mapped.detail.lspCode, 'LSP_SERVER_ERROR')
  const unknown = mapLspError(new Error('plain'))
  assert.equal(unknown.code, DELEGATE_ERROR.UNAVAILABLE)

  const normalized = normalizeLspResult(null, { action: 'hover', operation: 'hover' })
  assert.equal(normalized.kind, 'unknown')
  assert.equal(normalized.provider, LSP_PROVIDER_MOTHER)
})
