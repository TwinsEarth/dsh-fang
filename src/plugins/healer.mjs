// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang 2.3 修复子插件 — 自检 / 证据 / G1–G12 门禁 / 补丁建议（契约：docs/CONTRACTS.md 5.5）。
//
// 硬边界：**Healer 不放行，也不写盘**。本插件只读取插件目录并产出结构化证据与
// 建议补丁；放行权在 approver（见 CONTRACTS.md §1 硬约束 5）。
//
// 门禁设计原则（移植自 dsh-hot-update/packages/ci-gate）：能确定性判定的才叫门禁；
// 拿不到证据的判 UNKNOWN 并**默认阻断**（fail-closed，可用 Config.blockingOnUnknown 关闭）。
//
// G1–G12 分配（v1.0.0）：
//   G1  manifest 字段          name/version/type=module
//   G2  入口存在               可解析的 entry 文件
//   G3  无 eval/new Function   静态源码扫描
//   G4  无裸 child_process     import 层扫描（局限：不做调用层）
//   G5  依赖 allow-list        dependencies ⊆ { @deepseek-ai/* } ∪ config.allowlist
//   G6  资源闭合               裸定时器必须与 ctx.effect 同时出现（近似判定）
//   G7  豁免诚实性             acceptRisk=true 必须带 {gate,reason} 豁免清单
//   G8  构建脚本闭合           安装期 script 必须列入 dsh.buildApproved
//   G9  秘密卫生               硬编码凭据模式
//   G10 bundle patch 存在      dsh.bundle.patch 声明与文件一致（非 bundle 则 SKIP）
//   G11 激活证据               facts.application === 'applied' 且证据不旧于入口
//   G12 分数可复算             facts.signals/score 重算一致
//     ↑ G11/G12 的 host facts 只在 load 之后才存在：静态预检（stage='load'，默认）按 ci-gate
//       G7 先例判 deferred/SKIP；stage='promote' 时必须给 facts，否则 UNKNOWN 阻断（fail-closed）。
//
// 证据来源：目录读取全部走 node:fs 只读；无任何写操作（suggestFix 也不写）。
import fs from 'node:fs'
import path from 'node:path'
import { SERVICE, AUDIT, z, readJson, listFiles, sha256, exists } from '../kernel/index.mjs'
import { scanSource, importsToSignals } from './imports.mjs'
import { scoreScan, familyOf, entryCandidates, resolvePluginFile } from './scorer.mjs'
import { roleGate } from '../kernel/index.mjs'

export const name = 'fang-healer'
export const inject = []

export const Config = z.object({
  blockingOnUnknown: z.boolean().default(true)
    .description('UNKNOWN 是否阻断（默认 true；关闭后拿不到证据的门禁不阻断），与 ci-gate 语义一致'),
  reservedIds: z.array(z.string()).default([])
    .description('保留插件 id（G5 之外的命名冲突检查；v1.0.0 只记录在 policy）'),
  allowlist: z.array(z.string()).default([])
    .description('额外允许的依赖名（默认放行 @deepseek-ai/*）'),
})

/** 安装期构建脚本（与 ci-gate 一致）。 */
export const BUILD_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']

/** 默认放行的依赖前缀：宿主提供的 @deepseek-ai/* 包。 */
export const DEFAULT_ALLOWLIST_PREFIXES = ['@deepseek-ai/']

