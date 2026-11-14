// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// v3.3.0 主城门禁（main-city gate）
// ------------------------------------------------------------
// 目标：任何「进主城」的动作（打包、发布、安装、部署、新建 profile）都必须先过
// 同一套可复核的检查；拿不到证据时 fail-closed，而不是静默放行。
//
// 设计约束：
//   * 纯本地、只读优先：默认不写 profile、不联网、不改产物。
//   * 产物校验以 sha256/manifest 为准；profile 校验以「不越界 + 可解析 + 不覆盖」为准。
//   * 崩溃循环 / 安全模式 / 审计链断裂 = blocker：系统级故障不能靠重试绕过。
//   * 需要写盘的两个例外都显式开关：--repair 建 profile 备份；--create 新建 profile。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { parseYamlSubset } from './rule-registry.mjs'
import { appendChained, verifyChain } from '../kernel/ledger.mjs'
import { scoreGateFindings } from '../plugins/scorer.mjs'
import { gateRepairPlan } from '../plugins/healer.mjs'
import { CRASH_LOOP_DEFAULTS, detectCrashLoop } from './restart-contract.mjs'

export const GATE_TARGETS = Object.freeze(['source', 'package', 'publish', 'install', 'deploy', 'workflows', 'profile'])
export const GATE_SEVERITIES = Object.freeze(['blocker', 'warning', 'info'])
export const DEFAULT_MIN_FREE_BYTES = 512 * 1024 * 1024
export const RESERVED_PROFILE_NAMES = Object.freeze(['desktop', 'plugin'])
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

const REQUIRED_SOURCE_FILES = Object.freeze([
  'package.json',
  'client.js',
  'cordis.patch.yml',
  'src/index.mjs',
  'src/lib/boot-guard.mjs',
  'src/lib/fork-supervisor.mjs',
  'src/lib/restart-contract.mjs',
  'src/lib/main-gate.mjs',
  'src/plugins/restart-guard.mjs',
  'src/plugins/scorer.mjs',
  'src/plugins/approver.mjs',
  'src/plugins/auditor.mjs',
  'src/plugins/healer.mjs',
  'tools/gate/main-city.mjs',
  'tools/release/build.mjs',
  'tools/release/preflight.mjs',
  'docs/CRASH-SAFETY.md',
  'docs/MAIN-CITY-GATE.md',
  'docs/DSH-ARCHITECTURE-MAP.md',
])

const REQUIRED_ARTIFACT_FILES = Object.freeze([
  'package.json',
  'client.js',
  'cordis.patch.yml',
  'src/index.mjs',
  'src/lib/boot-guard.mjs',
  'src/lib/main-gate.mjs',
  'src/plugins/restart-guard.mjs',
  'tools/gate/main-city.mjs',
])

