# 设计：三区控制台与分身 Web 的实时状态

> 副标题：分身六态 · 派生四段 · 满员/VIP 前置 · 1:1 多分支 · 切换读写权 · 归档保留

- 文档状态：设计提案（P0 契约层），待实现评审。
- 代码基线：dsh-Fang `3.0.4`；client 面板 `3.0.1` 代际（5 s 面板轮询 / 8 s 升级轮询 / 10 s 徽标）。
- 上游依据：`docs/REVIEW-三区隔离与快照回流.md`（下称「三区评审」）与 `docs/REVIEW-会话分支实时协作语义.md`（下称「分支评审」）。
- 本文边界：只定义**权威、契约、频率、上限、恢复与判定**，不写实现，不粘贴源码；代码位置只作为证据索引放在附录。
- 结论口径：**轮询是骨架，推送只做失效通知；状态是派生的，事实是持久化的；容量是预判 + 服务端仲裁；1:1 用归属会话，分支用引用修订；切换必须穿越“无写者”；归档保留全部会话数据。**

---

## 0. 决策摘要

| # | 决策 | 选择 | 理由 | 代价 / 何时改 |
|---|---|---|---|---|
| D1 | 面板实时传输 | 条件 GET 轮询 + `ETag`/`If-None-Match`，`BroadcastChannel` 选主；SSE 只在 P3 做“失效通知” | 面板是请求-响应、多标签页、无双向需求；304 天然省流量，服务端无 per-connection 缓冲 | 快速档仍有 1 s 延迟；若将来跨机控制台或 >5k 观看者，再评估 SSE/WebSocket |
| D2 | 生命周期状态 | **六态派生**：`starting/running/stopping/failed/crashed/archived`；`ready` 降为适配器健康，不再作为生命周期 | 现在把“进程在不在”和“握手成不成”混在一根轴；`provisioning` 被呈现成 `failed`，`crashed` 被丢弃 | 需要持久化 `phase/startedAt/stopRequestedAt/exit`；`taskView` 变纯函数 |
| D3 | 派生进度 | 四段不确定态 + `ready` 终止；总预算 20 s | 与 UX 规格的 4 段进度轨一致；`ready` 不是第 5 段 | 需 `POST /api/derive` 改 202 + `opId`；否则拿不到进度 |
| D4 | 容量前置 | 快照给出 `capacity.headroom` + 服务端动作掩码；点击前零请求；最终仍由服务端 409 仲裁 | 前端算不出 `reserved/stopping`；双标签页会同时通过 | 需要同步预留账本与 `opId` 幂等 |
| D5 | 1:1 归属 | 任务增加唯一 `primarySessionId`；其余会话记为 `orphans`（隐藏、只导出），面板不再展开会话列表 | 现在 `listForkSessions` 返回“列表”，1:1 不成立；导入会塞进第二个会话 | 旧 `/api/tasks/sessions` 保留为兼容别名，内部只返回归属会话 + 计数 |
| D6 | 分支模型 | 分支 = 父日志字节前缀 + 独立段；键为 `(taskId, sessionId, branchId)`；不复制、不硬链接、不挂母体会话 | 复制会半帧、成本 ×N；硬链接会双写穿；母体只读是硬约束 | 需要 `refs` 双槽、`segment`、`journal`、租约 |
| D7 | 切换语义 | 重启式切换：停运行时 → 翻 `refs` → 物化 → 启动 → 握手；切换期间无写者 | 热切换依赖未知上游能力；rename 活动日志会造成不可恢复双写 | 3–8 s 可见等待；必须有 `stopping` 与明确失败 |
| D8 | 读新鲜度 | `refsRev + activeBranchId + tipBytes` 三元组；ETag 必须包含 active 指针；缓存键必须含 `branchId` | 只哈希分支列表会漏掉切换这一格，导致永久 304 旧分支；标题缓存会串味 | 需要改 ETag 与缓存键；测试 T8 类断言 |
| D9 | 写所有权 | 任一分支任一时刻至多一个写者；切换必穿越“无写者”；fencing 只能检测式，不能预防上游 | 我们改不了 DSH 运行时；诚实口径是“不主动制造双写，发生能看见” | 需要 tip 上报、指纹采样、`fenced/diverged` 状态 |
| D10 | 归档 | 归档 = 冻结：flush + 停进程 + 保留 home + 全部分支可读 + active 指针保留；删除才销毁 | 归档删数据是当前最大语义风险；分支必须随会话保留 | 删除确认需列分支数与体积；`reap` 不得当归档用 |
| D11 | 客户端 store | 不把 `MirrorStatusStore` 改成多资源；新增 `PanelSnapshotStore` / `BranchRefsStore` / `PendingMutationsStore` / `PresenceStore` | 改多资源会破坏既有测试与 idle-audit 契约 | 多一个组合层；selector 必须纯函数 |
| D12 | 协调器 | 恢复完成是重算前置；单飞加 `rerunRequested`；状态快照引用稳定且带 `rev` | 半恢复上重算会产出“谁都不信”的 fingerprint；分支触发的重算会被静默丢弃 | 需要 `RecoverySupervisor` 与稳定缓存 |
| D13 | 修订模型 | `panelEpoch`（母体启动世代）+ `panelRev`（世代内单调）+ 每会话 `refsRev`（持久化）+ 每分支 `tipBytes` | 母体重启后 `rev` 会倒退，客户端若只比 `rev` 会永远丢新包 | 需要 epoch 进 ETag；重启后首个包强制 200 |
| D14 | 频率 | 60 s 空闲 / 5 s 活跃 / 1 s 快速 / 500 ms 涡轮（仅进度条，全局至多 1 个） | 一套节奏覆盖三区；快速档必须有上限与释放 | 快速档持有期间不得被 idle 降级 |
| D15 | 测试 | 纯函数崩溃注入 + store 契约 + HTTP 契约 + 真进程 + 文件 fixture；82 条 RT 用例 + 固定种子 fuzz | 收敛性/崩溃恢复不能靠手测；Windows 句柄语义只有真机可复现 | CI 需要 Windows runner；性能用例需 IO 计数 |

---

## 1. 范围与语义地基

### 1.1 范围

**覆盖：**

- 母体侧「三区控制台」：总控（母体/镜像/升级）、工厂（原身）、车间（分身）的实时状态。
- 分身 Web：分身自己的 DSH Web UI 中与 fang 相关的实时状态（归属会话、当前分支、可写/只读、切换后重启提示）。
- 分身六态、派生四段、满员/VIP 超额前置判定。
- 分身 ↔ 会话 1:1、同会话多分支、分支切换的读新鲜度与写所有权、归档保留会话数据。
- `status-store` / `upgrade-coordinator` 的接口契约与测试矩阵。

**不覆盖（写进 CONTRACTS 的“不做”清单）：**

- 分支合并（CRDT/OT）；v1 跨分支只有“从该分支派生新分身”。
- 运行中热切换活动日志。
- 母体会话的分支写入（只允许只读切点 + 派生）。
- 分支 = 目录复制 / 硬链接 / reflink 依赖。
- 面板 WebSocket、每卡独立轮询、满员排队。

### 1.2 术语

| 术语 | 含义 | 谁写 | 生命周期 |
|---|---|---|---|
| **事实（fact）** | 服务端持久化的原始字段：`status/phase/startedAt/stopRequestedAt/exit/adapter/archivedAt/primarySessionId` | 服务端权威 | 随任务/会话 |
| **视图（view）** | 由事实派生的六态、灯、文案、动作掩码 | 纯函数，不落盘 | 每次快照重算 |
| **快照（snapshot）** | 三区一次渲染所需的稳定字段集合 | 服务端组装 | 每请求 |
| **修订（rev）** | 世代内单调递增的语义变更号 | 服务端单写者 | 进程内 + 尽力持久化 |
| **世代（epoch）** | 母体每次启动一个新值 | 服务端 | 进程生命周期 |
| **引用修订（refsRev）** | 单会话分支引用清单的修订号 | 分支服务 | 持久化在 refs 槽 |
| **段尾（tipBytes）** | 某分支可见日志的字节长度 | 运行时/分支服务 | 同一 `writerEpoch` 内随追加单调 |
| **操作号（opId）** | 客户端生成的幂等键 | 客户端 | 请求 + 2 分钟去重窗口 |
| **预留（reservation）** | 派生/还原占用的容量位 | 准入账本 | 25 s TTL |
| **租约（lease）** | 跨进程临界区的所有权 | 持锁者心跳 | 10 s TTL |
| **在场（presence）** | 谁在看哪个分支 | 客户端心跳 | 30 s TTL，永不落盘 |
| **写者（writer）** | 当前可追加该分支日志的主体 | 运行时或 fang（物化中） | 分支状态决定 |
| **归属会话（primarySessionId）** | 分身唯一对应的会话 | 服务端 | 随任务 |

### 1.3 十条不变式

| # | 不变式 | 违反时的用户可见后果 |
|---|---|---|
| I1 | **单一权威**：生命周期、容量、分支写权都来自服务端事实；客户端不从 mtime、标题、URL 猜状态 | 卡片闪烁、假绿、幽灵分身 |
| I2 | **单调**：`(epoch, rev)` 在世代内不倒退；`refsRev` 每会话不倒退；`tipBytes` 在同一 `writerEpoch` 内只增不减（段尾修复会换 epoch，允许向下修正并记审计） | 旧包覆盖新包、面板卡在旧分支 |
| I3 | **幂等**：`opId` 对派生/切换/建分支/删除去重；`(branchId, writerEpoch, tipBytes)` 对上报去重 | 双击派生两个分身、重试切两次 |
| I4 | **单写者**：任一分支任一时刻至多一个写者；切换必然穿越一次“无写者” | 两分支交替写同一 inode，不可恢复 |
| I5 | **在场易失**：presence 不进快照、不进 ETag、不进 journal | 光标一动整面板重渲染、审计噪声 |
| I6 | **容量包含预留**：`headroom = max - (running + starting + stopping + reserved)`，展示不得为负 | 并发派生越过上限，最后变成“请求失败” |
| I7 | **陈旧不否决**：陈旧快照只能提示，不能永久禁用动作；最终由服务端 409 仲裁 | 网络恢复后按钮仍灰，用户以为坏了 |
| I8 | **归档 ≠ 删除**：归档保留 home、全部分支、active 指针；删除才销毁 | 归档即删生产数据 |
| I9 | **不假装成功**：未握手不变绿；未观察到进程退出不标 `archived`；未翻 refs 不标“已切换”；ghost 不静默消失 | 用户点开一个未就绪分身、以为切换成功 |
| I10 | **有界**：每个队列、每次读、每个 payload 都有上限；慢消费者只掉质量不掉内存 | 热房间/多标签把服务端拖死 |

---

## 2. 分身六态与状态同步表

### 2.1 事实字段：先把“状态”拆成可持久化的事实

现状的核心问题不是“少一个枚举”，而是**状态被存在多个地方且互相覆盖**：`task.status`、`forker` 记录的 `running/starting`、`adapter.ok`、进程退出码各说各话，`taskView` 在读取时临时拼一个四值枚举，于是 `provisioning` 变 `failed`、`crashed` 变 `failed`、归档过程中闪 `failed`。

目标：**只持久化事实，六态每次由纯函数派生。**

| 事实字段 | 写入者 | 语义 | 持久化 | 现状 |
|---|---|---|---|---|
| `task.status` | orchestrator | 兼容旧枚举：`provisioning/ready/running/archived/failed` | `tasks.json` | 有，但 `ready` 混入生命周期 |
| `task.phase` | orchestrator | `accepting/provision/spawn/handshake/ready/stopping/archived/failed` | `tasks.json` | **缺失** |
| `task.startedAt` | orchestrator | 进程真正启动的时刻 | `tasks.json` | **缺失**（时长算不出来） |
| `task.stopRequestedAt` | orchestrator | 归档/切换发起停止的时刻 | `tasks.json` | **缺失**（无法表达 `stopping`） |
| `task.stoppedAt` | orchestrator | 观察到进程退出的时刻 | `tasks.json` | **缺失** |
| `task.archivedAt` | orchestrator | 归档确认时刻 | `tasks.json` | 有 |
| `task.exit` | forker → orchestrator | `{kind, code, signal, at, source}`；`kind ∈ {normal, crash, restart-request}` | `tasks.json` + `forks.json` | forker 有 `exit`，`taskView` 未透出 |
| `task.adapter` | orchestrator | `{ok, protocol, version, sessionId, at}`；这里的 `sessionId` 是 **adapter 事件流 id**，不是 DSH 会话 id | `tasks.json` | 有（注意语义） |
| `task.primarySessionId` | orchestrator | 唯一归属会话 | `tasks.json` | **缺失**（1:1 不成立） |
| `task.orphanSessionIds` | orchestrator | 额外会话（导入/运行时自建） | `tasks.json` | **缺失** |
| `task.opId` | orchestrator | 最近一次派生/还原的操作号 | `tasks.json` | **缺失** |
| `task.reservationId` | 准入账本 | 容量预留句柄 | `tasks.json` + 内存 | **缺失** |
| `task.urlEpoch` | orchestrator | 每次 spawn 递增；URL/token 轮换的代号 | `tasks.json` | **缺失** |
| `task.recovery` | RecoverySupervisor | `{switchAborted, tailRepaired, refsReconstructed}` | `tasks.json` | **缺失** |
| `task.health` | 派生 | `handshaked` / `no-adapter` | 不落盘（由 `adapter.ok` 派生） | 有 `adapter.ok` |

规则：

1. **`ready` 不是生命周期。** 它是 `health = handshaked`。`task.status` 仍可保留 `ready` 供旧调用方读，但新视图只读 `phase + exit + archivedAt`。
2. **`phase` 只由 orchestrator 写，且在每次 await 前后落盘。** 进程崩溃后，`phase` 是恢复的唯一线索。
3. **`exit` 必须来自 `classifyExit`**（正常 / 重启请求 / 崩溃），不能由“列表里没了”推断。
4. **`startedAt` 是进程启动时刻，不是任务创建时刻。** 运行时长 = `now - startedAt`，只在客户端每秒刷新，不进快照、不进 ETag。

**两个事实来源必须对齐：**

- `tasks.json`（orchestrator）：`phase/opId/archivedAt/primarySessionId/stopRequestedAt/urlEpoch`。
- `forks.json`（forker）：`starting/exit/startedAt/exitedAt/restartScheduledAt/lastError`。

目标契约：`forker.status(forkId)` 必须返回 `{starting, exit, startedAt, exitedAt, restartScheduledAt}`；否则 orchestrator 无法派生 `starting/crashed`。当前 `status()` 只返回 `status/running/pid/port/http/url`，`publicFork()` 虽有 `exit/startedAt`，但 `taskView` 没有使用——这是六态缺失的直接原因之一。

### 2.2 六态派生：顺序即优先级

派生函数是纯函数 `deriveRuntime(facts) → {runtime, health, reason, since}`。判定顺序如下（先命中先返回）：

