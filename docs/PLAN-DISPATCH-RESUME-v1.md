# 计划 · 自动派发 / 定时续跑 / 断点续跑 / 额度守卫（v3.0.8–v3.3.3 对齐）

> 状态：**设计方案（未实现）**。基线：`package.json` v3.0.7；工作树 HEAD `d3e2989`（分支 `feat/upgrade-coordinator`，v3.0.8/v3.0.9 在飞）。
> 依据：`<v3.1.1规格书>`（v3.0.8–v3.0.12 路线）+ 本仓库现有代码/文档。
> 硬约束：不推 main · 不新增浏览器 fang UI · 不伪造完成 · 发布等人工确认。
> 本文所有"现状"均带 `文件:行` 证据；所有"提案"标 **P**；**没有一行代码被实现，因此不存在任何"已完成"声明**。

---

## 0. 一句话

把任务从"派生一个分身、等人去聊天框里打字"升级为一条**可持久化、可重放、可断点**的派发/续跑流水线：
母体持有**意图与预算**，分身持有**会话与执行**，DSH 宿主提供 `prompt / schedule / goals / tokenMeter` 原语；
三者之间只用**幂等命令 + 复算游标**连接，不新增浏览器 UI。

---

## 1. 现状盘点（缺什么，证据在哪）

| # | 能力 | 现状 | 证据 | 缺口 |
|---|---|---|---|---|
| A1 | 派发到聊天框（PC 宿主） | **有**：`POST /v1/sessions/:id/messages {text}` → `controller.prompt()` | `src/lib/bridge-client.mjs:116-124`；`dist/vendor-inspect/_ignotuss_dsh-desktop-bridge/package/src/index.js:220-240` | `requestId` 由**服务端** `randomUUID()` 生成（`index.js:231`），客户端重试会**重复注入**；无队列、无回执落盘 |
| A2 | 派发到聊天框（分身） | **无** | `ADAPTER_OP`（`src/kernel/types.mjs:174-184`）无 prompt 类 op；`orchestrator` 路由表 62 条无 dispatch（`src/plugins/orchestrator.mjs:1386-1604`） | 分身进程内明明有 `sessionController`，但没有入口 |
| A3 | 派发幂等 | **基座已有**：`CommandCache`（in-flight 合并 / completed 重放 / LRU） | `src/lib/command-cache.mjs`；`docs/ADAPTER-COMMANDS.md:70-73` | 只覆盖 adapter 命令，覆盖不到"派发意图"这一层 |
| B1 | 长任务状态 | **弱**：任务只有 `TASK_STATUS = provisioning/ready/running/archived/failed` | `src/kernel/types.mjs:165-171` | 无轮次、无心跳、无进度、无"停在哪一步" |
| B2 | 状态流 | **有**：adapter SSE `EventLog`（cursor / gap / `cursor-expired` 410 / `session-changed` 409） | `docs/ADAPTER-COMMANDS.md:90-97` | 事件里没有 session 级状态（`ADAPTER_EVENT` 无 turn 类事件，`types.mjs:210-220`） |
| B3 | TaskHandle | **库在、未接线** | `docs/TASK-HANDLE.md:166-167`（§8 明确"未接线到 Orchestrator"） | 崩溃重连逻辑写好了但没人用 |
| C1 | 重试 | **只有进程级**：forker 崩溃退避重启 + restart-guard | `docs/FORKER-SUPERVISOR.md`；`ADAPTER_OP`/`AUDIT` 无业务重试 | 没有"业务级重试 / 断点续跑 / 预算" |
| C2 | 定时 | **无**：只有 `autoReapIdleMinutes` 空闲回收 | `src/plugins/orchestrator.mjs:64,1336`（config + tick） | 没有续跑定时器、没有额度探测 |
| D1 | 额度 | **无**：无 pressure 采样、无 429 分类 | — | 上下文压缩、供应商限流、余额三种"额度"全未区分 |
| D2 | 完成判定 | **无**：`status=archived` 是人手动归档 | `orchestrator.mjs:1417`（archive） | "做完了"目前等于"人点了归档"，正是"伪造完成"的温床 |

**结论**：四件事（派发 / 跟踪 / 续跑 / 重试）不是四个功能，是**一条链**。缺少的核心不是 WebSocket，而是**一条 append-only 的派发意图日志 + 一个可复算的运行态投影**。

---

## 2. 不变量（先定规矩，再写代码）

| ID | 不变量 | 违反后果 |
|---|---|---|
| I1 | 每次派发有**客户端生成的 `intentId`**，母体、分身、宿主三层各留一份；同一 `intentId` 到达两次 = 一次效果 | 重复注入提示词，Agent 重复干活、重复花钱 |
| I2 | `intentId → SessionPromptRequest.requestId` **一一映射**，`requestId` 必须由**客户端**传入 | 宿主边界无法去重（现状见 A1 缺口） |
| I3 | 顺序由**母体日志**决定，客户端不猜 | 断线重放乱序 |
| I4 | 运行态是**投影**，可被 (事件, 快照, 复算) 三种来源重建，绝不作为唯一真相 | 进程崩溃后状态永久丢失 |
| I5 | 续跑只由**三类信号**触发：`stop-reason` 分类、`stall` 判定、显式 schedule 命中 | "看着像没动就再发一次"→ 双写 |
| I6 | **绝不由 Agent 自述"我完成了"判定完成**；完成需 `verifier`（可执行校验）+ 证据文件 + 人确认三选二的显式记录 | 伪造完成 |
| I7 | 同一 task 同一时刻**至多一个活跃 dispatch**（单飞锁，`src/lib/mutex.mjs` 同款语义） | 两轮 Agent 抢一个 session |
| I8 | 检查点只存**指针与摘要**（seq / 摘要 / 声明），不存密钥、不存全量会话、不存产物 | 体积失控 + 泄密（沿用 v3.0.5 B8 凭据纪律） |
| I9 | 定时器必须**带 jitter 且单飞**，重复命中只算一次 | 部署/重启时的惊群（reconnect storm 同款） |
| I10 | 任何"余额/限流"类失败**绝不无限重试**；到预算上限一律转 `needs-human` | 静默烧钱 |
| I11 | fork home 是**分身私有**；母体只经 adapter 读，不直接写（延续"母体不可变 / 分身零共享"边界，`orchestrator.mjs:9-13`） | 破坏隔离，recompute 语义失效 |
| I12 | 落地不新增浏览器 fang UI：全部能力经 **HTTP API / adapter op / CLI** 暴露；`client.js` 不改 | 违反本次约束 |

---

## 3. 总体架构

