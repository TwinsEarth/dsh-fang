// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// fork-seed — 派生分身的默认第三方插件种子（v3.1.12）。
//
// 新机器/新用户的干净分身模板只有 base + web-app + fang；这里按“安装不激活 /
// 安装并激活”两组清单，把默认第三方插件装进**每个新分身自己的 profile**：
//   * install  = 只写入 dependencies 并安装 node_modules，不加入 profile bundles；
//   * activate = 额外加入 profile 的 dsh.profile.bundles，DSH 启动时就会加载。
// 安装缓存在 <forkHomes>/.plugin-seed/seed-<fingerprint>，用 dsh 自带 pnpm 完成；
// 模块树通过 hardlink 合并进分身 `node_modules`，不替换原有的 mother 镜像条目。
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { ensureDir, exists, hardlinkTree, isLink, removeTree, writeJsonAtomic } from '../kernel/index.mjs'

/** 用户给定的默认清单（2026-11-11）。新增/调整只改这里，再同步 docs/CHANGELOG。 */
export const DEFAULT_FORK_SEED = Object.freeze({
  enabled: true,
  install: Object.freeze([
    '@twinsearth/dsh-2xray',
    '@michengai/dsh-agency-agents',
    'dsh-better-sidebar',
    'dsh-context',
    '@liustack/modlens',
    '@liustack/modsearch',
  ]),
  activate: Object.freeze([
    'dshmarket',
    '@twinsearth/dsh-im2a-plugin',
    '@openviking/dsh-memory-plugin',
    '@twinsearth/w2m-dsh-plugin',
  ]),
})

/** npm 包名（可带 scope），防止配置把路径/参数注入 pnpm 命令。 */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i

/** 把用户配置归一成 { enabled, install, activate, packages }（去重、过滤非法名）。 */
export function normalizeForkSeed(input = {}) {
  const raw = input && typeof input === 'object' ? input : {}
  const enabled = raw.enabled !== false
  const clean = (list) => [...new Set((Array.isArray(list) ? list : []).map((item) => String(item ?? '').trim()).filter((name) => PACKAGE_NAME_RE.test(name)))]
  const install = clean(raw.install ?? DEFAULT_FORK_SEED.install)
  const activate = clean(raw.activate ?? DEFAULT_FORK_SEED.activate)
  const packages = [...install, ...activate.filter((name) => !install.includes(name))]
  return { enabled, install, activate, packages }
}

/** 种子指纹：配置变化即换缓存目录（排序，顺序不同但集合相同不换缓存）。 */
export function forkSeedFingerprint(seed) {
  const norm = normalizeForkSeed(seed)
  const canonical = { packages: [...norm.packages].sort(), activate: [...norm.activate].sort() }
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16)
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function packageDirName(name) {
  return name.split('/')
}

export function seedPackageDir(modulesDir, name) {
  return path.join(String(modulesDir ?? ''), ...packageDirName(name))
}

function readInstalledVersion(modulesDir, name) {
  const pkg = readJson(path.join(seedPackageDir(modulesDir, name), 'package.json'), null)
  return pkg && typeof pkg.version === 'string' ? pkg.version : ''
}

/**
 * 把种子模块合并进分身 `node_modules`：
 *   * 普通包：整目录 hardlink 覆盖；
 *   * scope：把目标 scope（可能是 junction / 真实目录）先展开成真实目录，再覆盖 seed 里的子包。
 * 不删除 seed 之外的目标条目（mother 镜像要继续可用）。
 */
export function mergeSeedModules(seedModulesDir, targetModulesDir) {
  const source = String(seedModulesDir ?? '')
  const target = String(targetModulesDir ?? '')
  if (!source || !exists(source)) return { ok: false, error: 'seed-modules-missing' }
  if (!target || !exists(target)) return { ok: false, error: 'target-modules-missing' }
  const copied = []
  const scopes = []
  const warnings = []
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const name = entry.name
    if (name.startsWith('.') || !entry.isDirectory()) continue
    const from = path.join(source, name)
    const to = path.join(target, name)
    try {
      if (name.startsWith('@')) {
        mergeScope(from, to)
        scopes.push(name)
      } else {
        removeTree(to)
        hardlinkTree(from, to)
        copied.push(name)
      }
    } catch (error) {
      warnings.push(`${name}: ${String(error?.message ?? error)}`)
    }
  }
  return { ok: warnings.length === 0, copied, scopes, warnings }
}

