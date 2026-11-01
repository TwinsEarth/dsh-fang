// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/release/lib.mjs — shared helpers for the release pipeline (zero dependencies).
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const PUBLISH_NAME = 'dsh-fang' // npm package name (unscoped, public)

export const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'))
export const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
export const exists = (rel) => fs.existsSync(path.join(ROOT, rel))

export function versionOf() {
  return readJson('package.json').version
}

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export function run(command, args, opts = {}) {
  const res = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 600000,
    env: { ...process.env, ...(opts.env ?? {}) },
  })
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

export function nodeRun(args, opts = {}) {
  return run(process.execPath, args, opts)
}

export function listTestFiles() {
  return fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.mjs')).sort()
}

export function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(abs, out)
    else out.push(abs)
  }
  return out
}

/** Minimal glob matcher for package.json `files` entries (`**` and `*`). */
export function globMatch(rel, pattern) {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '')
  let re = '^'
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') {
        re += '.*'
        i += 1
        if (p[i + 1] === '/') { re += '/?'; i += 1 }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(re + '$').test(rel.replace(/\\/g, '/'))
}

export function selectFilesFromManifest(pkg) {
  const out = new Set()
  for (const pattern of pkg.files ?? []) {
    for (const abs of walk(ROOT)) {
      const rel = path.relative(ROOT, abs).replace(/\\/g, '/')
      if (rel.startsWith('node_modules/') || rel.startsWith('dist/') || rel.startsWith('.git/')) continue
      if (globMatch(rel, pattern)) out.add(rel)
    }
  }
  // always ship the manifest + license texts + the CLI
  for (const always of ['package.json', 'README.md', 'LICENSE-CORE', 'LICENSE-SDK', 'LICENSE-COMMERCIAL', 'NOTICE', 'CLA.md', 'LICENSES/cordis-MIT.txt', 'tools/fangctl.mjs']) {
    if (fs.existsSync(path.join(ROOT, always))) out.add(always)
  }
  return [...out].sort()
}

/** token file helpers: env first, then E:\GPT\.secrets\<name>.txt (never printed). */
export function readSecret(envName, fileName) {
  if (process.env[envName]) return process.env[envName].trim()
  for (const p of [path.join(process.env.USERPROFILE ?? '', '.secrets', fileName), `E:/GPT/.secrets/${fileName}`]) {
    try {
      const t = fs.readFileSync(p, 'utf8').trim()
      if (t) return t
    } catch { /* next */ }
  }
  return ''
}

export async function httpJson(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: { 'user-agent': 'dsh-fang-release', ...(opts.headers ?? {}) },
    body: opts.body,
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text.slice(0, 400) } }
  return { status: res.status, data, text, headers: res.headers }
}

export function serveHealthz(handler, port = Number(process.env.PORT ?? 8080)) {
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz' || req.url === '/healthz/') {
      const info = handler()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(info))
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`dsh-Fang health service\n/healthz\n`)
  })
  server.listen(port, '0.0.0.0', () => console.log(`healthz listening on :${port}`))
  return server
}
