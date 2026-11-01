# dsh-Fang v2.6.1 — Adapter v3 跨进程协议（母体 ↔ 分身）

> 适用：母体 DSH 与每个分身 DSH-Web 是两个进程，**不能共享 Cordis ctx / bus**。
> v3 在 v2 的五条端点上叠加「协议版本协商 / 状态快照 / SSE 事件流 / 幂等命令 / Bearer 认证」，
> **全部向后兼容**：旧端点保留，旧分身（无 v3 端点）按 legacy 协议继续工作。
>
> 代码：分身侧 `src/plugins/adapter.mjs`；共享协议库 `src/lib/adapter-protocol.mjs`；
> 母体侧客户端 `src/lib/remote.mjs`（JSON）与 `src/lib/adapter-client.mjs`（SSE + 重连）。
> 契约中的 `Adapter` = 分身侧；`ForkClient` = 母体侧 `createAdapterClient()`。

---

## 1. 定位

```
分身 DSH-Web 进程
┌────────────────────────────────────────────────────────────┐
│  Scorer / Router / Healer / Approver / HotReloader /       │
│  BufferKeeper / Auditor（业务插件，进程内）                  │
│        │  registerStateProvider / emit / onCommand          │
│        ▼                                                    │
│  Adapter（唯一“对母体可见”的基础设施插件，roleGate('adapter')）│
│        │  HTTP /fang/adapter/*（Bearer）                    │
└────────┼───────────────────────────────────────────────────┘
         │ 回环 TCP
         ▼
母体 DSH（role=mother）
  Orchestrator ── Forker（spawn + token 注入 + 进程生命周期）
        │
        └── Remote / AdapterClient（JSON 调用 + SSE 订阅）
```

三条硬边界：

1. **依赖单向**：外部世界 → Adapter → 业务插件。业务插件永不直接接触 HTTP；Adapter 不实现业务判断，只做协议与聚合。
2. **进程内接口与 HTTP 接口共享同一实现**（`hello/status/command/state/commands` 等 service 方法）；HTTP 层只做鉴权、方法校验、状态码映射。
3. **母体不接管孤儿**：母体重启后旧分身的 token 只存在于旧母体内存，新母体拿不到 → 401 自然拒绝；
   需要继续工作就**重建分身**（kill + fork），不做状态合并（见 §10）。

---

## 2. 通信方向与选型

| 方向 | 通道 | 理由 |
|---|---|---|
| 母体 → 分身：控制命令 | 普通 HTTP POST（`/commands`） | 低频、需要明确结果；不需要全双工 |
| 分身 → 母体：状态快照 | HTTP GET（`/state`） | 幂等、可恢复、可重试；母体/UI 任意时刻都能重拉 |
| 分身 → 母体：状态/审计/审批事件 | SSE（`/events`，单向推） | append-only 事件天然适合推；实现比 WebSocket 少一个数量级 |
| 审批 | SSE 下行 + POST 上行 | 审批请求走 `approval-requested` 事件，决议走 `approve-action` 命令，结果再以 `approval-resolved` 事件确认 |

**为什么不用 WebSocket**：母体→分身只有低频命令（load-plugin / promote / kill / 审批回写），POST 足够；
WebSocket 的心跳、重连、分帧、背压复杂度换不来收益。SSE 是 HTTP 原生、可被代理/浏览器理解、断线后天然靠 `Last-Event-ID` 或 `?since=` 续传。

**为什么审批不需要全双工**：审批 = 分身推「待批项」事件 → 母体 UI 展示 → 母体 POST 决议 → 分身推「已决」事件。
两段都是「单向流 + 回写」，最终一致性由事件流保证（命令响应只证明到达，事件才证明状态变化）。

---

## 3. 认证

### 3.1 凭证产生与传递