```text
                    ┌──────────────────────── 母体进程（fang-orchestrator）────────────────────────┐
  人/CI/CLI ──────▶ │  /fang/api/tasks/{dispatch,progress,checkpoint,resume,schedule,...}            │
  既有面板  ──────▶ │            │                                                                  │
                    │            ▼                                                                  │
                    │   ┌─────────────────┐   写入    ┌──────────────────────────────┐            │
                    │   │ FangRunScheduler│─────────▶ │ dispatch-queue.jsonl (意图日志)│            │
                    │   │ (tick/单飞/抖动) │◀───────── │ runs/<taskId>/*.json (状态投影)│            │
                    │   └────────┬────────┘   读取    └──────────────────────────────┘            │
                    │            │ CommandCache(intentId) 幂等                                     │
                    └────────────┼───────────────────────────────────────────────────────────────┘
                                 │  POST /fang/adapter/commands  {commandId, op:'prompt', payload}
                                 ▼
                    ┌──────────────────── 分身进程（fork role，每个 task 一个 dsh web）─────────────┐
                    │  fang-adapter v4                                                            │
                    │    op prompt    ──▶ ctx.sessionController.prompt({requestId, sessionId,     │
                    │                     mode, content})      ← 宿主原语，自带 resume/queue/steer  │
                    │    op state     ──▶ ctx.sessionController.state({sessionId})                │
                    │    op wait      ──▶ ctx.sessionController.wait({sessionId, timeoutMs})      │
                    │    op checkpoint──▶ 写 homeDir/fang-run/<intentId>.json（分身私有）          │
                    │    op quota     ──▶ ctx.tokenMeter.contextPressure() + ctx.deepseekAccount  │
                    │    publish session-state / dispatch-accepted / turn-failed → EventLog(SSE)   │
                    └─────────────────────────────────────────────────────────────────────────────┘
                                 ▲
                                 │  DSH schedule（分身内）：target.kind='session' → 到点**恢复**该会话
                    ┌────────────┴────────────┐
                    │ 宿主任期原语（不新增依赖）│  prompt / wait / state / observeState
                    │                         │  schedule.create|run|edit|history
                    │                         │  goals.create|resume|pause|block
                    │                         │  tokenMeter.contextPressure / compaction.compactNow
                    └─────────────────────────┘
```

**三条通道，互不混用**（沿用"presence 与 doc 分道"的纪律）：

| 通道 | 载体 | 语义 | 失败容忍 |
|---|---|---|---|
| 派发（durable） | `dispatch-queue.jsonl` → adapter `op:prompt` | 至少一次 + 幂等 = 效果恰好一次 | 断线重放，不丢 |
| 观测（lossy） | adapter SSE `session-state` / 母体 1s 采样 | 最新态优先，可丢中间帧 | 丢帧后靠 `state` 拉齐 |
| 定时（budgeted） | DSH `schedule` + 进程内 tick | 到点唤醒，重复命中只算一次 | 错过只补最近一次（宿主语义） |

---

## 4. 数据结构

### 4.1 磁盘布局（母体 dataDir 下，全部 append-only 或原子写）

```text
<dataDir>/
├── tasks.json                      # 既有：任务表（扩展 run{} 字段，见 4.2）
├── dispatch-queue.jsonl            # 新增：派发意图日志（只追加，永不改写）
├── runs/<taskId>/
│   ├── state.json                  # 新增：运行态投影（原子写，可整份丢弃重建）
│   ├── checkpoints/<ckptId>.json   # 新增：检查点（人可读，<32KB）
│   └── attempts.jsonl              # 新增：每次续跑尝试（含 stopReason / verdict）
└── schedules.json                  # 新增：定时器镜像（权威在宿主 schedule，这是索引/对账用）
```

分身侧（**私有，母体不写**）：

```text
<forkHome>/fang-run/
├── chat.json                       # 聊天框绑定：{sessionId, workspaceId, cwd, createdAt}
└── <intentId>.json                 # 该次派发的检查点（由 op:checkpoint 写出）
```

### 4.2 `FangTask.run`（扩展既有任务记录）

```jsonc
{
  "taskId": "task_01J...",
  "title": "重构 session-router",
  "status": "running",              // 既有 TASK_STATUS，不改语义
  "run": {                          // P：新增块；缺省时全部能力降级为"手工模式"
    "mode": "manual|assisted|auto", // assisted=派发但不自动续；auto=允许续跑
    "chat": {                       // 聊天框绑定（权威副本在分身 chat.json）
      "sessionId": "s-abc123",      // 空 = 尚未绑定，首次派发时解析
      "workspaceId": "ws-...",
      "boundAt": 1762300000000
    },
    "intent": {                     // 当前活跃派发意图（单飞，I7）
      "intentId": "itn_01J...",
      "state": "queued|sent|admitted|working|stopped|done|failed",
      "attempt": 2,
      "deadlineAt": 1762303600000,  // 到点不再重试（预算）
      "lastSeq": 1833               // 宿主 session seq 游标（复算用）
    },
    "progress": {
      "phase": "editing|testing|waiting-approval|idle",
      "progressRevision": 7,        // 进度指纹：变了=有进展（stall 判定唯一依据）
      "lastActivityAt": 1762300123000,
      "rounds": 12,                 // 当前会话轮次
      "tokens": { "pressure": 96000, "window": 128000 },
      "stopReason": "idle|input-required|quota|error|null",
      "stopClass": null             // 见 7.1 分类表
    },
    "checkpointId": "ckpt_01J...",  // 最近一次可用断点
    "verdict": null                 // done 的唯一出口，见 4.6
  }
}
```

### 4.3 `DispatchIntent`（`dispatch-queue.jsonl` 一行）

```jsonc
{
  "v": 1,
  "intentId": "itn_01J8Z...",       // I1：客户端生成，全局唯一
  "taskId": "task_01J8Y...",
  "kind": "initial|continue|resume|probe",  // 四类意图，动作不同（§5.3）
  "createdAt": 1762300000000,
  "actor": "human|scheduler|ci",    // 谁发起的（审计与限流都靠它）
  "target": {
    "sessionId": "s-abc123|null",   // null → 由分身解析/新建（§5.1）
    "mode": "queue|steer"           // 直通 SessionPromptRequest.mode
  },
  "content": { "text": "…≤4096B…" },// 与 bridge 的 4096 字节上限对齐（bridge-client.mjs:120）
  "budget": { "maxAttempts": 3, "deadlineAt": 1762303600000 },
  "idem": {                          // 三层幂等映射（I1/I2）
    "commandId": "cmd_01J8Z...",     // adapter CommandCache 键
    "requestId": "req_01J8Z..."      // SessionPromptRequest.requestId
  }
}
```

派发结果不回写这一行，而是追加 `runs/<taskId>/attempts.jsonl`：

```jsonc
{ "v":1, "intentId":"itn_...", "attempt":1, "at":1762300009000,
  "result":"accepted",              // accepted|rejected|timeout|transport-error
  "code":null, "hostRequestId":"req_...", "seq":1834, "deduplicated":false }
```

> 为什么拆两处：意图是**事实**（不可变），结果是**证据**（可多次）。混在一行就要改写，改写就要锁，锁就要处理"锁持有者崩了"——全部避免。

### 4.4 `RunState` 投影（`runs/<taskId>/state.json`）

```jsonc
{
  "v": 1,
  "taskId": "task_01J8Y...",
  "revision": 41,                  // 每次投影更新 +1（单调，客户端可用它做 CAS）
  "computedAt": 1762300130000,
  "sources": { "sse": {"lastSeq": 1833}, "poll": {"at": 1762300128000}, "adapter": {"ok": true} },
  "session": { "sessionId": "s-abc123", "running": true, "active": true,
               "queue": 0, "pendingInput": [] },
  "run": { /* 4.2 的 run 块镜像 */ },
  "health": { "heartbeatAt": 1762300129000, "ttlMs": 90000, "alive": true },
  "degraded": []                   // ["sse-gap","adapter-unreachable","clock-skew"] 等，**如实上报**
}
```

