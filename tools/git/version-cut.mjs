// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/git/version-cut.mjs — 一次把「版本号」在四个地方改到位，并补齐发布证据文件。
//
// 为什么需要它：v3.0.7 之前的版本号散落在 package.json / FANG_VERSION / CHANGELOG / tag 四处，
// 任何一处漏改都会让 preflight 变红（或更糟：绿着发布了错的版本号）。
//
// 用法：
//   node tools/git/version-cut.mjs 3.0.8 --dry-run     # 预演，不写盘
//   node tools/git/version-cut.mjs 3.0.8               # 改 package.json + types.mjs + CHANGELOG + AUDIT
//   node tools/git/version-cut.mjs 3.0.8 --commit      # 改完顺手提交（不 tag；tag 只在 main 上打）
//   node tools/git/version-cut.mjs --check [--version 3.0.8]   # 只校验（PR 门禁用）
//
// 版本阶梯：3.0.7 → 3.0.8 允许；3.0.7 → 3.0.10 属于跳号，需 --waiver（并把豁免写进 docs/RELEASE-WAIVER-*.md）。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseSemver, classifyStep } from './pr-gate.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const write = (rel, text) => fs.writeFileSync(path.join(ROOT, rel), text)
const exists = (rel) => fs.existsSync(path.join(ROOT, rel))

function git (args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`)
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

export function latestReleaseTag (ref = 'origin/main') {
  // 版本阶梯的基线是「已发布的最高版本」，不是「main 上可达的最新 tag」：
  // 历史上 v2.8.3…v3.0.7 都打在分支上，若按 main 取基线会算出错误的跳号。
  const all = git(['tag', '--list', 'v*', '--sort=-version:refname'], { allowFail: true }).out.split('\n').filter(Boolean)
  if (all.length) return all[0]
  for (const r of [ref, 'HEAD', 'main']) {
    const out = git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', r], { allowFail: true })
    if (out.status === 0 && out.out) return out.out
  }
  return ''
}

export function changelogHasSection (changelog, version) {
  return new RegExp(`^## v${version.replace(/\./g, '\\.')}\\b`, 'm').test(changelog)
}

