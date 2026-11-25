# 瓮城控制面板 · 实时状态模型定稿 v1

- 文档状态：**定稿**，可作为面板 UI、HTTP 快照与测试的共同契约。
- 代码基线：dsh-Fang `3.0.5`；对照 `src/lib/status-store.mjs`、`src/plugins/orchestrator.mjs`、`client.js`。
- 本文范围：元主卡（母体/控制面主卡）与分身卡的**三色状态投影**、7 槽位与默认 5 配额、分组与折叠记忆、双击重命名、母体浮窗三个动作、轮询/ETag、派生进度与满员前置、归档/删除后的选中态收敛、多客户端冲突。
- 非本文范围：会话分支切换、分支合并、回流、CRDT/OT；这些沿用 `DESIGN-实时状态同步与分支协作-v1.md`。
- 冲突口径：旧设计文档里“`maxForks` 默认 8、六态直接展示、无 pause/rename”的部分，由本稿覆盖；分支与回流部分继续有效。

---

## 0. 结论与不可动摇的规则

### 0.1 十句结论

1. **服务端只存事实，客户端只做投影。** 后端存 `phase / desiredPhase / health / exit / rev`；绿/蓝/红不是数据库枚举，是三色投影函数的结果。
2. **`ready` 不是生命周期。** 握手成功是 `health.adapter = ok`；进程活不活是 `phase`。两者不能混成一根轴。
3. **红点只代表已证实的故障。** 进程崩溃、启动失败、运行中适配器失联才红；HTTP 轮询失败是“离线/未知”，不能冒充“崩溃”。
4. **蓝点是“未在工作但非故障”。** `paused`、`completed`、`stopping`、`archived` 都属于蓝色语义；具体文案由子状态给出。
5. **7 是物理槽位，5 是默认配额。** `slots = 7`，`limit = 5`（可配 1–7）；UI 显示 `5/5` 和 `槽位 5/7`，不把 7 当 7 个可用派生位。
6. **一个快照，一个 ETag，一个轮询节奏。** 面板、徽标、卡片不再各自拉 `/status`、`/tasks`；卡片不单独轮询会话列表。
7. **快照按 `(panelEpoch, panelRev)` 整包收敛。** 旧包整包丢弃；epoch 变化强制 200 全量替换；不做逐字段乱序合并。
8. **派生是 202 + `opId` 的异步操作。** 前端先出 ghost，服务端同步预留槽位，绝不等到握手结束才返回。
9. **重命名用 `titleRev` CAS，归档/删除用 `opId` 幂等 + 每任务串行。** 并发冲突返回当前实体，客户端显式收敛，不静默覆盖。
10. **选中态只存 `taskId`。** 列表项被归档/删除后，详情、浮窗、选中条必须同帧收敛；不保留任务对象的旧副本。

### 0.2 与旧文档的关系

| 项 | 旧口径 | 本稿定稿 |
|---|---|---|
| 分身状态 | 六态直接出 UI | 后端保留细粒度 `phase`，UI 归并为三色三态 |
| `maxForks` | 默认 8，范围 1–64 | 默认 **5**，有效上限 **7**；旧 8 在启动迁移时降为 7 并记审计 |
| `ready` | 与 `running` 并列 | `ready` 降为健康字段，不再作为生命周期 |
| 派生 | 同步 POST，握手后返回 | **202 + `opId`**，异步推进 |
| 重命名 | 无接口 | `titleRev` CAS 的显式 mutation |
| 母体动作 | 只有 restart-guard | 浮窗三动作：打开、暂停/恢复、重启；关闭母体不支持 |

---

## 1. 术语、数字与容量公式

### 1.1 术语

| 术语 | 定义 | 谁写 | 是否进快照 |
|---|---|---|---|
| 元主卡 | 母体/控制面主卡，回答“控制面是否在运行、是否暂停、是否崩溃” | 母体生命周期事实源 | 是 |
| 分身卡 | 一个 task/fork 的运行实例 | orchestrator 写任务事实，forker 写进程事实 | 是 |
| `phase` | 服务端权威的实际生命周期 | 仅服务端 | 是 |
| `desiredPhase` | 用户/系统的目标意图（running / paused / archived） | 服务端根据动作写入 | 是 |
| `health` | 适配器、心跳、控制面健康 | 服务端 | 是 |
| `rev` | 单对象语义版本；任何可见变化 +1 | 服务端 | 是 |
| `phaseSeq` | 仅生命周期转换 +1，用于拒绝旧阶段 | 服务端 | 是 |
| `titleRev` | 标题版本，仅重命名 +1 | 服务端 | 是 |
| `panelRev` | 快照语义版本；用于 ETag 与整包丢弃 | 服务端 | 是 |
| `panelEpoch` | 母体每次启动的新 UUID；防止重启后 rev 回退 | 服务端 | 是 |
| `slotIndex` | 7 个物理槽位中的稳定编号，0–6 | 服务端分配 | 是 |
| `opId` | 客户端生成的幂等键 | 客户端生成，服务端记录 | 是（操作中） |
| ghost | 已受理但尚无真卡的临时卡，键为 `opId` | 客户端 | 否（本地） |

### 1.2 7 槽位与默认 5 配额

这是两个不同的数，禁止合并：

| 字段 | 值 | 含义 | 谁能改 |
|---|---|---|---|
| `capacity.slots` | **7** | 面板/运行时的物理槽位硬上限；`slotIndex` 只能在 0–6 | 产品/部署 |
| `capacity.limit` | **5**（默认，1–7） | 当前准入配额；派生、还原都要过这道门 | 配置或套餐 |
| `capacity.used` | 动态 | 当前占用配额的分身数 | 服务端账本 |
| `capacity.headroom` | 动态 | `max(0, limit - used)` | 服务端计算 |
| `capacity.slotFree` | 动态 | `slots - used` | 服务端计算 |

**占用（used）的 phase：**

```text
starting + running + pausing + paused + resuming + stopping + reserved
```

- `reserved` 是派生/还原受理后、真卡出现前的容量预留，TTL 25 秒。
- `paused` **仍然占槽**；只有归档/删除/完成才释放。UI 必须能解释“暂停了为什么还是满员”。
- `crashed` 本身不占槽；如果自动重启已排期，则必须记入 `reserved`，防止重启时超卖。
- `failed / completed / archived / deleted` 不占槽。
- `completed` 如果没有显式完成事件就不存在，不能因为“没有心跳/没有活动”推断完成。

**判定：**

- `headroom = 0` 且容量数据新鲜 → 派生/还原 CTA 禁用，点击零请求。
- 容量数据陈旧（超过 2 个轮询周期）→ CTA 可点但提示“状态可能已变”，由服务端 409 最终仲裁。
- 由于 `limit ≤ slots`，正常情况 `headroom ≤ slotFree`；两个数仍分别放在快照里，便于解释“是配额满还是物理槽位满”。

**7 个槽位的渲染规则：**

- 槽位是布局与恢复位置，不是 7 个可点击的“新建位”。
- 默认配额 5 时，只渲染 5 个可用卡位；第 6、7 位显示为“未启用/超出当前配额”，或只在容量抽屉中显示。
- 不要把 `Array(7).fill(...)` 当作任务列表，也不要用数组下标当 `taskId`。
- 归档/删除释放 `slotIndex`；还原优先复用原槽位，原槽位被占则取最小空闲槽位。
- 如果 7 只是视觉列数、不是硬容量，则不要把 7 写进 `capacity`；本稿按“硬槽位 7”执行。

**迁移：**

- `maxForks` 默认从 8 改为 5，有效范围 1–7。
- 存量配置为 8 的安装：启动时把有效 `limit` 降为 7，写一条审计 `quota.migrated`，UI 显示“7/7（历史配置已收敛）”。
- 任何“升级解锁第 6/7 位”的 CTA，只有 `capacity.source = plan` 时才能出现；`source = config` 时只能提示联系管理员，不能承诺升级。

---

## 2. 状态机

### 2.1 分身的 phase

