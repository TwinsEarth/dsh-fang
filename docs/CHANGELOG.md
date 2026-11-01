# CHANGELOG

## v2.7.3（2026-11-01）

**主题：重启结果事件化 —— Forker 发 `fork-restart-failed`，TaskHandle 终态 fail-fast。**

### 新增
- **事件 `fang/fork-restart-failed { forkId, error, terminal }`**（Forker）：
  - 自动重启尝试失败（`restartFork` spawn 失败）→ `terminal:false`（Forker 可能按
    supervise 计划再试）；
  - 放弃重启（`planRestart` give-up / `restart-no-cli`）→ `terminal:true`（不会再有自动重试）。
- **TaskHandle 订阅该事件**：
  - `terminal=true` → 立即 `failed`，不再等 `restartTimeoutMs`（60s）；
  - `terminal=false` → 只记日志、保持 `reconnecting`，由后续 `fork-started` 或
    `forker.status()` 轮询兜底推进（不把「还会重试」误判为终态）；
  - `taskId` 不匹配忽略；`stop()` 仍会立即打断等待（`restartSlot.finish`）。
- 既有 `waitForRestart` 的「事件优先 + 轮询兜底」保留；`fork-started` 仍是成功的完成信号。

### 说明
- 设计稿的 `fork-restarted` 对应仓库既有 `fang/fork-started`（不再新增重复事件）；
- TaskHandle 不自己挂 child `exit` handler，统一由 Forker 的 `fang/fork-crashed` 驱动，
  因此没有「attach 两次」的重复挂载问题；
- 非终态失败不 settle(false)：设计稿原方案会把「Forker 还会重试」误标成 failed，
  这里改为继续等待（见 `docs/TASK-HANDLE.md §3`）。

### 测试 / 文档
- `test/task-handle.test.mjs` 新增 3 项（20 项）：terminal fail-fast、非终态继续等、
  taskId 过滤；
- `test/forker.test.mjs` 新增 1 项（27 项）：supervise give-up 时 emit
  `fang/fork-restart-failed`（terminal=true）；
- `docs/TASK-HANDLE.md §3`：事件驱动重启流程与 terminal 语义。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 3 个补丁位。

## v2.7.2（2026-11-01）

**主题：Forker token 生命周期显式化 —— 补齐 TokenRegistry 公开面（getToken / onTokenRefresh）。**

### 说明
- token 生命周期本身自 v2.6.1 起已在 `forker.mjs` 内联实现（每次 spawn 生成、
  stop 作废、重启重生成、内存 only、env 注入）；本版本补齐设计稿 `TokenRegistry`
  的**公开 API** 并对齐命名。

### 新增
- `forker.getToken(forkId)`：`adapterToken(forkId)` 的别名；
- `forker.onTokenRefresh(handler) → disposer`：每次 `spawn()` 重新生成/刷新 token 时广播
  `(forkId, token)`；handler 异常隔离，disposer 幂等；
  - 首次派生（生成）与崩溃重启（刷新）都会触发；语义是「当前 token」，不是「进程就绪」。

### 测试 / 文档
- `test/forker.test.mjs` 新增 1 项（26 项）：onTokenRefresh 每次 spawn 广播、getToken 别名、
  异常隔离、disposer；既有 adapterToken 生命周期测试保持不变；
- `docs/FORKER-TOKEN.md`：现状、公开面、TS 形状映射、边界（含 adapterPort → webServer 复用）。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 2 个补丁位。

## v2.7.1（2026-11-01）

**主题：修复归档不生效 + 新增「读档」存档管理（还原 / 删除）。**

### 修复
- **归档失败却显示成功**：旧实现 `archiveTask` 调 `service.reap()`（停进程 + 删 home），
  且 `reap` 失败时仍返回 `ok:true`。现在归档 = **停止进程 + 保留 home**：
  - 调 `forker.stop()` 后用 `forker.alive()`（真实 PID 存活）确认进程退出；
  - 超时/停不掉 → `{ok:false, error:'stop-failed'}`，任务保持原样，不再假装归档成功；
  - 只有确认退出后才写 `status:'archived'`、`archivedAt`、清空 url/port/token。
- `autoReapIdleMinutes` 的空闲回收改回 `reap()`（删 home），不再误用归档。

### 新增
- **读档 / 存档管理**：
  - `POST /api/tasks/archive`：归档（保留 home，url/port/token 清空）；
  - `POST /api/tasks/restore`：用原 home/profile 重新 spawn（新端口/新 token）+ 握手；
  - `POST /api/tasks/archive/delete`：reap 删除 home + 记录（forker 记录丢失时按 home 兜底）；
  - `GET /api/tasks` 的 archived 任务新增 `archivedAt` / `archiveRemote` 字段。
- **面板顶栏「读档 (N)」按钮**：切换存档视图；存档卡片支持「还原」「删除存档」，
  普通右栏只保留存档提示 +「打开读档」入口。
- `forker.alive(forkId)`：真实 PID 存活判断（归档确认用，不只看 `rec.running`）。
- `archiveStopTimeoutMs` 配置（100–30000，默认 3000）。

### 测试 / 文档
- `test/orchestrator.test.mjs` 新增 3 项：归档停进程且保留 home、stop-failed 不假装成功、
  还原重新 spawn、删除存档 reap 并移除记录（21 项）；
- `docs/ARCHIVE.md`：生命周期、接口、UI、配置、兼容与边界。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 1 个补丁位。

## v2.7.0（2026-11-01）

**主题：ForkSseClient（SSE 层）网络层模糊测试 —— 随机分块 + 随机断连的等价性。**

### 新增
- **`tools/fuzz/sse-client-mock.mjs`**：真实 `http.createServer` mock：
  - `/fang/adapter/version`、`/state`、`/events` 三个端点；
  - `/events` 按 `since` 过滤帧并记录 `{since, session}`；
  - plan 控制 200/401/409/410/503、`serve` 帧数、`ending`（hold/end/destroy）、心跳插入；
  - `destroy` 前等最后一个 write 回调 + 5ms，降低“数据未到 TCP 就断开”的 flake。
