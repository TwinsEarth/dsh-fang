// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// P2#7: bounded CDP metric history for the task card sparklines. The JSONL
// sample log remains the durable source; this ring is only the hot view.
export const BROWSER_METRIC_HISTORY_MAX = 60

function count(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

export function browserMetricPoint(input, at = Date.now()) {
  if (!input || typeof input !== 'object' || input.ok === false) return null
  const point = {
    at: Number(input.at ?? at),
    documents: count(input.documents),
    listeners: count(input.listeners),
    layoutCount: count(input.layoutCount),
  }
  if (!Number.isFinite(point.at) || point.at <= 0) return null
  return point
}

export function appendBrowserMetricHistory(history, point, max = BROWSER_METRIC_HISTORY_MAX) {
  const next = browserMetricPoint(point)
  if (!next) return Array.isArray(history) ? history.slice(-max) : []
  const prior = Array.isArray(history) ? history.filter((item) => browserMetricPoint(item)) : []
  const last = prior.length ? browserMetricPoint(prior.at(-1)) : null
  // A watchdog tick can arrive while a slow CDP sample is still in flight.
  // Do not duplicate the same timestamp; still keep one point per real sample.
  if (last && last.at === next.at) return prior.slice(-max)
  return [...prior, next].slice(-max)
}

export function browserMetricSeries(history, key) {
  return (Array.isArray(history) ? history : [])
    .map((item) => browserMetricPoint(item))
    .filter(Boolean)
    .map((item) => item[key])
    .filter((value) => Number.isFinite(value))
}
