// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { Config, DEFAULT_MAX_FORKS, HARD_MAX_FORKS } from '../src/plugins/orchestrator.mjs'
import { isPackageJunkPath, selectFilesFromManifest } from '../tools/release/lib.mjs'
import { cleanLocaleSidecars } from '../tools/release/clean-locale-sidecars.mjs'

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
const singleRowPatch = fs.readFileSync(path.join(root, 'cordis.patch.single-row.yml'), 'utf8')

test('v3.9.10: maxForks defaults to 5, hard limit 100', () => {
  assert.equal(Config({}).maxForks, DEFAULT_MAX_FORKS)
  assert.equal(Config({ maxForks: 5 }).maxForks, 5)
  assert.equal(Config({ maxForks: 100 }).maxForks, 100)
  assert.equal(HARD_MAX_FORKS, 100)
  assert.equal(DEFAULT_MAX_FORKS, 5)
})

test('cordis patch keeps the 5-fork default capacity', () => {
  assert.equal((patch.match(/^\s*maxForks: 5\s*$/gm) || []).length, 2)
  assert.equal((patch.match(/^\s*maxOpenForkBrowsers: 5\s*$/gm) || []).length, 1)
  assert.equal((patch.match(/^\s*maxForks: 1\s*$/gm) || []).length, 0)
})

test('cordis single-row fallback keeps the same 5-fork / 5-web capacity', () => {
  assert.match(singleRowPatch, /^\s*maxForks: 5\s*$/m)
  assert.match(singleRowPatch, /^\s*maxOpenForkBrowsers: 5\s*$/m)
  assert.doesNotMatch(singleRowPatch, /^\s*maxForks: 8\s*$/m)
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
  assert.equal(pkg.scripts?.postinstall, 'node tools/release/clean-apple-double.mjs && node tools/release/clean-locale-sidecars.mjs')
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