- **`tools/fuzz/sse-client-generators.mjs`**：事件序列（3–10 帧）、每帧 4 种切块模式、
  四类策略（无断/单断/多断/心跳）、`expectedSinceFor()`。
- **`tools/fuzz/sse-client-fuzz.mjs`**：
  - 性质：401 致命不重试；409/410 触发 `resetCursor=true` + 快照重置；心跳不产生事件；
    断连后 cursor 无重复/无空洞且 `since` 正确；
  - 随机：逐 case 配置 mock → 新 client → `connect()` → 等覆盖全部 cursor →
    比较**未去重**的 cursor 序列与请求 `since`；失败报告含 seed/iteration/strategy/
    expectedCursors/actualCursors/requests；
  - CLI `--iterations` / `--seed`。
- **`test/sse-client-fuzz.test.mjs`（3 项）**：性质测试全通过；120 次随机 fuzz 0 failures
  且四类策略均覆盖；同 seed 可复现。

### 文档
- `docs/FUZZ-SSE-CLIENT.md`：与 SseParser fuzz 的区别、MockSseServer 能力、I1–I7 不变量、
  生成器、性质测试、CLI、证据与边界。
- `docs/PROTOCOL-V3.md §11/§12`：测试与实现记录。

### 本机证据
- 200 次随机 fuzz（seed=20261110）：**0 failures**；
  noDisconnect 47 / singleDisconnect 51 / multiDisconnect 53 / withHeartbeats 49；
- 60 次：3.6s；200 次：10.8s（mock 无每 chunk 延迟，靠 write 回调保序）。

> 版本策略：`x.y.z` 每一位只能是 0–9；v2.6 的补丁位已到 9，本次进位为 **v2.7.0**。

## v2.6.9（2026-11-01）

**主题：SseParser 定向生成器 —— 为 9 个分支各构造“边界恰好命中”的最小输入。**

### 新增
- **`tools/fuzz/sse-directed.mjs`**：
  - 9 个分支、**61 条**定向用例：`cr-trimming`（8）/ `multi-line-data`（7）/
    `empty-data-dropped`（9）/ `comment-ignored`（9）/ `space-trimming`（7）/
    `field-override`（6）/ `retry-and-unknown`（6）/ `data-field-edge`（4）/ `buffer-boundary`（5）；
  - 40+ 条用例带 `expectedFrames`，锁定“只裁一个 CR / 只裁一个空格 / 空 data 帧丢弃 /
    无冒号 data 仍产帧”等精确语义；
  - `pickDirected(rng)` 均匀选分支与用例；`generateMixed(rng, { directedProb })` 按概率混合定向/随机；
  - `runDirectedSmokeTest()`：一次性解析 + expectedFrames + 6 种分块策略 × 3 种子等价性；
    支持注入 parse 函数用于 mutation 测试。
- **`tools/fuzz/sse-parser-fuzz.mjs`**：
  - `runSseParserFuzz({ directedProb, directed })` 支持混合策略，返回 `branchCounts` /
    `directedHits` / `randomHits`；失败记录带 `branch`；
  - CLI 先跑定向 smoke（61/61），再跑随机模糊，并打印分支覆盖率；
    `--directed-prob` / `--no-directed` 可调；`directedHits > 100` 时零命中分支告警。
- **`test/sse-directed.test.mjs`（8 项）**：用例完整性、smoke、expectedFrames 覆盖、
  mutation 检出（裁掉所有尾部 CR 会被抓到）、混合确定性、均匀抽样、fuzz 全定向/全随机/可复现。

### 文档
- `docs/FUZZ-SSE-DIRECTED.md`：分支表、用例设计、smoke 流程、混合策略、CLI、取舍与边界。
- `docs/PROTOCOL-V3.md §11/§12`：定向生成器测试与实现记录。

> 版本策略：`x.y.z` 每一位只能是 0–9；本次是 v2.6 的第 9 个补丁位。

## v2.6.8（2026-11-01）

**主题：Adapter 命令入口的扩展面 —— 外部插件注册命令 + 413 body 上限。**

### 新增
- **`adapter.registerCommand(op, executor)`**（`src/plugins/adapter.mjs`）：
  - executor 签名 `(payload, { commandId, trackingId, emit, logger })`；
  - **同步/异步由 executor 的返回值决定**：普通对象 = 200；`{status:'completed',result}` = 200；
    `{status:'rejected',code,message}` = 失败信封；`{status:'accepted',trackingId}` = **202**，
    由 executor 异步执行并通过 `emit({kind:'command-done',…})` 推送结果；
  - `trackingId` 未显式给出时默认 `track_<commandId>`，同一 commandId 重试稳定；
  - 内置 op 不可覆盖（抛错），避免协议语义被第三方替换；disposer 后该 op 回到 `unknown-op`；
  - 仍由 `CommandCache.run(commandId, …)` 包裹：accepted 也缓存，重试不会启动第二个异步任务。

### 修复
- **body 超限 → 413**：`POST /adapter/commands`（以及 `/adapter/command`）请求体超过 1 MB 时，
  之前返回 400 `bad-request`；现在按 `ADAPTER_ERROR_STATUS` 返回 **413 `body-too-large`**，
  且 executor 不会被调用。

### 文档 / 测试
- `docs/ADAPTER-COMMANDS.md`：设计稿（CommandHttpHandler / EventLog / CommandHandler /
  AdapterServer）与本仓库已有实现的映射；为什么复用 DSH webServer 而不是独立端口；
  HTTP 状态表、SSE cursor/session 语义、命令注册示例、边界。