```
Forker.spawn(forkId)
  ├─ token = randomBytes(24).toString('hex')     // 48 hex 字符，每次 spawn 重新生成
  ├─ 只存在母体内存 rec.adapterToken（不写 forks.json / fang-meta.json / URL）
  ├─ child env: DSH_ADAPTER_TOKEN=<token>
  └─ return spawn 结果（token 不在返回值里）
Adapter.apply()
  ├─ token = Config.token || env.DSH_ADAPTER_TOKEN
  ├─ 非空 → 所有 /fang/adapter/* 请求必须带 Authorization: Bearer <token>
  └─ 为空 → v2 兼容模式（仍由 DSH web 自身的 ?token= 守卫）
母体 Remote/AdapterClient
  └─ 每个请求 header: authorization: Bearer <token>（URL 里仍带 DSH web 的 ?token=）
```

### 3.2 语义

| 场景 | 行为 |
|---|---|
| 无 `DSH_ADAPTER_TOKEN`（旧 Forker / 旧分身） | Adapter 不加认证层，沿用 DSH web `?token=`；母体不发 Authorization |
| 有 token，Header 缺失/错误 | `401 {ok:false,code:'unauthorized'}` |
| 比较方式 | `crypto.timingSafeEqual`，长度不等直接拒绝 |
| 母体重启、旧分身仍在跑 | 新母体没有旧 token → 401；**不尝试猜测/复用**，也不接管（§10） |
| Forker 重启分身 | `spawn()` 重新生成 token；旧 token 随旧进程一起作废 |

> 为什么 token 不落盘：`fang-meta.json` / `forks.json` 在 fork home 与数据目录里，分身自己可读；
> 任何落盘都等于把「母体身份」写进分身的可读范围。token 只在 spawn 时经 env 单向传一次。

### 3.3 为什么不把 token 放 URL

URL 会进日志、浏览器历史、`parseWebUrl` 的返回值、错误信息。v3 token 只走 Header；`?token=` 仍然只承担 DSH web 自己的会话令牌。

---

## 4. 版本协商

```ts
// src/kernel/types.mjs
export const ADAPTER_PROTOCOL_VERSION = 3
export const ADAPTER_PROTOCOL_MIN = 1
```

| 母体看到的 `protocol` | 判定 | 处置 |
|---|---|---|
| 1..3 | 兼容 | 正常握手，记录 `task.adapter.protocol` |
| > 3（分身比母体新） | `protocol-too-new` | **fail-closed**：`adapter.ok=false`，任务不进入 READY，不假装成功 |
| 缺失（旧分身 `/version` 404） | legacy | 按 v2 语义继续（hello 成功即 READY） |
| 母体主动设置 `min/max` | `protocol-too-old` / `protocol-too-new` | 拒绝对端 |

`GET /fang/adapter/version` 响应：

```json
{
  "ok": true,
  "protocol": 3,
  "minProtocol": 1,
  "version": "2.6.1",
  "sessionId": "s-3f7c9a12b4e8d650",
  "taskId": "task_...",
  "role": "fork",
  "capabilities": ["ping", "status", "flush-buffer", "..."],
  "at": "2026-11-01T10:00:00.000Z"
}
```

`hello()` 同时补充 `protocol` / `sessionId`（旧客户端忽略未知字段，前向兼容）。

**为什么不是“母体先查 DSH 版本再 fork”**：分身的 bundle 版本可能来自 profile 解析，母体只能看到 URL 和 stdout；
`/version` 是唯一由分身自己回答「我是谁、我说哪版协议」的地方，且必须在首帧快照之前。

---

## 5. 状态模型

### 5.1 快照（`GET /fang/adapter/state`）

