// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/release/deploy-profile.mjs — 安全部署插件到 DSH profile：
//   1) 宿主/母体在运行时拒绝热替换（2026-11-22 宿主 EPERM watch 事故的直接修复）；
//   2) 先完整 staging → 原子 rename → 失败回滚；
//   3) 记录版本/hash/旧目录，部署后必须重启 DSH Desktop。
//
// 用法：
//   node tools/release/deploy-profile.mjs --check
//   node tools/release/deploy-profile.mjs [--source dist/npm/package] [--profile <dir>] [--allow-running]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const value = (flag, fallback = '') => {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}

const source = path.resolve(value('--source', path.join(ROOT, 'dist/npm/package')))
// 默认是母体 profile。不要用 DSH_PROFILE_DIR：在分身 Web 里它会指向分身 profile。
const profile = path.resolve(value('--profile', 'C:/Users/fangw/.dsh/profiles/desktop'))
const packageName = value('--package', '@twinsearth/fang-dsh-plugin')
const allowRunning = has('--allow-running')
const checkOnly = has('--check')

const dataDir = path.resolve(value('--fang-home', path.join(path.dirname(profile), '..', 'fang', 'desktop')))
const endpointFile = path.join(dataDir, 'endpoint.json')

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

async function hostAlive() {
  const endpoint = readJson(endpointFile, null)
  const url = endpoint?.url
  if (!url) return { alive: false, reason: 'no-endpoint' }
  try {
    // 401/404 也说明 TCP 服务活着；只有连接失败才算宿主已退出。
    const res = await fetch(url.replace(/\/$/, '') + '/fang/api/status', { signal: AbortSignal.timeout(2500) })
    return { alive: true, reason: `http ${res.status}`, url }
  } catch (error) {
    return { alive: false, reason: String(error?.cause?.code ?? error?.name ?? error).slice(0, 120), url }
  }
}

function digestTree(dir) {
  const hash = crypto.createHash('sha256')
  const walk = (abs, rel) => {
    const entries = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const nextAbs = path.join(abs, entry.name)
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(nextAbs, nextRel)
      else if (entry.isFile()) hash.update(nextRel).update('\0').update(fs.readFileSync(nextAbs)).update('\0')
    }
  }
  walk(dir, '')
  return hash.digest('hex')
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

async function main() {
  const alive = await hostAlive()
  const sourcePkg = readJson(path.join(source, 'package.json'), null)
  if (!sourcePkg) throw new Error(`source package missing: ${source}`)
  console.log(`source  : ${sourcePkg.name}@${sourcePkg.version}`)
  console.log(`profile : ${profile}`)
  console.log(`host    : ${alive.alive ? `RUNNING (${alive.reason})` : `stopped (${alive.reason})`}`)

  if (checkOnly) {
    if (alive.alive) {
      console.log('\nFAIL 宿主仍在运行：拒绝热替换母体 profile。请先退出 DSH Desktop 再部署。')
      process.exit(2)
    }
    console.log('\nPASS 宿主已停止，可以安全部署。')
    return
  }
  if (alive.alive && !allowRunning) {
    console.log('\nFAIL 宿主仍在运行：拒绝热替换母体 profile（2026-11-22 宿主 EPERM 崩溃事故保护）。')
    console.log('     请先退出 DSH Desktop，或显式使用 --allow-running（不推荐）。')
    process.exit(2)
  }

  const target = path.join(profile, 'node_modules', ...packageName.split('/'))
  const parent = path.dirname(target)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const stage = path.join(parent, `.fang-stage-${stamp}`)
  const old = path.join(parent, `.fang-old-${stamp}`)
  const backup = path.join(ROOT, 'archive', 'deploy', stamp)
  fs.mkdirSync(parent, { recursive: true })
  fs.rmSync(stage, { recursive: true, force: true })

  // 1) staging 完整落盘 + 校验
  fs.cpSync(source, stage, { recursive: true, dereference: true })
  const stagedPkg = readJson(path.join(stage, 'package.json'), null)
  if (!stagedPkg || stagedPkg.name !== packageName || stagedPkg.version !== sourcePkg.version) {
    fs.rmSync(stage, { recursive: true, force: true })
    throw new Error('staging verification failed')
  }
  const stagedDigest = digestTree(stage)

  // 2) 旧目录改名（不删除，失败可回滚）
  const hadOld = fs.existsSync(target)
  if (hadOld) fs.renameSync(target, old)

  // 3) staging → target 原子切换
  try {
    fs.renameSync(stage, target)
  } catch (error) {
    if (hadOld && !fs.existsSync(target)) fs.renameSync(old, target)
    fs.rmSync(stage, { recursive: true, force: true })
    throw error
  }

  // 4) 备份旧目录（同盘 rename 已完成，这里只做归档副本）
  let previousVersion = null
  if (hadOld) {
    previousVersion = readJson(path.join(old, 'package.json'), null)?.version ?? null
    fs.mkdirSync(backup, { recursive: true })
    fs.cpSync(old, path.join(backup, 'package'), { recursive: true, dereference: true })
    fs.rmSync(old, { recursive: true, force: true })
  }
  const installedPkg = readJson(path.join(target, 'package.json'), null)
  const installedDigest = digestTree(target)
  const record = {
    at: new Date().toISOString(),
    action: 'deploy-profile',
    package: packageName,
    from: previousVersion,
    to: installedPkg.version,
    source,
    target,
    digest: installedDigest,
    sourceDigest: stagedDigest,
    hostWasRunning: alive.alive,
    backup: hadOld ? backup : null,
  }
  writeJson(path.join(backup, 'deploy.json'), record)
  console.log(`PASS  deployed ${packageName}@${installedPkg.version}`)
  console.log(`      digest ${installedDigest}`)
  console.log('      NEXT: 重新启动 DSH Desktop，让宿主加载新版本。')
}

main().catch((error) => {
  console.error(`FAIL ${String(error?.message ?? error)}`)
  process.exit(1)
})
