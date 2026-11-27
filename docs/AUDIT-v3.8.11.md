# v3.8.11 审计：状态对账与 500 可观测性

## 结论

| 问题 | 修复 | 验证 |
|---|---|---|
| task failed / meta running | `repairTaskMetaIfStale` 在 taskView 中同时检查 task 与 meta；task 有死 pid/port 或 meta 仍 running 都清 | 两条新增测试：meta-only 19444/18000；task-only 死 pid/port + meta stopped，`tasks.json` 与 meta 均清空 |
| 旧端口被元主运行态占用仍复用 | `reconcileOpenState` 读 meta，meta 端口参与 `portIsFree`，冲突标记 `stale-port-conflict` | 既有 stale-pid 测试改为覆盖 meta；新增 meta-only 测试 |
| 暂停时旧进程/旧窗口残留 | `pauseOtherForks` await stop、browser close 独立 try/catch、清 token、同步 meta | `fork-auto-paused` 审计新增 `browserCloseOk/stopOk/metaSynced` |
| handler-threw 无路由无堆栈 | `handlerFailure()` 返回 route/method/requestId/detail，并审计 `http-handler-threw` + stack | 新增测试：`/fang/api/tasks/archive` 抛错，500 body 与 audit 的 requestId 对齐 |

## 风险与边界

- `repairTaskMetaIfStale` 会在每次 `taskView` 读一次 `fang-meta.json`；只在 meta 与任务不一致时写回。
- 修复以任务注册表为准：若进程真实存活但 forker 状态未报告，仍可能被误判为 stale；当前以 `forker.status(...).running` 为 live 判据。
- `handler-threw` 的 stack 只写审计，不返回给浏览器；响应只返回 message。
