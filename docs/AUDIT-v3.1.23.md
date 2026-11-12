# AUDIT v3.1.23

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

## 增补：元主 Web 界面收敛（并入 v3.1.23）

| 要求 | 实现 | 判定 |
|---|---|---|
| 元主不执行会话/任务/指令 | 隐藏 composer + 发送按钮；Enter 捕获拦截 | `mountEssenceUiLocks()` |
| 派生必须选会话 | `deriveTask()` 无 sessionId 且 role=essence → warn 并返回 | 面板层护栏 |
| 分身内不许新建会话 | `mountForkUiLocks()` NAV_TEXTS 加「新会话/新建会话」 | 与「插件」同样隐藏 + 点击拦截 |
| 隐藏工作区/新会话 | essence locks 侧栏隐藏清单 | `[data-fang-essence-locks="applied"]` |
| 默认落地插件设置页 | 首屏一次性点击侧栏「插件」 | `[data-fang-essence-landing="plugins"]` |

回归：`test/client-essence-locks.test.mjs`（4 例：隐藏/落地/输入区拦截/fork 不生效）。

## 实机核查（真实元主 Host 3.1.23 + 无头浏览器）

```text
环境：临时 profile（不碰用户 profile），DSH_FANG_ROLE=fork + DSH_FANG_ESSENCE=1，端口 18240
页面：http://127.0.0.1:18240（元主 Web）

DOM 断言（实机）：
  data-fang-essence-locks = applied      PASS
  data-fang-essence-landing = plugins    PASS（默认落地插件设置页）
  「插件」入口可见                       PASS
  「新会话Ctrl+Alt+N」hidden             PASS
  「工作区」分组 + 工作区行 hidden       PASS
  输入区 textarea 可见数 = 0            PASS
  发送按钮可见数 = 0                     PASS
  底部提示横幅存在                       PASS
RESULT: PASS ✓ 实机生效
```

### 实机发现（已修）
1. 侧栏文案带快捷键后缀（`新会话Ctrl+Alt+N`）→ 原匹配漏掉，改为标签前缀匹配；
2. 「工作区」是分组标题 + 工作区行（不是按钮）→ 新增 `hideWorkspaceBlock()` 整段收起。