```ts
interface StateSnapshot {
  ok: true
  sessionId: string          // 进程实例 id；每次进程启动都变（§10）
  protocolVersion: 3
  minProtocol: 1
  version: string            // FANG_VERSION
  role: 'fork'
  taskId: string
  status: 'running' | 'stopping'
  uptimeMs: number
  at: number                 // 分身时钟；母体只展示，不用于排序（cursor 才是顺序）
  metrics: {
    rssBytes: number | null
    heapUsedBytes: number | null
    handleCount: number      // process.getActiveResourcesInfo 计数
    cpu: { userMs: number; systemMs: number } | null
    activeSessions: number | null   // 没有 sessionCatalog 服务时为 null，不假装 0
    pid: number | null
  }
  services: Record<string, boolean>
  plugins: Array<{ pluginId: string; state: 'active' | 'unavailable' }>
  approvals: Array<{ approvalId: string; action: string; light: string | null; createdAt: number | null }>
  buffer: { state: string; pending: number; dirtyFiles: number; dir: string }
  audit: { records: number; head: string | number | null; degraded: string | null }
  archived: boolean
  lastCursor: string         // 快照对应的事件 cursor（母体订阅时从它开始）
  nextCursor: string
}
```

约束：

- **幂等**：同一状态重复 GET 返回等价结构（时间戳/指标除外）；
- **不写副作用**：GET 不产生事件（待审批 diff 在 GET 时只做「已见到」的登记，见 §6.3）；
- **显式降级**：依赖服务缺失时字段缺省为 `null` / `unavailable`，并用 `services` 标出，绝不假装 0。

### 5.2 事件（SSE 帧）

```ts
interface EventEnvelope {
  cursor: string      // uint64 十进制字符串（bigint 不能 JSON 序列化）
  sessionId: string
  at: number
  event: AdapterEvent
}

type AdapterEvent =
  | { kind: 'state-changed'; snapshot: StateSnapshot }        // 预留：大变更时带全量
  | { kind: 'plugin-state'; pluginId: string; state: string }
  | { kind: 'approval-requested'; approval: { approvalId: string; action: string; light: string | null; createdAt: number | null } }
  | { kind: 'approval-resolved'; approvalId: string; verdict: 'approve' | 'reject' | 'timeout' | 'resolved' }
  | { kind: 'audit'; event: { at: number; kind: string; detail: unknown } }
  | { kind: 'command'; op: string; ok: boolean; code: string | null; commandId: string | null }
  | { kind: 'command-done'; trackingId: string; op: string; result: CommandResult }
  | { kind: 'command-progress'; trackingId: string; progress: number; detail?: string }
  | { kind: 'error'; code: string; message: string }
```

已落地的 `kind`：`command`、`command-done`、`approval-requested`、`approval-resolved`、`error`。
`state-changed/plugin-state/audit/command-progress` 是协议预留（业务插件可通过进程内 `emit` 直接用）。

SSE 帧：

```
retry: 2000

: connected
id: 1
event: adapter
data: {"cursor":"1","sessionId":"s-…","at":1730000000000,"event":{"kind":"command","op":"ping","ok":true,"commandId":null}}

: heartbeat
```

- `id` 是 cursor；母体重连时显式带 `?since=<lastCursor>`（不依赖浏览器 `Last-Event-ID`）；
- 心跳是**注释帧**（`: heartbeat`），不占 cursor、不进审计流；间隔 `heartbeatMs`（默认 5s），同时驱动待审批 diff；
- 单帧上限 64KB（超限由业务插件拆成多个 `command-progress`，Adapter 不静默截断）；
- 母体侧解析器 `src/lib/sse-parser.mjs`（v2.6.5）：只按 `\n` 切行、行尾裁一个 `\r`、空行切帧、
  `flush()` 丢弃残帧；模糊测试见 `docs/FUZZ-SSE-PARSER.md`。

### 5.3 三种同步模式

| 模式 | 端点 | 幂等 | cursor | 用途 |
|---|---|---|---|---|
| 快照拉取 | `GET /state` | 是 | 无（返回 `lastCursor`） | UI 展示、首帧同步、410 后的回退 |
| 事件续传 | `GET /events?since=N&session=S` | 是 | 有 | 审计/审批/命令结果、断线追平 |
| 命令提交 | `POST /commands` | 由 `commandId` 保证 | 无 | 控制面：flush / approve / archive / score / read |

---

## 6. HTTP 接口清单（分身侧）

### 6.1 路由表