| phase | 语义 | 进程 | 占槽 | 典型 health | UI 粗态 |
|---|---|---|---|---|---|
| `provisioning` | 正在装配 home/profile，尚未 spawn | 否 | 是（预留） | n/a | 进行中 |
| `starting` | 已 spawn，等待 URL/进程稳定/握手 | 是 | 是 | `pending` | 进行中 |
| `running` | 进程活着 | 是 | 是 | `pending` / `ok` / `error` | 进行中；error 时异常 |
| `pausing` | 暂停请求已受理，等待运行时静默 | 是 | 是 | n/a | 暂停 |
| `paused` | 已暂停，保留 home 与槽位，可恢复 | 可能已停 | 是 | n/a | 暂停 |
| `resuming` | 恢复中（可能重新 spawn/握手） | 是 | 是 | `pending` | 进行中 |
| `stopping` | 归档/停止请求已受理，等待“观察到退出” | 是 | 是 | n/a | 暂停（停止中） |
| `completed` | 显式完成；保留 home，不再运行 | 否 | 否 | n/a | 完成 |
| `crashed` | 非主动停止的异常退出 | 否 | 否（重启预留除外） | n/a | 异常 |
| `failed` | 装配/启动失败（停止超时不是 failed，回原态并记 `stopFailedAt`） | 否 | 否 | n/a | 异常 |
| `archived` | 冻结：进程已退出、home 保留 | 否 | 否 | n/a | 已归档 |

> `ready` 不在此表。它是 `phase = running` 且 `health.adapter = ok` 的**健康投影**。`running` + `health.pending` 可以持续 10 秒，这是正常的启动窗口；超过握手预算后 `health.error`，但 phase 仍是 `running`。

### 2.2 分身状态机

```text
[点击派生 / opId]
      │ 服务端同步预留
      ▼
  provisioning ──装配失败/超时──▶ failed
      │ 装配成功
      ▼
   starting ──spawn 失败/超时──▶ failed
      │ 进程活
      ▼
   running ──适配器超时──▶ running + health=error（异常，但不是 failed）
      │
      ├── pause ──▶ pausing ──▶ paused
      │                   └── 暂停超时 ──▶ running + lastError
      │
      ├── archive ──▶ stopping ──观察到退出──▶ archived
      │                   └── 停止超时 ──▶ 回原态 + stopFailedAt，不标 archived
      │
      ├── completion 事件 ──▶ completed
      │
      └── 非主动退出 ──▶ crashed ──retry──▶ starting
                           └── 重试耗尽 ──▶ 保持 crashed，lastError 说明
paused ──resume──▶ resuming ──▶ running
paused ──archive──▶ stopping ──▶ archived
failed / crashed / completed ──archive──▶ archived
archived ──restore──▶ starting（新端口、新 token、新 urlEpoch）
archived ──delete──▶ deleted（终态，快照中消失或留 tombstone）
```

转换硬规则：

| 规则 | 说明 |
|---|---|
| 阶段单调 | `phaseSeq` 只增；旧包里的低 `phaseSeq` 不得回退 UI。 |
| 归档必须见证退出 | 没观察到进程退出，不得写 `archived`；`stop-failed` 必须回原态并记录 `stopFailedAt`，显示“进程仍在”。 |
| 崩溃不冒充失败 | 非主动退出且 `exit.kind = crash` 才是 `crashed`；启动失败是 `failed`；正常退出是 `completed` 或 `failed(reason=exited)`，看产品语义。 |
| 握手超时不杀进程 | `running` + `health.error`，保留打开/归档/诊断入口；不得自动标 failed/archived。 |
| 自动重启不掩盖崩溃 | 重启排期期间仍可显示 `crashed · N 秒后重试`，真正重新 spawn 后才进入 `starting`。 |
| 归档后面板动作冻结 | `stopping/archived` 拒绝重命名、暂停、再次归档；只允许还原/删除（archived）。 |
| 服务端串行 | 同一 `taskId` 同时只允许一个改变生命周期的长操作；短重命名用 `titleRev` CAS。 |

### 2.3 元主（母体）的 phase

| phase | 语义 | 进程/控制面 | UI 色 |
|---|---|---|---|
| `starting` | 母体启动、路由/服务未就绪 | 启动中 | 绿（启动中） |
| `running` | 控制面可服务，心跳新鲜 | 运行 | 绿 |
| `pausing` | 暂停请求已受理 | 收敛中 | 蓝（暂停中） |
| `paused` | 明确暂停；不接新工作 | 暂停 | 蓝 |
| `resuming` | 恢复中 | 收敛中 | 绿（继续中） |
| `restarting` | 已交给 restart-guard，等待新 epoch | 重启中 | 绿（重启中） |
| `completed` | 可选：显式收尾完成；当前没有该事件时永不出现 | 完成 | 蓝（完成） |
| `crashed` | 有外部证据证明异常退出，或下次启动对账发现 unclean-exit | 崩溃 | 红 |
| `failed` | 启动失败且无法进入服务 | 失败 | 红 |

规则：

- **元主不能可靠上报自己的死亡。** 母体进程被杀后，面板也不在了；“红崩溃”只能由外部 supervisor、持久化的 unclean-exit 对账，或下一次启动的 `lastIncident` 提供证据。
- 单纯 HTTP 轮询失败只能得到 **离线/未知**，不能写 `phase=crashed`。离线用灰色/断线降级，不抢红点的语义。
- 暂停/恢复/重启是目标能力。当前 orchestrator 只提供 `requestMotherRestart`（转交 restart-guard），没有 pause/resume 路由；未上线前 `actions.pause/resume` 必须 `enabled=false, code=capability-missing`，不能画一个假按钮。
- 母体不支持“关闭/杀死”。若浮窗第三个动作是“关闭”，应从产品删除；唯一退出路径是 restart-guard 审批后的重启。
- `completed` 对元主通常不可达：只有产品定义了有限生命周期并给出显式完成事件时才存在；没有事件就永远不显示蓝色“完成”，不能用“空闲”推断。分身的 `completed` 同理。

### 2.4 三色投影（唯一入口）

所有卡片、徽标、分组、计数必须调用同一个纯函数 `projectCardState(facts)`。禁止组件各自写一套。

```text
输入：phase, health, serverFresh, desiredPhase
输出：{ tone: green|blue|red|neutral, bucket: active|paused|error|archived,
        label, sublabel, actions }
```

判定顺序（先命中先返回）：

| 序 | 条件 | tone | bucket | 文案 |
|---|---|---|---|---|
| 1 | 服务端明确 `phase ∈ {crashed, failed}` | 红 | error | 已崩溃 / 启动失败 |
| 2 | `phase = running` 且 `health.adapter = error` | 红 | error | 运行中 · 适配器失联（异常） |
| 3 | 服务端判定心跳/控制面 stale | 红 | error | 失联 · 状态未知 |
| 4 | `phase ∈ {pausing, paused, stopping, completed, archived}` | 蓝 | paused | 暂停中 / 已暂停 / 停止中 / 已完成 / 已归档 |
| 5 | `phase ∈ {provisioning, starting, resuming, running}` | 绿 | active | 装配中 / 启动中 / 继续中 / 运行中 |
| 6 | 无快照或传输失败 | 中性 | unknown | 离线/状态未知，保留上次已知卡 |

补充：

- `health.adapter = pending` 只允许出现在 `starting/resuming/running` 的前 10 秒窗口，保持绿色“握手中”；服务端超过预算后写 `health.error`，才转红。
- `paused` 的适配器健康不参与红点判定；暂停的进程本来就不该有健康心跳。
- `archived` 是蓝色语义，但单独进“已归档”组/读档视图；不要和“暂停”混成同一张可操作卡。
- **客户端不得用 `Date.now() - lastHeartbeatAt` 判红/绿。** stale 必须由服务端基于自己的时钟计算并写入 `health.fresh` 或 `phase`。
- 三色不是四个相位。`starting` 和 `running` 都是绿色“进行中”；`stopping` 和 `paused` 都是蓝色“暂停/完成”；`crashed` 和 `failed` 都是红色“异常”。子文案负责区分，不要新增黄/紫第四色。

### 2.5 动作矩阵（服务端给，UI 只展示）

