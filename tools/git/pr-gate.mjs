// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/git/pr-gate.mjs — PR 结构门禁（版本阶梯 / 线性历史 / 路径 / 提交信息 / SPDX / 证据）。
//
// 设计原则：这个文件是「可执行的规范」。README 里写的规则，若不能在此失败，就等于没有。
// 用法：
//   node tools/git/pr-gate.mjs                      # 本地：对 origin/main...HEAD 跑全部检查
//   node tools/git/pr-gate.mjs --base origin/main --json
//   PR_TITLE="feat(v3.0.8): branch spike" node tools/git/pr-gate.mjs
//
// 退出码：0 全绿 / 1 有失败 / 2 用法错误。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export const REQUIRED_PR_TYPES = ['feat', 'fix', 'chore', 'docs', 'test', 'refactor', 'perf', 'build', 'ci', 'revert']

// PR 不允许触碰的路径（商业层/产物/运行数据）。--allow-path 可放行单个前缀，需在 PR 里说明理由。
export const FORBIDDEN_PREFIXES = ['dist/', 'node_modules/', 'relay-server/', 'enterprise/', '.secrets/']
export const FORBIDDEN_SUFFIXES = ['.jsonl']
export const CODE_EXT = ['.mjs', '.js', '.cjs', '.ts', '.tsx']

export function parseSemver (s = '') {
  const m = String(s).match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), raw: s }
}

export const cmp = (a, b) => (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch)

/** 版本步进分类：same / patch / minor / major / skip（跳号）/ backwards（回退）。 */
export function classifyStep (fromRaw, toRaw) {
  const from = typeof fromRaw === 'string' ? parseSemver(fromRaw) : fromRaw
  const to = typeof toRaw === 'string' ? parseSemver(toRaw) : toRaw
  if (!from || !to) return { kind: 'invalid' }
  if (cmp(to, from) === 0) return { kind: 'same' }
  if (cmp(to, from) < 0) return { kind: 'backwards' }
  if (to.major === from.major && to.minor === from.minor && to.patch === from.patch + 1) return { kind: 'patch' }
  if (to.major === from.major && to.minor === from.minor + 1 && to.patch === 0) return { kind: 'minor' }
  if (to.major === from.major + 1 && to.minor === 0 && to.patch === 0) return { kind: 'major' }
  return { kind: 'skip' }
}

/** 提交主题：type(vX.Y.Z)!: 摘要 —— scope 必须是本版本的 x.y.z。 */
export function parseSubject (subject = '') {
  const m = String(subject).match(/^([a-z]+)(?:\(([^)]*)\))?(!)?:\s+(.+)$/)
  if (!m) return { ok: false, type: '', scope: '', version: '', summary: '' }
  const type = m[1]
  const scope = (m[2] || '').trim()
  const version = /^v\d+\.\d+\.\d+$/.test(scope) ? scope.slice(1) : ''
  return { ok: REQUIRED_PR_TYPES.includes(type), type, scope, version, summary: m[4] }
}

// 纯基础设施改动（不改变发布物）的路径：版本号检查按“同一版本”放行。
export const INFRA_PREFIXES = ['.github/', 'docs/', 'tools/git/', 'tools/release/', '.githooks/', 'test/']

export function isInfraOnly (changed = []) {
  return changed.length > 0 && changed.every((c) => INFRA_PREFIXES.some((p) => c.file.startsWith(p)))
}

export function isForbiddenPath (rel, allowPaths = []) {
  if (allowPaths.some((p) => rel === p || rel.startsWith(p.endsWith('/') ? p : `${p}/`))) return false
  if (FORBIDDEN_PREFIXES.some((p) => rel.startsWith(p))) return true
  return FORBIDDEN_SUFFIXES.some((s) => rel.endsWith(s))
}

