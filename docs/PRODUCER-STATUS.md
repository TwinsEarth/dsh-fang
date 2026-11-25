# 业务生产者状态（canonical）

> 单一事实来源：用于结束“同一矩阵反复审计”。代码与测试为准，不以 UI/旧 bundle 为准。

## 状态定义

| 状态 | 含义 | 判定条件 |
|---|---|---|
| ✅ 已接 | 业务系统本体已经调用决策中心 | 1) 本仓有调用点；2) 有测试覆盖；3) 不依赖人工点击 |
| 🟡 客户端/契约就绪 | 决策中心侧入口完成，但本体未调用 | 有 client/CLI/tool/adapter/ingest，且测试覆盖；外部进程尚未调用 |
| ❌ 无本体 | 本仓没有该系统的任何代码/进程 | 无法接线；只能提供契约 |

## 当前矩阵

| 生产者 | 状态 | 证据 |
|---|---|---|
| umbrella ASK | ✅ 已接（双写，非统一调度） | `lib/umbrella.mjs`；母体 submit；fork 走 outbox；`test/umbrella.test.mjs`、`test/umbrella-fork-outbox.test.mjs` |
| MirrorUpgrade | ✅ 已接（失败侧） | `orchestrator.mjs`；failure/compat/throw → ticket；`test/orchestrator.test.mjs`；真实成功仍缺官方源 adapter |
| EssenceManager | ✅ 已接 | `orchestrator.mjs syncEssences`；真实 conflict/failed 测试；计数数组 bug 已修 |
| PM ask_user_choice | ✅ 已接 | `decision-center.mjs` 工具，强制红；`test/decision-center.test.mjs` |
| HarnessMM | ❌ 无本体 | 无文件/服务；契约与客户端就绪（`producer-contract.mjs`、`decision-ingest-client.mjs`） |
| PluginUpdater | ❌ 无本体 | 本仓只有 PLAN/文档，无升级流水线代码 |
| SuperAgent | ❌ 无本体 | 本仓无该上层系统 |
| PJM 超时 / 致命错误 | 🟡 客户端就绪 | `report_pjm_timeout` fork tool、`pjm-timeout`/`pjm-fatal` 契约、ingest client/CLI；**PJM 进程未调用** |
| Worker 跑偏 | 🟡 客户端就绪 | `report_worker_deviation` fork tool、`worker-deviation` 契约、ingest client/CLI；**Worker 进程未调用** |

## 🟡 → ✅ 的唯一条件

```text
1. 在业务系统事件处加入一行调用（submit / CLI / fork tool / adapter op）
2. 加一条测试证明该调用会真正发送
3. 不依赖 UI 人工操作
```

调用统一样例见 [docs/PRODUCER-CONTRACT.md](PRODUCER-CONTRACT.md)。

## 不许声称的

- 有工具/契约 ≠ 已接；
- 运行中宿主的旧 bundle 看不到新路由，不等于仓库未实现；
- 没有外部进程代码时，不能把 🔴/🟡 改成 ✅。

## 最近验证

- 全量：979 tests / 968 pass / 0 fail / 1 skip / 10 todo
- 路由数：84；`fangctl verify` ok
- 未提交 / 未推送 / 未发布
