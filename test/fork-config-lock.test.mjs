// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { applyForkConfigLock, FORK_LOCKED_ENTRY_IDS, setProfileConfigReadonly } from '../src/lib/fork-config-lock.mjs'

const tmpProfile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-lock-'))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '[]\n', 'utf8')
  return dir
}

test('fork-config-lock: 写入禁用条目且幂等', () => {
  const dir = tmpProfile()
  const first = applyForkConfigLock(dir)
  assert.equal(first.ok, true)
  assert.equal(first.entries, FORK_LOCKED_ENTRY_IDS.length)
  const text = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
  assert.doesNotMatch(text, /^\s*\[\s*\]\s*$/m, '必须移除模板里的空数组 []，否则 YAML 非法')
  for (const id of FORK_LOCKED_ENTRY_IDS) assert.match(text, new RegExp(`- id: ${id}\\n  disabled: true`))
  const second = applyForkConfigLock(dir)
  assert.equal(second.entries, 0, '第二次不得重复写入')
  assert.equal(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'), text)
})

test('fork-config-lock: JSON {insert} 补丁结构化合并，保持合法 YAML/JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-lock-json-'))
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '{"insert":[{"id":"ui-chat"}]}\n', 'utf8')
  const out = applyForkConfigLock(dir)
  assert.equal(out.ok, true)
  assert.equal(out.entries, FORK_LOCKED_ENTRY_IDS.length)
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'))
  assert.ok(Array.isArray(parsed), '必须变成顶层数组，不能在 JSON object 后追加 YAML')
  assert.ok(parsed.some((entry) => Array.isArray(entry.insert) && entry.insert.some((inner) => inner.id === 'ui-chat')))
  assert.ok(parsed.some((entry) => entry.id === FORK_LOCKED_ENTRY_IDS[0] && entry.disabled === true))
  assert.ok(parsed.some((entry) => entry.id === 'ui-settings-general'))
  const again = applyForkConfigLock(dir)
  assert.equal(again.entries, 0, '重复应用不得重复写入')
})

test('fork-config-lock: essence-runtime 不设只读（元主设置需要原子写 package.json）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-runtime-ro-'))
  const dir = path.join(root, 'profiles', 'essence-runtime')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), '{}', 'utf8')
  const out = setProfileConfigReadonly(dir, true)
  assert.equal(out.runtime, true)
  assert.equal(out.skipped, true)
  fs.writeFileSync(path.join(dir, 'package.json'), '{"enabled":true}', 'utf8')
  assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), '{"enabled":true}')
})

test('fork-config-lock: 配置文件只读/可解锁', () => {
  const dir = tmpProfile()
  fs.writeFileSync(path.join(dir, 'cordis.yml'), '[]\n', 'utf8')
  const locked = setProfileConfigReadonly(dir, true)
  assert.equal(locked.ok, true)
  assert.ok(locked.changed.includes('package.json') === false, '不存在的文件跳过')
  assert.ok(locked.changed.includes('cordis.patch.yml'))
  assert.ok(!locked.changed.includes('cordis.yml'), 'cordis.yml 不能只读：DSH 启动会写它')
  assert.throws(() => fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), 'x', 'utf8'), '只读后写入必须失败')
  setProfileConfigReadonly(dir, false)
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '[]\n', 'utf8')
})

test('fork-config-lock: DSH_FANG_FORK_CONFIG_LOCK=0 可关闭', () => {
  const dir = tmpProfile()
  const previous = process.env.DSH_FANG_FORK_CONFIG_LOCK
  process.env.DSH_FANG_FORK_CONFIG_LOCK = '0'
  try {
    const out = applyForkConfigLock(dir)
    assert.equal(out.skipped, true)
    assert.equal(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'), '[]\n')
  } finally {
    if (previous === undefined) delete process.env.DSH_FANG_FORK_CONFIG_LOCK
    else process.env.DSH_FANG_FORK_CONFIG_LOCK = previous
  }
})