| phase | 打开 | 重命名 | 暂停 | 恢复 | 归档 | 还原 | 删除 | 重试 |
|---|---|---|---|---|---|---|---|---|
| provisioning | 否 | 是 | 否 | 否 | 否 | 否 | 否 | 否 |
| starting | 否 | 是 | 否 | 否 | 否 | 否 | 否 | 否 |
| running | 是（有 url） | 是 | 是 | 否 | 是 | 否 | 否 | 否 |
| running + health.error | 是（诊断） | 是 | 否 | 否 | 是 | 否 | 否 | 重试握手 |
| pausing | 否 | 否 | 否 | 否 | 否 | 否 | 否 | 否 |
| paused | 否 | 是 | 否 | 是 | 是 | 否 | 否 | 否 |
| resuming | 否 | 是 | 否 | 否 | 否 | 否 | 否 | 否 |
| stopping | 否 | 否 | 否 | 否 | 否 | 否 | 否 | 否 |
| completed | 否 | 是 | 否 | 否 | 是 | 否 | 否 | 否 |
| crashed | 否 | 是 | 否 | 否 | 是 | 否 | 否 | 是 |
| failed | 否 | 是 | 否 | 否 | 是 | 否 | 否 | 是 |
| archived | 否 | 否 | 否 | 否 | 否 | 是 | 是 | 否 |

- 动作可用性由服务端的 `actions` 掩码给出；UI 不根据 phase 二次推断“该不该灰”。
- `actions.*` 必须带 `confirm: none | once | strong` 和 `blockedCode/detail`。置灰原因来自服务端，避免前端文案漂移。
- `rename` 在 `stopping/archived` 永远拒绝；归档是标题的终态。
- 分身的 `pause/resume`、`completed` 也是目标能力：当前 orchestrator/forker 没有暂停路由，也没有完成事件。未实现前必须由服务端把对应 actions 置为 `enabled=false, code=capability-missing`；UI 不能凭 phase 自己变出蓝点“已完成”。
- `archive` 不删 home；UI 旧文案“归档并删除 $DSH_HOME”必须改成“停止进程、保留 home；永久删除在归档行”。
- `provisioning/starting` 若需要中途取消，用独立的 `cancel` 动作，不要复用 archive 语义；没有 cancel API 时只能等 20 s 预算失败后再归档，不能假装“已取消”。

---

## 3. 字段契约

### 3.1 快照信封

```json
{
  "schemaVersion": 1,
  "panelEpoch": "uuid-per-mother-boot",
  "panelRev": 42,
  "generatedAt": 1760000000000,
  "mother": {},
  "tasks": [],
  "capacity": {}
}
```

| 字段 | 类型 | 约束 |
|---|---|---|
| `schemaVersion` | int | 破坏性变更才 +1；客户端不认识就降级只读 |
| `panelEpoch` | string | 母体每次启动新值；变化即全量替换 |
| `panelRev` | int | 同一 epoch 内单调；任何可见语义变化 +1 |
| `generatedAt` | int | 服务端时间；只用于展示/新鲜度，不参与状态判定 |
| `mother` | object | 见 3.2 |
| `tasks` | array | 活跃 + 归档；按服务端稳定顺序返回，客户端只做展示排序 |
| `capacity` | object | 见 3.4 |

**不要**在信封里放 `now` 驱动的 uptime、`diskUsageBytes`、原始心跳时间、请求延迟；这些会破坏 304。

### 3.2 元主卡字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `"mother"` | 固定 |
| `phase` | enum | 见 2.3 |
| `desiredPhase` | `running / paused / restarting` | 目标意图；与 `phase` 不等即“收敛中” |
| `phaseSeq` | int | 生命周期转换序号，单调 |
| `rev` | int | 元主对象版本 |
| `health` | object | `{state: ok/degraded/unreachable, code?, since?}`；degraded 是警告，不直接转红 |
| `operation` | object/null | `{opId, kind: pause/resume/restart, startedAt}`；跨客户端可见的 busy |
| `lastIncident` | object/null | `{kind: unclean-exit, at, detail}`；用于下次启动解释红点 |
| `version` | string | 当前 Fang 版本 |
| `startedAt` | int | 本次启动时间 |
| `phaseChangedAt` | int | 当前 phase 进入时间 |
| `actions` | object | 见 3.5，至少 open/pause/resume/restart |

### 3.3 分身卡字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `taskId` | string | 唯一键，也是所有 React key |
| `title` | string | 展示标题；服务端已 trim/限长 |
| `titleRev` | int | 只随重命名 +1 |
| `phase` | enum | 见 2.1 |
| `desiredPhase` | `running / paused / archived` | 目标意图 |
| `phaseSeq` | int | 只随 phase 转换 +1 |
| `rev` | int | 任务对象版本；任何字段变化 +1 |
| `slotIndex` | int/null | 0–6；归档/完成/失败不占槽时为 null |
| `origin` | `blank / session / restore` | 用于“临时/会话派生”分类；不要用标题正则判断 |
| `health` | object | `{adapter: pending/ok/error/n/a, fresh: boolean, code?, checkedAt?}`；`fresh` 由服务端判定，客户端不用本地时钟猜 |
| `exit` | object/null | `{kind: normal/crash/restart-request/killed, code, signal, at}` |
| `pid` / `port` | int/null | 诊断信息；重启后变化 |
| `url` | string/null | 已去 token 的可展示 URL；打开走一次性 open-url |
| `createdAt` | int | 任务创建 |
| `startedAt` | int/null | 本次进程启动；不是 createdAt |
| `phaseChangedAt` | int | 当前 phase 进入时间 |
| `stopRequestedAt` | int/null | 归档/暂停请求时刻 |
| `stoppedAt` | int/null | 观察到进程退出时刻 |
| `completedAt` | int/null | 显式完成时刻 |
| `archivedAt` | int/null | 归档确认时刻 |
| `archive` | object/null | `{homeKept, remote, stopFailedAt?}` |
| `operation` | object/null | 长操作 `{opId, kind, startedAt}` |
| `lastError` | object/null | `{code, message, at}`；已翻译前的稳定码 |
| `actions` | object | 见 3.5 |
| `legacyStatus` | string | 兼容旧客户端：由 phase 派生，不反向写 |

### 3.4 容量字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `slots` | int | 固定 7（硬上限） |
| `limit` | int | 默认 5，1–7 |
| `used` | int | 当前占用数 |
| `byPhase` | object | `{starting,running,pausing,paused,resuming,stopping,reserved}` |
| `headroom` | int | `max(0, limit - used)` |
| `slotFree` | int | `slots - used` |
| `portFree` | int/null | 可选；端口耗尽另给 `port-exhausted` |
| `source` | `config / plan` | 决定是否能出现“升级扩容”CTA |
| `fresh` | boolean | 服务端判定容量数据是否仍新鲜；stale 时允许点击并由 409 仲裁 |
| `capturedAt` | int | 服务端采样时间 |
| `derive` | object | `{enabled, code, detail}`；派生 CTA 的服务端结论 |
| `restore` | object | `{enabled, code, detail}`；还原同样消耗槽位 |
| `checks` | array | `{id, ok, code, current, limit, detail, remediation}`；满员原因 |

### 3.5 动作对象

每个动作统一为：

| 字段 | 类型 | 说明 |
|---|---|---|
| `enabled` | boolean | 服务端判定 |
| `code` | string/null | 禁用/失败原因稳定码 |
| `detail` | string/null | 可读原因 |
| `confirm` | `none / once / strong` | 二确认等级；服务端给建议，客户端执行 |
| `busy` | boolean | 是否已有同任务长操作；由服务端 `operation` 或客户端 pending 合并 |

动作至少包含：`open, rename, pause, resume, archive, restore, delete, retry, cancel`。母体动作至少包含：`open, pause, resume, restart`。

### 3.6 变更接口契约

| 动作 | 方法与幂等 | 前置 | 成功 | 冲突/失败 |
|---|---|---|---|---|
| 派生 | `POST /fang/api/derive`，`Idempotency-Key: opId` | `capacity.headroom > 0`；服务端预留 | **202** `{opId, taskId, reservationId, phase: provisioning}` | 409 `quota-exceeded` / `port-exhausted`，带 `checks[]` |
| 重命名 | `PATCH /fang/api/tasks/:id`，`mutationId` | `actions.rename.enabled`；`baseTitleRev` | 200 `{taskId, title, titleRev, rev, panelRev}` | 409 `version-conflict` / `task-archived` / `task-gone`；400 `invalid-title` |
| 归档 | `POST /fang/api/tasks/:id/archive`，`mutationId` | `actions.archive.enabled` | 202/200 `{phase: stopping, rev, panelRev, already?}`，终态再给 `archivedAt` | 409 `stop-failed` / `task-gone` / `archive-in-progress` |
| 删除 | `POST /fang/api/tasks/:id/delete`，`mutationId` | `phase = archived` | 200 `{deleted: true, rev, panelRev}` | 409 `not-archived`；404/410 `task-gone` 按已收敛处理 |
| 暂停/恢复/重启母体 | `POST /fang/api/mother/:action`，`opId` | 对应 `actions.*` | 202 `{operation}` | 409 `capability-missing` / `restart-guard-unavailable` / `already-in-state` |

