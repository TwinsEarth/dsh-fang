// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// tools/release/upload-release-assets.mjs
// 把 dist/ 里的发布资产直接传到 GitHub Release（幂等、可重试）。
//
// 为什么不用 `gh release upload`：自托管 Windows runner 上没有 gh CLI。
// 为什么不用 actions/upload-artifact → download-artifact：那条路径对
// results-receiver.actions.githubusercontent.com 的解析会间歇 ENOTFOUND，
// 一旦失败整条发布链的 npm / Release 都被 skip（v3.1.24 就是这么挂的）。
//
// v3.8.3 P2 #9：GitHub 上传/查询遇到 ENOTFOUND、ECONNRESET、502/503 时
// 自动指数退避重试；POST 上传响应丢失但资产已落地时，用 name+size+digest
// 回读并视为成功，避免重复上传 422 后又要人工重跑 workflow。
//
// 用法：
//   GH_TOKEN=xxx node tools/release/upload-release-assets.mjs --tag v3.1.25
//   （可选）--repo owner/name   默认取 GH_REPOSITORY 或 TwinsEarth/fang-dsh-plugin
//   （可选）--api URL           默认 GITHUB_API_URL 或 https://api.github.com
//   （可选）--dist dist         默认 dist
//   （可选）--retries 5         失败重试次数
//   （可选）--dry-run           只打印将要做的事
import fs from 'node:fs'
import path from 'node:path'
import { HttpError, retryAfterMsFrom, retryOperation, sha256Hex } from './net-retry.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback = '') => {
  const index = args.indexOf(name)
  return index >= 0 ? String(args[index + 1] ?? fallback) : fallback
}
const has = (name) => args.includes(name)

const TAG = flag('--tag', String(process.env.RELEASE_TAG ?? '').trim())
const REPO = flag('--repo', String(process.env.GH_REPOSITORY ?? 'TwinsEarth/fang-dsh-plugin').trim())
const API = flag('--api', String(process.env.GITHUB_API_URL ?? 'https://api.github.com').trim()).replace(/\/$/, '')
const DIST = flag('--dist', 'dist')
const RETRIES = Math.max(1, Math.min(10, Number(flag('--retries', process.env.FANG_RELEASE_RETRIES ?? '5')) || 5))
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

const retryOptions = {
  attempts: RETRIES,
  baseMs: 1000,
  capMs: 15000,
  log: (message) => console.log(`  retry: ${message}`),
}

function parseBody(raw) {
  try { return raw ? JSON.parse(raw) : null } catch { return null }
}

function apiUrl(suffix) {
  return `${API}/repos/${REPO}${suffix}`
}

async function json(method, url, body, { allow422 = false } = {}) {
  return retryOperation(async () => {
    const response = await fetch(url, {
      method,
      headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
      body: body ? JSON.stringify(body) : undefined,
    })
    const raw = await response.text()
    if (response.status === 404) return { status: 404, body: null, raw }
    if (!response.ok && !(allow422 && response.status === 422)) {
      throw new HttpError(`${method} ${url} -> HTTP ${response.status}: ${raw.slice(0, 300)}`, {
        status: response.status,
        body: parseBody(raw) ?? raw,
        retryAfterMs: retryAfterMsFrom(response.headers),
      })
    }
    return { status: response.status, body: parseBody(raw), raw }
  }, retryOptions)
}

function assetMatches(asset, data, localSha) {
  if (!asset) return false
  if (Number(asset.size) !== data.length) return false
  const digest = String(asset.digest ?? '').trim()
  if (!digest) return true // GitHub 老版本没有 digest；size 已相同，视为同一次上传
  return digest === `sha256:${localSha}`
}

async function listAssets(releaseId) {
  const response = await json('GET', apiUrl(`/releases/${releaseId}/assets`))
  return Array.isArray(response.body) ? response.body : []
}