/** 硬编码凭据模式（与 ci-gate 一致）。 */
export const SECRET_PATTERNS = [
  { id: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { id: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { id: 'openai-key', re: /sk-[A-Za-z0-9]{20,}/ },
  { id: 'pem-private-key', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: 'slack-token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
]

const CHILD_PROCESS = new Set(['child_process', 'node:child_process'])
const TIMER_RE = /(^|[^.\w$])(setInterval|setTimeout|setImmediate)\s*\(/g
const EVAL_RES = [/(^|[^.\w$])eval\s*\(/g, /\bnew\s+Function\s*\(/g]
const EFFECT_RE = /ctx\.effect\s*\(/
const PROVIDE_RE = /ctx\.provide\s*\(/
const INJECT_RE = /export\s+const\s+inject\s*=\s*(\[[^\]]*\])/

/** v3.3.0：主城门禁 blocker → 可执行的修复动作（只给建议，不写盘）。 */
export const GATE_REPAIR_HINTS = Object.freeze({
  'source: semver': 'fix package.json version to a semver x.y.z',
  'source: kernel FANG_VERSION': 'update src/kernel/types.mjs FANG_VERSION to the package version',
  'source: CHANGELOG section': 'add a "## v<version>" section to docs/CHANGELOG.md',
  'source: AUDIT file': 'add docs/AUDIT-v<version>.md with the release evidence',
  'source: required guard files': 'restore the missing crash-safety files before building',
  'source: vendored contract bytes': 're-sync src/contract from the pinned @twinsearth/dsh-fang-contract version',
  'source: gate wired into build': 'call tools/gate/main-city.mjs from tools/release/build.mjs',
  'source: gate wired into publish': 'call tools/gate/main-city.mjs from tools/release/publish-npm.mjs',
  'package: client half': 'restore dsh.client.platform=web in package.json',
  'package: bundle manifest': 'restore dsh.bundle.patch and the referenced patch file',
  'artifact: tarball sha256': 'rebuild the artifact; never publish a tarball whose sha256 differs from manifest',
  'artifact: sha256 sidecar': 'rebuild so the .sha256 sidecar is regenerated with the tarball',
  'artifact: required files inside tarball': 'add the missing guard/gate files to package.json files and rebuild',
  'publish: tag matches version': 'recreate the annotated tag as v<package version>',
  'publish: registry version not already used': 'bump the version; published versions are immutable',
  'profile: inside home/profiles': 'point --home/--profile at $DSH_HOME/profiles; never write outside it',
  'profile: no duplicate bundles': 'remove duplicate entries from dsh.profile.bundles',
  'profile: patch parses': 'repair cordis.patch.yml indentation or restore the previous patch from .gate-backups',
  'profile: backup available': 'run gate --repair (creates .gate-backups/<stamp>/) before changing the profile',
  'runtime: no live host on this profile': 'fully exit the DSH client before install/deploy',
  'runtime: restart safe-mode clear': 'investigate restart safe-mode; clear only via fangRestart.clearSafeMode({by,note})',
  'runtime: no active crash loop': 'inspect runtime-crash.jsonl and the restart guard; do not redeploy until the loop is understood',
  'audit: hash chain verifies': 'restore audit.jsonl from backup and investigate tampering; never append to a broken chain',
  'disk: free space available': 'free disk space before creating profiles or installing packages',
})

export function gateRepairPlan(findings) {
  return (Array.isArray(findings) ? findings : [])
    .filter((item) => item && item.ok !== true)
    .map((item) => ({
      id: item.id,
      severity: item.severity ?? 'blocker',
      hint: GATE_REPAIR_HINTS[item.id] ?? item.repair ?? 'inspect the gate report and fix the underlying cause; do not bypass',
    }))
}

export const GATE_IDS = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12']

function safeGet(ctx, key) {
  try { return ctx?.get?.(key) } catch { return undefined }
}

function lineOf(src, index) {
  return String(src ?? '').slice(0, index).split('\n').length
}

function findMatches(src, re) {
  const out = []
  if (typeof src !== 'string') return out
  re.lastIndex = 0
  let m
  while ((m = re.exec(src)) !== null) {
    out.push({ index: m.index, line: lineOf(src, m.index), text: m[0] })
    if (m[0].length === 0) re.lastIndex += 1
  }
  return out
}

/** 裸定时器调用点（近似：只看文本，不建 AST）。 */
export function findTimers(src) {
  return findMatches(src, TIMER_RE).map(m => ({ fn: m.text.trim().replace(/\s*\($/, ''), line: m.line }))
}

/** eval()/new Function() 调用点。 */
export function findEvalSites(src) {
  const sites = []
  for (const re of EVAL_RES) {
    for (const m of findMatches(src, re)) sites.push({ line: m.line, text: m.text.trim() })
  }
  return sites.sort((a, b) => a.line - b.line)
}

export function findSecrets(src) {
  const text = typeof src === 'string' ? src : ''
  return SECRET_PATTERNS.filter(p => p.re.test(text)).map(p => p.id)
}

function parseInject(src) {
  const m = INJECT_RE.exec(String(src ?? ''))
  if (!m) return { declared: false, empty: false, raw: null }
  const raw = m[1]
  const empty = raw.replace(/\s+/g, '') === '[]'
  return { declared: true, empty, raw }
}

function depsOf(pkg) {
  const deps = pkg?.dependencies
  return deps && typeof deps === 'object' ? Object.keys(deps) : []
}

function depAllowed(dep, cfg) {
  const name = String(dep)
  if (name.startsWith('node:') || name === 'fs' || name === 'path') return true // 防御性：builtin 不应出现在 dependencies
  if (DEFAULT_ALLOWLIST_PREFIXES.some(p => name.startsWith(p))) return true
  return Array.isArray(cfg.allowlist) && cfg.allowlist.includes(name)
}

/**
 * 读取插件目录模型（只读）。
 * @returns {{abs:string, pkg:object|null, manifest:object|null, entry:object|null, files:string[], scan:object|null}}
 */
export function readModel(dir, opts = {}) {
  const abs = path.resolve(String(dir ?? ''))
  const pkgFile = resolvePluginFile(abs, 'package.json')
  const pkg = pkgFile ? readJson(pkgFile, null) : null
  const manifestFile = opts.manifest === undefined ? resolvePluginFile(abs, 'manifest.json') : null
  const manifest = opts.manifest ?? (manifestFile ? readJson(manifestFile, null) : null)
  let entry = null
  for (const rel of entryCandidates(pkg ?? {}, manifest)) {
    const file = resolvePluginFile(abs, rel)
    if (!file) continue
    try {
      const st = fs.statSync(file)
      if (!st.isFile()) continue
      const src = fs.readFileSync(file, 'utf8')
      entry = { rel, file, src, bytes: st.size, mtimeMs: st.mtimeMs, sha256: sha256(src) }
      break
    } catch { /* 试下一个候选 */ }
  }
  let scan = null
  if (entry) {
    try { scan = scanSource(entry.src) } catch { scan = { imports: [], warnings: [{ reason: 'scan-error' }], error: true } }
  }
  return { abs, pkg, manifest, entry, files: listFiles(abs), scan }
}

/** 目录的静态评分等级（复用 scorer 的同一套数学）。 */
function gradeOfModel(model) {
  if (!model.entry) return { grade: 'E', S: 100, veto: false, degraded: true, reasons: ['no-entry-file'], signals: [] }
  const mapped = importsToSignals(model.scan, model.pkg ?? {})
  const scored = scoreScan(mapped.signals, { ...(model.pkg ?? {}), __parseErrors: (model.scan?.warnings ?? []).length })
  return { ...scored, signals: mapped.signals.map(s => ({ id: s.id, weight: s.weight })) }
}

// ─────────────────────────────── selfCheck ───────────────────────────────

/**
 * 静态自检（契约 5.5）：ctx.effect 包裹 / 依赖 allow-list / inject 最小化 /
 * 无裸定时器 / 入口存在。只读、同步、不写盘。
 */
export function selfCheckOf(model, cfg) {
  const findings = []
  const add = (id, level, message, evidence = null) => findings.push({ id, level, message, evidence })
  const src = model.entry?.src ?? ''
  const effect = EFFECT_RE.test(src)
  const provide = PROVIDE_RE.test(src)

  if (!model.entry) {
    add('entry-missing', 'block', `no resolvable entry file under ${model.abs}`)
  } else {
    add('entry-ok', 'info', `entry=${model.entry.rel}`, { bytes: model.entry.bytes, sha256: model.entry.sha256 })
  }

  if (!model.pkg) {
    add('manifest-missing', 'block', 'package.json missing or unreadable')
  } else {
    const deps = depsOf(model.pkg)
    const bad = deps.filter(d => !depAllowed(d, cfg))
    if (bad.length > 0) {
      add('deps-not-allowed', 'block', `dependencies outside allow-list: ${bad.join(', ')}`, { deps: bad })
    } else {
      add('deps-ok', 'info', deps.length > 0 ? `dependencies allow-listed: ${deps.join(', ')}` : 'no runtime dependencies', { deps })
    }
  }

  if (!effect) add('no-effect-wrap', 'block', 'ctx.effect(...) not found — services/timers must be disposable')
  else add('effect-ok', 'info', 'ctx.effect(...) present')
  if (!provide) add('no-provide', 'block', 'ctx.provide(...) not found — plugin provides no service')

  const inject = parseInject(src)
  if (!inject.declared) add('inject-missing', 'block', 'module must export inject (hard deps only; middle-tier: inject = [])')
  else if (!inject.empty) add('inject-not-minimal', 'warn', `inject is not empty (${inject.raw}) — declare only hard deps`, { inject: inject.raw })
  else add('inject-minimal', 'info', 'inject = []')

  const timers = findTimers(src)
  if (timers.length === 0) add('timer-clean', 'info', 'no bare timers')
  else if (!effect) add('bare-timer', 'block', `timers without any ctx.effect cleanup: ${timers.map(t => `${t.fn}@${t.line}`).join(',')}`, { timers })
  else add('bare-timer-unwrapped', 'warn', 'timers found; ctx.effect present but static scan cannot prove each timer is registered inside it', { timers })

  if (model.pkg?.dsh?.hotReload === false) {
    add('hotreload-veto', 'warn', 'package.json dsh.hotReload === false → static grade is E (veto)')
  }

  const ok = !findings.some(f => f.level === 'block')
  return { ok, grade: gradeOfModel(model).grade, dir: model.abs, findings }
}

// ─────────────────────────────── gates ───────────────────────────────

function makeGates(model, cfg, opts = {}) {
  const gates = []
  const facts = opts.facts ?? null
  // 'load' = 装载前静态预检（默认，host facts 尚不存在）；'promote' = 晋升裁决（必须 host facts）。
  const stage = opts.stage === 'promote' ? 'promote' : 'load'
  const blockingOnUnknown = cfg.blockingOnUnknown !== false
  const add = (id, gate, verdict, detail, extra = {}) => {
    const ok = verdict === 'pass'
      || verdict === 'skip'
      || (verdict === 'unknown' && !blockingOnUnknown)
    gates.push({ id, gate, verdict, ok, detail, ...extra })
  }

  const pkg = model.pkg
  const src = model.entry?.src ?? ''
  const hasSrc = typeof model.entry?.src === 'string'

  // G1 manifest 字段
  if (!pkg || typeof pkg !== 'object') {
    add('G1', 'manifest-fields', 'fail', 'package.json missing/unreadable')
  } else if (typeof pkg.name !== 'string' || pkg.name.trim() === '') {
    add('G1', 'manifest-fields', 'fail', 'missing package.json name')
  } else if (typeof pkg.version !== 'string' || pkg.version.trim() === '') {
    add('G1', 'manifest-fields', 'fail', `${pkg.name}: missing version`)
  } else if (pkg.type !== undefined && pkg.type !== 'module') {
    add('G1', 'manifest-fields', 'fail', `${pkg.name}@${pkg.version}: type must be "module" (got ${JSON.stringify(pkg.type)})`)
  } else {
    add('G1', 'manifest-fields', 'pass', `${pkg.name}@${pkg.version} (type=${pkg.type ?? 'module'})`)
  }

  // G2 入口存在
  if (model.entry) add('G2', 'entry-exists', 'pass', `${model.entry.rel} (${model.entry.bytes}B)`)
  else add('G2', 'entry-exists', 'fail', 'no entry file matched exports/module/main/index.js')

  // G3 无 eval/new Function
  if (!hasSrc) add('G3', 'static-danger', 'unknown', 'no entry source to inspect')
  else {
    const sites = findEvalSites(src)
    if (sites.length > 0) add('G3', 'static-danger', 'fail', `eval()/new Function() at line(s) ${sites.map(s => s.line).join(',')}`, { sites })
    else add('G3', 'static-danger', 'pass', 'no eval()/new Function() found')
  }

  // G4 无裸 child_process（import 层；不做调用层）
  if (!model.scan) add('G4', 'no-bare-child-process', 'unknown', 'no import scan (entry unreadable)')
  else {
    const hits = model.scan.imports.filter(i => CHILD_PROCESS.has(i.specifier))
    if (hits.length > 0) {
      add('G4', 'no-bare-child-process', 'fail', `child_process imported at line(s) ${hits.map(h => h.line).join(',')}`, { imports: hits })
    } else {
      add('G4', 'no-bare-child-process', 'pass', 'no child_process import (import-layer only)')
    }
  }

  // G5 依赖 allow-list
  if (!pkg || typeof pkg !== 'object') {
    add('G5', 'deps-allowlist', 'unknown', 'no manifest to read dependencies from')
  } else {
    const deps = depsOf(pkg)
    const bad = deps.filter(d => !depAllowed(d, cfg))
    add('G5', 'deps-allowlist', bad.length ? 'fail' : 'pass',
      bad.length
        ? `not allow-listed: ${bad.join(', ')} (allowed: @deepseek-ai/* + config.allowlist)`
        : (deps.length ? `allow-listed: ${deps.join(', ')}` : 'no runtime dependencies'),
      { deps, disallowed: bad })
  }

  // G6 资源闭合（裸定时器必须有 ctx.effect；静态近似）
  if (!hasSrc) add('G6', 'resource-containment', 'unknown', 'no entry source to inspect')
  else {
    const timers = findTimers(src)
    const effect = EFFECT_RE.test(src)
    if (timers.length === 0) add('G6', 'resource-containment', 'pass', 'no bare timers')
    else if (!effect) add('G6', 'resource-containment', 'fail', `timers without ctx.effect: ${timers.map(t => `${t.fn}@${t.line}`).join(',')}`, { timers })
    else add('G6', 'resource-containment', 'pass', `timer(s) present with ctx.effect (approximate): ${timers.map(t => `@${t.line}`).join(',')}`, { approximate: true, timers })
  }

  // G7 豁免诚实性
  if (pkg?.dsh?.acceptRisk === true) {
    const exempted = pkg?.dsh?.exempted
    const honest = Array.isArray(exempted) && exempted.length > 0
      && exempted.every(e => e && typeof e.gate === 'string' && String(e.reason ?? '').trim() !== '')
    add('G7', 'exemption-honesty', honest ? 'pass' : 'fail',
      honest ? `${exempted.length} explicit exemption(s)` : 'dsh.acceptRisk=true without explicit {gate,reason} exemptions')
  } else {
    add('G7', 'exemption-honesty', 'pass', 'no acceptRisk claim')
  }

  // G8 构建脚本闭合
  const scripts = pkg?.scripts ?? {}
  const present = BUILD_SCRIPTS.filter(s => typeof scripts[s] === 'string')
  if (present.length === 0) add('G8', 'build-scripts', 'pass', 'no install-time build scripts')
  else {
    const approved = Array.isArray(pkg?.dsh?.buildApproved) ? pkg.dsh.buildApproved : []
    const missing = present.filter(s => !approved.includes(s))
    add('G8', 'build-scripts', missing.length ? 'fail' : 'pass',
      missing.length ? `unapproved install scripts: ${missing.join(', ')}` : `approved: ${present.join(', ')}`,
      { present, missing })
  }

  // G9 秘密卫生
  if (!hasSrc) add('G9', 'secret-hygiene', 'unknown', 'no entry source to inspect')
  else {
    const hits = findSecrets(src)
    add('G9', 'secret-hygiene', hits.length ? 'fail' : 'pass', hits.length ? `hardcoded secret pattern(s): ${hits.join(', ')}` : 'clean', { hits })
  }

  // G10 bundle patch 声明与文件一致
  const patchRel = pkg?.dsh?.bundle?.patch
  if (typeof patchRel !== 'string' || patchRel === '') {
    add('G10', 'bundle-patch', 'skip', 'not a bundle (no dsh.bundle.patch)')
  } else {
    // The declared patch is plugin-relative and must stay inside the plugin root.
    const patchFile = resolvePluginFile(model.abs, patchRel)
    const ok = patchFile !== null
    add('G10', 'bundle-patch', ok ? 'pass' : 'fail',
      ok ? patchRel : `declared bundle patch missing/unsafe: ${patchRel}`, { patch: patchRel })
  }

  // G11 激活证据：静态预检查看不了激活（load 之后才可观测）→ deferred/SKIP（ci-gate G7 同构）；
  // stage='promote' 时必须给出 host facts，否则 UNKNOWN 阻断（fail-closed）。
  if (stage === 'load' && !facts) {
    add('G11', 'activation-evidence', 'skip', 'deferred: activation is observed only after load')
  } else if (!facts || typeof facts !== 'object') {
    add('G11', 'activation-evidence', 'unknown', 'no host facts (activation not observed)')
  } else if (facts.application !== 'applied') {
    add('G11', 'activation-evidence', 'fail', `facts.application=${JSON.stringify(facts.application ?? null)} (expected "applied")`)
  } else if (!Number.isFinite(facts.observedAt) || facts.observedAt <= 0) {
    add('G11', 'activation-evidence', 'unknown', 'facts.observedAt missing/invalid; freshness cannot be established')
  } else if (model.entry && facts.observedAt < model.entry.mtimeMs) {
    add('G11', 'activation-evidence', 'fail', `facts stale: observedAt=${facts.observedAt} < entry.mtimeMs=${model.entry.mtimeMs}`)
  } else {
    add('G11', 'activation-evidence', 'pass', 'facts.application=applied and fresh enough')
  }

  // G12 分数可复算：同样只在有 host facts 时才可判定。
  if (stage === 'load' && (!facts || !Array.isArray(facts.signals) || typeof facts.score !== 'number')) {
    add('G12', 'score-reproducible', 'skip', 'deferred: persisted facts exist only after load')
  } else if (!facts || !Array.isArray(facts.signals) || typeof facts.score !== 'number') {
    add('G12', 'score-reproducible', 'unknown', 'no persisted facts.signals/score')
  } else {
    const recomputed = scoreScan(facts.signals, { dsh: pkg?.dsh }).S
    add('G12', 'score-reproducible', recomputed === facts.score ? 'pass' : 'fail',
      `stored=${facts.score} recomputed=${recomputed}`)
  }

  const count = (v) => gates.filter(g => g.verdict === v).length
  const summary = {
    total: gates.length,
    pass: count('pass'),
    fail: count('fail'),
    unknown: count('unknown'),
    skip: count('skip'),
  }
  return {
    pass: gates.every(g => g.ok),
    gates,
    summary,
    blockingOnUnknown,
    dir: model.abs,
  }
}

// ─────────────────────────────── evidence ───────────────────────────────

function evidenceOf(model, cfg) {
  const scan = model.scan ?? { imports: [], warnings: [] }
  const mapped = model.entry ? importsToSignals(scan, model.pkg ?? {}) : { signals: [] }
  const self = selfCheckOf(model, cfg)
  const gs = makeGates(model, cfg, {})
  return {
    plugin: model.pkg
      ? {
        name: model.pkg.name ?? null,
        version: model.pkg.version ?? null,
        type: model.pkg.type ?? null,
        dsh: model.pkg.dsh ?? null,
        dependencies: model.pkg.dependencies ?? {},
      }
      : null,
    entry: model.entry
      ? { file: model.entry.file, rel: model.entry.rel, bytes: model.entry.bytes, sha256: model.entry.sha256, mtimeMs: model.entry.mtimeMs }
      : null,
    files: model.files,
    imports: {
      count: scan.imports.length,
      items: scan.imports.map(i => ({ specifier: i.specifier, kind: i.kind, line: i.line })),
      warnings: scan.warnings,
      coverage: 'import-only',
    },
    resources: {
      timers: model.entry ? findTimers(model.entry.src) : [],
      evalSites: model.entry ? findEvalSites(model.entry.src) : [],
      secrets: model.entry ? findSecrets(model.entry.src) : [],
      hasEffect: model.entry ? EFFECT_RE.test(model.entry.src) : false,
      hasProvide: model.entry ? PROVIDE_RE.test(model.entry.src) : false,
      deps: depsOf(model.pkg),
      signals: mapped.signals.map(s => ({ id: s.id, weight: s.weight })),
    },
    checks: {
      selfCheck: self.findings.map(f => ({ id: f.id, level: f.level })),
      gates: gs.gates.map(g => ({ id: g.id, gate: g.gate, verdict: g.verdict, ok: g.ok })),
    },
  }
}

// ─────────────────────────────── suggestFix ───────────────────────────────

function patch(target, yaml, why, extra = {}) {
  return { target, yaml, why, ...extra }
}

function suggestFixOf(model, cfg, opts = {}) {
  const self = selfCheckOf(model, cfg)
  const gs = makeGates(model, cfg, opts)
  const gate = (id) => gs.gates.find(g => g.id === id)
  const finding = (id) => self.findings.find(f => f.id === id)
  const entryRel = model.entry?.rel ?? 'index.js'
  const patches = []
  const seen = new Set()
  const add = (p) => {
    const key = `${p.target}\u0000${p.why}`
    if (seen.has(key)) return
    seen.add(key)
    patches.push(p)
  }

  const g1 = gate('G1')
  if (g1 && !g1.ok && g1.verdict === 'fail') {
    add(patch('package.json',
      JSON.stringify({ name: model.pkg?.name ?? '@local/<plugin-name>', version: '1.0.0', type: 'module' }, null, 2),
      `G1 manifest-fields: ${g1.detail} — merge these fields into the existing package.json; do not replace the file`,
      { apply: 'merge', mergeInto: 'package.json' }))
  }

  const g2 = gate('G2')
  if (g2 && !g2.ok) {
    add(patch('package.json',
      JSON.stringify({ exports: { '.': './index.js' } }, null, 2),
      `G2 entry-exists: ${g2.detail} — create the entry file and merge this exports field`,
      { apply: 'merge', mergeInto: 'package.json' }))
  }

  const g3 = gate('G3')
  if (g3 && g3.verdict === 'fail') {
    add(patch(entryRel,
      '# remove eval()/new Function(): use a static branch, a schema, or a declared capability service\n# (healer only suggests; the code change is a manual edit)',
      `G3 static-danger: ${g3.detail}`))
  }

  const g4 = gate('G4')
  if (g4 && g4.verdict === 'fail') {
    add(patch(entryRel,
      '# drop the child_process import: delegate process work to the declared capability\n# (fangForker mother-side) or run this code in the container zone',
      `G4 no-bare-child-process: ${g4.detail}`))
  }

  const g5 = gate('G5')
  if (g5 && g5.verdict === 'fail') {
    const bad = g5.disallowed ?? []
    const yaml = [
      '# merge into the plugin row config in cordis.patch.yml',
      'config:',
      '  allowlist:',
      ...bad.map(d => `    - ${JSON.stringify(d)}`),
    ].join('\n')
    add(patch('cordis.patch.yml', yaml, `G5 deps-allowlist: ${g5.detail}`))
  }

  const g6 = gate('G6')
  if (g6 && g6.verdict === 'fail') {
    add(patch(entryRel,
      '# register every timer through ctx.effect so it is disposed with the fiber:\n# ctx.effect(() => { const t = setInterval(fn, ms); return () => clearInterval(t) })',
      `G6 resource-containment: ${g6.detail}`))
  }

  const g8 = gate('G8')
  if (g8 && g8.verdict === 'fail') {
    // Never auto-approve install scripts: that would turn a security finding into a
    // one-line bypass. The placeholder requires a human review step.
    add(patch('package.json',
      JSON.stringify({
        dsh: {
          buildApproved: ['<script-name-after-review>'],
        },
      }, null, 2),
      `G8 build-scripts: ${g8.detail} — review each install script; only merge names you explicitly approve. An auto-filled buildApproved list would bypass this gate.`,
      { apply: 'manual-review', mergeInto: 'package.json', requiresHumanReview: true }))
  }

  const g9 = gate('G9')
  if (g9 && g9.verdict === 'fail') {
    add(patch(entryRel,
      '# remove the hardcoded credential; read it from ctx.config / environment at runtime',
      `G9 secret-hygiene: ${g9.detail}`))
  }

  const g10 = gate('G10')
  if (g10 && g10.verdict === 'fail') {
    const declared = typeof g10.patch === 'string' ? g10.patch : ''
    const safeTarget = declared && !path.isAbsolute(declared) && !declared.split(/[\\/]/).includes('..')
      ? declared
      : 'cordis.patch.yml'
    add(patch(safeTarget,
      '# create the declared bundle patch file; the declaration must stay inside the plugin root',
      `G10 bundle-patch: ${g10.detail}`,
      { apply: 'manual-create', declaredPatch: declared || null }))
  }

  const g7 = gate('G7')
  if (g7 && g7.verdict === 'fail') {
    add(patch('package.json',
      JSON.stringify({ dsh: { exempted: [{ gate: '<gate-id>', reason: 'reviewed: <why this risk is acceptable>' }] } }, null, 2),
      `G7 exemption-honesty: ${g7.detail} — merge only after a real review; a placeholder exemption must not be copied blindly`,
      { apply: 'manual-review', mergeInto: 'package.json', requiresHumanReview: true }))
  }

  const fx = finding('inject-missing')
  if (fx) {
    add(patch(entryRel,
      '# add at module top level (middle-tier plugins declare no hard deps):\n# export const inject = []',
      `module shape: ${fx.message}`))
  }
  const fe = finding('no-effect-wrap')
  if (fe) {
    add(patch(entryRel,
      '# wrap service registration: ctx.effect(() => ctx.provide(SERVICE.<key>, service))',
      `module shape: ${fe.message}`))
  }

  const before = gradeOfModel(model)
  let afterGrade = before.grade
  const projectedGates = []
  if (model.entry) {
    const addressed = new Set()
    if (g4 && g4.verdict === 'fail') {
      addressed.add('S1')
      projectedGates.push('G4')
    }
    const kept = before.signals.filter(s => !addressed.has(familyOf(s.id)))
    const projected = scoreScan(kept, {
      ...(model.pkg ?? {}),
      __parseErrors: (model.scan?.warnings ?? []).length,
    })
    afterGrade = projected.grade
  }

  return {
    patches,
    before: { grade: before.grade, S: before.S },
    after: {
      grade: afterGrade,
      note: projectedGates.length > 0
        ? 'projected only by removing G4/S1 signals; G3/G5/G6/G7/G8/G9/G10 are not represented and host-fact gates (G11/G12) are unaffected'
        : 'static projection only; no score-affecting patch was applied and host-fact gates (G11/G12) are unaffected',
      projectedGates,
    },
    dir: model.abs,
    applied: false,
  }
}

// ─────────────────────────────── plugin ───────────────────────────────

export function apply(ctx, config) {
  const gate = roleGate('healer', { cfgRole: config?.role, logger: ctx.logger })
  // v2 deployment matrix: this plugin is not deployed in this role — register nothing.
  if (!gate.active) return
  const cfg = {
    blockingOnUnknown: true,
    reservedIds: [],
    allowlist: [],
    ...(config ?? {}),
  }
  const normalized = {
    blockingOnUnknown: cfg.blockingOnUnknown !== false,
    reservedIds: Array.isArray(cfg.reservedIds) ? cfg.reservedIds.map(String) : [],
    allowlist: Array.isArray(cfg.allowlist) ? cfg.allowlist.map(String) : [],
  }

  const audit = (kind, data) => {
    try { safeGet(ctx, SERVICE.auditor)?.append?.(kind, data) } catch { /* 审计缺失不得影响自检 */ }
  }

  const service = {
    policy: { ...normalized },

    /** 自检：只读，返回 {ok, grade, findings[]}（契约 5.5）。 */
    selfCheck(dir, opts = {}) {
      const model = readModel(dir, opts)
      const out = selfCheckOf(model, normalized)
      audit(AUDIT.SCORE, {
        component: name,
        check: 'self-check',
        dir: out.dir,
        ok: out.ok,
        grade: out.grade,
        findings: out.findings.length,
      })
      return out
    },

    /** 结构化证据 JSON（契约 5.5）：{plugin, entry, files, imports, resources, checks}。 */
    evidence(dir, opts = {}) {
      return evidenceOf(readModel(dir, opts), normalized)
    },

    /**
     * G1–G12 门禁（契约 5.5）：{pass, gates:[{id, ok, detail, verdict}], summary}。
     * opts.stage: 'load'（默认，静态预检，G11/G12 deferred/SKIP）| 'promote'（G11/G12 必须有 facts，否则 UNKNOWN 阻断）。
     * opts.facts: host 证据 {application, observedAt, signals, score}（见 CONTRACTS 5.5）。
     */
    gates(dir, opts = {}) {
      const out = makeGates(readModel(dir, opts), normalized, opts)
      audit(AUDIT.SCORE, {
        component: name,
        check: 'gates',
        dir: out.dir,
        pass: out.pass,
        fail: out.summary.fail,
        unknown: out.summary.unknown,
      })
      return out
    },

    /** 补丁建议：{patches:[{target,yaml,why}], before, after}；**不写盘**（契约 5.5）。 */
    suggestFix(dir, opts = {}) {
      const out = suggestFixOf(readModel(dir, opts), normalized, opts)
      audit(AUDIT.SCORE, {
        component: name,
        check: 'suggest-fix',
        dir: out.dir,
        patches: out.patches.length,
        before: out.before.grade,
        after: out.after.grade,
      })
      return out
    },
  }

  ctx.effect(() => ctx.provide(SERVICE.healer, service))
}

export const _internals = { selfCheckOf, makeGates, evidenceOf, suggestFixOf, readModel, gradeOfModel }