| 序 | 条件 | 结果 | 说明 |
|---|---|---|---|
| 1 | `archivedAt != null` 且已观察到退出 | `archived` | 终态；若进程仍活，拒绝置 archived（见 I9） |
| 2 | `stopRequestedAt != null` 且未观察到退出且未 archived | `stopping` | 归档/切换的“穿越期”；超过 3 s + 1 s 宽限仍未退出 → 由服务端清 `stopRequestedAt` 或写 `stopFailedAt`，客户端不自己超时 |
| 3 | `phase ∈ {accepting, provision, spawn, handshake}` 或 `forker.starting` 或 `reservation` 有效 | `starting` | 包括还原；**不再把 `provisioning` 呈现成 `failed`** |
| 4 | `exit.kind = 'crash'` 且非主动停止且未 archived | `crashed` | 保留 `code/signal`；若已安排重启，附 `restartScheduledAt`，仍显示 `crashed` 直到下一次 `spawn` |
| 5 | 进程不在且没有 crash 证据（含正常退出、启动失败、超时） | `failed` | 必须带 `reason`：`provision-timeout/provision-interrupted/spawn-failed/exited/timeout/unknown`；握手超时**不**进这一行（保留 `running/no-adapter`） |
| 6 | 进程活 | `running` | `health = adapter.ok ? handshaked : no-adapter` |

补充规则：

- **`stopping` 优先于 `starting`**：还原时先停旧进程再起新进程，不能在这 200 ms 里显示“启动中”。
- **`crashed` 与“自动重启中”不矛盾**：重启计划存在时仍显示 `crashed`，卡片文案“已崩溃 · 3 s 后重试”；真正 `spawn` 后变 `starting`。
- **正常退出（code 0）没有独立枚举**：六态里最接近的是 `failed`，但文案必须是“已停止（退出码 0）”，并带 `reason=exited`。这是产品文案待确认项（§10）。
- **未知退出**：母体重启后只看到 pid 死了、没有 `exit` 记录 → `failed(reason=unknown)`，不冒充 `crashed`。三区评审的“3 次轮询仍无 exit → 降级为 failed / 原因未知”在这里落地。
- **`archived` 必须以观察到退出为前提**：归档流程先 `stop`，再轮询最多 `archiveStopTimeoutMs=3s`；只有观察到 `alive=false` 才能写 `archivedAt`。

### 2.3 六态动作矩阵（服务端给掩码，UI 不猜）

| 态 | 灯 / 文本 | 允许 | 禁止 | 可切分支？ | 写者 |
|---|---|---|---|---|---|
| `starting` | 黄（呼吸）· `启动中 · 装配/握手` | 查看、取消（若 API 支持） | 打开、归档、下载、切分支、建分支 | 否 | 无（预留中） |
| `running` | 绿 · `运行中 · 00:42:17 · 端口/PID` | 打开、归档、下载、建分支 | 改配置、切分支、直接写文档 | 否（运行时持日志） | 运行时（active 分支） |
| `stopping` | 黄（转圈）· `停止中 · 最多 3s` | 查看 | 打开、再归档、切分支、建分支、发送 | 否 | 无（排空中） |
| `failed` | 红 · `已停止 · 原因` | 归档、删除、诊断、重试派生、切分支、建分支 | 打开、发送 | 是（无活写者） | 无 |
| `crashed` | 红（脉冲一次）· `已崩溃 · code N` | 归档、下载、重试、切分支、建分支 | 打开、发送 | 是（无活写者） | 无 |
| `archived` | 灰 · `已归档 · home 1.2 GB` | 还原、下载、删除、读分支、导出全部分支、切换（只读，需租约） | 打开、派生、建分支、写文档 | 是（只读切换；还原后可写） | 无 |

动作掩码（服务端随快照返回，避免 UI 自行推导）：

| 字段 | 含义 |
|---|---|
| `actions.open` | 是否有可用 URL 且 `runtime=running`（不需已握手；握手是健康徽章，不是打开门槛） |
| `actions.archive` | 是否可归档（`running/failed/crashed`） |
| `actions.restore` | 是否可还原（`archived` 且 home 在） |
| `actions.download` | 是否可导出（`running` 时需二次确认“某一时刻副本”） |
| `actions.switchBranch` | 是否可切换（`failed/crashed/archived` 且无租约冲突；`running` 一律否） |
| `actions.createBranch` | 是否可建分支（有归属会话、分支数 < 32、磁盘足够、未被 fence） |
| `blocks[]` | 每个被禁动作的 `{action, code, detail, remediation}`；UI 只展示，不自行拼原因 |

> 关键：按钮置灰的原因必须来自 `blocks[]`，而不是前端根据 `runtime` 二次推断。这样“运行中不可切换”“有子分支不可删除”“满员”“VIP 超额”共用一套口径。

### 2.4 派生四段进度与落位

四段是**四个不确定态段**；“就绪”是终止，不是第五段。

| # | 阶段 | 权威触发 | 快照字段 | 文案 | 预算 | 超时动作 |
|---|---|---|---|---|---|---|
| 1 | 受理 | 客户端点击 → 服务端同步预留成功 | `opId, phase='accepting', taskId` | 正在受理… | ≤300 ms | 1 个快照周期内无 `taskId` → ghost 变“未确认” |
| 2 | 装配 | orchestrator 进入 `provision` | `phase='provision', provisionStartedAt` | 装配 profile… | ≤3 s | `failed(provision-timeout)`，释放预留 |
| 3 | 启动 | 进程 spawn，端口/PID 出现 | `phase='spawn', pid, port` | 启动进程 · 端口 18043 | ≤5 s | 杀进程、释放端口、`failed(spawn-timeout)` |
| 4 | 握手 | adapter 轮询 | `phase='handshake', startedAt` | 等待适配器握手… | ≤10 s | 保留 `running + no-adapter`，可重试握手；**不置 failed** |
| 终 | 就绪 | `phase='ready'` 且 `adapter.ok` | `runtime='running', health='handshaked'` | 已就绪 | — | 未握手不得变绿、不得自动打开窗口 |

规则：

- **阶段单调**：`accepting → provision → spawn → handshake → ready` 只前进；旧快照回退整包丢弃。
- **总预算 20 s**：超过则 `failed(timeout)`、释放槽位、保留卡片给“重试/诊断”。20 s 是服务端硬上限，不是客户端计时器。
- **每段最多 3 s 的不定态**是视觉建议，不是状态机；真正的超时按上表。
- **ghost 键 = `opId`，真卡键 = `taskId`**；绑定后复用同一 DOM，避免闪两次。
- **ghost TTL = 2 个快照周期**（按周期数，不按墙钟；避免空闲档挂十几分钟）。
- **自动打开只允许在 `ready` 后触发一次**，用 `taskId` 记“已开”；派生 202 后服务端不再返回 `url`，这条规则必须由客户端持有。
- **取消**只在服务端支持时出现；取消后释放预留，ghost 立即转“已取消”，不留在列表。

### 2.5 状态同步表（核心）

这张表把“谁写事实、走哪条通道、两端怎么显示、时延预算、失败兜底”钉在一起。时延预算以**快照周期**为口径，不用“5 秒”这种会随降级档变化的墙钟。

| 事件 / 状态 | 权威写入者 | 事实字段 | 面板通道 | 分身 Web 通道 | 三区呈现 | 时延预算 | 丢失 / 失败兜底 |
|---|---|---|---|---|---|---|---|
| 点击派生（受理） | 客户端乐观 + 服务端预留 | `opId, reservationId` | 本地 ghost；下一次快照确认 | 不适用 | 车间出现 ghost 卡；`capacity.used` 由下一次快照 +1，**不本地累加** | ≤100 ms 本地 | 预留 TTL 25 s 自动释放；ghost 2 周期未确认转“未确认” |
| 预留成功 | 准入账本 | `capacity.used.reserved` | 快照 | 不适用 | `车间 4/8`，派生 CTA 按 `headroom` 重算 | ≤1 周期 | 账本崩溃后按 `phase` 重建；孤儿预留 GC |
| 装配 | orchestrator | `phase='provision'` | 快照 1 s 快速档 | 不适用 | `starting · 装配 profile…` | ≤1 周期 | provision 超时 → `failed` + 释放 |
| 启动 / 端口 | forker | `phase='spawn', pid, port, startedAt` | 快照 1 s 快速档 | 分身页尚未可用 | `starting · 端口 18043` | ≤1 周期 | 5 s 无 pid → “启动缓慢”；5 s 超时 → `failed` |
| 握手成功 | adapter | `adapter.ok=true, protocol` | 快照 1 s 快速档 | 分身页可加载 | 卡变绿，运行时长从 `startedAt` 起算 | ≤1 周期 | 10 s 超时 → `running/no-adapter`，黄蓝 pill + 重试握手 |
| 握手超时 | orchestrator | `adapter={ok:false,error:'timeout'}` | 快照 | 分身页可加载（若已起） | `running · 适配器未就绪` | ≤1 周期 | 不置 failed；保留重试入口 |
| 进程异常退出 | forker `classifyExit` | `exit.kind='crash', code` | 快照 1 s 快速档 | 页面断开 | `crashed · code N` + 归档/重试 | ≤1 周期 | 3 周期无 `exit` → `failed(unknown)`，不冒充 crashed |
| 自动重启计划 | forker `planRestart` | `restartScheduledAt, restartCount` | 快照 | 不适用 | `crashed · 3 s 后重试` | ≤1 周期 | 超过 `maxRestarts=3` → `failed(max-restarts)` |
| 点击归档 | 客户端 + orchestrator | `stopRequestedAt` | 本地立即 `stopping`；快照确认 | 分身页进入停止 | 该卡动作全禁用 | ≤100 ms 本地 | 3 s 未退出 → 清 `stopRequestedAt`，回 `running` + “停止超时” |
| 归档确认 | orchestrator | `archivedAt, stoppedAt, pid=null` | 快照 | 分身页不可用 | 移入归档行，`headroom+1` | ≤1 周期 | `stop-failed` → 红卡 + “进程仍在”诊断，绝不标 archived |
| 还原 | orchestrator | `phase='spawn'`, `urlEpoch+1` | 快照 1 s 快速档 | 新 URL 生效 | `starting → running` | ≤1 周期 | `archive-home-missing` → 卡上“删除记录”出口 |
| 容量变化 | 准入账本 | `capacity.used/headroom` | 快照 | 不适用 | `车间 n/8`，CTA 重算 | ≤1 周期 | 陈旧 2 周期 → 提示“状态陈旧”，允许点击由服务端仲裁 |
| VIP 用量变化 | EssenceManager | `plan.usage` | 快照（30 s 缓存） | 不适用 | 工厂卡 `n/10`、抽屉 | ≤1 周期（缓存 30 s） | 抽屉打开时强制刷新一次 |
| 建分支 | 分支服务 | `refsRev+1`、`branchCount+1` | 分支列表按需拉 | 分身 Web 本地可见 | 切换器新增一行，0 秒 | ≤1 周期 | `opId` 幂等；失败不留半分支 |
| 切换请求 | 分支服务 | `pendingSwitch{opId, from, to, phase}` | 快照摘要 | 不适用（运行时将被停） | “切换中 → feature-x”，当前标签仍旧值 | ≤1 s 快速档 | 409 `branch-busy {holder}` / `writer-alive` |
| 切换排空 | 分支服务 | `phase='draining'`, `stopRequestedAt` | 快照 | 页面断开 | 写动作全禁用 | ≤1 s | 3 s 未观察到退出 → `switch-failed` |
| 切换物化 | 分支服务 | `phase='materializing'`, `bytesCopied` | 分支详情 1 s | 不适用 | `正在准备分支 · 42%`，可取消 | ≤1 s | 失败不留半文件；旧日志一字节未动 |
| 切换激活 | 分支服务 | `refsRev+1, activeBranchId=to` | 快照 | 重启后读新 active | 只有 refs 翻完且 active 匹配才改标签 | ≤1 周期 | 启动失败 → `failed(switch-activation)`，不回翻 |
| 切换失败 | 分支服务 | `phase='failed'`, refs 未翻 | 快照 | 旧分支重启 | “仍停留在 main” | ≤1 周期 | 自动重启旧分支；再失败 → `failed(switch-aborted)` |
| `fence 检测` | 母体比对 tip 上报 | `branch.status='fenced'` | 分支详情 | 分身页降级“只读” | “分支被另一写者占用”，冻结写 | ≤1 周期 | 不自动解锁；需重启或导出 |
| divergence 检测 | 母体指纹采样 | `branch.status='diverged'` | 分支详情 | 分身页降级 | “历史不一致”，给导出并重建 | 30 s 采样 | 冻结写；不自动修 |
| presence | 客户端心跳 | 不落盘 | 独立 presence 通道 | 分身页显示本人 | 分支行“2 人在看” | 2 s / TTL 30 s | 掉线 30 s 内消失；永不进审计 |
| 镜像升级开始 | MirrorManager | `upgrade.phase` | 8 s 升级轮询 | 不受影响 | 母体灯 warning，工厂只读 | ≤1 个 8 s 周期 | 升级失败 → danger + 回滚结论；不阻塞车间 |
| 重算完成 | coordinator | `recompute.{running,done,total}` | 快照（8 s） | 不受影响 | 工厂版本前进/冲突数刷新 | ≤1 个 8 s 周期 | 部分失败 → warning；分支 UI 不订阅 |
| 快照陈旧 | 客户端 | `stalenessMs` | 面板 | 分身页显示本地状态 | 顶部 Callout“上次成功 xx:xx” | 2 周期后 | 保留旧数据；不假装实时 |
| 母体重启 | 服务端 | `panelEpoch+1` | 快照首个包 | 不适用 | 全量替换，不卡旧 rev | 1 次轮询 | epoch 变化强制 200；不清用户草稿 |
| 部署排空 | 服务端 | `draining=true, Retry-After` | 轮询收到 503 | 不适用 | “服务重启中”，退避 | 5 s 内 | 抖动重连；不产生惊群 |

### 2.6 三盏灯与文案

| 灯 | green | info | warning | danger | 文案模板 |
|---|---|---|---|---|---|
| 母体 | 镜像就绪、无更新 | 有新版本可用 | 升级/重算进行中、compat 门禁失败 | 镜像不可读 / 升级失败且回滚失败 | `母体 v{ver}` + 最多一个短语 |
| 工厂 | 全部原身 ready | — | 有 stale / 重算中 | 有 conflicted / 合并 fatal | `工厂 {n} 个` + `{n} 冲突` |
| 车间 | 全部 `running + handshaked` 且 `headroom>0` | 有 `starting` | 有 `stopping` 超时 / 未握手 / `fenced` | `crashed` / `failed>0` / 满员 | `车间 {used}/{max}` |

规则：

- 一盏灯只允许一个最高优先级原因（`danger > warning > info > green`），其余降级为 tooltip 明细。
- 所有数字来自快照，不允许组件内累加；预留计入 `used`。
- 满员时车间灯为 danger，但**不能**把“满员”与“crashed”混成同一句文案；tooltip 必须分开列。
- 灯永不单独存在：8 px 圆点 + 12 px 文本；色盲安全。

---

## 3. 1:1、分支与读写权

### 3.1 归属：`primarySessionId` + `orphans`