async function createOrGetRelease() {
  const current = await json('GET', apiUrl(`/releases/tags/${TAG}`))
  if (current.body) {
    console.log('release exists:', current.body.id)
    return current.body
  }
  const created = await json('POST', apiUrl('/releases'), {
    tag_name: TAG,
    name: TAG,
    generate_release_notes: true,
    draft: false,
  }, { allow422: true })
  if (created.status === 201 && created.body && created.body.id && created.body.upload_url) {
    console.log('release created:', created.body.id, created.body.html_url)
    return created.body
  }
  // A concurrent retry may have created the release between GET and POST.
  const raced = await json('GET', apiUrl(`/releases/tags/${TAG}`))
  if (raced.body) {
    console.log('release exists after create race:', raced.body.id)
    return raced.body
  }
  throw new Error(`release create failed for ${TAG} (HTTP ${created.status})`)
}

async function uploadOnce(release, file) {
  const name = path.basename(file)
  const data = fs.readFileSync(file)
  const url = `${release.upload_url.split('{')[0]}?name=${encodeURIComponent(name)}`
  return retryOperation(async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': String(data.length) },
      body: data,
    })
    const raw = await response.text()
    const body = parseBody(raw)
    if (!response.ok) {
      throw new HttpError(`upload ${name} -> HTTP ${response.status}: ${raw.slice(0, 300)}`, {
        status: response.status,
        body,
        retryAfterMs: retryAfterMsFrom(response.headers),
      })
    }
    if (!body || !body.id) {
      // 上传可能已经落地但响应被网络截断；按 transient 处理，下一次 422 时会回读资产。
      throw new HttpError(`upload ${name} returned an invalid response`, { status: 502, body })
    }
    return body
  }, retryOptions)
}

async function ensureUploaded(release, file, existing) {
  const name = path.basename(file)
  const data = fs.readFileSync(file)
  const localSha = sha256Hex(data)
  const duplicate = existing.find((asset) => asset.name === name)
  if (duplicate) {
    if (assetMatches(duplicate, data, localSha)) {
      console.log(`asset already current: ${name}`)
      return { ...duplicate, recovered: true }
    }
    await json('DELETE', apiUrl(`/releases/assets/${duplicate.id}`))
    console.log('replaced old asset:', name)
  }
  try {
    return await uploadOnce(release, file)
  } catch (error) {
    if (Number(error?.status) !== 422) throw error
    // Ambiguous POST: the asset may exist even though the client lost the response.
    const current = await listAssets(release.id)
    const recovered = current.find((asset) => asset.name === name && assetMatches(asset, data, localSha))
    if (recovered) {
      console.log(`recovered uploaded asset after 422: ${name}`)
      return { ...recovered, recovered: true }
    }
    const conflicting = current.find((asset) => asset.name === name)
    if (!conflicting) throw error
    await json('DELETE', apiUrl(`/releases/assets/${conflicting.id}`))
    return uploadOnce(release, file)
  }
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
  console.log(`tag=${TAG} repo=${REPO} assets=${files.length} retries=${RETRIES}`)
  for (const file of files) console.log('  ·', path.basename(file), fs.statSync(file).size, 'B')
  if (DRY) { console.log('--dry-run：未上传'); return }

  const release = await createOrGetRelease()
  const existing = await listAssets(release.id)
  for (const file of files) {
    const asset = await ensureUploaded(release, file, existing)
    console.log(`uploaded ${path.basename(file)} (${asset.size} B) state=${asset.state}${asset.recovered ? ' recovered' : ''}`)
  }

  const final = await json('GET', apiUrl(`/releases/tags/${TAG}`))
  if (!final.body || !Array.isArray(final.body.assets)) throw new Error(`release ${TAG} not readable after upload`)
  console.log(`\nrelease ${TAG}: ${final.body.assets.length} assets — ${final.body.html_url}`)
  for (const asset of final.body.assets) console.log('  -', asset.name, asset.size, 'B')
}

main().catch((error) => { console.error('FAIL', error.message); process.exit(1) })
