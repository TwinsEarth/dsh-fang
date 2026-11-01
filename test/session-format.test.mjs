// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T10 — 会话格式库单测（纯函数 + 注入 fs/zstd，不碰真实 $DSH_HOME）。
// 覆盖：sessionId 校验、workspace.json 容错解析、workspaceKey 编码、只 stat 扫描、
// 多帧 zstd 头读（只解第一帧）与四种预算降级、脱敏计数与四处泄漏面。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { tmpDir } from './helpers.mjs'
import {
  SESSION_ID_RE,
  SESSION_LOG_FILE,
  WORKSPACE_INDEX_FILE,
  HEAD_DEFAULTS,
  DIGEST_MAX_BYTES,
  isValidSessionId,
  emptyWorkspaceIndex,
  parseWorkspaceIndex,
  encodeWorkspaceKey,
  readBoundedHead,
  readBoundedEvents,
  extractSessionTitle,
  TITLE_DEFAULTS,
  redact,
  scanSessionDirs,
} from '../src/lib/session-format.mjs'

const FSA = {
  statSync: fs.statSync,
  readdirSync: fs.readdirSync,
  openSync: fs.openSync,
  readSync: fs.readSync,
  closeSync: fs.closeSync,
}
const ZSTD = zlib.zstdDecompressSync
const compress = (text) => zlib.zstdCompressSync(Buffer.from(String(text), 'utf8'))

const UUID_A = '11111111-2222-4333-8444-555555555555'
const UUID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const SESSION_A = `session-${UUID_A}`
const SESSION_B = UUID_B // 本机 v4 也有裸 uuid 目录

function writeLog(file, frames) {
  fs.mkdirSync(requireDir(file), { recursive: true })
  fs.writeFileSync(file, Buffer.concat(frames.map((f) => compress(f))))
}

function requireDir(file) {
  return file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')))
}

/** 造一个只有 sessions 树的 $DSH_HOME。 */
function makeSessionsRoot() {
  const root = tmpDir('fang-t10-fmt-')
  return root
}

function sessionFile(sessionsDir, workspaceKey, sessionId) {
  return `${sessionsDir}/${workspaceKey}/${sessionId}/${SESSION_LOG_FILE}`
}

// ── id 校验与常量 ───────────────────────────────────────────────────────────

test('sessionId: 接受 session-<uuid> 与裸 uuid，拒绝路径元字符', () => {
  assert.ok(SESSION_ID_RE instanceof RegExp)
  assert.equal(SESSION_LOG_FILE, 'session.v4.jsonl.zstd')
  assert.equal(WORKSPACE_INDEX_FILE, 'workspace.json')
  assert.equal(DIGEST_MAX_BYTES, 32 * 1024)
  assert.deepEqual(HEAD_DEFAULTS, { maxCompressedBytes: 262144, maxLines: 50, maxChars: 65536 })

  assert.equal(isValidSessionId(SESSION_A), true)
  assert.equal(isValidSessionId(SESSION_B), true)
  assert.equal(isValidSessionId(SESSION_A.toUpperCase()), true, '宽松：大小写不敏感')
  for (const bad of [
    '', '..', '../x', 'a/b', 'a\\b', 'C:\\Windows', '\\\\server\\x',
    'session-../../x', 'session-' + 'z'.repeat(36), `${SESSION_A}\0`, null, undefined, 42, {},
  ]) {
    assert.equal(isValidSessionId(bad), false, `必须拒绝 ${String(bad)}`)
  }
})

// ── workspace.json 解析 ─────────────────────────────────────────────────────