function git (args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`)
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

function read (rel) {
  const p = path.join(ROOT, rel)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

/**
 * The range whose commit subjects the gate reads. GitHub checks a pull request
 * out at its synthetic merge commit by default; that commit's subject is the
 * platform's "Merge <head> into <base>" text, not a change the PR authored.
 * Unwrap it to the PR head so linear-history and conventional-commit checks see
 * the commits the author actually wrote.
 * @param {object} facts base ref, its resolved SHA, HEAD's parent list, HEAD subject.
 * @returns {{range: string, head: string}} git log range and the diff head.
 */
export function resolveSubjectRange ({ base = 'origin/main', baseSha = '', baseExists = false, headParents = [], headSubject = '' } = {}) {
  const syntheticMerge = baseExists && headParents.length === 3 && headParents[1] === baseSha &&
    /^Merge [0-9a-f]{7,40} into [0-9a-f]{7,40}$/.test(String(headSubject))
  if (syntheticMerge) return { range: `${base}..${headParents[2]}`, head: headParents[2] }
  return { range: baseExists ? `${base}..HEAD` : 'HEAD', head: 'HEAD' }
}

export function collectFacts ({ base = 'origin/main' } = {}) {
  const pkg = JSON.parse(read('package.json') || '{}')
  const kernel = read('src/kernel/types.mjs')
  const version = String(pkg.version || '')
  const kernelVersion = (kernel.match(/FANG_VERSION\s*=\s*'([^']+)'/) || [])[1] || ''
  const changelog = read('docs/CHANGELOG.md')
  const baseExists = git(['rev-parse', '--verify', base], { allowFail: true }).status === 0
  const baseSha = baseExists ? git(['rev-parse', base], { allowFail: true }).out : ''
  const headParents = git(['rev-list', '--parents', '-n', '1', 'HEAD'], { allowFail: true }).out.split(/\s+/).filter(Boolean)
  const headSubject = git(['log', '-1', '--format=%s', 'HEAD'], { allowFail: true }).out
  const { range, head } = resolveSubjectRange({ base, baseSha, baseExists, headParents, headSubject })
  const subjects = git(['log', '--format=%s', range], { allowFail: true }).out.split('\n').filter(Boolean)
  const merges = git(['log', '--merges', '--format=%h', range], { allowFail: true }).out.split('\n').filter(Boolean)
  const changed = git(['diff', '--name-status', baseExists ? `${base}...${head}` : 'HEAD'], { allowFail: true })
    .out.split('\n').filter(Boolean).map((line) => {
      const [status, ...rest] = line.split('\t')
      return { status: status[0], file: rest.join('\t') }
    })
  const latestTagAll = git(['tag', '--list', 'v*', '--sort=-version:refname'], { allowFail: true }).out.split('\n').filter(Boolean)[0] || ''
  const latestTag = latestTagAll || git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', baseExists ? base : 'HEAD'], { allowFail: true }).out
  const tagExists = version ? git(['rev-parse', '--verify', `refs/tags/v${version}`], { allowFail: true }).status === 0 : false
  return { pkg, version, kernelVersion, changelog, subjects, merges, changed, latestTag, tagExists, base, baseExists }
}

export function runChecks (facts, { prTitle = '', allowPaths = [], reconcile = false, onMainPush = false } = {}) {
  const checks = []
  const add = (id, ok, detail = '') => checks.push({ id, ok: !!ok, detail })
  const v = parseSemver(facts.version)
  const changelogHeading = facts.version && facts.changelog.includes(`## v${facts.version}`)
  const infraOnly = isInfraOnly(facts.changed)

  add('version: 语义化版本', !!v, facts.version || '(missing)')
  add('version: kernel FANG_VERSION 一致', !!v && facts.kernelVersion === facts.version, `${facts.kernelVersion || '(missing)'} vs ${facts.version}`)
  add('version: CHANGELOG 有本节', !!changelogHeading, `## v${facts.version}`)
  add('version: 版本号尚未打标签', !!v && (!facts.tagExists || reconcile || infraOnly || onMainPush), facts.tagExists
    ? (onMainPush
        ? `v${facts.version} 已存在（main 后置检查：发布后版本号已打标属正常）`
        : reconcile || infraOnly
          ? `v${facts.version} 已存在（${reconcile ? '主干回收' : '纯基础设施'} PR：不产生新发布物）`
          : `v${facts.version} 已存在（已发布？改用下一个补丁版本）`)
    : 'new')

  const latest = facts.latestTag ? facts.latestTag.replace(/^v/, '') : ''
  const step = latest ? classifyStep(latest, facts.version) : { kind: 'patch' }
  const waiver = facts.version
    ? fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => /^RELEASE-WAIVER-.*\.md$/.test(f))
        .some((f) => read(`docs/${f}`).includes(`v${facts.version}`))
    : false
  const stepOk = reconcile
    ? step.kind === 'same'
    : ['patch', 'minor', 'major'].includes(step.kind) ||
      (step.kind === 'same' && (!facts.tagExists || infraOnly || onMainPush)) ||
      (step.kind === 'skip' && waiver)
  add('version: 版本阶梯（跳号需 waiver）', !!latest ? stepOk : true,
    latest ? `${latest} → ${facts.version} = ${step.kind}${reconcile ? '（reconcile）' : ''}${onMainPush && step.kind === 'same' ? '（main 后置检查）' : ''}${step.kind === 'skip' && waiver ? '（有 waiver）' : ''}` : '首个版本')

  const auditExists = !!facts.version && fs.existsSync(path.join(ROOT, `docs/AUDIT-v${facts.version}.md`))
  add('docs: AUDIT-v<版本>.md 存在', auditExists, `docs/AUDIT-v${facts.version}.md`)

  const badPaths = facts.changed.filter((c) => isForbiddenPath(c.file, allowPaths))
  add('diff: 不含产物/商业层/运行数据', badPaths.length === 0, badPaths.map((c) => `${c.status} ${c.file}`).join(', ') || 'clean')

  add('history: 无 merge 提交（线性）', facts.merges.length === 0, facts.merges.join(', ') || 'linear')

  const badSubjects = facts.subjects.filter((s) => !parseSubject(s).ok)
  add('commits: conventional 提交', badSubjects.length === 0, badSubjects.slice(0, 3).join(' | ') || `${facts.subjects.length} commits`)

  const scopedOk = facts.subjects.every((s) => {
    const p = parseSubject(s)
    return !p.version || p.version === facts.version
  })
  add('commits: scope 版本与本版一致', scopedOk, scopedOk ? facts.version : '存在 scope 指向旧/新版本')

  const titleParsed = parseSubject(prTitle)
  const titleOk = !prTitle || (titleParsed.ok && titleParsed.version === facts.version)
  add('pr: 标题 = type(v<版本>): 摘要', titleOk, prTitle || '(本地运行，跳过)')

  const missingSpdx = facts.changed
    .filter((c) => c.status === 'A' && CODE_EXT.includes(path.extname(c.file)))
    .filter((c) => !/SPDX-License-Identifier/.test(read(c.file).split('\n').slice(0, 3).join('\n')))
  add('license: 新增代码文件带 SPDX', missingSpdx.length === 0, missingSpdx.map((c) => c.file).join(', ') || 'ok')

  return checks
}