**错误信封：**

| 字段 | 说明 |
|---|---|
| `ok` | false |
| `error` | 稳定 code |
| `detail` | 可读补充 |
| `taskId` | 相关对象 |
| `current` | 冲突时的当前 `{rev, phase, title, titleRev}`；客户端直接用它收敛 |
| `checks` | 容量/前置条件明细 |

关键点：**所有 mutation 成功都要 bump `panelRev`**。否则下一次条件 GET 可能 304，UI 会永远停在旧标题/旧状态。

---

## 4. 7 槽位、分组顺序与折叠记忆

### 4.1 分组顺序

固定为：

| 顺序 | groupKey | 包含 | 默认折叠 |
|---|---|---|---|
| 1 | `active` | 进行中（绿：provisioning/starting/resuming/running） | 展开 |
| 2 | `paused` | 暂停/完成（蓝：pausing/paused/stopping/completed） | 折叠 |
| 3 | `error` | 异常（红：crashed/failed/running+health.error） | 展开 |
| 4 | `archived` | 已归档（蓝，单独读档区） | 折叠 |

- 采用用户枚举顺序“进行中 → 暂停 → 异常”；异常组不置顶，但顶部必须常驻异常计数/一次性横幅，避免错误被埋在末尾。
- 不提供拖拽改分组顺序；分组顺序是产品常量，不是用户数据。若未来要自定义，必须新增 `groupOrder` 服务端偏好，不能只存在 `localStorage`。
- “临时”不是第四种状态。用 `origin=blank` 做筛选/标签，不要用 `title` 正则（重命名会让卡片跳组）。若保留临时组，放在状态组之外，作为筛选器。

### 4.2 组内排序

| 组 | 排序 |
|---|---|
| active | `slotIndex asc` → `createdAt asc` → `taskId` 字典序 |
| paused | 同上 |
| error | 同上（异常不按严重度重排，避免每次轮询跳动） |
| archived | `archivedAt desc` → `taskId` |

- 排序键稳定；轮询不得因为 `updatedAt` 变化而换位。
- `slotIndex` 是服务端分配的稳定槽位，不是数组下标；归档释放后，新任务优先补最小空位。
- 如果 UI 使用 7 列固定槽位，按 `slotIndex` 放置，允许槽位空洞；分组视图是另一个展示层，不能改变槽位编号。

### 4.3 折叠记忆

- 存储键：`fang.panel.groups.v2`；值为 JSON 对象，不是 `Set`。
- 键必须为 `(panelId, groupKey)`；不要用数组下标、标题、中文 label。`groupKey` 固定为 `active/paused/error/archived`。
- 默认值：active 展开、paused 折叠、error 展开、archived 折叠。
- 用户手动折叠/展开后持久化；组暂时为空时保留记忆，下次重新出现恢复原状态。
- `schemaVersion` 变化时执行迁移/重置；storage 不可用时只保留当前会话内存态。
- 新建派生成功后，可临时展开目标组并滚动到新卡一次；不要永久改写用户的折叠偏好。
- 折叠状态不进快照、不进 ETag、不参与多客户端冲突；它是纯本地 UI 偏好。

---

## 5. 双击重命名：乐观更新与失败回滚

### 5.1 本地状态机

```text
idle
  └─ dblclick ──▶ editing(draft, baseTitleRev, previousTitle)
                    ├─ Esc / 无变化 ──▶ idle
                    ├─ Enter / blur ──▶ saving(mutationId, draft)
                    │                     ├─ 200 ──▶ committed（清 pending）
                    │                     ├─ 400/404/409 ──▶ conflict 或 rejected
                    │                     └─ 超时/5xx ──▶ unknown（不盲目回滚）
                    └─ 任务被归档/删除 ──▶ 关闭编辑并收敛
```

### 5.2 规则

1. **只乐观改标题，不乐观改 phase/容量。** 标题是低风险字段；归档/暂停/容量必须等权威快照。
2. 双击进入编辑时记录 `previousTitle`、`baseTitleRev`，并生成唯一 `mutationId`；同一编辑会话只允许一个在飞请求。
3. 渲染优先级：`pending.draft`（saving/conflict/unknown）→ 权威 `title`。轮询快照不得覆盖正在编辑的 draft。
4. 成功：服务端返回 `title/titleRev/rev/panelRev`；只有 `mutationId` 匹配且 `titleRev >= baseTitleRev` 才清除 pending。其它客户端的更新不得误清。
5. 400（空/超长/控制字符）：明确拒绝，回滚到 `previousTitle`，输入框下方给原因。
6. 409 `version-conflict`：**不自动回滚成旧值**。保留本地 draft，同时显示远端当前标题；给两个出口：
   - “采用对方”：丢弃 draft，清 pending；
   - “仍用我的”：用远端 `titleRev` 作为新 base 重发，生成新 `mutationId`。
   - 用户关闭冲突条：回滚到远端当前标题，避免长期幽灵。
7. 超时/5xx：结果是 **unknown**，不是失败。先保留 draft 并标“保存结果未知”；1 秒后强制刷新快照，用 `titleRev`/`title` 对账：
   - 服务端已是 draft → 视为成功；
   - 服务端仍是旧标题且 `titleRev` 未变 → 可用同一 `mutationId` 重试；
   - 服务端是第三个标题 → 进入冲突，不覆盖。
8. 双击/Enter/blur 不得重复提交：用同步 `commitLockRef` + `saving` 标志 + `mutationId` 三重防抖；不要只依赖 React state（state 更新是异步的）。
9. 归档/停止期间 `rename.enabled=false`；若 rename 在飞时归档先提交，服务端返回 `task-archived`，客户端清 pending、显示归档后的标题。
10. 重命名成功只 bump `titleRev/task.rev/panelRev`，不 bump `phaseSeq`，不改变三色状态。

### 5.3 服务端规则

- 校验：trim、去控制字符、1–120 个 Unicode 字符；空标题拒绝，不静默替换。
- CAS：`baseTitleRev` 必须等于当前 `titleRev`；否则 409 并返回当前标题/版本。
- 幂等：同一 `mutationId` 重放返回第一次结果，不重复 +1。
- 串行：每任务一把短锁或单写者事件循环内完成；与归档的长操作互斥，归档一旦进入 `stopping` 就冻结标题。
- 审计：记录 `taskId, oldTitle, newTitle, titleRev, mutationId, actor/clientId`；不回传 token。

---

## 6. 母体浮窗三个动作：busy 与二确认

以“打开 / 暂停·恢复 / 重启”为定稿三动作。若 mock 的第三个动作是“关闭”，删除它——母体没有面板直杀路径。

| 动作 | 触发 | 确认等级 | busy 来源 | 成功判定 | 失败/断线 |
|---|---|---|---|---|---|
| 打开 | 点击“打开母体/门户” | none | 仅本地获取一次性 URL 的短暂 busy | 新窗口/标签打开 | 弹窗被拦截给可点击链接；404 给诊断，不标崩溃 |
| 暂停 / 恢复 | 切换按钮 | 暂停 `once`；恢复 `none` | 服务端 `operation.opId` + `desiredPhase ≠ phase` | `phase` 到达 `paused` / `running` | 超时不假装成功；显示“仍在收敛”，保留当前 phase |
| 重启 | 点击“重启母体” | **strong** | 服务端 `operation` + epoch 变化 | 新 `panelEpoch` + `phase=running` | UI 可能先断线；重连后按新 epoch 对账，显示“重启中/已完成/失败” |

规则：

