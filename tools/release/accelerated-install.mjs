#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// Install the accelerated core under <FANG_HOME>/accel/cli.
//
// Budget rule (product): the install must stay <= 1 GiB. Above that the operator
// gets an explicit second confirmation prompt; without a TTY (CI/automation) the
// install fails closed unless --confirm-oversize is passed.
//
// Usage:
//   node tools/release/accelerated-install.mjs --fang-home <dir> [--version 3.5.0] [--yes]
import path from 'node:path'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

import {
  ACCEL_INSTALL_LIMIT_BYTES,
  DEFAULT_ACCEL_VERSION,
  installAcceleratedCore,
} from '../../src/lib/accelerated-install.mjs'

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? String(process.argv[index + 1] ?? '') : fallback
}
const hasFlag = (name) => process.argv.includes(`--${name}`)

const mb = (bytes) => `${(Number(bytes || 0) / (1024 * 1024)).toFixed(1)} MiB`

async function promptOversize({ sizeBytes, limitBytes }) {
  if (!input.isTTY || !output.isTTY) return false
  const rl = readline.createInterface({ input, output })
  try {
    const answer = await rl.question(
      `加速核安装体积 ${mb(sizeBytes)} 超过上限 ${mb(limitBytes)}。继续安装？（y/N） `,
    )
    return /^y(es)?$/i.test(String(answer).trim())
  } finally {
    rl.close()
  }
}

const main = async () => {
  const fangHome = arg('fang-home', String(process.env.FANG_HOME ?? '').trim())
  if (!fangHome) {
    console.error('缺少 --fang-home（或设置 FANG_HOME）')
    return 2
  }
  const version = arg('version', DEFAULT_ACCEL_VERSION)
  const result = await installAcceleratedCore({
    fangHome,
    version,
    force: hasFlag('force'),
    confirmOversize: hasFlag('yes') || hasFlag('confirm-oversize'),
    promptImpl: promptOversize,
  })
  if (result.ok !== true) {
    if (result.error === 'accelerated-install-too-large') {
      console.error(
        `安装体积 ${mb(result.sizeBytes)} 超过上限 ${mb(result.limitBytes)}（${path.join(fangHome, 'accel', 'cli')}）。`,
      )
      console.error('已保留文件但未登记安装；确认后请加 --confirm-oversize 重新执行。')
    } else {
      console.error(JSON.stringify({ ok: false, error: result.error, detail: result.detail ?? null }))
    }
    return 1
  }
  console.log(JSON.stringify({
    ok: true,
    version: result.version,
    cliPath: result.cliPath,
    reused: result.reused === true,
    sizeBytes: result.sizeBytes ?? null,
    limitBytes: result.limitBytes ?? ACCEL_INSTALL_LIMIT_BYTES,
  }, null, 2))
  return 0
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(String(error?.stack ?? error))
  process.exit(1)
})
