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

## 增补：元主 Web 界面收敛（并入 v3.1.22）

| 要求 | 实现 | 判定 |
|---|---|---|
| 元主不执行会话/任务/指令 | 隐藏 composer + 发送按钮；Enter 捕获拦截 | `mountEssenceUiLocks()` |
| 派生必须选会话 | `deriveTask()` 无 sessionId 且 role=essence → warn 并返回 | 面板层护栏 |
| 分身内不许新建会话 | `mountForkUiLocks()` NAV_TEXTS 加「新会话/新建会话」 | 与「插件」同样隐藏 + 点击拦截 |
| 隐藏工作区/新会话 | essence locks 侧栏隐藏清单 | `[data-fang-essence-locks="applied"]` |
| 默认落地插件设置页 | 首屏一次性点击侧栏「插件」 | `[data-fang-essence-landing="plugins"]` |

回归：`test/client-essence-locks.test.mjs`（4 例：隐藏/落地/输入区拦截/fork 不生效）。