- **busy 不是全局布尔值。** 用 `pendingOps`（按 `motherId + action`）合并服务端 operation；暂停/重启互斥，打开不互斥。
- 二确认必须用可访问的自定义对话框，不用 `window.confirm`：标题、影响清单、确认按钮、取消按钮、Esc、焦点陷阱、返回焦点。
- 暂停确认文案必须列出影响：是否停止受理新派生、是否影响运行中的分身、是否断开面板。不能只写“确定暂停？”。
- 重启确认文案：会断开当前面板连接；子分身是否受影响由服务端 `impact` 给出；必须二次点击/勾选，不能单击即发。
- 点击确认后**先同步加锁，再发请求**；请求返回 202 后显示“已发起”，不要乐观把 phase 改成 paused/running。
- 重启请求发出前把 `{opId, requestedAt}` 写入 `sessionStorage`；页面重连后据此显示“重启中”，避免把断线误判为失败或重复发起。
- 动作不可用时显示服务端原因：`capability-missing`（pause/resume 未实现）、`restart-guard-unavailable`、`already-in-state`。不要渲染“看起来能点”的死按钮。
- 母体 `phase=paused` 是蓝色，但“暂停”不等于“归档”；暂停仍可在恢复后继续，归档/删除只针对分身。

---

## 7. 轮询、刷新与 ETag

### 7.1 单一快照端点

- 目标端点：`GET /fang/api/panel/snapshot`。
- 兼容：`/fang/api/status` 和 `/fang/api/tasks` 保留，但必须由同一份快照生成，禁止各自维护一套 counts/list。
- 会话列表 `GET /fang/api/tasks/sessions?taskId=` 独立按需：只在卡片展开时拉，缓存 30 秒，绝不由快照轮询触发 N+1。
- 徽标、面板、独立门户共享同一个 `PanelSnapshotStore`；镜像卡继续用镜像自己的低频状态，不混任务计数。

### 7.2 频率

| 档 | 间隔 | 触发 | 上限 | 说明 |
|---|---|---|---|---|
| `active` | **5 s** | 面板可见、有订阅、用户活跃 | 常驻 | 默认 |
| `fast` | **1 s** | 派生/归档/暂停/重启/还原收敛中 | 30 s | 只缩短同一快照的节奏，不换接口 |
| `idle` | **60 s** | 30 s 无交互 | 常驻 | 降级不改变数据，只降频 |
| `hidden` | **0** | `document.hidden` | — | 回前台强制刷新一次 |
| 错误退避 | 5→10→20→40→60 s + jitter | 连续失败 | 60 s | 成功即复位；401/403 停止轮询 |
| 手动刷新 | 立即 | 点击“刷新” | 单飞 | 绕过 ETag；在飞时只排一次尾随刷新 |

规则：

- 快速档必须在 `finally` 释放；组件卸载、页面隐藏、动作失败都要释放。
- `document.hidden` 时 0 请求；`visible` 时强制一次条件/无条件刷新，并重置退避。
- 10 个标签页不应产生 10 条独立快照流：优先 `BroadcastChannel` 选主；至少 ETag 会让非主标签的轮询很便宜。
- 徽标不再 10 秒独立拉取；它订阅快照，显示同一 `ready/limit` 与异常数。
- 卡片运行时长每秒本地刷新，不触发快照；不要把 uptime 放进 ETag。

### 7.3 ETag

- 响应头：`ETag`、`Cache-Control: no-cache, must-revalidate`；200 带完整 body，304 无 body。
- 客户端发 `If-None-Match`；304 只更新 `lastUpdatedAt`，**保留原对象引用**，不 set `status=null`，不清列表，不重渲染整棵树。
- `panelEpoch` 放进 ETag 语义；epoch 变化必须 200，即使 `panelRev` 数值相同。
- ETag 稳定字段：
  - `panelEpoch`、`panelRev`；
  - 每个任务：`taskId, title, titleRev, phase, phaseSeq, health.adapter, health.fresh, exit.kind/code, slotIndex, archivedAt, actions.*`；
  - 容量：`slots, limit, used, headroom, slotFree, source, fresh, derive.enabled, restore.enabled`；
  - 元主：`phase, phaseSeq, health.state, operation.opId, lastIncident.at`。
- 排除字段：`uptimeMs`、`now`、`lastHeartbeatAt` 原始值、`diskUsageBytes`、`checkedAt`、请求延迟、动画/选中/折叠状态。
- 手动刷新：发送 `force=1` 并省略 `If-None-Match`，强制 200；不要用“清空数据 + 骨架屏”表达刷新。
- 旧包：同 epoch 且 `panelRev` 更小 → 整包丢弃；不同 epoch → 全量替换。不要逐字段合并，尤其不要用旧包的 `title/phase` 覆盖新包。
- mutation 成功必须 bump `panelRev`；否则条件 GET 可能 304，导致“操作成功但界面不变”。

### 7.4 对 `status-store` 的复用与修正

`MirrorStatusStore` 的骨架可以复用：订阅计数、active/idle 双档、`acquireActive`、`pokeActive`、304 只更新时间、`dispose` 中止。但必须修正：

| 现状 | 问题 | 定稿 |
|---|---|---|
| 每次 `refresh` 先 `loading:true` | 每 5 秒整面板重渲染/闪 | 只有首帧或手动刷新才 loading；后台轮询用 quiet |
| `inFlight` 直接吞掉手动刷新 | 用户点刷新没反应 | 记录 trailing force，当前请求结束后补跑一次 |
| 只有 `status`，无 `rev/epoch` | 旧响应无法丢弃 | 快照层增加 `panelEpoch/panelRev`，store 保留最近 ETag |
| 单资源 | 三区/徽标各自为政 | 一个 PanelSnapshotStore；会话/镜像另建资源 |
| 全局 `acquireActive` | 无法局部 fast | 增加命名空间（derive/archive）或独立 fast 调度，保留原契约 |
| 304 只更新时间 | 正确，但 `loading` 仍会闪 | 304 不置 loading，不替换引用 |

---

## 8. 派生进度与满员前置判定

### 8.1 派生五段（四段进度 + 就绪终止）

| 段 | 服务端事实 | 文案 | 预算 | 超时 |
|---|---|---|---|---|
| 受理 | 同步预留成功，尚未建任务 | 正在受理… | ≤300 ms | 2 个快照周期无 `taskId` → ghost “未确认”，不假装成功 |
| 装配 | `phase=provisioning` | 装配 profile… | ≤3 s | `failed(provision-timeout)`，释放预留 |
| 启动 | `phase=starting` | 启动进程 · 端口/PID | ≤5 s | `failed(spawn-timeout)`，释放端口/预留 |
| 握手 | `phase=running` + `health.pending` | 等待适配器握手… | ≤10 s | `running + health.error`，保留打开/归档，不标 failed |
| 就绪 | `phase=running` + `health.ok` | 已就绪 | — | 只有此时才允许自动打开 |

- 总预算 20 秒由服务端硬控制；客户端不自己把 20 秒到点写成 failed。
- `phaseSeq` 只前进；旧快照的阶段不得把进度条拉回。
- 失败必须带稳定 code（`provision-timeout`/`spawn-failed`/`handshake-timeout` 等）；`handshake-timeout` 不是失败，是异常。

### 8.2 ghost 与真卡

- ghost 键：`opId`；真卡键：`taskId`。
- 点击即插 ghost，`aria-busy`；202 返回后绑定 `taskId`。快照中出现真卡时复用同一 DOM 位置，避免闪两次。
- ghost TTL：**2 个快照周期**，不是墙钟；快速档 2 秒、空闲档 2 分钟都按周期算。
- 2 周期仍无 `taskId` → “未确认”卡，给刷新/取消；不自动消失，不假装成功。
- 失败 → ghost 转失败卡，保留 code + 重试；重试生成新的 `opId`（除非用户显式重放同一操作）。

### 8.3 满员前置

```text
canDerive =
  capacity.headroom > 0
  AND capacity.fresh
  AND capacity.derive.enabled
```

- 新鲜满员：CTA `aria-disabled=true`，点击**零 POST**，打开原因抽屉；不能只把按钮 `disabled` 导致键盘/读屏不可达。
- 陈旧：显示“状态可能已变”，允许点击；服务端 409 后按 `quota-exceeded` 收敛，不显示通用“派生失败”。
- 服务端在第一次 `await` 之前同步预留；`reserved` 立刻计入 `used`，因此面板下一次快照就会显示满员，不靠前端本地累加。
- 同一个 `opId` 重放（双击、两标签页、网络重试）返回同一个 `taskId`，最多产生一个分身。
- 派生失败、超时、取消都必须释放预留；预留 TTL 25 秒，母体重启后对账清理孤儿预留。

### 8.4 自动打开