function mergeScope(seedScope, targetScope) {
  const staging = `${targetScope}.fang-seed-merge`
  removeTree(staging)
  ensureDir(staging)
  // 1) 保留目标 scope 既有子包（可能是指向 mother 模块树的 junction）。
  if (exists(targetScope) || isLink(targetScope)) {
    for (const child of fs.readdirSync(targetScope, { withFileTypes: true })) {
      const from = path.join(targetScope, child.name)
      const to = path.join(staging, child.name)
      try {
        if (child.isSymbolicLink()) {
          const resolved = fs.realpathSync(from)
          hardlinkTree(resolved, to)
        } else if (child.isDirectory()) hardlinkTree(from, to)
      } catch { /* keep the rest */ }
    }
  }
  // 2) seed 子包覆盖同名项。
  for (const child of fs.readdirSync(seedScope, { withFileTypes: true })) {
    if (!child.isDirectory()) continue
    const from = path.join(seedScope, child.name)
    const to = path.join(staging, child.name)
    removeTree(to)
    hardlinkTree(from, to)
  }
  // 3) 原子替换 scope 目录。
  removeTree(targetScope)
  try { fs.renameSync(staging, targetScope) } catch {
    removeTree(staging)
    hardlinkTree(seedScope, targetScope)
  }
}

/**
 * 把种子写进分身 profile 的 package.json：
 *   dependencies += 所有种子包（已有 spec 不覆盖）；
 *   dsh.profile.bundles += activate 列表（放在 fang 之后，去重）。
 * @returns {{packageJson:object, changed:boolean, addedDependencies:string[], addedBundles:string[]}}
 */
export function forkSeedProfilePatch(profilePkg, seed, versions = {}) {
  const norm = normalizeForkSeed(seed)
  const pkg = profilePkg && typeof profilePkg === 'object' ? JSON.parse(JSON.stringify(profilePkg)) : {}
  const dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
  const addedDependencies = []
  for (const name of norm.packages) {
    if (typeof dependencies[name] === 'string' && dependencies[name].trim()) continue
    const version = String(versions[name] ?? '').trim()
    dependencies[name] = version ? `^${version}` : '*'
    addedDependencies.push(name)
  }
  if (Object.keys(dependencies).length > 0) pkg.dependencies = dependencies
  pkg.dsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : {}
  pkg.dsh.profile = pkg.dsh.profile && typeof pkg.dsh.profile === 'object' ? pkg.dsh.profile : {}
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? [...pkg.dsh.profile.bundles] : []
  const addedBundles = []
  for (const name of norm.activate) {
    if (bundles.includes(name)) continue
    bundles.push(name)
    addedBundles.push(name)
  }
  pkg.dsh.profile.bundles = bundles
  return { packageJson: pkg, changed: addedDependencies.length > 0 || addedBundles.length > 0, addedDependencies, addedBundles }
}

const SEED_MARKER = '.fang-fork-seed.json'

