# AUDIT v3.2.0

范围：决策中心四色流程语义与收件箱/历史展示。

## 需求对照

| 需求 | 实现 | 验证 |
|---|---|---|
| 红色强制暂停，人工选择后继续 | `waitMode=human`，无自动代选 | red wait 测试 |
| 黄/蓝/绿在历史与收件箱可见 | 各颜色组同时展示 pending 与已处理记录 | jsdom 四色历史测试 |
| 黄色等 3 分钟后跳过，之后仍可补选 | `deferredAt`，保持 pending，`lateResponse` | defer + late action 测试 |
| 蓝色等 1 分钟后按推荐执行 | 定时自动 resolve 推荐项并运行 action | blue execution 测试 |
| 绿色自动执行，不提醒但留底 | 创建即闭环，created 事件即为 resolved | green + DOM 测试 |

## 安全与兼容

- 自动执行仍复用 `resolve()` 与 action handler 白名单；不执行任意代码。
- 红色不被 AI、批量处理或超时自动选择。
- 旧版 pending 不做追溯自动执行；新策略状态持久化到 `decision-center.json`。
- 无新增 HTTP 路由，继续沿用 `/fang/api/decisions/*` 的现有鉴权。

## 回归

```text
decision-level-policy      8 例（新增）
client-inbox-dom          16 例（含四色历史，真实 jsdom）
decision-center + fork    83 例
decision-action-integration 1 例
```
