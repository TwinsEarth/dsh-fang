# ForkSseClient 网络层模糊测试（v2.7.0）

> 代码：`tools/fuzz/sse-client-mock.mjs`（真实 HTTP mock）、
> `tools/fuzz/sse-client-generators.mjs`（事件/切块/断连生成器）、
> `tools/fuzz/sse-client-fuzz.mjs`（性质 + 随机循环 + CLI）；
> 被测对象：`createAdapterClient()`（`src/lib/adapter-client.mjs`）的 SSE 状态机。
> 测试：`test/sse-client-fuzz.test.mjs`（3 项）。

## 1. 与 SseParser 模糊测试的区别

| | SseParser fuzz | ForkSseClient fuzz |
|---|---|---|
| 被测对象 | 纯函数式增量解析器 | 有状态网络客户端（连接/重连/cursor/session） |
| 等价性 | 一次性解析 = 任意分块解析 | **同一逻辑事件序列，无论 TCP 怎么切、断连多少次，去重后的事件序列 = 完整序列** |
| 输入 | 随机 SSE 文本 | 事件序列 + 分块策略 + 断连策略 + 错误响应 |
| 基础设施 | 无网络 | 真实 `http.createServer` + 真实 fetch 流式读取 |

> 本仓库的 `ForkSseClient` 即 `createAdapterClient()` 的 SSE 层（fetch + ReadableStream，
> 非 `http.request`）；mock 服务器测的是同一网络路径（真实 TCP/HTTP 分块与断连）。

## 2. MockSseServer 能力

- 端点：`/fang/adapter/version`、`/state`、`/events`（与 `remote.mjs` 路由一致）；
- `/events` 记录每次请求的 `{since, session}`，按 **`since` 过滤帧**（模拟 EventLog 语义）；
- plan 控制：`status`（200/401/409/410/503）、`serve`（本次写多少帧）、
  `ending`（`hold` / `end` / `destroy`）、`heartbeat`（每帧前插 `: heartbeat\n\n`）；
- `destroy` 前等待最后一个 `write` 回调 + 5ms，降低“数据未到 TCP 就断开”的 flake；
- `stop()` 清理所有挂起响应与连接。

## 3. 不变量

| 编号 | 不变量 | 验证方式 |
|---|---|---|
| I1 | 分块无关性：同一事件序列，任意 chunk 切分，`onEvent` 的 cursor 序列完全一致 | 随机 fuzz：每帧随机 1–N 字符切块；比较完整 cursor 序列 |
| I2 | 断连重连等价性：任意位置断连 M 次，最终去重后的事件 = 完整序列 | singleDisconnect / multiDisconnect 策略 |
| I3 | 无重复无丢失：cursor 严格递增且 1..N 无空洞 | 比较**未去重**的 cursor 序列（重复/空洞直接失败） |
| I4 | 心跳无害：任意数量注释不产生事件、不影响 cursor | withHeartbeats 策略 + 性质测试 |
| I5 | 409/410：触发 `onReconnect(resetCursor=true)`，并从快照重置 cursor/session | 性质测试（无随机 fuzz，避免状态机噪声） |
| I6 | 401：致命、不重连 | 性质测试：只允许 1 次 `/events` 请求 |
| I7 | 无异常：任意输入不抛错（除显式 stop） | fuzz 循环 try/catch 记录，0 failures |

> 差异说明：本仓库客户端**没有 heartbeat timeout**（心跳注释只用于保活/绕过代理，
> 客户端不据此重连），因此不实现“心跳超时触发重连”的性质；I4 只验证“心跳不产生帧”。

## 4. 生成器

`generateCase(rng)`：

- 事件数 3–10，cursor 1..N，事件种类：`audit` / `plugin-state` / `command-progress` /
  `approval-requested`；
- 每帧编码为 `id: <cursor>\nevent: adapter\ndata: <JSON>\n\n`；
- `splitFrame` 四模式：整帧、固定大小、按 `\n` 切、随机两个切点；
- 策略：
  - `noDisconnect`：一次 200 流，`ending:'hold'`；
  - `singleDisconnect`：随机帧后 `destroy`，第二次从 since 续传至 `hold`；
  - `multiDisconnect`：1–3 个断点，每段 `destroy`，最后 `hold`；
  - `withHeartbeats`：每帧前插心跳（可选再断一次）；
- `expectedSinceFor()` 计算每个 200 请求应携带的 `since`（首连 0，之后为上一段最后 cursor）。

## 5. 性质测试（`runSseClientProperties`）

1. **401**：`connect()` 返回 `{ok:false, code:'unauthorized', fatal:true}`，`onDisconnect` fatal，
   `/events` 只请求 1 次（不重试）；
2. **409**：首连收到 409 → 重新拉 `/state` → `onReconnect(resetCursor=true)` → 重连 since=0；
3. **410**：同 409（`cursor-expired`）；
4. **心跳**：3 帧 + 心跳 → 恰好 3 个事件、`lastCursor='3'`；
5. **断连无重复且 since 正确**：前 2 帧后 destroy → 第二个请求 `since=2`，最终 cursor 1..4，
   无重复。

## 6. 随机循环与 CLI

```bash
node tools/fuzz/sse-client-fuzz.mjs --iterations 200 --seed 20261110
```

流程：性质测试 → 逐 case 配置 mock → 新 client → `connect()` → 等待覆盖全部 cursor →
比较未去重 cursor 序列与请求 since → 记录 strategy 计数。失败报告包含
seed / iteration / strategy / expectedCursors / actualCursors / requests，可直接用 seed 复现。

本机证据（seed=20261110）：

- 60 次：0 failures（noDisconnect 13 / single 14 / multi 16 / heartbeats 17）；
- 200 次：0 failures（47 / 51 / 53 / 49）；
- `test/sse-client-fuzz.test.mjs`：120 次随机 fuzz 0 failures，四类策略均覆盖。

## 7. 边界

- **不测字节级 UTF-8 拆分**：客户端用 `TextDecoder` + `ReadableStream`，由 fetch/undici 保证
  字符边界；mock 按字符串 chunk 写。
- **不测背压**：`dispatchFrame` 同步扇出，事件量极大时内存增长属已知设计边界，需专门压测。
- **hold 连接**：`ending:'hold'` 的流在测试结束由 `client.stop()`/`server.stop()` 销毁；
  不断言“服务端正常 EOF 后自动重连”，该路径由 409/410/断连场景覆盖。
- **409/410 都走快照重置**：当前实现两者都 `resyncFromState`，差异只在 reason 字段。
- mock 的 `destroy` 是硬断（RST/提前关闭），与正常 `res.end()` 的 FIN 语义不同；两者都触发
  `onDisconnect`，但随机 fuzz 只使用 `destroy`（更严格的网络中断）。