现状：`listForkSessions` 返回一个分身的**会话列表**（`orchestrator.mjs:806-857`）；`importSessionIntoFork` 还会往分身 home 塞进第二个（外来）会话（`:333-375`）。所以“哪个会话算这个分身的会话”没有权威答案，分支切换器只能为每个历史会话画一棵树。

目标模型：

| 概念 | 定义 | 面板 | 分身 Web | 删除/归档 |
|---|---|---|---|---|
| `primarySessionId` | 分身唯一归属会话；从会话派生时继承 seed 会话 id；空白派生先为 `null`，由母体扫描分身 sessions 根后一次性绑定（规则见下表） | 卡上只显示一个“会话”入口 | 默认打开这个会话的 active 分支 | 随 home 保留 |
| `orphanSessionIds[]` | 额外会话（导入、运行时自建） | 不展开；卡上显示 `orphanSessionCount` | 可在会话列表看到，标注“非归属” | 归档保留；删除随 home |
| 母体会话 | 只读目录 | 只做“从会话派生”的入口 | 不出现 | 永不写 |

规则：

- 一个分身**只有一个归属会话**；1:1 指的是“分身 ↔ 归属会话”，不是“分身只有一个物理会话目录”。
- 分支的键必须含 `taskId`：`(taskId, sessionId, branchId)`。`$DSH_HOME` 每个分身各一份，这是天然隔离；不能拿 `essenceId` 当 `sessions/` 的第一段（第一段现实是 `workspaceKey`）。
- 分支只挂在分身 home；母体会话只允许“只读切点 + 从中派生”，不允许分支写。
- 旧接口兼容：`GET /api/tasks/sessions` 保留，但内部返回 `{primary, orphans[], orphanSessionCount}`；旧客户端读 `sessions[]` 仍能拿到归属会话。
- 面板**不再**渲染会话列表，也不做每任务 N+1 请求；这是三区评审 U7/F9 的落地。

**归属绑定规则（一次性、可审计）：**

| 场景 | 绑定方式 | 失败/歧义 |
|---|---|---|
| 从母体会话派生 | `primarySessionId = seed.sessionId`，创建任务时即写入 | seed 不存在 → 派生失败，不建任务 |
| 导入母体会话 | 导入的会话就是 `primarySessionId`；若已存在归属会话，导入会话记 orphan | 导入失败不改变归属 |
| 空白派生 | `primarySessionId = null`；母体在快照周期内扫描 `<forkHome>/sessions/<workspaceKey>/<sessionId>/`，取 `createdAt ≥ task.startedAt` 且 `updatedAt` 最大的那个，**只绑一次** | 多个候选且无法判定 → 保持 `null`，标 `binding=ambiguous`，全部计入 orphan，等用户显式选择；不猜 |
| 运行时自建第二个会话 | 不自动改归属；新会话进 `orphanSessionIds` | 卡片显示 `orphanSessionCount`，不弹窗 |
| 母体重启 | 以 `tasks.json` 的 `primarySessionId` 为准；不重新扫描绑定 | 目录不见了 → `primarySessionId` 保留，卡上“会话缺失”，不自动换绑 |

补充：

- **不要拿 adapter 的 `sessionId` 当归属会话**：它是 `adapter` 事件流 id（`s-...`），不是 DSH 会话 id，两者生命周期不同。
- 绑定结果写审计 `session-bound {taskId, sessionId, source:'seed'|'import'|'scan'}`；`binding=ambiguous` 也记一条，便于事后对账。
- 归属会话是**引用**，不是 home 的复制；分支仍按会话目录读写。

### 3.2 分支对象与键

一个分支不是一份日志，是一条引用：

| 字段 | 含义 | 谁写 | 约束 |
|---|---|---|---|
| `branchId` | 分支 id | 客户端提议 / 服务端校验 | 与 `sessionId` 同级名校验；不得用标题当目录名 |
| `parentBranchId` | 父分支；空 = 直接挂会话主干 | 服务端 | 深度 ≤32 |
| `baseBytes` | 父日志的字节前缀长度 | 服务端 | 必须落在帧边界 |
| `baseFrames` | 帧计数 | 服务端 | 避免每次读都扫 magic |
| `openSeq` | 切点处父日志最后事件序号 | 服务端 | 与事件游标对齐 |
| `title` | 展示名 | 客户端 | 与 id 分离 |
| `createdAt/createdBy/opId` | 审计与幂等 | 服务端 | `opId` 去重 |
| `status` | `main-live/pinned/checkout-pending/materialized/archived` | 分支服务 | 见 3.3 |
| `tipBytes` | 本分支可见日志长度 | 运行时/分支服务 | 同一 `writerEpoch` 内单调；段尾修复换 epoch |
| `writerEpoch` | 写者世代 | 服务端 | 与 panelEpoch 无关；fencing 比对 |

可见日志 = `父分支可见日志[0, baseBytes)` + 本分支段；递归组合，深度上限 32，超过则强制物化一次把链压平。

目录形状（纯增量，向后兼容）：

```
<forkHome>/sessions/<workspaceKey>/<sessionId>/
  session.v4.jsonl.zstd          ← 运行时写；这就是 main-live
  branches/
    refs.a.json / refs.b.json    ← 双槽引用清单，唯一真相
    journal.jsonl                ← fang 写：create/switch/recover/gc，append-only
    <branchId>/
      branch.json                ← 元数据
      segment.v4.jsonl.zstd      ← fang 写的增量段（与运行时同格式）
      index.jsonl                ← (seq, frameBytes, events, at)，O(1) 续读
```

为什么 `branches/` 放在会话目录内安全：现有扫描器只 stat `session.v4.jsonl.zstd`；`branches` 不匹配 `SESSION_ID_RE`，即使被当成会话目录也会跳过。反过来，把 `<essence>` 插到 `sessions/` 下会让扫描器静默变空——这是最难的回归。

### 3.3 分支状态与写者

| 分支状态 | 谁可写 | 运行时可见 | 允许动作 | 面板徽标 | 分身 Web |
|---|---|---|---|---|---|
| `main-live` | 分身运行时（唯一） | 是（就是这份日志） | 读、建分支、归档、**不可切换** | 活 · 写者：运行时 | 可写 |
| `pinned` | 无（只读） | 否 | 读、切换（需租约）、建子分支、删除（无子分支时） | 只读 · 写者：无 | 只读 |
| `checkout-pending` | fang（物化中） | 否 | 取消；其它一律 409 | 准备中 | 不适用 |
| `materialized` | 无 | 否（下次切换才可见） | 读、删除、导出 | 已就绪 · 只读 | 只读 |
| `archived` | 无 | 否 | 读、导出、还原、删除、只读切换（需租约） | 已归档 | 只读 |

正交标记（不是状态）：

- `fenced`：tip 上报的 `(branchId, writerEpoch)` 与 refs 不一致 → 冻结写，UI 降级。
- `diverged`：指纹采样不一致 → 冻结写，给“导出并重建”。
- `tail-torn`：切点前有半帧，已回退并记 journal → UI 标注“切点前 N 字节未完成”。

不变量：

- **SB1 前缀不可变**：`baseBytes` 之前的字节永不重写；写者只能追加。
- **SB2 单写者**：任一分支任一时刻至多一个写者；切换必然穿越一次“无写者”。
- **SB3 refs 是唯一真相**：目录存在 ≠ 分支存在；孤儿目录可回收，孤儿引用不可存在。
- **SB4 母体只读**：母体 `$DSH_HOME` 只读；分支只挂在分身 home 或 fang dataDir。
- **SB5 切换不改历史**：切换只改 `active` 指针与物化产物，绝不重写既有字节。
- **SB6 归档 ≠ 删除**：冻结保留全部分支可读；删除必须显式列出分支数与体积。

### 3.4 切换状态机（5 态 + 失败）

```
idle → requested(opId, generation) → draining → materializing → activating → done
                 └──────────────── 任一态失败 → failed(reverted) ───────────────┘
```

| 态 | 进入条件 | 权威事实 | 写者 | 允许 | 失败动作 |
|---|---|---|---|---|---|
| `requested` | POST switch 受理，拿到租约 | `opId, from, to, requestedAt` | 无（运行时活则直接 409 `writer-alive`，不进入此态） | 只读 | 409 `writer-alive`（运行中）/ `branch-busy {holder}` |
| `draining` | 发出 stop，等待退出 | `stopRequestedAt` | 无（排空中） | 只读 | 3 s 未观察到退出 → `failed`，不“大概停了” |
| `materializing` | 进程已退出 | `bytesCopied, totalBytes` | fang（checkout） | 只读、取消 | ENOSPC/中断 → 删临时文件，refs 不动 |
| `activating` | 物化校验通过，翻 refs | `refsRev+1, activeBranchId=to` | 无（启动中） | 只读 | 启动/握手失败 → `failed(activation)`，**不回翻**（历史已前进） |
| `done` | 新运行时握手成功 | `activeTip` | 新运行时 | 写 | — |
| `failed(reverted)` | 翻 refs 之前失败 | refs 未变 | 无 | 只读 | 自动重启旧分支；再失败 → `failed(switch-aborted)` |

硬规则：

- **`draining` 必须真的观察到运行时退出**（复用 `archiveTask` 的停止确认语义），观察不到就 `failed`，禁止“大概停了”。
- **切换期间继续读旧分支（只读）**；不允许半新半旧。读的是磁盘上已冻结的旧日志，一致性由“进程已退出”保证。
- **切换窗口内禁用一切写动作**：派生、归档、发送、建分支、删除分支，不只禁用切换按钮。
- **refs 只在物化校验通过后翻**；翻之前任何失败都免费回滚（旧引用从未被覆盖）。
- **翻之后启动失败不回翻**：否则用户看到“切换失败但历史已经变了”的二义性；应显示 `failed(activation)`，给“重试启动/还原”。
- **禁止的捷径**：切换时不重启、直接把活动日志 rename，让运行时继续写旧句柄。Windows 会 EPERM/EBUSY，POSIX 会让两个分支交替写同一 inode——这是唯一能造成不可恢复双写的操作。

### 3.5 读新鲜度：三元组与缓存键

| 变化 | 读取单元 | 缓存键 | 失效条件 | ETag 是否包含 | 说明 |
|---|---|---|---|---|---|
| active 指针变化 | 会话分支摘要 | `(taskId, sessionId)` | `refsRev` 变化 | **必须** | 只哈希分支列表会漏掉切换；304 会让面板永远停在旧分支 |
| 分支列表变化 | 分支摘要 | `(taskId, sessionId, refsRev)` | `refsRev` 变化 | 必须 | 分支明细不进快照 |
| 某分支 tip 增长 | 分支行 / 事件页 | `(taskId, sessionId, branchId, tipBytes)` | `tipBytes` 变化 | 必须（行级） | 标题缓存键必须含 `branchId`；否则 A/B 同 `(mtime,size)` 会串味 |
| 事件分页 | 事件页 | `(branchId, seq, refsRev)` | `refsRev` 变化或 `branchId` 变化 | 不适用 | 游标必须带 `branchId`；`refsRev` 变化即重置 |
| 任务运行态 | 车间卡 | `(taskId)` | `epoch/rev` | 必须 | 包含 `runtime/health/phase/exit/urlEpoch`，不包含 uptime |
| 容量 | 总控/车间 | `(epoch, rev)` | `rev` | 必须 | `used/headroom` 进 ETag；`diskUsageBytes` 这类漂移字段排除 |
| presence | 分支行 | `(taskId, sessionId, branchId)` | TTL 30 s | **绝不** | 独立通道；进快照会让每次光标移动都 invalidate |
| 磁盘体积 | 归档卡 | `(taskId)` | 低频刷新 | 排除 | 漂移字段；单独 60 s 拉 |
| 运行时长 | 卡内一行 | 客户端本地 | 每秒本地 | 排除 | 由 `startedAt` 派生，不进快照 |

**ETag 稳定字段清单**（服务端计算）：

- `epoch`
- 每任务：`taskId, runtime, health, phase, startedAt, stopRequestedAt, archivedAt, exit.kind/code, urlEpoch, primarySessionId, orphanSessionCount, actions.*`
- 每会话：`sessionId, refsRev, activeBranchId, branchCount, pendingSwitch.opId/phase`
- 每分支：`branchId, status, parentBranchId, baseBytes, tipBytes, openSeq, fenced, diverged`
- 容量：`maxForks, used.{running,starting,stopping,reserved}, headroom, portFree`
- 计划：`plan.tier, plan.usage.{essences,subEssences,activeSessions}`（只取影响判断的字段）

**排除字段**：`uptimeMs`、`lastSeenAt`、`presence`、`diskUsageBytes`、`sizes` 的连续漂移、任何客户端可见的动画状态。

> `tipBytes` 是例外：它是**语义字段**（卡片上的消息数/体积），活跃写入时 ETag 会随之变化，空闲时自然 304。不要为了追求 304 把它排除，否则分支体积永远不更新；也不要把它塞进 `panelRev` 的 tick，否则每个 token 都让三区重渲染。
>
> **读的“当前分支”与写的 active 是两条轴**：切换只改 active 指针与写权；用户正在看的 `branchId` 不强制跳转。用户若停留在旧分支，界面标“非活跃 · 只读”；只有用户显式点开目标分支或刷新切换器，才切换阅读位置。这样“切换期间继续读旧分支”才是可解释的，而不是悄悄把内容换掉。

> 反例必须写成断言：如果实现只对“分支列表”求哈希而漏掉 `activeBranchId`，切换是唯一会变的一格，恰好在哈希之外 → 304 → 面板永远停在旧分支。测试见 RT-41。

### 3.6 写所有权：服务端给，客户端只展示

| 场景 | 写者 | 面板写动作 | 分身 Web 显示 | 服务端拒绝码 |
|---|---|---|---|---|
| `running` + active 分支 | 运行时 | 只读（除建分支/归档） | “可写 · 你正在编辑 active 分支” | 切分支：`writer-alive` |
| `running` + 用户查看非 active 分支 | 运行时写 active；查看者只读 | 只读 | “只读 · 该分支已固定” | 写事件：`branch-readonly` |
| `stopping` / 切换窗口 | 无 | 全部禁用 | 页面即将断开 | `branch-busy` |
| `failed/crashed` | 无 | 可切分支、可建分支、可归档；不可发送 | “无写者” | 发送：`no-writer` |
| `archived` | 无 | 只读；还原后可写 | “已归档 · 只读” | 写：`branch-archived` |
| `fenced` | 不明（上游可能） | 冻结全部写动作 | “分支被另一写者占用” | 写：`branch-fenced` |
| `diverged` | 不明 | 冻结写，给导出 | “历史不一致” | 写：`branch-diverged` |

规则：

- **写所有权是服务端判定**，不是客户端根据“我打开了页面”推断。
- **运行中不可切换**；`failed/crashed/archived` 才允许切换（无活写者，成本最低）。
- **fencing 只能是检测式**：运行时不会校验 fang 的 token。我们能保证“不主动制造双写者”，不能保证“上游永远不会”；一旦发生，必须能看见并说出来。
- **切换是分身级独占动作**：同一时刻只允许一个 actor；其他人显示“X 正在切换”，不是各自点一次。

### 3.7 presence：易失、独立、可丢