- `docs/PROTOCOL-V3.md §6.2/§6.4/§11/§12`：扩展命令约定与 413。
- `test/adapter.test.mjs` 新增 4 项：registerCommand 同步幂等 + disposer、异步 202 + command-done +
  重试同 trackingId、拒绝覆盖内置 op / rejected 映射、1 MB body → 413。

> 版本策略：`x.y.z` 每一位只能是 0–9；本次是 v2.6 的第 8 个补丁位。

## v2.6.7（2026-11-01）

**主题：TaskHandle —— 把 fork 启动、Adapter 连接、命令代理、崩溃重建连接收进一个生命周期对象。**

### 新增
- **`src/lib/task-handle.mjs`**：`TaskHandle` 组合 Forker（进程层）+ ForkClient（传输/命令层）。
  - 状态机：`idle / starting / running / reconnecting / stopping / stopped / failed`；
  - `start()`：fork 未运行则 `forker.spawn()`（可选 spawnOptions），用 `forker.adapterToken()`
    建 ForkClient 并 connect；重复调用幂等；
  - **崩溃重建连接**：监听 `fang/fork-crashed` → `reconnecting` → 等 `fang/fork-started`
    （事件优先 + `forker.status()` 轮询兜底）→ 用**新 url + 新 token** 重建 client；
    token 由 Forker 在每次 spawn 时重新生成（内存 only），重启后不会 401；
  - **命令代理**：`command(op, payload)` + dsh-Fang 9 个便捷方法；重连窗口内最多等
    `commandWaitMs`（默认 5s），超时 reject `task-unavailable`；idle/stopped/failed fail-closed；
  - 生命周期：`stop()`（断开 client + forker.stop，保留 home）、`recycle()`（stop + reap）、
    `dispose()`（只释放本地资源，不杀 fork）；stop/recycle 幂等；
  - 事件聚合：`onEvent()` 转发 SSE 事件；`onTaskEvent()` 输出
    `status-changed / crashed / restarting / reconnected / failed`。
- **文档** `docs/TASK-HANDLE.md`：状态机、崩溃恢复流程、与 Forker 的接口约定、
  TS 形状映射、测试清单、边界（supervise 默认关闭、命令不缓冲、未接线 Orchestrator）。

### 变更
- `docs/PROTOCOL-V3.md §9/§11/§12` 增加 TaskHandle 的职责与测试列。

### 测试
- 新增 `test/task-handle.test.mjs`（17 项）；全量门禁见 `docs/AUDIT-v2.6.7.md`。

> 版本策略：`x.y.z` 每一位只能是 0–9；本次是 v2.6 的第 7 个补丁位。

## v2.6.6（2026-11-01）

**主题：分身 Web UI 模式 —— 不再把「母体 API 在分身里不存在」渲染成插件故障。**

### 修复
- **分身 Web UI 面板 404**：分身的 profile 也包含 `@local/dsh-fang` 的 client 半，所以分身页面
  侧栏会出现「瓮城」；但 orchestrator 是 mother-only，`/fang/api/status|tasks|sessions` 在分身里
  全部 404。v2.6.6 先探测宿主角色（`/fang/api/status` 200 = 母体；否则 `/fang/adapter/hello`
  200/401 = 分身），分身里只渲染一段说明卡，不再请求母体 API、不再显示「不可读」错误块。
- **分身里隐藏 dock 徽标**：不再对 `/fang/api/status` 轮询，也不显示「瓮城离线」假故障。
- **母体行为保持不变**：只有探测为 mother 后才开始刷新 `/fang/api/*`，避免启动时先打一轮 404。

### 说明
- 分身里 Adapter 路由存在但 v2.6.1+ 要求 Bearer（浏览器拿不到 token），所以角色探测把 401 也
  视为「这是分身」，不展示 Adapter 详情（避免把 401 当适配器故障）。
- 侧栏注册项无法按角色摘除，点击仍会打开说明卡；这是宿主 slot 能力的限制。

### 文档
- `docs/UI-FORK-MODE.md`：404 原因、探测规则、分身/母体行为差异、验证步骤、限制。

> 版本策略：`x.y.z` 每一位只能是 0–9；本次是 v2.6 的第 6 个补丁位。

## v2.6.5（2026-11-01）

**主题：SSE 解析器独立成类 + 模糊测试（随机输入 / 分块等价 / 参考实现 / 帧边界）。**

### 新增
- **`src/lib/sse-parser.mjs`**：`SseParser` 类（行式增量解析，`push()`/`flush()`）。
  只按 `\n` 切行、行尾裁一个 `\r`（CRLF 支持）；空行切帧、无 data 帧丢弃、注释/`retry`/未知字段忽略；
  多行 data 用 `\n` 拼接；`flush()` 按 SSE 规范丢弃未完成残帧。
- **模糊测试工具** `tools/fuzz/`：可复现种子 RNG（SplitMix32 + XorShift128）、9 种输入模式、
  独立参考实现 oracle、6 种字符串分块 + 字节级切分、roundtrip、flush 不变量、失败报告（seed/hex/chunks）。
- **CI 档位** `test/sse-parser-fuzz.test.mjs`（7 项）：性质断言 + 固定种子 × 6 × 25 iterations +
  随机 seed smoke + 可复现性 + 已知 CRLF/多行/字节切分边界。
- CLI：`node tools/fuzz/sse-parser-fuzz.mjs --iterations 5000 --seed <seed>`；失败时打印可复现命令。
- 文档 `docs/FUZZ-SSE-PARSER.md`：不变量 I1–I6、结构、分块策略、复现方式、已知边界。

### 修复 / 行为变化
- **CRLF 帧边界**：旧 `createSseParser` 用 `indexOf('\n\n')` 找块边界，`\r\n\r\n` 不含 `\n\n`，
  CRLF 流会延迟到 flush 且把 `\r` 混进 data；新 `SseParser` 逐行处理，CRLF 正常切帧。
