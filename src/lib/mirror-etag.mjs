// SPDX-License-Identifier: AGPL-3.0-or-later
// dsh-Fang v3.0.1 — 母体镜像状态的条件 GET（ETag / If-None-Match，零依赖）。
//
// 目的：60 秒轮询在状态未变化时不传输完整体。
// ETag 只由“稳定字段”计算：diskUsageBytes 每次请求都在漂移（日志/临时文件），
// 必须排除，否则永远拿不到 304；客户端在 304 时沿用上一份状态（磁盘占用可能是几十秒前的值），
// 用户点「刷新」走 force 路径拿最新值。

import { sha256 } from '../kernel/index.mjs'

/**
 * 计算状态 ETag（强校验器，带引号）。
 * @param {Record<string, any>} status
 * @returns {string}
 */
export function computeMirrorStatusEtag(status) {
  const source = status !== null && typeof status === 'object' ? status : {}
  const meta = source.meta !== null && typeof source.meta === 'object' ? source.meta : {}
  const backups = Array.isArray(source.backups) ? source.backups : []
  const stable = {
    ok: source.ok !== false,
    currentVersion: source.currentVersion ?? null,
    officialLatest: source.officialLatest ?? null,
    updateAvailable: source.updateAvailable === true,
    meta: {
      version: meta.version ?? null,
      backupIntervalHours: meta.backupIntervalHours ?? null,
      lastBackupAt: meta.lastBackupAt ?? null,
      nextBackupAt: meta.nextBackupAt ?? null,
    },
    backups: backups.map(entry => ({
      id: entry?.id ?? null,
      version: entry?.version ?? null,
      kind: entry?.kind ?? null,
      bucket: entry?.bucket ?? null,
      createdAt: entry?.createdAt ?? null,
      sizeBytes: entry?.sizeBytes ?? null,
    })),
    activeEssenceCount: source.activeEssenceCount ?? 0,
    activeSessionCount: source.activeSessionCount ?? 0,
    // diskUsageBytes 刻意排除：持续漂移字段
  }
  return `"${sha256(JSON.stringify(stable)).slice(0, 24)}"`
}

/**
 * If-None-Match 匹配判断：支持逗号多值、`*`、弱校验前缀 `W/`（强比较语义下也接受弱值）。
 * @param {string|string[]|undefined} header
 * @param {string} etag 服务端计算的 ETag（带引号）
 * @returns {boolean}
 */
export function ifNoneMatchMatches(header, etag) {
  if (typeof header !== 'string') return false
  const candidates = header.split(',')
  const target = String(etag).trim()
  const normalizedTarget = target.startsWith('W/') ? target.slice(2) : target
  for (const raw of candidates) {
    const candidate = raw.trim()
    if (candidate.length === 0) continue
    if (candidate === '*') return true
    const normalized = candidate.startsWith('W/') ? candidate.slice(2) : candidate
    if (normalized === normalizedTarget) return true
  }
  return false
}

/**
 * 构造镜像状态响应（200 / 304）。
 * @param {Record<string, any>} status
 * @param {string|string[]|undefined} ifNoneMatch
 * @returns {{statusCode:number, headers:Record<string,string|number>, body:string|null, etag:string, notModified:boolean}}
 */
export function buildMirrorStatusResponse(status, ifNoneMatch) {
  const etag = computeMirrorStatusEtag(status)
  const notModified = ifNoneMatchMatches(ifNoneMatch, etag)
  const headers = {
    ETag: etag,
    'Cache-Control': 'no-cache, must-revalidate',
    'Content-Type': 'application/json; charset=utf-8',
  }
  if (notModified) return { statusCode: 304, headers, body: null, etag, notModified: true }
  const body = JSON.stringify(status)
  return {
    statusCode: 200,
    headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
    body,
    etag,
    notModified: false,
  }
}

export const _internals = Object.freeze({ stableFields: (status) => { const m = status?.meta ?? {}; return [status?.currentVersion, m.version, m.lastBackupAt, Array.isArray(status?.backups) ? status.backups.length : 0] } })