| 项 | 决策 |
|---|---|
| 内容 | `{taskId, sessionId, branchId, viewerId, tabId, at}` |
| 通道 | 独立 `GET/POST /fang/api/presence`；P3 可走 SSE；**永不进快照/ETag/journal** |
| 频率 | 心跳 10 s；光标/选择变化合并 100 ms；每房间 ≤10 次/秒 |
| TTL | 30 s；掉线/关页即消失 |
| 冲突 | last-write-wins，按 `viewerId` 去重；不保证历史 |
| 分身 Web | v1 只显示本人；跨端 presence 为 P3（需要 fork→mother 通道） |
| 切换 actor | 由租约 `holder` 给出，不用 presence 猜；presence 只解释“谁在看” |

### 3.8 归档保留：冻结、还原、删除、导出

| 概念 | 对象 | 保留什么 | 分支行为 | 现状 |
|---|---|---|---|---|
| **冻结（车间归档）** | 分身 | 整个 home + 全部分支 + active 指针 | 分支可读不可写；`active` 不丢 | `archiveTask` 已有停止确认，但缺 `stopping` 可见态 |
| **还原** | 分身 | 重新 spawn（新端口/新 token） | 恢复 active；已物化直接用，否则物化一次 | `restoreTask` 有，但需把 `phase` 置 `starting` |
| **删除** | 分身 | 无 | 连带分支；确认框列 `N 个分支 / X MB` | `deleteArchivedTask` 需补清单 |
| **导出** | 会话 | zip | 默认 active；`?allBranches=1` 导出 refs+journal+全部分支 | 需新增 |
| **回收 `reap`** | 分身 | 删 home | 不得当归档用；两阶段回收 | 现状 `reap` 直接删 home，风险高 |

硬规则：

- **归档页不删数据**；归档后分支可读、可导出、可还原。
- **删除父日志前必须检查 pinned**：有子分支引用 `[0, baseBytes)` → 409 `branch-pinned {children[]}`。
- **删除分身必须列分支数与体积**；二次确认文案写清“这会删除归属会话与全部分支”。
- **归档后还原**：若 active 已被物化则直接用；否则物化一次（此时没有写者，是最安全窗口）。
- **孤儿会话**也随 home 保留；导出 `allBranches=1` 时可包含，默认不含。

### 3.9 分身 Web 的实时视图

分身 Web 是运行时自己的 DSH Web UI，**不能依赖母体在线**；它只回答“我是谁、我在哪个分支、我能不能写”。

| 区域 | 显示 | 数据源 | 刷新 | 失败/降级 |
|---|---|---|---|---|
| 顶栏身份 | `分身 task_ab12 · 归属会话 sess_9f2` | 本地 `GET /fang/api/self/status`（env `DSH_FANG_TASK_ID` + 本地 refs） | 5 s 可见 / 60 s 空闲 | 读本地缓存；不阻塞聊天 |
| 分支徽标 | `main · 可写` / `feature-x · 只读` | 本地 refs + 当前 active | 5 s；切换后重载即更新 | 读不到 refs → “分支状态未知”，仍可只读查看 |
| 写权 | `writable=true` 仅当：当前进程是 active 写者、未 archived、未 fenced、无切换在飞 | 本地 tip/lease + refs | 5 s | `writable=false` 时禁用发送并给原因 |
| 切换提示 | **不在页面内假装“切换中”**：切换会停进程，页面本来就会断开；重连后读新 active，显示“已切换到 X”或“上次切换未完成” | 本地 refs + `recovery` 块 | 启动时一次 | 切换失败 → “仍在 main”，给母体控制台入口 |
| 在场 | v1 只显示本人；跨端 presence 为 P3 | 本地 | 10 s | 不显示比显示错的强 |
| 归档/崩溃 | 页面不可用或只读横幅 | 本地 refs/`archived` | 启动时一次 | 不伪造“已保存” |

规则：

- 分身 Web **不轮询母体 `/fang/api/panel`**；跨进程状态由母体聚合，分身只读本地事实。
- `writable` 不是“页面打开了”的同义词；它是服务端/本地租约判定的结果。
- 切换期间页面断开是**预期行为**，不要用前端动画掩盖；重连后以 refs 为准。
- 分身的 `sessionId` 必须来自归属会话/本地会话目录，不能用 adapter 事件流 id 冒充。

---

## 4. 轮询 / 推送选择与频率

### 4.1 选择矩阵

| 数据 | 方向 | 机制 | 频率 / 触发 | 条件请求 | 载荷上限 | 失败兜底 | 为什么 |
|---|---|---|---|---|---|---|---|
| 三区快照 | 母体 → 面板 | HTTP GET | 5 s 活跃 / 60 s 空闲 / 隐藏暂停 | `ETag` + `If-None-Match` | ≤256 KiB | 保留旧快照 + 退避 | 面板是请求-响应；304 足够便宜 |
| 分支摘要 | 母体 → 面板 | 快照内嵌 | 随快照 | 随快照 | 每会话 ≤200 B | 随快照 | 只放摘要，明细按需 |
| 分支列表 / 明细 | 母体 → 面板 | HTTP GET | 切换器展开时一次；`refsRev` 变化时重拉 | `ETag`（含 `activeBranchId`） | 32 分支 / 2 MB | 展开失败给重试 | 消除每分支 N+1 |
| 分支事件页 | 母体 → 面板 | HTTP GET | 打开分支时；滚动分页 | 游标 `(branchId, seq, refsRev)` | 200 条 / 256 KiB | 游标重置 | 事件不是灯，不需要实时推送 |
| 分身 Web 自身状态 | 分身本地 | 本地 HTTP GET | 5 s 可见 / 60 s 空闲 | 本地文件无 ETag | 几 KB | 读本地缓存 | 分身页不依赖母体在线 |
| tip / live 上报 | 分身 → 母体 | **本地文件心跳**（`fang-live.json`） | 2 s + 优雅退出时立即写 | 原子写，last-write-wins | ≤1 KiB | 母体读不到则 `stat` 兜底 | 同机、无鉴权、无连接、崩溃可留证 |
| presence | 客户端 → 母体 | POST 心跳 + GET/SSE 订阅 | 10 s 心跳；变化合并 100 ms | 无 | ≤256 B/人 | TTL 30 s 消失 | 易失、可丢、绝不进快照 |
| 派生/切换进度 | 母体 → 面板 | 快照 + 快速档 | 1 s，最多 30 s | ETag | 随快照 | 终态或超时释放 | 3–8 s 的窗口，1 s 足够 |
| 物化进度 | 母体 → 面板 | 分支详情 | 1 s（涡轮 500 ms 可选） | `refsRev` | 几 KB | 失败不留半文件 | 只有进度条需要更细 |
| 镜像升级 | 母体 → 面板 | HTTP GET | 8 s（保持现状） | ETag | 几 KB | 保留上次 | 升级慢，8 s 够 |
| 重算状态 | coordinator → 面板 | 快照内嵌 | 8 s（不直连） | 随快照 | 几 KB | `lastError` | 分支 UI 不订阅，避免重渲染 |
| 分身 Adapter 事件 | 分身 → 母体 | SSE（已有） | 按需订阅 | 游标 `since` | 有界 | `session-changed` 409 | 事件尾读，不用于灯 |
| 打开分身 | 母体 → 浏览器 | 一次性票据 | 点击时 | 无 | 302 | 票据过期重取 | URL/token 不进快照 |

### 4.2 频率档（一套节奏，四个档）

| 档 | 间隔 | 触发 | 最长持有 | 命名空间 | 是否受 idle 降级 | 释放规则 |
|---|---|---|---|---|---|---|
| `idle` | 60 s | 30 s 无交互 | 常驻 | `panel` | — | 有交互升活跃 |
| `active` | 5 s | 面板可见、有订阅 | 常驻 | `panel` | 是（30 s 无交互降 idle） | 卸载/隐藏 |
| `fast` | 1 s | 派生/归档/还原/切换进行中 | 30 s | `derive` / `archive` / `switch` | **否** | 终态或超时，`finally` 必释放 |
| `turbo` | 500 ms | 物化/回流字节进度 | 60 s；全局至多 1 个 | `checkout` | **否** | 进度结束/取消，`finally` 必释放 |

规则：

- **快速档只影响快照节奏，不影响 payload**；仍是同一份快照，不另开接口。
- **快速档必须带超时**：派生 30 s（20 s 预算 + 余量），归档 8 s，切换 30 s；超时自动释放并回落到活跃档。
- **idle 降级只作用于 `active`**；`fast/turbo` 持有期间不降级，否则 30 s 的切换会在第 30 秒突然变慢。
- **`release` 必须在 `finally`**：失败、超时、组件卸载、路由跳转都要释放；否则面板永远停在 1 s，审计统计失真。
- **隐藏暂停**：`document.hidden` 停轮询；`visible` 时强制刷一次，并重置退避（成功后才重置）。
- **选主**：`BroadcastChannel` + `navigator.locks`（或 1 s 心跳 + 3 s 超时）选 leader；只有 leader 轮询，follower 只收 `rev` 通知。leader 卸载立即重选。
- **请求预算**（单标签）：活跃 ≤12 次/分钟（快照）+ 按需分支；空闲 ≤1 次/分钟；快速档 30 s 内 ≤30 次；10 个标签只产生 1 条轮询流。

### 4.3 为什么不是 WebSocket（以及什么时候改）

| 方案 | 适配度 | 问题 |
|---|---|---|
| 轮询 + ETag | **推荐** | 请求-响应、天然背压、304 便宜、部署简单、无 per-connection 状态 |
| 长轮询 | 不推荐 | 占连接、部署/排空复杂、与多标签放大叠加 |
| WebSocket | 不推荐（v1） | 需要重连状态机、心跳、鉴权、每连接缓冲；面板没有双向需求 |
| SSE | 可选（P3） | 单向、HTTP 友好；只做失效通知，不做状态源 |

什么时候改：

- 跨机控制台 / 远程访问，轮询 RTT 成为瓶颈。
- 单房间 >5,000 观看者，需要扇出工程。
- 真正需要“实时协同光标”（那时 presence 单独通道，仍然不能把文档/分支状态塞进去）。

### 4.4 SSE 失效通知（P3，可选）

- 端点：`GET /fang/api/panel/events`（同源，无 CORS）。
- 消息只含：`{type:'panel-invalidated', epoch, rev, reasons[]}`；**不含状态**。
- 客户端收到后 100 ms 去抖，leader 触发一次条件 GET；follower 通过 `BroadcastChannel` 收到 `rev`。
- 背压：每连接环形缓冲 64 条；溢出丢最旧并发送 `{type:'resync', rev}`，连续 3 次溢出关闭连接；客户端自动回落轮询。
- SSE 断线不影响正确性：轮询仍在，SSE 只是“更快知道该刷新”。
- 绝不允许 SSE 成为第二真相：任何状态都必须能从 GET 快照重建。

### 4.5 顺序、幂等与时钟

| 对象 | 权威顺序 | 幂等键 | 乱序/重复处理 |
|---|---|---|---|
| 快照 | `(epoch, rev)` | 无（GET） | `rev` 小整包丢弃；`epoch` 变全量替换 |
| 派生 | 服务端受理顺序 | `opId` | 同 `opId` 返回同一 `taskId`；2 分钟窗口 |
| 切换 | 租约持有者顺序 | `opId` | 同 `opId` 返回同一切换；不同 `opId` 409 `branch-busy` |
| 建分支 | `refsRev` CAS | `opId` | 同 `opId` 返回同一 `branchId` |
| 分支事件 | `(branchId, seq)` | `(branchId, seq)` | 重复事件丢弃；游标只前进 |
| tip 上报 | `(branchId, writerEpoch, tipBytes)` | 同左 | 同一 epoch 内旧 `tipBytes` 不覆盖新值；epoch 变化按“段尾修复/重启”处理；上报 epoch 与 refs 不符标 fenced |
| presence | last-write-wins | `(viewerId, tabId)` | 旧 `at` 丢弃；TTL 过期删除 |

时钟：

- **服务端时间是事实**：TTL、超时、`startedAt` 都用服务端时钟；客户端只做相对显示。
- 客户端 `now` 与服务端 `serverNow` 的偏差只影响“运行时长”这类展示，不影响判定。
- 不用客户端时间戳排序；不用墙钟解决冲突。

---

## 5. 并发 / 资源上限策略

### 5.1 上限表（当前 → 目标）

| 资源 | 当前 | 目标 | 依据 / 行为 |
|---|---|---|---|
| 同时存活分身 `maxForks` | 8（1–64） | 保持 8 默认；UI 只读展示 | `orchestrator.mjs:39`；超出 409 `quota-exceeded` |
| 端口池 | 18000–18100（101） | 保持；`headroom` 同时受端口约束 | `forker.mjs:74`；耗尽 409 `port-exhausted` |
| 派生总预算 | 无（分散） | 20 s 硬上限 | 6.2；超时释放槽位 |
| 握手超时 | 10 s | 保持 | `adapterTimeoutMs`；超时保留 `running/no-adapter` |
| 归档停止确认 | 3 s | 保持；`stopping` TTL = 3 s + 1 s 宽限 | `archiveStopTimeoutMs`；服务端清事实，客户端不自超时 |
| 分支数 | 无 | 32 / 会话 | 超出 409 `branch-limit` |
| 分支链深 | 无 | 32 | 超出强制物化或拒绝 |
| 分支元数据 | 无 | ≤2 MB / 会话 | 列表 ≤20 ms |
| 建分支读预算 | 无 | ≤256 KiB（尾部窗口） | p95 ≤50 ms |
| checkout | 无 | 200 MB 预算；可取消；失败不留半文件 | I/O 上限，不重编码 |
| 快照载荷 | `tasks.list` 全量 + N+1 | ≤256 KiB；会话/分支明细不进快照 | 三区评审 8.1 |
| 会话列表读取 | 每任务串行、无缓存 | 并发 ≤8、单次 ≤200 ms、缓存 30 s；面板不再拉 | 消除 N+1 |
| 事件页 | 无 | 200 条 / 256 KiB | 游标分页 |
| 重算 | 并发 4、每原身 60 s | 保持；加 rerun | `upgrade-coordinator` |
| 面板轮询 | 5 s 三套 | 60/5/1/0.5 四档，单一节奏 | 8.1/4.2 |
| SSE（P3） | 无 | 每连接环形 64 条；溢出重同步 | 背压 |
| presence | 无 | 64 人/房间；≤10 次/秒 | 合并 |
| 快速档 | 无 | 30 s（派生/归档/切换）；涡轮 60 s | 防永久提速 |
| 待处理变更 | 无 | 32 条；按 `opId` 合并 | 防内存膨胀 |
| ghost 卡 | 无 | ≤headroom 且 ≤8 | 防并发点击 |

### 5.2 容量预判：预判是建议，服务端是仲裁

**接口**：`GET /fang/api/capacity?taskId=&sessionId=&intent=derive|derive-from-session|restore|switch|create-branch|delete-branch|archive`

返回：