- `flush()` 不再解析残帧（SSE 规范：EOF 丢弃未完成事件）；解析器也不再把无 `event:` 的帧
  默认成 `event:'message'`（字段缺失即省略）。
- `adapter-protocol.mjs` 的 `createSseParser()` 改为 re-export `SseParser`（单一实现）。

### 测试
- 新增 `test/sse-parser-fuzz.test.mjs`（7 项）；CLI 额外跑过 5000 iterations，0 failure。
  全量门禁见 `docs/AUDIT-v2.6.5.md`。

> 版本策略：`x.y.z` 每一位只能是 0–9；本次是 v2.6 的第 5 个补丁位。

## v2.6.4（2026-11-01）

**主题：ForkClient 完整实现 —— inflight 追踪、command-done 匹配、超时兜底。**

### 新增
- **`src/lib/fork-client.mjs`**：`ForkClient` 组合 AdapterClient（传输 + SSE）与 `CommandCache`（幂等）。
  - **同步命令**：POST 返回 completed → 直接返回；同 commandId 命中缓存不重复 POST；
  - **异步命令**：202 accepted + trackingId → `inflight` Map 等待 SSE `command-done`，
    拿到终态后才写入缓存（不缓存 accepted）；
  - **command-done 匹配**：按 trackingId 匹配（trackingId 与 commandId 是两个键）；
    超时/断开后迟到的 command-done 静默忽略（debug）；
  - **超时兜底**：同步 POST 走传输层 AbortController（`synchronousTimeoutMs`）；
    异步命令用 `asynchronousTimeoutMs`（默认 120s）timer，超时 reject → 缓存移除 → 可重试；
  - **SSE 生命周期**：断开保留 inflight（cursor 补发）；`resetCursor=true`（分身重启）/
    `disconnect()`（用户主动）→ 全部 inflight reject；
  - **事件扇出**：`onEvent/onReconnect/onDisconnect`，handler 异常隔离；`state-changed` 更新快照；
  - **fail-closed**：未 connect 或已 disconnect 时命令直接 reject（`not-connected` / `disconnected`）；
  - dsh-Fang 的 9 个 Adapter op 便捷方法：ping/status/flush-buffer/score-plugin/read-plugin/
    route-confirm/approvals/approval-decide/archive。
- **文档** `docs/FORK-CLIENT.md`：TS 接口形状与 `.mjs` 映射、命令生命周期、inflight 语义、
  超时矩阵、SSE 处置规则、错误码、测试清单、边界（无 tsc、node:http 传输待实现、尚未接线）。

### 变更
- `docs/PROTOCOL-V3.md §9/§11/§12` 同步 ForkClient 实现与测试清单。

### 测试
- 新增 `test/fork-client.test.mjs`（13 项）；全量门禁见 `docs/AUDIT-v2.6.4.md`。

> 版本策略：`x.y.z` 每一位只能是 0–9；本次是 v2.6 的第 4 个补丁位。

## v2.6.3（2026-11-01）

**主题：CommandCache LRU + 幂等语义 —— in-flight 合并、失败契约、只淘汰已完成项。**

### 新增
- **`src/lib/command-cache.mjs`**：`CommandCache.run(commandId, fn)` 幂等执行。
  - 两态：`running`（value 是同一个 promise）/ `completed`（value 是结果）；
  - **并发合并**：同一 `commandId` 并发提交 → 第二次等待同一个 promise，不重复执行副作用；
  - **失败契约**：业务失败（`fn` 返回 `status:'rejected'`）与 async accepted 都缓存；
    `fn` 抛错（传输/编程错误，命令可能没执行）不缓存并移除，允许重试重新执行；
  - **LRU**：Map 插入顺序即使用顺序；`run()` 命中 touch，纯 `get()` 不 touch；
    超容量时从头部淘汰第一个 completed，跳过 running；全是 running 时允许临时超限，
    in-flight 完成后自动收敛；
  - `invalidate()` 只对 completed 生效、`clear()` 保留 running、`stats()` 暴露容量/命中/去重/淘汰/丢弃计数；
  - 容量必须 ≥1（否则 `RangeError`）；`onEvict` 回调异常被隔离；缓存不实现超时（超时属于命令层）。
- **Adapter 接线**：`commands()` 改为 `commandCache.run()`；并发同 commandId 只执行一次、
  第二个请求返回 `deduplicated:true`；只有真正执行的那一次发 `command` / `command-done` 事件；
  无 commandId 的请求仍不缓存（v2 兼容）。
- **文档** `docs/COMMAND-CACHE.md`：决策表、API、并发时序、失败契约、LRU 细节、Adapter 接线、
  测试清单、边界（单进程/不持久化/accepted 缓存）。

### 变更
- `adapter-protocol.mjs` 不再自带命令缓存实现，改为 re-export `command-cache.mjs`（避免两份幂等语义）；
- `docs/PROTOCOL-V3.md §6.2/§12` 补充 in-flight 合并与失败契约，并指向 `docs/COMMAND-CACHE.md`。

### 测试
- 新增 `test/command-cache.test.mjs`（16 项）与 Adapter 并发幂等用例（1 项）；全量门禁见 `docs/AUDIT-v2.6.3.md`。

> 版本策略：`x.y.z` 每一位只能是 0–9；本次是 v2.6 的第 3 个补丁位。

## v2.6.2（2026-11-01）

**主题：控制面板分类折叠 —— 进行中 / 已归档 / 临时 三组，进行中只先显示 7 条会话。**

### 新增
- **左栏（母体 项目 & 对话）三组折叠**：
  - **进行中**（默认展开）：只先渲染 7 条会话，其余折叠为「展开剩余 N 个」；展开后可「收起多余会话」；
  - **已归档**（默认折叠）：`session.archived = true` 的对话，按工作区分组；
  - **临时**（默认折叠）：`session.empty = true` 的空会话（没有用户消息、无法继续开发）。
