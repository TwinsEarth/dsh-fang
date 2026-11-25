// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/git/guard-main.mjs — 「绝不未经允许推送 main」的可执行闸门（零第三方依赖）。
//
// 三处调用：
//   1) .githooks/pre-push           —— 本地拦截（core.hooksPath=.githooks）
//   2) CI release 的 guard job      —— 远端复核（tag 必须落在 main 的 first-parent 上）
//   3) 人工审计：node tools/git/guard-main.mjs audit
//
// 授权模型：不是布尔开关，而是「ref@完整 sha」的显式粘贴式授权。
//   FANG_ALLOW_PROTECTED_PUSH="refs/heads/main@<40位sha>,refs/heads/release/v3.1@<40位sha>"
//   为什么必须是 sha：防止「以为在推 A、实际推了 B」——授权只对那一刻那个提交生效。
//
// 退出码：0 允许 / 3 受保护分支 / 4 tag 改写 / 5 删除 / 6 用法错误。
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const PROTECTED_HEAD = 'refs/heads/main'
export const PROTECTED_PREFIXES = ['refs/heads/release/']
export const ZERO_SHA = /^0+$/

/** 半开区间：受保护分支判定（main 与 release/*；hotfix/* 不受保护，PR 后即删）。 */
export function isProtectedRef (ref = '') {
  if (ref === PROTECTED_HEAD) return true
  return PROTECTED_PREFIXES.some((p) => ref.startsWith(p))
}

/** 解析 FANG_ALLOW_PROTECTED_PUSH；解析不了的条目一律丢弃（fail-closed）。 */
export function parseAllow (raw = '') {
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.lastIndexOf('@')
      if (at <= 0) return { ref: entry, sha: '' }
      return { ref: entry.slice(0, at).trim(), sha: entry.slice(at + 1).trim().toLowerCase() }
    })
    .filter((e) => e.ref.startsWith('refs/'))
}

export function isAllowed (allowed, ref, sha) {
  const s = String(sha || '').toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(s)) return false
  return allowed.some((e) => e.ref === ref && e.sha === s)
}

/**
 * 纯函数：给出一个 ref 更新的判定。
 * isAncestor：remoteSha 是 localSha 的祖先（false 且 remoteSha 非零 = 非快进/强推）
 * onMain    ：localSha 可达 main（tag 必须满足）
 */
export function evaluatePush ({ ref, localSha = '', remoteSha = '', allowed = [], isAncestor = true, onMain = true, tagMoveAllowed = false }) {
  const local = String(localSha || '').toLowerCase()
  const remote = String(remoteSha || '').toLowerCase()
  const isHead = ref.startsWith('refs/heads/')
  const isTag = ref.startsWith('refs/tags/')
  if (!isHead && !isTag) return { ok: true, code: 0, title: '非分支/标签引用，交由服务器策略', detail: '' }

  const deleting = ZERO_SHA.test(local)

  if (deleting) {
    if (isProtectedRef(ref)) return { ok: false, code: 5, title: '拒绝删除受保护分支', detail: ref }
    if (isTag) return { ok: false, code: 5, title: '拒绝删除标签（已发布标签只可 deprecate，不可删）', detail: ref }
    return { ok: true, code: 0, title: '删除普通分支，允许', detail: ref }
  }

  if (isTag) {
    if (!ZERO_SHA.test(remote) && remote !== local && !tagMoveAllowed) {
      return {
        ok: false,
        code: 4,
        title: '拒绝改写已存在的标签',
        detail: `${ref} 远端=${remote.slice(0, 8)} 本地=${local.slice(0, 8)}；发布用下一个补丁版本，不要移动历史`,
      }
    }
    if (/^v\d+\.\d+\.\d+$/.test(ref.replace('refs/tags/', '')) && !onMain) {
      return { ok: false, code: 4, title: '拒绝在非 main 提交上打版本标签', detail: `${ref} 必须指向 main 的 first-parent 提交（v3.0.7 的教训）` }
    }
    return { ok: true, code: 0, title: '标签推送允许', detail: ref }
  }

  if (isProtectedRef(ref)) {
    if (!ZERO_SHA.test(remote) && isAncestor === false) {
      return { ok: false, code: 3, title: '拒绝对受保护分支强推（History 不可改写）', detail: ref }
    }
    if (!isAllowed(allowed, ref, local)) {
      return { ok: false, code: 3, title: '拒绝直接推送受保护分支', detail: `${ref}@${local.slice(0, 8)}` }
    }
    return { ok: true, code: 0, title: '维护者已按 ref@sha 显式授权本次推送', detail: `${ref}@${local.slice(0, 8)}` }
  }

  return { ok: true, code: 0, title: '普通分支推送允许', detail: ref }
}