### 4.5 `Checkpoint`（`runs/<taskId>/checkpoints/<ckptId>.json`）

```jsonc
{
  "v": 1, "ckptId": "ckpt_01J...", "taskId": "task_01J8Y...",
  "at": 1762300120000,
  "trigger": "turn-end|pre-continue|manual|pre-upgrade|stall",
  "session": { "sessionId": "s-abc123", "seq": 1833, "rounds": 12 },
  "declared": {                     // Agent 自己声明的（**只是线索，不是结论**，I6）
    "goal": "把 session-router 的三个模式拆成纯函数并补测",
    "done": ["router.mjs 纯函数化", "9 条单测"],
    "next": ["补 cross-machine 用例", "更新 docs"]
  },
  "evidence": [                     // 可机器校验的证据指针（不内联内容）
    { "kind": "file", "path": "src/plugins/session-router.mjs", "sha256": "…", "bytes": 4821 },
    { "kind": "test", "cmd": "node --test test/session-router.test.mjs", "last": "pass", "at": 1762300100000 },
    { "kind": "audit", "from": 1762299000000, "to": 1762300120000 }
  ],
  "budget": { "attemptsUsed": 1, "attemptsMax": 3 },
  "resumeHint": "从「补 cross-machine 用例」继续；先跑 npm test 确认基线未红。"
}
```

**硬规则**：`<32KB`；`sha256` 指向文件而非内容；不含 token/凭据/绝对家目录（I8）。

### 4.6 `Verdict`（完成判定的唯一出口，I6）

```jsonc
{
  "v":1, "taskId":"task_01J8Y...", "verdict":"done|needs-human|failed",
  "at":1762301000000,
  "basis": [                                  // 必须非空，且每项有证据
    { "kind":"verifier", "id":"dos-checks", "result":"pass",
      "cmd":"node tools/fangctl.mjs verify --task task_01J8Y...", "at":1762300990000 },
    { "kind":"human", "who":"fang", "at":1762301000000, "note":"确认产物可用" }
  ],
  "verifierBypass": false                     // 若 true，必须附 human 记录，否则拒绝落盘
}
```

> 没有 `Verdict` 就没有 `done`。`progress.phase` 变成 `idle` **不等于**完成——这条写进 §7.4 与测试用例。

### 4.7 `QuotaVerdict`（额度判定，§7）

```jsonc
{ "v":1, "class":"context-pressure|round-budget|provider-rate|balance|unknown",
  "severity":"green|amber|red",
  "measured": { "pressure": 96000, "window": 128000, "ratio": 0.75 },
  "action": "compact|continue|backoff|wait-schedule|needs-human",
  "retryAfterMs": 300000, "source":"tokenMeter|error-code|account", "at":1762300130000 }
```

### 4.8 `ScheduleBinding`（`schedules.json` 一行，权威在宿主 `schedule` 服务）

```jsonc
{ "v":1, "taskId":"task_01J8Y...", "scheduleId":"sch_...", "purpose":"continue|heartbeat|quota-probe",
  "target":{"kind":"session","sessionId":"s-abc123"},
  "timing":{"kind":"every","every_seconds":900},
  "createdAt":1762300000000, "lastDelivery":null, "active":true }
```

### 4.9 运行态状态机（意图视角，只允许这些边）

```text
queued ──send──▶ sent ──202/command-done──▶ admitted ──session.running──▶ working
  │                │                                                    │
  │                └─reject/timeout─┐                          turn-end  │
  │                                 ▼                                    ▼
  │                              stopped ◀────────────────────────────── stopped
  │                                 │
  │            ┌────────────────────┼───────────────────────┐
  │            ▼                    ▼                        ▼
  │        resume(intent)      needs-human                failed(budget)
  │            │                    ▲                        │
  │            └────▶ working       └── stall/quota-red ─────┘
  └── cancel ──▶ cancelled（终态，须人工重开）
```

终态：`done`（必须有 Verdict）/ `failed` / `cancelled` / `needs-human`。
`reconnecting`（进程崩溃）不是意图态，是**分身态**，由 TaskHandle 负责，映射到 `state.degraded=["adapter-unreachable"]`。

---

## 5. 自动派发（dispatch）

### 5.1 目标解析：聊天框在哪

输入 `intent.target.sessionId`，按序解析（**每一步都必须可解释、可审计**）：

| 步 | 条件 | 动作 | 结果码 |
|---|---|---|---|
| 1 | `target.sessionId` 非空 | 直接用；adapter `op:prompt` 前先 `state()` 确认存在且非归档 | `resolved:explicit` |
| 2 | 分身 `fang-run/chat.json` 存在 | 读绑定（母体**不缓存**，每次经 adapter 取，避免双源） | `resolved:bound` |
| 3 | 分身内恰有 **1 个**非 blank 会话 | `sessionController.list` 过滤 → 绑定并写 `chat.json` | `resolved:single` |
| 4 | 0 个会话 | `sessionController.create({cwd})`（cwd = 分身工作区）→ 绑定 | `resolved:created` |
| 5 | ≥2 个会话 | **不猜**。返回 `409 ambiguous-chat`，附候选列表，等人/策略指定 | `resolved:ambiguous` |

> 第 5 条是刻意的：猜错就变成"任务干在别人的会话里"，比失败更糟。`409` 带候选，UI 层（若将来有）或 CLI 都能一眼选。

### 5.2 幂等三角

```text
intentId（母体日志键）
   └─ commandId（adapter CommandCache 键，1:1）
        └─ requestId（宿主 SessionPromptRequest.requestId，1:1）
```

- 母体重放：`dispatch-queue.jsonl` 里有 `intentId` 且 `attempts.jsonl` 已有 `accepted` → 直接跳过（**不**再发）。
- 母体重发同一 `commandId`：`CommandCache` 命中 completed → 返回同一结果并标 `deduplicated:true`（`docs/ADAPTER-COMMANDS.md:81`）。
- 分身重发同一 `requestId`：由宿主侧去重（**当前 bridge 做不到**，见 A1；`op:prompt` 必须由我们自己把 `requestId` 传进去）。

### 5.3 四类意图与动作

| kind | 触发 | 动作 | 允许自动重试 |
|---|---|---|---|
| `initial` | 建任务后（`/api/tasks/create` 带 `autoDispatch`） | 解析目标 → 发送首条提示 | 是（≤3 次，传输类失败） |
| `continue` | 上一轮 `stopped(idle)` 且未 `done` | 发 `resumeHint`（**不是**重发原提示） | 是（受预算 + stall 约束） |
| `resume` | 崩溃/重启/冷会话 | `schedule.run()` 或 `op:prompt`（会自动 resume 冷会话） | 是（同 continue） |
| `probe` | 定时器到点 | **只读** `state()`，无副作用 | 否（无副作用无需重试） |

`mode` 选择：`queue` = 当前轮次结束后按序执行；`steer` = 打断当前轮立即插入。**默认 `queue`**：`steer` 会让 Agent 丢弃正在写的东西，只在"跑错方向了"时人工选。

### 5.4 派发事务（顺序不可换）

