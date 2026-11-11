// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v3.1.15 contract: fang-master SDK endpoint/service + legacy-safe fallback surface.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { makeCtx } from './helpers.mjs'
import { CONTRACT_VERSION, METHODS, createEnvelope } from '../src/contract/index.js'

test('contract: orchestrator exposes fangContract service in the mother role', async () => {
  const previous = process.env.DSH_FANG_ROLE
  process.env.DSH_FANG_ROLE = 'mother'
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-contract-'))
  const calls = []
  const ctx = makeCtx({
    services: {
      fangForker: {
        async spawn(params) { calls.push(params); return { ok: true, forkId: 'task_contract_1' } },
      },
    },
  })
  try {
    const mod = await import('../src/plugins/orchestrator.mjs')
    mod.apply(ctx, {
      dataRoot, forksRoot: path.join(dataRoot, 'forks'), adapterTimeoutMs: 150,
      routes: { enabled: false },
      contract: { enabled: true, token: 'contract-token' },
    })
    const contract = ctx.get('fangContract')
    assert.ok(contract, 'mother must expose fangContract')
    const hello = contract.hello()
    assert.equal(hello.protocol, 'fang-master')
    assert.equal(hello.contractVersion, CONTRACT_VERSION)
    assert.ok(hello.methods.includes(METHODS.FORK_SPAWN))

    const response = await contract.invoke(createEnvelope({
      method: METHODS.FORK_SPAWN,
      params: { title: 'contract spawn', env: { DSH_MASTER_TICKET: 'ticket', EVIL_KEY: 'drop' } },
    }))
    assert.equal(response.ok, true)
    assert.equal(response.result.forkId, 'task_contract_1')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].env.DSH_MASTER_TICKET, 'ticket')
    assert.equal(calls[0].env.EVIL_KEY, undefined, 'contract env is filtered to DSH_MASTER_*')
  } finally {
    ctx.dispose()
    fs.rmSync(dataRoot, { recursive: true, force: true })
    if (previous === undefined) delete process.env.DSH_FANG_ROLE
    else process.env.DSH_FANG_ROLE = previous
  }
})

test('contract: orchestrator skips the contract service in fork role', async () => {
  const previous = process.env.DSH_FANG_ROLE
  process.env.DSH_FANG_ROLE = 'fork'
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-contract-fork-'))
  const ctx = makeCtx()
  try {
    const mod = await import('../src/plugins/orchestrator.mjs')
    mod.apply(ctx, { dataRoot, routes: { enabled: false } })
    assert.equal(ctx.get('fangContract'), undefined)
  } finally {
    ctx.dispose()
    fs.rmSync(dataRoot, { recursive: true, force: true })
    if (previous === undefined) delete process.env.DSH_FANG_ROLE
    else process.env.DSH_FANG_ROLE = previous
  }
})
