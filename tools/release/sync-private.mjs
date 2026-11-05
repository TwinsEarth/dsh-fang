#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// 公共仓 → 私有镜像仓 的发布同步（零第三方依赖，仅 GitHub REST API）。
//
// 为什么用 REST 而不是 git push：本仓库的发布机只放行 api.github.com / uploads.github.com，
// 直连 github.com:443 会超时（见 docs/RELEASE-MIRROR.md「网络前提」）。
//
// 用法：
//   node tools/release/sync-private.mjs verify --tag v2.8.3
//   node tools/release/sync-private.mjs sync   --tag v2.8.3
//   node tools/release/sync-private.mjs verify --tag v2.8.3 --json
//
// 认证：--token-file <path>（默认 .secrets/github-token.txt），或环境变量 GITHUB_TOKEN。
// 资产：--assets-dir <dir>（sync 时从公共 Release 经 API 下载到该目录，默认 .tmp/mirror-assets）。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const DEFAULT_OWNER = 'TwinsEarth'
export const DEFAULT_PUBLIC = 'dsh-fang'
export const DEFAULT_PRIVATE = 'dsh-fang-private'
export const SUPPORTED_MODES = ['sync', 'verify']

/** 解析命令行参数（纯函数，便于测试）。 */
export function parseArgs(argv) {
  const options = {
    mode: 'verify',
    owner: DEFAULT_OWNER,
    publicRepo: DEFAULT_PUBLIC,
    privateRepo: DEFAULT_PRIVATE,
    tag: '',
    tokenFile: path.join('.secrets', 'github-token.txt'),
    assetsDir: path.join('.tmp', 'mirror-assets'),
    json: false,
    dryRun: false,
  }
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') { options.json = true; continue }
    if (arg === '--dry-run') { options.dryRun = true; continue }
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`missing value for --${key}`)
      index += 1
      if (key === 'owner') options.owner = value
      else if (key === 'public') options.publicRepo = value
      else if (key === 'private') options.privateRepo = value
      else if (key === 'tag') options.tag = value
      else if (key === 'token-file') options.tokenFile = value
      else if (key === 'assets-dir') options.assetsDir = value
      else throw new Error(`unknown option --${key}`)
      continue
    }
    positional.push(arg)
  }
  if (positional.length > 0) options.mode = positional[0]
  if (!SUPPORTED_MODES.includes(options.mode)) throw new Error(`unknown mode "${options.mode}" (expected: ${SUPPORTED_MODES.join('|')})`)
  if (!/^v\d+\.\d+\.\d+$/.test(options.tag)) throw new Error(`--tag must look like v1.2.3 (got "${options.tag}")`)
  return options
}

export function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/**
 * 计算私有仓需要新建的 blob 列表（纯函数）。
 * @param {Array<{path: string, mode: string, sha: string}>} publicBlobs 公共仓 tree 的 blob 条目
 * @param {Map<string, string>} existingShas 私有仓现有 path→blob sha
 * @returns {{entries: Array<{path: string, mode: string, fetch: boolean, sha: string}>,
 *            reuseCount: number, fetchCount: number, fetchList: string[]}}
 */
export function buildSyncEntries(publicBlobs, existingShas) {
  const entries = []
  const fetchList = []
  let reuseCount = 0
  for (const blob of publicBlobs) {
    const existing = existingShas.get(blob.path)
    if (existing === blob.sha) {
      reuseCount += 1
      entries.push({ path: blob.path, mode: blob.mode, sha: blob.sha, fetch: false })
      continue
    }
    fetchList.push(blob.sha)
    entries.push({ path: blob.path, mode: blob.mode, sha: blob.sha, fetch: true })
  }
  return { entries, reuseCount, fetchCount: fetchList.length, fetchList }
}

/**
 * 判断一个 Release 的资产是否自洽（纯函数）。
 * @param {{actualSha: string, manifestSha: string|null, publishedSha: string|null}} input
 * @returns {{ok: boolean, problems: string[]}}
 */
export function decideAssetReconciliation(input) {
  const problems = []
  if (input.manifestSha === null) problems.push('manifest.json missing')
  else if (input.manifestSha !== input.actualSha) problems.push(`manifest sha256 ${input.manifestSha} != actual ${input.actualSha}`)
  if (input.publishedSha === null) problems.push('.sha256 asset missing')
  else if (input.publishedSha !== input.actualSha) problems.push(`.sha256 asset ${input.publishedSha} != actual ${input.actualSha}`)
  return { ok: problems.length === 0, problems }
}

/**
 * 比较两个仓的同名 tag 指向的内容树（纯函数）。
 * @param {{publicTree: string, privateTree: string}} input
 * @returns {{ok: boolean, detail: string}}
 */
export function compareTrees(input) {
  return { ok: input.publicTree === input.privateTree, detail: `public=${input.publicTree} private=${input.privateTree}` }
}

// ── 网络层 ──────────────────────────────────────────────────────────────────

