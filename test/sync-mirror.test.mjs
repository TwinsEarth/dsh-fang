// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v2.8.4 公共仓 → 私有镜像仓 发布同步工具的纯函数测试（网络路径不在单测内）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_OWNER,
  DEFAULT_PRIVATE,
  DEFAULT_PUBLIC,
  buildSyncEntries,
  compareTrees,
  decideAssetReconciliation,
  parseArgs,
  sha256Buffer,
} from '../tools/release/sync-private.mjs'

test('parseArgs：默认 verify 模式 + 公共/私有默认仓', () => {
  const options = parseArgs(['verify', '--tag', 'v2.8.3'])
  assert.equal(options.mode, 'verify')
  assert.equal(options.owner, DEFAULT_OWNER)
  assert.equal(options.publicRepo, DEFAULT_PUBLIC)
  assert.equal(options.privateRepo, DEFAULT_PRIVATE)
  assert.equal(options.tag, 'v2.8.3')
  assert.equal(options.json, false)
  assert.equal(options.dryRun, false)
})

test('parseArgs：sync 模式、--json、--dry-run、自定义仓与路径', () => {
  const options = parseArgs([
    'sync', '--tag', 'v2.9.0', '--json', '--dry-run',
    '--owner', 'acme', '--public', 'repo-a', '--private', 'repo-b',
    '--token-file', 'token.txt', '--assets-dir', 'out',
  ])
  assert.equal(options.mode, 'sync')
  assert.equal(options.tag, 'v2.9.0')
  assert.equal(options.json, true)
  assert.equal(options.dryRun, true)
  assert.equal(options.owner, 'acme')
  assert.equal(options.publicRepo, 'repo-a')
  assert.equal(options.privateRepo, 'repo-b')
  assert.equal(options.tokenFile, 'token.txt')
  assert.equal(options.assetsDir, 'out')
})

test('parseArgs：非法模式 / 非法 tag / 未知选项 / 缺值 都被明确拒绝', () => {
  assert.throws(() => parseArgs(['push', '--tag', 'v2.8.3']), /unknown mode/)
  assert.throws(() => parseArgs(['verify', '--tag', '2.8.3']), /--tag must look like/)
  assert.throws(() => parseArgs(['verify', '--tag', 'v2.8.3', '--nope', 'x']), /unknown option/)
  assert.throws(() => parseArgs(['verify', '--tag']), /missing value/)
})

test('buildSyncEntries：相同 blob 复用、不同 blob 进入待抓取列表', () => {
  const publicBlobs = [
    { path: 'README.md', mode: '100644', sha: 'aaa' },
    { path: 'src/a.mjs', mode: '100644', sha: 'bbb' },
    { path: 'bin/run.sh', mode: '100755', sha: 'ccc' },
  ]
  const existing = new Map([['README.md', 'aaa'], ['src/a.mjs', 'zzz']])
  const plan = buildSyncEntries(publicBlobs, existing)
  assert.equal(plan.reuseCount, 1)
  assert.equal(plan.fetchCount, 2)
  assert.deepEqual(plan.fetchList, ['bbb', 'ccc'])
  assert.deepEqual(plan.entries.map((entry) => [entry.path, entry.mode, entry.fetch]), [
    ['README.md', '100644', false],
    ['src/a.mjs', '100644', true],
    ['bin/run.sh', '100755', true],
  ])
})

test('buildSyncEntries：空仓库全部待抓取；完全一致时零抓取', () => {
  const blobs = [{ path: 'a', mode: '100644', sha: 'x' }]
  assert.equal(buildSyncEntries(blobs, new Map()).fetchCount, 1)
  assert.equal(buildSyncEntries(blobs, new Map([['a', 'x']])).fetchCount, 0)
})

test('decideAssetReconciliation：自洽 / manifest 不符 / 缺 .sha256 / 缺 manifest', () => {
  assert.deepEqual(decideAssetReconciliation({ actualSha: 'a', manifestSha: 'a', publishedSha: 'a' }), { ok: true, problems: [] })
  const badManifest = decideAssetReconciliation({ actualSha: 'a', manifestSha: 'b', publishedSha: 'a' })
  assert.equal(badManifest.ok, false)
  assert.match(badManifest.problems.join('\n'), /manifest sha256/)
  const badSha = decideAssetReconciliation({ actualSha: 'a', manifestSha: 'a', publishedSha: 'b' })
  assert.equal(badSha.ok, false)
  assert.match(badSha.problems.join('\n'), /\.sha256 asset/)
  const missing = decideAssetReconciliation({ actualSha: 'a', manifestSha: null, publishedSha: null })
  assert.equal(missing.problems.length, 2)
})

test('compareTrees：树一致才 ok（内容一致性证明）', () => {
  assert.equal(compareTrees({ publicTree: 'abc', privateTree: 'abc' }).ok, true)
  const mismatch = compareTrees({ publicTree: 'abc', privateTree: 'def' })
  assert.equal(mismatch.ok, false)
  assert.match(mismatch.detail, /public=abc private=def/)
})

test('sha256Buffer：与已知 SHA-256 向量一致且稳定', () => {
  assert.equal(sha256Buffer(Buffer.from('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(sha256Buffer(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(sha256Buffer(Buffer.from('abc')), sha256Buffer(Buffer.from('abc')))
})
