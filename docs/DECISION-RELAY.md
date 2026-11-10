# DECISION-RELAY — 会话内决策中继（v3.1.13）

## 目标

决策中心不再只在母体「收件箱」里处理：**每个会话自己**在右侧显示待决策入口，
用户在该会话里直接选 A/B/C/D 或输入决定，Agent 收到结果后继续任务。
总体界面仍在母体：收件箱（侧栏入口 + 右侧抽屉）保持原样，汇总所有会话/分身的待决策。

## 行为

1. **悬浮入口**：当前会话存在 `pending` 决策时，右侧边缘出现红色「◈ 待选 N」悬浮按钮；
   没有待决策时不显示（避免干扰）。入口只在**母体 Web** 注册——分身/元宝运行态不显示
   （决策由母体的收件箱统一处理）。
2. **从右向左滑出**：点击按钮，决策栏从右侧滑入（`translateX` 过渡 + 遮罩），`Esc` 或点遮罩关闭。
3. **按会话过滤**：只显示 `source.sessionId === 当前会话` 的 ticket；其他会话/分身的票留在收件箱。
4. **选择或输入**：
   - 预置选项按 **A/B/C/D** 标号显示（超过 4 个继续 E、F…），点击即提交 `option.value`；
   - 直接在输入框写决定（如“按 B 方案，先灰度 10%”），提交后作为 **custom decision**；
   - 无预置选项的 green/ack 票显示「确认收到（ACK）」。
5. 提交后按钮计数实时更新；没有待决策时按钮消失，面板提示为空。

## 服务端语义

`POST /fang/api/decisions/resolve` 新增可选字段 `custom`：

- 仅在**显式**传 `custom` 时生效（不是“任意未知 option 都放过”）；
- 去空白、上限 2000 字符；`resolvedOption = custom`、`resolvedPayload = {custom}`、
  `resolutionNote = custom`、ticket 标记 `customInput: true`；
- 未传 custom 的未知 option 仍按原逻辑拒绝（`unknown-option`，fail-closed）；
- Agent 的 `request_human_decision` 返回值 `selectedValue` 即用户输入/选项值，据此继续。

## 代码位置

| 文件 | 作用 |
|---|---|
| `client.js` | `mountDecisionRelay()`：悬浮按钮 + 右滑面板 + A/B/C/D + 自定义输入；slot `conversation.session.header.utilities`；store 新增 `resolveCustom()` |
| `src/plugins/decision-center.mjs` | `resolve()` 接受 `custom`；`publicTicket` 暴露 `customInput` |
| `src/plugins/orchestrator.mjs` | `/fang/api/decisions/resolve` 透传 `custom` |
| `test/decision-relay-dom.test.mjs` | 入口/面板/选项/自定义输入/会话过滤/fork 不挂载 |
| `test/decision-center.test.mjs` | custom 解析 + 未知 option 仍 fail-closed |

## 边界

- 只在母体 Web 的会话里出现；分身 Web 的决策仍在母体收件箱处理。
- 悬浮按钮依赖 DSH 会话 header utilities 槽与 sessionId 标准属性；DSH 大版本升级需回归对应 DOM 测试。
- 自定义输入会作为决定原文写入 ticket/审计，注意不要输入密钥等敏感信息。
