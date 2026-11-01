// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// 保护伞 TypeScript 参考实现的公共出口。
// 运行时权威实现是 `src/lib/umbrella.mjs` + `src/plugins/umbrella.mjs`；本目录是
// 可移植镜像，用于类型消费、跨语言移植与「语义即文档」。

export * from './types.js'
export { LruCache } from './cache.js'
export type { EvictHook } from './cache.js'
export * from './paths.js'
export {
  ACTION_CATEGORIES,
  DEFAULT_ACTION_RULES,
  DEFAULT_CREDENTIAL_PATTERNS,
  DEFAULT_DESTRUCTIVE_PATTERNS,
  DEFAULT_LIFECYCLE_PATTERNS,
  DEFAULT_LIFECYCLE_TOOLS,
  READ_ONLY_EXEC_PATTERNS,
  TOOL_MODE,
  ActionScorer,
  assertActionRule,
  baseLight,
  buildActionContext,
  commandTextOf,
  createActionRuleSet,
  decide,
  effectiveLightOf,
  evidencePathOf,
  execLooksReadOnly,
  firstPatternSource,
  gradeFloorOf,
  hostOfUrl,
  isCredentialAccess,
  isDestructiveCommand,
  isDshLifecycleAction,
  isDynamicImport,
  isNetworkEgress,
  isReadOnly,
  maxLight,
  modeOf,
  networkAllowed,
  normalizePolicy,
  parseShellRedirects,
  parseUrlParts,
  rankOf,
  scopeOf,
  targetOf,
  tokenizeShell,
} from './action-scorer.js'
export type { ActionScorerOptions, AssessOptions } from './action-scorer.js'
export { PluginScorer, normalizeGrade } from './plugin-scorer.js'
export type { PluginScorerOptions } from './plugin-scorer.js'
export { Umbrella, resolveFloorTable } from './umbrella.js'
export type { FloorResolution, UmbrellaDecisionOptions, UmbrellaOptions } from './umbrella.js'