- 只允许在 **用户主动派生** 且 `phase=running + health.ok` 后自动打开一次。
- 按 `taskId` 记已打开集合，后台轮询发现的新任务不得自动弹窗。
- 不能在 `starting` 或仅有 `url` 时打开；当前实现存在“拿到 url 就 window.open”的提前行为，必须删除。
- 弹窗被拦截时给可点击的“打开分身”链接，不重试弹窗。

---

## 9. 归档、删除与选中态收敛

### 9.1 归档

| 阶段 | UI | 容量 | 选中 |
|---|---|---|---|
| 用户确认 | 不立即移除；卡进入 pending | 不变 | 保留 |
| 服务端 `stopping` | 卡保留，显示“停止中”，动作全禁用 | 仍占用 | 保留 |
| 观察到退出 → `archived` | 从 active 移到 archived；显示归档时间 | 释放 `slot/used` | 若原选中，清除或转到归档行 |
| `stop-failed` | 卡留在原组，红/异常，显示进程仍在 | 不变 | 保留 |
| `already` | 视为成功，直接收敛 | 已释放 | 同上 |

- 归档不是删除：home、会话、分支都保留；确认文案必须写清。
- 归档成功前不得从列表移除；否则失败时卡片“消失又回来”，容量也会短暂错误。
- 归档失败不能清空面板，只加错误条/卡内原因。
- 归档后标题冻结；还原不清空 home，但会生成新端口、新 token、新 urlEpoch。

### 9.2 删除

- 只允许 `phase=archived`；先显示体积/会话数，再做 **strong** 二次确认。
- 删除成功：从 archived 列表移除、清理选中、释放所有引用；不需要刷新才能消失。
- 删除 404/410：按“已经不存在”收敛，显示成功/已删除，不弹“失败”惊吓用户。
- 删除失败（home 被占用等）：保留归档行，显示可操作的错误，不把记录先删掉。

### 9.3 选中态收敛

- 状态里只存 `selectedTaskId: string | null`；不要存整个 task 对象。
- 每次渲染用 `tasks.find(t => t.taskId === selectedTaskId)` 派生详情；找不到就是 `null`。
- 归档当前选中：
  - 从 active 移出后，清除选中；焦点移到同组下一个卡，若组空则移到组头/派生 CTA。
  - 若用户正在读档视图，可保留选中并定位到 archived 行；两种模式必须明确，不能一边显示 active 详情一边任务已归档。
- 删除当前选中：清除选中；焦点移到相邻归档行；空态聚焦“返回面板”或空态标题。
- 其它客户端导致选中项消失：同一条规则，不显示 stale 详情，不保留旧对象。
- 选中项移到折叠组：保留选中条，显示“已移到已折叠组”，提供“展开定位”；不要静默把详情清空。
- 列表 key 用 `taskId`；分组 key 用固定 `groupKey`；禁止 index key。

### 9.4 多客户端归档/删除

- 归档请求带 `mutationId`；服务端每任务串行：
  - 第一个请求进入 `stopping`；
  - 第二个请求返回 `202 archive-in-progress` 或 `already`，跟随同一 phase；
  - 已归档再归档返回 `already: true`，UI 视为成功。
- 删除在归档未完成时返回 `not-archived`；删除已不存在返回 `task-gone`，按已收敛处理。
- 客户端收到 409 时使用 `current` 实体更新列表/选中，不继续重试旧动作。
- 另一客户端归档时，本端正在重命名：服务端拒绝 rename，客户端清 pending、采用 archived 标题；不覆盖归档终态。

---

## 10. 多客户端并发冲突矩阵

| 并发操作 | 服务端裁决 | 客户端表现 |
|---|---|---|
| 重命名 vs 重命名 | `titleRev` CAS；先提交者赢，后者 409 `version-conflict` | 后者显示“已被改为 X”，保留 draft + 采用/覆盖选择 |
| 重命名 vs 归档 | 归档先进入 `stopping` 则 rename 409；rename 先提交则归档保留新标题 | pending rename 清掉或转冲突；归档标题以服务端为准 |
| 归档 vs 归档 | 第一个执行；第二个 `already`/`archive-in-progress` | 两个标签都收敛到 archived，不重复审计/停止 |
| 归档 vs 删除 | 删除要求 archived；归档未完成 → 409 `not-archived` | 删除按钮在 stopping 时禁用/提示等待 |
| 删除 vs 还原 | 每任务串行；先提交者赢 | 后者 `task-gone`/`not-archived`，刷新收敛 |
| 派生 vs 派生 | `opId` 幂等 + 同步预留 + 服务端配额 | 双标签只产生一个；超出配额 409 带 `checks[]` |
| 暂停/恢复 vs 归档 | 长操作互斥；归档优先/先到者赢 | 失败方显示当前 phase，不乐观覆盖 |
| 轮询旧包 vs 新操作 | `(epoch, rev)` 整包丢弃旧包 | 乐观 pending overlay 保留，直到 ack/冲突 |
| 改名超时 vs 服务端已提交 | `mutationId` + 强制刷新对账 | 不盲目回滚；标题最终一致 |
| 两客户端折叠状态不同 | 本地偏好，不冲突 | 各存各的 `localStorage`，互不影响 |

实现要求：

- 每个 task 一个服务端 mutation 串行区；所有长操作在 `await` 前后检查 phase，防止两个 `archiveTask` 同时穿过“未归档”判断。
- 服务端写 `rev/panelRev/titleRev` 后才能返回；响应带当前实体，客户端不需要再猜。
- 客户端冲突处理必须“保留用户输入 + 展示远端当前值 + 明确选择”，不能 LWW 静默覆盖，也不能一律回滚旧值。
- 不能用 `updatedAt` 墙钟排序或裁决；只用服务端 revision/seq。

---

## 11. React mock 中会导致状态不一致的写法

仓库里没有独立的 mock 文件；以下按 mock 常见写法审计，并在括号中给出当前 React 面板里的同类证据。逐条都应在实现前改掉。