1. **写意图**：`appendFile(dispatch-queue.jsonl, intent)` + `fsync`（先落盘再发送，崩溃不丢意图）。
2. **单飞检查**（I7）：`runs/<taskId>/.lock`（`mutex.mjs`），拿不到 → 意图留在 `queued`，下个 tick 再试。
3. **(可选) 预检**：`op:state` 确认 `pendingInput` 为空。非空 → 不派发，转 `needs-human`（§7.4）。
4. **发送**：`POST /fang/adapter/commands {commandId, op:'prompt', payload:{requestId, sessionId, mode, content}}`。
5. **回执**：`attempts.jsonl` 追加 `accepted|rejected|timeout`；`state.json` 投影更新。
6. **提交**：`intent.state = admitted`，释放单飞锁（锁只保护"发送"这一段，不跨整个任务）。

### 5.5 失败分类（决定重试与否的唯一依据）

| 分类 | 判据 | 重试 | 退避 |
|---|---|---|---|
| `transport` | 连接失败/5xx/超时 | 是 | 1s→2s→4s + jitter（≤30s） |
| `session-changed` | adapter 409（`types.mjs:242`） | 是（重读 token+sessionId 后重发，**换 commandId**） | 立即（1 次） |
| `not-ready` | 503（adapter 未起） | 是 | 2s×n（≤10 次） |
| `quota-*` | 429/余额/上下文超限 | 见 §7 | 按 QuotaVerdict |
| `bad-request` | 400（payload 非法） | **否**（重试同错） | — |
| `ambiguous-chat` | 409（§5.1 步 5） | **否** | 等人工 |

---

## 6. 长任务状态跟踪

### 6.1 四个事件源（互补，任一可用即可降级运行）

| 源 | 取什么 | 频率 | 不可用时的降级 |
|---|---|---|---|
| adapter SSE（作者推荐） | `session-state` / `dispatch-accepted` / `turn-failed` | 事件驱动 | `degraded:["sse-gap"]` → 轮询兜底 |
| `op:state` 轮询 | `{running, active, queue, pendingInput}` | 1s（活跃）/ 15s（空闲） | — |
| `op:wait` | `{reason:'idle'|'input-required'|'timeout'}` + 有界输出 | 仅在等一轮结束时 | 退回轮询 |
| 文件指纹 | `sha256(src 树)` 的变化 | 每轮结束 | 记为不可用，stall 判定退回"仅 seq" |

### 6.2 `progressRevision`（进度指纹）

```text
progressRevision = hash(
  session.seq 段数,            // 宿主事件序号推进
  workspaceDigest(src/**),     // 工作区内容摘要
  checkpoint.declared.done.length,
  testPassCount                // 最近一次 verifier/测试通过数
)
```

变了 → 有进展，`attemptsUsed` 归零；不变 → 计入 stall 计数。**这是"Agent 说自己在干活"与"真的在动"的唯一区分手段**，也是 §7.4 的防伪造核心。

### 6.3 停滞与存活

- `stall`：连续 `K=2` 次 `continue` 后 `progressRevision` 不变 → `needs-human`（不再烧钱）。
- `heartbeat`：`op:ping` 或 SSE 心跳，`ttlMs=90s`；超时 → `health.alive=false`，但**不**自动判定失败（进程可能只是冷），交由 forker/TaskHandle 处理。
- 时钟：一切以宿主的 `seq` 与 `time` 为准；母体只用自己的单调时钟算超时（`Idle` 类逻辑沿用 `src/lib/idle-audit.mjs` 的做法）。

### 6.4 对外视图（`GET /fang/api/tasks/progress`）

返回 `RunState` 的**只读精简投影**：`{phase, progressRevision, lastActivityAt, rounds, pressureRatio, stopClass, checkpointId, verdict, degraded}`。
**不改 `client.js`**；既有面板不消费也不报错（多字段、无必填）。

---

## 7. 自动续"上下文额度"

先把"额度"这个词拆开——**三种额度、三套机制，混在一起必然错**：

### 7.1 三类额度

| 类 | 是什么 | 观测手段 | 到达边界后 |
|---|---|---|---|
| **Q1 轮次额度** | Agent 自动续跑轮数（goal continuation） | `ctx.goals.get(agent)` 的轮次/状态 | `goals.resume()` 再续，或转 schedule 唤醒 |
| **Q2 上下文窗口额度** | 单会话 token 压力 | `ctx.tokenMeter.contextPressure(session)` → `{pressureTokens, contextWindow}` | `ctx.compaction.compactNow()`；仍超则**带检查点续跑** |
| **Q3 供应商额度** | 限流 429 / 余额不足 | 错误码 + `ctx.deepseekAccount.getBalance()` | 定时探测 + 退避，到点重试 |

### 7.2 判定表（`stopClass → action`，唯一决策表）

| 观测 | stopClass | 动作 | 是否消耗预算 |
|---|---|---|---|
| `wait.reason=idle`，Verdict 缺失 | `turn-end` | 写检查点 → 发 `continue` | 是 |
| `wait.reason=input-required`（`pendingInput` 非空） | `needs-approval` | **停**，转 `needs-human`，提示"等人批" | 否 |
| `contextPressure.ratio ≥ 0.85` | `context-pressure` | `compactNow()` → 成功则 `continue`，失败则 `needs-human` | 是（压缩成功才算） |
| 错误码 429 / `rate-limit` | `provider-rate` | `backoff(waitFor=retryAfter|5min)` → `continue` | 是 |
| 余额不足 | `balance` | 建 `quota-probe` 定时器（every 30min）→ 恢复后 `continue` | 否（探测不算） |
| `goals` 达 `max_goal_rounds` | `round-budget` | `goals.resume()` 或新 `continue`（**需 `mode=auto`**） | 是 |
| 连续 2 次 `progressRevision` 不变 | `stall` | `needs-human` | **否，立即停** |
| 未知错误 | `unknown` | 记 `attempts.jsonl`，发**一次** `continue` 后仍失败 → `needs-human` | 是（1 次） |

### 7.3 预算与退避（写死，不给"聪明的自动"留空间）

```jsonc
{
  "attemptsMax": 3,            // 每个 intent 的续跑次数上限
  "deadlineMs": 3600000,       // 单 intent 墙钟上限（1h）
  "backoff": { "base": 5000, "factor": 2, "cap": 900000, "jitter": 0.3 },
  "stallK": 2,                 // 连续无进展次数
  "autoOnlyWhen": ["assisted", "auto"]   // run.mode=manual 时一律不自动续
}
```

### 7.4 绝不自动继续的五种情况（写进代码与测试）

1. `pendingInput` 含 `approval` / `question`（人在等，自动续等于**替人批**）。
2. `run.mode === "manual"`。
3. `intent.budget` 用尽。
4. `stall` 判定命中（I6 的防伪造）。
5. `degraded` 含 `adapter-unreachable` 且 `fork.status !== running`（先修进程，不要重试业务）。

---

## 8. 断点续跑

### 8.1 何时写检查点

| 时机 | trigger | 说明 |
|---|---|---|
| 每轮 `wait.reason=idle` | `turn-end` | 常规，成本低 |
| 发 `continue` 之前 | `pre-continue` | 保证"续跑前有据" |
| 母体 recompute / 升级前（v3.0.11 协同） | `pre-upgrade` | 升级失败回滚后仍能从断点续 |
| 人工 | `manual` | CLI 一条命令 |
| `stall` 命中 | `stall` | 存档给人看 |

### 8.2 恢复序（RL-1…RL-6，不可跳步）