| 方法 | 路径 | 认证 | 幂等 | 用途 |
|---|---|---|---|---|
| GET | `${prefix}/adapter/hello` | Bearer（如启用） | 是 | v2 握手：role/taskId/version/capabilities（+protocol/sessionId） |
| GET | `${prefix}/adapter/status` | 同上 | 是 | v2 服务表/缓冲三态/待批数/审计头 |
| GET | `${prefix}/adapter/approvals` | 同上 | 是 | 待审批项 |
| GET | `${prefix}/adapter/audit?limit=n` | 同上 | 是 | 审计尾部 |
| POST | `${prefix}/adapter/command` | 同上 | 否（无 commandId） | v2 控制命令 `{op,payload}` |
| GET | `${prefix}/adapter/version` | 同上 | 是 | v3 协议协商 |
| GET | `${prefix}/adapter/health` | 同上 | 是 | 轻量健康检查（Forker.waitReady / 存活探测） |
| GET | `${prefix}/adapter/state` | 同上 | 是 | 完整快照 |
| GET | `${prefix}/adapter/events?since=N&session=S` | 同上 | 是 | SSE 事件流 |
| POST | `${prefix}/adapter/commands` | 同上 | 由 `commandId` | 幂等命令信封 |

`prefix` 默认 `/fang`（与母体 Remote 的 `prefix` 一致）。
> 设计稿里的 `/api/adapter/*` 在本仓库落为 `${prefix}/adapter/*`：避免与 DSH 自身的 `/api` 命名空间冲突，
> 且与 v2 五条路由同前缀、同 allow-list 规则（`tools/release/allowlist.mjs` 自动扫描）。

`GET /health` 响应：

```json
{ "ok": true, "status": "running", "pid": 7032, "taskId": "task_...", "sessionId": "s-…",
  "protocol": 3, "uptimeMs": 123456, "archived": false, "at": "…" }
```

### 6.2 命令信封与幂等

```ts
interface CommandEnvelope {
  commandId?: string   // /^[A-Za-z0-9._:-]{1,128}$/；缺省 = 不幂等（兼容 v2 用法）
  op: string           // ping / status / flush-buffer / score-plugin / read-plugin /
                       // route-confirm / approvals / approval-decide / archive
  payload?: object
  async?: boolean      // true → 202 Accepted，结果走 command-done 事件
}
```

语义（实现见 `src/lib/command-cache.mjs` / `docs/COMMAND-CACHE.md`）：

- **幂等**：同一 `commandId` 重试 → 直接重放第一次的响应，**不重复执行副作用**
  （`CommandCache`，容量 500，LRU 只淘汰已完成项）；重放响应带 `"deduplicated": true`；
- **并发合并**：同一 `commandId` 正在执行时再次提交 → 等待**同一个 promise**，不会执行两次；
  只有真正执行的那一次会发 `command` / `command-done` 事件；
- **失败契约**：业务失败（`fn` 返回 `{status:'rejected',code,message}`）与 async accepted
  都会被缓存；`fn` 抛错（传输/编程错误，命令可能没执行）不缓存并移除，重试才会重新执行；
- **同步**：返回 `200 {ok, op, result, commandId}`；
- **异步**：返回 `202 {ok:true, status:'accepted', trackingId, commandId, async:true}`，
  完成后推 `command-done {trackingId, op, result}`。`trackingId`（追踪）与 `commandId`（去重）是两个字段；
- **扩展命令**（v2.6.8）：插件可通过 `registerCommand(op, executor)` 注册新 op；executor 返回普通对象 =
  同步 200，返回 `{status:'accepted',trackingId}` = 202 + 自行 `emit command-done`；内置 op 不可覆盖。
  请求体上限 1 MB，超限 **413 `body-too-large`**（契约见 `docs/ADAPTER-COMMANDS.md`）；
- 同一次重试窗口内（分身未重启）幂等成立；跨进程重启不保证（见 §12 遗留决策）。

### 6.3 待审批 diff

批准项的「请求」没有母体可订阅的进程内事件（Approver 只发 decided），因此 Adapter：

