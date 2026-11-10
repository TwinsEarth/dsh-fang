# AUDIT v3.1.13

> 版本：3.1.13（2026-11-11）
> 范围：决策中心深入每个会话（右侧悬浮入口 + 从右向左决策栏 + 选项/自定义输入）。

## 1. 需求

1. 总界面保持在母体（收件箱）；
2. 每个会话右侧有「中继悬浮图标（待选按钮）」；
3. 点击后从右向左滑出决策栏，用户选 A/B/C/D 或输入文字完成该会话的决策，
   让 Agent 按用户要求继续任务。

## 2. 实现

### 客户端（client.js）

| 点 | 实现 |
|---|---|
| 挂载点 | `conversation.session.header.utilities`（session scope，标准 props 含 `sessionId`），DomMount 自身隐藏，按钮/面板用 portal 挂到 `document.body` |
| 角色限制 | `detectWebRole() === 'mother'` 才创建；分身/元宝运行态不显示（决策归母体收件箱） |
| 悬浮入口 | `position:fixed; right:18px; top:52%` 的红色「◈ 待选 N」按钮；仅当前会话有 pending 时显示 |
| 面板 | `position:fixed` 右侧抽屉，`translateX(102%) → 0` 过渡 + 遮罩；Esc/遮罩关闭；面板内实时随 store 更新 |
| 过滤 | `relayPendingFor(store, sessionId)`：只取 `ticket.source.sessionId === 当前会话` |
| 选项 | 按 A/B/C/D 标号（>26 显示数字）；点击 `store.resolve(id, option.value)` |
| 自定义 | 输入框 + 提交，`store.resolveCustom(id, text)`；空文本拒绝；提交后清空、刷新 |
| ACK | 无选项 ticket 显示「确认收到（ACK）」，提交 `__ACK__` |
| 清理 | disposer 移除按钮/遮罩/面板、取消 store 订阅与 keydown 监听 |

### 服务端

| 文件 | 改动 |
|---|---|
| `src/plugins/decision-center.mjs` | `resolve(id, option, options)` 接受 `options.custom`：显式传值才走自定义；trim ≤2000；`resolvedOption=custom`、`resolvedPayload={custom}`、`resolutionNote=custom`、`customInput=true`；未匹配 option 且无 custom 仍 `unknown-option`；`publicTicket` 暴露 `customInput` |
| `src/plugins/orchestrator.mjs` | `POST /api/decisions/resolve` 把 `body.custom` 透传给 `resolve`/`resolveAction` |

## 3. 测试

```text
test/decision-relay-dom.test.mjs   5/5
  - 有 pending → 右侧「待选」按钮 + A/B 选项；点击 A → resolve(id,'a')
  - 自定义输入 → resolveCustom(id,text)；完成后按钮隐藏
  - 其他会话的 ticket 被过滤；无 pending 不显示
  - fork 角色 200ms 内不挂载
  - socket 接线（utilities 槽、resolveCustom、customInput/useCustom 字段）
test/decision-center.test.mjs      全部通过 + 新增 custom 用例
  - custom 解析：resolvedOption/customInput/resolutionNote
  - 未传 custom 的未知 option 仍被拒绝（fail-closed）
```

## 4. 发布与 v3.1.12 处置

- 按人类要求 **v3.1.12 不发布**：本版发布后
  - npm `@twinsearth/dsh-fang@3.1.12` 标记 **deprecated**（提示升级 3.1.13）；
  - 删除 GitHub Release `v3.1.12` 页面（tag 保留为历史，不移动）；
  - `latest` 由 v3.1.13 接管。

## 5. 边界

- 决策中继只在母体 Web 会话内出现；分身/元宝运行态的决策继续由母体收件箱统一处理。
- 自定义输入会原文写入 ticket/审计（`resolvedOption`/`resolutionNote`），不要输入密钥等敏感信息。
- 入口依赖 DSH `conversation.session.header.utilities` 槽与 `sessionId` 标准属性；DSH 大版本升级需回归 DOM 测试。