```text
RL-1 读 runs/<taskId>/state.json + 最新 checkpoint
RL-2 探活：fork.status → 不在跑则 flop 到 TaskHandle.start()（或 forker.spawn）
RL-3 冷会话唤醒：op:prompt 自带 resume；或 schedule.run()（宿主语义：delivery 会 resume）
      —— 二者只选一个，用 schedule 时**不**再发 op:prompt（防双注入）
RL-4 对齐游标：op:state 取 seq，若 < checkpoint.seq → 记 degraded:["cursor-behind"]，不续跑
RL-5 注入 resumeHint：只发 §4.5 的 resumeHint + 一条"先复述你要做的下一步"，让人能在日志里核对
RL-6 起单飞锁，回到 §5.4 第 4 步
```

`RL-4` 的"游标落后就不续跑"是刻意的：宁可停，也不要在错误的上下文上继续改文件。

### 8.3 与 v3.0.11 recompute 的协同（重要）

母体升级（v3.0.10）→ 原身 recompute（v3.0.11）会替换 `merged/`。此时**正在跑的分身不受影响**（`v3.1.1版本.txt:1015`）。
因此：`pre-upgrade` 检查点是跨代际续跑的唯一凭据；新实例健康检查通过后，用同一 `checkpointId` 续跑，**不新建 intent**。

---

## 9. 定时任务

### 9.1 三类定时器（一表说清用途与预算）

| 用途 | 载体 | timing | 做什么 | 预算 |
|---|---|---|---|---|
| `continue` | **分身内** `schedule.create`（`target:{kind:'session'}`） | `every 900s`（可按任务调） | 到点投递 `resumeHint` → 宿主自动 **resume 冷会话** | 每次投递 = 1 attempt，受 §7.3 |
| `heartbeat` | 母体进程内 tick + `op:ping` | `interval 30s` | 刷 `health.heartbeatAt`，写 `state.json` | 无（只读） |
| `quota-probe` | **母体** `schedule.create`（`target:{kind:'new_once'}`）或 CLI | `every 1800s`，`COUNT` 上限 | 探测余额/限流是否恢复 → 恢复则 `continue` | ≤48 次后转人工 |

> 为什么 `continue` 用**分身内** schedule 而不是母体：只有分身进程能直接 resume 自己的会话（`SessionPromptRequest` 需要 `sessionId` 且会 resume Agent）。母体若代劳，就要每次 fork home 存活 + adapter 可达，可用性更差。反之 `quota-probe` 用母体的 schedule，因为余额是**账号级**的，与某个分身无关。

### 9.2 三个载体的取舍（诚实版）

| 载体 | 存活期 | 适用 | 代价 |
|---|---|---|---|
| 进程内 `ctx.timer.interval` | 到进程死 | 心跳、队列 drain | 母体重启会丢（但队列在盘上，重启即恢复） |
| DSH `schedule`（持久化，宿主调度） | 跨重启 | 会话唤醒、额度探测 | 只能投递"提示词"，不能跑任意函数 |
| OS 计划任务 / CI cron 调 `fangctl queue tick` | 跨机器 | 无人值守兜底 | 需要外部配置，不进仓库 |

**方案**：进程内 tick 为主（默认 5s，jitter ±20%），DSH `schedule` 负责"到点唤醒会话"，`fangctl queue tick` 作为**可选**兜底（文档给命令，不自动安装，避免偷偷改系统）。

### 9.3 具体 rrule / timing 模板

```jsonc
// 1) 每 15 分钟续跑（分身内，target=session）
{ "title":"continue task_01J8Y", "prompt":"[fang:continue] 读取 fang-run/<intentId>.json 的 resumeHint 并继续；若无进展先说明原因。",
  "timing":{"kind":"every","every_seconds":900},
  "target":{"kind":"session","sessionId":"s-abc123"} }

// 2) 额度探测：每 30 分钟，最多 48 次（母体，new_once）
{ "title":"quota-probe", "prompt":"[fang:quota-probe] 只读检查余额与限流状态，不要修改任何文件。",
  "timing":{"kind":"rrule","rrule":"DTSTART:<TZ 本地时刻>\nRRULE:FREQ=MINUTELY;INTERVAL=30;COUNT=48"},
  "target":{"kind":"new_once","create":{"cwd":"<mother workspace>"}} }

// 3) 每日 03:00 对账（母体）
{ "timing":{"kind":"daily","daily":{"time":"03:00","time_zone":"Asia/Shanghai"}} }
```

> 约束（与既有 tooling 一致）：`MINUTELY`/`HOURLY` 不接受 BY 部件；`COUNT ≤ 1000`；需要时区时用 `TZID`；重复时刻只算一次。**这些是宿主 `schedule` 的既有语义，不是本方案发明的。**

### 9.4 防雷同（与 reconnect storm 同款治理）

- 投递前 `schedule.view()` 查 `executionActive` / `deliveryFloorEndsAt`，正在执行则跳过。
- jitter：tick 内随机 ±20%（I9）。
- 幂等：每次投递携带 `intentId`（写进 prompt 的 `[fang:intent=…]` 标记），Agent 侧看到的重复标记 = 重放。
- `edit({active:false})` 暂停而不是 delete：保留 `history` 证据（`schedule.history` 给 `messageId`/`targetSessionId`）。

---

## 10. API 契约

### 10.1 母体 HTTP（新增，全部复用既有 `x-fang-auth` + CSRF/Host 校验）

| 方法 | 路径 | 入参 | 出参 | 备注 |
|---|---|---|---|---|
| POST | `/fang/api/tasks/dispatch` | `{taskId, text, kind?, mode?, intentId?, budget?}` | `{ok, intentId, state}` | 幂等：同 `intentId` 返回同一结果 |
| GET | `/fang/api/tasks/dispatch/queue` | `?taskId&limit` | `{ok, items[], nextCursor}` | 只读 |
| POST | `/fang/api/tasks/dispatch/cancel` | `{intentId}` | `{ok, cancelled}` | 只对 `queued|sent` 有效 |
| GET | `/fang/api/tasks/progress` | `?taskId` | `RunState` 精简投影 | §6.4 |
| POST | `/fang/api/tasks/checkpoint` | `{taskId, trigger?, note?}` | `{ok, ckptId}` | 立即写一份 |
| GET | `/fang/api/tasks/checkpoint` | `?taskId&ckptId?` | `{ok, checkpoint}` | 只读 |
| POST | `/fang/api/tasks/resume` | `{taskId, ckptId?, mode?}` | `{ok, intentId}` | 走 §8.2 |
| POST | `/fang/api/tasks/redo` | `{taskId, from: 'ckpt'|'start'}` | `{ok, intentId}` | 显式重来（审计必须记） |
| GET/POST | `/fang/api/tasks/schedule` | `GET ?taskId` / `POST {taskId, purpose, timing, active}` | `{ok, bindings[]}` | 镜像 `schedule` 服务 |

**降级契约**（fail-closed，不假装成功）：无 forker / adapter 未就绪 → `503 {ok:false, code:'not-ready'}`；`run.mode=manual` 却调 `resume` → `409 {code:'manual-mode'}`。

### 10.2 分身 adapter 协议 v4（`ADAPTER_PROTOCOL_VERSION: 3 → 4`）

