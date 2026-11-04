// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.8 reflow: seal → verify → quarantine → adopt. No merge, no config/credential upload.
export const REFLOW_STATES = Object.freeze(['sealed', 'verified', 'quarantine', 'adopted'])

const NEXT = {
  sealed: 'verified',      // seal → verify
  verified: 'adopted',    // verify → adopt
  quarantine: 'adopted',  // only after explicit quarantine resolution
  adopted: null,
}

const FORBIDDEN_KEYS = new Set(['token', 'password', 'secret', 'credential', 'auth', 'cookie', 'sessionkey', 'apikey'])

export function transition(current, event) {
  if (event === 'quarantine') {
    if (current !== 'verified') return { ok: false, error: 'invalid-transition' }
    return { ok: true, state: 'quarantine' }
  }
  if (event === 'adopt' && current === 'verified') return { ok: true, state: 'adopted' }
  if (event === 'recover' && current === 'quarantine') return { ok: true, state: 'verified' }
  return { ok: false, error: 'invalid-transition' }
}

export function assertSafeArtifact(artifact) {
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk)
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(String(key).toLowerCase())) throw new Error('reflow-forbidden-field:' + key)
      walk(child)
    }
  }
  walk(artifact)
  return true
}

export function canAdopt(state, artifact) {
  if (state !== 'verified') return { ok: false, error: 'not-verified' }
  try { assertSafeArtifact(artifact) } catch (error) { return { ok: false, error: String(error.message) } }
  return { ok: true }
}
