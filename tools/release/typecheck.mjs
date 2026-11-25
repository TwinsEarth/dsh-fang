// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// 保护伞 TypeScript 参考实现的编译门禁（v2.7.7）。
//
// 仓库的产品运行时是纯 .mjs（CI 零第三方依赖，见 .github/workflows/ci.yml），
// 因此 TypeScript 只用于 types/ 下的参考实现，**不进 bundle、不进 preflight**。
// 本脚本的契约：
//   * 找到编译器 → 真的编译，失败就非零退出；
//   * 找不到编译器 → 打印 SKIP 与安装方法，退出码 0，但绝不打印 PASS。
//
// 用法：
//   node tools/release/typecheck.mjs
//   DSH_FANG_TSC=/abs/path/to/typescript/lib/tsc.js node tools/release/typecheck.mjs
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PROJECT = path.join(ROOT, 'types', 'tsconfig.json')

function run(command, args) {
  return spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', shell: false })
}

function probeVersion(command, args) {
  try {
    const out = run(command, [...args, '--version'])
    if (out.status !== 0) return null
    const text = `${out.stdout ?? ''}${out.stderr ?? ''}`.trim()
    return text.length > 0 ? text.split(/\r?\n/)[0] : null
  } catch {
    return null
  }
}

/** 按优先级找编译器：显式 env → 仓库依赖 → PATH。 */
function findCompiler() {
  const candidates = []
  const fromEnv = process.env.DSH_FANG_TSC
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    const file = path.resolve(fromEnv.trim())
    if (fs.existsSync(file)) candidates.push({ label: `DSH_FANG_TSC=${file}`, command: process.execPath, args: [file] })
  }
  for (const rel of ['node_modules/typescript/lib/tsc.js', 'node_modules/typescript/bin/tsc']) {
    const file = path.join(ROOT, rel)
    if (fs.existsSync(file)) candidates.push({ label: rel, command: process.execPath, args: [file] })
  }
  const binName = process.platform === 'win32' ? 'tsc.cmd' : 'tsc'
  const bin = path.join(ROOT, 'node_modules', '.bin', binName)
  if (fs.existsSync(bin)) candidates.push({ label: `node_modules/.bin/${binName}`, command: bin, args: [] })
  for (const candidate of candidates) {
    const version = probeVersion(candidate.command, candidate.args)
    if (version !== null) return { ...candidate, version }
  }
  return null
}

function main() {
  if (!fs.existsSync(PROJECT)) {
    console.log(`SKIP  types/tsconfig.json not found at ${PROJECT}`)
    console.log('      this repository ships the TypeScript reference under types/; nothing to check')
    return 0
  }

  const compiler = findCompiler()
  if (compiler === null) {
    console.log('SKIP  no TypeScript compiler found — nothing was compiled')
    console.log('      install one of:')
    console.log('        npm i -D typescript            (writes node_modules/typescript)')
    console.log('        DSH_FANG_TSC=/abs/path/to/typescript/lib/tsc.js node tools/release/typecheck.mjs')
    console.log('      CI does not run this check on purpose: the runtime is dependency-free .mjs')
    return 0
  }

  console.log(`compiler: ${compiler.version}  (${compiler.label})`)
  const result = run(compiler.command, [...compiler.args, '-p', PROJECT])
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.status === 0) {
    console.log('PASS  typescript: types/**/*.ts compiles under strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes')
    if (output.length > 0) console.log(output)
    return 0
  }
  console.log('FAIL  typescript: compilation errors')
  if (output.length > 0) console.log(output)
  return 1
}

process.exit(main())
