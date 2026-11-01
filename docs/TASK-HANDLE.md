# TaskHandle（v2.6.7）

> 代码：`src/lib/task-handle.mjs`；单测：`test/task-handle.test.mjs`（20 项）。
> 组合：Forker（进程层）+ ForkClient（传输/命令层 + CommandCache 幂等）。
> 目标：把「创建/启动 fork → 连接 Adapter → 命令代理 → 崩溃重启后重连 → 停止/回收」
> 收进一个生命周期对象，Orchestrator 只操作 `TaskHandle`，不直接拼 spawn + client。
>
> 本仓库是纯 JS（`.mjs` + JSDoc）；与设计稿的 TS 形状一一对应，映射见 §7。

## 1. 分层

| 层 | 负责 | 不负责 |
|---|---|---|
| Forker（`src/plugins/forker.mjs`） | 端口池、profile 模板、spawn、崩溃退避/重启、stop/reap、内存 token | Adapter 协议、命令语义 |
| ForkClient（`src/lib/fork-client.mjs`） | connect、SSE、命令 inflight、command-done、超时、CommandCache 幂等 | 进程生命周期、端口/token 变化 |
| **TaskHandle** | 启动链、崩溃后的**重建连接**（新端口/新 token）、命令等待窗口、事件聚合、stop/recycle | HTTP/SSE 帧解析、命令副作用 |

关键区别：**ForkClient 处理「同一进程内的断线」；TaskHandle 处理「整个进程崩溃重启」**。
后者端口与 token 都可能变，必须重建 client，不能只靠 SSE 重连。

## 2. 状态机

```
idle ──start()──▶ starting ──spawn+connect成功──▶ running
                     │                              │
                     │ spawn/connect失败            │ fang/fork-crashed
                     ▼                              ▼
                  failed ◀──── restart超时      reconnecting
                     ▲            │                 │
                     │            │                 │ fang/fork-started + connect成功
                     │            │                 ▼
                     └────────────┴──────────────  running

任意状态 ──stop()──▶ stopping ──forker.stop──▶ stopped
                      recycle = stop + forker.reap
```

- `failed` 是终态：不再自动恢复；需要 `recycle()` 后重建。
- `reconnecting` 可恢复：命令代理最多等 `commandWaitMs`（默认 5s），超时 reject。
- `stop` / `recycle` 幂等；`start` 幂等（重复调用返回同一 promise）。

## 3. 崩溃恢复流程

```
Forker 子进程退出
  └─ bus: fang/fork-crashed { forkId, kind, code }
       └─ TaskHandle: emit crashed → state=reconnecting → 断开旧 client
            └─ waitForRestart()            // 事件优先 + status 轮询兜底
                 ├─ bus: fang/fork-started         → forker.status() running/url
                 ├─ bus: fang/fork-restart-failed  → terminal=true 时立即失败
                 └─ 或 poll forker.status()        // 覆盖事件丢失/重启很快的情况
            └─ 重新读 forker.adapterToken(taskId)（spawn 时已换新 token）
            └─ 用新 url + 新 token 建 ForkClient → connect
                 └─ state=running → 唤醒等待中的命令 → emit reconnected
```

- **token 来源**：Forker 在每次 `spawn`（含 restart）时用 `randomBytes(24)` 生成新 token，
  只存在内存（`adapterToken(forkId)`），不写 `fang-meta.json` / `forks.json`；
  `stop` 立即置空。TaskHandle 每次重建 client 都重新读取，所以重启后不会 401。
- **事件缺失兜底**：`waitForRestart` 同时轮询 `forker.status`，不依赖单一事件。
- **v2.7.3 重启失败事件**：Forker 在自动重启失败 / 放弃重启时发
  `fang/fork-restart-failed { forkId, error, terminal }`：
  - `terminal=true`（放弃重启、无 CLI）→ TaskHandle 立即 `failed`，不等 `restartTimeoutMs`；
  - `terminal=false`（本次尝试失败、Forker 还会再试）→ 只记日志并继续 `reconnecting`，
    由后续 `fork-started` 或轮询兜底推进（避免把「还会重试」误判为终态）。
  - `stop()` 已有 `restartSlot.finish(stopping)`，会立即打断等待，不会挂到超时。

## 4. API

```js
const handle = new TaskHandle({
  taskId,
  forker,                       // fangForker 服务
  createClient,                 // 默认 createForkClient，可注入
  spawnOptions: { homeDir, profile, cliPath, env }, // fork 未运行时 start() 会 spawn
  eventSource: bus,             // 默认 kernel bus（可注入用于测试）
  commandWaitMs: 5000,
  restartTimeoutMs: 60000,
  pollMs: 250,
  logger,
})

await handle.start()            // idle → running
await handle.start()            // 幂等
handle.status                   // 'idle'|'starting'|'running'|'reconnecting'|'stopping'|'stopped'|'failed'
handle.taskMeta                 // forker.status(taskId) 的快照（含 url/pid/port）

await handle.command('ping', {})                    // 通用命令
await handle.flushBuffer({ strictMs: 2000 })         // 9 个便捷方法
await handle.scorePlugin({ pluginId: 'p' })
await handle.approvals()
await handle.getState() / getCursor() / getInflightCount()

handle.onEvent((envelope) => {})       // SSE 事件
handle.onTaskEvent((event) => {})      // status-changed / crashed / restarting / reconnected / failed

await handle.stop({ graceful: true })  // 停进程、保留 fork home
await handle.recycle()                 // stop + forker.reap（删除 home）
await handle.dispose()                 // 只释放本地资源（不杀 fork）
```