function git (args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

function revParse (rev) {
  const r = git(['rev-parse', '--verify', `${rev}^{commit}`])
  return r.status === 0 ? r.out : ''
}

function isAncestorOf (ancestor, descendant) {
  if (!ancestor || !descendant) return false
  return git(['merge-base', '--is-ancestor', ancestor, descendant]).status === 0
}

function onFirstParentOfMain (sha) {
  const main = revParse('main') || revParse('origin/main')
  if (!main || !sha) return false
  const chain = git(['rev-list', '--first-parent', main])
  if (chain.status !== 0) return false
  return chain.out.split('\n').includes(sha)
}

function printDenied (verdict, ref, local) {
  const lines = [
    '',
    `DENY  ${verdict.title}`,
    `      ${verdict.detail}`,
    '',
    '本仓库规则：agent 只推 feat/*、fix/*、hotfix/* 分支；main 只经 PR（squash）进入。',
    '',
    '安全替代路径：',
    '  1) 推工作分支并开 PR：',
    '       git push -u origin feat/v3.0.8-<slug>',
    '  2) 维护者确认要直推时，粘贴「ref@完整sha」授权后重试：',
    `       $env:FANG_ALLOW_PROTECTED_PUSH = "${ref}@${local}"`,
    '       git push origin main',
    '  3) 若已误推：不要强推覆盖，按 docs/RELEASE-FLOW-v3.0.8-v3.3.3.md §7 回滚（revert + 新补丁版本）。',
    '',
  ]
  console.error(lines.join('\n'))
}

function cmdCheck (argv) {
  const get = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : ''
  }
  const ref = get('--ref')
  const local = (get('--local') || '').trim().toLowerCase()
  const remote = (get('--remote') || '').trim().toLowerCase()
  if (!ref || !/^[0-9a-f]{40}$|^0+$/.test(local)) {
    console.error('usage: node tools/git/guard-main.mjs check --ref <refs/heads/x> --local <sha> --remote <sha>')
    return 6
  }
  const allowed = parseAllow(process.env.FANG_ALLOW_PROTECTED_PUSH || '')
  const tagMoveAllowed = process.env.FANG_ALLOW_TAG_MOVE === '1'
  // v3.1.17：版本 tag 可能是 annotated（local 是 tag 对象），先 peel 到 commit 再判断。
  const isVersionTag = /^refs\/tags\/v\d+\.\d+\.\d+$/.test(ref)
  const commitSha = isVersionTag ? (revParse(local) || local) : local
  const isAncestor = ZERO_SHA.test(remote) ? true : isAncestorOf(remote, commitSha)
  const onMain = ZERO_SHA.test(local) ? false : (isAncestorOf(commitSha, 'main') ? onFirstParentOfMain(commitSha) : false)

  const verdict = evaluatePush({ ref, localSha: local, remoteSha: remote, allowed, isAncestor, onMain, tagMoveAllowed })
  if (!verdict.ok) {
    printDenied(verdict, ref, local)
    return verdict.code || 3
  }
  console.error(`ALLOW ${verdict.title}  ${verdict.detail}`)
  return 0
}

function cmdAudit () {
  const main = revParse('main')
  const originMain = revParse('origin/main')
  const head = revParse('HEAD')
  const rows = [
    ['local main', main ? main.slice(0, 8) : '(missing)'],
    ['origin/main', originMain ? originMain.slice(0, 8) : '(missing, run git fetch)'],
    ['HEAD', head ? head.slice(0, 8) : '(missing)'],
    ['main == origin/main', main && main === originMain ? 'yes' : 'NO — 先 git switch main && git pull --ff-only'],
    ['HEAD on main', head && main && isAncestorOf(head, main) ? 'yes' : 'no (工作分支，正常)'],
  ]
  for (const [k, v] of rows) console.log(`${k.padEnd(20)} ${v}`)
  const behind = main && originMain ? git(['rev-list', '--count', `main..origin/main`]).out : '?'
  const ahead = main && originMain ? git(['rev-list', '--count', `origin/main..main`]).out : '?'
  console.log(`${'main 落后/领先'.padEnd(20)} behind=${behind} ahead=${ahead}`)
  return main && originMain && main === originMain ? 0 : 1
}

function main () {
  const argv = process.argv.slice(2)
  const sub = argv[0]
  if (sub === 'check') return cmdCheck(argv)
  if (sub === 'audit') return cmdAudit()
  console.error('usage:')
  console.error('  node tools/git/guard-main.mjs check --ref <ref> --local <sha> --remote <sha>')
  console.error('  node tools/git/guard-main.mjs audit')
  return 6
}

// 只有被直接执行时才跑 CLI（被 test/ 或别的工具 import 时保持纯函数）。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main()