function main () {
  const argv = process.argv.slice(2)
  const get = (n, d = '') => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
  const json = argv.includes('--json')
  const allowPaths = argv.reduce((acc, a, i) => (a === '--allow-path' ? [...acc, argv[i + 1]] : acc), [])
  const base = get('--base', process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/main')
  const prTitle = get('--title', process.env.PR_TITLE || '')
  const reconcile = argv.includes('--reconcile') || /^chore\(v\d+\.\d+\.\d+\):\s*主干回收/.test(prTitle)
  // push 到 main 是发布后的后置检查：版本号已经打标/阶梯持平都是正常状态。
  const onMainPush = process.env.GITHUB_EVENT_NAME === 'push' && process.env.GITHUB_REF === 'refs/heads/main'

  let facts
  try {
    facts = collectFacts({ base })
  } catch (e) {
    console.error(`FAIL 无法读取仓库事实：${e.message}`)
    process.exitCode = 2
    return
  }

  const checks = runChecks(facts, { prTitle, allowPaths, reconcile, onMainPush })
  const green = checks.every((c) => c.ok)
  if (json) {
    console.log(JSON.stringify({ green, version: facts.version, base: facts.base, latestTag: facts.latestTag, checks }, null, 2))
  } else {
    for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(36)} ${c.detail}`)
    console.log(`\n${green ? 'GREEN' : 'RED'}  pr-gate  v${facts.version}  (base=${facts.base}, latest=${facts.latestTag || 'none'})`)
  }
  process.exitCode = green ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
