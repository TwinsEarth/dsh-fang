// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/git/history-audit.mjs — 只读体检：找出「重复历史」与「该退休的分支/标签」。
//
// 它回答四件事（不写盘、不改引用、不推送）：
//   1) 哪些版本标签不在 main 上（v2.8.3…v3.0.7 的历史问题）
//   2) 哪些分支已经 0 领先（可安全删除）
//   3) 哪些分支的提交是「重复补丁」（内容已在 main 上，只剩 commit 壳）
//   4) 哪些分支是陈旧分支（有独有提交、但很久没动）
//
// 用法：node tools/git/history-audit.mjs [--json] [--base origin/main] [--days 30] [--max-patch 200]
// 退出码：0 读取成功（体检结论不是错误）；1 git 读取失败。
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function git (args, { allowFail = false, input } = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', input, maxBuffer: 512 * 1024 * 1024 })
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`)
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

/** 一次 spawn 拿一批提交的 patch-id：git log -p | git patch-id --stable。 */
export function patchIds (rangeArgs, limit = 200) {
  const log = spawnSync('git', ['log', '--no-merges', '--patch', '--pretty=format:commit %H', ...rangeArgs], {
    cwd: ROOT, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024,
  })
  if (log.status !== 0 || !log.stdout) return new Map()
  const pid = spawnSync('git', ['patch-id', '--stable'], { cwd: ROOT, encoding: 'utf8', input: log.stdout, maxBuffer: 64 * 1024 * 1024 })
  const map = new Map()
  for (const line of (pid.stdout || '').split('\n')) {
    const [id, sha] = line.trim().split(/\s+/)
    if (id && sha) map.set(sha.slice(0, 40), id)
  }
  return map
}

export function rankBranch (row, { staleDays = 30, now = Date.now() } = {}) {
  if (row.ahead === 0) return 'merged'
  if (row.duplicateRatio >= 1) return 'duplicate'
  const ageDays = row.lastCommitAt ? (now - row.lastCommitAt) / 86400000 : Infinity
  return ageDays > staleDays ? 'stale' : 'active'
}

function main () {
  const argv = process.argv.slice(2)
  const opt = (n, d = '') => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
  const base = opt('--base', 'origin/main')
  const days = Number(opt('--days', '30'))
  const maxPatch = Number(opt('--max-patch', '200'))
  const noPatch = argv.includes('--no-patch') // 快速模式：只看 ahead/behind，不算重复补丁
  const json = argv.includes('--json')

  if (git(['rev-parse', '--verify', base], { allowFail: true }).status !== 0) {
    console.error(`FAIL 找不到基线 ${base}（先 git fetch origin）`)
    process.exitCode = 1
    return
  }

  const basePatch = noPatch ? new Map() : patchIds([base, '-n', '600'])
  const baseIds = new Set(basePatch.values())

  const tags = git(['tag', '--list', 'v*', '--sort=-version:refname']).out.split('\n').filter(Boolean)
  const offMainTags = tags.filter((t) => git(['merge-base', '--is-ancestor', t, base], { allowFail: true }).status !== 0)

  const localRefs = git(['branch', '--format=%(refname:short)']).out.split('\n').filter(Boolean)
  const remoteRefs = git(['branch', '-r', '--format=%(refname:short)']).out.split('\n').filter((r) => r && !r.includes('HEAD'))
  const refs = [...new Set([...localRefs, ...remoteRefs])].filter((r) => {
    const name = r.replace(/^origin\//, '')
    return r !== 'origin' && name !== 'main' && !name.startsWith('release/')
  })

  // 同一个 tip 只算一次（本地分支与其 origin/ 副本通常指向同一提交）
  const bySha = new Map()
  for (const ref of refs) {
    const sha = git(['rev-parse', '--verify', ref], { allowFail: true }).out
    if (!sha) continue
    if (!bySha.has(sha)) bySha.set(sha, [])
    bySha.get(sha).push(ref)
  }

  const rows = []
  for (const [sha, names] of bySha) {
    // 一次 spawn 同时拿 ahead/behind：`base...sha` 的 left=base 独有（behind），right=分支独有（ahead）
    const lr = git(['rev-list', '--left-right', '--count', `${base}...${sha}`], { allowFail: true }).out.split(/\s+/)
    const behind = Number(lr[0] || 0)
    const ahead = Number(lr[1] || 0)
    const ct = git(['log', '-1', '--format=%ct', sha], { allowFail: true }).out
    let duplicateRatio = 0
    if (!noPatch && ahead > 0 && ahead <= maxPatch) {
      const ids = [...patchIds([`${base}..${sha}`]).values()]
      duplicateRatio = ids.length ? ids.filter((id) => baseIds.has(id)).length / ids.length : 0
    }
    rows.push({
      sha: sha.slice(0, 8),
      refs: names,
      ahead,
      behind,
      duplicateRatio: Number(duplicateRatio.toFixed(2)),
      lastCommitAt: ct ? Number(ct) * 1000 : 0,
      kind: rankBranch({ ahead, duplicateRatio, lastCommitAt: ct ? Number(ct) * 1000 : 0 }, { staleDays: days }),
    })
  }

  const kinds = ['merged', 'duplicate', 'stale', 'active']
  const summary = {
    base,
    at: new Date().toISOString(),
    tags: { total: tags.length, offMain: offMainTags },
    branches: Object.fromEntries(kinds.map((k) => [k, rows.filter((r) => r.kind === k).flatMap((r) => r.refs)])),
    rows: rows.sort((a, b) => b.ahead - a.ahead),
  }

  if (json) {
    console.log(JSON.stringify(summary, null, 2))
    return
  }

  console.log(`基线 ${base}  标签 ${tags.length} 个（${offMainTags.length} 个不在 main 上）  分支 ${refs.length} 个 / 唯一 tip ${rows.length} 个\n`)
  if (offMainTags.length) {
    console.log(`标签不在 main 上（发布完整性问题，禁止再新增）：\n  ${offMainTags.join('\n  ')}\n`)
  }
  const label = {
    merged: '可删（0 领先）',
    duplicate: '重复补丁（内容已在 main，仅剩提交壳）',
    stale: `陈旧（有独有提交，>${days} 天未动）`,
    active: '活跃（本版应归并到唯一的版本分支）',
  }
  for (const kind of kinds) {
    const group = rows.filter((r) => r.kind === kind)
    if (!group.length) continue
    console.log(`${label[kind]}：${group.reduce((n, r) => n + r.refs.length, 0)} 个引用`)
    for (const r of group) {
      console.log(`  ${r.refs.join(' , ').padEnd(52)} ahead=${String(r.ahead).padStart(3)} behind=${String(r.behind).padStart(3)} dup=${r.duplicateRatio} sha=${r.sha}`)
    }
    console.log('')
  }
  console.log('建议动作（本工具不会执行）：')
  console.log('  merged    → git branch -d <ref> && git push origin --delete <ref>')
  console.log('  duplicate → 逐条 diff 确认内容已在 main 后删除；不要 rebase 到 main 再推，否则重复历史翻倍')
  console.log('  stale     → 打 archive/<ref> 标签后删除，或写进 docs/DUP-HISTORY-CLEANUP-v3.0.8.md 的保留清单')
  console.log('  active    → 归并到当前版本的唯一分支；一个版本只允许一个活跃分支')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
