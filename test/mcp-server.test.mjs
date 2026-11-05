// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from '../tools/mcp/server.mjs'

const callTool = async (name) => ({ name, ok: true })

test('initialize returns protocol and server info', async () => {
  const handle = createServer({ callTool })
  const res = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize' })
  assert.equal(res.result.serverInfo.name, 'dsh-fang')
  assert.equal(res.result.protocolVersion, '2024-11-05')
})

test('tools/list includes 8 default + 2 op tools, hides high-risk', async () => {
  const handle = createServer({ callTool })
  const res = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const names = res.result.tools.map((tool) => tool.name)
  assert.equal(names.length, 10)
  assert.equal(names.includes('promote'), false)
  assert.equal(names.includes('get_op'), true)
})

test('tools/call status returns tool result', async () => {
  const handle = createServer({ callTool })
  const res = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'status', arguments: {} } })
  assert.equal(res.result.isError, false)
  assert.equal(JSON.parse(res.result.content[0].text).name, 'status')
})

test('derive returns opId and get_op polls it', async () => {
  const handle = createServer({ callTool: async () => ({ ok: true, taskId: 't1' }) })
  const started = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'derive', arguments: {} } })
  const opId = JSON.parse(started.result.content[0].text).opId
  assert.match(opId, /^op_/)
  await new Promise((resolve) => setImmediate(resolve))
  const polled = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_op', arguments: { opId } } })
  assert.equal(JSON.parse(polled.result.content[0].text).state, 'completed')
})

test('unknown method is a JSON-RPC error', async () => {
  const handle = createServer({ callTool })
  const res = await handle({ jsonrpc: '2.0', id: 6, method: 'nope' })
  assert.equal(res.error.code, -32601)
})
