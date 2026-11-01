// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T6 fixture — 环境阈值分叉样本（只用于评分测试，永不装载）。
//
// `node:vm` 单独命中 S4-vm（weight 25）→ D1 sev = round(25/30*5) = 4 → S = 28*4/5 = 22.4 → 22。
// 母体分档 A≤20/B≤40 → B；分身分档 A≤25 → A。同一份源码、同一套评分数学，只是分档阈值不同。
import { runInNewContext } from 'node:vm'

export function evaluate(source, sandbox = {}) {
  return runInNewContext(source, sandbox)
}
