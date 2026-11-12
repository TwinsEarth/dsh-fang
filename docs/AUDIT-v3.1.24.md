# AUDIT v3.1.24

范围：决策中心浮窗（会话右侧决策中继）的尺寸与交互改造。

| 要求 | 实现 | 判定 |
|---|---|---|
| 浮窗面积过大 → 1/3 高度 | `.fang-relay-panel{height:33vh;min-height:220px;bottom:12px}` | CSS |
| 不影响会话/工作区 | 去掉全屏遮罩（`.fang-relay-backdrop{display:none}`），面板仅占右下角 | CSS |
| 选完自动收起为小浮标 | `submitOption`/`submitCustom` 成功后 `setOpen(false)` | 代码 |
| 点其他地方自动收起 | `pointerdown` 捕获：命中面板/FAB 外 → `setOpen(false)` | 代码 |

回归：`test/client-decision-relay.test.mjs`（3 例，jsdom）。

## 决策中心可见性 / 自动化（v3.1.24 追加）

| 反馈 | 根因 | 修复 |
|---|---|---|
| 会话工作区没有浮窗 | 中继浮标仅在「当前会话有 pending」时显示，0 条时 `hidden` | 入口常驻，0 条时半透明 + 计数 0 |
| 瓮城-收件箱没消息 | 重启恢复把 pending 全改 `expired/gray`，持久化后收件箱空白 | 未过期 pending 保留，仅过期置灰 |
| 大模型不主动/不自动决策 | 只有 `autoAdvise`（只给建议，不落决策） | 新增 `autoDecide`（green/低风险/高置信度自动落决策；red/blocking 永不自动） |

回归：`test/decision-center.test.mjs`（79 例）+ `test/decision-relay-dom.test.mjs`（5 例）+ `test/client-decision-relay.test.mjs`（3 例）。
