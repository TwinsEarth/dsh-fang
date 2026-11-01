// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T2 healer fixture — clean middle-tier Cordis plugin.
// Deliberately boring: no child_process / network / vm / fs imports, timer + service
// registration wrapped in ctx.effect, inject stays empty.
import { SERVICE, z } from '../../../src/kernel/index.mjs'

export const name = 'fang-fixture-clean'
export const inject = []

export const Config = z.object({
  label: z.string().default('clean'),
})

export function apply(ctx, config) {
  const cfg = { ...Config({}), ...(config ?? {}) }
  let ticks = 0

  ctx.effect(() => {
    const timer = setInterval(() => { ticks += 1 }, 60_000)
    return () => clearInterval(timer)
  })

  ctx.effect(() => ctx.provide(SERVICE.scorer, {
    label: cfg.label,
    ticks: () => ticks,
  }))
}