test('parseWorkspaceIndex: 真实 shape（unit/global/tables）解析出工作区与全局集', () => {
  const raw = JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      defaultWorkspaceId: 'ws-1',
      workspaceIds: ['ws-1'],
      archivedSessionIds: [SESSION_A, SESSION_A, 'bad/../x'],
      pinnedSessionIds: [SESSION_B],
    },
    tables: {
      workspaces: {
        'ws-1': { path: 'E:\\GPT', title: 'GPT', sessionIds: [SESSION_A, SESSION_B], createdAt: 'c', updatedAt: 'u' },
        'ws-2': { path: 'E:\\DSH', sessionIds: [] },
        'ws-3': { title: '无 path 的工作区' },
        'ws-4': { path: 'E:\\GPT', title: '重复 path' },
      },
    },
  })
  const idx = parseWorkspaceIndex(raw)
  assert.deepEqual(idx.degraded, [])
  assert.equal(idx.workspaces.length, 2, '无 path / 重复 path 被忽略')
  assert.deepEqual(idx.workspaces.map((w) => w.id).sort(), ['ws-1', 'ws-2'])
  const gpt = idx.workspaces.find((w) => w.id === 'ws-1')
  assert.equal(gpt.path, 'E:\\GPT')
  assert.equal(gpt.title, 'GPT')
  assert.deepEqual(gpt.sessionIds, [SESSION_A, SESSION_B])
  assert.equal(idx.workspaces.find((w) => w.id === 'ws-2').title, 'E:\\DSH', '缺 title 时回退 path')
  assert.equal(idx.global.initialized, true)
  assert.equal(idx.global.defaultWorkspaceId, 'ws-1')
  assert.deepEqual(idx.global.archivedSessionIds, [SESSION_A], '去重 + 非法 id 过滤')
  assert.deepEqual(idx.global.pinnedSessionIds, [SESSION_B])
})

test('parseWorkspaceIndex: 容错（空/坏 JSON/缺表/BOM/对象输入）', () => {
  const empty = emptyWorkspaceIndex(['empty'])
  assert.deepEqual(empty.workspaces, [])
  assert.deepEqual(empty.global.archivedSessionIds, [])

  for (const raw of ['', '   ', null, undefined]) {
    const out = parseWorkspaceIndex(raw)
    assert.deepEqual(out.workspaces, [])
    assert.ok(out.degraded.includes('empty'))
  }
  const bad = parseWorkspaceIndex('{not json')
  assert.deepEqual(bad.workspaces, [])
  assert.ok(bad.degraded.includes('invalid-json'))

  const noTable = parseWorkspaceIndex({ global: { archivedSessionIds: [SESSION_A] } })
  assert.deepEqual(noTable.workspaces, [])
  assert.ok(noTable.degraded.includes('no-workspaces-table'))
  assert.deepEqual(noTable.global.archivedSessionIds, [SESSION_A])

  const withBom = parseWorkspaceIndex(`\uFEFF${JSON.stringify({ tables: { workspaces: { w: { path: 'E:\\X' } } } })}`)
  assert.equal(withBom.workspaces.length, 1)
  assert.equal(withBom.workspaces[0].path, 'E:\\X')

  const arrayRaw = parseWorkspaceIndex([1, 2, 3])
  assert.deepEqual(arrayRaw.workspaces, [])
  assert.ok(arrayRaw.degraded.includes('invalid-shape'))
})

// ── workspaceKey 编码 ───────────────────────────────────────────────────────

test('encodeWorkspaceKey: 实测编码 --E-GPT--，仅显示用、拒绝反解假设', () => {
  assert.equal(encodeWorkspaceKey('E:\\GPT'), '--E-GPT--')
  assert.equal(encodeWorkspaceKey('E:\\DSH'), '--E-DSH--')
  assert.equal(encodeWorkspaceKey('C:\\Users\\fangw\\Documents\\deepseek-harness\\default-workspace'),
    '--C-Users-fangw-Documents-deepseek-harness-default-workspace--')
  assert.equal(encodeWorkspaceKey('E:/GPT/'), '--E-GPT--', '正斜杠 + 尾部分隔符归一')
  assert.equal(encodeWorkspaceKey('E:\\my  work'), '--E-my-work--', '连续非法字符折叠为单个 -')
  assert.equal(encodeWorkspaceKey(''), '')
  assert.equal(encodeWorkspaceKey(null), '')
})

// ── 只 stat 扫描 ────────────────────────────────────────────────────────────