1. 在 `GET /state`、`GET /status`、SSE 连接建立、每次 SSE 心跳时读取 `approver.pending()`；
2. 新出现的 id → `approval-requested`（一次）；
3. 消失的 id → `approval-resolved`（verdict 优先取 `fang/approval-decided` 总线事件，取不到为 `resolved`）。

这是**轮询 diff + 事件确认**的混合：请求侧轮询保证不丢，决议侧事件保证及时。

---

## 7. cursor 语义

- cursor 是单调递增 `uint64`，从 1 开始；JSON 里是十进制字符串（`"42"`），不接受 `01`/`-1`/`1.5`/超 uint64。
- 分身维护 ring buffer（默认容量 1000 条，`Config.eventCapacity`）。

| `since` | 结果 |
|---|---|
| `0` | 回放缓冲中最旧到最新；若最旧 cursor > 1 → `gap=true` |
| 缓冲内 | 返回 `cursor > since` 的事件，`gap=false` |
| 早于最旧一条 | `gap=true` → HTTP **410 `cursor-expired`**，母体回退 `GET /state` |
| 超前（`since >= nextCursor`） | `gap=true, reason='cursor-ahead'` → 410 |
| 非法 | HTTP **400 `cursor-invalid`** |
| `session` 与当前 `sessionId` 不同 | HTTP **409 `session-changed`**，母体重置 cursor 并重拉快照 |

410 响应示例：

```json
{ "ok": false, "code": "cursor-expired", "error": "cursor-expired",
  "sessionId": "s-…", "lastCursor": "42", "nextCursor": "51" }
```

---

## 8. 错误码 → HTTP 状态码

唯一来源：`ADAPTER_ERROR_STATUS`（`src/kernel/types.mjs`）。

| HTTP | code | 触发 | 母体处置 |
|---|---|---|---|
| 200 | — | 成功 | 直接使用 |
| 202 | — | 异步命令已接受 | 用 `trackingId` 等 `command-done` |
| 400 | `bad-request` / `invalid-json` / `invalid-payload` / `missing-op` / `unknown-op` / `path-escape` / `file-too-large` / `total-too-large` / `binary-file` / `cursor-invalid` / `command-id-invalid` | 参数/协议错误 | 记录，不重试 |
| 413 | `body-too-large` | 请求体超过 1 MB | 记录，不重试 |
| 401 | `unauthorized` | token 错误 | 标记 fork 不可信；**不重试** |
| 404 | `not-found` / `plugin-not-found` | 资源不存在 | 记录，不重试 |
| 409 | `session-changed` / `state-conflict` / `not-pending` / `service-unavailable` / `not-configured` / `conflict` / `timeout` | 状态冲突/依赖缺失 | `session-changed` 重置 cursor；其余记录 |
| 410 | `cursor-expired` | cursor 落后于 ring buffer | 回退 `GET /state` |
| 500 | `handler-threw` / `internal-error` | 分身内部异常 | 记录，通知编排器 |
| 503 | `not-ready` | 分身尚未就绪 | 退避重试 |
| 405 | `method-not-allowed` | 方法不匹配 | 记录 |

任何未登记 code 一律 500：宁可让母体看到明确失败，也不假装成功。

---

## 9. 母体侧 ForkClient（`createAdapterClient()`）

```ts
const client = createAdapterClient({
  url, token, adapterToken,          // token = DSH web ?token=；adapterToken = Bearer
  timeoutMs: 8000, prefix: '/fang',
  minProtocol: 1, maxProtocol: 3,    // 可选
  reconnect: { baseMs: 500, maxMs: 8000 },
  autoReconnect: true,
})

client.onEvent((envelope) => {})      // 每条 SSE 事件
client.onState((snapshot) => {})      // 首帧快照 / 410/409 后重拉
client.onReconnect(({ resetCursor, reason }) => {})   // 重连；resetCursor=true 必须清缓存
client.onDisconnect(({ reason, fatal, retryable }) => {})

const connected = await client.connect()
// { ok, protocol, sessionId, lastState, lastCursor }
// 或 { ok:false, code, fatal | retryable }

await client.state()                  // JSON 快照
await client.command('flush-buffer', { strictMs: 2000 })   // 自动生成 commandId + 重试一次
client.lastCursor; client.lastState; client.mode           // 'idle' | 'negotiating' | 'streaming' | 'reconnecting' | 'failed'
client.stop()
```