- **右栏（分身 任务 & 项目）三组折叠**：
  - **进行中**（默认展开）：普通任务卡片；
  - **已归档**（默认折叠）：`status = archived` 的任务（沿用原分组，改为统一分区标题）；
  - **临时**（默认折叠）：快速派生任务（标题为 快速派生 / 双击快速派生 / 徽标快速派生 / 重试快速派生，
    空白且未继承会话）。
- **「隐藏/显示临时内容」顶栏开关**：整组隐藏或恢复临时内容；偏好写入
  `localStorage["fang.panel.showTemporary"]`（storage 不可用时只影响本次面板会话）。
- 分类判定**只用宿主已返回的事实**（`archived` / `empty` / 任务标题），不改协议、不新增接口；
  分区标题的 tooltip 写明「临时」的定义。

### 变更
- 左栏/右栏标题栏的计数补充分类明细（进行中 / 已归档 / 临时，临时隐藏时标注「已隐藏」）。
- 同一工作区同时存在进行中/已归档/临时会话时，会在对应分区各出现一次，折叠状态按分区独立记忆。
- 临时全部隐藏且没有其它内容时，给出「当前只有 N 条临时内容（已隐藏）」的空态 + 一键恢复按钮。

### 测试
- UI 层改动，无新增单元测试；`node --check client.js` 通过；全量测试与 e2e 门禁见
  `docs/AUDIT-v2.6.2.md`。视觉验收需重启宿主加载新 client 后人工确认（本机后台宿主未重启）。

> 版本策略：`x.y.z` 每一位只能是 0–9（一个次版本含 10 个小版本）；本次是 v2.6 的第 2 个补丁位。

## v2.6.1（2026-11-01）

**主题：Adapter v3 协议化 —— 版本协商 / 状态快照 / SSE 事件流 / 幂等命令 / Bearer 认证。**

> 版本策略：`x.y.z`，每一位只能是 0–9（一个次版本含 10 个小版本）。
> 本次是 v2.6 的第 1 个补丁位（`2.6.0` → `2.6.1`）；v2.6.9 之后才进 `2.7.0`。

### 新增
- **协议词汇**：`ADAPTER_PROTOCOL_VERSION=3`、v3 五条路由常量、`ADAPTER_EVENT`、`ADAPTER_ERROR_STATUS`
  （错误码 → HTTP 状态码的唯一来源）。
- **共享协议库** `src/lib/adapter-protocol.mjs`：cursor 编解码（uint64 十进制字符串）、环形缓冲 `EventLog`、
  LRU `CommandCache`、版本协商、Bearer 解析、命令信封校验、SSE 帧编解码。
- **分身侧 Adapter v3**：`GET version/health/state`、`GET events`（SSE：回放/心跳/410 cursor-expired/409 session-changed）、
  `POST commands`（`commandId` 幂等 + `async:true` → 202 + `trackingId` → `command-done` 事件）；
  审批 diff 生成 `approval-requested/approval-resolved`；进程级 `sessionId`。
- **母体侧**：`remote.mjs` 增加 `version/health/state/commands/eventsUrl` 与 Bearer 头；新增
  `src/lib/adapter-client.mjs`（`connect()` 协商→快照→SSE、断线指数退避、409/410 自动重拉快照、
  同 `commandId` 网络重试一次）。
- **Forker token 生命周期**：每次 spawn 生成 48 hex Adapter token，经 `DSH_ADAPTER_TOKEN` 注入分身；
  `adapterToken(forkId)` 只读母体内存；`stop` 即作废；不写 `forks.json` / `fang-meta.json` / `status()` / URL。
- **Orchestrator**：握手后调用 `/version` 协商并记录 `task.adapter.protocol`；`remoteFor()` 自动带 Bearer；
  协议过新时 fail-closed（不假装 READY）。
- **文档** `docs/PROTOCOL-V3.md`：接口粒度协议（定位/选型/认证/协商/状态模型/cursor/错误码/时序/测试/遗留决策）。

### 变更
- 版本 2.6.1；Adapter 路由 5 → 10（v2 五条全部保留，向后兼容）；`hello()`/`status()` 增补
  `protocol/sessionId/lastCursor` 等字段（旧客户端忽略未知字段）。
- 旧分身（无 `/version`）按 legacy 协议继续可用；旧母体（不注入 token）下 Adapter 退化为 v2 语义，不加认证层。

### 测试
- 新增 25 项：协议库 11、Adapter v3 5、AdapterClient 6、Remote v3 2、Forker token 1。
- 全量 **331 项（330 pass / 1 skip）**；门禁证据见 `docs/AUDIT-v2.6.1.md`。

## v2.6.0（2026-11-01）

**主题：Forker 完整化 —— 端口池/健康探测/崩溃退避/孤儿恢复/每分身 meta。**

### 新增
- **每分身 `fang-meta.json`**（原子写、0600）：status/pid/port/url/profile/crashCount/restartCount/lastError/时间戳；
  reap 前写入，删除 home 后不会复活目录（修复了"meta 写晚导致 home 重建"的回归）。
- **崩溃退避**：`supervise=true` 时，已就绪分身崩溃按指数退避（默认 1s/2s/4s，上限 30s、±20% 抖动）自动重启，
  最多 3 次；只重启 **ready 过** 的分身（首启失败直接如实报错，避免 loop-spawn）。
- **孤儿恢复**：`recover()` 对账持久化记录：pid 已死 → 标 crashed + 归还端口；pid 存活 → 保留（绝不 kill 别的实例）。
- **健康探测**：`health(forkId)` = 进程状态 + 回环 HTTP 探测（任何响应都算活着）；
  `probeHttpAlive` 作为纯函数可测。
- **纯函数库**：`src/lib/fork-supervisor.mjs`（backoff / planRestart / reconcileOrphans / meta 读写 / HTTP 探测）。
- 配置：`supervise/maxRestarts/backoffBaseMs/backoffMaxMs/backoffJitter/healthPath`；默认 **opt-in**（patch 行 `supervise: false`），
  因为自动重启会与 Orchestrator 的 archive/reap 生命周期竞争；需要时显式打开。

