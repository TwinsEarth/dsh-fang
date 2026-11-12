#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/recover-queue.mjs — 从瓮城的 composer journal 里找回草稿与排队消息。
//
// 用法：
//   node tools/recover-queue.mjs                      # 扫描默认目录，列出可恢复内容
//   node tools/recover-queue.mjs --data-dir <dir>     # 指定 fang dataDir（可多次）
//   node tools/recover-queue.mjs --scan-all           # 扫描 ~/.dsh/fang 下所有 dataDir
//   node tools/recover-queue.mjs --json               # 输出 JSON（便于脚本处理）
//   node tools/recover-queue.mjs --restore <url> --token <token> --session <sessionId> --index <n>
//        把第 n 条快照（默认最新）的队列写回官方队列：POST <url>/fang/api/composer/queue
//   --dry-run  与 --restore 搭配，只打印将要发送的内容
//
// 设计原则：只读扫描 + 显式恢复；默认不发送任何消息。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const readFlag = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? String(args[index + 1] ?? '') : ''
}
const has = (name) => args.includes(name)

const jsonOut = has('--json')
const scanAll = has('--scan-all')
const dryRun = has('--dry-run')
const dataDirs = []
for (let i = 0; i < args.length; i += 1) if (args[i] === '--data-dir' && args[i + 1]) dataDirs.push(args[i + 1])
if (scanAll || dataDirs.length === 0) {
  const roots = [path.join(os.homedir(), '.dsh', 'fang')]
  for (const root of roots) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const candidate = path.join(root, entry.name)
        // fang dataDir 里应有 endpoint.json / audit.jsonl / composer-journal.json 之一
        const markers = ['composer-journal.json', 'composer-journal-history.jsonl', 'audit.jsonl', 'endpoint.json']
        if (markers.some((marker) => fs.existsSync(path.join(candidate, marker)))) dataDirs.push(candidate)
      }
    } catch { /* 没有 fang 目录 */ }
  }
}

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}
const readLines = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}

const report = []
for (const dir of dataDirs) {
  const journalFile = path.join(dir, 'composer-journal.json')
  const historyFile = path.join(dir, 'composer-journal-history.jsonl')
  const journal = readJson(journalFile)
  const entries = []
  if (journal && typeof journal === 'object') {
    for (const [key, entry] of Object.entries(journal)) {
      const queue = Array.isArray(entry?.queue) ? entry.queue : []
      if (!entry?.draft && queue.length === 0) continue
      entries.push({ key, draft: String(entry?.draft || ''), queue, updatedAt: entry?.updatedAt || '', source: 'journal' })
    }
  }
  for (const snapshot of readLines(historyFile)) {
    const queue = Array.isArray(snapshot?.queue) ? snapshot.queue : []
    if (queue.length === 0) continue
    entries.push({
      key: String(snapshot?.key || ''),
      draft: String(snapshot?.draft || ''),
      queue,
      updatedAt: String(snapshot?.updatedAt || ''),
      sessionKey: String(snapshot?.sessionKey || ''),
      source: 'history',
    })
  }
  entries.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  report.push({ dataDir: dir, journalFile, historyFile, entries })
}

const restoreUrl = readFlag('--restore').replace(/\/+$/, '')
const restoreToken = readFlag('--token') || String(process.env.FANG_TOKEN ?? '')
const restoreSession = readFlag('--session')
const indexFlag = Number(readFlag('--index') || 0)

if (!jsonOut) {
  console.log(`扫描目录 ${dataDirs.length} 个`)
  for (const item of report) {
    console.log(`\n=== ${item.dataDir}`)
    console.log(`  journal: ${fs.existsSync(item.journalFile) ? item.journalFile : '(none)'}`)
    console.log(`  history: ${fs.existsSync(item.historyFile) ? item.historyFile : '(none)'}`)
    if (item.entries.length === 0) { console.log('  可恢复条目: 0'); continue }
    item.entries.forEach((entry, index) => {
      console.log(`  [${index}] ${entry.source} · key=${JSON.stringify(entry.key)} · ${entry.updatedAt} · queue=${entry.queue.length}${entry.draft ? ' · draft=' + JSON.stringify(entry.draft.slice(0, 40)) : ''}`)
      for (const queueItem of entry.queue.slice(0, 6)) {
        const text = String(queueItem?.text ?? '')
        const broken = /\?{3,}/.test(text)
        console.log(`        • ${JSON.stringify(text.slice(0, 120))}${broken ? '   ⚠ 疑似乱码（原文已丢失）' : ''}`)
      }
    })
  }
}

if (jsonOut) {
  console.log(JSON.stringify({ at: new Date().toISOString(), dataDirs, report }, null, 2))
  if (!restoreUrl) process.exit(0)
}

if (restoreUrl) {
  const flattened = report.flatMap((item) => item.entries.map((entry) => ({ ...entry, dataDir: item.dataDir })))
  const target = flattened[indexFlag]
  if (!target) { console.error(`没有第 ${indexFlag} 条可恢复记录（共 ${flattened.length} 条）`); process.exit(1) }
  if (!restoreSession) { console.error('恢复需要 --session <sessionId>（官方队列按会话恢复）'); process.exit(1) }
  const items = target.queue.map((queueItem) => ({ text: String(queueItem?.text ?? '').slice(0, 4000) })).filter((item) => item.text.trim())
  if (items.length === 0) { console.error('该快照没有可恢复的队列内容'); process.exit(1) }
  const payload = { sessionId: restoreSession, items }
  console.log(`\n准备恢复 ${items.length} 条 → ${restoreUrl}/fang/api/composer/queue（session=${restoreSession}）`)
  if (dryRun) { console.log('--dry-run：未发送'); process.exit(0) }
  if (!restoreToken) { console.error('恢复需要 --token 或环境变量 FANG_TOKEN'); process.exit(1) }
  const res = await fetch(`${restoreUrl}/fang/api/composer/queue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fang-auth': restoreToken },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  console.log(`HTTP ${res.status} ${text.slice(0, 200)}`)
  process.exit(res.ok ? 0 : 1)
}