| 字段 | 含义 |
|---|---|
| `ok` | 预判是否可通过 |
| `intent` | 本次动作 |
| `capacitySource` | `config` / `plan`；只有 `plan` 才允许渲染“升级解锁车间位” |
| `maxForks` | 上限 |
| `used` | `{running, starting, stopping, reserved}` |
| `headroom` | `maxForks - (running + starting + stopping + reserved)`，最小 0 |
| `portFree` | 端口池可用数 |
| `plan` | `{tier, quotas:{maxEssences,maxSubEssences,maxActiveSessions}, usage:{...}}` |
| `checks[]` | `{id, ok, current, limit, source, code, detail, remediation}` |
| `capturedAt` | 服务端采样时刻 |

**判定公式**：

- 车间位：`headroom = maxForks - (running + starting + stopping + reserved)`；四项都要算，预留也要算。
- 端口：`portFree ≥ 1`；派生时 `effectiveHeadroom = min(slotHeadroom, portFree)`，两个数都要在快照里单独展示（一个是槽位，一个是端口，不能混成一个数）。
- VIP 活跃会话：仅 `intent=derive-from-session`（或导入会话）检查 `usage.activeSessions < maxActiveSessions`；空白派生不预占会话位；建分支不消耗会话位。
- 原身/子原身：只用于工厂的新建/子原身动作，不用于派生。
- 官方原身：`tier` 必须满足 `OFFICIAL_ESSENCE_MIN_TIER`（当前为 `vip100`，不是数值比较）；不足 → `tier-required`。
- 分支：`branchCount < 32`；链深 < 32；磁盘足够。
- 切换：无新槽位，但要求 `refs` 可写、租约空闲、磁盘 ≥ 2.5× 日志大小（物化临时文件）。
- 归档：不占新槽位；释放槽位在观察到退出后生效。

**原因码与出口**（必须一一对应，不允许通用“操作失败”）：

| code | 场景 | 出口 |
|---|---|---|
| `capacity-full` | 车间满员 | 归档一个分身 / 管理员扩容 |
| `port-exhausted` | 端口池耗尽 | 释放端口 / 修复死 pid 记录 |
| `vip-session-quota` | 原身活跃会话满 | 归档会话 / 升级 tier |
| `vip-essence-quota` | 原身额度满 | 删除原身 / 升级 |
| `vip-subessence-quota` | 子原身额度满 | 删除子原身 / 升级 |
| `tier-required` | 官方原身需要 vip100 | 升级 / 选非官方基底 |
| `branch-limit` | 分支数或链深超限 | 删除旧分支 / 物化压平 |
| `disk-low` | 物化或日志空间不足 | 清理 / 换盘 |
| `writer-alive` | 运行中切换 | 先归档再切换 |
| `branch-busy` | 租约被占 | 显示 holder，稍后重试 |
| `branch-pinned` | 有子分支 | 先删子分支 |
| `fenced` / `diverged` | 写者冲突/历史不一致 | 重启 / 导出重建 |

**新鲜度**：

- 预判快照 `capturedAt` 在 2 个周期内算“新鲜”；新鲜且 `headroom=0` → CTA `aria-disabled`，点击零请求。
- 陈旧 → 显示“状态可能已变”，允许点击；服务端仍可能 409，UI 按 `code` 映射，不显示通用失败。
- 服务端 409 永远带 `checks[]`，UI 直接复用预判抽屉的同一套文案。

### 5.3 准入账本（Admission Ledger）

| 操作 | 时机 | 原子性 | 失败 |
|---|---|---|---|
| `tryReserve(opId, kind, ttl=25s)` | 在任何 `await` 之前同步执行 | Node 单线程内同步检查 + 自增；跨进程由 forker 第二道门 | 返回 `quota-exceeded` + `checks[]`，不建任务 |
| `commit(opId, taskId)` | 任务记录落盘后 | 预留转为 `starting` 计数 | 失败则释放预留 |
| `release(opId)` | 失败/取消/超时/恢复 | 幂等 | 重复释放 no-op |
| `reconcile()` | 母体启动 | 清掉无 `taskId` 的孤儿预留；按 `phase` 重建 `starting` | 不阻塞只读面板 |

规则：

- **同 `opId` 重放返回同一 `reservationId`/`taskId`**，不重复占位。
- **预留计入 `used.reserved`**，因此 `headroom` 在派生一开始就减 1，而不是等进程起来。
- **两道门**：`orchestrator` 的账本 + `forker.spawn` 的 `starting()` 检查。后者是最后保险；其 `max-forks` 必须映射为 `quota-exceeded`，不是 `spawn-failed`。
- **预留 TTL 25 s**（20 s 派生预算 + 5 s 余量）；母体崩溃后由 `reconcile` 清理，不永久泄漏槽位。

### 5.4 锁、租约与信号量

| 临界区 | 参与者 | 机制 | 超时 | 超时结果 |
|---|---|---|---|---|
| 追加 active 分支 | 分身运行时 | 无需锁：单写者 + 只追加；fang 只读 | — | — |
| pin 前缀（建分支） | 母体 fang 与运行时并发 | 无锁；尾部帧边界校验 + 最多 3 次重试 | 3 s | `branch-create-retry` |
| refs 读改写 | 母体多窗口/双实例 | `O_EXCL` 租约 + 双槽 + `seq` CAS | 3 s | `branch-busy {holder}` |
| 切换 | 母体 + 运行时生命周期 | 同一租约 + 必须观察到退出 | 3 s 排空 / 30 s 总 | `switch-failed` |
| GC / 物化 / 删除 | 母体 | 同一租约 + pinned 检查 | 3 s | `branch-busy` |
| 归档 / 还原 | 每任务 | 进程内 `KeyedMutex` + forker 停止确认 | 3 s | `stop-failed` |
| 物化 | 每任务 1 个，全局 ≤2 | 独立信号量 | 60 s | 可取消 |
| 事件读 | 每 `(branchId, cursor)` | 单飞 | 200 ms 预算 | 复用上次 |
| 重算 | coordinator | 并发 4，单原身 60 s | — | 单原身失败不中断整批 |

说明：

- `KeyedMutex` 是**进程内** per-key Promise 链，防不了双窗口、双母体实例、重启重试；任何“单写者”的结论都不能引用它。跨进程必须用租约。
- 租约内容：`{pid, processStartMs, bootId, hostname, kind, opId, epoch, heartbeatAt}`；心跳 2 s，TTL 10 s。
- 陈旧判定三重：pid 不存在 → 抢占；pid 在但 `processStartMs` 或 `bootId` 不符 → 判定 pid 复用并抢占；`kind/opId` 与 refs 在飞操作不一致 → 抢占并记 journal。
- 不要用 rename 当锁：Windows 在读者持句柄时会拒绝 rename，拿它做互斥会随机失败。
- `fang.pid` 已定义但无写者/校验者；本设计建议它只做“同 `$DSH_HOME` 单实例”的提示，不作为分支写权依据。

### 5.5 背压与队列

| 队列/缓冲 | 上限 | 溢出策略 | 用户可见 |
|---|---|---|---|
| 快照请求 | 每 key 1 个在飞 | 单飞，后来的复用同一 Promise | 无 |
| 待处理变更 `pendingMutations` | 32 | 新操作拒绝并提示“操作过多，请稍候” | toast |
| ghost 卡 | `min(headroom, 8)` | 超出不允许再点 | 按钮禁用 + 原因 |
| 事件页 | 200 条 / 256 KiB | 截断 + 下一页游标 | “加载更多” |
| SSE 环形缓冲 | 64 条 | 丢最旧 + `resync`；3 次溢出断开 | 自动回轮询 |
| presence | 64 人/房间；10 次/秒 | 合并、last-write-wins | 旧光标消失 |
| tip 上报 | 1 KiB / 2 s | 文件覆盖写；接收端按 `writerEpoch/tipBytes` 拒绝旧值 | 无 |
| 分支列表 | 32 / 2 MB | 超出 409 `branch-limit` | 明确原因 |
| 归档导出 | 512 MB / 200k 文件 | 拒绝并给上限 | 明确原因 |

原则：

- **轮询没有服务端 per-connection 缓冲**；真正的风险是多标签放大与 N+1，用选主和“明细按需”解决。
- **SSE 只做通知**，所以丢消息是安全的；丢到一定程度就断开让客户端重同步。
- **慢消费者不拖死服务端**：请求-响应天然背压；任何服务端侧队列都必须有界。
- **合并优先于排队**：presence、tip、容量计数都是 last-write-wins；只有用户显式操作（派生/切换）才需要队列与幂等。

### 5.6 降级阶梯

| 档 | 触发 | 行为 | 用户可见 |
|---|---|---|---|
| L0 | 正常 | 5 s 快照；明细按需 | — |
| L1 | `document.hidden` | 停轮询；`visible` 强制刷一次 | — |
| L2 | 30 s 无交互 | 降 60 s；进行中的派生/切换/物化保持快速档 | 不提示 |
| L3 | 连续 3 次失败 | 退避 1→2→4→8→16→30 s + 抖动；保留上次数据 | 顶部 Callout + “上次成功 xx:xx” |
| L4 | 429 / `overloaded:true` | 停按需分支/事件请求与动画，只留快照；合并请求 | 徽标“降级” |
| L5 | 满员 / VIP 超额 / fenced | 只禁用相关写动作；打开/归档/还原仍可用 | 明确原因与出口 |
| L6 | 恢复未完成 / `refs-corrupt` | 只读模式；禁止派生/切换/删除；给诊断 | “状态不一致，需确认” |

---

## 6. 崩溃与重连恢复

### 6.1 崩溃点与恢复动作

| # | 崩溃点 | 磁盘/内存残留 | 检测 | 恢复动作 | 用户可见 |
|---|---|---|---|---|---|
| R1 | 面板请求在飞、标签关闭 | 无 | `AbortController` | 中止；不写状态 | 无 |
| R2 | 母体在派生中崩溃（spawn 前） | `tasks.json` 的 `provisioning` | 启动对账 | 标 `failed(provision-interrupted)`，释放预留 | “派生未完成，可重试” |
| R3 | 母体在派生中崩溃（spawn 后） | 子进程可能还活 | `fork-supervisor` 按 pid 对账 | pid 活 → 接管为 `running`；死 → `failed(unknown)` | 卡片如实显示 |
| R4 | 母体在归档中崩溃 | `stopRequestedAt` + 可能活进程 | 启动对账 | 进程活 → 清 `stopRequestedAt` 回 `running`；进程死 → 按归档意图决定 `archived` 或 `failed` | “上次归档未完成” |
| R5 | 母体在切换中崩溃（未翻 refs） | `journal` 有在飞 opId；refs.active 仍旧 | 启动扫描 journal | `switch-aborted`；重启旧分支；GC 临时物化 | “上次切换未完成” |
| R6 | 母体在切换中崩溃（已翻 refs、未启动） | refs.active 新值 | 启动对账 | 保持新 active；启动新分支；失败 → `failed(activation)` | “分支已切换，启动失败” |
| R7 | 分身进程崩溃 | `exit` 记录 + 段尾可能半帧 | forker 退出回调 | `crashed`；按 `planRestart` 重启（最多 3 次）；段尾修复 | `crashed · code` / “已恢复，丢弃 N 字节” |
| R8 | 段尾撕裂（半帧） | 半帧 | 下次 open-for-append | 持租约截断到上一有效边界 + 写 `resume` 事件 | “已恢复，丢弃 N 字节” |
| R9 | refs 槽写一半 | 单槽坏 | 双槽校验 | 读另一槽，取最高可校验 `seq` | 无 |
| R10 | refs 双槽都坏 | `refs-corrupt` | 双槽校验 | **拒绝写、拒绝自动重建**；只读 + 诊断 | “分支列表不可用” |
| R11 | 物化写一半 | 临时文件 | 启动 GC | 删除临时文件；旧日志一字节未动 | 无 |
| R12 | 物化完成、refs 未翻 | 多一份完整日志 | `opId` 对账 | 按 `opId` 识别并 GC | 无 |
| R13 | 磁盘满（ENOSPC） | 物化临时文件 | 写入错误 | 不翻 refs，不覆盖旧日志 | “空间不足，旧分支未变” |
| R14 | 租约持有者被 `kill -9` | 租约文件 | TTL 10 s | 抢占并记 journal；三重陈旧判定 | 短暂 `branch-busy` |
| R15 | pid 复用 | 旧租约 | `processStartMs/bootId` | 判定陈旧并抢占 | 无 |
| R16 | 母体重启 | `panelRev` 可能回退 | `panelEpoch` | 新 epoch 强制全量快照；不清用户草稿 | 一次全量刷新 |
| R17 | 部署/滚动重启 | 在飞请求 | 503 + `Retry-After` | 客户端抖动退避；5 s 内恢复 | “服务重启中” |
| R18 | token 轮换 | 旧 URL 401 | `urlEpoch` 变化 | 旧标签提示“分身已重启”；用新票据打开 | 明确提示 |
| R19 | tip 文件陈旧 / pid 复用 | 旧 `fang-live.json` | `at` 超 6 s 或 pid/启动时间不符 | 不信任上报；用 `stat` 兜底；标 `report-stale` | 分支显示“状态未知” |
| R20 | fenced / diverged | 分支状态 | 指纹/tip 比对 | 冻结写；给导出/重建 | 明确原因 |

### 6.2 客户端重连状态机

```
idle → loading → live ──(网络错/5xx)──→ degraded(backoff) ──成功──→ live
                    │                         │
                    └──(epoch 变/缓存坏)──→ resync ──→ live
```

| 状态 | 进入条件 | 行为 | 退出 |
|---|---|---|---|
| `idle` | 无订阅 / 隐藏 | 不发请求 | 订阅/可见 |
| `loading` | 首次加载 | 显示骨架；允许 1 次重试 | 成功/失败 |
| `live` | 最近一次成功在 2 周期内 | 按档轮询；304 只更新 `lastUpdatedAt` | 失败/隐藏 |
| `degraded` | 连续失败或被 429 | 退避 1/2/4/8/16/30 s + 抖动 0–500 ms；保留旧快照；显示“上次成功” | 成功/可见 |
| `resync` | `epoch` 变化或 `rev` 不可比 | 强制无缓存 GET；全量替换；按 `opId` 重新对账 ghost/pendingSwitch | 成功 |

规则：

- **保留最后一份好快照**；2 周期后标 `stale`，但不把状态改成 `failed`（不伪造事实）。
- **`If-None-Match` 仍发**；服务端在 epoch 变化时忽略 ETag 返回 200。
- **成功后退避复位**；失败不清空 UI，不自动重试写操作。
- **409 不盲目重试**：刷新快照，展示 `holder`/`code`，由用户决定。
- **卸载必须 abort**；`dispose` 后不再 setState。
- **可见性恢复**：立即刷一次，并重置退避（仅在成功后）。
- **多标签**：leader 轮询；follower 收到 `rev` 后只在本地重渲染，不发请求；leader 卸载 1 s 内重选。

### 6.3 启动恢复顺序（RecoverySupervisor）

启动时串行执行，任何一步失败都不进入可写模式：