内部状态机：

```
idle ──connect()──▶ negotiating ──ok──▶ streaming
                        │                 │ SSE 断开/网络错误
                        │ 协议不兼容/401    ▼
                        ▼              reconnecting ──退避──▶ negotiating(重连)
                     failed
```

失败语义：**永不抛出**；网络/超时按 `baseMs * 2^n` 无限退避（上限 `maxMs`）；401 致命、不重试。

**ForkClient（v2.6.4 实现）**：`src/lib/fork-client.mjs` 在 AdapterClient 之上组合 `CommandCache`：

- `inflight: Map<trackingId, {resolve,reject,timer}>` 追踪异步命令，`command-done` 按 trackingId 匹配；
- 同步/异步命令统一走 `cache.run`；异步命令**等 command-done 拿到终态后才写缓存**（不是缓存 accepted）；
- 同步 POST 用传输层超时（AbortController）；异步命令用 `asynchronousTimeoutMs`（默认 120s）兜底；
- SSE 断开保留 inflight（cursor 补发），`resetCursor=true` / `disconnect()` 清空并 reject；
- 契约与 13 项测试见 `docs/FORK-CLIENT.md`。

**TaskHandle（v2.6.7 实现）**：`src/lib/task-handle.mjs` 组合 Forker + ForkClient：

- `start()` 负责 spawn（可选）+ 用 forker 的内存 token 建 client + connect；
- 监听 `fang/fork-crashed` → `reconnecting`；等 `fang/fork-started`（或轮询 status）→ 用
  **新 url / 新 token** 重建 client（ForkClient 只处理同进程 SSE 断线，进程重启由 TaskHandle 处理）；
- 重连窗口内命令最多等 `commandWaitMs`，超时 fail-closed；`stop/recycle/dispose` 幂等；
- 状态机与 17 项测试见 `docs/TASK-HANDLE.md`。

---

## 10. 时序

### 10.1 连接建立与协商

```
Orchestrator            ForkClient                Adapter(分身)
     │ connect()            │                         │
     │─────────────────────▶│ GET /version            │
     │                      │────────────────────────▶│
     │                      │  {protocol:3,sessionId} │
     │                      │◀────────────────────────│
     │                      │ negotiateProtocol()     │
     │                      │ GET /state              │
     │                      │────────────────────────▶│
     │                      │ {snapshot,lastCursor}   │
     │                      │◀────────────────────────│
     │                      │ GET /events?since=…     │
     │                      │  &session=<sessionId>   │
     │                      │────────────────────────▶│
     │                      │ 200 text/event-stream   │
     │                      │◀════════════════════════│
     │  {ok,protocol,state} │                         │
     │◀─────────────────────│                         │
```

### 10.2 幂等命令（同步 / 异步）

```
ForkClient                Adapter               业务插件
    │ POST /commands {commandId,op,flush-buffer}
    │──────────────────────▶│
    │                       │ cache miss → 执行
    │                       │─────────────────────▶│
    │  200 {ok,result,commandId}
    │◀──────────────────────│
    │ （网络超时后重试同 commandId）
    │──────────────────────▶│ cache hit → 重放，不执行
    │  200 {ok,result,deduplicated:true}
    │◀──────────────────────│
```

异步分支：`202 {status:'accepted',trackingId}` → 完成后 SSE `command-done {trackingId, result}`；
命令响应证明「到达」，事件证明「状态真的变了」，两者不可互相替代。

### 10.3 分身重启 / 断线重连