/** 从 dsh CLI 路径推导 DSH 自带 pnpm 入口（.../runtime/cli/bin/dsh.cmd → .../runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs）。 */
export function resolvePnpmEntry(cliPath) {
  const cli = String(cliPath ?? '').trim()
  if (!cli) return null
  const cliDir = path.dirname(path.resolve(cli))
  const candidates = [
    path.resolve(cliDir, '..', '..', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
    path.resolve(cliDir, '..', '..', '..', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
  ]
  return candidates.find((candidate) => exists(candidate)) ?? null
}

/**
 * 默认安装器：在一个**普通 pnpm 项目**里安装种子（不初始化 DSH profile，避免被默认
 * dsh-llm 之类无法解析的基线依赖拖死）。只装插件包本身，peer 依赖交给宿主解析。
 */
export async function installSeedWithPnpm({ cliPath, seedHome, packages, timeoutMs = 300000 }) {
  const pnpmEntry = resolvePnpmEntry(cliPath)
  if (!pnpmEntry) return { ok: false, error: 'pnpm-not-found', detail: `cliPath=${cliPath}` }
  const seedDir = path.join(seedHome, 'seed')
  ensureDir(seedDir)
  const dependencies = Object.fromEntries([...packages].sort().map((name) => [name, 'latest']))
  writeJsonAtomic(path.join(seedDir, 'package.json'), { name: 'fang-fork-seed', private: true, dependencies })
  fs.writeFileSync(path.join(seedDir, 'pnpm-workspace.yaml'), [
    'packages:',
    '  - .',
    '',
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    'strictPeerDependencies: false',
    'minimumReleaseAge: 0',
    '',
  ].join('\n'), 'utf8')
  const nodeBin = process.execPath
  const args = [pnpmEntry, 'install', '--ignore-scripts', '--config.confirmModulesPurge=false']
  const result = await new Promise((resolve) => {
    let output = ''
    let child = null
    let timer = null
    const done = (value) => { if (timer) clearTimeout(timer); resolve(value) }
    try {
      child = spawn(nodeBin, args, {
        cwd: seedDir,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      done({ ok: false, error: 'spawn-failed', detail: String(error?.message ?? error) })
      return
    }
    const append = (chunk) => { output = (output + String(chunk)).slice(-8000) }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } done({ ok: false, error: 'seed-install-timeout', detail: output.slice(-1200) }) }, Math.max(1000, Number(timeoutMs) || 300000))
    child.on('error', (error) => done({ ok: false, error: 'spawn-failed', detail: String(error?.message ?? error) }))
    child.on('exit', (code) => done(code === 0 ? { ok: true, detail: output.slice(-1200) } : { ok: false, error: 'seed-install-failed', code, detail: output.slice(-2400) }))
  })
  return { ...result, modulesDir: path.join(seedDir, 'node_modules') }
}

/**
 * 给一个分身 profile 装备默认插件种子。幂等：同一指纹已应用则直接返回。
 * @returns {Promise<{ok:boolean, skipped?:boolean, cached?:boolean, packages?:string[], activate?:string[],
 *   versions?:Record<string,string>, merged?:object, error?:string, detail?:string}>}
 */
export async function applyForkSeedToProfile({ seed, profileDir, profileModulesDir, seedRoot, cliPath, timeoutMs = 300000, install = installSeedWithPnpm } = {}) {
  const norm = normalizeForkSeed(seed)
  if (!norm.enabled || norm.packages.length === 0) return { ok: true, skipped: true }
  const profile = String(profileDir ?? '')
  if (!profile || !exists(path.join(profile, 'package.json'))) return { ok: false, error: 'profile-package-missing' }
  if (!cliPath) return { ok: false, error: 'cli-path-missing' }
  const fingerprint = forkSeedFingerprint(norm)
  const markerFile = path.join(profile, SEED_MARKER)
  const marker = readJson(markerFile, null)
  const modulesDir = String(profileModulesDir ?? path.join(profile, 'node_modules'))
  const seedHome = path.join(String(seedRoot ?? path.join(path.dirname(profile), '.plugin-seed')), `seed-${fingerprint}`)
  const seedModules = path.join(seedHome, 'seed', 'node_modules')

  const cached = marker && marker.fingerprint === fingerprint
    ? norm.packages.every((name) => exists(seedPackageDir(seedModules, name)) && exists(seedPackageDir(modulesDir, name)))
    : false
  if (cached) {
    // v3.1.12: every spawn replays the clean template over the profile config, which
    // wipes the seeded dependencies/bundles. The seed modules and marker survive, so
    // re-apply the cheap profile patch on the cached path (no install, no module copy).
    const cachedPkg = readJson(path.join(profile, 'package.json'), null)
    if (!cachedPkg) return { ok: false, error: 'profile-package-invalid' }
    const patched = forkSeedProfilePatch(cachedPkg, norm, marker.versions ?? {})
    if (patched.changed) writeJsonAtomic(path.join(profile, 'package.json'), patched.packageJson)
    return {
      ok: true, cached: true, packages: norm.packages, activate: norm.activate, versions: marker.versions ?? {},
      patched: { addedDependencies: patched.addedDependencies, addedBundles: patched.addedBundles },
    }
  }

  if (!norm.packages.every((name) => exists(seedPackageDir(seedModules, name)))) {
    const installResult = await install({ cliPath, seedHome, packages: norm.packages, timeoutMs })
    if (!installResult?.ok) return { ok: false, error: installResult?.error ?? 'seed-install-failed', detail: installResult?.detail ?? '' }
  }
  const unknown = norm.packages.filter((name) => !exists(seedPackageDir(seedModules, name)))
  if (unknown.length > 0) return { ok: false, error: 'seed-packages-missing', detail: unknown.join(',') }
  const versions = Object.fromEntries(norm.packages.map((name) => [name, readInstalledVersion(seedModules, name)]).filter(([, version]) => version))

  const profilePkg = readJson(path.join(profile, 'package.json'), null)
  if (!profilePkg) return { ok: false, error: 'profile-package-invalid' }
  const patched = forkSeedProfilePatch(profilePkg, norm, versions)
  if (patched.changed) writeJsonAtomic(path.join(profile, 'package.json'), patched.packageJson)

  const merged = mergeSeedModules(seedModules, modulesDir)
  if (!merged.ok) {
    return {
      ok: false, error: 'seed-modules-merge-failed', detail: (merged.warnings ?? []).join('; '),
      packages: norm.packages, versions, merged,
    }
  }
  writeJsonAtomic(markerFile, {
    fingerprint,
    packages: norm.packages,
    activate: norm.activate,
    versions,
    appliedAt: Date.now(),
    merged: { copied: merged.copied.length, scopes: merged.scopes.length },
  })
  return { ok: true, packages: norm.packages, activate: norm.activate, versions, merged, patched: { addedDependencies: patched.addedDependencies, addedBundles: patched.addedBundles } }
}

export { SEED_MARKER }