| 序 | 步骤 | 失败结果 |
|---|---|---|
| 1 | 单实例守卫（`fang.pid` 提示 + 租约） | 只读 + 诊断 |
| 2 | refs 双槽校验 | 单槽坏读另一槽；双坏 `refs-corrupt`，只读 |
| 3 | 孤儿 GC（无引用 + 无租约 + >10 min） | 记录但不阻塞（失败则留到下次） |
| 4 | 段尾修复（持租约，只截到上一有效边界） | 失败则拒绝该分支写，标 `tail-unrepaired` |
| 5 | `tasks.json` / `forks.json` 对账 | 矛盾则拒绝启动该分身，要求确认 |
| 6 | 切换 journal 回放（`switch-aborted` / `switch-resumed`） | 无法判定则只读 |
| 7 | 发布 `recovery` 块 + `panelEpoch` | — |
| 8 | 放行 `MirrorUpgradeCoordinator.postUpgradeHook` | 未完成不得重算 |

规则：

- **顺序契约**：RecoverySupervisor 必须早于 `MirrorUpgradeCoordinator` 的 `postUpgradeHook`；否则重算会在“半恢复”的 refs 上跑，得到一份谁都不信的 fingerprint。
- **恢复预算 10 s**：超时进入只读模式，暴露 `recovery: {phase:'timeout', degraded[]}`；不允许“边恢复边服务写”。
- **恢复块进快照**（`rev+1`），但恢复进度本身不按 1 s 轮询；启动期一次性。
- **只读模式**下仍可看历史、导出、诊断；派生/切换/删除全部禁用。

### 6.4 发布 / 部署排空

- 收到 SIGTERM：停止接受写操作 → 返回 503 `{code:'draining', retryAfterMs:2000}` → 等待在飞操作（≤5 s）→ 持久化事实与 `panelEpoch` → 退出。
- 客户端：`Retry-After` 优先；否则 1 s + 抖动；连续失败进入 L3。
- 面板轮询在部署期间最多产生 **2× 基线**请求（抖动 + 选主）；不产生惊群。
- 母体重启后 `epoch` 变化：每个标签一次全量快照，随后恢复 304。
- 分身重启：`urlEpoch` 变化；旧标签 401；面板上的“打开”用一次性票据重新取 URL，不缓存旧 URL。

### 6.5 “不假装成功”的硬规则

| 场景 | 禁止 | 必须 |
|---|---|---|
| 未握手 | 卡变绿、自动打开窗口 | 黄/蓝 pill + “适配器未就绪” |
| 归档未观察到退出 | 标 `archived`、移入归档行 | 红卡 + `stop-failed` + `alive:true` |
| 切换未翻 refs | 改“当前分支”标签 | `pendingSwitch` + 旧标签 |
| ghost 未确认 | 静默消失 | “未确认，请刷新” + 关闭 |
| fenced/diverged | 继续显示“可写” | 冻结写 + 明确原因 + 导出 |
| 快照陈旧 | 冒充实时 | “上次成功 xx:xx” |
| 容量预判失败 | 通用“派生失败” | 具体 `code` + 出口 |

---

## 7. 与 `status-store` / `upgrade-coordinator` 的接口契约

### 7.1 `MirrorStatusStore`：保留语义，扩展能力，不改多资源

**不做什么：**

- 不把 `MirrorStatusStore` 改成多资源 store（会破坏既有测试与 idle-audit 契约）。
- 不改变 `INITIAL_MIRROR_SNAPSHOT` 的既有形状；旧调用方继续可用。

**扩展契约：**

| 能力 | 现状 | 目标 | 兼容性 |
|---|---|---|---|
| `fetcher` 返回 | `{status, notModified}` | `{data, rev, epoch, etag?, notModified, capturedAt, stale?}`；`status` 作为 `data` 别名 | 旧字段保留 |
| 快照形状 | `{status, loading, error, lastUpdatedAt}` | 增加 `rev, epoch, stalenessMs, degraded[]`；`status` 引用稳定 | 追加字段 |
| 304 | 只更新 `lastUpdatedAt` | 同样只更新 `lastUpdatedAt`；**不替换 `status` 引用** | 保持 |
| 加载态 | 每次 tick 无条件 `loading:true` | `quiet` 模式：仅 `status===null` 或显式刷新置 loading | 默认 quiet 可配置 |
| 单飞 | 实例级 `inFlight` | 按 key 单飞（`Map<key, Promise>`）；单资源行为不变 | 内部 |
| 高频档 | `acquireActive()` 无命名空间 | `acquireActive(namespace, tier)` → 幂等 release；取最高档；只释放自己的命名空间 | 旧无参调用映射 `namespace='default', tier='active'` |
| 空闲降级 | 单一 idle 计时器 | 只降 `active` 档；`fast/turbo` 持有期间不降；audit 事件带 `tier/namespace` | 事件字段追加 |
| 失效通知 | 无 | `notify(rev)` / `onInvalidate(sink)` 供 leader 广播 | 新增 |
| 陈旧 | 无 | `isStale()`、`stalenessMs()` | 新增 |
| 销毁 | abort in-flight | 同样 abort；释放所有命名空间；不再 setState | 保持 |

**硬性约束：**

- `getSnapshot()` 在 304 或语义未变时必须返回**同一引用**；否则 `useSyncExternalStore` 会无限重渲染。
- `rev` 只在语义变化时前进；`uptime`、`lastSeen`、`presence` 不得触发 `rev`。
- `release` 必须幂等，失败/超时/卸载都要调用；否则面板永不回 idle。
- `dispose` 后不得再更新快照。
- `fetcher` 的 `signal` 必须被使用；超时/卸载要 abort。

### 7.2 新增 store 组合（一层一个资源）

| Store | 键 | 数据 | 生命周期 | 持久化 | 订阅者 |
|---|---|---|---|---|---|
| `MirrorStatusStore` | 单例 | 镜像/升级 | 页面 | 否 | 总控 |
| `PanelSnapshotStore` | 单例 | 三区快照 + `rev/epoch` | 页面 | 否 | 三区 |
| `BranchRefsStore` | `(taskId, sessionId)` | 分支摘要/明细 + `refsRev` | 切换器打开期间 | 否 | 切换器 |
| `BranchEventStore` | `(branchId, cursor)` | 事件页 | 分支详情打开期间 | 否 | 事件列表 |
| `PendingMutationsStore` | `opId` | `{kind,target,phase,at,deadline}` | 操作 + 2 周期 | 否 | 卡片/按钮 |
| `PresenceStore` | `(taskId, sessionId, branchId)` | 在线查看者 | 30 s TTL | 否 | 分支行 |
| `RecoveryStore` | 单例 | 恢复块/只读标志 | 页面 | 否 | 顶部 Callout |

规则：

- **纯 selector 组合**：`deriveZones(snapshot)`、`deriveWorkshopCard(task, capacity)`、`deriveBranchRow(branch, presence)`。组件不自己累加、不自己推生命周期。
- `PendingMutationsStore` 与快照分离；**不要**把“切换中”塞进 `snapshot.status`。
- `BranchRefsStore` 的 ETag 必须包含 `activeBranchId` 与每分支 `(tipBytes,status)`。
- `PresenceStore` 永不进快照、永不持久化、永不写审计。
- `RecoveryStore` 只读；只读模式由它向所有动作提供 `blocks[]`。

### 7.3 `MirrorUpgradeCoordinator`：必须修的冲突点

| # | 问题 | 现状 | 目标契约 | 失败模式 |
|---|---|---|---|---|
| C26 | 启动顺序无契约 | `onUpgradeSuccess` 直接起批 | 先 `await recovery.ready()`；未完成不重算，置 `lastError='recovery-incomplete'` | 半恢复上重算，fingerprint 不可信 |
| C27 | 单飞无 rerun | 已有批次直接 join，分支触发的重算被丢弃 | `requestRun(reason)` + `rerunRequested` 循环；最多 2 次重跑 | 分支索引重建被静默丢弃 |
| C28 | 状态快照每次新对象 | `getRecomputeStatus()` 浅拷贝 | 缓存稳定对象；`rev` 只在进度真变化时 +1；`progress` 不可变 | 分支 chip 订阅 → 无限重渲染 |
| C29 | 无阶段词汇 | `progress` 只有 done/total | 统一 `{phase, at, done, total, detail}`；与派生/回流共用 | 三区各画各的进度条 |
| C30 | 与 panelRev 双写 | 无 | coordinator 只在**开始/结束**各 `bump` 一次；进度 tick 不 bump | 每 tick 全面板重渲染 |
| C31 | 恢复失败仍重算 | 无 | `recovery.ok=false` → 不重算；`lastError` 明确 | 在坏 refs 上算 fingerprint |
| C32 | 排空时启动新批次 | 无 | `drain()` 置 `accepting=false`；在飞批次完成或超时 | 部署期间重算卡住退出 |
| C33 | 指纹不含 refs | 只有镜像/原身 | fingerprint 输入包含 `refsRev/refs.head`；重算前校验 refs 可读 | 重算结果与分支状态不一致 |

协调器对外形状（契约）：

| 方法/字段 | 语义 |
|---|---|
| `recoveryGate` | `ready() → {ok, phase, degraded[]}`；启动时注入 |
| `requestRun(reason)` | 去重 + 可重跑；返回当前/下一批 Promise |
| `getRecomputeStatus()` | 稳定引用；`{running, phase, startedAt, finishedAt, rev, progress, lastResult, lastError}` |
| `waitForIdle()` | 排空/关闭时等待；不接受新批次 |
| `drain()` | 停止接受新批次；在飞批次最多等 5 s |
| `onUpgradeSuccess()` | 保留为兼容入口；内部先过 recovery gate |

**明确禁止：**

- 分支 UI 直接订阅 `getRecomputeStatus()`；只能经 `PanelSnapshotStore` 的 `recompute` 块（8 s 新鲜度）。
- 把 coordinator 的进度 tick 当作 `panelRev` 的来源。
- 在 recovery 未完成时跑重算。
- 重算失败影响升级结果（失败隔离保持）。

### 7.4 服务端快照形状（契约，不是实现）

```json
{
  "epoch": "boot-2026-11-02T15:00:00Z-7f3a",
  "rev": 1042,
  "generatedAt": "2026-11-02T15:04:05.123Z",
  "serverNow": 1762086245123,
  "role": "mother",
  "mother": {
    "version": "3.0.4",
    "mirror": { "version": "3.0.4", "updateAvailable": false },
    "upgrade": { "phase": "idle", "at": null },
    "recompute": { "running": false, "done": 0, "total": 0, "lastError": null }
  },
  "capacity": {
    "maxForks": 8,
    "used": { "running": 2, "starting": 1, "stopping": 0, "reserved": 1 },
    "headroom": 4,
    "portFree": 97,
    "source": "config",
    "capturedAt": "2026-11-02T15:04:04.900Z",
    "checks": []
  },
  "plan": {
    "tier": "vip10",
    "quotas": { "maxEssences": 10, "maxSubEssences": 10, "maxActiveSessions": 10 },
    "usage": { "essences": 2, "subEssences": 0, "activeSessions": 4 }
  },
  "tasks": [
    {
      "taskId": "task_ab12",
      "title": "修复路由守卫",
      "phase": "ready",
      "runtime": "running",
      "health": "handshaked",
      "reason": null,
      "startedAt": 1762085400000,
      "stopRequestedAt": null,
      "archivedAt": null,
      "exit": null,
      "pid": 21488,
      "port": 18042,
      "urlEpoch": 3,
      "primarySessionId": "sess_9f2",
      "orphanSessionCount": 0,
      "seed": { "sessionId": "sess_9f2", "branchId": "main", "baseBytes": 0, "refsRev": 4 },
      "actions": {
        "open": true, "archive": true, "restore": false, "download": true,
        "switchBranch": false, "createBranch": true
      },
      "blocks": [
        { "action": "switchBranch", "code": "writer-alive", "detail": "运行中不可切换", "remediation": "先归档再切换" }
      ],
      "session": {
        "sessionId": "sess_9f2",
        "refsRev": 4,
        "activeBranchId": "main",
        "branchCount": 3,
        "pendingSwitch": null
      }
    }
  ],
  "recovery": { "phase": "done", "at": 1762086000000, "degraded": [] },
  "degraded": []
}
```

说明：

- **不包含**分支明细、事件、presence、磁盘漂移、uptime。
- `url` **不进快照**；用 `GET /fang/api/tasks/open-ticket?taskId=` 换一次性 URL，60 s TTL。
- `actions`/`blocks` 由服务端计算；客户端只渲染。
- `session.pendingSwitch` 只放摘要 `{opId, from, to, phase, at}`，详情在分支接口。

### 7.5 端点契约

| 方法 | 路径 | 用途 | 成功 | 冲突/失败 | 幂等 / 条件 |
|---|---|---|---|---|---|
| GET | `/fang/api/panel` | 三区快照（新） | 200 + `ETag/X-Panel-Epoch/X-Panel-Rev` | 503 `draining` + `Retry-After` | `If-None-Match` → 304 |
| GET | `/fang/api/status` | 旧状态（兼容） | 200（内部读同一快照） | 同上 | 逐步加 ETag |
| GET | `/fang/api/capacity` | 容量预判 | 200 `{checks[]}` | 400 参数错 | 只读，不预留 |
| POST | `/fang/api/derive` | 派生 | **202** `{taskId, opId, phase:'accepting', reservationId}` | 409 `quota-exceeded`/`tier-required`/`port-exhausted` | `Idempotency-Key` / body `opId`；2 min |
| POST | `/fang/api/tasks/archive` | 归档 | **202** `{opId, phase:'stopping'}`（旧客户端按 200/202 均可） | 409 `stop-failed`/`unknown-task` | `opId` 幂等 |
| POST | `/fang/api/tasks/restore` | 还原 | 202 `{phase:'spawn'}` | 409 `archive-home-missing`/`quota-exceeded` | `opId` |
| GET | `/fang/api/tasks/open-ticket` | 打开分身 | 302 到带 token 的 URL | 410 过期 / 409 未就绪 | 60 s TTL，一次性 |
| GET | `/fang/api/sessions/branches` | 分支摘要/列表 | 200 + `ETag` | 404 unknown | `If-None-Match`；`refsRev` |
| POST | `/fang/api/sessions/branches/create` | 建分支 | 201 `{branchId, baseBytes, baseFrames, refsRev}` | 409 `branch-limit`/`branch-busy` | `opId` 幂等 |
| POST | `/fang/api/sessions/branches/switch` | 切换 | **202** `{opId, phase:'requested'}` | 409 `writer-alive`/`branch-busy {holder}`/`branch-pinned` | `opId` 幂等 |
| POST | `/fang/api/sessions/branches/delete` | 删分支 | 200 | 409 `branch-pinned {children[]}` | `opId` 幂等 |
| GET | `/fang/api/sessions/branches/read` | 事件页 | 200 `{events, nextCursor, refsRev}` | 409 `cursor-stale` | 游标 `(branchId, seq, refsRev)` |
| GET/POST | `/fang/api/presence` | 在场 | 200 | 429 限流 | TTL 30 s；无持久化 |
| GET | `/fang/api/panel/events` | SSE 失效通知（P3） | `text/event-stream` | — | 只发 `{epoch, rev}` |
| GET | `/fang/api/self/status` | 分身 Web 自身状态 | 200 `{taskId, sessionId, branchId, writable, epoch}` | — | 本地；5 s |
| GET | `/fang/api/self/live` | 分身本地在场/tip | 200 | — | 本地；不依赖母体 |