```
ForkClient                     Adapter(旧)      Adapter(新, sessionId 变)
    │ SSE 连接中断                      │
    │◀────────────── 退避 500ms ────────│
    │ GET /events?since=42&session=old  │
    │──────────────────────────────────▶│
    │ 409 session-changed               │
    │◀──────────────────────────────────│
    │ onReconnect(resetCursor=true)     │
    │ GET /state → {sessionId:new,lastCursor}│
    │ GET /events?since=<new>            │
    │═══════════════════════════════════│
```

- **sessionId 每次进程启动都变**；母体不必判断「对端是不是新进程」——由分身返回 409，最清楚这件事的一侧做判断。
- 母体重启：旧分身的 token 已丢失 → 401；orchestrator 把任务标失败/待归档，**不接管**，需要就重建（§1.3）。

---

## 11. 测试清单（已落地）

| 文件 | 覆盖 |
|---|---|
| `test/adapter-protocol.test.mjs`（11） | cursor 边界/uint64、环形缓冲与 gap、命令缓存 re-export、版本协商、Bearer 解析、命令信封校验、错误码映射、SSE 帧跨 chunk、命令 id 生成 |
| `test/command-cache.test.mjs`（16，v2.6.3） | in-flight 合并、completed 重放、失败契约、LRU/touch、get 不 touch、超限收敛、invalidate/clear/onEvict、容量边界、stats |
| `test/adapter.test.mjs`（+6，共 32） | v3 路由注册顺序、version/health/state 形状、审批 diff 事件、SSE 回放/session-changed/cursor-invalid/410/close 清理、命令幂等+202+参数校验、并发同 commandId 只执行一次、Bearer 401/放行 |
| `test/adapter-client.test.mjs`（6） | connect 三步、协议过新拒绝、401 致命、409 重拉快照+续流、同 commandId 网络重试、400 不重试 |
| `test/fork-client.test.mjs`（13，v2.6.4） | 同步直通/缓存、异步 accepted→command-done 终态、异步超时、传输失败不缓存、SSE 断开保留 inflight、session 变化清空、disconnect 清空、stale command-done、重复 trackingId、事件隔离、connect 失败、参数边界、9 个 op 便捷方法 |
- `test/task-handle.test.mjs`（17，v2.6.7） | 启动链/token/spawn、崩溃后新端口新 token 重连、命令短等待、重启超时、stop/recycle/dispose、SSE 断开不改变状态、事件聚合、幂等、fail-closed |
| `test/adapter.test.mjs`（36，v2.6.8 新增 4） | 既有：命令/审批/归档/SSE/认证；新增：registerCommand 同步+异步+disposer、accepted 重试同 trackingId、拒绝覆盖内置 op、1MB body → 413 |
| `test/sse-directed.test.mjs`（8，v2.6.9） | 9 分支 61 条定向用例完整性、smoke（一次性+分块）、expectedFrames 覆盖、mutation 检出（裁掉所有尾部 CR）、混合策略确定性、均匀抽样、fuzz 全定向 900 次分支全覆盖、全随机/可复现 |
| `test/sse-client-fuzz.test.mjs`（3，v2.7.0） | 性质（401 致命/409、410 reset/心跳无害/断连无重复且 since 正确）、120 次随机分块+断连 0 failures 且四类策略覆盖、同 seed 可复现 |
| `test/orchestrator.test.mjs`（21，v2.7.1 新增 3） | 归档停进程且保留 home、stop-failed 不假装成功、还原重新 spawn、删除存档 reap 并移除记录 |
| `test/sse-parser-fuzz.test.mjs`（7，v2.6.5） | 帧边界/多行 data/CRLF/flush/超长行/UTF-8 字节切分、固定种子分块等价、随机 seed smoke、RNG 可复现、参考实现一致、roundtrip、flush 后可用 |
| `test/remote.test.mjs`（+2，共 14） | v3 路径 + Bearer 头、eventsUrl 的 since/session/token |
| `test/forker.test.mjs`（+1，共 25） | token 每次 spawn 重新生成、进 env、stop 作废、不落 forks.json/fang-meta.json/status |
| `test/orchestrator.test.mjs`（18） | 版本号改从 `FANG_VERSION` 读取；握手/任务生命周期回归 |

