// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Host half of the composer journal bundle; rendering lives in client.js.
 * v0.1.7: expose a capability service so the orchestrator can gate every
 * journal/queue route. If this row is disabled/absent, the service is missing,
 * APIs return 503 queue-journal-disabled and no UI can use the feature.
 */
export const name = 'fang-queue-journal'
export const inject = []
export const version = '0.1.7'

export function apply(ctx) {
  const service = Object.freeze({
    version,
    capability: 'queueJournal',
    /** The journal is a recovery surface; it never auto-sends. */
    recoveryOnly: true,
  })
  if (typeof ctx.effect === 'function') ctx.effect(() => ctx.provide('fangQueueJournal', service))
  else ctx.provide('fangQueueJournal', service)
  return service
}