头约定：

| 头 | 方向 | 语义 |
|---|---|---|
| `ETag` | 响应 | 稳定字段哈希；含 `epoch` |
| `If-None-Match` | 请求 | 304 仅当同 epoch 且稳定字段一致 |
| `X-Panel-Epoch` | 响应 | 母体启动世代 |
| `X-Panel-Rev` | 响应 | 世代内修订 |
| `Retry-After` | 503/429 | 秒或毫秒（本设计用毫秒字段 `retryAfterMs` + 标准头） |
| `Idempotency-Key` | 请求 | 与 body `opId` 二选一；同键同结果 |

### 7.6 审计事件

| 事件 | 触发 | 关键字段 | 备注 |
|---|---|---|---|
| `derive-accepted` | 派生受理 | `opId, taskId, reservationId, title` | 不写每次进度 |
| `derive-phase` | 阶段变化 | `taskId, phase, at` | 仅 5 个阶段，低频 |
| `derive-failed` | 失败 | `taskId, code, detail, released` | 与 `fork-crashed` 区分 |
| `task-archived` | 归档确认 | `taskId, branches, bytes, remote` | 已有 |
| `task-restored` | 还原 | `taskId, activeBranchId, urlEpoch` | 已有，补字段 |
| `branch-created` | 建分支 | `taskId, sessionId, branchId, baseBytes, refsRev` | — |
| `branch-switch-requested` | 切换受理 | `opId, from, to, holder` | — |
| `branch-switched` | 切换完成 | `branchId, refsRev, durationMs` | — |
| `branch-switch-failed` | 切换失败 | `branchId, phase, reason, reverted` | 必须写 |
| `branch-gc` | 孤儿回收 | `branchId, reason` | — |
| `branch-tail-repaired` | 段尾修复 | `branchId, droppedBytes, writerEpoch` | 用户可见一次 |
| `branch-fenced` | fence 检测 | `branchId, reportedEpoch, expectedEpoch` | 冻结写 |
| `branch-diverged` | 指纹不一致 | `branchId, reportedSha, expectedSha` | 冻结写 |
| `capacity-rejected` | 服务端 409 | `intent, code, checks` | 用于容量调优 |
| `panel-epoch` | 母体启动 | `epoch, recoveryPhase` | 低频 |
| `recovery` | 恢复完成/降级 | `phase, degraded[], durationMs` | 进快照，不进日志噪声 |

**不写审计**：presence 心跳、每次轮询、304、uptime 变化、ghost 动画。presence 只进 presence store。

### 7.7 角色矩阵

| 插件 | 母体 | 分身 | 说明 |
|---|---|---|---|
| `orchestrator` | ✅ | — | 任务事实、容量、归档/还原、快照 |
| `forker` | ✅ | — | 进程、端口、退出分类 |
| `sessionCatalog` | ✅（只读） | — | 母体会话只读；不开分支后门 |
| `sessionBranch`（新） | ✅ | ✅ | 母体：refs 权威/切换；分身：tip 上报/本地只读视图 |
| `sessionBridge` | ✅ | — | 只读桥接 |
| `adapter` | — | ✅ | 分身控制面；已有 SSE/事件 |
| `auditor` | ✅ | ✅ | 审计 |
| `scorer/router/umbrella/approver` | ✅ | ✅ | 不变 |

规则：

- `MATRIX` 加 `sessionBranch: ['mother','fork']`；母体是 refs 权威，分身是 tip 上报者。
- `sessionCatalog` 保持 `['mother']` 且 `readOnly: true`；分支功能不许给只读目录开后门。
- 分支写权只属于母体 fang 的 `sessionBranch` 与运行时；分身侧只读 + 上报。

---

## 8. 测试矩阵

### 8.1 注入层

| 层 | 手段 | 覆盖 | 成本 |
|---|---|---|---|
| 纯函数 | 假 `fsApi` + 步骤计数器 `crashAt(step, N)`，在 `mkdir/writeSlot/rename/fsync/readback/append` 每边界抛一次 | 分支解析、组合、派生、容量公式、ETag | 毫秒级 |
| Store 契约 | 假 timers/now/fetcher/BroadcastChannel | 304 引用稳定、单飞、命名空间、退避、选主 | 毫秒级 |
| HTTP 契约 | 假 webServer + 假请求 | 202/409/304、`opId` 幂等、头 | 毫秒级 |
| 真进程 | `child_process` + `taskkill /F`（Windows） | 崩溃、重启、端口、token 轮换 | 秒级 |
| 文件 fixture | 真实截断生成半帧 zstd、坏槽、孤儿目录、pid 复用租约 | 段尾修复、双槽、GC | 毫秒级 |
| 浏览器逻辑 | 假快照序列 + 假 BroadcastChannel | A→B→A 串味、ghost、陈旧丢弃 | 毫秒级 |

### 8.2 矩阵（RT-01 ~ RT-82）

#### A. 六态与动作（9）

| # | 层 | 场景 | 注入/手段 | 期望（判定口径） |
|---|---|---|---|---|
| RT-01 | 纯函数 | `provisioning` 不再呈现为 `failed` | 事实 `phase=provision` | `runtime=starting`，`reason=null` |
| RT-02 | 纯函数 | 握手成功 | `adapter.ok=true` | `runtime=running, health=handshaked` |
| RT-03 | 纯函数 | 进程活但未握手 | `adapter.ok=false` | `runtime=running, health=no-adapter`，不是 failed |
| RT-04 | 纯函数 | 归档点击后、进程未退 | `stopRequestedAt` 新鲜 | `runtime=stopping`，不是 failed |
| RT-05 | 纯函数 | 停止超时 | `stopRequestedAt` 超 4 s，进程仍活 | `runtime=running` + `reason=stop-timeout`，`alive:true` |
| RT-06 | 纯函数 | 崩溃 | `exit.kind=crash, code=1` | `runtime=crashed`，保留 code，不是 failed |
| RT-07 | 纯函数 | 正常退出 | `exit.kind=normal, code=0` | `runtime=failed` + `reason=exited`，文案“已停止（退出码 0）” |
| RT-08 | 纯函数 | 归档确认 | `archivedAt` + `pid=null` | `runtime=archived`，`homeKept=true` |
| RT-09 | 纯函数 | 还原中 | `phase=spawn`，旧 `status=archived` 已清 | `runtime=starting`，不是 running |

#### B. 派生进度与落位（7）

| # | 层 | 场景 | 注入/手段 | 期望 |
|---|---|---|---|---|
| RT-10 | 纯函数 | 四段顺序 | 依次投喂 `accepting→provision→spawn→handshake→ready` | 阶段单调，无回退；`ready` 是终止 |
| RT-11 | 纯函数 | 总预算 20 s | 时钟推进 | `failed(timeout)` + `released=true` |
| RT-12 | 纯函数 | 握手超时 | 10 s 到点 | `running/no-adapter`，可重试；不 failed |
| RT-13 | 并发 | 双标签同 `opId` 派生 | 两个请求同键 | 同一 `taskId`；只占 1 个预留 |
| RT-14 | UI 逻辑 | ghost TTL 按周期 | 空闲档 60 s，2 周期 | ghost 在 2 次快照后“未确认”，不是 2 分钟 |
| RT-15 | UI 逻辑 | 未就绪自动打开 | `url` 已出现、`adapter.ok=false` | 不打开；`ready` 后才允许一次 |
| RT-16 | 纯函数 | 阶段乱序 | 先投喂 `handshake` 再投喂 `spawn` | 旧包丢弃，视图不倒退 |

#### C. 容量与前置判定（13）

| # | 层 | 场景 | 注入/手段 | 期望 |
|---|---|---|---|---|
| RT-17 | 纯函数 | `starting` 计入 | 2 running + 1 starting | `used=3`，`headroom=max-3` |
| RT-18 | 纯函数 | `stopping` 计入 | 1 stopping | 计入 used；不被忽略 |
| RT-19 | 纯函数 | `reserved` 计入 | 1 预留 | 计入 used；预留 TTL 到期释放 |
| RT-20 | 并发 | 满员前并发派生 | `max=2`，已有 1 running，两个并发 | 恰好一个 202，一个 409 `capacity-full`；不越界 |
| RT-21 | HTTP | forker 第二道门 | 直接调 spawn 越过账本 | `max-forks` 映射 `quota-exceeded`，不是 `spawn-failed` |
| RT-22 | 纯函数 | VIP 活跃会话满 | `usage=9, limit=10`，从会话派生 | 通过；`10/10` 再派生 → `vip-session-quota` |
| RT-23 | 纯函数 | 建分支不占会话位 | `activeSessions=10`，建分支 | 允许；不检查会话额度 |
| RT-24 | 纯函数 | 官方原身 tier | `tier=vip10`，从官方原身派生 | `tier-required`；vip100 通过 |
| RT-25 | 纯函数 | 端口耗尽 | `portFree=0` | `port-exhausted`，独立于 `capacity-full` |
| RT-26 | 崩溃 | 预留泄漏 | 派生中杀母体，重启 | 25 s 内释放；`reconcile` 不永久占位 |
| RT-27 | UI 逻辑 | 满员零请求 | `headroom=0` 且新鲜 | 按钮 `aria-disabled`；点击不发请求；一次 `aria-live` |
| RT-28 | UI 逻辑 | 陈旧满员 | `capturedAt` 超 2 周期 | 提示“状态可能已变”，允许点击，服务端仲裁 |
| RT-29 | UI 逻辑 | `source=config` | 满员 | 不渲染“升级解锁车间位”；只给归档/扩容 |

#### D. 1:1 与分支（11）

| # | 层 | 场景 | 注入/手段 | 期望 |
|---|---|---|---|---|
| RT-30 | 纯函数 | 一个分身一个归属会话 | 任务有 2 个会话目录 | `primarySessionId` 唯一；另一个计 `orphanSessionCount` |
| RT-31 | 纯函数 | 导入会话 | `importSession` 成功 | 不覆盖归属会话；标记 orphan |
| RT-32 | 纯函数 | 键隔离 | 两个 task 同 sessionId/branchId | 分支键含 `taskId`，互不可见 |
| RT-33 | 纯函数 | 分支上限 | 32 个分支后建第 33 个 | 409 `branch-limit`，不写目录 |
| RT-34 | 纯函数 | 分支 id 校验 | `../`、`C:`、超长、保留名 | 400；绝不进路径 |
| RT-35 | 纯函数 | 切点帧边界 | 含伪 magic 的多帧日志 | `baseBytes` 落在真帧边界；父事件数正确 |
| RT-36 | 纯函数 | 截断帧 | 真实截断 fixture | 识别 torn；回退一帧；不是“空会话” |
| RT-37 | 并发 | 同会话多分支 | 同时建 3 个分支 | 3 个不同 id；`refsRev+3`；共享前缀 |
| RT-38 | 纯函数 | `opId` 幂等 | 同 `opId` 重放建分支 | 返回同一 `branchId`；不重复计数 |
| RT-39 | 纯函数 | 删除 pinned | 有子分支的父分支删除 | 409 `branch-pinned {children[]}` |
| RT-40 | 纯函数 | 归档保留分支 | 归档后读分支 | 全部分支可读，`archived` 状态，写入 409 |

#### E. 读新鲜度与写所有权（14）

| # | 层 | 场景 | 注入/手段 | 期望 |
|---|---|---|---|---|
| RT-41 | 纯函数 | ETag 含 active | 仅 `activeBranchId` 变化 | ETag 必变；不得 304 |
| RT-42 | 纯函数 | ETag 排除漂移 | 仅 uptime/disk/presence 变化 | ETag 不变，304 |
| RT-43 | Store | 304 引用稳定 | 连续 304 | `getSnapshot()` 返回同一 `status` 引用；只更新 `lastUpdatedAt` |
| RT-44 | UI 逻辑 | A→B→A 串味 | 假快照序列，A/B 同 `(mtime,size)` | 标题/事件/active 标签不串；缓存键含 `branchId` |
| RT-45 | 纯函数 | 游标重置 | `refsRev` 变化 | 事件游标重置；不把旧分支事件拼到新分支 |
| RT-46 | 并发 | 运行中切换 | 运行中 POST switch | 409 `writer-alive`；日志字节零改动 |
| RT-47 | 并发 | 并发切换 | 两个进程同时 switch | 恰好一个成功；另一个 409 `branch-busy` + holder |
| RT-48 | 崩溃 | 切换失败回滚 | 物化失败 | refs 未变；旧分支自动重启；UI“仍停留在 main” |
| RT-49 | UI 逻辑 | 切换窗口禁用写 | `pendingSwitch` 存在 | 派生/归档/建分支/发送全部禁用，不只切换按钮 |
| RT-50 | 检测 | fenced | tip 上报 branchId/writerEpoch 不符 | `branch.status=fenced`；写冻结；UI 降级 |
| RT-51 | 检测 | diverged | 指纹不一致 | 冻结写；给导出重建；不自动修 |
| RT-52 | 纯函数 | presence TTL | 31 s 无心跳 | 从分支行消失；journal/审计无记录 |
| RT-53 | UI 逻辑 | 双标签选主 | 假 BroadcastChannel | 只有一个 leader 轮询；follower 不发请求 |
| RT-54 | UI 逻辑 | 切换成功广播 | leader 收到新 `refsRev` | 立即广播失效，不等下一周期；旧标签不显示新分支旧数据 |

#### F. 崩溃与重连（11）

| # | 层 | 场景 | 注入/手段 | 期望 |
|---|---|---|---|---|
| RT-55 | 真进程 | 母体重启 epoch | 杀母体再起 | 客户端接受新 epoch 全量；`rev` 不卡死 |
| RT-56 | UI 逻辑 | 离线 10 分钟 | 假网络失败 | 退避 1→30 s；恢复后一次刷新；ghost 不重复 |
| RT-57 | Store | 卸载 abort | `dispose` 时有在飞请求 | abort；不再 setState；释放命名空间 |
| RT-58 | 真进程 | 分身崩溃 | `taskkill /F` | 1 周期内 `crashed` + code；不是 failed |
| RT-59 | 真进程 | token 轮换 | 还原/重启后旧 URL | 旧票据 401/410；新票据可打开；`urlEpoch+1` |
| RT-60 | 崩溃 | 切换中崩溃（P5） | 停后未物化杀进程 | 启动回旧 active + `switch-aborted` |
| RT-61 | 崩溃 | 物化完成未翻 refs（P7） | 杀进程 | 临时物化 GC；无“半个分支” |
| RT-62 | 崩溃 | ENOSPC | 假 fs 抛错 | 不翻 refs；旧日志一字节未动 |
| RT-63 | 部署 | 排空抖动 | 503 + Retry-After | 5 s 内恢复；请求 ≤2× 基线 |
| RT-64 | 纯函数 | 陈旧 tip/pid 复用 | `at` 超 6 s 或启动时间不符 | 不信任上报；`report-stale`；stat 兜底 |
| RT-65 | 纯函数 | 时钟偏移 | 客户端快/慢 5 分钟 | 状态判定仍按服务端时间；相对时长仅展示 |

#### G. Store / coordinator 契约（10）

