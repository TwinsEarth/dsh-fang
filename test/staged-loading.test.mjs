// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { applyForkStagedLoadingSurface, buildStagedLoadingConfig } from '../src/plugins/forker.mjs'

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}

function writeBundle(profileDir, bundleName, names, clientNames = []) {
  const patch = names.map(name => `    - id: ${name}\n      name: '${name}'\n`).join('')
  writeFile(path.join(profileDir, 'node_modules', bundleName, 'cordis.patch.yml'), patch)
  for (const name of clientNames) {
    writeFile(path.join(profileDir, 'node_modules', name, 'package.json'), JSON.stringify({
      name,
      dsh: { client: { platform: 'web' } },
    }))
  }
}

test('staged loading groups Fang, experimental and third-party client packages without server rows', () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-staged-'))
  try {
    writeBundle(profileDir, '@twinsearth/fang-dsh-plugin',
      ['@twinsearth/fang-dsh-plugin', '@twinsearth/fang-dsh-plugin/forker', '@twinsearth/dsh-fang-web-entry'],
      ['@twinsearth/fang-dsh-plugin', '@twinsearth/dsh-fang-web-entry'])
    writeBundle(profileDir, '@twinsearth/dsh-experimental-plugin-market-bundle',
      ['@twinsearth/dsh-plugin-market', '@twinsearth/dsh-client-ui-plugin-market'],
      ['@twinsearth/dsh-client-ui-plugin-market'])
    writeBundle(profileDir, 'dshmarket', ['dshmarket'], ['dshmarket'])
    writeFile(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'fixture-profile' }))
    writeFile(path.join(profileDir, 'cordis.patch.yml'), JSON.stringify([
      { id: 'existing', name: '@twinsearth/dsh-client-ui-theme' },
      { id: 'modules', config: { keep: true } },
    ]))

    const built = buildStagedLoadingConfig(profileDir)
    assert.deepEqual(built.counts, [4, 2, 1])
    assert.equal(built.stages[0].delayMs, 30000)
    assert.equal(built.stages[1].delayMs, 60000)
    assert.equal(built.stages[2].delayMs, 100000)
    assert.ok(built.stages[0].packages.includes('@twinsearth/fang-dsh-plugin'))
    assert.ok(!built.stages[0].packages.includes('@twinsearth/fang-dsh-plugin/forker'))
    assert.ok(built.stages[1].packages.includes('@twinsearth/dsh-client-ui-plugin-market'))
    assert.ok(!built.stages[1].packages.includes('@twinsearth/dsh-plugin-market'))
    assert.ok(built.stages[2].packages.includes('dshmarket'))

    const applied = applyForkStagedLoadingSurface(profileDir)
    assert.equal(applied.ok, true)
    const entries = JSON.parse(fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8'))
    assert.equal(entries.filter(entry => entry.id === 'modules').length, 1)
    const modules = entries.find(entry => entry.id === 'modules')
    assert.equal(modules.config.keep, true)
    assert.deepEqual(modules.config.stagedLoading.map(stage => stage.delayMs), [30000, 60000, 100000])
    assert.ok(entries.some(entry => entry.id === 'existing'))
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true })
  }
})
