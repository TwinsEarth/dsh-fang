# v3.8.11 发布记录：状态对账与 handler-threw 可观测性

- 日期：2026-11-25
- 基线：v3.8.10
- 主题：修复 task / fang-meta / 端口三方不一致，让 500 不再吞掉路由与真实原因

## 问题

真机出现：

- `tasks.json` 中 task 已 `failed`、`pid=null`、`port=null`、`adapter.error=auto-paused-memory`；
- 同一时刻 18000 已由元主运行态（`--profile essence-runtime`）接管；
- 该 task 的 `fang-meta.json` 仍写 `status=running, pid=19444, port=18000`；
- UI 对该 task 执行打开/启动/修复时，异常被统一包装成 `handler-threw`，响应里没有路由、requestId 与堆栈。

## 修复

1. **500 可观测**：`route` 与 `routeMethods` 的 catch 改为 `handlerFailure()`，返回并审计 `route`、`method`、`requestId`、`detail`、`stack`（截断 3000 字符）。响应新增 `route` / `method` / `requestId`。
2. **meta 自动对账**：`taskView` 每次读任务前检查 `fang-meta.json`；没有 live 进程但 meta 仍写 running/pid/port 时，以任务注册表为准清空，并审计 `fork-meta-reconciled`。
3. **打开/恢复对账纳入 meta**：`reconcileOpenState` 不再只看 task 字段，也读 `fang-meta.json`；meta 里的旧端口也参与 `portIsFree` 探测，被元主运行态占用时标记 `stale-port-conflict`，绝不复用。
4. **暂停等待真实停止**：`pauseOtherForks` 现在 `await f.stop(id)`，关浏览器与停进程各自 try/catch 并审计；清 token、同步 meta，`fork-auto-paused` 记录 `browserCloseOk` / `stopOk` / `metaSynced`。
5. **meta 写失败可见**：`syncTaskMeta` 写失败写 `fork-meta-write-failed` 审计，不再静默返回 false。

## 行为变化

- 打开/启动/修复时，若 meta 还声称占用 18000，会先清成 failed/null，再由 restore 申请新端口。
- 500 响应可直接看到 `route` 与 `requestId`，并能在审计链中按 requestId 找到堆栈。
- 暂停其他分身时，不再出现“任务已 failed 但旧进程/meta 还在跑”的窗口。

## 产物

- `dist/dsh-fang-3.8.11.tgz`：938,425 bytes，229 entries
- SHA-256：`0ca82a4d8b6c588691bf3ad01d2a8bde93b76ccbb888da2ff207a0c60602f667`

## 测试

- 新增 `open-fork-preflight` 三条：failed + 无端口但 meta 仍 running → `listTasks()` 修复；task 仍留死 pid/port 但 meta 已 stopped → `tasks.json` 也清空；handler 抛错 → 500 带 route/method/requestId 并落审计。
- 全量：1571 tests / 1548 pass / 0 fail / 13 skipped / 10 todo。