### 测试
- 新增 `test/fork-supervisor.test.mjs`（5 项）：退避边界/抖动、重启策略、孤儿对账、meta 原子读写、HTTP 探测。
- forker 服务契约新增 `health/recover`；全量 306 项（305 pass / 1 skip），e2e 45/45。

## v2.5.0（2026-11-01）

**主题：同步 / 桥接 / 混合路由三个子插件（P0 契约版，API + 纯函数 + 测试）。**

### 新增
- **角色**：`consumer`（PC 消费端）成为一等形式；矩阵 15 个插件。
- **`fang-session-bridge`（桥接）**：mother 侧只读 façade，复用 PC 宿主 `desktop-bridge.json`
  （127.0.0.1 + Bearer，端口/token 每次重读，拒绝非回环 descriptor）；
  暴露 list / events / send(1–4096B) / create，路由 `/fang/api/bridge/*`；PC 不可达时 `bridge-unavailable`。
- **`fang-session-sync`（同步）**：勾选会话导出到 staging bundle（manifest + 每文件 sha256，源只读），
  导入按工作区路径/名称精确匹配，**永不覆盖**：冲突保留 `.fork-<ts>` 副本；未匹配进 `pendingMatch`。
  路由 `/fang/api/sync/{status,export,import}`。
- **`fang-session-router`（混合路由）**：纯函数 `chooseMode`：
  跨机+实时 → `deny`；一次性迁移 → `sync`；同机+宿主在跑+bridge+实时 → `bridge`；其余 `sync`。
  路由 `/fang/api/route` 返回决策与理由。
- 历史隔离说明：PC 与 Web 的会话数据不会自动双向流动；sync 是"文件搬运"（可离线/跨机），
  bridge 是"驱动活进程"（仅同机回环）。派生 fork 的默认回退仍是文件导入（v2.4.0 的 importSession）。

### 验证
- 新增 7 个测试：descriptor 校验与 token 不泄漏、四个 bridge 调用、bundle 导出只读/冲突保留/待匹配、
  路由真值表；全量 301 项（300 pass / 1 skip）；e2e 45/45；新增 allow-list 自检门禁（29 路由、0 findings）。

## v2.4.0（2026-11-01）

**主题：母体会话数据修正 + 派生时真正继承历史 + 「瓮城」控制面板重设计。**

### 修复（母体 · 项目 & 会话）
- **创建时间**：列表此前只回传文件 mtime（并当成时间展示），现在从会话日志 header 读取真实 `createdAt`，
  API 同时返回 `createdAt/createdAtIso/updatedAt`；UI 分别显示「创建」与「更新」。
- **空会话**：没有 `user/message` 的会话标记 `empty:true`，UI 显示「空会话」标签并禁止「继续开发」，
  派生时返回 `session-empty`，不再生成只有 header 的假交接。
- **历史会话继承**：派生前构建真正的交接种子（有界多帧读取 + 对话摘录，默认 48KiB），
  并把母体会话日志**复制进分身自己的 `$DSH_HOME`**（`sessions/<workspaceKey>/<sessionId>`），
  同步写入分身的 `storages/workspace.json`，让分身原生 UI 能看到这段历史；
  日志超过 `importMaxBytes`（默认 32 MiB）时如实标记「仅交接摘要」。
- 之前 `fang-seeds/*.md` 只写不读（注释称"fork reads it"，实际无消费方），现改为种子+历史导入双轨，
  派生响应返回 `importedSession` 供 UI 如实展示。

### UI（控制面板重设计）
- 3:7 分屏保留；新增品牌/状态/主操作分层、会话搜索、分组折叠、两栏回顶、选中条两段式。
- 会话标题来源感知：`session/title` → 原生标题；`preview` → 首条消息；缺失 → 「未命名会话 + 短 ID」，
  绝不拿工作区名冒充标题。
- 任务健康拆成生命周期/适配器两枚徽章；`running + adapter 失败` 标记异常（僵尸分身），
  错误带 code/中文原因/诊断/就地重试；分身会话读取失败只影响该卡。
- 响应式 ≤980px 单列堆叠、键盘可达、对比度 ≥ WCAG AA（详见 `docs/UI-瓮城入口.md`）。

### 测试
- 新增：真实 `createdAt`（非 mtime）、空会话拒绝、`seed()` 对话摘录、派生导入会话日志与 workspace 索引。
- 全量 294 项（293 pass / 0 fail / 1 skip；skip 为手动容器探针）。

## v2.3.1（2026-11-01）

**主题：npm 包名改为 `@twinsearth/dsh-fang` + 修复 CI 上的 watchdog 取消。**

### 变更
- npm 发布包名：`@twinsearth/dsh-fang`（scoped、公开、AGPL-3.0-or-later）；构建时
  `@local/dsh-fang` 统一改写为 `@twinsearth/dsh-fang`，tarball 仍为 `dsh-fang-<ver>.tgz`。
- 注册表 PUT 路径/tarball URL 按 scoped 规则编码（`@twinsearth%2Fdsh-fang`）；healthz 远端检查同步。

### 修复
- restart-guard 的审批 watchdog 定时器不再 `unref()`：挂起审批时事件循环必须保持存活，
  否则 Node 测试调度器会在 1s 定时器触发前判定事件循环已结束并 `cancelledByParent`
  （CI Windows node 22 实测 8 个用例被取消，本地 node 24 偶发不复现）。
- release workflow 修复：`secrets` 不能用于 job 级 `if`，改为 step 级检查 + `workflow_dispatch`。

## v2.3.0（2026-11-01）

**主题：8 步发布流水线落地 —— 以 npm 与 GitHub Release 为主，验收门禁可执行。**