新增 op（`types.mjs` 的 `ADAPTER_OP`，自动进入 `capabilities`，见 `adapter.mjs:590,643`）：

| op | payload | result | 映射到宿主 |
|---|---|---|---|
| `prompt` | `{requestId, sessionId?, mode:'queue'|'steer', text, clientTimeZone?}` | `{accepted, sessionId, requestId, seq}` | `sessionController.prompt()` |
| `state` | `{sessionId?}` | `SessionState`（`types.mjs` 同名类型） | `sessionController.state()` |
| `wait` | `{sessionId?, timeoutMs?, afterSeq?}` | `{reason, state, outputTail}`（tail ≤8KB） | `sessionController.wait()` |
| `checkpoint` | `{intentId, trigger, note?}` | `{ckptId, bytes, sha256}` | 写 `<forkHome>/fang-run/` |
| `quota` | `{}` | `QuotaVerdict` | `tokenMeter` + `deepseekAccount` |

新增事件（`ADAPTER_EVENT`）：`session-state`（`{sessionId, running, active, queue, pendingInput, seq}`）、`dispatch-accepted`、`turn-failed`（`{class, code, message≤300}`）。

兼容策略：版本协商已存在（`/adapter/version`）；旧母体不会发新 op（`unknown-op` 400，`types.mjs:231`），新母体对 v3 分身降级为 `degraded:["adapter-v3"]` 并禁用自动续（只保留手工派发）。

**bridge 补丁（必要的小改）**：`POST /v1/sessions/:id/messages` 接受**可选** `requestId`（缺省仍 `randomUUID()`），透传给 `controller.prompt`。这样 §5.2 的 `requestId` 才能跨桥幂等。同时校验 `mode` 取值与当前宿主一致（现存 `mode:'followup'`，而本机宿主 `SessionPromptRequest.mode` 是 `'queue'|'steer'`——**待实测确认是否兼容，列为 T-01**）。

### 10.3 CLI（`tools/fangctl.mjs` 子命令，不新增可执行文件）

```text
fangctl queue tick [--once] [--dry-run]   # 单次 drain（给 OS 计划任务用）
fangctl queue list  [--task <id>]         # 只读
fangctl run dispatch --task <id> --text "…"
fangctl run resume   --task <id> [--ckpt <id>]
fangctl run verify   --task <id>          # 调 verifier，产出 Verdict 证据
```

### 10.4 错误码（新增，沿用 `ADAPTER_ERROR_STATUS` 风格）

| code | HTTP | 含义 |
|---|---|---|
| `ambiguous-chat` | 409 | §5.1 步 5，候选 >1 |
| `manual-mode` | 409 | 自动续被策略拒绝 |
| `budget-exhausted` | 409 | §7.3 用尽 |
| `stalled` | 409 | §7.4 第 4 条 |
| `ckpt-not-found` | 404 | 断点不存在/被清理 |
| `cursor-behind` | 409 | §8.2 RL-4 |
| `not-ready` | 503 | adapter/fork 未就绪 |

---

## 11. 时序（三张）

```text
① 正常派发
POST /tasks/create(autoDispatch) ─▶ provision ─▶ spawn ─▶ handshake
        └─ writeDispatchIntent(initial) ─▶ tick ─▶ lock ─▶ op:state(空 pendingInput)
              ─▶ POST adapter/commands{op:prompt, requestId} ─▶ 202 accepted
                    ─▶ attempts.jsonl ─▶ state.json(admitted) ─▶ unlock
                          ─▶ SSE session-state: running ─▶ working ─▶ wait(idle) ─▶ checkpoint

② 额度耗尽 → 续跑
wait(idle) ─▶ Verdict?无 ─▶ quota{pressure:0.91} ─▶ compactNow() ─▶ ok
   ─▶ checkpoint(pre-continue) ─▶ continue intent ─▶ op:prompt(resumeHint)
   ─▶ (若无进展 ×2) ─▶ stall ─▶ Verdict{needs-human} ─▶ 停止烧钱

③ 崩溃 → 断点续跑
fork crash ─▶ TaskHandle reconnecting ─▶ forker restart(新 pid/port/token)
   ─▶ state.degraded=["adapter-unreachable"] ─▶ tick 跳过(§7.4-5)
   ─▶ fork-started ─▶ op:state{seq} 对比 ckpt.seq ─▶ 不落后
   ─▶ schedule.run() 或 op:prompt ─▶ working（同一 intentId，不新建）
```

---

## 12. 与现有 orchestrator / MCP 的接入点（逐文件）

| # | 文件 | 改什么 | 为什么安全 |
|---|---|---|---|
| 1 | `src/kernel/types.mjs` | +`ADAPTER_OP.{PROMPT,STATE,WAIT,CHECKPOINT,QUOTA}`、+`ADAPTER_EVENT.{SESSION_STATE,DISPATCH_ACCEPTED,TURN_FAILED}`、+`RUN_STATUS`、`ADAPTER_PROTOCOL_VERSION=4` | 纯增量常量；`capabilities` 由 `Object.values(ADAPTER_OP)` 自动派生（`adapter.mjs:590`） |
| 2 | `src/plugins/adapter.mjs` | 5 个内置 HANDLERS + 对外暴露 `publish`（供 watch 插件） | 内置 op 仍不可被 `registerCommand` 覆盖（`ADAPTER-COMMANDS.md:69`） |
| 3 | **新** `src/plugins/session-watch.mjs`（fork 角色） | 订阅 `ctx.sessionController.observeState` → `adapter.publish(session-state)` | 只读订阅；`roleGate` 保证母体不加载（`kernel/role.mjs`） |
| 4 | **新** `src/lib/dispatch-queue.mjs` | 意图日志 append/read/replay + `intentId` 幂等 | 复用 `src/kernel/fsx.mjs` 原子写；无新依赖 |
| 5 | **新** `src/lib/run-state.mjs` | 投影 `RunState`、`progressRevision`、stall | 纯函数，可用内存 FS 单测（同 `src/kernel/rounds.mjs` 的注入式 fs） |
| 6 | **新** `src/lib/quota-warden.mjs` | `stopClass → action` 判定表（§7.2） | 纯函数 + 一张表；表即测试用例来源 |
| 7 | `src/plugins/orchestrator.mjs` | 9 条路由 + `createTask` 接 `autoDispatch`；`archive` 前要求 `Verdict`（可配） | 路由集中在既有 `route()` 循环；不改既有 62 条签名 |
| 8 | `src/lib/task-handle.mjs` | 接线（`docs/TASK-HANDLE.md:166` 明列的下一步） | 库已测 20 项；接线只做编排 |
| 9 | `src/plugins/forker.mjs` | `spawn` 后注入 `DSH_FANG_RUN_DIR` 等 env | 已有 env 注入口（`orchestrator.mjs:529`） |
| 10 | `tools/fangctl.mjs` | 子命令（§10.3） | 既有 CLI 框架 |
| 11 | `cordis.patch.yml` | 新增 `fang-session-watch` 一行（fork 侧） | 加载器行 id 约定见 `kernel/types.mjs:30-46` |

### 12.1 MCP 接入（与 v3.0.8 "MCP" 对齐）

MCP 不特殊对待，**只当派发源之一**：

```text
MCP server ──tool call──▶ mcp_<name>_dispatch_task ──▶ POST /fang/api/tasks/dispatch
                                    │                    (intentId 由 MCP 侧生成并复用)
                                    └─ 返回 {intentId, state} → 后续用 /progress 轮询
```