function createClient(token) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-fang-mirror',
    'content-type': 'application/json',
  }
  async function call(method, apiPath, body) {
    const res = await fetch(`https://api.github.com${apiPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* ignore */ }
    if (!res.ok) throw new Error(`${method} ${apiPath} -> ${res.status} ${text.slice(0, 400)}`)
    return json
  }
  async function download(assetUrl) {
    const res = await fetch(assetUrl, { headers: { ...headers, accept: 'application/octet-stream' } })
    if (!res.ok) throw new Error(`download ${assetUrl} -> ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
  async function upload(ownerRepo, releaseId, name, buffer, contentType) {
    const res = await fetch(
      `https://uploads.github.com/repos/${ownerRepo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'dsh-fang-mirror',
          'content-type': contentType,
        },
        body: buffer,
      },
    )
    const json = await res.json()
    if (!res.ok) throw new Error(`upload ${name} -> ${res.status} ${JSON.stringify(json).slice(0, 300)}`)
    return json
  }
  return { call, download, upload }
}

async function resolveTagCommit(client, owner, repo, tag) {
  const ref = await client.call('GET', `/repos/${owner}/${repo}/git/ref/tags/${tag}`)
  if (ref.object.type !== 'tag') return ref.object.sha
  const tagObject = await client.call('GET', `/repos/${owner}/${repo}/git/tags/${ref.object.sha}`)
  return tagObject.object.sha
}

async function treeOf(client, owner, repo, commitSha) {
  const commit = await client.call('GET', `/repos/${owner}/${repo}/git/commits/${commitSha}`)
  return commit.tree.sha
}

async function releaseOf(client, owner, repo, tag) {
  try {
    return await client.call('GET', `/repos/${owner}/${repo}/releases/tags/${tag}`)
  } catch {
    return null
  }
}

async function releaseAssetReport(client, owner, repo, release, workDir) {
  if (release === null) return { ok: false, problems: ['release missing'], actualSha: null, tgzBytes: 0 }
  const tgzAsset = release.assets.find((asset) => asset.name.endsWith('.tgz'))
  const manifestAsset = release.assets.find((asset) => asset.name === 'manifest.json')
  const shaAsset = release.assets.find((asset) => asset.name.endsWith('.tgz.sha256'))
  if (!tgzAsset) return { ok: false, problems: ['tarball asset missing'], actualSha: null, tgzBytes: 0 }
  fs.mkdirSync(workDir, { recursive: true })
  const tgzPath = path.join(workDir, path.basename(tgzAsset.name))
  const tgz = await client.download(tgzAsset.url)
  fs.writeFileSync(tgzPath, tgz)
  const actualSha = sha256Buffer(tgz)
  const manifest = manifestAsset ? JSON.parse((await client.download(manifestAsset.url)).toString('utf8')) : null
  const published = shaAsset ? (await client.download(shaAsset.url)).toString('utf8').trim().split(/\s+/)[0] : null
  const decision = decideAssetReconciliation({
    actualSha,
    manifestSha: manifest?.sha256 ?? null,
    publishedSha: published,
  })
  return { ok: decision.ok, problems: decision.problems, actualSha, tgzBytes: tgz.length, manifestSha: manifest?.sha256 ?? null }
}

// ── 两种模式 ────────────────────────────────────────────────────────────────

async function verifyMode(client, options, out) {
  const publicCommit = await resolveTagCommit(client, options.owner, options.publicRepo, options.tag)
  const privateCommit = await resolveTagCommit(client, options.owner, options.privateRepo, options.tag)
  const publicTree = await treeOf(client, options.owner, options.publicRepo, publicCommit)
  const privateTree = await treeOf(client, options.owner, options.privateRepo, privateCommit)
  const trees = compareTrees({ publicTree, privateTree })

  const publicRelease = await releaseOf(client, options.owner, options.publicRepo, options.tag)
  const privateRelease = await releaseOf(client, options.owner, options.privateRepo, options.tag)
  const privateAssets = await releaseAssetReport(client, options.owner, options.privateRepo, privateRelease, path.join(options.assetsDir, 'private'))
  const publicAssets = await releaseAssetReport(client, options.owner, options.publicRepo, publicRelease, path.join(options.assetsDir, 'public'))

  const report = {
    tag: options.tag,
    public: { repo: `${options.owner}/${options.publicRepo}`, commit: publicCommit, tree: publicTree, release: publicRelease?.id ?? null, assets: publicAssets },
    private: { repo: `${options.owner}/${options.privateRepo}`, commit: privateCommit, tree: privateTree, release: privateRelease?.id ?? null, assets: privateAssets },
    trees,
    ok: trees.ok && privateAssets.ok,
  }
  out(report)
  return report.ok ? 0 : 1
}

async function syncMode(client, options, out) {
  const publicCommit = await resolveTagCommit(client, options.owner, options.publicRepo, options.tag)
  const publicTree = await treeOf(client, options.owner, options.publicRepo, publicCommit)
  const tree = await client.call('GET', `/repos/${options.owner}/${options.publicRepo}/git/trees/${publicTree}?recursive=1`)
  if (tree.truncated) throw new Error('public tree truncated; refusing partial mirror')
  const blobs = tree.tree.filter((entry) => entry.type === 'blob')

  const mainRef = await client.call('GET', `/repos/${options.owner}/${options.privateRepo}/git/ref/heads/main`)
  const mainSha = mainRef.object.sha
  const privateCommit = await client.call('GET', `/repos/${options.owner}/${options.privateRepo}/git/commits/${mainSha}`)
  const privateTree = await client.call('GET', `/repos/${options.owner}/${options.privateRepo}/git/trees/${privateCommit.tree.sha}?recursive=1`)
  const existing = new Map(privateTree.tree.filter((entry) => entry.type === 'blob').map((entry) => [entry.path, entry.sha]))

  const plan = buildSyncEntries(blobs, existing)
  out({ mode: 'sync', tag: options.tag, publicCommit, publicTree, files: blobs.length, reuse: plan.reuseCount, fetch: plan.fetchCount })

  const entries = []
  for (const entry of plan.entries) {
    if (!entry.fetch) {
      entries.push({ path: entry.path, mode: entry.mode, type: 'blob', sha: entry.sha })
      continue
    }
    const blob = await client.call('GET', `/repos/${options.owner}/${options.publicRepo}/git/blobs/${entry.sha}`)
    const created = await client.call('POST', `/repos/${options.owner}/${options.privateRepo}/git/blobs`, { content: blob.content, encoding: 'base64' })
    entries.push({ path: entry.path, mode: entry.mode, type: 'blob', sha: created.sha })
  }

  const newTree = await client.call('POST', `/repos/${options.owner}/${options.privateRepo}/git/trees`, { tree: entries })
  if (newTree.sha !== publicTree) throw new Error(`mirrored tree ${newTree.sha} != public tree ${publicTree}`)
  if (options.dryRun) { out({ mode: 'sync', dryRun: true, tree: newTree.sha }); return 0 }

  const message = [
    `chore(sync): mirror public ${options.tag} content`,
    '',
    `Public ${options.owner}/${options.publicRepo} @ ${publicCommit} (tag ${options.tag}); tree ${publicTree}.`,
  ].join('\n')
  const commit = await client.call('POST', `/repos/${options.owner}/${options.privateRepo}/git/commits`, {
    message,
    tree: newTree.sha,
    parents: [mainSha],
  })
  await client.call('PATCH', `/repos/${options.owner}/${options.privateRepo}/git/refs/heads/main`, { sha: commit.sha, force: false })
  out({ mode: 'sync', commit: commit.sha, tree: newTree.sha })

  // tag（annotated），已存在则跳过
  try {
    const tagObject = await client.call('POST', `/repos/${options.owner}/${options.privateRepo}/git/tags`, {
      tag: options.tag,
      message: `dsh-Fang ${options.tag}`,
      object: commit.sha,
      type: 'commit',
    })
    await client.call('POST', `/repos/${options.owner}/${options.privateRepo}/git/refs`, { ref: `refs/tags/${options.tag}`, sha: tagObject.sha })
    out({ mode: 'sync', tag: 'created', sha: tagObject.sha })
  } catch (error) {
    out({ mode: 'sync', tag: 'skipped', reason: String(error.message).slice(0, 200) })
  }

  const publicRelease = await releaseOf(client, options.owner, options.publicRepo, options.tag)
  if (publicRelease === null) { out({ mode: 'sync', release: 'public release missing; assets skipped' }); return 0 }
  let privateRelease = await releaseOf(client, options.owner, options.privateRepo, options.tag)
  if (privateRelease === null) {
    privateRelease = await client.call('POST', `/repos/${options.owner}/${options.privateRepo}/releases`, {
      tag_name: options.tag,
      target_commitish: commit.sha,
      name: publicRelease.name,
      body: `${publicRelease.body}\n\n## 私有镜像\n内容与公共仓 ${options.tag} 一致（tree ${newTree.sha}）。`,
      draft: false,
      prerelease: false,
    })
    out({ mode: 'sync', release: `created ${privateRelease.id}` })
  }
  const report = await releaseAssetReport(client, options.owner, options.privateRepo, privateRelease, path.join(options.assetsDir, 'private'))
  out({ mode: 'sync', releaseAssets: report })
  return report.ok ? 0 : 1
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function readToken(options) {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim()
  const tokenPath = path.resolve(options.tokenFile)
  if (!fs.existsSync(tokenPath)) throw new Error(`token not found: ${tokenPath} (use --token-file or GITHUB_TOKEN)`)
  return fs.readFileSync(tokenPath, 'utf8').trim()
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv)
  const log = deps.log ?? ((line) => process.stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line, null, 2)}\n`))
  if (options.json) options.json = true
  const token = deps.token ?? readToken(options)
  const client = deps.client ?? createClient(token)
  const out = options.json ? ((value) => log(JSON.stringify(value))) : log
  return options.mode === 'sync' ? syncMode(client, options, out) : verifyMode(client, options, out)
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    process.stderr.write(`sync-private failed: ${error.message}\n`)
    process.exitCode = 1
  })
}
