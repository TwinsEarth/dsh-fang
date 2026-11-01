# ForkClient · 完整实现（v2.6.4）

> 代码：`src/lib/fork-client.mjs`；单测：`test/fork-client.test.mjs`（13 项）；
> 组合：`createAdapterClient()`（传输 + SSE）+ `CommandCache`（幂等）。
> 契约：`docs/PROTOCOL-V3.md`；缓存语义：`docs/COMMAND-CACHE.md`。
>
> 本仓库是纯 JS（`.mjs`，无 TypeScript 工具链）。本文给出 TS 接口形状与实现映射；
> 代码本身以 JSDoc 标注类型，可被 `tsc --allowJs --checkJs` 检查，但当前门禁是
> `node --check` + `node:test`（与仓库其它模块一致）。

## 1. 职责分层

| 层 | 负责 | 不负责 |
|---|---|---|
| `createAdapterClient()`（`adapter-client.mjs`） | 连接、协议协商、快照、SSE 解析、cursor、退避、409/410 | 命令语义、inflight、超时 |
| `CommandCache`（`command-cache.mjs`） | commandId 幂等、并发去重、LRU、失败契约 | trackingId 匹配、超时 |
| **`ForkClient`（本类）** | 命令 API、同步/异步分派、inflight、超时兜底、事件扇出 | HTTP 帧解析、SSE 状态机 |

一个关键语义：**异步命令的缓存结果是终态（command-done 之后），不是 202 accepted**。
如果缓存 accepted，重试会直接拿到 accepted 而跳过真正的等待，把「已接受」误报成「已完成」。

## 2. TypeScript 形状（与 `.mjs` 实现一一对应）

```ts
type CommandResult =
  | { ok: true; status?: 'accepted'; trackingId?: string; op?: string; result?: unknown; commandId?: string | null; async?: boolean }
  | { ok: false; code: string; error?: string }

interface ForkClientOptions {
  url?: string
  token?: string
  adapterToken?: string
  fetchImpl?: typeof fetch
  prefix?: string
  /** 直接注入传输层（测试 / 自定义 SSE 传输） */
  transport?: ForkTransport
  transportFactory?: (opts: Record<string, unknown>) => ForkTransport
  commandCache?: CommandCache
  cacheCapacity?: number
  synchronousTimeoutMs?: number      // 同步 POST 的传输超时（默认 30s）
  asynchronousTimeoutMs?: number     // 等 command-done 的超时（默认 120s）
  logger?: { debug?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void }
}

interface ForkTransport {
  lastState: unknown | null
  lastCursor: string
  connect(): Promise<{ ok: boolean; code?: string; fatal?: boolean } | void>
  stop(): Promise<void>
  commands(envelope: { commandId: string; op: string; payload: object; async?: boolean }): Promise<
    { ok: true; status: number; data: CommandResult } | { ok: false; status: number; error: string; kind?: string; data?: unknown }
  >
  onEvent(fn: (envelope: { event: { kind: string; [k: string]: unknown } }) => void): () => void
  onReconnect(fn: (payload: { resetCursor?: boolean; reason?: string } | boolean) => void): () => void
  onDisconnect(fn: (payload: { reason?: string; fatal?: boolean; retryable?: boolean }) => void): () => void
}

class ForkClient {
  constructor(options?: ForkClientOptions)
  connect(): Promise<unknown>
  disconnect(): Promise<void>
  command(op: string, payload?: object, options?: { commandId?: string; async?: boolean }): Promise<CommandResult>
  commandWithId(commandId: string, op: string, payload?: object, options?: { async?: boolean }): Promise<CommandResult>
  runCommand(commandId: string, op: string, payload?: object, options?: { async?: boolean }): Promise<CommandResult>

  // dsh-Fang Adapter 的 9 个 op 便捷方法
  ping / status / flushBuffer / scorePlugin / readPlugin / routeConfirm / approvals / approvalDecide / archive

  // 查询 / 订阅
  getState(): unknown | null
  getCursor(): string
  getInflightCount(): number
  readonly cacheStats: ReturnType<CommandCache['stats']>
  onEvent(fn: (envelope: unknown) => void): () => void
  onReconnect(fn: (payload: unknown) => void): () => void
  onDisconnect(fn: (payload: unknown) => void): () => void
}
```

## 3. 命令生命周期

```
dispatch() → cache.run(commandId, fn)
  ├── completed 命中 → 立即返回缓存结果（无 POST）
  ├── running 命中   → 等待同一个 promise（不重复执行）
  └── miss
       └── POST /adapter/commands
             ├── 2xx 且 body.status === 'accepted'
             │     → waitForCommandDone(trackingId)          // inflight Map
             │           ├── SSE command-done → resolve → cache 写终态
             │           ├── asyncTimeout    → reject(command-timeout) → cache 移除
             │           └── session 变化    → reject(session-changed) → cache 移除
             ├── 2xx completed → 返回 body → cache 写结果
             └── 传输错误 / 非 2xx → throw（code/status）→ cache 移除，可用同 commandId 重试
```

## 4. inflight 与 command-done 匹配

- `inflight: Map<trackingId, { commandId, op, resolve, reject, timer, startedAt }>`；
- **trackingId ≠ commandId**：commandId 是幂等键（同一次用户意图重试复用），trackingId 是
  Adapter 侧异步任务标识；重试后 commandId 不变但 trackingId 可能变，所以匹配只能用 trackingId；
