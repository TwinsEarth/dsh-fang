// SPDX-License-Identifier: AGPL-3.0-or-later
// test/git-workflow-tools.test.mjs — 发布工作流工具的自证测试（guard / pr-gate / version-cut / verify-release）。
// 这些工具是「规则的可执行化」，它们自己必须被测：规则失效比没有规则更危险。
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseAllow, isAllowed, evaluatePush, isProtectedRef } from '../tools/git/guard-main.mjs'
import { classifyStep, parseSubject, isForbiddenPath, parseSemver, runChecks as runPrChecks, resolveSubjectRange } from '../tools/git/pr-gate.mjs'
import { planCut, insertChangelogSection, changelogHasSection, auditStub } from '../tools/git/version-cut.mjs'
import { runChecks, sha256File } from '../tools/git/verify-release.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const SHA = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)
const ZERO = '0'.repeat(40)

test('guard: 解析授权必须是 ref@完整sha，垃圾条目一律丢弃', () => {
  assert.deepEqual(parseAllow(''), [])
  assert.deepEqual(parseAllow('refs/heads/main@' + SHA), [{ ref: 'refs/heads/main', sha: SHA }])
  assert.deepEqual(parseAllow('not-a-ref@' + SHA), [])
  assert.equal(isAllowed(parseAllow('refs/heads/main@' + SHA), 'refs/heads/main', SHA), true)
  assert.equal(isAllowed(parseAllow('refs/heads/main@' + SHA), 'refs/heads/main', SHA2), false)
  assert.equal(isAllowed(parseAllow('refs/heads/main@' + SHA), 'refs/heads/main', 'abc'), false)
})

test('guard: 普通分支放行，受保护分支/标签/删除按规则拒绝', () => {
  assert.equal(isProtectedRef('refs/heads/main'), true)
  assert.equal(isProtectedRef('refs/heads/release/v3.1'), true)
  assert.equal(isProtectedRef('refs/heads/feat/x'), false)

  assert.equal(evaluatePush({ ref: 'refs/heads/feat/v3.0.8-x', localSha: SHA, remoteSha: ZERO }).ok, true)
  assert.equal(evaluatePush({ ref: 'refs/heads/main', localSha: SHA, remoteSha: ZERO }).ok, false)
  assert.equal(evaluatePush({ ref: 'refs/heads/main', localSha: SHA, remoteSha: ZERO, allowed: parseAllow('refs/heads/main@' + SHA) }).ok, true)
  assert.equal(evaluatePush({ ref: 'refs/heads/main', localSha: SHA, remoteSha: SHA2, isAncestor: false }).code, 3)
  assert.equal(evaluatePush({ ref: 'refs/heads/main', localSha: ZERO, remoteSha: SHA }).code, 5)
  assert.equal(evaluatePush({ ref: 'refs/tags/v3.0.8', localSha: SHA, remoteSha: ZERO, onMain: true }).ok, true)
  assert.equal(evaluatePush({ ref: 'refs/tags/v3.0.8', localSha: SHA, remoteSha: ZERO, onMain: false }).code, 4)
  assert.equal(evaluatePush({ ref: 'refs/tags/v3.0.8', localSha: SHA, remoteSha: SHA2 }).code, 4)
  assert.equal(evaluatePush({ ref: 'refs/tags/v3.0.8', localSha: ZERO, remoteSha: SHA }).code, 5)
})

