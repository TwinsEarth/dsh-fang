// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import readline from 'node:readline'

const serverPath = path.resolve(import.meta.dirname, '..', 'tools', 'mcp', 'server.mjs')

function rpc(child, request, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: child.stdout })
    const timer = setTimeout(() => { rl.close(); reject(new Error('mcp stdio timeout')) }, timeoutMs)
    rl.once('line', (line) => {
      clearTimeout(timer)
      rl.close()
      try { resolve(JSON.parse(line)) } catch (error) { reject(error) }
    })
    child.once('error', reject)
    child.stdin.write(JSON.stringify(request) + '\n')
  })
}

test('stdio server answers initialize and tools/list', async () => {
  const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] })
  try {
    const init = await rpc(child, { jsonrpc: '2.0', id: 1, method: 'initialize' })
    assert.equal(init.result.serverInfo.name, 'dsh-fang')
    const list = await rpc(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    assert.equal(list.result.tools.length, 10)
  } finally {
    child.kill()
  }
})
