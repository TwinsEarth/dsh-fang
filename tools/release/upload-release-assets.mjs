// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// tools/release/upload-release-assets.mjs
// 把 dist/ 里的发布资产直接传到 GitHub Release（幂等）。
//
// 为什么不用 `gh release upload`：自托管 Windows runner 上没有 gh CLI。
// 为什么不用 actions/upload-artifact → download-artifact：那条路径对
// results-receiver.actions.githubusercontent.com 的解析会间歇 ENOTFOUND，
// 一旦失败整条发布链的 npm / Release 都被 skip（v3.1.24 就是这么挂的）。
//
// 用法：
//   GH_TOKEN=xxx node tools/release/upload-release-assets.mjs --tag v3.1.25
//   （可选）--repo owner/name   默认取 GH_REPOSITORY 或 TwinsEarth/dsh-fang
//   （可选）--dist dist         默认 dist
//   （可选）--dry-run           只打印将要做的事
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const flag = (name, fallback = '') => {
  const index = args.indexOf(name)
  return index >= 0 ? String(args[index + 1] ?? fallback) : fallback
}
const has = (name) => args.includes(name)

const TAG = flag('--tag', String(process.env.RELEASE_TAG ?? '').trim())
const REPO = flag('--repo', String(process.env.GH_REPOSITORY ?? 'TwinsEarth/dsh-fang').trim())
const DIST = flag('--dist', 'dist')
const DRY = has('--dry-run')
const TOKEN = String(process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '').trim()

if (!TAG) { console.error('missing --tag (or RELEASE_TAG)'); process.exit(2) }
if (!TOKEN && !DRY) { console.error('missing GH_TOKEN'); process.exit(2) }

const headers = {
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-fang-release',
  'x-github-api-version': '2022-11-28',
}

async function json(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const raw = await response.text()
  if (response.status === 404) return { status: 404, body: null }
  if (!response.ok && response.status !== 422) {
    throw new Error(`${method} ${url} -> HTTP ${response.status}: ${raw.slice(0, 300)}`)
  }
  return { status: response.status, body: raw ? JSON.parse(raw) : null }
}

async function upload(assetUrl, filePath) {
  const name = path.basename(filePath)
  const data = fs.readFileSync(filePath)
  const url = `${assetUrl.split('{')[0]}?name=${encodeURIComponent(name)}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': String(data.length) },
    body: data,
  })
  const raw = await response.text()
  if (!response.ok) throw new Error(`upload ${name} -> HTTP ${response.status}: ${raw.slice(0, 300)}`)
  return JSON.parse(raw)
}

/** 只挑这一版的资产：避免把 dist 里遗留的旧版本 tgz 一起传上去。 */
function pickAssets(version) {
  const wanted = new RegExp(`^dsh-fang-${version.replace(/\./g, '\\.')}\\.tgz(\\.sha256)?$`)
  return fs.readdirSync(DIST)
    .filter((name) => wanted.test(name) || name === 'manifest.json' || name === 'preflight.json')
    .map((name) => path.join(DIST, name))
}

async function main() {
  const version = TAG.replace(/^v/, '')
  const files = pickAssets(version)
  if (files.length === 0) throw new Error(`${DIST} 里没有 ${version} 的资产`)
  for (const file of files) {
    if (!fs.existsSync(file)) throw new Error('asset missing: ' + file)
  }
  console.log(`tag=${TAG} repo=${REPO} assets=${files.length}`)
  for (const file of files) console.log('  ·', path.basename(file), fs.statSync(file).size, 'B')
  if (DRY) { console.log('--dry-run：未上传'); return }

  let release = (await json('GET', `https://api.github.com/repos/${REPO}/releases/tags/${TAG}`)).body
  if (release) console.log('release exists:', release.id)
  else {
    release = (await json('POST', `https://api.github.com/repos/${REPO}/releases`, {
      tag_name: TAG,
      name: TAG,
      generate_release_notes: true,
      draft: false,
    })).body
    console.log('release created:', release.id, release.html_url)
  }

  const existing = (await json('GET', `https://api.github.com/repos/${REPO}/releases/${release.id}/assets`)).body ?? []
  for (const file of files) {
    const name = path.basename(file)
    const duplicate = existing.find((asset) => asset.name === name)
    if (duplicate) {
      await json('DELETE', `https://api.github.com/repos/${REPO}/releases/assets/${duplicate.id}`)
      console.log('replaced old asset:', name)
    }
    const asset = await upload(release.upload_url, file)
    console.log(`uploaded ${name} (${asset.size} B) state=${asset.state}`)
  }

  const final = (await json('GET', `https://api.github.com/repos/${REPO}/releases/tags/${TAG}`)).body
  console.log(`\nrelease ${TAG}: ${final.assets.length} assets — ${final.html_url}`)
  for (const asset of final.assets) console.log('  -', asset.name, asset.size, 'B')
}

main().catch((error) => { console.error('FAIL', error.message); process.exit(1) })
