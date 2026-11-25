// SPDX-License-Identifier: AGPL-3.0-or-later
// 把 fang 注册表 JSON 里的绝对路径前缀从旧布局改到新布局（结构化解码，不做字符串替换）。
// 用法：node tools/rewrite-fang-paths.mjs --file <tasks.json> --from <旧目录> --to <新目录>
import fs from 'node:fs'

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 ? String(argv[i + 1] ?? '') : ''
}
const file = arg('file')
const from = arg('from').replace(/[\\/]+$/, '')
const to = arg('to').replace(/[\\/]+$/, '')
if (!file || !from || !to) {
  console.error('usage: --file <json> --from <oldPath> --to <newPath>')
  process.exit(2)
}
let doc
try { doc = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) {
  console.error('not-json: ' + error.message)
  process.exit(3)
}
let changed = 0
const walk = (node) => {
  if (Array.isArray(node)) { for (const item of node) walk(item); return }
  if (!node || typeof node !== 'object') return
  for (const key of Object.keys(node)) {
    const value = node[key]
    if (typeof value === 'string' && value.startsWith(from)) {
      node[key] = to + value.slice(from.length)
      changed += 1
    } else {
      walk(value)
    }
  }
}
walk(doc)
if (changed > 0) {
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8')
}
console.log(JSON.stringify({ ok: true, file, changed, from, to }))
