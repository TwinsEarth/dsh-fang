# dsh-Fang v3.1.13 发布说明

- 版本：`3.1.13`（v3.1.12 已按人类要求不发布，由本版取代）
- 主题：决策中心深入每个会话 —— 右侧「待选」悬浮入口 + 从右向左的决策栏。

## 功能

1. **总收件箱仍在母体**：侧栏「收件箱」入口 + 右侧抽屉不变，汇总所有会话/分身的待决策。
2. **每个会话的悬浮入口**：母体 Web 中，当前会话有待决策时右侧边缘出现红色
   「◈ 待选 N」按钮；没有待决策时不显示。
3. **从右向左滑出决策栏**：
   - 只列出当前会话的 ticket；
   - 预置选项按 **A/B/C/D** 标号，点击即提交；
   - 也可以直接输入决定（例如“按 B 方案，先灰度 10%”）提交，Agent 收到后继续；
   - 无选项的绿票显示「确认收到（ACK）」；Esc / 点遮罩关闭。

## 协议

`POST /fang/api/decisions/resolve` 新增可选 `custom` 字段（仅显式传值时生效，trim ≤2000）：
`resolvedOption = custom`、`resolvedPayload = { custom }`、`resolutionNote = custom`、
ticket `customInput = true`。未传 custom 的未知 option 仍被拒绝（fail-closed）。

## 升级

```bash
pnpm add @twinsearth/dsh-fang@3.1.13
```

按 `docs/WORKFLOW-UI.md` §5：先停 DSH host、备份 profile、候选包冒烟后再升级/重启。
升级后进入任一有 pending 决策的会话，右侧会出现「待选」按钮。

## v3.1.12 处置

v3.1.12 的 npm/GitHub Release 已由上一轮流程产出，但按人类要求不作为正式版本：
- npm 3.1.12 标记 deprecated（提示升级 3.1.13）；
- GitHub Release v3.1.12 页面删除（tag 保留）；
- `latest` 以 3.1.13 为准。

## 边界

- 决策中继只在母体 Web 的会话内出现；分身/元宝运行态的决策仍由母体收件箱统一处理。
- 自定义决定会原文写入 ticket 与审计，不要输入敏感信息。
