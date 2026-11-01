// SPDX-License-Identifier: AGPL-3.0-or-later
// docker/healthz-server.mjs — container health endpoint for the published release.
import fs from 'node:fs'
import http from 'node:http'

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const startedAt = new Date().toISOString()
const PORT = Number(process.env.PORT ?? 8080)

const health = () => ({
  ok: true,
  name: pkg.name,
  version: pkg.version,
  license: pkg.license,
  node: process.versions.node,
  platform: process.platform,
  commit: process.env.GIT_SHA || null,
  startedAt,
  at: new Date().toISOString(),
})

const server = http.createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/healthz/') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(health()))
    return
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('dsh-Fang release health service\nGET /healthz\n')
})
server.listen(PORT, '0.0.0.0', () => console.log(`dsh-Fang healthz on :${PORT} (${pkg.name}@${pkg.version})`))
