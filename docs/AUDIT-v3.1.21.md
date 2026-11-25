# AUDIT v3.1.21

范围：队列持久化（客户端采集 + 恢复 UI + 恢复工具），queue-journal 0.1.4 → 0.1.5。

## 变更清单

| 项 | 位置 | 判定 |
|---|---|---|
| 按会话键（不再塌缩 `/`） | `queue-journal/client.js` `resolveKey()` | slot SessionId → DOM → URL → sessionStorage 实例键 |
| 变化即写 | 同上 `scheduleSave()` / `commitSave()` | MutationObserver + 250ms debounce |
| 15s 兜底 | 同上 `setInterval(..., FALLBACK_MS)` | 覆盖 dock 重渲染后未被观察 |
| 关闭前 flush | `flushNow()` + pagehide/visibilitychange/beforeunload | `fetch(keepalive)` |
| 恢复 UI | `JournalDock` 的「历史 N」列表 | 每条快照独立「恢复」→ `POST /composer/queue` |
| 回读校验 | `verifySaved()` | 不一致/乱码 → 重试一次 + 诊断 |
| append-only 历史 | `src/lib/composer-journal.mjs` | `composer-journal-history.jsonl`，500 条上限 |
| 历史路由 | `src/plugins/orchestrator.mjs` | `GET /fang/api/composer/journal/history` |
| 恢复工具 | `tools/recover-queue.mjs` | 扫描 / JSON / dry-run / 写回 |
| 独立包上架 | `.github/workflows/release.yml` | queue-journal 0.1.5 publish 步骤（NPM_TOKEN） |

## 验证证据

```text
npm test  : 1089 tests / 1078 pass / 0 fail
新单测    : test/composer-journal-history.test.mjs（5 例，含 UTF-8 往返）
恢复工具  : node tools/recover-queue.mjs --data-dir <fang dataDir> → 正确列出历史并标注乱码
```

## 已知限制

- 已丢失且从未落盘的队列**无法找回**（本版只保证「以后不再丢」）。
- 恢复写入依赖官方 `/fang/api/composer/queue`，目标会话必须处于 live 状态（否则返回 `session-not-live`，快照保留待重试）。
