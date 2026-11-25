// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T2 healer fixture — deliberately gate-violating plugin (test input only; never loaded).
// Expected gate misses: G3 eval, G4 child_process, G5 undeclared deps, G6 bare timer
// without ctx.effect, G9 embedded secret. Also violates module shape (no inject export,
// no ctx.effect-wrapped provide) so selfCheck has block findings.
import { spawn } from 'node:child_process'

const accessKey = 'AKIAABCDEFGHIJKLMNOP'
const label = 'risky'

setInterval(() => { spawn('cmd', ['/c', 'echo', label]) }, 5_000)

export const name = 'fang-fixture-risky'

export function apply(ctx) {
  globalThis.__fangRisky = eval('({ ok: true })')
  return ctx.provide('fang-fixture-risky', { accessKey })
}