test('scanSessionDirs: 只 stat 目录/日志，归档/置顶标记，跳过非法目录与缺日志', () => {
  const sessionsDir = makeSessionsRoot()
  try {
    const wsKey = encodeWorkspaceKey('E:\\GPT')
    const f1 = sessionFile(sessionsDir, wsKey, SESSION_A)
    const f2 = sessionFile(sessionsDir, wsKey, SESSION_B)
    writeLog(f1, ['{"type":"session"}\n'])
    writeLog(f2, ['{"type":"session"}\n'])
    fs.utimesSync(f1, new Date(1000), new Date(1000))
    fs.utimesSync(f2, new Date(2000), new Date(2000))
    // 干扰项：非法 session 名、缺日志的 session 目录、无 workspace 的 session 目录
    fs.mkdirSync(`${sessionsDir}/${wsKey}/not-a-session`, { recursive: true })
    fs.mkdirSync(`${sessionsDir}/${wsKey}/${'f'.repeat(8)}-${'0'.repeat(4)}-4000-8000-${'0'.repeat(12)}`, { recursive: true })
    fs.mkdirSync(`${sessionsDir}/--E-DSH--/${SESSION_A}`, { recursive: true })

    const found = scanSessionDirs({
      sessionsDir,
      workspaceIds: [wsKey],
      archivedSessionIds: [SESSION_A],
      pinnedSessionIds: [SESSION_B],
      fsApi: FSA,
    })
    assert.equal(found.length, 2, '非法名 / 缺日志目录不列出；只扫指定 workspace')
    const a = found.find((s) => s.sessionId === SESSION_A)
    const b = found.find((s) => s.sessionId === SESSION_B)
    assert.ok(a && b)
    assert.equal(a.workspaceId, wsKey)
    assert.equal(a.bytes, fs.statSync(f1).size)
    assert.equal(a.updatedAt, Math.round(fs.statSync(f1).mtimeMs))
    assert.equal(a.archived, true)
    assert.equal(a.pinned, false)
    assert.equal(b.archived, false)
    assert.equal(b.pinned, true)
    assert.equal(a.relPath, `${wsKey}/${SESSION_A}/${SESSION_LOG_FILE}`)
    assert.equal(found[0].sessionId, SESSION_B, '按 updatedAt 倒序（B 更新）')
  } finally {
    fs.rmSync(sessionsDir, { recursive: true, force: true })
  }
})

test('scanSessionDirs: workspaceIds 缺省扫全部；无 fsApi / 根不存在返回空数组不抛', () => {
  const sessionsDir = makeSessionsRoot()
  try {
    for (const ws of ['--A--', '--B--']) {
      writeLog(sessionFile(sessionsDir, ws, SESSION_A), ['{}\n'])
    }
    const all = scanSessionDirs({ sessionsDir, fsApi: FSA })
    assert.equal(all.length, 2)
    assert.deepEqual([...new Set(all.map((s) => s.workspaceId))].sort(), ['--A--', '--B--'])

    assert.deepEqual(scanSessionDirs({ sessionsDir }), [])
    assert.deepEqual(scanSessionDirs({ sessionsDir: `${sessionsDir}/nope`, fsApi: FSA }), [])
    assert.deepEqual(scanSessionDirs({}), [])
  } finally {
    fs.rmSync(sessionsDir, { recursive: true, force: true })
  }
})

// ── 有界头读（多帧 zstd） ───────────────────────────────────────────────────

