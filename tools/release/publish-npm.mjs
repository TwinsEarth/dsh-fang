// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/release/publish-npm.mjs — 用 npm registry REST API 发布（本机无 npm CLI 也能发）。
// 用法：node tools/release/publish-npm.mjs [--dry]
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, readJson, readSecret, httpJson } from './lib.mjs'

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const pkg = readJson('dist/npm/package/package.json')
const manifest = readJson('dist/manifest.json')
const tarball = path.join(ROOT, 'dist', manifest.tarball)
if (!fs.existsSync(tarball)) { console.error('FAIL missing tarball: ' + tarball); process.exit(2) }
const readme = fs.existsSync(path.join(ROOT, 'dist/npm/package/README.md'))
  ? fs.readFileSync(path.join(ROOT, 'dist/npm/package/README.md'), 'utf8')
  : ''
const data = fs.readFileSync(tarball).toString('base64')
const crypto = await import('node:crypto')
const tarballBytes = fs.readFileSync(tarball)
const versionManifest = {
  ...pkg,
  _id: `${pkg.name}@${pkg.version}`,
  dist: {
    tarball: `https://registry.npmjs.org/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`,
    shasum: crypto.createHash('sha1').update(tarballBytes).digest('hex'),
    integrity: `sha512-${crypto.createHash('sha512').update(tarballBytes).digest('base64')}`,
    fileCount: manifest.files.length,
    unpackedSize: tarballBytes.length,
  },
}
const body = {
  _id: pkg.name,
  name: pkg.name,
  description: pkg.description,
  'dist-tags': { latest: pkg.version },
  versions: { [pkg.version]: versionManifest },
  readme,
  _attachments: {
    [`${pkg.name}-${pkg.version}.tgz`]: { content_type: 'application/octet-stream', data, length: fs.statSync(tarball).size },
  },
}
const payload = JSON.stringify(body)
console.log(`package : ${pkg.name}@${pkg.version}`)
console.log(`tarball : ${manifest.tarball} (${fs.statSync(tarball).size} bytes)`)
console.log(`payload : ${(payload.length / 1024).toFixed(1)} KiB`)

const token = readSecret('NPM_TOKEN', 'npm-token.txt')
if (!token) {
  console.error('\nFAIL no npm token. Put an npm Automation token in E:\\GPT\\.secrets\\npm-token.txt')
  console.error('     (npmjs.com → Access Tokens → Generate New Token → Automation), or set NPM_TOKEN.')
  process.exit(2)
}
if (dry) { console.log('DRY: token present, payload built; nothing published'); process.exit(0) }

const res = await httpJson(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`, {
  method: 'PUT',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: payload,
})
if (res.status === 200 || res.status === 201) {
  console.log(`\nPUBLISHED ${pkg.name}@${pkg.version}`)
  console.log(`registry: https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`)
} else {
  console.error(`\nFAIL npm publish: HTTP ${res.status}`)
  console.error(JSON.stringify(res.data).slice(0, 800))
  process.exitCode = 1
}