| # | 写法 | 为什么会不一致 | 定稿做法 |
|---|---|---|---|
| R1 | 同时 `GET /status`、`GET /tasks`、`GET /sessions`，各自 `useState` | 计数来自 status、卡片来自 tasks，一边成功一边失败就互相打脸；会话 N+1 各有新鲜度 | 单一 snapshot store；会话按需；`status/tasks` 兼容路由由同一快照生成 |
| R2 | `selected` 存整个 task 对象（`client.js` 1631） | 轮询替换列表后对象还是旧的；归档/删除后详情仍显示 | 只存 `selectedTaskId`，每帧从快照派生 |
| R3 | 一个全局 `busy` 字符串 + `if (busy) return`（1668、1820） | 归档 A 时不能重命名 B；React state 未提交前快速双击可穿透；错误提示互相覆盖 | `pendingOps` 按 `(taskId, action)` 键；同步 ref 锁；每次操作独立 `mutationId` |
| R4 | 轮询直接 `setTasks(body.tasks)`（1754） | 正在乐观重命名的 draft 被旧标题覆盖；旧响应覆盖新归档 | 快照按 `(epoch,rev)` 丢弃；pending overlay 合并；不整包覆盖本地 mutation |
| R5 | 任何请求失败都回滚乐观值 | 超时可能服务端已提交，回滚造成两端分叉 | 区分“明确拒绝”和“结果未知”；unknown 强制刷新对账，不盲目回滚 |
| R6 | `window.confirm` 后才 `setBusy`（1861–1866） | 连点会弹多个确认/多个请求；阻塞主线程；焦点/读屏差 | 自定义确认层；打开前同步加锁；strong/once 分级 |
| R7 | 拿到 `body.url` 就 `window.open`（1836） | 进程刚 spawn、适配器未握手，打开的是未就绪页；后面又变红 | 只在 `running + health.ok` 自动开一次；按 taskId 去重 |
| R8 | 生命周期看 `task.status`，健康另算，异常又在三处各算一遍（255–286、2099–2101、2775–2778） | 同一卡不同组件显示不同灯；`provisioning` 被当成 failed；`crashed` 丢失 | 后端 `phase` + `health`；一个纯 selector 出 `tone/bucket/label/actions` |
| R9 | 每个卡片自己 `setInterval` 拉会话（1782–1783） | 7 张卡 7 条流、不同步；扩容后打爆宿主 | 不按卡轮询；会话列表只在展开时拉，30 秒缓存 |
| R10 | 列表 key 用数组下标，或用标题正则判断“临时”（204、224） | 排序/过滤/重命名让卡换身份、折叠错位；标题改成“快速派生”就跳组 | key=`taskId`；分组键固定；临时用 `origin` 字段 |
| R11 | 原地修改数组/Set/任务对象（`sort`、`add`、`task.title=`） | React 不重渲染，或其它组件共享引用被改脏 | 全部不可变更新；派生数据用纯 selector |
| R12 | 用本地 `setTimeout` 把进度判 failed/ready，或客户端时钟判超时 | 服务端还在启动，UI 已红；或反之；时钟偏移导致假状态 | 只看服务端 `phase/health`；客户端只展示“等待中”；stale 由服务端判定 |
| R13 | 轮询 setState 不比较 `rev`，`setInterval` 闭包捕获旧 state，卸载不清 timer | 旧包覆盖新包；重复轮询；卸载后 setState | 单飞 + epoch/rev + AbortController + cleanup；用最新 ref 或函数式更新 |
| R14 | 把 304 当空响应/错误，或根本不发 `If-None-Match` | 列表被清空，或永远传全量；无法做条件刷新 | 304 保留数据只更新时间；发 ETag；手动刷新才强制 200 |
| R15 | `useSyncExternalStore` 的 `getSnapshot` 每次返回新对象，或 `getRecomputeStatus` 浅拷贝不稳定 | 无限重渲染/卡死 | store 缓存快照；只有 `rev` 变化才换引用 |
| R16 | 网络失败把卡片标红“崩溃” | 无证据的红色恐慌；恢复后状态闪回 | 传输失败单独 `offline`，保留最后已知状态；红只给服务端已证实的 crash/failed |
| R17 | 把服务端数据复制进 `useState`，再用 `useEffect` 往回同步 | 每次轮询多一帧旧值；依赖写错会循环 setState；两处真值漂移 | 服务端数据只做 props/store 派生；只有用户草稿进本地 state，用 `key` 重置 |
| R18 | ghost 与真卡按标题/数组下标配对，不按 `opId/taskId` 去重 | 同一分身出现两张卡，或 ghost 绑错真卡；刷新后闪两次 | ghost 键 `opId`，真卡键 `taskId`；202 后绑定，列表按 taskId 去重 |
| R19 | `useMemo` 依赖缺 `rev`，或对原数组 `sort()` 后返回 | 新状态不重算，或旧顺序被原地改；分组/选中错位 | 依赖 `snapshot.panelRev`/相关切片；`slice().sort()` 不可变排序 |
| R20 | 旧请求的 `finally` 清掉新请求的 busy | 新操作进行中但按钮恢复可点，重复提交/双卡 | busy 带 `opId`/递增 token；只允许匹配的请求清自己的状态 |

附加的 mock 卫生规则：

- 不要在 render 中 `Date.now()` 或新建数组/对象作为 props；用 `useMemo`/稳定引用。
- 不要同时维护 `tasks`、`taskCount`、`anomalyCount`、`groups` 四份派生状态；只保留 `tasks + capacity`，其余 selector 计算。
- 不要用 `window.confirm` 做唯一确认；它无法展示服务端 `impact`，也无法在断开后恢复。
- 不要为了“看起来实时”把选中/折叠/编辑态塞进快照或 ETag。

---

## 12. 测试矩阵

### 12.1 状态投影与状态机

| ID | 场景 | 期望 |
|---|---|---|
| A1 | `running + health.ok` | 绿，运行中；open/archive/rename 可用 |
| A2 | `running + health.error` | 红，异常；open 诊断可用，pause 不可用，archive 可用 |
| A3 | `starting + health.pending` | 绿，启动中；open/archive 禁用；不出现红 |
| A4 | `pausing/paused` | 蓝；resume/archive 可用；open 禁用 |
| A5 | `stopping` | 蓝，停止中；全部变更动作禁用；不移除卡 |
| A6 | `completed` | 蓝，已完成；不占槽；archive 可用 |
| A7 | `crashed + exit` | 红，显示 code；retry/archive 可用；不伪造 failed |
| A8 | 非主动退出但无 exit 证据 | `failed(reason=unknown)` 或明确未知；不冒充 crashed |
| A9 | 旧快照 `phaseSeq` 更低 | 整包/该对象更新被丢弃；UI 不回退 |
| A10 | 归档未观察到退出 | 拒绝 archived；返回 stop-failed，容量不释放 |
| A11 | 母体 `paused` / `restarting` / `crashed` | 蓝 / 绿 / 红；传输失败只显示离线，不标崩溃 |
| A12 | 客户端时钟偏移 ±10 分钟 | 红/绿/蓝不发生翻转；stale 由服务端事实决定 |

### 12.2 容量与 7/5

| ID | 场景 | 期望 |
|---|---|---|
| B1 | `slots=7, limit=5, used=5` | `headroom=0`；CTA 禁用；点击零 POST；文案 5/5，槽位 5/7 |
| B2 | `used=4` + `reserved=1` | `headroom=0`；不超卖；显示 1 个受理中 |
| B3 | 5 个 paused | 仍占槽，派生禁用；归档一个后恢复 |
| B4 | 5 个 archived | 不占槽，派生可用 |
| B5 | crashed 且重启已排期 | 计入 `reserved`；不因 crashing 放新任务进来 |
| B6 | `limit=7, used=7` | 满员原因为槽位；与配额满使用不同 code/detail |
| B7 | 3 个并发派生，`limit=2` | 恰好 2 个受理；第 3 个 409 `quota-exceeded`；前 2 个不被误杀 |
| B8 | 同 `opId` 连发 3 次 | 只建 1 个任务，返回同一 taskId |
| B9 | 容量快照 2 周期未更新 | 显示“可能已变”，允许点击，由服务端仲裁 |
| B10 | 还原时原 slot 被占 | 分配最小空闲槽位；无空位则拒绝，不越界 |

### 12.3 派生进度

| ID | 场景 | 期望 |
|---|---|---|
| C1 | 点击派生 300 ms 内 | ghost 出现，带 opId；容量不本地累加 |
| C2 | provisioning→starting→running→ready | 阶段单调；旧阶段不回退；进度条与 phase 一致 |
| C3 | 握手超时 | `running + health.error`，卡变红但可打开/归档；不标 failed/archived |
| C4 | 总预算 20 s 失败 | `failed`，释放预留/端口；ghost 转失败卡，可重试 |
| C5 | 202 后 2 周期未见真卡 | ghost 变“未确认”；不消失、不成功 |
| C6 | 双击/多标签同时派生 | 只产生一个任务；只有一条自动打开 |
| C7 | 满员点击派生 | 零 POST，原因抽屉/提示；不是通用失败 |
| C8 | 派生只拿到 url、未握手 | **不**自动打开；ready 后才打开一次 |
| C9 | 409 带 checks[] | UI 复用同一套容量原因，不显示“派生失败” |

### 12.4 重命名

| ID | 场景 | 期望 |
|---|---|---|
| D1 | 双击进入编辑 | 只选中标题；轮询不覆盖 draft |
| D2 | 保存成功 | 立即显示 draft；ack 后与权威标题一致；pending 清除 |
| D3 | 409 版本冲突 | 保留 draft，显示远端标题和“采用/覆盖”；不静默回滚/覆盖 |
| D4 | 超时但服务端已提交 | 刷新对账后采用服务端标题，不二次提交 |
| D5 | 双击 Enter + blur | 只发一个 mutationId，只 +1 次 titleRev |
| D6 | 重命名中归档 | rename 被拒；清 pending；显示 archived 最终标题 |
| D7 | 两个客户端同时改名 | 一个成功，一个 409；两边最终一致；无丢失更新 |
| D8 | 空/超长/控制字符 | 400 `invalid-title`；回滚并内联提示 |
| D9 | 任务已删除 | 编辑关闭，卡消失，选中收敛；无幽灵详情 |
| D10 | 重命名不影响容量/phase | phaseSeq 不变，slot/used 不变，三色不变 |

### 12.5 归档/删除/选中

