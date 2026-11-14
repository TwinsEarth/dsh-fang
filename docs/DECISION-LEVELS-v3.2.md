# 决策中心四色状态机（v3.2）

## 目标

让注意力等级真正驱动 Agent 流程，而不是只给 ticket 上色。红色仍是唯一的强制人工阻塞；黄/蓝有明确的有限等待窗口；绿色只留底，不制造提醒。

## 状态与字段

| 字段 | 含义 |
|---|---|
| `waitMode` | `human` / `grace-defer` / `grace-recommended` / `immediate` |
| `waitDeadlineAt` | Agent 流程等待窗口截止时间 |
| `expiresAt` | 归档期限；仅红色沿用，黄/蓝不再用它表示等待窗口 |
| `deferredAt` | 黄色已超时继续的时间；此时仍 `status=pending` |
| `autoResolved` / `autoReason` | 蓝/绿自动闭环及原因 |
| `lateResponse` | 黄色 deferred 后的人工补选 |

## 状态转移

```text
red     pending ──人工选择──> resolved（恢复执行）
yellow  pending ──3 分钟────> pending + outcome=deferred（Agent 继续）
                         └────人工补选──> resolved + lateResponse=true（执行动作）
blue    pending ──1 分钟────> resolved + autoResolved=true（推荐项，执行动作）
green   创建 ────────────────> resolved/acked + autoResolved=true（仅留底）
```

- 黄色超时**不变灰、不过期**，收件箱中保留操作按钮。
- 蓝/绿只通过既有 `resolve()` 执行已注册 action handler，不执行任意文本或代码。
- 蓝/绿自动执行结果继续写入 `ticket.execution`，可审计。
- 旧版 pending 票在升级后不会被追溯自动执行；只有带 `waitMode` 的新策略票参与自动调度。

## 收件箱与历史

- 每种颜色同时显示 pending 与已处理记录，pending 置顶。
- 灰色组只放过期/放弃等真正的灰色归档，不重复显示其他颜色历史。
- 绿色默认折叠，可在收件箱展开查询；不产生红色强提醒，也不占 pending 数。

## 验收

- 红色未选择不继续。
- 黄色窗口结束返回 `outcome=deferred, continueWithoutDecision=true, canAnswerLater=true`。
- 黄色补选后 `lateResponse=true`，动作真实执行。
- 蓝色窗口结束选择推荐项，`autoReason=blue-timeout`，结果落库。
- 绿色创建即闭环，`autoReason=green-immediate`，历史保留。
- 重启后黄色 deferred 与蓝色 resolved 均可恢复；临时测试目录清理后无残留。

## 优先级与风险（v3.2.2）

| 等级 | priority | risk |
|---|---|---|
| red | P0 | high |
| yellow | P1 | medium |
| blue | P2 | low |
| green | P3 | info |

- 字段随 ticket 落库，支持调用方覆盖；未知值回落到等级默认。
- 收件箱四色分组常驻，0 条也展示，避免“没有记录 → 完全看不到该等级”。
- `ask_user_choice` 默认红，但必须按风险显式选择黄/蓝/绿，不应全部用红色。