test('guard CLI: 直推 main 退出码非 0，且给出可执行的替代路径', () => {
  const r = spawnSync(process.execPath, ['tools/git/guard-main.mjs', 'check', '--ref', 'refs/heads/main', '--local', SHA, '--remote', ZERO], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 3)
  assert.match(r.stderr, /DENY/)
  assert.match(r.stderr, /feat\//)
})

test('pr-gate: 版本阶梯只允许 +1，跳号/回退可识别', () => {
  assert.deepEqual(parseSemver('3.0.8'), { major: 3, minor: 0, patch: 8, raw: '3.0.8' })
  assert.equal(classifyStep('3.0.7', '3.0.8').kind, 'patch')
  assert.equal(classifyStep('3.0.7', '3.1.0').kind, 'minor')
  assert.equal(classifyStep('3.0.7', '4.0.0').kind, 'major')
  assert.equal(classifyStep('3.0.7', '3.0.10').kind, 'skip')
  assert.equal(classifyStep('3.0.7', '3.0.7').kind, 'same')
  assert.equal(classifyStep('3.0.7', '2.9.9').kind, 'backwards')
})

test('pr-gate: PR 标题与提交主题必须是 type(vX.Y.Z): 摘要', () => {
  assert.equal(parseSubject('feat(v3.0.8): 分支 spike').version, '3.0.8')
  assert.equal(parseSubject('fix(v3.0.10): 指针对齐').ok, true)
  assert.equal(parseSubject('feat: 没写版本').ok, true)
  assert.equal(parseSubject('feat: 没写版本').version, '')
  assert.equal(parseSubject('Feat(v3.0.8): 大写类型').ok, false)
  assert.equal(parseSubject('随便写写').ok, false)
})

test('pr-gate: GitHub PR 合成 merge ref 解包为真实 PR 提交', () => {
  const merged = resolveSubjectRange({
    base: 'origin/main', baseSha: SHA, baseExists: true,
    headParents: [SHA2, SHA, SHA2], headSubject: `Merge ${SHA2} into ${SHA}`,
  })
  assert.equal(merged.head, SHA2)
  assert.equal(merged.range, `origin/main..${SHA2}`)
  const normal = resolveSubjectRange({ base: 'origin/main', baseSha: SHA, baseExists: true, headParents: [SHA2, SHA], headSubject: 'fix(v3.0.10): x' })
  assert.equal(normal.head, 'HEAD')
  assert.equal(normal.range, 'origin/main..HEAD')
  const noBase = resolveSubjectRange({ base: 'origin/main', baseExists: false, headParents: [], headSubject: '' })
  assert.equal(noBase.range, 'HEAD')
})

test('pr-gate: 产物/商业层/运行数据路径默认禁止，可显式放行', () => {
  assert.equal(isForbiddenPath('dist/dsh-fang-3.0.8.tgz'), true)
  assert.equal(isForbiddenPath('relay-server/index.mjs'), true)
  assert.equal(isForbiddenPath('enterprise/README.md'), true)
  assert.equal(isForbiddenPath('audit.jsonl'), true)
  assert.equal(isForbiddenPath('src/lib/essence.mjs'), false)
  assert.equal(isForbiddenPath('dist/keep.tgz', ['dist/keep.tgz']), false)
})

test('version-cut: 跳号必须带 waiver，patch 步进可用，CHANGELOG 段不重复', () => {
  const pkg = '{\n  "name": "dsh-fang",\n  "version": "3.0.7",\n  "license": "AGPL-3.0-or-later"\n}\n'
  const kernel = "export const FANG_VERSION = '3.0.7'\n"
  const changelog = '# CHANGELOG\n\n## v3.0.7（2026-11-03）\n内容\n'

  const skip = planCut({ target: '3.0.10', latestTag: 'v3.0.7', pkgText: pkg, kernelText: kernel, changelog, date: '2026-11-05' })
  assert.equal(skip.ok, false)
  assert.match(skip.error, /跳号/)

  const waived = planCut({ target: '3.0.10', latestTag: 'v3.0.7', pkgText: pkg, kernelText: kernel, changelog, date: '2026-11-05', waiver: true })
  assert.equal(waived.ok, true)

  const cut = planCut({ target: '3.0.8', latestTag: 'v3.0.7', pkgText: pkg, kernelText: kernel, changelog, date: '2026-11-05', theme: '分支 spike' })
  assert.equal(cut.ok, true)
  assert.match(cut.files['package.json'], /"version": "3\.0\.8"/)
  assert.match(cut.files['src/kernel/types.mjs'], /FANG_VERSION = '3\.0\.8'/)
  assert.equal(changelogHasSection(cut.files['docs/CHANGELOG.md'], '3.0.8'), true)
  assert.match(cut.files['dist'] || Object.keys(cut.files).join(','), /docs\/AUDIT-v3\.0\.8\.md/)

  const twice = planCut({ target: '3.0.8', latestTag: 'v3.0.7', pkgText: pkg, kernelText: kernel, changelog: cut.files['docs/CHANGELOG.md'], date: '2026-11-05' })
  assert.equal(twice.ok, false)
})

test('version-cut: 新段插在旧段之前，且保留文件头', () => {
  const out = insertChangelogSection('# CHANGELOG\n\n## v3.0.7（2026-11-03）\n旧\n', '3.0.8', '2026-11-05', '新')
  assert.match(out, /^# CHANGELOG\n\n## v3\.0\.8/)
  assert.match(out, /## v3\.0\.7/)
  assert.equal(out.indexOf('## v3.0.8') < out.indexOf('## v3.0.7'), true)
  assert.match(auditStub('3.0.8', '2026-11-05', 'v3.0.7'), /# AUDIT v3\.0\.8/)
})

test('pr-gate: 主干回收 PR 允许复用已发布版本号（唯一例外）', () => {
  const facts = {
    version: '3.0.7', kernelVersion: '3.0.7', changelog: '## v3.0.7\n', latestTag: 'v3.0.7', tagExists: true,
    subjects: [], merges: [], changed: [], base: 'origin/main', baseExists: true, pkg: {},
  }
  const normal = runPrChecks(facts, { prTitle: 'chore(v3.0.7): 主干回收' })
  assert.equal(normal.some((c) => c.id.includes('版本号尚未打标签') && c.ok), false)
  const reconcile = runPrChecks(facts, { prTitle: 'chore(v3.0.7): 主干回收', reconcile: true })
  assert.equal(reconcile.some((c) => c.id.includes('版本号尚未打标签') && c.ok), true)
  assert.equal(reconcile.some((c) => c.id.includes('版本阶梯') && c.ok), true)
})

test('pr-gate: 纯基础设施 PR 不产生发布物，允许版本号已打标签', () => {
  const base = {
    version: '3.0.7', kernelVersion: '3.0.7', changelog: '## v3.0.7\n', latestTag: 'v3.0.7', tagExists: true,
    subjects: [], merges: [], changed: [{ status: 'A', file: 'tools/git/guard-main.mjs' }, { status: 'M', file: 'docs/CHANGELOG.md' }],
    base: 'origin/main', baseExists: true, pkg: {},
  }
  const infra = runPrChecks(base, { prTitle: 'ci(v3.0.7): 发布工作流落地' })
  assert.equal(infra.some((c) => c.id.includes('版本号尚未打标签') && c.ok), true)
  assert.equal(infra.some((c) => c.id.includes('版本阶梯') && c.ok), true)
  const shipped = runPrChecks({ ...base, changed: [{ status: 'M', file: 'src/lib/essence.mjs' }] }, { prTitle: 'feat(v3.0.7): 改产品代码' })
  assert.equal(shipped.some((c) => c.id.includes('版本号尚未打标签') && !c.ok), true)
})

test('verify-release: tag 不在 main 上 / 无 e2e / 无证据 一律判红', () => {
  const facts = {
    tag: 'v3.0.8', version: '3.0.8', tagSha: SHA, annotated: true, onMain: false,
    previous: 'v3.0.7', merges: [], pkgVersion: '3.0.8', kernelVersion: '3.0.8',
    changelogHeading: true, auditExists: true,
    preflight: { green: true, version: '3.0.8', tests: { pass: 680, fail: 0 }, e2e: null },
  }
  const checks = runChecks(facts, { requireArtifact: false })
  const failed = checks.filter((c) => !c.ok).map((c) => c.id)
  assert.ok(failed.some((id) => id.includes('first-parent')))
  assert.ok(failed.some((id) => id.includes('e2e')))
  assert.equal(checks.every((c) => typeof c.ok === 'boolean'), true)
})

test('verify-release: sha256 计算与 sidecar 比对口径一致', () => {
  const file = path.join(ROOT, 'package.json')
  const digest = sha256File(file)
  assert.match(digest, /^[0-9a-f]{64}$/)
})