- MCP tool 注册沿用 `ctx.tools.register`（`v3.1.1版本.txt:456-470` 的形态），本方案不新增协议。
- **MCP 侧必须传 `intentId`**：很多 MCP 客户端会重试 tool call，没有幂等键就等于重复派发。
- 分身内 MCP server 生命周期 = 分身生命周期；母体不代理 MCP 调用（避免母体变成数据面）。

### 12.2 与审计/审批的接线（不绕过）

| 既有机制 | 本方案如何用 |
|---|---|
| `auditor.append(kind, data)`（`AUDIT.*`） | 新增 `DISPATCH_SENT` / `DISPATCH_REJECTED` / `RESUME_TRIGGERED` / `VERDICT_RECORDED` 四种 kind |
| `restart-guard` / `approver` | 自动续跑**不**触发重启类高危动作；若 `continue` 需要重启进程 → 走既有审批（不新增路径） |
| `umbrella` 四色灯（`LIGHT`） | `op:prompt` 定级 `blue`（可自动），`redo` 定级 `yellow`（需确认） |

---

## 13. 与 v3.0.8–v3.3.3 路线对齐

**先说实话**：两份来源里**有锚点**的只到 v3.0.12（规格书）+ v3.1.0 / v3.1.1（仓库注释与审计报告）。**v3.1.2–v3.3.3 在仓库内没有任何文档锚点**，下表右列是**提案（P）**，需人工确认后才能进 CHANGELOG。

| 版本 | 该版本已知主题 | 锚点来源 | 本方案落点 |
|---|---|---|---|
| v3.0.8 | 分支 / 回流 / MCP（分支 spike 先行） | 规格书 :175、:297；`docs/SPIKE-v3.0.8-BRANCH.md`；HEAD 上 `7b72f95` | MCP 作为派发源（§12.1）；分支不影响派发目标解析（§5.1 用 sessionId 而非 branchId） |
| v3.0.9 | 升级状态 API + 版本角标（只读） | 规格书 :485；HEAD `a62a7f5`（`/api/upgrade/status` 已存在，`orchestrator.mjs:1391`） | 只读原则沿用：`/tasks/progress` 先落只读投影，写能力后开 |
| v3.0.10 | 母体代际升级 + 指针切换 + 回滚 | 规格书 :750 | `pre-upgrade` 检查点（§8.3）；升级期间 tick 暂停（`degraded:["upgrade"]`） |
| v3.0.11 | 原身 recompute + 新实例启动/健康检查 | 规格书 :1032 | 健康检查通过才允许 `resume`（§8.2 RL-2/RL-3），否则停在 `needs-human` |
| v3.0.12 | 插件更新 + snapshot/restore + smoke/rollback | 规格书 :1266 | 复用 `smoke` 结论做 `verifier` 证据源之一（§4.6 `evidence.kind=test`） |
| v3.1.0 | Onboarding / MirrorBootstrap 三盘初始化 | `docs/AUDIT-v3.0.1.md:45`；`src/lib/status-store.mjs:2`、`interaction-poke.mjs:2` 自称 v3.1.0 | 本方案不触碰引导流程；只依赖 `layout`（`resolveFangLayout`） |
| v3.1.1 | DSH client-half 插件包 | `docs/AUDIT-v3.0.1.md:45` | **地雷**：client-half 属 UI，本方案**明确不改** `client.js`（约束 2） |
| **v3.1.2（P1）** | **派发骨架** | 提案 | §4.3/§5/§10.2 的 `prompt`+`DispatchIntent`+`chat.json` |
| **v3.1.3（P2）** | **运行态跟踪** | 提案 | §6 四源投影 + `progressRevision` |
| **v3.1.4（P3）** | **断点续跑** | 提案 | §8 检查点 + RL 六步 |
| **v3.2.0（P4）** | **额度守卫 + 自动续跑（默认关）** | 提案（minor：新增能力） | §7 三类额度 + 判定表 + 预算 |
| **v3.2.1（P5）** | **定时器族** | 提案 | §9 三类定时器 + 防雷同 |
| **v3.2.2（P6）** | **MCP 派发适配** | 提案 | §12.1 |
| **v3.3.0（P7）** | **多分身并行调度 / 配额账本联动** | 提案（与 `docs/DERIVED-ORCHESTRATION.md` §2.4/§6.2 的配额归属对齐） | §5.4 单飞扩展到"每 identity 单飞"；`maxForks` 与队列预算联动 |
| **v3.3.1–v3.3.2（P8）** | 观测/告警/取证打磨 | 提案 | §6.4 + `docs/DERIVED-ORCHESTRATION.md` §10.4"五分钟取证" |
| **v3.3.3（P9）** | 收口：回滚演练 + 发布候选 | 提案 | §14.5 验收清单 + 人工 tag |

> 若人工确认的 v3.2/v3.3 内容与上表冲突，**以人工为准**，上表整列作废、只保留"本文能力清单"部分——能力清单本身与版本号解耦。

---

## 14. 测试计划

### 14.1 单测（`node --test`，与既有 59 个测试文件同风格）

| 新文件 | 用例 | 覆盖 |
|---|---|---|
| `test/dispatch-queue.test.mjs` | 12 | append 原子性、`intentId` 重复不重复发、日志损坏行跳过、replay 保序、cursor |
| `test/run-state.test.mjs` | 10 | 投影幂等、`progressRevision` 变化检测、stall K=2、degraded 聚合、revision CAS |
| `test/quota-warden.test.mjs` | 14 | §7.2 八行判定各一条、§7.4 五条各一条、预算耗尽 |
| `test/checkpoint.test.mjs` | 8 | 体积上限、无凭据、seq 落后拒续、sha256 校验 |
| `test/schedule-binding.test.mjs` | 8 | 三类 timing、jitter 上界、单飞、`executionActive` 跳过、暂停保历史 |
| `test/adapter-v4.test.mjs` | 10 | 5 个新 op 信封、capabilities 含新 op、旧 token 401、`requestId` 透传、413 |

**基线不回归**：现有 648 单测 + e2e 66/66 必须保持（`docs/CHANGELOG.md:33`）。

### 14.2 契约测试（双方各一份，防单边漂移）

- 母体侧：`ForkClient` 对 v3 分身发 `prompt` → 必须收到 `unknown-op` 并**优雅降级**（不重试、不崩）。
- 分身侧：`op:prompt` 缺 `requestId` → `bad-request`（fail-closed，不偷偷生成）。
- 版本协商：`/adapter/version` 返回 `4`，母体接受 `≥3`，`<3` 拒绝自动续。

### 14.3 对抗测试（本方案的真正验收）

