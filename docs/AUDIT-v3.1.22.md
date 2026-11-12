# AUDIT v3.1.22

范围：3.1.21 上线后的两个缺陷修复（产物缺文件 / queue-journal 误采集自家 UI）。

| 项 | 位置 | 判定 |
|---|---|---|
| recover-queue 未发布 | `package.json#files` | 补入 `tools/recover-queue.mjs` |
| 自家按钮被当排队消息 | `queue-journal/client.js` | 扫描跳过 `[data-fang-entry]`；动作标签加入 恢复全部/队列 N/历史 N/清除 |
| 依赖版本 | `optionalDependencies` | `@twinsearth/dsh-fang-queue-journal: ^0.1.6` |

## 线上证据（3.1.21 生效后）

```text
D:\ToFuture\mirror\desktop\composer-journal-history.jsonl  存在，4 条快照
  其中捕获到真实排队消息正文（“用 queue-journal 的机制 A. 立刻恢复…”）
  说明「变化即写 + append-only 历史」在真实运行态生效
```
