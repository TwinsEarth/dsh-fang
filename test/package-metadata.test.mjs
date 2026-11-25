// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { Config, HARD_MAX_FORKS } from '../src/plugins/orchestrator.mjs'
import { isPackageJunkPath, selectFilesFromManifest } from '../tools/release/lib.mjs'
import { cleanLocaleSidecars } from '../tools/release/clean-locale-sidecars.mjs'

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')

test('maxForks accepts legacy 8 without rejecting plugin config; runtime default stays 1', () => {
  assert.equal(Config({}).maxForks, HARD_MAX_FORKS)
  assert.equal(Config({ maxForks: 8 }).maxForks, 8)
  assert.equal(HARD_MAX_FORKS, 1)
})

test('cordis patch no longer injects maxForks: 8 into orchestrator/forker', () => {
  assert.equal((patch.match(/^\s*maxForks: 1\s*$/gm) || []).length, 2)
  assert.equal((patch.match(/^\s*maxForks: 8\s*$/gm) || []).length, 0)
})

test('AppleDouble and Finder sidecars are identified as package junk', () => {
  assert.equal(isPackageJunkPath('locale/._en.json'), true)
  assert.equal(isPackageJunkPath('locale/.DS_Store'), true)
  assert.equal(isPackageJunkPath('locale/en.json'), false)
  assert.equal(isPackageJunkPath('src/plugins/orchestrator.mjs'), false)
})

test('package manifest filters sidecars and ships the locale cleanup hook', () => {
  const files = selectFilesFromManifest(pkg)
  assert.equal(files.some((file) => isPackageJunkPath(file)), false)
  assert.equal(files.includes('locale/en.json'), true)
  assert.equal(files.includes('locale/zh.json'), true)
  assert.equal(files.includes('tools/release/clean-locale-sidecars.mjs'), true)
  assert.equal(pkg.scripts?.postinstall, 'node tools/release/clean-locale-sidecars.mjs')
})

test('source locale directory contains only valid language-id JSON files', () => {
  const localeDir = path.join(root, 'locale')
  const names = fs.readdirSync(localeDir).filter((name) => name.endsWith('.json'))
  assert.deepEqual(names.sort(), ['en.json', 'zh.json'])
})

test('postinstall cleanup removes AppleDouble locale sidecars only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-locale-clean-'))
  try {
    fs.writeFileSync(path.join(dir, 'en.json'), '{}')
    fs.writeFileSync(path.join(dir, '._en.json'), 'junk')
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'junk')
    const removed = cleanLocaleSidecars(dir)
    assert.deepEqual(removed.sort(), ['.DS_Store', '._en.json'])
    assert.deepEqual(fs.readdirSync(dir), ['en.json'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
