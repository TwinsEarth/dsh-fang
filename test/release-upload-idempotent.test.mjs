// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const script = path.join(root, 'tools/release/upload-release-assets.mjs')

function collect(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

test('release asset upload recovers when a successful upload response is lost', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-release-retry-'))
  const files = ['dsh-fang-0.0.0.tgz', 'dsh-fang-0.0.0.tgz.sha256', 'manifest.json', 'preflight.json']
  for (const name of files) fs.writeFileSync(path.join(dir, name), Buffer.from(`payload:${name}`))

  const assets = []
  const firstAttempts = new Set()
  let nextId = 1
  let release = null
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/repos/owner/repo/releases/tags/v0.0.0') {
      res.writeHead(release ? 200 : 404, { 'content-type': 'application/json' })
      res.end(release ? JSON.stringify(release) : '{"message":"Not Found"}')
      return
    }
    if (req.method === 'POST' && url.pathname === '/repos/owner/repo/releases') {
      release = { id: 1, upload_url: 'http://127.0.0.1:{{port}}/upload/1{?name,label}', html_url: 'http://example.test/release/1', assets }
      release.upload_url = release.upload_url.replace('{{port}}', String(server.address().port))
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify(release))
      return
    }
    if (req.method === 'GET' && url.pathname === '/repos/owner/repo/releases/1/assets') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(assets))
      return
    }
    if (req.method === 'POST' && url.pathname === '/upload/1') {
      const name = url.searchParams.get('name')
      const body = await collect(req)
      if (!firstAttempts.has(name)) {
        firstAttempts.add(name)
        const asset = {
          id: nextId++,
          name,
          size: body.length,
          digest: `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`,
          state: 'uploaded',
        }
        assets.push(asset)
        // Simulate the edge: server persisted the asset, but the response
        // connection reset before the client could read it.
        req.socket.destroy()
        return
      }
      res.writeHead(422, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: 'Validation Failed', errors: [{ code: 'already_exists' }] }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"message":"Not Found"}')
  })

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const child = spawn(process.execPath, [
      script, '--tag', 'v0.0.0', '--repo', 'owner/repo', '--dist', dir,
      '--api', `http://127.0.0.1:${port}`, '--retries', '2',
    ], { cwd: root, env: { ...process.env, GH_TOKEN: 'test-token' } })
    let output = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { output += String(chunk) })
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(-1) }, 30000)
      child.on('close', (exitCode) => { clearTimeout(timer); resolve(exitCode) })
    })
    assert.equal(code, 0, output)
    assert.match(output, /recovered uploaded asset after 422/)
    assert.equal(assets.length, files.length)
    assert.deepEqual(assets.map((asset) => asset.name).sort(), files.slice().sort())
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
