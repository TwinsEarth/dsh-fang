// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang kernel — commercial (Relay-backed) extension points.
//
// v2.0.0 ships the hooks, not the paid features. Every hook is optional and a no-op
// when absent: the offline development loop never depends on a Relay provider.
// A future commercial plugin provides the service `fangCommercial` with any subset of:
//
//   collaboration: { publishChange({taskId, pluginId, files}) -> Promise<void>,
//                    onRemoteChange(cb) -> unsubscribe }
//   git:           { snapshot({dir, message}) -> Promise<{commit}>,
//                    log({dir, limit}) -> Promise<{commits}> }
//   backup:        { upload({kind, id, key, body}) -> Promise<{uri}>,
//                    status() -> Promise<{lastAt, ok}> }
//   tokenApi:      { issue({scope, ttlMs}) -> Promise<{token}> }
//   teams:         { whoami() -> Promise<{id, role}>, check({action, group}) -> Promise<{allowed}> }
//
// Providers must be async-safe and must never throw into the host: callers wrap them.

export const COMMERCIAL = {
  collaboration: 'collaboration',
  git: 'git',
  backup: 'backup',
  tokenApi: 'tokenApi',
  teams: 'teams',
}

export const SERVICE_COMMERCIAL = 'fangCommercial'

/** Default config gate: every paid capability is off unless the user enables it. */
export function commercialConfigSchemaDefaults() {
  return { collaboration: false, git: false, backup: false, tokenApi: false, teams: false }
}

/**
 * Resolve one commercial capability. Returns undefined when the feature is disabled by
 * config, the provider service is absent, or that provider does not implement it.
 * @param {object} opts
 * @param {object} opts.commercialHooks  Config flag map (see commercialConfigSchemaDefaults)
 * @param {object|undefined} opts.provider  ctx.get('fangCommercial')
 * @param {string} opts.capability
 */
export function resolveCommercial({ commercialHooks, provider, capability } = {}) {
  if (!commercialHooks || commercialHooks[capability] !== true) return undefined
  if (!provider) return undefined
  const impl = provider[capability]
  if (!impl || typeof impl !== 'object') return undefined
  return impl
}

/** Call one provider method with failure isolation. Never rejects. */
export async function invokeCommercial({ commercialHooks, provider, capability, method, args = [] } = {}) {
  const impl = resolveCommercial({ commercialHooks, provider, capability })
  if (!impl || typeof impl[method] !== 'function') return { ok: false, error: 'not-configured' }
  try {
    const value = await impl[method](...args)
    return { ok: true, value }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}