全量：**403 项（402 pass / 1 skip）**。

---

## 12. 落地状态与遗留决策

### 已落地

- 分身侧 10 条路由（v2 五条 + v3 五条）、Bearer 认证、事件环形缓冲、审批 diff、命令幂等缓存、异步 202、SSE 心跳/回放/410/409；
- `CommandCache.run()` 幂等执行（v2.6.3）：in-flight 合并、completed 重放、业务失败缓存 /
  传输错误不缓存、LRU 只淘汰已完成项，契约见 `docs/COMMAND-CACHE.md`；
- `ForkClient`（v2.6.4）：命令外观 + inflight/trackingId/超时兜底，契约见 `docs/FORK-CLIENT.md`；
- `TaskHandle`（v2.6.7）：fork 进程 + ForkClient 的统一生命周期，崩溃后重建连接，契约见 `docs/TASK-HANDLE.md`；
- `Adapter.registerCommand`（v2.6.8）：外部插件注册命令（同步/异步由 executor 返回值决定），
  accepted 走 command-done；1 MB body 超限 → 413；契约见 `docs/ADAPTER-COMMANDS.md`；
- SSE 定向生成器（v2.6.9）：9 分支 61 条最小输入 + expectedFrames + mutation 检出，
  随机模糊按 `directedProb` 混入；契约见 `docs/FUZZ-SSE-DIRECTED.md`；
- SSE 网络层模糊（v2.7.0）：真实 HTTP mock + 随机分块/断连，验证 cursor 无重复/无空洞、
  `since` 续传、409/410 reset、401 致命；契约见 `docs/FUZZ-SSE-CLIENT.md`；
- 归档/读档（v2.7.1）：归档 = 停进程 + 保留 home（stop-failed 如实返回），
  还原 = 原 home 重新 spawn，删除 = reap；契约见 `docs/ARCHIVE.md`；
- 共享协议库 + ForkClient（SSE 解析、cursor 续传、409/410 处理、指数退避、幂等重试）；
- Forker 每次 spawn 生成 token 并经 env 注入；`adapterToken(forkId)` 只读内存；
- Orchestrator 在握手后做 `/version` 协商并记录 `task.adapter.protocol`；`remoteFor()` 自动带 Bearer。

### 尚未接线（刻意）

- Orchestrator 目前只用 `Remote`（JSON）；`AdapterClient` 的 SSE 订阅还没有接到任务状态流/UI。
  下一步是把 `onEvent` 映射到 `task.adapter.*` / `bus.emit('fang/...')`，让 UI 不再轮询。
- `state-changed`、`plugin-state`、`audit`、`command-progress` 是协议预留；业务插件通过进程内 `emit` 可直接使用，
  但当前没有插件主动发。
- 母体重启后的「孤儿任务」只做到「不接管 + 401」；UI 的「已失效/可归档」文案是下一个独立修复。

### 三个待决策

1. **`/state` 是否 gzip**：快照在插件多时可达几十 KB。若 DSH web 已有压缩中间件则 Adapter 不重复实现；
   否则由 Adapter 自己 `zlib.gzip`（但会破坏「纯 HTTP 层」的简洁性）。
2. **`CommandCache` 是否持久化**：现在纯内存（v2.6.3 起 in-flight 合并与失败契约已实现，见
   `docs/COMMAND-CACHE.md`），跨进程重启清空。极端窗口
   「命令执行成功 → 响应丢失 → 分身重启 → 母体重试」会执行两次。缓解方案是让每个命令副作用本身幂等
   （例如 `load-plugin` 对已加载插件返回 completed）；不建议落盘——它解决的是短窗口重试，不是跨重启一致性。
3. **审批双确认**：`approve-action` 命令返回 `completed` 后，实际结果再由 `approval-resolved` 事件确认。
   这是刻意冗余：命令响应证明到达，事件证明状态变化。若两者不一致，**以事件为准**（事件与快照同源）。
   需要 ForkClient 把「命令完成」和「状态确认」分成两条路径，不能混成一个 Promise。
