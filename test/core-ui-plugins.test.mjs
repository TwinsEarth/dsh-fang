// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  CORE_UI_PLUGIN_NAMES,
  enforceCoreUiEntries,
  findDisabledCoreUiEntries,
  isCoreUiPluginName,
} from '../src/lib/core-ui-plugins.mjs'

test('core UI: theme/layout/sidebar/chat are recognized across both scopes', () => {
  for (const name of CORE_UI_PLUGIN_NAMES) assert.equal(isCoreUiPluginName(name), true)
  assert.equal(isCoreUiPluginName('@twinsearth/dsh-client-ui-theme'), true)
  assert.equal(isCoreUiPluginName('@deepseek-ai/dsh-client-ui-settings'), false)
  assert.equal(isCoreUiPluginName('dsh-better-sidebar'), false)
})

test('core UI: disabled rows are forced enabled but their config is preserved', () => {
  const entries = [
    { id: 'ui-theme', name: '@deepseek-ai/dsh-client-ui-theme', config: { fontSize: 17, codeFontSize: 13 }, disabled: true },
    { id: 'ui-layout', name: '@deepseek-ai/dsh-client-ui-layout', disabled: 'true' },
    { id: 'ui-sidebar', name: '@deepseek-ai/dsh-client-ui-sidebar', disabled: false },
    { id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat' },
    { id: 'other', name: 'dsh-better-sidebar', disabled: true },
  ]
  const out = enforceCoreUiEntries(entries)
  assert.equal(out.forced, 2)
  assert.equal(out.entries[0].disabled, false)
  assert.deepEqual(out.entries[0].config, { fontSize: 17, codeFontSize: 13 })
  assert.equal(out.entries[1].disabled, false)
  assert.equal(out.entries[2].disabled, false)
  assert.equal(out.entries[3].disabled, undefined)
  assert.equal(out.entries[4].disabled, true, 'non-core rows keep their own switch')
  assert.equal(findDisabledCoreUiEntries(out.entries).length, 0)
  assert.equal(findDisabledCoreUiEntries(entries).length, 2)
})

test('core UI: official repair and source-surface merge both enforce the rows', () => {
  const essence = fs.readFileSync(new URL('../src/lib/essence.mjs', import.meta.url), 'utf8')
  const orchestrator = fs.readFileSync(new URL('../src/plugins/orchestrator.mjs', import.meta.url), 'utf8')
  assert.match(essence, /enforceCoreUiEntries\(\[\.\.\.recommended, \.\.\.experimental, \.\.\.shadows, \.\.\.preserved\]\)/)
  assert.match(essence, /coreUiForced: enforced\.forced/)
  assert.match(orchestrator, /enforceCoreUiEntries\(sourcePatchRaw\)\.entries/)
  assert.match(orchestrator, /enforceCoreUiEntries\(mergedRaw\)/)
  assert.match(orchestrator, /fork-core-ui-enabled/)
  assert.match(orchestrator, /runtime-core-ui-enabled/)
  assert.match(orchestrator, /runtime-core-ui-repair-failed/)
})
