// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const TOOL = fileURLToPath(new URL('../tools/release/deploy-profile.mjs', import.meta.url))

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-deploy-check-'))
  const pkg = path.join(root, 'pkg')
  const data = path.join(root, 'data')
  const profile = path.join(root, 'profile')
  fs.mkdirSync(pkg, { recursive: true })
  fs.mkdirSync(data, { recursive: true })
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@twinsearth/fang-dsh-plugin', version: '9.9.9' }))
  return { root, pkg, data, profile }
}

function writeEndpoint(data, endpoint) {
  fs.writeFileSync(path.join(data, 'endpoint.json'), JSON.stringify(endpoint))
}

async function withServer(responseFor, fn) {
  const server = http.createServer((req, res) => {
    const response = responseFor(req)
    res.writeHead(response.status, response.headers ?? {})
    res.end(response.body ?? '')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function runCheck(root) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      TOOL, '--check', '--json',
      '--fang-home', root.data,
      '--source', root.pkg,
      '--profile', root.profile,
    ])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => {
      let body = null
      try { body = JSON.parse(stdout) } catch { body = null }
      resolve({ code, body, stdout, stderr })
    })
  })
}

test('deploy-profile --check treats a dead endpoint pid as stopped even if the old port answers 404', async () => {
  const root = makeRoot()
  await withServer(() => ({ status: 404, body: 'not found' }), async (url) => {
    writeEndpoint(root.data, { url, pid: 99_999_999, updatedAt: new Date().toISOString() })
    const out = await runCheck(root)
    assert.equal(out.code, 0)
    assert.equal(out.body?.ok, true)
    assert.equal(out.body?.alive?.probes?.[0]?.state, 'stopped')
    assert.match(out.body?.alive?.probes?.[0]?.reason, /404/)
  })
})

test('deploy-profile --check fails closed when the endpoint pid is alive but does not prove Fang identity', async () => {
  const root = makeRoot()
  await withServer(() => ({ status: 404, body: 'not found' }), async (url) => {
    writeEndpoint(root.data, { url, pid: process.pid, updatedAt: new Date().toISOString() })
    const out = await runCheck(root)
    assert.equal(out.code, 2)
    assert.equal(out.body?.ok, false)
    assert.equal(out.body?.alive?.probes?.[0]?.state, 'unknown')
  })
})

test('deploy-profile --check detects a different Fang instance on a stale endpoint', async () => {
  const root = makeRoot()
  await withServer(() => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }) }), async (url) => {
    writeEndpoint(root.data, { url, pid: 99_999_999, instanceId: 'old-instance', updatedAt: new Date().toISOString() })
    const out = await runCheck(root)
    assert.equal(out.code, 2)
    assert.equal(out.body?.ok, false)
    assert.equal(out.body?.alive?.probes?.[0]?.state, 'unknown')
  })
})

test('deploy-profile --check accepts a matching x-fang-instance header as a running host', async () => {
  const root = makeRoot()
  await withServer(() => ({ status: 401, headers: { 'x-fang-instance': 'instance-1', 'content-type': 'application/json' }, body: JSON.stringify({ ok: false, code: 'unauthorized' }) }), async (url) => {
    writeEndpoint(root.data, { url, pid: process.pid, instanceId: 'instance-1', updatedAt: new Date().toISOString() })
    const out = await runCheck(root)
    assert.equal(out.code, 2)
    assert.equal(out.body?.ok, false)
    assert.equal(out.body?.alive?.probes?.[0]?.state, 'running')
  })
})