test('readBoundedHead: 多帧只解第一帧，标记 first-frame-only，budget 内不出界', () => {
  const dir = makeSessionsRoot()
  try {
    const file = `${dir}/log.zstd`
    const frame1 = '{"type":"session","id":"s1"}\n{"type":"event","seq":0}\n'
    const frame2 = `${JSON.stringify({ type: 'event', seq: 1, data: 'x'.repeat(500) })}\n`
    writeLog(file, [frame1, frame2])
    const totalBytes = fs.statSync(file).size

    const head = readBoundedHead({ file, fsApi: FSA, zstdDecompressSync: ZSTD })
    assert.deepEqual(head.lines, ['{"type":"session","id":"s1"}', '{"type":"event","seq":0}'], '只解第一帧')
    assert.equal(head.bytesRead, totalBytes, '预算够时读满整个（小）文件')
    assert.ok(head.degraded.includes('first-frame-only'), '多帧要如实告知调用方')
    assert.equal(head.lines.some((l) => l.includes('x'.repeat(10))), false, '不得解出第二帧内容')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('readBoundedHead: maxLines / maxChars / maxCompressedBytes 三种预算各自降级', () => {
  const dir = makeSessionsRoot()
  try {
    const file = `${dir}/log.zstd`
    const frame1 = Array.from({ length: 6 }, (_, i) => `line-${i}-${'a'.repeat(30)}`).join('\n') + '\n'
    writeLog(file, [frame1, 'tail-frame'])

    const linesCapped = readBoundedHead({ file, maxLines: 3, fsApi: FSA, zstdDecompressSync: ZSTD })
    assert.equal(linesCapped.lines.length, 3)
    assert.ok(linesCapped.degraded.includes('line-limit'))

    const charsCapped = readBoundedHead({ file, maxChars: 20, fsApi: FSA, zstdDecompressSync: ZSTD })
    assert.equal(charsCapped.lines.length, 1)
    assert.equal(charsCapped.lines[0].length, 19)
    assert.ok(charsCapped.degraded.includes('char-limit'))

    const compressedCapped = readBoundedHead({ file, maxCompressedBytes: 8, fsApi: FSA, zstdDecompressSync: ZSTD })
    assert.equal(compressedCapped.lines.length, 0, '第一帧都读不全 → 不给半截假内容')
    assert.ok(compressedCapped.degraded.includes('decompress-failed'), JSON.stringify(compressedCapped.degraded))
    assert.equal(compressedCapped.bytesRead, 8)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('readBoundedHead: 降级路径（空/缺文件/非 zstd/无 fsApi/无 zstd）都要如实标记', () => {
  const dir = makeSessionsRoot()
  try {
    const empty = `${dir}/empty.zstd`
    fs.writeFileSync(empty, Buffer.alloc(0))
    assert.deepEqual(readBoundedHead({ file: empty, fsApi: FSA, zstdDecompressSync: ZSTD }).degraded, ['empty'])

    const missing = readBoundedHead({ file: `${dir}/missing.zstd`, fsApi: FSA, zstdDecompressSync: ZSTD })
    assert.ok(missing.degraded.includes('read-failed'))
    assert.deepEqual(missing.lines, [])

    const plain = `${dir}/plain.jsonl`
    fs.writeFileSync(plain, 'plain-1\nplain-2\n')
    const plainOut = readBoundedHead({ file: plain, fsApi: FSA, zstdDecompressSync: ZSTD })
    assert.deepEqual(plainOut.lines, ['plain-1', 'plain-2'])
    assert.ok(plainOut.degraded.includes('not-zstd'))

    assert.ok(readBoundedHead({ file: plain }).degraded.includes('no-fs-api'))
    const zstdFile = `${dir}/needs-zstd.zstd`
    writeLog(zstdFile, ['first\n'])
    assert.ok(readBoundedHead({ file: zstdFile, fsApi: FSA }).degraded.includes('no-zstd'))
    assert.ok(readBoundedHead({}).degraded.includes('no-file'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── 脱敏 ────────────────────────────────────────────────────────────────────

test('redact: 凭证/邮箱/手机号/绝对路径全部替换并计数', () => {
  const cases = [
    ['token=abcdef123456', 'token=<redacted>'],
    ['{"token":"abcdef123456"}', '{"token":"<redacted>"}'],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def', 'Authorization: Bearer <redacted>'],
    ['key is sk-1234567890abcdef', 'key is <redacted>'],
    ['password=hunter2', 'password=<redacted>'],
    ['"api_key":"AKIA1234567890"', '"api_key":"<redacted>"'],
    ['secret: s3cr3t-value', 'secret: <redacted>'],
    ['mail me at dev@example.com', 'mail me at <email>'],
    ['call 13812345678 now', 'call <phone> now'],
    ['intl +8613812345678', 'intl <phone>'],
    ['open E:\\GPT\\dsh-fang\\a.mjs', 'open <path>'],
    ['{"cwd":"E:\\\\GPT\\\\x"}', '{"cwd":"<path>"}'],
    ['read /home/user/secret/file.txt', 'read <path>'],
    ['unc \\\\server\\share\\file', 'unc <path>'],
  ]
  for (const [input, expected] of cases) {
    const out = redact(input)
    assert.equal(out.text, expected, `输入: ${input}`)
    assert.equal(out.redactions, 1, `输入: ${input} 应恰好计 1 次脱敏`)
  }
})

test('redact: 多类混合计数 / 干净文本零改动 / 原始秘密不残留', () => {
  const text = 'token=topsecret123 mail dev@example.com path E:\\GPT\\x call 13812345678 token=second456'
  const out = redact(text)
  assert.equal(out.redactions, 5, '两个 token + 邮箱 + 手机号 + 路径')
  assert.equal(out.text.includes('topsecret123'), false)
  assert.equal(out.text.includes('second456'), false)
  assert.equal(out.text.includes('dev@example.com'), false)
  assert.equal(out.text.includes('E:\\GPT\\x'), false)
  assert.equal(out.text.includes('13812345678'), false)
  assert.ok(out.text.includes('<redacted>'))
  assert.ok(out.text.includes('<email>'))
  assert.ok(out.text.includes('<path>'))
  assert.ok(out.text.includes('<phone>'))

  const clean = 'no secrets here, just words'
  const cleanOut = redact(clean)
  assert.equal(cleanOut.text, clean)
  assert.equal(cleanOut.redactions, 0)
  assert.deepEqual(redact(''), { text: '', redactions: 0 })
  assert.deepEqual(redact(null), { text: '', redactions: 0 })
})

test('readBoundedEvents + extractSessionTitle: native session/title from a later frame', () => {
  const dir = tmpDir('fang-sf-title-')
  try {
    const file = path.join(dir, 'session.v4.jsonl.zstd')
    const frames = [
      JSON.stringify({ type: 'session', version: 4, id: 'session-x' }) + '\n',
      JSON.stringify({ type: 'session/title', seq: 7, data: { title: '  修复  dock 徽标 ', messageSeqs: [5] } }) + '\n',
      JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: '帮我修一下徽标' }] } }) + '\n',
    ]
    fs.writeFileSync(file, Buffer.concat(frames.map((fr) => zlib.zstdCompressSync(Buffer.from(fr, 'utf8')))))
    const decoded = readBoundedEvents({ file, fsApi: FSA, zstdDecompressSync: zlib.zstdDecompressSync })
    assert.equal(decoded.events.length, 3)
    const meta = extractSessionTitle(decoded.events)
    assert.equal(meta.title, '修复 dock 徽标', 'title is trimmed and whitespace-collapsed')
    assert.equal(meta.titleSource, 'session/title')
    assert.equal(meta.messageSeq, 5)
    assert.match(meta.preview, /帮我修一下徽标/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('extractSessionTitle: falls back to the first user message; empty input returns null', () => {
  const meta = extractSessionTitle([{ type: 'user/message', data: { content: [{ type: 'text', text: '  只读设计评审  ' }] } }])
  assert.equal(meta.title, '只读设计评审')
  assert.equal(meta.titleSource, 'first-user')
  assert.equal(extractSessionTitle([]).title, null)
  assert.equal(extractSessionTitle([]).titleSource, null)
})

test('readBoundedEvents: frame budget degrades honestly instead of pretending to have read everything', () => {
  const dir = tmpDir('fang-sf-title-cap-')
  try {
    const file = path.join(dir, 'session.v4.jsonl.zstd')
    const frames = [
      JSON.stringify({ type: 'session', version: 4 }) + '\n',
      JSON.stringify({ type: 'session/title', data: { title: 'later title' } }) + '\n',
    ]
    fs.writeFileSync(file, Buffer.concat(frames.map((fr) => zlib.zstdCompressSync(Buffer.from(fr, 'utf8')))))
    const decoded = readBoundedEvents({ file, maxFrames: 1, fsApi: FSA, zstdDecompressSync: zlib.zstdDecompressSync })
    assert.equal(decoded.framesDecoded, 1)
    assert.ok(decoded.degraded.includes('frame-limit'))
    assert.equal(extractSessionTitle(decoded.events).title, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