| ID | 场景 | 必须成立 |
|---|---|---|
| X-01 | 同一 `intentId` 连发 3 次（网络重试） | 宿主只收到 **1** 次 prompt；`attempts.jsonl` 记 1 条 `accepted` 2 条 `deduplicated` |
| X-02 | 发送中途 kill 分身进程 | 重启后 `resume` 用**同一** `intentId`；无重复轮次 |
| X-03 | 冷会话放置 2h 后命中 schedule | 会话被 resume，`history` 有 delivery 记录，轮次 +1（不是 +2） |
| X-04 | `pendingInput=approval` 时触发自动续 | **拒绝**，`needs-human`，审计有 `RESUME_BLOCKED` |
| X-05 | 注入 429 → 退避 → 恢复 | 退避序列单调 + jitter 上界内；恢复后仅 1 次 `continue` |
| X-06 | Agent 自述"完成了"但 verifier 红 | `Verdict` 只能是 `needs-human`，**不得** `done` |
| X-07 | 连续 2 轮 `progressRevision` 不变 | 第 3 次 `continue` 被拒（`stalled`） |
| X-08 | adapter 返回 `session-changed` 409 | 重读 token/sessionId，换 `commandId` 重发 1 次；仍失败 → `needs-human` |
| X-09 | 两个 tick 并发（模拟双进程） | 单飞锁只有一个赢；另一个不改状态 |
| X-10 | 母体升级期间 tick | tick 全跳过，升级完成后按 `pre-upgrade` 检查点续跑 |
| X-11 | 时钟回拨 5 分钟 | 只用单调时钟算超时；不产生"已过期"误判 |
| X-12 | fork home 不可写 | 检查点写失败 → 派发照常但标 `degraded:["ckpt-unavailable"]`，**不**谎报成功 |

### 14.4 e2e（扩 `tools/e2e.mjs`，不新增框架）

1. `create(autoDispatch)` → 分身内出现 1 条用户消息 → `progress.phase=working`；
2. `wait(idle)` → 自动 checkpoint 落盘 → 文件 sha256 与证据一致；
3. `resume` → 会话轮次 +1 且**无**重复消息（比对 session 事件 seq）；
4. 归档前置 `Verdict`：无 Verdict 时 `archive` 返回 `409 verdict-required`。

### 14.5 验收 DoD（命令可执行，结果不许口头声称）

```powershell
npm test                                   # 全绿（含新增 62 条）
node tools/fangctl.mjs verify              # 既有 16 行完整性
npm run preflight -- --e2e                 # RED→GREEN 必须真实贴输出
node tools/e2e.mjs --only dispatch,resume  # 新增 4 条
```

**发布**：`npm run build` / `publish:npm` / tag **一律等人确认**（沿用 `docs/RELEASE-WAIVER-v3.0.7.md` 的"不跳号"纪律）。

---

## 15. 风险与守卫

| # | 风险 | 守卫 |
|---|---|---|
| R1 | 重复注入导致重复干活/重复计费 | 幂等三角（§5.2）+ X-01/X-02 |
| R2 | 自动续变成"自动烧钱" | 预算三步（attempts / deadline / stall）+ 默认 `mode=assisted` |
| R3 | 替人做决定（自动批准审批） | §7.4 第 1 条，硬编码 |
| R4 | 伪造完成 | `Verdict` 唯一出口 + X-06 |
| R5 | 上下文压缩后信息丢失 | 检查点先写再压缩（§8.1 `pre-continue`） |
| R6 | adapter v4 与旧母体不兼容 | 版本协商 + `unknown-op` 降级 + 契约测试 §14.2 |
| R7 | bridge `mode` 值不一致（`followup` vs `queue|steer`） | **T-01 实测确认**；不一致就先修 bridge 再启用桥派发 |
| R8 | 定时器惊群 | jitter + 单飞 + `executionActive` 检查 |
| R9 | 跨机/跨代际的会话串台 | `target.sessionId` 显式优先；`ambiguous-chat` 不猜 |
| R10 | 磁盘无界增长 | `dispatch-queue.jsonl` 按月轮转；`runs/` 只留最近 20 个 ckpt；`state.json` 原子覆盖 |
| R11 | 把"分身零共享"破坏成母体直写 fork home | I11：母体只经 adapter 读；代码评审 checklist 一条 |
| R12 | UI 意外被动到 | 约束 2：`client.js` 与 `locale/*` 不在本方案 diff 内 |

**明确不做**（防止范围蔓延）：不做分布式共识、不做多机同一 session 并发写、不做 Agent 自评打分、不做新的前端面板、不做自动发布。

---

## 16. 交付与排期（4 个 PR，均不开 main）

| PR | 内容 | 分支 | 门禁 |
|---|---|---|---|
| PR-1 | `types.mjs` + `adapter.mjs` 5 op + `session-watch` + 协议 v4 | `feat/adapter-v4-prompt` | 单测 10 + 契约 3 |
| PR-2 | `dispatch-queue` + `run-state` + orchestrator 5 条只读路由 | `feat/dispatch-queue` | 单测 22 + e2e 1 |
| PR-3 | checkpoint / resume + `fangctl` 子命令 + TaskHandle 接线 | `feat/resume-checkpoint` | 单测 8 + 对抗 X-01..X-03, X-12 |
| PR-4 | `quota-warden` + schedule binding（**默认关闭**，config 开） | `feat/quota-warden` | 单测 22 + 对抗 X-04..X-11 |

分支策略：全部 stacked 在 `feat/upgrade-coordinator` 之上（与 v3.0.8/v3.0.9 在飞保持一致），**只开 draft PR，不 merge、不 tag、不 publish**。

---

## 附录 A：必须由人拍板的 7 件事

1. **版本映射**：v3.1.2–v3.3.3 的提案映射（§13 右列）是否认可？不认可就只保留能力清单。
2. **默认模式**：新任务默认 `manual` / `assisted` / `auto` 哪个？（本文建议 `assisted`）
3. **自动预算**：`attemptsMax=3` / `deadline=1h` / `stallK=2` 是否合适？
4. **完成判定**：`archive` 是否强制要求 `Verdict`？（强制更安全，但会改变现有操作习惯）
5. **bridge 改造**：是否允许改 `@ignotuss/dsh-desktop-bridge` 增加可选 `requestId`（跨包改动）？
6. **定时器载体**：是否允许文档里给出 Windows 计划任务示例（不自动安装）？
7. **发布**：v3.1.2 起是否仍沿用"不跳号 + 人工豁免"纪律？

---

## 附录 B：证据索引（本文所有事实的出处）

- 规格书：`<v3.1.1规格书>`（v3.0.8 :175/:297、v3.0.9 :485、v3.0.10 :750、v3.0.11 :1032、v3.0.12 :1266、母体升级不打断分身 :1015、MCP 注册形态 :456）
- 现状：`src/kernel/types.mjs:165-171,174-184,210-220`；`src/plugins/orchestrator.mjs:428-573,1386-1604`；`src/plugins/adapter.mjs:590,643,746-811,842-848`；`src/lib/bridge-client.mjs:116-124`；`dist/vendor-inspect/_ignotuss_dsh-desktop-bridge/package/src/index.js:220-240`
- 文档：`docs/TASK-HANDLE.md:166`（未接线）、`docs/ADAPTER-COMMANDS.md:70-97`（幂等/SSE 语义）、`docs/PROTOCOL-V3.md`（协议 v3）、`docs/DERIVED-ORCHESTRATION.md` §2.4/§6.2/§10.4、`docs/CHANGELOG.md:33`（648 测试/e2e 66）
- 宿主原语（本机 inspect 实读，非推测）：`sessionController.prompt|state|wait|observeState`、`schedule.create|run|edit|history|deliveryLimits`、`goals.create|resume|pause|block|disarm`、`tokenMeter.contextPressure`、`compaction.compactNow`、`deepseekAccount.getBalance`