- `command-done` 到达时 `resolveInflight(trackingId, result)`：清 timer、删表、resolve；
- 找不到对应 inflight（超时后迟到 / 断开后迟到 / 旧 session 残留）→ **静默忽略**，只记 `logger.debug`；
- 重复 trackingId（同一 trackingId 被两次 accepted）→ 第二个等待直接 reject `duplicate-tracking-id`；
- `command-progress` / `state-changed` / `approval-*` / `audit` / `error` 只做转发（`state-changed`
  同时更新本地快照），不 resolve inflight。

## 5. 超时矩阵

| 超时 | 位置 | 触发后 | 结果 |
|---|---|---|---|
| 同步 POST | 传输层 `createAdapterClient` 的 `timeoutMs`（默认 8s，可由 `synchronousTimeoutMs` 透传） | fetch abort | fn 抛错 → 缓存移除 → 重试重新执行 |
| 异步 command-done | `ForkClient` 的 `asynchronousTimeoutMs`（默认 120s） | timer 到期 | reject `command-timeout` → 缓存移除；迟到 command-done 静默忽略 |
| SSE 心跳 | 传输层 `heartbeatTimeoutMs` | 断开重连 | inflight 保留，等 cursor 补发 |

**为什么缓存层不实现超时**：缓存自己超时又移除，会留下「promise 还在执行但缓存已空」，
下一次 run 启动第二次执行，破坏幂等。超时必须发生在命令层（POST/等事件），让 fn 抛错。

## 6. SSE 生命周期与 inflight 处置

| 事件 | 来源 | 处置 |
|---|---|---|
| SSE 断开 | 网络抖动 | **inflight 保留**：cursor 续传会补发 command-done；`onDisconnect` 转发 |
| 重连 `resetCursor=false` | 同 session 续传 | 保留 inflight；`onReconnect` 转发 |
| 重连 `resetCursor=true` | 分身重启 / session 变了 | **所有 inflight reject `session-changed`**；`onReconnect` 转发 |
| `disconnect()` | 用户主动 | 取消订阅 → **所有 inflight reject `client disconnected`** → 停止传输层（幂等） |

## 7. 错误码（ForkClient 层）

| code | 触发 |
|---|---|
| `not-connected` | 未 connect 就 dispatch（fail-closed） |
| `disconnected` | disconnect 之后 dispatch / 等待 |
| `bad-command-id` | commandId 为空 |
| `missing-op` | op 为空 |
| `command-timeout` | 异步命令等待 command-done 超时 |
| `duplicate-tracking-id` | 同一 trackingId 被重复追踪 |
| `inflight-rejected` | disconnect / session 变化统一 reject |
| 传输错误码（`handler-threw` / `http-*` / `timeout` 等） | POST 失败原样带出（`transport: true`） |

## 8. 与 Adapter 的 op 对应

`ForkClient` 使用本仓库 Adapter 的 9 个 op（`ADAPTER_OP`）：
`ping` / `status` / `flush-buffer` / `score-plugin` / `read-plugin` / `route-confirm` /
`approvals` / `approval-decide` / `archive`。设计稿中的 `load-plugin` / `unload-plugin` /
`update-thresholds` / `set-task-meta` / `pause` / `resume` / `stop` 属于后续 Adapter op 扩展，
届时只需在 Adapter 侧加 handler、在 `ForkClient` 加一行便捷方法，分层不变。

## 9. 测试清单（13 项，`test/fork-client.test.mjs`）

1. 同步命令直通 + 同 commandId 命中缓存不重复 POST；
2. 异步 202 → 等 command-done → 缓存终态结果（不是 accepted）；
3. 异步超时 → `command-timeout`、inflight 清空、缓存移除可重试；
4. 传输层失败不缓存，同 commandId 重试重新执行；
5. SSE 断开保留 inflight，command-done 到达后 resolve；
6. session 变化（resetCursor=true）→ inflight 全部 reject；
7. 主动 disconnect → reject inflight + 停止传输层（幂等）；
8. stale command-done 静默忽略（debug）；
9. 重复 trackingId → duplicate-tracking-id；
10. 事件扇出隔离、state-changed 更新快照、订阅可取消；
11. connect 失败抛出带 code/fatal 的错误；未 connect 不能发命令；
12. 参数边界（空 commandId / 空 op / nextCommandId 唯一）；
13. 9 个 dsh-Fang op 便捷方法都走 runCommand/缓存。

## 10. 边界与遗留

- **TypeScript**：仓库没有 `tsc`/`tsconfig`，本实现是 `.mjs` + JSDoc。若要真正 `tsc` 编译，
  需要引入 TypeScript 工具链与类型声明（独立 PR），当前以 `node --check` + 测试作为可运行证据。
- **传输层**：默认用 `createAdapterClient()`（fetch SSE）。设计稿中的 `ForkSseClient`
  （裸 `node:http.request` + 手写解析）尚未实现；`ForkClient` 通过 `transport` 注入点已经为它留好位置，
  实现后只需替换默认工厂。
- **尚未接线**：Orchestrator 仍只用 `remote.mjs` 的 JSON 调用；`ForkClient` 的 inflight/事件流
  还没接到任务状态与 UI。
- **异步缓存语义**：缓存终态意味着「等待期间」的并发同 commandId 会合并到同一个本地 promise；
  跨进程重试仍依赖 Adapter 侧缓存（见 `docs/COMMAND-CACHE.md`）。