const SECRET_PATTERNS = Object.freeze([
  { id: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { id: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { id: 'openai-key', re: /sk-[A-Za-z0-9]{20,}/ },
  { id: 'pem-private-key', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
])

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')
export const sha256File = (file) => sha256(fs.readFileSync(file))

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function isInside(parent, child) {
  const p = path.resolve(String(parent ?? ''))
  const c = path.resolve(String(child ?? ''))
  const rel = path.relative(p, c)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function readTextSafe(file, fallback = '') {
  try { return fs.readFileSync(file, 'utf8') } catch { return fallback }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

function diskFree(dir) {
  try {
    const stat = fs.statfsSync(dir)
    return Number(stat.bavail) * Number(stat.bsize)
  } catch { return null }
}

function addCheck(checks, id, ok, severity, detail, repair = '') {
  const level = ok ? 'info' : severity
  checks.push({ id, ok: !!ok, severity: level, detail: String(detail ?? ''), ...(repair ? { repair } : {}) })
}

function fail(checks, id, detail, repair = '') {
  addCheck(checks, id, false, 'blocker', detail, repair)
}

function warn(checks, id, detail, repair = '') {
  addCheck(checks, id, false, 'warning', detail, repair)
}

function pass(checks, id, detail = '') {
  addCheck(checks, id, true, 'info', detail)
}

function walkFiles(dir, rel = '', out = [], limit = 5000) {
  if (out.length >= limit) return out
  let entries = []
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (out.length >= limit) break
    const child = rel ? path.join(rel, entry.name) : entry.name
    if (entry.isDirectory()) walkFiles(dir, child, out, limit)
    else if (entry.isFile()) out.push(child)
  }
  return out
}

/** 源码树：版本、文档、vendored 契约、关键防线文件、危险默认值。 */
export function checkSourceTree({ root = process.cwd(), version = '' } = {}) {
  const checks = []
  const base = path.resolve(root)
  const pkg = readJsonSafe(path.join(base, 'package.json'))
  const declared = String(pkg?.version ?? version ?? '').trim()
  if (!/^\d+\.\d+\.\d+$/.test(declared)) fail(checks, 'source: semver', declared || '(missing)')
  else pass(checks, 'source: semver', declared)
  if (version && declared !== version) fail(checks, 'source: version matches requested', `${declared} != ${version}`)
  else pass(checks, 'source: version matches requested', declared)

  const kernel = readTextSafe(path.join(base, 'src/kernel/types.mjs'))
  addCheck(checks, 'source: kernel FANG_VERSION', kernel.includes(`FANG_VERSION = '${declared}'`), 'blocker', declared)
  addCheck(checks, 'source: CHANGELOG section', readTextSafe(path.join(base, 'docs/CHANGELOG.md')).includes(`## v${declared}`), 'blocker', `## v${declared}`)
  addCheck(checks, 'source: AUDIT file', fs.existsSync(path.join(base, `docs/AUDIT-v${declared}.md`)), 'blocker', `docs/AUDIT-v${declared}.md`)

  const missing = REQUIRED_SOURCE_FILES.filter((rel) => !fs.existsSync(path.join(base, rel)))
  addCheck(checks, 'source: required guard files', missing.length === 0, 'blocker', missing.length ? `missing=${missing.join(',')}` : `${REQUIRED_SOURCE_FILES.length} files`, missing.length ? 'restore the missing guard files before packaging' : '')

  const patch = parseYamlSubset(readTextSafe(path.join(base, 'cordis.patch.yml')))
  addCheck(checks, 'source: bundle patch parses', patch.errors.length === 0, 'blocker', patch.errors[0] ?? 'ok')

  const restart = readTextSafe(path.join(base, 'src/plugins/restart-guard.mjs'))
  addCheck(checks, 'source: restart default observe', restart.includes("mode: 'observe'"), 'blocker', 'mode default must stay observe')
  addCheck(checks, 'source: process restart disarmed by default', restart.includes('allowProcessRestart: false'), 'blocker', 'allowProcessRestart default must stay false')
  addCheck(checks, 'source: crash-loop breaker present', restart.includes('crash-loop') && restart.includes('clearSafeMode'), 'blocker', 'restart-guard crash-loop breaker')
  addCheck(checks, 'source: gate wired into build', readTextSafe(path.join(base, 'tools/release/build.mjs')).includes('main-city.mjs'), 'blocker', 'build must call the gate')
  addCheck(checks, 'source: gate wired into publish', readTextSafe(path.join(base, 'tools/release/publish-npm.mjs')).includes('main-city.mjs'), 'blocker', 'publish must call the gate')
  const workflows = checkWorkflows({ root: base })
  checks.push(...workflows.checks)

  const vendor = readJsonSafe(path.join(base, 'src/contract/VENDOR.json'))
  if (!vendor) fail(checks, 'source: vendored contract manifest', 'src/contract/VENDOR.json missing', 're-sync contract from npm')
  else {
    const drifted = []
    for (const [name, expected] of Object.entries(vendor.sha256 ?? {})) {
      const file = path.join(base, 'src/contract', name)
      try { if (sha256File(file) !== expected) drifted.push(name) } catch { drifted.push(name + ':missing') }
    }
    addCheck(checks, 'source: vendored contract bytes', drifted.length === 0, 'blocker', drifted.length ? `drift=${drifted.join(',')}` : `${Object.keys(vendor.sha256 ?? {}).length} files @ ${vendor.version}`)
  }

  const secretHits = []
  for (const rel of walkFiles(base, 'src').slice(0, 2000)) {
    const text = readTextSafe(path.join(base, rel))
    for (const pattern of SECRET_PATTERNS) if (pattern.re.test(text)) secretHits.push(`${rel}:${pattern.id}`)
  }
  addCheck(checks, 'source: no hardcoded secrets', secretHits.length === 0, 'blocker', secretHits.length ? secretHits.slice(0, 5).join(',') : 'clean')

  return { target: 'source', checks, version: declared }
}

/**
 * v3.3.1：第七类目标 workflows —— CI/发布工作流本身的审计。
 * 工作流是「谁能发布、能写什么」的执行入口；它被改坏时，源码门禁可能完全绕过。
 */
export function checkWorkflows({ root = process.cwd() } = {}) {
  const checks = []
  const base = path.resolve(String(root))
  const dir = path.join(base, '.github/workflows')
  const required = ['ci.yml', 'release.yml']
  const missing = required.filter((name) => !fs.existsSync(path.join(dir, name)))
  addCheck(checks, 'workflows: required files', missing.length === 0, 'blocker', missing.length ? `missing=${missing.join(',')}` : 'ci.yml + release.yml', 'restore the CI/release workflows from the repository history')

  const files = []
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) files.push(path.join(dir, entry.name))
    }
  } catch { /* missing dir already reported */ }
  addCheck(checks, 'workflows: files discoverable', files.length >= required.length, 'blocker', `${files.length} files`)

  for (const file of files) {
    const name = path.basename(file)
    const text = readTextSafe(file)
    if (!text.trim()) { fail(checks, `workflows: ${name} not empty`, 'empty workflow'); continue }
    addCheck(checks, `workflows: ${name} has on/jobs`, /^on:/m.test(text) && /^jobs:/m.test(text), 'blocker', name)
    addCheck(checks, `workflows: ${name} no pull_request_target`, !/pull_request_target/.test(text), 'blocker', name, 'pull_request_target exposes secrets to fork PRs; use pull_request with explicit env passing')
    addCheck(checks, `workflows: ${name} no write-all`, !/permissions:\s*write-all/.test(text), 'blocker', name, 'grant the narrowest permission per job')
    addCheck(checks, `workflows: ${name} no secrets inherit`, !/secrets:\s*inherit/.test(text), 'blocker', name, 'map only the secrets a job needs')
    const unsafeInterpolation = text.split(/\r?\n/).some((line) => /\$\{\{\s*github\.event\.pull_request\.(title|body|head\.ref)\s*\}\}/.test(line) && !/^\s*[A-Z][A-Z0-9_]*:\s*\$\{\{/.test(line) && !/^\s*#/.test(line))
    addCheck(checks, `workflows: ${name} no untrusted title interpolation`, !unsafeInterpolation, 'blocker', name, 'pass PR fields through env:, never interpolate them into run:')
    addCheck(checks, `workflows: ${name} has job timeouts`, /timeout-minutes:/m.test(text), 'warning', name, 'add timeout-minutes to every job so a stuck runner cannot hang the release')
  }

  const ci = readTextSafe(path.join(dir, 'ci.yml'))
  addCheck(checks, 'workflows: ci runs main-city source gate', ci.includes('tools/gate/main-city.mjs') && ci.includes('--target'), 'blocker', 'ci.yml', 'add the main-city source/workflows gate before tests')
  addCheck(checks, 'workflows: ci runs full test suite', /node --test/.test(ci), 'blocker', 'ci.yml')
  addCheck(checks, 'workflows: ci matrix 22+24', /node:\s*\[?[^\n]*22/.test(ci) && /node:\s*\[?[^\n]*24/.test(ci), 'warning', 'ci.yml', 'test both supported Node versions')
  const release = readTextSafe(path.join(dir, 'release.yml'))
  addCheck(checks, 'workflows: release runs main-city gate', release.includes('tools/gate/main-city.mjs'), 'blocker', 'release.yml', 'add the source gate to the release guard job')
  addCheck(checks, 'workflows: release builds via gated build.mjs', release.includes('tools/release/build.mjs'), 'blocker', 'release.yml', 'release must use build.mjs (it runs package/publish gates)')
  addCheck(checks, 'workflows: release grants contents write only where needed', release.includes('permissions:') && !/permissions:\s*write-all/.test(release), 'warning', 'release.yml')
  return { checks, files: files.map((file) => path.basename(file)) }
}

function checkStagedPackage({ packageDir, version }) {
  const checks = []
  const dir = path.resolve(String(packageDir ?? ''))
  const pkg = readJsonSafe(path.join(dir, 'package.json'))
  if (!pkg) { fail(checks, 'package: staged package.json', dir); return { checks, pkg: null } }
  pass(checks, 'package: staged package.json', `${pkg.name ?? '?'}@${pkg.version ?? '?'}`)
  addCheck(checks, 'package: name', pkg.name === '@twinsearth/dsh-fang', 'blocker', String(pkg.name))
  addCheck(checks, 'package: version', !version || pkg.version === version, 'blocker', `${pkg.version}${version ? ' vs ' + version : ''}`)
  addCheck(checks, 'package: not private', pkg.private !== true, 'blocker', String(pkg.private))
  addCheck(checks, 'package: client half', pkg.dsh?.client?.platform === 'web', 'blocker', JSON.stringify(pkg.dsh?.client ?? null))
  const bundlePatch = String(pkg.dsh?.bundle?.patch ?? '').trim()
  addCheck(checks, 'package: bundle manifest', bundlePatch.length > 0, 'blocker', bundlePatch || 'missing dsh.bundle.patch')
  if (bundlePatch) addCheck(checks, 'package: bundle file', fs.existsSync(path.join(dir, bundlePatch)), 'blocker', bundlePatch)
  const missing = REQUIRED_ARTIFACT_FILES.filter((rel) => !fs.existsSync(path.join(dir, rel)))
  addCheck(checks, 'package: required artifact files', missing.length === 0, 'blocker', missing.length ? `missing=${missing.join(',')}` : `${REQUIRED_ARTIFACT_FILES.length} files`)
  return { checks, pkg }
}

function checkTarball({ distDir, version, tarball, manifest }) {
  const checks = []
  const dist = path.resolve(String(distDir ?? 'dist'))
  let doc = manifest ?? readJsonSafe(path.join(dist, 'manifest.json'))
  if (!doc) { fail(checks, 'artifact: manifest', 'dist/manifest.json missing', 'run build first'); return { checks, manifest: null, tarballPath: null } }
  pass(checks, 'artifact: manifest', `${doc.name}@${doc.version}`)
  addCheck(checks, 'artifact: manifest name', doc.name === '@twinsearth/dsh-fang', 'blocker', String(doc.name))
  addCheck(checks, 'artifact: manifest version', !version || doc.version === version, 'blocker', `${doc.version}${version ? ' vs ' + version : ''}`)
  const tgz = tarball ? path.resolve(tarball) : path.join(dist, path.basename(String(doc.tarball ?? '')))
  if (!fs.existsSync(tgz)) { fail(checks, 'artifact: tarball exists', tgz, 'rebuild the artifact'); return { checks, manifest: doc, tarballPath: tgz } }
  const actual = sha256File(tgz)
  addCheck(checks, 'artifact: tarball sha256', actual === doc.sha256, 'blocker', actual.slice(0, 16))
  const sidecar = `${tgz}.sha256`
  if (!fs.existsSync(sidecar)) warn(checks, 'artifact: sha256 sidecar', 'missing sidecar', 'rebuild writes the sidecar')
  else {
    const expected = readTextSafe(sidecar).trim().split(/\s+/)[0]
    addCheck(checks, 'artifact: sha256 sidecar', expected === actual, 'blocker', expected ? expected.slice(0, 16) : 'empty')
  }
  const files = Array.isArray(doc.files) ? doc.files : []
  addCheck(checks, 'artifact: file list present', files.length > 0, 'blocker', `${files.length} entries`)
  const bad = files.filter((rel) => /^package\/(dist|node_modules|\.git|\.env)/.test(rel) || /\.pem$|npm-token|gh-master-token/i.test(rel))
  addCheck(checks, 'artifact: no forbidden entries', bad.length === 0, 'blocker', bad.length ? bad.slice(0, 5).join(',') : 'clean')
  const missing = REQUIRED_ARTIFACT_FILES.map((rel) => `package/${rel}`).filter((rel) => !files.includes(rel))
  addCheck(checks, 'artifact: required files inside tarball', missing.length === 0, 'blocker', missing.length ? `missing=${missing.join(',')}` : `${REQUIRED_ARTIFACT_FILES.length} files`)
  return { checks, manifest: doc, tarballPath: tgz }
}

function checkProfile({ homeDir, profile, profileDir }) {
  const checks = []
  const home = path.resolve(String(homeDir ?? ''))
  const name = String(profile ?? path.basename(path.resolve(String(profileDir ?? '')))).trim()
  const dir = path.resolve(String(profileDir ?? path.join(home, 'profiles', name)))
  if (!home) fail(checks, 'profile: home required', home, 'pass --home')
  addCheck(checks, 'profile: name format', PROFILE_NAME_RE.test(name), 'blocker', name)
  addCheck(checks, 'profile: reserved name', !RESERVED_PROFILE_NAMES.includes(name), 'blocker', name)
  addCheck(checks, 'profile: inside home/profiles', isInside(path.join(home, 'profiles'), dir), 'blocker', dir, 'refuse paths outside $DSH_HOME/profiles')
  if (!fs.existsSync(dir)) {
    warn(checks, 'profile: profile directory', `not created yet: ${dir}`, 'create it through the gate (--create)')
    return { checks, dir, name, exists: false, pkg: null }
  }
  const pkg = readJsonSafe(path.join(dir, 'package.json'))
  if (!pkg) fail(checks, 'profile: package.json', dir)
  else {
    pass(checks, 'profile: package.json', pkg.name ?? name)
    const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles.map(String) : null
    if (!bundles) fail(checks, 'profile: bundles array', JSON.stringify(pkg?.dsh?.profile ?? null))
    else {
      const dup = bundles.filter((id, index) => bundles.indexOf(id) !== index)
      addCheck(checks, 'profile: no duplicate bundles', dup.length === 0, 'blocker', dup.length ? dup.join(',') : `${bundles.length} bundles`)
    }
  }
  const patchFile = path.join(dir, 'cordis.patch.yml')
  if (!fs.existsSync(patchFile)) warn(checks, 'profile: patch file', 'cordis.patch.yml missing', 'profile may still boot; create an empty [] patch')
  else {
    const text = readTextSafe(patchFile)
    // 空 patch 的合法形式：空文件、`[]`（DSH 模板常见）。
    const empty = text.trim() === '' || text.trim() === '[]' || text.trim() === '{}'
    if (empty) pass(checks, 'profile: patch parses', 'empty patch')
    else {
      const parsed = parseYamlSubset(text)
      addCheck(checks, 'profile: patch parses', parsed.errors.length === 0, 'blocker', parsed.errors[0] ?? 'ok')
    }
  }
  const backup = fs.existsSync(dir) && fs.readdirSync(dir).some((file) => /^package\.json\.bak-|^cordis\.patch\.yml\.bak-|^\.gate-backups$/.test(file))
  addCheck(checks, 'profile: backup available', backup, 'warning', backup ? 'present' : 'none', 'run gate --repair to create a backup before changing this profile')
  return { checks, dir, name, exists: true, pkg, backup }
}

function checkRuntimeGuards({ homeDir, profile }) {
  const checks = []
  const home = path.resolve(String(homeDir ?? ''))
  const dataDir = path.join(home, 'fang', String(profile ?? ''))
  const pidFile = path.join(dataDir, 'fang.pid')
  const pidDoc = readJsonSafe(pidFile)
  const live = pidDoc && pidAlive(Number(pidDoc.pid))
  addCheck(checks, 'runtime: no live host on this profile', !live, 'blocker', live ? `pid=${pidDoc.pid} is alive` : 'no live fang.pid', 'fully exit the DSH client before install/deploy')
  const safeFile = path.join(dataDir, 'restart/safe-mode.json')
  const safe = readJsonSafe(safeFile)
  addCheck(checks, 'runtime: restart safe-mode clear', !(safe && safe.active === true), 'blocker', safe?.active === true ? `${safe.reason ?? 'active'} at ${safe.at ?? '?'}` : 'clear', 'clear it only after investigating crashes: fangctl restart-safe clear --by <you>')
  const crashFile = path.join(dataDir, 'restart/runtime-crash.jsonl')
  const crash = fs.existsSync(crashFile) ? detectCrashLoop(readTextSafe(crashFile), { windowMs: CRASH_LOOP_DEFAULTS.windowMs, threshold: CRASH_LOOP_DEFAULTS.threshold }) : { active: false, count: 0 }
  addCheck(checks, 'runtime: no active crash loop', crash.active !== true, 'blocker', crash.active ? `${crash.count} crashes in ${crash.windowMs}ms` : `count=${crash.count}`, 'inspect runtime-crash.jsonl and restart-guard safe mode; do not redeploy blindly')
  const auditFile = path.join(dataDir, 'audit.jsonl')
  if (fs.existsSync(auditFile)) {
    const chain = verifyChain(auditFile)
    addCheck(checks, 'audit: hash chain verifies', chain.ok === true, 'blocker', chain.ok ? `records=${chain.count}` : `${chain.reason}@${chain.badIndex}`, 'do not append/deploy on a broken audit chain; restore the ledger from backup and investigate')
  } else {
    pass(checks, 'audit: hash chain verifies', 'no ledger yet (first install)')
  }
  const ledger = path.join(home, 'audit.jsonl')
  if (fs.existsSync(ledger) && ledger !== auditFile) {
    const chain = verifyChain(ledger)
    addCheck(checks, 'audit: home ledger verifies', chain.ok === true, 'blocker', chain.ok ? `records=${chain.count}` : `${chain.reason}@${chain.badIndex}`)
  }
  return { checks, dataDir }
}

function checkDiskSpace({ homeDir, minFreeBytes = DEFAULT_MIN_FREE_BYTES }) {
  const checks = []
  const target = path.resolve(String(homeDir ?? ''))
  let dir = target
  while (dir && !fs.existsSync(dir)) dir = path.dirname(dir)
  const free = diskFree(dir)
  if (free === null) warn(checks, 'disk: free space available', 'statfs unavailable', 'verify free space manually')
  else addCheck(checks, 'disk: free space available', free >= minFreeBytes, 'blocker', `${(free / 1024 / 1024).toFixed(0)} MiB free (need ${(minFreeBytes / 1024 / 1024).toFixed(0)} MiB)`, 'free disk space before creating profiles / installing artifacts')
  return { checks, free }
}

function checkPublishMetadata({ version, tag, npmLatest, allowExisting }) {
  const checks = []
  addCheck(checks, 'publish: version present', /^\d+\.\d+\.\d+$/.test(String(version ?? '')), 'blocker', String(version ?? ''))
  if (tag !== undefined && String(tag).trim() !== '') {
    addCheck(checks, 'publish: tag matches version', String(tag).trim() === `v${version}`, 'blocker', `${tag} vs v${version}`, 'create the annotated tag from the same version')
  } else {
    warn(checks, 'publish: tag provided', 'no tag supplied; CI tag/version check is skipped', 'pass --tag v<version> in release workflows')
  }
  if (npmLatest !== undefined && npmLatest !== null && String(npmLatest).trim() !== '') {
    const existing = String(npmLatest).trim()
    const equal = existing === String(version)
    addCheck(checks, 'publish: registry version not already used', allowExisting === true || !equal, 'blocker', equal ? `npm latest already ${existing}` : `npm latest ${existing}`, 'bump the version; never overwrite an already published version')
  } else {
    pass(checks, 'publish: registry version not already used', 'not checked (no --npm-latest)')
  }
  return { checks }
}

function aggregate(target, checks, extra = {}) {
  const blockers = checks.filter((item) => item.severity === 'blocker' && item.ok === false)
  const warnings = checks.filter((item) => item.severity === 'warning' && item.ok === false)
  const infos = checks.filter((item) => item.severity === 'info' && item.ok === true)
  const score = scoreGateFindings(checks.map((item) => ({ severity: item.ok ? 'info' : item.severity })))
  // 修复建议由 healer 统一给出（未知 blocker 也回落到 fail-closed 提示）。
  const healerHints = new Map(gateRepairPlan(checks.map((item) => ({ ...item }))).map((item) => [item.id, item.hint]))
  const repair = checks
    .filter((item) => item.ok === false)
    .map((item) => ({ id: item.id, hint: item.repair || healerHints.get(item.id) || 'inspect the gate report; do not bypass' }))
  return {
    ok: blockers.length === 0,
    target,
    at: new Date().toISOString(),
    summary: { blockers: blockers.length, warnings: warnings.length, infos: infos.length, checks: checks.length },
    score,
    blockers: blockers.map((item) => ({ id: item.id, detail: item.detail })),
    warnings: warnings.map((item) => ({ id: item.id, detail: item.detail })),
    repair,
    checks,
    ...extra,
  }
}

/** 主入口：按 target 聚合检查。缺参数时 fail-closed，不猜。 */
export function runMainGate(options = {}) {
  const target = String(options.target ?? 'package').trim()
  if (!GATE_TARGETS.includes(target)) {
    return aggregate(target, [{ id: 'gate: target', ok: false, severity: 'blocker', detail: `unknown target ${target}` }])
  }
  const checks = []
  let version = String(options.version ?? '').trim()
  if (!version) version = String(readJsonSafe(path.join(path.resolve(String(options.root ?? process.cwd())), 'package.json'))?.version ?? '')
  let dataDir = String(options.dataDir ?? '').trim()
  if (!dataDir && options.homeDir && options.profile) dataDir = path.join(path.resolve(String(options.homeDir)), 'fang', String(options.profile))

  if (target === 'source') {
    const out = checkSourceTree({ root: options.root ?? process.cwd(), version })
    checks.push(...out.checks)
    version = out.version
  }
  if (target === 'package' || target === 'publish' || target === 'install' || target === 'deploy') {
    if (options.packageDir) {
      const out = checkStagedPackage({ packageDir: options.packageDir, version })
      checks.push(...out.checks)
    } else if (target === 'package' || target === 'publish') {
      fail(checks, 'package: staged package directory', 'missing --package-dir', 'run build and pass dist/npm/package')
    }
    if (target === 'package' || target === 'publish') {
      const out = checkTarball({ distDir: options.distDir ?? 'dist', version, tarball: options.tarball, manifest: options.manifest })
      checks.push(...out.checks)
    }
  }
  if (target === 'workflows') {
    const out = checkWorkflows({ root: options.root ?? process.cwd() })
    checks.push(...out.checks)
  }
  if (target === 'publish') {
    const out = checkPublishMetadata({ version, tag: options.tag, npmLatest: options.npmLatest, allowExisting: options.allowExisting === true })
    checks.push(...out.checks)
  }
  if (target === 'install' || target === 'deploy' || target === 'profile') {
    if (!options.homeDir) fail(checks, 'profile: home required', 'missing --home', 'pass the DSH_HOME that owns the profile')
    if (!options.profile) fail(checks, 'profile: name required', 'missing --profile', 'pass the profile name')
    if (options.homeDir && options.profile) {
      const out = checkProfile({ homeDir: options.homeDir, profile: options.profile, profileDir: options.profileDir })
      checks.push(...out.checks)
      if (out.exists && !out.backup && options.repair === true) {
        const backup = createProfileBackup(out.dir)
        addCheck(checks, 'profile: backup created by repair', backup.ok === true, 'blocker', backup.ok ? backup.dir : backup.error, 'repair could not create a backup')
      }
      if (out.exists && !out.backup && options.requireBackup === true && options.repair !== true) {
        fail(checks, 'profile: backup required before deploy', out.dir, 'run gate --repair (or make a .bak copy) before deploy')
      }
      const guards = checkRuntimeGuards({ homeDir: options.homeDir, profile: options.profile })
      checks.push(...guards.checks)
      const disk = checkDiskSpace({ homeDir: options.homeDir, minFreeBytes: options.minFreeBytes })
      checks.push(...disk.checks)
    }
  }
  if (target === 'deploy') {
    if (options.supervisorPresent !== true) {
      warn(checks, 'deploy: external supervisor', 'no live supervisor marker supplied', 'start restart-watchdog --execute if unattended restart is required')
    } else pass(checks, 'deploy: external supervisor', 'present')
  }
  if (target === 'profile' && options.create === true) {
    const home = path.resolve(String(options.homeDir ?? ''))
    const name = String(options.profile ?? '')
    const dir = path.join(home, 'profiles', name)
    if (!PROFILE_NAME_RE.test(name)) fail(checks, 'profile-create: name', name, 'use lowercase letters/digits/hyphens, 1-63 chars')
    if (RESERVED_PROFILE_NAMES.includes(name)) fail(checks, 'profile-create: reserved', name, 'desktop/plugin are reserved')
    if (!isInside(path.join(home, 'profiles'), dir)) fail(checks, 'profile-create: inside home/profiles', dir)
    if (fs.existsSync(dir) && options.force !== true) fail(checks, 'profile-create: does not exist', dir, 'use --force only after a verified backup')
    if (fs.existsSync(dir) && options.force === true) warn(checks, 'profile-create: overwrite requested', dir, 'existing profile will be replaced; backup is mandatory')
    const disk = checkDiskSpace({ homeDir: home, minFreeBytes: options.minFreeBytes })
    checks.push(...disk.checks)
  }

  const report = aggregate(target, checks, { version, dataDir: dataDir || null })
  if (dataDir && (target === 'install' || target === 'deploy' || target === 'publish')) {
    const audit = recordGateDecision({ dataDir, target, report, actor: options.actor })
    report.audit = audit
    if (audit.ok === false && audit.reason === 'chain-broken') {
      report.ok = false
      report.blockers.push({ id: 'audit: append gate record', detail: 'hash chain broken; refusing to append a gate record' })
    }
  }
  return report
}

/** 在 profile 目录写 .gate-backups/<stamp>/（只复制配置，不动 node_modules/会话）。 */
export function createProfileBackup(profileDir) {
  const dir = path.resolve(String(profileDir ?? ''))
  if (!fs.existsSync(dir)) return { ok: false, error: 'profile-missing', dir }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(dir, '.gate-backups', stamp)
  try {
    fs.mkdirSync(target, { recursive: true })
    const copied = []
    for (const name of ['package.json', 'cordis.patch.yml', 'cordis.yml']) {
      const from = path.join(dir, name)
      if (!fs.existsSync(from)) continue
      fs.copyFileSync(from, path.join(target, name))
      copied.push(name)
    }
    fs.writeFileSync(path.join(target, 'MANIFEST.json'), JSON.stringify({ at: new Date().toISOString(), profileDir: dir, copied }, null, 2), 'utf8')
    return { ok: true, dir: target, copied }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), dir: target }
  }
}

/** 把门禁结论写进链式审计；没有 dataDir 时跳过。链坏了拒绝追加，避免洗白。 */
export function recordGateDecision({ dataDir, target, report, actor = '' } = {}) {
  if (!dataDir) return { ok: false, skipped: true, reason: 'no-data-dir' }
  const ledger = path.join(String(dataDir), 'audit.jsonl')
  try {
    fs.mkdirSync(String(dataDir), { recursive: true })
    if (fs.existsSync(ledger)) {
      const chain = verifyChain(ledger)
      if (!chain.ok) return { ok: false, skipped: true, reason: 'chain-broken', chain }
    }
    const record = appendChained(ledger, {
      kind: 'main-city-gate',
      target,
      ok: report?.ok === true,
      version: report?.version ?? null,
      blockers: report?.blockers?.map((item) => item.id).slice(0, 20) ?? [],
      warnings: report?.warnings?.map((item) => item.id).slice(0, 20) ?? [],
      grade: report?.score?.grade ?? null,
      actor: String(actor ?? '').slice(0, 200) || null,
      at: new Date().toISOString(),
    })
    return { ok: true, ledger, record }
  } catch (error) {
    return { ok: false, skipped: true, reason: 'append-failed', error: String(error?.message ?? error) }
  }
}

/** 把 blocker 汇总成可直接打在 CI/终端上的一行（不隐藏原因）。 */
export function formatGateFailure(report) {
  const blockers = report?.blockers ?? []
  if (!blockers.length) return 'gate GREEN'
  return blockers.map((item) => `${item.id}: ${item.detail}`).join(' | ')
}

export const DEFAULT_PROFILE_BUNDLES = Object.freeze([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@twinsearth/dsh-fang',
])

/**
 * 通过门禁后真正创建一个新 profile（唯一允许的写路径）。
 * 再次校验名称/路径/存在性，避免调用方跳过 gate 直接调用。
 */
export function createGatedProfile({ homeDir, profile, bundles = DEFAULT_PROFILE_BUNDLES, force = false, minFreeBytes = DEFAULT_MIN_FREE_BYTES } = {}) {
  const home = path.resolve(String(homeDir ?? ''))
  const name = String(profile ?? '').trim()
  if (!home) return { ok: false, error: 'home-required' }
  if (!PROFILE_NAME_RE.test(name)) return { ok: false, error: 'profile-name-invalid', detail: name }
  if (RESERVED_PROFILE_NAMES.includes(name)) return { ok: false, error: 'profile-name-reserved', detail: name }
  const dir = path.join(home, 'profiles', name)
  if (!isInside(path.join(home, 'profiles'), dir)) return { ok: false, error: 'profile-path-escape', detail: dir }
  if (fs.existsSync(dir) && force !== true) return { ok: false, error: 'profile-exists', detail: dir }
  const free = diskFree(home)
  if (free !== null && free < minFreeBytes) return { ok: false, error: 'disk-low', detail: `${free} < ${minFreeBytes}` }
  const list = (Array.isArray(bundles) ? bundles : DEFAULT_PROFILE_BUNDLES).map(String).filter(Boolean)
  if (!list.length || new Set(list).size !== list.length) return { ok: false, error: 'bundles-invalid' }
  try {
    fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
    if (fs.existsSync(dir) && force === true) {
      const backup = createProfileBackup(dir)
      if (!backup.ok) return { ok: false, error: 'backup-failed', detail: backup.error }
    }
    fs.mkdirSync(dir, { recursive: true })
    const pkg = { name: `dsh-profile-${name}`, private: true, dsh: { profile: { bundles: list } } }
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    const patch = path.join(dir, 'cordis.patch.yml')
    if (!fs.existsSync(patch)) fs.writeFileSync(patch, '[]\n', 'utf8')
    return { ok: true, dir, profile: name, bundles: list }
  } catch (error) {
    return { ok: false, error: 'create-failed', detail: String(error?.message ?? error), dir }
  }
}

export const _internals = { checkSourceTree, checkStagedPackage, checkTarball, checkProfile, checkRuntimeGuards, checkPublishMetadata, checkWorkflows, isInside, pidAlive, diskFree }