命令在以下状态 fail-closed：

| 状态 | 行为 |
|---|---|
| `idle` | reject `task-not-started` |
| `stopping` / `stopped` | reject `task-stopped` / `task-stopping` |
| `failed` | reject `task-failed` |
| `reconnecting` | 最多等 `commandWaitMs`；恢复成功则执行，否则 `task-unavailable` |
| `running` 但 client 丢失 | reject `client-missing` |

## 5. 与 Forker 的接口约定

TaskHandle 依赖的 forker 方法（本仓库的 `fangForker` 服务）：

| 方法 | 用途 |
|---|---|
| `status(taskId)` | 判断 running / 拿最新 url/pid/port（重启后变化） |
| `adapterToken(taskId)` | v2.6.1 起的内存 token（每次 spawn 重新生成，stop 置空） |
| `spawn({ forkId, ...spawnOptions })` | start() 时 fork 未运行则派生（home 需已 provision） |
| `stop(taskId)` | stop() 时杀进程树并归还端口 |
| `reap(taskId)` | recycle() 时删除 fork home |

事件：`fang/fork-started`、`fang/fork-crashed`、`fang/fork-reaped`（kernel bus）。
**注意**：Forker 的自动重启默认 `supervise:false`（避免与 Orchestrator archive/reap 竞争）；
要观察 TaskHandle 的崩溃重连，需显式打开 supervise（Forker config）或由上层重启后重新 `start()`。

## 6. 测试清单（20 项，`test/task-handle.test.mjs`）

1. start：spawn → 用 forker token 建 client → running；
2. start：fork 已运行时不重复 spawn；
3. spawn 失败 → failed + task 事件；
4. token 缺失 → failed（fail-closed）；
5. connect 失败 → failed；
6. start 幂等：重复调用只 spawn/connect 一次；
7. 崩溃重连：新端口/新 token 重建 client，等待中的命令恢复；
8. 崩溃后重启超时 → failed，命令 reject task-failed；
9. stop：断开 client + forker.stop；幂等；
10. stop 时等待中的命令 reject task-stopping；
11. recycle：stop + reap；
12. SSE 断开不改变 TaskHandle 状态（进程仍在）；
13. client onReconnect 转发为 task 事件 reconnected；
14. 事件聚合：onEvent 转发 + handler 异常隔离；
15. 命令代理：op/payload 透传 + 便捷方法映射 ADAPTER_OP；
16. 未启动 / 已停止时命令 fail-closed；
17. dispose：释放订阅/client，不杀 fork；
18. v2.7.3：terminal `restart-failed` 立即 failed（不等超时）；
19. v2.7.3：非 terminal `restart-failed` 继续等待，后续 `fork-started` 恢复；
20. v2.7.3：taskId 不匹配的 `restart-failed` 被忽略。

## 7. TS 形状映射

| 设计稿（TS） | 本仓库（JS） |
|---|---|
| `Forker.fork(opts)` | `forker.spawn({ forkId, ...spawnOptions })`（home 需先 `provision`） |
| `Forker.kill(taskId)` | `forker.stop(taskId)` |
| `Forker.recycle(taskId)` | `forker.reap(taskId)` |
| `Forker.getToken` + `TokenRegistry` 事件 | `forker.adapterToken(taskId)`（每次 spawn 已换新 token） |
| `ForkHandle.meta` | `forker.status(taskId)` 快照 |
| `createClient({ baseUrl, token })` | `createClient({ url, adapterToken })`（url 自带 web token） |
| `loadPlugin/unloadPlugin/...` | `ping/status/flush-buffer/score-plugin/read-plugin/route-confirm/approvals/approval-decide/archive` |
| `onCrash/onStateChange` | `onTaskEvent((e) => …)`（kind: crashed/status-changed/…） |

## 8. 边界与未接线

- **未接线到 Orchestrator**：本仓库的 orchestrator 仍自己管理 tasks/fork；TaskHandle 目前是
  可独立使用的库 + 测试。下一步是把 createTask/archive/命令调用迁移到 TaskHandle。
- **supervise 默认关闭**：崩溃后没有自动 restart 时，TaskHandle 会等 `restartTimeoutMs` 后 failed；
  需要自动恢复就显式开启 Forker supervise（并处理与 archive/reap 的竞争）。
- **命令不缓冲**：重连窗口内命令等待有限时间后 reject；不把命令排队到恢复后执行（避免副作用时序问题）。
- **多实例**：同一个 taskId 只应有一个 TaskHandle；并发 start 已被 promise 幂等保护，但跨实例无锁。
- **dispose 与 stop**：dispose 只释放本地资源，不杀 fork；卸载宿主时由上层决定是否 stop。
- **token 安全**：token 只在 Forker 内存与子进程 env 中存在，不落盘、不进 meta.json、不写 URL。