export function insertChangelogSection (changelog, version, date, theme) {
  const idx = changelog.search(/^## v\d/m)
  const body = [
    `## v${version}（${date}）`,
    `**主题：${theme || '（一句话写清这版解决什么问题）'}**`,
    '',
    '### 新增',
    '- ',
    '',
    '### 门禁（发布前必填，来自 dist/preflight.json）',
    '- tests: pass=? fail=0 skip=?',
    '- e2e: ?/?',
    '- routes: ?（allowlist） / plugins: 16',
    '- preflight: GREEN',
    '',
    '### 边界（本版明确不做的事）',
    '- ',
    '',
    '### 回滚锚点',
    `- 升级前快照/上一代目录：active-v${version}-pre（母体）；merged-v${version}-pre（原身）；plugin-snapshot-<ts>（插件层）`,
    '',
    '',
  ].join('\n')
  if (idx < 0) return `${changelog.trimEnd()}\n\n${body}`
  return `${changelog.slice(0, idx)}${body}${changelog.slice(idx)}`
}

export function auditStub (version, date, latestTag) {
  return [
    `# AUDIT v${version}`,
    '',
    `- 日期：${date}`,
    `- 基线：${latestTag || '(初始)'}`,
    `- 目标：v${version}`,
    '',
    '## 范围（本版改了什么，逐项可核对）',
    '- ',
    '',
    '## 验证（粘贴真实数字，不写“已测试”）',
    '- preflight --e2e：GREEN',
    '- 全量测试：pass=? fail=0 skip=?',
    '- e2e：?/?',
    '- 路由契约 / 插件行数：/16',
    '',
    '## 风险与边界',
    '- ',
    '',
    '## 回滚演练',
    '- 触发方式：',
    '- 恢复耗时：',
    '- 证据：dist/preflight.json / tools/e2e.mjs 输出',
    '',
  ].join('\n')
}

export function planCut ({ target, latestTag, pkgText, kernelText, changelog, date, theme, waiver }) {
  const to = parseSemver(target)
  if (!to) return { ok: false, error: `版本号不是 x.y.z：${target}` }
  const fromRaw = (latestTag || '').replace(/^v/, '') || (pkgText.match(/"version"\s*:\s*"([^"]+)"/) || [])[1]
  const step = fromRaw ? classifyStep(fromRaw, target) : { kind: 'patch' }
  if (step.kind === 'backwards') return { ok: false, error: `不能回退版本：${fromRaw} → ${target}` }
  if (step.kind === 'same') return { ok: false, error: `已是 ${target}，无需 cut（改了内容请走下一个补丁版本）` }
  if (step.kind === 'skip' && !waiver) {
    return { ok: false, error: `跳号 ${fromRaw} → ${target}：按 docs/RELEASE-WAIVER-v3.0.7.md 的规则，需 --waiver 并书面记录` }
  }
  if (changelogHasSection(changelog, target)) return { ok: false, error: `CHANGELOG 已有 ## v${target} 段，拒绝重复写入` }
  if (!/"version"\s*:\s*"\d+\.\d+\.\d+"/.test(pkgText)) return { ok: false, error: 'package.json 找不到顶层 version 字段' }
  if (!/FANG_VERSION\s*=\s*'\d+\.\d+\.\d+'/.test(kernelText)) return { ok: false, error: 'src/kernel/types.mjs 找不到 FANG_VERSION' }

  const nextPkg = pkgText.replace(/(^\s{2}"version"\s*:\s*")(\d+\.\d+\.\d+)(")/m, `$1${target}$3`)
  const nextKernel = kernelText.replace(/(FANG_VERSION\s*=\s*')(\d+\.\d+\.\d+)(')/, `$1${target}$3`)
  const nextChangelog = insertChangelogSection(changelog, target, date, theme)

  return {
    ok: true,
    step,
    from: fromRaw,
    files: {
      'package.json': nextPkg,
      'src/kernel/types.mjs': nextKernel,
      'docs/CHANGELOG.md': nextChangelog,
      [`docs/AUDIT-v${target}.md`]: auditStub(target, date, latestTag),
    },
  }
}

export function runCheck (version) {
  const pkg = JSON.parse(read('package.json'))
  const kernel = read('src/kernel/types.mjs')
  const changelog = read('docs/CHANGELOG.md')
  const kernelVersion = (kernel.match(/FANG_VERSION\s*=\s*'([^']+)'/) || [])[1] || ''
  const latest = latestReleaseTag()
  const checks = []
  const add = (id, ok, detail = '') => checks.push({ id, ok: !!ok, detail })
  add('version: package.json', pkg.version === version, `${pkg.version} vs ${version}`)
  add('version: kernel FANG_VERSION', kernelVersion === version, `${kernelVersion || '(missing)'} vs ${version}`)
  add('version: CHANGELOG 段', changelogHasSection(changelog, version), `## v${version}`)
  const latestRaw = latest.replace(/^v/, '')
  const step = latestRaw ? classifyStep(latestRaw, version) : { kind: 'patch' }
  add('version: 阶梯', ['patch', 'minor', 'major', 'same'].includes(step.kind), `${latestRaw || '(none)'} → ${version} = ${step.kind}`)
  return { green: checks.every((c) => c.ok), checks, version, latest }
}

function main () {
  const argv = process.argv.slice(2)
  const flag = (n) => argv.includes(n)
  const opt = (n, d = '') => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
  const target = argv.find((a) => /^\d+\.\d+\.\d+$/.test(a)) || opt('--version', '')
  const json = flag('--json')
  const date = opt('--date', new Date().toISOString().slice(0, 10))
  const dryRun = flag('--dry-run')

  if (flag('--check')) {
    const version = target || JSON.parse(read('package.json')).version
    const r = runCheck(version)
    if (json) console.log(JSON.stringify(r, null, 2))
    else {
      for (const c of r.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(28)} ${c.detail}`)
      console.log(`\n${r.green ? 'GREEN' : 'RED'}  version-cut --check  v${version}（last tag ${r.latest || 'none'}）`)
    }
    process.exitCode = r.green ? 0 : 1
    return
  }

  if (!target) {
    console.error('usage: node tools/git/version-cut.mjs <x.y.z> [--dry-run] [--commit] [--waiver] [--theme "…"]')
    process.exitCode = 2
    return
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out
  if (branch === 'main' && !flag('--allow-main')) {
    console.error('DENY  在 main 上 cut 版本：请先 git switch -c feat/v' + target + '-<slug>（main 只经 PR 变更）')
    process.exitCode = 3
    return
  }
  if (git(['rev-parse', '--verify', `refs/tags/v${target}`], { allowFail: true }).status === 0) {
    console.error(`DENY  tag v${target} 已存在；已发布版本不可重打，改用下一个补丁版本`)
    process.exitCode = 3
    return
  }

  const latestTag = latestReleaseTag()
  const plan = planCut({
    target,
    latestTag,
    pkgText: read('package.json'),
    kernelText: read('src/kernel/types.mjs'),
    changelog: read('docs/CHANGELOG.md'),
    date,
    theme: opt('--theme'),
    waiver: flag('--waiver') || exists(`docs/RELEASE-WAIVER-v${target}.md`),
  })

  if (!plan.ok) {
    console.error(`FAIL  ${plan.error}`)
    process.exitCode = 1
    return
  }

  const summary = { version: target, from: plan.from, step: plan.step.kind, dryRun, files: Object.keys(plan.files) }
  if (json) console.log(JSON.stringify(summary, null, 2))
  else {
    console.log(`version-cut  ${plan.from} → ${target}  (${plan.step.kind}${dryRun ? ', dry-run' : ''})`)
    for (const f of Object.keys(plan.files)) console.log(`  ${dryRun ? 'would write' : 'write'}  ${f}`)
  }
  if (dryRun) return

  for (const [rel, text] of Object.entries(plan.files)) write(rel, text)
  console.log('\n下一步（main 只经 PR 变更；tag 只在合并后的 main 上打）：')
  console.log('  git add -A && git commit -m "chore(v' + target + '): 版本收口（package/FANG_VERSION/CHANGELOG/AUDIT）"')
  console.log('  git fetch origin && git rebase origin/main')
  console.log('  node tools/release/preflight.mjs --e2e')
  console.log('  git push -u origin ' + branch)

  if (flag('--commit')) {
    const add = git(['add', ...Object.keys(plan.files)])
    const commit = git(['commit', '-m', `chore(v${target}): 版本收口（package/FANG_VERSION/CHANGELOG/AUDIT）`], { allowFail: true })
    if (add.status !== 0 || commit.status !== 0) {
      console.error(`FAIL  提交失败：${commit.err || commit.out}`)
      process.exitCode = 1
      return
    }
    console.log(`committed  ${git(['rev-parse', '--short', 'HEAD']).out}`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