| ID | 场景 | 期望 |
|---|---|---|
| E1 | 归档请求发出 | 卡保留为 stopping；不立即移除 |
| E2 | 归档成功 | 移入 archived；释放 used/slot；当前选中清除或转归档 |
| E3 | `stop-failed` | 留在原组，显示进程仍在；容量不变 |
| E4 | 重复归档/两标签归档 | 第二次返回 already/in-progress；两次都收敛，不重复停止 |
| E5 | 删除 archived | strong 确认；移除、清选中、释放引用 |
| E6 | 删除已消失记录 | 404/410 按已删除收敛，不弹惊吓错误 |
| E7 | 其它客户端归档当前选中 | 本端下一快照清选中，不显示 stale 详情 |
| E8 | 其它客户端删除当前选中 | 清选中；焦点到相邻行/空态 |
| E9 | 归档后还原 | 重新 starting；分配槽位；旧标题保留；新 urlEpoch |
| E10 | 归档/删除后列表顺序 | 不移位、不闪回、不重复 key |

### 12.6 母体浮窗

| ID | 场景 | 期望 |
|---|---|---|
| M1 | 点击“打开” | 无确认；只取一次一次性 URL；失败给链接/诊断，不标崩溃 |
| M2 | 点击“暂停”后取消确认 | 零 POST；没有 busy 残留；焦点回到按钮 |
| M3 | 确认暂停后连点 | 打开确认层前已加锁；只发一个 operation；按钮 `aria-busy` |
| M4 | 暂停 202 后收敛 | 只显示“暂停中”；phase 到 paused 才显示“已暂停”；超时不假装成功 |
| M5 | 恢复 | 无确认；busy 到 `running`；失败保留 paused + 原因 |
| M6 | 重启确认 | strong 二次确认；取消零请求；确认后只发一次 |
| M7 | 重启期间断线/重连 | 用 sessionStorage 的 opId 恢复“重启中”；新 epoch 后显示运行/失败；不重复发起 |
| M8 | restart-guard 不可用 | 按钮禁用，原因 `restart-guard-unavailable`；零请求 |
| M9 | 两个客户端同时暂停/重启 | 一个受理，另一个 409 并显示当前 phase；不互相覆盖 |
| M10 | 浮窗动作 busy 时点其它冲突动作 | 只有冲突动作禁用；“打开”不因暂停 busy 被禁用 |

### 12.7 轮询/ETag

| ID | 场景 | 期望 |
|---|---|---|
| F1 | 第二次请求带 If-None-Match | 304；无 body；保留数据引用；无 loading 闪烁 |
| F2 | 手动刷新 | 绕过 ETag 强制 200；在飞时排一次尾随；不并发重复 |
| F3 | 旧 `(epoch,rev)` 晚到 | 整包丢弃，UI 不倒退 |
| F4 | panelEpoch 变化、rev 相同 | 200 全量替换；不误判 304 |
| F5 | 心跳/uptime 改变、语义未变 | 仍 304；不因为漂移字段反复 200 |
| F6 | 重命名/归档成功 | panelRev +1；下一次轮询 200；不出现“操作成功但界面旧” |
| F7 | 页面隐藏 10 分钟 | 0 请求；回前台强制刷新一次 |
| F8 | 连续 3 次失败 | 5/10/20 秒退避 + jitter；成功复位 |
| F9 | 304 到达时列表为空 | 维持原列表；绝不把 304 当空态 |
| F10 | 徽标 + 面板同时打开 | 共享一条快照流；不再 5/10/8 秒三套 |

### 12.8 恶劣网络与并发

| ID | 场景 | 期望 |
|---|---|---|
| G1 | 500 ms 延迟、响应乱序 | 旧包丢弃；最终收敛到最新 rev |
| G2 | 离线 1 小时再上线 | 全量刷新；不重放已成功 mutation；pending 明确显示 |
| G3 | mutation 响应丢失后重试 | 同 mutationId/opId 幂等；不重复改名/归档/派生 |
| G4 | 服务端重启中途 | epoch 变化；ghost 处理为未确认/失败；不假成功 |
| G5 | 两标签同时改名/归档 | CAS/串行仲裁；两边收敛；无丢失更新 |
| G6 | 浏览器时钟与服务器差 10 分钟 | 状态/超时/排序不依赖本地时钟 |
| G7 | 长轮询间隙用户操作 | 乐观 overlay 保留；ack/冲突后清理 |

### 12.9 React 状态不变量

| ID | 场景 | 期望 |
|---|---|---|
| H1 | 列表重排/过滤 | `taskId` key 稳定，选中/编辑不串卡 |
| H2 | 折叠一个组再刷新 | 折叠状态保持；不因空组/重排丢失 |
| H3 | 卸载/隐藏 | timer、fetch、订阅全部清理 |
| H4 | `useSyncExternalStore` | snapshot 引用稳定；不无限重渲染 |
| H5 | 快速双击归档/重启 | 只弹一个确认、只发一个请求 |
| H6 | 删除当前选中 | 焦点落到合理位置；无 stale 详情 |
| H7 | 304 到达 | 不重建列表、不重播落位动画、不闪空态 |
| H8 | 状态派生 | 计数/异常数/分组全部来自一个 selector；无第二份 state |
| H9 | 分组顺序/折叠 | 固定 active→paused→error→archived；折叠按 groupKey 持久化，重排/重命名不丢 |
| H10 | 7 槽位布局 | 槽位由 slotIndex 决定；过滤/分组/归档不改变其它卡的 slotIndex |

---

## 13. 实施顺序与验收

### 13.1 P0：契约与一致性（不做完不应改 UI）

1. 后端任务记录补 `phase/desiredPhase/phaseSeq/rev/titleRev/slotIndex/health/exit/operation`；`taskView` 改为纯投影，不再把 `provisioning` 呈现成 failed。
2. 快照加 `panelEpoch/panelRev/capacity/actions`，加 ETag；`/api/status` 与 `/api/tasks` 统一数据源。
3. 派生改 202 + `opId` + 同步预留；配额计入 starting/reserved；`maxForks` 默认 5、有效上限 7。
4. 重命名路由 + `titleRev` CAS；归档/删除每任务串行 + `mutationId` 幂等。
5. 客户端改用 `PanelSnapshotStore` 单快照；`selectedTaskId`；per-action pending；去掉 URL 即开、全局 busy、双源轮询。

### 13.2 P1：体验与状态收敛

1. 三色投影统一 selector；分组/折叠持久化；7 槽位稳定布局。
2. ghost/进度/自动打开；满员前置与原因抽屉。
3. 归档 stopping、删除 strong 确认、选中/焦点收敛。
4. 母体浮窗三动作（无 API 的按钮禁用 + 原因）。

### 13.3 验收口径

- 满员时点击派生：**零 POST**，仍有可读原因。
- 派生 200 ms 内出现 ghost；500 ms 内出现真实 `starting`，绝不出现红 failed。
- 归档 200 ms 内显示 `stopping`；未观察到退出不得 archived。
- 双击重命名只发 1 次；409 后不丢失本地 draft，也不静默覆盖远端。
- 两个标签页同时改名/归档：最终一致，无丢失更新，无第二个分身。
- 304 不闪空态、不清列表；隐藏 10 分钟 0 请求。
- 所有卡片状态由同一 selector 产出；同一时刻顶栏、组头、卡片的计数/异常数一致。
- 选中项被归档/删除后，详情在下一帧收敛；无 stale 对象。

---

## 14. 证据索引

- 现状 `taskView` 只出 status、`provisioning` 可能被呈现为 failed：`src/plugins/orchestrator.mjs` 330–355。
- 配额只数 running/ready：`src/plugins/orchestrator.mjs` 413–419。
- 归档等待退出确认、但无 stopping 可见态：`src/plugins/orchestrator.mjs` 887–951。
- 状态接口无 ETag、`json()` 使用 no-store：`src/plugins/orchestrator.mjs` 1269–1308。
- `status-store` 的 5s/60s、304 语义与 loading/inFlight 行为：`src/lib/status-store.mjs` 157–182、235–240。
- `status-store` 目前未被面板接入；面板仍是 5s、徽标 10s、镜像 8s 三套节奏：`client.js` 1793–1799、2766–2794。
- 当前 React 面板的双源轮询、全局 busy、选中对象、URL 即开：`client.js` 1631、1668、1737–1779、1836、1861–1866。
- 三处异常计数不一致的风险：`client.js` 2099–2101、2775–2778。
- 旧设计中的六态/ETag/容量公式（本稿与其方向一致，数值与 pause/rename 部分以本稿为准）：`docs/DESIGN-实时状态同步与分支协作-v1.md`。