### 新增
- **验收门禁** `tools/release/preflight.mjs`：版本三处一致（package/FANG_VERSION/CHANGELOG）、许可矩阵、
  全量测试、可选 `--e2e`；结果写 `dist/preflight.json`，GREEN 才能继续。
- **构建** `tools/release/build.mjs`：零依赖、用系统 tar 产出 `dist/dsh-fang-<ver>.tgz` + `dist/manifest.json`
  （sha256/大小/条目/包清单）；staged 包名统一为 `dsh-fang`，`@local/dsh-fang` 自动改写。
- **healthz** `tools/release/healthz.mjs`：解包校验 + kernel/plugin 可加载；`--remote` 核对 npm 与 GitHub Release；
  `--serve` 暴露 `/healthz`。
- **npm 发布** `tools/release/publish-npm.mjs`：本机无 npm CLI 也走 registry REST API 发布（token 只从 env/文件读取，不打印）。
- **Docker**：`docker/Dockerfile` + `docker/healthz-server.mjs`，发布健康镜像（`/healthz`，含 HEALTHCHECK）。
- **工作流**：`release.yml`（tag → test → build → npm → GitHub Release → docker → healthz）、`compat.yml`（Node 22/24 导入兼容）。
- **验收文档** `docs/ACCEPTANCE.md`（8 道门禁与已知边界）。

### 修复
- GitHub Actions 功能测试改为 **windows-latest**（本产品依赖 junction/taskkill/AppContainer），许可门禁留在 ubuntu；
  清掉最后几处本地绝对路径字符串。

### 发布
- npm 包名：`dsh-fang`（unscoped，公开发布，AGPL-3.0-or-later）；
- GitHub：`TwinsEarth/dsh-fang`（public）、`TwinsEarth/dsh-fang-private`（private），tag `v2.3.0` 起由 `release.yml` 自动发布。

## v2.2.0（2026-11-01）

**主题：控制面板 3:7 水平分屏 —— 左「母体项目 & 会话」，右「分身项目 & 会话」。**

### 新增
- 控制面板改为 **3:7 网格**：左栏母体（按 workspace 分组的项目 + 会话），右栏分身
  （每个任务一个项目，展开即该分身自己的会话列表）；两栏各自独立纵向滚动
  （`overflowY:auto` + 视口高度上限），条目多时不再撑长页面。
- 新增母体 API `GET /fang/api/tasks/sessions?taskId=` + orchestrator `listForkSessions()`：
  只读分身自己的 `<forkHome>/sessions`，有界解帧（≤32 帧 / 1MiB）提取会话标题，失败如实降级。
- 左栏会话点选 → 两段式「继续开发 →」（派生新分身 + lineage 种子）；
  右栏分身会话点选 → 「打开分身 →」；右栏每个项目保留 打开/归档。
- 右栏默认展开全部项目，可逐个折叠；会话标题沿用 v2.1.1 的原生标题 + 来源标注。

### 测试
- orchestrator：`listForkSessions` 读取分身会话日志与工作区索引、标题/来源/preview、未知任务。
- e2e：创建任务后写入一份分身侧多帧会话日志，断言
  `GET /fang/api/tasks/sessions` 返回原生标题。

## v2.1.1（2026-11-01）

**主题：会话可辨认 + 分身不再"派生出僵尸"。**

### 新增
- 会话标题：从会话日志的有界多帧读（`session/title` 事件）提取原生标题；
  无原生标题时退化为"首条用户消息预览"，再退化才用工作区名。API 返回 `title/titleSource/preview`
  （来源如实标注：`session/title` / `first-user` / `workspace`）。
- 控制面板会话行显示真实会话名（长标题截断 + 完整 title 提示），下方标注来源与工作区。

### 修复
- **分身僵尸**：orchestrator 的模板解析改为"只选一个真的装了本 bundle 的 profile"，
  并在 provision 后校验 `<forkHome>/profiles/<p>/node_modules/@local/dsh-fang`；
  解析不到 bundle 时直接回收（`fork-bundle-unavailable`）而不是派生出一个
  `/fang` 全部 404、adapter 永远 `http-404` 的僵尸分身。
- `cordis.patch.yml` 移除了遗留的 `motherProfile: web`（它把分身模板指向了没有 Fang 的 web profile，
  正是上面僵尸分身的根因）。
- 标题提取有界：最多 64 帧 / 2MiB 压缩预算，超出如实 `frame-limit` 降级，绝不整文件解压；
  标题按 `mtime+size` 缓存，列表刷新不重复解帧。

## 协议分层（2026-11-01，不改变运行时行为）

**主题：AGPL 核心 + MIT 生态 + 商业闭源的许可分层，以及"不赌解释"的边界文档。**

### 新增
- `LICENSE-CORE`（AGPL-3.0 全文，gnu.org 原文 34,523 bytes）、`LICENSE-SDK`（MIT）、
  `LICENSE-COMMERCIAL`（商业许可草案：评估/生产/OEM 三档 + 占位价格）。
- `CLA.md`：贡献者许可协议，含**永久不可撤销的再许可/双许可授权**（商业双许可路径的法律前提）。
- `NOTICE`：逐目录/逐文件许可地图 + 第三方归属；`LICENSES/cordis-MIT.txt`。
- `docs/LICENSING.md`：决策（为什么 AGPL 而非 BUSL/SSPL）、Open Core 与双许可、收入结构、
  **AGPL 与 MIT 的 DSH 兼容边界分析**（推荐 fangd 独立进程 + MIT bridge 的迁移路径）。
- `sdk/`（MIT）：插件模板 + 调用 `/fang/api/status` 的示例插件；`relay-server/`、`enterprise/` 商业占位。
- 全仓源码 `SPDX-License-Identifier` 头（核心 64 个 AGPL、生态 MIT、vendored cordis MIT）。
- `test/licensing.test.mjs`：许可文件/分层标注/package.json 许可/第三方归属的回归测试。

