// SPDX-License-Identifier: MIT
// dsh-Fang / DSH plugin template — Host half.
//
// A Cordis plugin module: export name / inject / (optional Config) / apply.
// Copy this file, change the names, and install the directory as a bundle:
//   plugin_manager install_bundle(target="E:\\path\\to\\my-plugin")
//
// The optional `Config` two lines below needs a schema library. If you want a configurable
// plugin, copy `schemastery.mjs` + `cosmokit.mjs` (MIT, upstream cordis) into a `vendor/`
// folder next to this file and `export const Config = z.object({...})`, exactly like the
// dsh-Fang core does; otherwise a plugin with no Config is perfectly valid.
export const name = 'my-plugin'
export const inject = []

const DEFAULTS = { greeting: 'hello from my plugin' }

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  ctx.effect(() => ctx.provide('myPlugin', {
    greeting: () => cfg.greeting,
    status: () => ({ ok: true, at: new Date().toISOString() }),
  }))
}