| # | 层 | 场景 | 注入/手段 | 期望 |
|---|---|---|---|---|
| RT-66 | Store | quiet 模式 | 连续 tick | 语义未变不置 `loading`；快照引用稳定 |
| RT-67 | Store | 按 key 单飞 | 两个 key 同时刷新 | 互不阻塞；同 key 复用同一 Promise |
| RT-68 | Store | 命名空间高频档 | `acquireActive('switch','fast')` | 只提速该命名空间；释放后回 5 s；失败/超时也释放 |
| RT-69 | Store | idle 不降 fast | fast 持有 40 s 无交互 | 仍 1 s；只降 active |
| RT-70 | Store | 陈旧丢弃 | 先发后到的旧 `rev` | 整包丢弃；界面不倒退 |
| RT-71 | Coordinator | 恢复门禁 | recovery 未完成 | 不重算；`lastError='recovery-incomplete'` |
| RT-72 | Coordinator | rerun | 重算中再次请求 | 本轮结束后再跑一轮；最多 2 次 |
| RT-73 | Coordinator | 快照稳定 | 连续读取 | 引用稳定；`rev` 只在进度变化时 +1 |
| RT-74 | Coordinator | 分支 UI 不订阅 | 渲染计数 | 分支 chip 不因 progress tick 重渲染 |
| RT-75 | Coordinator | 单写 panelRev | 重算开始/结束 | 只 bump 两次；进度 tick 不 bump |

#### H. 性能与上限（7）

| # | 层 | 场景 | 注入/手段 | 期望 |
|---|---|---|---|---|
| RT-76 | 性能 | 快照 64 任务 | 构造最大快照 | ≤256 KiB；不含会话/分支明细 |
| RT-77 | 性能 | 32 分支列表 | 固定 fixture | ≤20 ms；元数据 ≤2 MB |
| RT-78 | 性能 | 200 MB 日志建分支 | IO 计数 | p95 ≤50 ms；读取 ≤256 KiB |
| RT-79 | 性能 | 200 MB checkout | 固定 fixture | 预算内；可取消；失败无半文件 |
| RT-80 | 性能 | 10 标签 | 假 BroadcastChannel | 1 条轮询流；请求 ≤单标签 1.2× |
| RT-81 | 性能 | presence 洪水 | 1,000 次/秒 | 合并后 ≤10 次/秒/房间；服务端内存有界 |
| RT-82 | 性能 | SSE 慢消费者 | 不读 100 条 | 环形 64 丢最旧 + resync；3 次溢出断开 |

> 编号到 RT-82；其中 RT-60/61/62 与分支评审的 T15/T18/T20 重叠，保留是因为它们同时验证“实时状态不倒退”。分支内部语义仍以分支评审 T1–T30 为准，本文不重新编号。

### 8.3 不变量检查器与 fuzz

固定种子（可复现）随机执行：`create / derive / archive / restore / switch / create-branch / delete-branch / kill -9 / gc / deploy`，每步后检查：

| # | 不变量 |
|---|---|
| INV1 | `baseBytes ≤ 父日志当时 size` |
| INV2 | 分支可见事件序列 == 父序列前缀 + 段序列 |
| INV3 | refs 中每个分支目录都存在；反向不要求 |
| INV4 | 任一分支同时至多一个活跃租约 |
| INV5 | `headroom = max - (running+starting+stopping+reserved) ≥ 0` |
| INV6 | `used` 的四个分项与实际记录一致，且预留有 TTL |
| INV7 | `rev` 在 epoch 内单调；`refsRev` 单调；`tipBytes` 在同一 `writerEpoch` 内单调 |
| INV8 | 任一时刻至多一个 writer；切换窗口 writer=none |
| INV9 | 归档后分支可读、写返回 409；home 仍存在 |
| INV10 | presence/uptime/disk 不影响 ETag 与 rev |
| INV11 | 任意 304 后 `getSnapshot().status` 引用不变 |
| INV12 | 任意失败路径都释放预留、租约、端口、快速档 |

5000 步；任一步失败打印 seed + 操作序列 + 违反的不变量。崩溃注入按 `crashAt(stepName, N)` 覆盖 `mkdir / writeSlot / rename / fsync / readback / append / flipRefs / spawn / handshake`。

### 8.4 CI 门槛（阻塞合并）

| 组 | 必跑 |
|---|---|
| 六态 | RT-01、RT-04、RT-06、RT-08 |
| 进度 | RT-10、RT-11、RT-13 |
| 容量 | RT-17、RT-19、RT-20、RT-22 |
| 1:1/分支 | RT-30、RT-32、RT-35、RT-36、RT-39 |
| 新鲜度/写权 | RT-41、RT-42、RT-44、RT-46、RT-47、RT-49 |
| 崩溃/重连 | RT-55、RT-58、RT-60、RT-62、RT-64 |
| Store/coordinator | RT-43、RT-68、RT-71、RT-73、RT-75 |
| 性能 | RT-76、RT-78、RT-80 |
| 真进程 | RT-55、RT-58、RT-59（Windows CI 必跑；EPERM/句柄语义只有真机可复现） |

### 8.5 与既有测试的映射

| 本文组 | 分支评审 | 三区评审 | 说明 |
|---|---|---|---|
| A 六态 | — | T1、T4、T5 | 直接补 G1/G3/G5 |
| B 进度 | — | T1、T2 | 202 + phase |
| C 容量 | — | T7、T16 | `headroom` 四项 + 零请求 |
| D 1:1/分支 | T1–T8、T15–T21 | — | 分支内部不重复编号 |
| E 新鲜度/写权 | T8、T9、T10、T11、T26、T27、T28、T29 | T15 | ETag/串味/并发切换 |
| F 崩溃/重连 | T12–T20、T22 | T15 | 崩溃点与真进程 |
| G Store/coordinator | — | C1–C14 | 契约层 |
| H 性能 | T23–T25 | — | 预算 |

---

## 9. 分期与验收

| 阶段 | 内容 | 工作量 | 验收 |
|---|---|---|---|
| **P0 契约 + 纯函数** | 事实字段、六态派生、容量公式、ETag 稳定字段、准入账本、store 契约、coordinator 契约、测试桩 | 2 人日 | RT-A/B/C/E 中的纯函数与 Store 桩全绿；`session-format` 一行未改；契约评审通过 |
| **P1 只读实时视图** | 快照 v2 + ETag/epoch/rev + 5/60 s 轮询 + 选主 + 六态 UI + 四段进度 + 容量预判 + 1:1 归属 + 分支列表（不切换） | 3.5 人日 | 满员零请求；`starting` 200 ms 可见；A→B→A 无串味；`headroom` 四项正确；10 标签 1 条流 |
| **P2 切换与恢复** | 重启式切换 + 物化 + `RecoverySupervisor` + 归档保留 + 删除清单 + 一次性打开票据 + 崩溃恢复 | 4 人日 | 切换 3–8 s 落定或明确失败；P1–P9 崩溃点可恢复；删除有子分支被拒；归档后分支可读 |
| **P3 推送与协作** | SSE 失效通知（可选）+ tip 上报 + 指纹采样 + presence + 多标签打磨 + 监控 | 2.5 人日 | SSE 掉线不影响正确性；`fenced/diverged` 可见；presence 30 s 消失；双标签只一条流 |
| **明确不做** | 分支合并、热切换、母体会话分支写、WebSocket 面板、每卡轮询、满员排队、客户端自算生命周期 | — | 写进 CONTRACTS“不做”清单 |

**发布门槛：**

- P1 不得上线“可切换”按钮；切换在 P2 才开放。
- P1 的容量预判必须与服务端 409 使用同一套 `checks[]` 文案。
- P2 的 `stopping` 必须在归档点击后 200 ms 内可见；否则不上线归档。
- 任何阶段都不得出现“未握手变绿”“归档未确认移入归档行”“ghost 静默消失”。

---

## 10. 明确不做 / 待产品确认

### 10.1 明确不做

| 不做 | 原因 |
|---|---|
| 分支合并（CRDT/OT） | v1 的语义单位是“引用 + 段”，不是字符；跨分支只需“派生新分身” |
| 运行中热切换 | 依赖未知上游能力；失败会造成双写 |
| 母体会话的分支写入 | 母体只读是产品第一约束 |
| 面板 WebSocket | 请求-响应足够；WS 带来重连/缓冲/部署复杂度 |
| 每卡独立轮询 | N+1；多标签放大 |
| 满员排队 | 与 `maxForks` 的“同时存活”语义冲突；需要队列/位置/取消，工作量翻倍 |
| 客户端自算生命周期/容量 | 双写真相；前端算不出 reserved/stopping |
| presence 进快照 | 每次光标移动都会 invalidate；且 presence 是易失的 |
| 归档即删除 | 数据丢失风险 |
| 用 `KeyedMutex` 保证跨进程单写者 | 进程内锁防不了双窗口/双实例 |

### 10.2 待产品确认

| # | 问题 | 建议 |
|---|---|---|
| 1 | 正常退出（code 0）显示红 `failed` 还是灰“已停止”？ | 保留六态；`failed(reason=exited)` 用中性文案，灯色默认仍红（避免与 `crashed` 混淆），是否降为琥珀由产品定 |
| 2 | 分身 Web 是否显示跨端 presence？ | v1 只显示本人；P3 再经 fork→mother 通道聚合 |
| 3 | 同一分身是否允许第二个人只读连接？ | 允许读；切换仍独占；presence 解释“谁在看” |
| 4 | 车间容量是否随套餐变化？ | 当前 `maxForks` 是配置，VIP 表不含并发位；只有 `capacity.source='plan'` 才渲染升级 CTA |
| 5 | 分支上限 32/会话是否够？ | 先 32；按实测调；删除有子分支必须显式 |
| 6 | 日志物理格式是否坚持 JSONL？ | 数据 zstd 不变 + fang 元数据 JSONL；改数据格式需要上游同步 |
| 7 | 切换失败后是否自动重启旧分支？ | 建议自动重启一次；再失败进入 `failed(switch-aborted)`，给人工出口 |
| 8 | 归档分支是否自动清理？ | 不自动清理；删除时按体积二次确认 |

---

## 附录 A：证据索引

| 结论 | 位置 |
|---|---|
| 状态 store 单资源、304 只更新 `lastUpdatedAt`、全局单飞、`acquireActive` 无命名空间 | `src/lib/status-store.mjs:18-20`、`:76-113`、`:157-182`、`:168-171` |
| coordinator 直接起批、单飞无 rerun、状态快照每次新对象 | `src/lib/upgrade-coordinator.mjs:20-21`、`:32-44`、`:50-57` |
| `taskView` 只有四值、丢弃 `exit`、`provisioning` 变 failed | `src/plugins/orchestrator.mjs:302-327` |
| 配额只数 `running/ready`，未计 `starting/stopping/reserved` | `src/plugins/orchestrator.mjs:385-391`；`docs/REVIEW-三区隔离与快照回流.md` G2 |
| 归档先 stop 再轮询 3 s，失败返回 `stop-failed` | `src/plugins/orchestrator.mjs:860-923`；`archiveStopTimeoutMs` `:63-64` |
| 还原先置 RUNNING 再握手 | `src/plugins/orchestrator.mjs:941-963` |
| `/api/status` 无 ETag、`cache-control:no-store`；`/api/derive` 同步 200 | `src/plugins/orchestrator.mjs:1241-1268`、`:1301-1305` |
| `listForkSessions` 返回列表，1:1 不成立 | `src/plugins/orchestrator.mjs:806-857` |
| 导入会话整文件复制，可塞第二个会话 | `src/plugins/orchestrator.mjs:333-375` |
| `task.seed` 只有 sessionId | `src/plugins/orchestrator.mjs:454-460` |
| 母体与分身是两个进程（env 传递） | `src/plugins/orchestrator.mjs:479-491` |
| forker 退出分类、`max-forks` 第二道门、端口池 18000–18100 | `src/plugins/forker.mjs:201-206`、`:811-812`、`:74` |
| orchestrator 读的 `forker.status()` 不含 `exit/startedAt`；`publicFork` 有 `exit/startedAt` 但未进任务视图；两者都无 `stopRequestedAt` | `src/plugins/forker.mjs:410-429`、`:1201-1204`；`src/plugins/orchestrator.mjs:302-327` |
| fork-supervisor 重启退避 1–30 s、最多 3 次、启动对账 | `src/lib/fork-supervisor.mjs:11-18`、`:41-57`、`:59-74` |
| 六态评审与动作矩阵 | `docs/REVIEW-三区隔离与快照回流.md` §4.1、§6.2、§8.1 |
| 分支引用、双槽、租约、切换状态机、P1–P9 | `docs/REVIEW-会话分支实时协作语义.md` §1.2、§1.6、§3.3、§5.1、§5.4 |
| 分支 ETag 必须含 active 指针、缓存键含 branchId | 同上 §4.1、§4.2 |
| presence TTL 30 s、永不写 journal | 同上 §4.7 |
| 快照包 ≤256 KiB、轮询 5/60 s、降级阶梯 | 三区评审 §8.1、§8.2、§9.1 |
| 标题缓存键只含 sessionId + `(mtime,size)` | `src/plugins/session-catalog.mjs:245-246`、`:268` |
| 扫描器只认 `session.v4.jsonl.zstd`，新层级会静默变空 | `src/lib/session-format.mjs:621-629`；`docs/REVIEW-会话分支实时协作语义.md` §1.3 |
| 截断帧解压返回 0 字节而不抛错 | `src/lib/session-format.mjs:299-304` |
| `writeFileAtomic` 在 Windows 退化为 copy | `src/kernel/fsx.mjs:48-63` |
| 树拷贝吞错、junction-safe 删除 | `src/kernel/fsx.mjs:142-169`、`:192-206` |
| 链式账本“尾部不可解析则拒绝续写” | `src/kernel/ledger.mjs:43-55` |
| 唯一互斥是进程内 `KeyedMutex` | `src/lib/mutex.mjs:6-25` |
| `fang.pid` 定义了但无写者/校验者 | `src/kernel/paths.mjs:43`、`:65` |
| 母体 sessions 只读硬约束 | `src/kernel/paths.mjs:111-114`；`src/plugins/session-catalog.mjs:605-606` |
| VIP 配额表（free/vip10/...）与官方原身 vip100 | `src/lib/essence.mjs:38-52`、`:86-138` |
| 角色矩阵 | `src/kernel/role.mjs:15-32` |
| 分身 URL 带 token，每 spawn 轮换 | `src/kernel/paths.mjs:74-93`；`src/plugins/forker.mjs:842`、`:955-974` |
| Adapter 已有 SSE/事件游标 | `src/plugins/adapter.mjs:18-22`、`:1203-1236` |
| 面板三套轮询 5 s/8 s/10 s 与 N+1 | `client.js:803`、`:1776-1779`、`:2763`、`:1719-1723`、`:1764-1765` |
| UX 四段进度、满员/VIP 前置、8.4 抽屉 | `docs/UX-三区控制台规格-v1.md` §7、§8 |
| 三区评审 C1–C14 / G1–G6 / T1–T16 | `docs/REVIEW-三区隔离与快照回流.md` §9、§11 |
| 分支评审 C15–C20 / T1–T30 | `docs/REVIEW-会话分支实时协作语义.md` §6、§7 |
