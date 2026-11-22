// SPDX-License-Identifier: AGPL-3.0-or-later
// Host half of the independent Vault subplugin. It only exposes the pure vault
// service; HTTP routes stay behind the mother's authenticated orchestrator.
import { exportVault, importVault, readVault } from './lib/vault.mjs'

export const name = 'fang-vault'
export const version = '0.1.0'
export const inject = []

export function apply(ctx) {
  const service = Object.freeze({ version, exportVault, importVault, readVault })
  if (typeof ctx?.effect === 'function') ctx.effect(() => ctx.provide('fangVault', service))
  else if (typeof ctx?.provide === 'function') ctx.provide('fangVault', service)
  return service
}
