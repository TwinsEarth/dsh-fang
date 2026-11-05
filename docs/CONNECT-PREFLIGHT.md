# 连接三步流程（version → state → SSE）与可观测性（v2.7.4）

> 代码：`src/lib/adapter-client.mjs`（`createAdapterClient`）；测试：`test/adapter-client.test.mjs`（8 项）。
> 契约：`docs/PROTOCOL-V3.md §2/§5`。

## 1. 现状：三步流程自 v2.6.1 已存在

设计稿要求「先 GET /version 协商协议、再 GET /state、再订阅 SSE」。仓库
`createAdapterClient().connect()` 从 v2.6.1 起就是这个顺序：

```
connect()
  ① remote.version()                 → GET ${prefix}/adapter/version
     └─ negotiateProtocol(protocol, {min,max})   // min=ADAPTER_PROTOCOL_MIN(1), max=3
        ├─ protocol-invalid / protocol-too-old / protocol-too-new
        │     → {ok:false, code, protocol}；**不拉 state、不订阅 SSE**
        └─ ok → protocol = negotiated.protocol
  ② remote.state()                   → GET ${prefix}/adapter/state
        └─ 失败：401 fatal / 其他 retryable（后台重连）
        └─ 成功：lastCursor = state.lastCursor；sessionId = state.sessionId
  ③ openOnce()                       → GET ${prefix}/adapter/events?since=<cursor>&session=<sessionId>
        └─ 409/410 → resyncFromState()（重拉 state + resetCursor=true）后重试
        └─ 401 → fatal，不重试
```

对应测试（`test/adapter-client.test.mjs`）：
- 「connect: 版本协商 → 快照 → SSE，cursor 推进、事件/状态回调、Bearer 头」；
- 「connect: 协议过新 → 拒绝并进入 failed（不拉快照、不订阅）」；
- 「connect: 401 是致命失败（不重试）」；
- 「SSE 409 session-changed：重置 cursor、重拉快照并自动续流」。

## 2. v2.7.4 新增：三步过程可观测

设计稿里的 `VersionInfo` 与「version/state sessionId 一致性」在这里落地为**只读诊断**，
不改变既有行为：

```js
const connected = await client.connect()
// connected: { ok, protocol, sessionId, state, lastCursor, version, sessionMismatch }

client.lastVersionInfo   // 最近一次 /adapter/version 原始响应（protocol/version/sessionId…）
client.protocolRange     // { min, max }：本次协商实际使用的区间
client.sessionMismatch   // { versionSession, stateSession, at } | null
```

语义：

- `lastVersionInfo` / `protocolRange`：纯诊断，供日志、面板与上层审计；
- `sessionMismatch`：version 与 state 的 `sessionId` **不一致**时记录，表示 Adapter 在两次请求
  之间重启过。此时 **state 是最新真相**，客户端仍用 `state.sessionId` 续流（行为不变）；
  不做「重试整个三步」——因为 state 已由新进程生成，重试只会得到同一个 state。
- `connect()` 结果新增 `version` / `sessionMismatch` 字段（向后兼容：只加字段）。

## 3. 版本兼容规则（既有实现）

`negotiateProtocol(remote, {min, max})`（`src/lib/adapter-protocol.mjs`）：

| 输入 | 结果 | 行为 |
|---|---|---|
| 非整数 / <1 | `protocol-invalid` | 拒绝，不拉 state |
| `remote < min` | `protocol-too-old` | 拒绝（对端缺客户端需要的字段） |
| `remote > max` | `protocol-too-new` | 拒绝（客户端不认识新字段） |
| `min ≤ remote ≤ max` | ok，`protocol = remote` | 继续 state + SSE |

默认 `min = ADAPTER_PROTOCOL_MIN = 1`、`max = ADAPTER_PROTOCOL_VERSION = 3`；
`createAdapterClient({ minProtocol, maxProtocol })` 可缩小/放大区间。

## 4. 错误处理（与设计稿的刻意差异）

| 设计稿 | 仓库实现 | 原因 |
|---|---|---|
| 抛 `UnsupportedProtocolError` | 返回 `{ok:false, code:'protocol-too-new'|'protocol-too-old'|'protocol-invalid'}` + `emit('disconnect', {fatal:true})` | 仓库传输层契约「永不抛，全部降级为可判定结果」 |
| 抛 `SessionChangedError`，重试三步 | 记录 `sessionMismatch`，继续用 state 的 session | state 是重启后的最新快照，重试三步没有新信息 |
| `connectWithSnapshot` 拆分 | 不拆：`openOnce` + `resyncFromState` 已覆盖 | 单一 connect 状态机更简单，409/410 已有 resync |
| 同步 N 次重试 | 失败后 `reconnectLoop()` 后台退避重连（无限） | 母体不放弃分身；上层通过 `onDisconnect` 观察 |

## 5. 边界

- `sessionMismatch` 只在**两次请求之间发生重启**时出现；Adapter 的 `sessionId` 在进程生命周期内
  不变，所以这个信号是精确的，不会误报。
- 401 在 version / state / SSE 任一步都是 fatal，不重试。
- 协议协商失败时 `lastVersionInfo` 仍会记录对端返回（便于排障），但不建立任何连接。
- 三步之间没有事务性回滚：version 成功、state 失败时只需后台重连，不产生悬挂资源。
