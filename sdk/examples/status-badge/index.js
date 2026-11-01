// SPDX-License-Identifier: MIT
// Example host half: exposes a tiny service so the plugin is observable, and nothing else.
export const name = 'fang-example-status-badge'
export const inject = []

export function apply(ctx, config) {
  const cfg = { intervalMs: 10000, ...(config ?? {}) }
  ctx.effect(() => ctx.provide('fangExampleStatusBadge', {
    intervalMs: () => cfg.intervalMs,
    at: new Date().toISOString(),
  }))
}