### 注意
- 版本仍为 2.1.0（许可证变更不改变运行时行为）。
- 发布前必须替换 `NOTICE`/`LICENSE-COMMERCIAL`/`CLA.md` 中的主体、邮箱、价格占位，
  并由律师审阅；这不是法律意见。

## v2.1.0（2026-11-01）

**主题：把「瓮城」做进 Harness Web UI，并让门户能"选中已有会话 & 任务继续开发"。**

### 新增
- **左侧导航「瓮城」**（`sidebar.panellist` id=fang order=90）：图标 = 红色城门组件
  （瓮圈红色 `--fang-gate-accent` + 门洞 currentColor + 门基），单击由外壳切到面板。
- **双击快速派生**：图标 / dock 徽标双击（400ms 窗口、6px 容差、2s 冷却、单飞）→
  POST /fang/api/derive → 打开带 token 的分身标签页；弹窗被拦时面板内给「打开分身 ↗」。
- **中列面板 `main` key='fang'**：任务 + 母体已有会话的「选中 → 确认 → 继续开发」两段式；
  状态/离线/空态/加载态显式呈现。
- **母体只读会话目录**：新插件 `fang-session-catalog`（mother-only，只读 fs）+
  `src/lib/session-format.mjs`（多帧 zstd 有界头读、脱敏、digest ≤32KiB、id 不透传路径）；
  路由 `GET /fang/api/sessions`、`/sessions/item`、`/sessions/head`。
- **lineage 种子**：`orchestrator.derive({sessionId})` → catalog.digest → 写入分身
  `<forkHome>/fang-seeds/<seedId>.md` → createTask；`taskView.seed` 暴露来源与大小。
- `POST /fang/api/derive`（标题 + 可选 sessionId）；`normalizeSeed()` 64KiB 上限、超限抛错。

### 变更
- 版本 2.1.0（package / kernel FANG_VERSION / e2e 断言）。
- 角色矩阵新增 `sessionCatalog: ['mother']`（12 行）。
- 客户端半重构：三个槽位登记（导航/面板/徽标）共用一份 client.js，颜色改用 `--dsw-alias-*` 回退链。

### 已知边界
- 导航行点击归外壳，双击热区只能是 18px 图标本身（dock 徽标是更大的目标）。
- 会话继续是 lineage + 有界摘要，不复制 transcript、不挂载母体会话目录（母体不可变）。
- v2.1 需母体重启 + 页面刷新才生效（ESM/客户端 bundle 缓存）。

## v2.0.0（2026-11-01）

**主题：从「1 编排器 + 9 子插件」升级为「母体大脑 + 分身器官 + 容器兜底」三层部署。**

### 新增
- **Adapter 插件（第 11 行，`fang-adapter`，仅分身）**：跨进程桥。HTTP 端点
  `/fang/adapter/{hello,status,approvals,audit,command}`；命令 ping/status/flush-buffer/
  score-plugin/read-plugin/route-confirm/approvals/approval-decide/archive。
- **Remote 客户端（`src/lib/remote.mjs`）**：母体侧调用分身的纯模块，统一 `{ok,kind,error}`，永不抛。
- **角色矩阵与 `roleGate`（`src/kernel/role.mjs`）**：11 个插件按 mother/fork 激活；
  同一 bundle 同时装进母体与分身，运行时决定。
- **任务语义**：`createTask / listTasks / getTaskStatus / promoteTask / archiveTask`，
  HTTP `/fang/api/tasks*`；v1 的 fork/reap/listForks/promote 保留为兼容别名。
- **端口池（18000–18100）**：Forker 确定性分配并校验 URL 端口；占用表持久化、启动回收。
- **干净分身模板**：`ensureTemplate()` 生成 base+web-app+bundle 的最小 profile，不再继承母体脏 profile。
- **Router 双阶段**：`decide`（母体初判）/ `confirm`（分身复核，只升不降，deny 不可推翻）。
- **Scorer 环境阈值**：`thresholds.{mother,fork}` + `basis{environment,thresholds,note}`。
- **Auditor 汇总**：`aggregate({limit,sources})`；分身独立落盘、母体按需拉取。
- **Approver 双侧语义**：`scope`、`requestPromotion/requestRestart`、`summary({remotes})`。
- **容器兜底**：`src/lib/container`（AppContainer 执行器 + 申报写代理 + NDJSON 帧）；
  BufferKeeper 追加 proxyState/setDeclared/proxyWrite/proxyLog。
- **商用钩子**：`src/kernel/extensions.mjs`（collaboration/git/backup/tokenApi/teams），默认关闭、无 provider 即 no-op。
- **e2e 脚本 `tools/e2e.mjs`**：临时 `$DSH_HOME` + 真实 dsh 母体 + 真分身全链路验收。

### 变更
- `FANG_VERSION` 与 `package.json` 版本 → `2.0.0`。
- 所有插件 apply 首行 `roleGate()`：未部署角色不注册服务/定时器/路由。
- 旧测试按新矩阵固定角色（fork-only 插件测试置 `DSH_FANG_ROLE=fork`）。
- `orchestrator` 模板默认 = 当前 profile；fork 的 role 由 `DSH_FANG_ROLE` 注入，防止分身自升为母体。

### 修复（v1 遗留）
- 宿主 `approval` 行被误禁用 → 恢复，permission-presets/auto-review/gpw 的 pending 告警清零。
- `node --test test/` 在 node v24 不可用 → 统一为 `node --test --test-concurrency=1 "test/*.test.mjs"`。
- 客户端半注册根因（loader 行必须是裸包名）已固化在 patch 与预检测试里。

## v1.0.0（2026-11-01）
- 首次整合：单包 `@local/dsh-fang`、10 个插件行、共享 kernel、141 项测试、门户与 dock 徽标、
  真实 fork/reap 机制验收、审计链与 A/B 审批。
