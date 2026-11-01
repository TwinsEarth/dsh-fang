// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// 纯字符串路径工具：等价于运行时 `path.resolve` / `path.relative` 的判定部分，
// 不触碰文件系统。参考实现用它保证「沙箱内/外」判断可被任意宿主复用。
//
// 支持：`C:\a\b`、`C:/a/b`、`/a/b`、`a/b`、`./a`、`../a`。
// 不支持（如实声明）：UNC 前缀的规范化、符号链接/junction 的真实路径解析。

const DRIVE_RE = /^([a-zA-Z]:)(?:\/|$)/
const ABSOLUTE_RE = /^\/|^[a-zA-Z]:\//

/** 反斜杠统一成 `/`，折叠重复分隔符（不处理 `.`/`..`）。 */
function toPosix(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
}

export function isAbsolutePath(value: string): boolean {
  return ABSOLUTE_RE.test(value)
}

/**
 * 归一化绝对或相对路径：折叠 `.` / `..`，去掉尾部分隔符。
 * `caseInsensitive` 只影响盘符大小写（Windows 语义），不改变其余部分大小写。
 */
export function normalizePath(value: string, caseInsensitive = false): string {
  const posix = toPosix(value)
  let prefix = ''
  let rest = posix

  const drive = DRIVE_RE.exec(posix)
  if (drive) {
    const letter = drive[1] ?? ''
    prefix = `${caseInsensitive ? letter.toLowerCase() : letter}/`
    rest = posix.slice(prefix.length)
  } else if (posix.startsWith('/')) {
    prefix = '/'
    rest = posix.slice(1)
  }

  const out: string[] = []
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') {
        out.pop()
      } else if (prefix === '') {
        out.push('..')
      }
      continue
    }
    out.push(part)
  }

  const body = out.join('/')
  if (prefix === '') return body === '' ? '.' : body
  return body === '' ? prefix : `${prefix}${body}`
}

/** 相对路径按 root 解析；空值返回 null（调用方据此判「没有目标」）。 */
export function resolvePath(value: string, root: string, caseInsensitive = false): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (isAbsolutePath(trimmed)) return normalizePath(trimmed, caseInsensitive)
  return normalizePath(`${toPosix(root)}/${toPosix(trimmed)}`, caseInsensitive)
}

/** 目录 + 文件名拼接（不做归一化以外的判断）。 */
export function joinPath(dir: string, name: string, caseInsensitive = false): string {
  return normalizePath(`${toPosix(dir)}/${toPosix(name)}`, caseInsensitive)
}

/**
 * child 是否在 parent 之内（含相等）。
 * child/parent 都应先经 normalizePath/resolvePath 处理。
 */
export function isWithin(child: string | null, parent: string | null, caseInsensitive = false): boolean {
  if (child === null || parent === null) return false
  let c = normalizePath(child, caseInsensitive)
  let p = normalizePath(parent, caseInsensitive)
  if (caseInsensitive) {
    c = c.toLowerCase()
    p = p.toLowerCase()
  }
  if (c === p) return true
  const withSep = p.endsWith('/') ? p : `${p}/`
  return c.startsWith(withSep)
}
