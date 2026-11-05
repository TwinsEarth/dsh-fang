# 评审 · 瓮城控制台 HMI 落地（v3.0.6 后端契约 / v3.0.7 UI 验收）

- 评审视角：工业上位机 / HMI（操作安全、告警语义、契约可验证、弱网可恢复）
- 基线：`dsh-fang` 提交 `80bc33a`（v3.0.5 线）；`client.js` 为**未提交工作树**，评审时指纹
  `sha256:F3315114…5BBFD8`、约 2.4k 行、mtime `2026-11-03 03:26`。该文件在评审期间被持续改写
  （729 → 1410 → 2365 → 2397 行），故本文对 client 的证据一律以**函数名/行为**定位，不以行号为准；
  冻结实现前需重新比对一次。
- 对照文档：`docs/UX-三区控制台规格-v1.md`、`docs/STATE-MODEL-瓮城控制台-定稿-v1.md`、
  `docs/REVIEW-三区隔离与快照回流.md`
- 不粘贴源码；字段名即契约。

---

## 0. 结论

**方向对，视觉层已经跑到契约前面。** 现在这套面板可以做“看”，还不能做“信”：

1. **P0 状态不真实**：后端 `taskView` 仍把 `provisioning` 和“进程不在了”一律折成 `failed`
   （`orchestrator.mjs#L330`）。派生 5–20 秒窗口内、归档最长 3 秒窗口内，面板会真实地闪一张红卡。
   这不是样式问题，是 UI 在撒谎。
2. **P0 语义自相矛盾**：`client.js` 的 `TASK_STATUS` 把 `running` 映射成**蓝**、`ready` 映射成**绿**；
   而定稿状态模型规定 **绿 = 进行中（含 running）、蓝 = 非工作（paused/stopping/archived）**。
   两份“权威”不一致，验收脚本会锁死错误映射。
3. **P0 契约缺字段**：无 `phase/exit/health.pending/startedAt/sessionCount/homeBytes`，无
   `panelEpoch/panelRev/ETag`，无 `opId/mutationId/auditId`。面板只能靠标题、时间与 `adapter.ok`
   猜状态，违反“服务端权威、客户端只投影”。
4. **P0 安全等级未分级**：归档（可逆）与永久删除（不可逆）共用同一种确认；归档确认按钮是红色
   `danger`，删除却没有“输入名称/强确认”。危险色同时出现在“疑似僵尸”“归档”“确认”“失败提示”四处。
5. **P1 打开路径仍有假成功**：`openTask` 在 `open-url` 失败后回落到已去 token 的 `task.url`；
   打开的是一个 401 页面，但用户看到的是“已打开”。

**放行条件**：v3.0.6 先冻结契约（本文 §3）并补测试；v3.0.7 只做投影与交互（本文 §4）。
两者不可并行开工——UI 先行的每一行都会在契约落地后返工。

---

## 1. 七维评审

### 1.1 操作安全

| # | 发现 | 证据（行为） | 级别 | 处置 |
|---|---|---|---|---|
| S1 | 永久删除只有一次普通确认，文案写“不可撤销”但交互是一击 | `deleteArchive → askConfirm`（单步） | P0 | v3.0.7 改 strong：输入标题或 taskId 后 6 位；错误时确认键 `aria-disabled` + 原因 |
| S2 | 归档（可逆）与删除（不可逆）同级 | 两者同一 `askConfirm` 组件；归档未传 `tone` | P0 | 确认分级 `none/once/strong`；归档用中性主键，删除才用红 |
| S3 | 归档确认按钮是红色 | `renderConfirmModal`：`tone==='info' ? primary : danger`；归档默认 `bad` | P0 | 归档确认主键改中性/描边；红只留给删除与故障 |
| S4 | `softDisabled` 只做视觉与 `aria-disabled`，仍保留 `onClick` | `button()`/`textAction()`：`onClick: opts.onClick` 未按 `softDisabled` 拦截 | P1 | 组件层统一拦截：`softDisabled` 时 `preventDefault` + 零请求 + 展示 `data-reason` |
| S5 | 确认层不显示对象身份 | 归档/删除文案只有标题 | P1 | 必须带 `title + taskId 短码 + port + sessionCount (+ homeBytes)`，防卡片重排错行 |
| S6 | 确认后先关层再发请求，无同步加锁 | `renderConfirmModal`：`closeModal(); void run()` | P1 | 先置 `pendingOps` 再发；按钮 `aria-busy`，请求终态前不显示成功 |
| S7 | 失败 toast 4.2 秒自动消失 | `notify`：`sticky ? 8000 : 4200` | P1 | 失败必须落卡/落通知区并保留到用户处理；toast 只做“已受理” |
| S8 | 危险色过载 | 红出现在：异常 chip、僵尸提示、归档文字键、归档确认键、删除键、失败通知 | P1 | 见 §4 V 组：健康视图红色元素 ≤2 且全部带 `data-danger` |

**危险色克制规则（建议写进组件契约）**

- 红 = **已证实故障** 或 **不可逆动作**；可逆动作（归档/还原）一律中性或描边。
- 主 CTA 不用红；品牌红只允许出现在 `[data-brand]` 图标内，不参与任何按钮底色。
- 红色背景 wash 只允许出现在确认层内部，不得铺到卡片/区头。
- 健康且无归档行时，界面红色元素应为 **0**。

### 1.2 状态与告警语义

| # | 发现 | 证据 | 级别 | 处置 |
|---|---|---|---|---|
| T1 | `provisioning` 被呈现为 failed（红） | `taskView`：`live` 不存在 → `running=false` → `failed`；`createTask` 在 spawn 前已入表 | P0 | 后端加 `phase`；`provisioning/starting` 绿；旧客户端用 `legacyStatus` |
| T2 | 归档中闪红 | `archiveTask` 等 `stop()` 期间 `live.running=false` → `taskView` 判 failed | P0 | 加 `stopping`（`stopRequestedAt` + 未观察到退出），蓝 |
| T3 | 蓝/绿语义与定稿相反 | `TASK_STATUS.running.tone='info'`、`ready.tone='ok'` | P0 | 按定稿投影：running 绿；paused/stopping/archived 蓝；health 单独徽章 |
| T4 | 第四色 | `provisioning.tone='warn'`（橙） | P1 | 只保留 绿/蓝/红/中性；橙仅用于“配置待重算”这类非运行态（若有） |
| T5 | 适配器未就绪无 pending/error 分档 | `adapterTone` 对 running、failed 取 bad；running 且未握手即红 + “疑似僵尸” | P1 | `health.adapter: pending/ok/error`；pending ≤10s 绿“握手中”，error 才红 |
| T6 | `failed` 与 `crashed` 不分，退出码丢失 | 后端 `taskView` 不透传 `exit`；UI 文案“已停止” | P0 | `exit {kind, code, signal, at}`；文案“已崩溃 · code 1” vs “启动失败 · spawn-timeout” |
| T7 | 离线/未知无表达 | 刷新失败只把 `state:'error'`，保留旧卡；无 `data-freshness` | P0 | 区容器 `data-freshness` ∈ {live, stale, offline}；离线卡片去饱和 + 显示上次成功时间；**不得标红** |
| T8 | 计数多源 | 顶栏读 `status.tasks.*`，分组读 `tasks[]` | P1 | 单一 selector；计数只从快照派生 |
| T9 | 无告警确认模型 | 徽标计数只增不减，故障修复前一直红 | P2 | 稳定 `alarmId`；确认只消音不消状态；状态消失才清除 |

**三色投影（唯一入口，采纳定稿 §2.4 并去掉第四色）**

| 条件 | 色 | 文案 | 备注 |
|---|---|---|---|
| `phase=running` + `health.adapter=ok` | 绿 | 运行中 · 已就绪 | — |
| `phase=running` + `pending`（≤10s） | 绿 | 运行中 · 握手中 | 不算异常 |
| `phase=running` + `error` | 红 | 运行中 · 适配器失联 | 保留打开/归档/重试 |
| `phase ∈ {provisioning,starting,resuming}` | 绿 | 装配中/启动中/继续中 | 不进异常组 |
| `phase ∈ {pausing,paused,stopping,completed,archived}` | 蓝 | 暂停中/已暂停/停止中/已完成/已归档 | 归档单列 |
| `phase ∈ {crashed,failed}` | 红 | 已崩溃/启动失败 + code | 不伪造 |
| 无快照 / 传输失败 | 中性 | 状态未知 · 上次 HH:MM:SS | 绝不红、绝不绿 |

**离线 ≠ 崩溃 ≠ 适配器失联**：前者无证据（中性），后者有服务端证据（红/红）。这是本面板最容易被用户误读的三件事，必须在文案与颜色上同时区分，不能只靠颜色。

### 1.3 后端契约

| # | 发现 | 证据 | 级别 |
|---|---|---|---|
| B1 | 无双源合并快照，无 `panelRev/panelEpoch/ETag` | 面板每次 `GET /status` + `/tasks` + `/sessions`；`json()` 统一 `no-store` | P0 |
| B2 | 派生同步返回，无 202/`opId` | `POST /derive` 等握手完才返回 | P0 |
| B3 | 配额只计 running/ready，不计 starting/reserved | `createTask` 只过滤 RUNNING / READY | P0 |
| B4 | 无重命名路由；当前是本地 alias | 双击标题写 localStorage，服务端无 `titleRev` | P1 |
| B5 | 无分身会话数/体积字段 | `taskView` 只有 pid/port | P1 |
| B6 | `open-url` 有，但客户端有回落 | `openTask` 失败后 `window.open(task.url)`（已去 token） | P0 |
| B7 | 鉴权 token 永久缓存，401 无重引导 | `ensureFangAuthToken` 只取一次 | P0 |
| B8 | 无审计查询；mutation 不返回 `auditId` | 仅写 JSONL ledger | P1 |
| B9 | 元主工作区 CRUD 是“禁用 + title 提示”，无能力位 | `workspace-*-route-missing` 文案 | P1 |
| B10 | 路由数变化未纳入 compat 门禁 | 新增快照路由会改变 `DEFAULT_EXPECTED_ROUTE_COUNT` | P1 |

### 1.4 断线与重连

| # | 发现 | 级别 |
|---|---|---|
| N1 | 固定 5s 轮询，失败不退避、无 jitter | P0 |
| N2 | 无离线/陈旧视觉，失败后旧绿卡继续显示 | P0 |
| N3 | 401/403 与网络错误同处理，不停止轮询 | P1 |
| N4 | 无 epoch 对账，母体重启后旧选中/ghost 可能悬挂 | P1 |
| N5 | 多标签各自 5s × 3 请求，无选主 | P2 |

### 1.5 刷新频率与资源占用

| # | 发现 | 级别 |
|---|---|---|
| R1 | 每次 5s 三个请求；无 304，全量 JSON | P0 |
| R2 | 每次 200 都 `replaceChildren` 重建整棵树，仅靠 `data-fk` 恢复焦点/滚动 | P1 |
| R3 | `tasks/sessions` 只在展开时拉（好），但后端每次读 `workspace.json` 并逐会话解帧取标题（上限 32 帧/1MB） | P1 |
| R4 | 无 `AbortController`，旧响应靠序号丢弃，仍在飞 | P1 |
| R5 | 若把体积放进列表，禁止请求内递归 stat（GB 级 home） | P1 |

**预算（建议写进验收）**：活跃 1 请求/5s；空闲 30s 后 1/60s；动作收敛 1/1s（≤30s）；隐藏 0；单包 ≤64KB；本机 p95 ≤150ms；304 时 0 DOM 重建；空闲 CPU <1%。

### 1.6 审计与操作回显

| # | 发现 | 级别 |
|---|---|---|
| A1 | mutation 无 `opId/mutationId/auditId` 回显 | P0 |
| A2 | 结果只在顶部 notice，失败不落卡 | P1 |
| A3 | “确认”这一决策不入审计 | P1 |
| A4 | 无审计尾部查询，无法回答“谁在何时对谁做了什么” | P1 |

### 1.7 键盘与可重复性

| # | 发现 | 级别 |
|---|---|---|
| K1 | Esc / Tab 陷阱 / 焦点恢复已实现（保留） | 优点 |
| K2 | 删除无 strong，确认层回车即可永久删除 | P0 |
| K3 | 全局 `busy` 字符串阻挡无关操作 | P1 |
| K4 | 无 roving tabindex；7 卡 × 6 控件 ≈ 42 个 Tab 停点 | P2 |
| K5 | 双击重命名与双击图标派生共用双击语义 | P2 |
| K6 | Enter+blur 双提交防护依赖状态位，需验收 | P1 |

---

## 2. v3.0.6 后端契约字段表

> 目标：一次交付可被 UI、徽标、独立门户、e2e 四方共用的契约；不改变用户可见语义的字段不进 ETag。

### 2.1 通用约定

| 项 | 约定 |
|---|---|
| 前缀 | `/fang/api`（保留既有前缀配置） |
| 鉴权 | 除 `/auth-token` 外全部要求 `x-fang-auth`；兼容 `Authorization: Bearer` |
| 写请求 | 必须 `content-type: application/json`；Origin/Sec-Fetch-Site 同源；Host loopback |
| 时间 | 全部 epoch ms，服务端时钟；客户端不得用本地时钟判 stale/超时 |
| 版本 | `schemaVersion`（破坏性 +1）、`panelEpoch`（每次启动 UUID）、`panelRev`（可见语义 +1） |
| 条件请求 | 强 ETag `"<epoch>-<rev>"`；`Cache-Control: no-cache`；`If-None-Match` 命中返回 304 |
| 变更即 bump | 任何 mutation 成功必须 `panelRev+1`，否则下一次条件 GET 可能 304，界面停在旧态 |
| 幂等 | 长操作 `Idempotency-Key`（2 分钟窗口，重放返回同一结果 + `replayed:true`）；重命名用 `baseTitleRev` + `mutationId` |
| 错误信封 | `{ok:false, error, detail?, taskId?, current?, checks?}`，`error` 为稳定码 |
| 审计 | 每个 mutation 返回 `auditId`；`actor/source/target/at/result` 落只追加 ledger |

### 2.2 路由总表

| 方法 | 路径 | 语义 | 成功 | 主要失败 | 幂等 |
|---|---|---|---|---|---|
| GET | `/panel/snapshot` | 唯一读模型（元主+分身+容量+能力） | 200 / 304 | 401/403 | 条件 GET |
| GET | `/tasks/:id` | 单卡详情（动作、会话数、体积、审计尾） | 200 | 404 | — |
| POST | `/tasks/derive` | 派生（异步） | **202** `{opId,taskId,phase}` | 409 `quota-exceeded`/`slot-exhausted`/`port-exhausted` | `Idempotency-Key` |
| PATCH | `/tasks/:id` | 重命名 | 200 `{title,titleRev,rev,panelRev,auditId}` | 409 `version-conflict`/`task-archived`；400 `invalid-title` | `mutationId` + CAS |
| POST | `/tasks/:id/archive` | 归档（停进程、留 home） | 202 `{phase:'stopping',opId}` 或 200 `{already}` | 409 `stop-failed`/`archive-in-progress` | `mutationId` |
| POST | `/tasks/:id/restore` | 还原 | 202 `{phase:'starting'}` | 409 `quota-exceeded`/`not-archived` | `mutationId` |
| POST | `/tasks/:id/delete` | 永久删除存档 | 200 `{deleted:true}` | 409 `not-archived`；404/410 `task-gone` | `mutationId` |
| GET | `/tasks/:id/open-url` | 内存取带 token URL | 200 `{url,issuedAt}` | 409 `not-running`；404 | 不缓存 |
| GET | `/audit` | 审计尾（`since/limit/taskId`） | 200 `{entries[]}` | 401 | — |
| GET | `/capabilities` | 能力位（或并入 snapshot） | 200 | — | — |
| PATCH | `/workspaces/:key` | 元主显示名 alias（fang 自有） | 200 `{alias,aliasRev}` | 409 `version-conflict` | `baseAliasRev` |
| GET | `/auth-token` | 同源 bootstrap | 200 `{token,tokenId}` | 403 `bad-origin` | 不缓存 |

> 兼容：旧 `/status`、`/tasks`、`/derive`、`/tasks/archive…` 保留，但**由同一快照生成**；旧路径不得各自维护计数。

### 2.3 快照信封

| 字段 | 类型 | 级 | 语义 |
|---|---|---|---|
| `schemaVersion` | int | P0 | 契约版本；客户端不认识则只读降级 |
| `panelEpoch` | string | P0 | 母体启动 UUID；变化 = 全量替换 |
| `panelRev` | int | P0 | 同 epoch 单调；旧包整包丢弃 |
| `generatedAt` | int | P0 | 服务端时间；只展示，不参与判定 |
| `mother` | object | P0 | §2.4 |
| `tasks` | object[] | P0 | 活跃 + 归档；服务端稳定序 |
| `capacity` | object | P0 | §2.6 |
| `capabilities` | object | P0 | `{workspace,mma,essence,branch,export}`；`supported:false` 必带 `code` |
| `alarms` | object[] | P1 | `{id,severity,code,taskId,since,message,state}` |

**禁止进信封**：`uptime`、`now`、原始心跳时间、`diskUsageBytes`、请求延迟——会破坏 304。

### 2.4 元主卡（mother）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `"mother"` | 固定 |
| `phase` | enum | starting/running/pausing/paused/resuming/restarting/crashed/failed |
| `desiredPhase` | enum | running/paused/restarting |
| `phaseSeq` | int | 生命周期单调序号 |
| `rev` | int | 对象版本 |
| `health` | `{state: ok / degraded / unreachable, code?, since?}` | degraded 不直接转红 |
| `operation` | `{opId,kind,startedAt}|null` | 跨客户端可见 busy |
| `lastIncident` | `{kind,at,detail}|null` | 下次启动解释红点 |
| `version` | string | 运行中版本（与镜像版本分开） |
| `startedAt` / `phaseChangedAt` | int | 本次启动 / 进入当前 phase |
| `actions` | object | `{open,pause,resume,restart}`，每项 `{enabled,code,detail,confirm,busy}` |

**口径**：母体不能可靠上报自己的死亡；`crashed` 只由 supervisor/unclean-exit 对账提供。传输失败是“离线”，不是“崩溃”。暂停/恢复未实现前必须 `enabled:false, code:'capability-missing'`，UI 隐藏而非画灰键。

### 2.5 分身卡（tasks[]）

| 字段 | 类型 | 级 | 现状 → 目标 |
|---|---|---|---|
| `taskId` / `title` | string | P0 | 已有 |
| `titleRev` | int | P0 | 新增；仅重命名 +1 |
| `phase` | enum | P0 | 新增；见 §1.2 |
| `desiredPhase` | enum | P0 | 新增 |
| `phaseSeq` | int | P0 | 新增 |
| `rev` | int | P0 | 新增 |
| `slotIndex` | int\|null | P1 | 新增（0–6） |
| `origin` | `blank / session / restore` | P1 | 新增；替代标题正则判“临时” |
| `health` | `{adapter: pending / ok / error / n/a, fresh: bool, code?, checkedAt?}` | P0 | 由 `adapter.ok` 升级 |
| `exit` | `{kind: normal / crash / restart-request / killed, code, signal, at}` 或 null | P0 | 新增；崩溃码来源 |
| `pid` / `port` | int\|null | P0 | 已有 |
| `url` / `urlEpoch` | string\|null / int | P1 | 仅展示；打开走 open-url |
| `openable` | bool | P0 | 新增；替代“有 url 就能开” |
| `createdAt` / `startedAt` / `phaseChangedAt` | int | P0 | `startedAt` 新增（时长） |
| `stopRequestedAt` / `stoppedAt` / `archivedAt` | int\|null | P0 | 新增 |
| `archive` | `{homeKept,remote,stopFailedAt?}` | P0 | 新增 |
| `operation` | `{opId,kind,startedAt}|null` | P0 | 新增；长操作 busy |
| `lastError` | `{code,message,at}|null` | P0 | 稳定码 |
| `actions` | object | P0 | `open/rename/pause/resume/archive/restore/delete/retry` |
| `legacyStatus` | string | P0 | 旧客户端兼容，由 phase 派生 |
| `sessionCount` | int | P1 | 新增；目录计数，TTL 30s |
| `sessionCountAt` / `sessionCountState` | int / `fresh / stale / unknown` | P1 | 新增；禁止请求内解帧 |
| `homeBytes` | int\|null | P1 | 新增；后台采样 TTL 60s |
| `homeSizeAt` / `homeSizeState` | int\|null / enum | P1 | 新增；超预算返回 stale |
| `essenceId` / `baseFingerprint` | string\|null | P2 | 三区恢复时再加 |

**体积/会话数硬规则**：不在 GET 请求路径里递归遍历 home；采样器单飞、限时、可中断；拿不到就返回 `null + unknown`，UI 显示“—”，**不得显示 0**。

### 2.6 容量与配额（capacity）

| 字段 | 类型 | 说明 |
|---|---|---|
| `slots` | int | 物理槽位硬上限（定稿 7） |
| `limit` | int | 准入配额（默认 5，1–7） |
| `used` | int | 占用数（starting/running/pausing/paused/resuming/stopping/reserved） |
| `byPhase` | object | 分 phase 计数，解释“为什么满” |
| `headroom` | int | `max(0, limit-used)` |
| `slotFree` | int | `slots-used` |
| `source` | `config / plan` | 决定是否可出现“升级扩容” |
| `capturedAt` / `stale` | int / bool | 服务端新鲜度；2 周期未更新即 stale |
| `checks[]` | array | `{id,ok,code,current,limit,detail,remediation}` |

**配额口径**：`used` 必须包含 `starting` 与 `reserved`；`reserved` TTL 25s，母体重启对账清理。派生/还原 CTA 的禁用只由 `headroom` + `actions.*` 驱动，点击零 POST。

### 2.7 元主工作区（“元主 CRUD”的边界）

| 动作 | 归属 | v3.0.6 结论 | UI 行为 |
|---|---|---|---|
| 新建工作区 | DSH 宿主 | **fang 不实现**（不复制宿主职责） | 隐藏，不画灰键 |
| 归档/删除/下载工作区 | DSH 宿主 | **fang 不实现** | 隐藏 |
| 工作区显示名 alias | fang 自有偏好 | 实现 `PATCH /workspaces/:key`（写 fang dataDir，不碰 `workspace.json`） | 双击重命名；CAS 冲突提示 |
| 分身配额 | fang | `capacity` + 409 `checks[]` | 满员前置禁用 + 原因 |
| 原身（essence）CRUD | fang | 本轮只读 `essence/list`；create/delete 留到三区恢复 | 不渲染 |

> 若产品坚持在 fang 里做工作区 CRUD，那是**宿主契约**，不是本插件契约；否则会出现两套 `workspace.json` 写者。

### 2.8 打开分身（open-url）

| 项 | 约定 |
|---|---|
| 路径 | `GET /tasks/:id/open-url`（保留 query 形式兼容） |
| 成功 | 200 `{ok, taskId, url, issuedAt}`；`Cache-Control: no-store` |
| 失败 | 409 `not-running`；404 `unknown-task`；401 |
| 安全 | URL 只在内存；不落盘、不进列表、不进日志；`noopener` |
| 客户端 | **禁止回落**到 `task.url`；失败即报错并给“重试/诊断” |
| 复制链接 | v3.0.7 暂不提供；若必须，复制 open-url 值并标注“含访问令牌，勿外传” |

### 2.9 鉴权（auth header）

| 项 | 约定 |
|---|---|
| Header | `x-fang-auth: <token>`（兼容 Bearer） |
| Bootstrap | `GET /auth-token`，同源 + loopback + `no-store`；返回 `{token, tokenId}` |
| 401 | `{ok:false,error:'unauthorized'}`；客户端**只重引导一次 + 重试一次** |
| 再 401 | 停止轮询，显示“鉴权失效 · 重新加载面板”，不得无限重试 |
| 轮换 | 母体重启或 token 文件重建后旧 token 失效；页面需重载（写入契约） |
| CSRF | 写请求 JSON + Origin/Sec-Fetch-Site 校验；缺 content-type → 415 |
| SSE | 本轮不引入；若引入，用一次性 ticket，禁止长期 token 进 query |

### 2.10 审计条目

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 只追加 |
| `at` | int | 服务端时间 |
| `kind` | string | `task.archive` / `task.delete` / `task.rename` / `task.derive` / `mother.restart` / `decision.confirm` … |
| `actor` / `source` | string | 当前 `owner` / `panel / cli / mcp` |
| `target` | `{type,id,title}` | 归档前标题要留旧值 |
| `result` | `ok / failed / unknown` | unknown 用于超时 |
| `code` | string\|null | 稳定错误码 |
| `rev` | int | 操作后 `panelRev` |
| `redact` | — | 永不记录 token / 带 token URL / credentials |

### 2.11 错误码（面板必须区分的最小集）

`unauthorized` 401 · `bad-origin`/`bad-host` 403 · `not-found`/`route-missing` 404 · `quota-exceeded`/`slot-exhausted`/`port-exhausted` 409 · `version-conflict` 409 · `invalid-title` 400 · `task-archived`/`task-gone`/`not-archived`/`archive-in-progress`/`stop-failed`/`not-running` 409 · `capability-missing` 409 · `unsupported-media-type` 415 · `too-large` 413 · `rate-limited` 429 · `dependency-unavailable` 503 · `handler-threw` 500。

映射规则：403 说权限，404 说“宿主未提供该接口”，409 说状态冲突，0 说网络；**四者不得互换**。

### 2.12 兼容与迁移

- `maxForks` 默认 8 → 5，有效上限 7；存量 8 启动时收敛并写 `quota.migrated` 审计。
- `/status` 与 `/tasks` 保留但由同一快照生成；`tasks.ready/running/max` 标记 deprecated。
- `legacyStatus` 由 phase 派生，旧面板仍可读；不得反向写 phase。
- compat 门禁的 `DEFAULT_EXPECTED_ROUTE_COUNT` 与必需路由列表随本版更新；否则升级后子插件会被误关。

---

## 3. v3.0.7 UI 验收项

### 3.1 钩子契约（先有钩子，再写 AC）

| 钩子 | 值 | 落点 |
|---|---|---|
| `data-zone` | `header` / `mother` / `derived` | 三块容器（`region`/`header`） |
| `data-btn-id` | `M-01…M-07`、`W-01…W-05`、`C-01…C-08`、`D-01/D-02` | 每个可交互元素 |
| `data-reason` | 与 `aria-describedby` 同 id | 禁用/不可用原因节点（禁止只放 `title`） |
| `data-reason-code` | 稳定错误码 | 同上，供断言 |
| `data-state` | `provisioning/starting/running/pausing/paused/stopping/completed/crashed/failed/archived/unknown` | 状态文本节点 |
| `data-health` | `pending/ok/error/n/a` | 健康徽章 |
| `data-freshness` | `live/stale/offline` | 区容器 |
| `data-confirm-level` | `none/once/strong` | 触发按钮 |
| `data-confirm` | `archive/restore/delete/upgrade/restart` | 对话框根 |
| `data-task` / `data-op` | `taskId` / `opId` | 卡片 / ghost |
| `data-danger` | `1` | 所有使用危险色的元素（便于“克制”断言） |

ID 段沿用旧规格：`M`=母体栏，`W`=元主区，`C`=分身区，`D`=确认层。新增动作先加 ID，再写渲染条件，最后写代码。

### 3.2 验收表

> 断言只认属性，不认中文文案；网络断言指 DevTools 过滤 `fang/api` 的计数。

#### A. 操作安全

| ID | 前置 | 操作 | 期望 |
|---|---|---|---|
| AC7-S1 | 已归档卡 | 点 `C-05` 永久删除 | 弹出 `data-confirm-level="strong"`；未输入标题时 `D-01` `aria-disabled` 且有 `[data-reason="C-05"]`；输入正确后仅 1 次 POST |
| AC7-S2 | 运行中卡 | 点 `C-03` 归档 | 确认层显示 title + taskId 短码 + port + 会话数；确认后仅 1 次 POST；Esc 关闭时 0 POST |
| AC7-S3 | 健康面板 | 打开面板 | 红色元素 ≤2 且全部 `[data-danger]`；无归档行时为 0；`E-02/派生` 主键非红 |
| AC7-S4 | 任一 `aria-disabled="true"` 控件 | 点击 + 回车 | 0 请求；焦点不丢；原因节点可见且 `aria-describedby` 指向它 |
| AC7-S5 | `capabilities.workspace.create=false` | 打开元主区 | DOM 无 `W-01`（不是禁用）；全 DOM 搜“新建元主/删除元主”无按钮 |
| AC7-S6 | 服务端 500 | 归档 | 错误留在卡上（`data-task` 定位）且不自动消失；无成功通知 |

#### B. 状态与告警语义

| ID | 前置 | 操作 | 期望 |
|---|---|---|---|
| AC7-T1 | 无任务 | 派生 | 500ms 内 `data-state` ∈ {provisioning,starting}；全程无 `failed`；无红色 |
| AC7-T2 | 归档中的卡 | 观察 3s | `data-state="stopping"` 且为蓝；不闪 `failed`；卡不移除 |
| AC7-T3 | 握手未完成 | 观察 ≤10s | `data-health="pending"`、绿；超时后 `error`、红、文案“适配器失联” |
| AC7-T4 | 崩溃 fixture | 打开 | `data-state="crashed"`；显示 exit code；与 `failed` 文案可区分 |
| AC7-T5 | 停止服务端 | 观察 1 个周期 | 区 `data-freshness="offline"`；卡片去饱和；显示“上次成功 HH:MM:SS”；无 `crashed` |
| AC7-T6 | 快照延迟 2 周期 | 观察 | `data-freshness="stale"`；CTA 可点但提示“状态可能已变” |
| AC7-T7 | 有异常卡 | 打开 | 顶栏异常数 = 异常组卡数（同一 selector 来源） |
| AC7-T8 | 任意 | 全 DOM | `data-state` 的颜色映射仅 {绿,蓝,红,中性}；无橙色状态 |

#### C. 契约落地

| ID | 前置 | 操作 | 期望 |
|---|---|---|---|
| AC7-B1 | 运行中卡 | 双击标题改名 | 1 次 `PATCH` 带 `baseTitleRev`；成功后标题更新；409 显示“已被改为 X”+采用/覆盖 |
| AC7-B2 | 有会话/体积 | 打开卡 | 显示 `sessionCount` 与 `homeBytes`；`homeSizeState!='fresh'` 时显示“—”或“约”，不显示 0 |
| AC7-B3 | 运行中 | 点 `C-01` 打开 | 1 次 `GET open-url`；`window.open` 使用返回 URL；409 时只报错，**无回落** |
| AC7-B4 | 任意 | 抓包 | 除 `/auth-token` 外所有请求带 `x-fang-auth`；每页 bootstrap 1 次 |
| AC7-B5 | `limit=5, used=5` | 点派生 | `aria-disabled`；0 POST；原因含 `5/5` 与出口 |
| AC7-B6 | 归档成功 | 下一次轮询 | 200（非 304），`panelRev` 前进；标题/状态即更新 |
| AC7-B7 | 无变化 | 下一次轮询 | 304；列表节点引用不变（无重建）；无 loading 闪烁 |

#### D. 断线重连

| ID | 前置 | 操作 | 期望 |
|---|---|---|---|
| AC7-N1 | 面板打开 | 杀母体再启动 | 自动恢复 ≤30s；横幅清除；无重复卡；选中项按 epoch 收敛 |
| AC7-N2 | 面板打开 | 轮换 token | 401 → 1 次重引导 + 1 次重试；仍 401 则停轮询并给“重新加载” |
| AC7-N3 | 面板打开 | 切后台 60s | 0 请求；回前台立即 1 次 |
| AC7-N4 | 断网 3 次 | 恢复 | 退避 5/10/20(+jitter)；成功后复位为 5s |
| AC7-N5 | 母体重启 | 观察 | `panelEpoch` 变化→全量替换；旧 ghost 转“未确认”，不假成功 |

#### E. 刷新与资源

| ID | 前置 | 操作 | 期望 |
|---|---|---|---|
| AC7-P1 | 5 个分身、面板可见 | 观察 30s | 仅 `GET /panel/snapshot`，约 6 次；无 `/tasks/sessions` 轮询 |
| AC7-P2 | 同上 | 看 Network | 单包 ≤64KB；304 时无 body；p95 ≤150ms（本机） |
| AC7-P3 | 同上 | Performance 60s | 空闲 CPU <1%；无每卡 timer；无 DOM 重建（304） |
| AC7-P4 | 展开一张卡 | 观察 30s | 会话仅按需拉取；30s 内不重复；收起后停止 |
| AC7-P5 | 卸载面板 | 观察 | timer/fetch/订阅全部清理；无控制台报错 |

#### F. 审计与回显

| ID | 前置 | 操作 | 期望 |
|---|---|---|---|
| AC7-A1 | 归档成功 | 看响应/审计 | 返回 `opId/auditId`；审计尾有 `task.archive` 条目；界面显示“已记录审计” |
| AC7-A2 | 归档失败 | 看卡 | 卡内错误 + code + 重试；审计为 `failed`；无顶部假成功 |
| AC7-A3 | 打开删除确认 | 取消 | 审计有 `decision.confirm`（取消）且 0 mutation |
| AC7-A4 | 长操作 | 观察 | 按钮 `aria-busy`；“已受理”≠“已完成”；终态才成功 |

#### G. 键盘与可重复

| ID | 前置 | 操作 | 期望 |
|---|---|---|---|
| AC7-K1 | 面板 | Tab 顺序 | header → 元主 → 分身；对话框内闭环 |
| AC7-K2 | 确认层 | Esc / 取消 | 关闭且 0 请求；焦点回到触发键 |
| AC7-K3 | 删除确认 | 打开 | 初始焦点在“取消”；确认键需移动焦点后才可回车 |
| AC7-K4 | 改名 | Enter + blur 快速 | 仅 1 次 mutation、`titleRev` 仅 +1 |
| AC7-K5 | 归档 | 双击确认键 | 仅 1 次 POST（幂等键兜底） |
| AC7-K6 | 任意 | 按键扫描 | 无单键删除/归档快捷键；无全局破坏性热键 |

#### H. 色彩与无障碍

| ID | 前置 | 操作 | 期望 |
|---|---|---|---|
| AC7-V1 | 任意 | 对比度实测 | 正文 ≥4.5:1；状态 chip ≥3:1；焦点环 ≥3:1 |
| AC7-V2 | 任意 | 色盲模拟 | 每个状态 chip 有文字；不靠颜色单独承载 |
| AC7-V3 | 任意 | `prefers-reduced-motion` | 无脉冲/位移；告警不闪烁 |

### 3.3 判定口径

- “零请求”= 过滤 `fang/api` 后计数 0；“DOM 不存在”= `querySelector` 为 null，不是 `disabled`。
- 所有失败态必须同时断言：`data-reason-code`、可见原因文本、审计 `result`。
- 每个 P0 按钮至少被一条 AC 覆盖；没有 AC 的按钮不允许合并。

---

## 4. React mock → 零构建 `client.js` 的移植风险

> 目标文件是 `window.__ModuleLoader__.load({id, factory(require)})` 的单文件模块：无 JSX、无打包、
> 无 CSS 文件、无第三方 UI 库；React 只作为插槽返回值的外壳。mock 里的“写法”本身不是问题，
> 问题是它们**依赖构建期或 React 运行时**，移植后不会报错，会静默变形。

| # | 风险 | 机制 | 症状 | 处置 |
|---|---|---|---|---|
| M1 | JSX 语义丢失 | JSX → `h()`：`false/null/0` 子节点、数组 key、Fragment、展开属性 | 少渲染/多渲染、key 警告、属性名错（`class` vs `className`） | 统一 `h()` 工具函数；禁止条件里直接放数字；每个列表显式 key |
| M2 | 类型检查消失 | TS/PropTypes 不参与运行 | 契约字段拼错 → `undefined` 被当成“未就绪/成功” | 运行时字段守卫 + 契约测试；关键字段缺失即 `unknown` |
| M3 | 依赖不可解析 | 无 bundler，`require` 只有宿主模块 | 引入 Radix/lucide/tailwind/framer 直接运行时报错 | 只用宿主 react；图标内联 SVG；样式内联或注入 `<style>` |
| M4 | CSS 作用域污染 | 无 CSS Modules；类名全局 | `.btn`/`.card` 命中宿主样式或反之 | 全部前缀 `fang-`/`f-`；避免裸标签选择器；宿主 token 优先 |
| M5 | 状态模型换了 | React `useState/useEffect` → 可变 store + 全量重渲染 | 定时器/焦点/滚动/输入法需手工恢复；stale closure | 统一 `render()` + `data-fk` 恢复；编辑中挂起刷新；requestAnimationFrame 合帧 |
| M6 | 合成事件变原生 | `onChange` vs `oninput`、受控输入、IME composition | 中文改名丢字/重复提交 | 用 `oninput`；处理 `compositionstart/end`；Enter+blur 单飞锁 |
| M7 | 生命周期消失 | 无 `useEffect` cleanup | 卸载后 setState/定时器泄漏、重复轮询 | 显式 `destroy()`：timer、fetch、订阅、DOM 全清 |
| M8 | Portal 变树内浮层 | mock 常用 portal + fixed overlay | 宿主容器 `transform/overflow` 导致裁切/错位 | 浮层挂在面板根内；`position:fixed` 前先确认祖先无 transform；必要时锁 body 滚动 |
| M9 | 数据层是假的 | mock 静态数组/延时 | 无鉴权、无 401、无 ETag、无 stale、无并发 | 统一 `api()`：token、401 重引导、Abort、304、错误码映射 |
| M10 | 乐观更新过头 | mock 点即改 | 归档失败后卡片已消失；派生未握手就绿 | 只乐观标题；phase/容量等权威快照；失败原地回滚并给原因 |
| M11 | 性能假设失效 | mock 3 张卡；真实 7 卡 + 100 会话 | 每 5s 全树重建、布局抖动、CPU 飙高 | 304 不重建；分组/排序 memo；会话按需；长列表分页 |
| M12 | 测试选择器失效 | mock 用文案/类名断言 | e2e 找不到按钮；改文案即挂 | 先落 `data-btn-id/data-reason/data-state`，再写 AC |
| M13 | 安全回退 | mock 可能 `innerHTML` 渲染标题 | 标题注入 HTML | 只用文本节点；URL 只经 open-url；`noopener` |
| M14 | 双实现漂移 | mock 与 client 各改一版 | 视觉/交互对不上，验收基准不明 | mock 冻结为设计参考，不再演进；以 AC + 钩子为准 |

**建议的移植顺序**：钩子与契约 → 状态投影 → 确认分级 → 轮询/ETag → 键盘/焦点 → 视觉打磨。反过来做（先视觉）会把上面每一条都推迟到“看起来完成了”之后才暴露。

---

## 5. 落地顺序与门禁

| 阶段 | 内容 | 完成判定 |
|---|---|---|
| v3.0.6-a | 快照 + rev/epoch/ETag + 单源 | 同 rev 304；mutation 后 200；旧 `/status` 与新快照计数一致 |
| v3.0.6-b | phase/health/exit/operation + 202 派生 + 配额 | 派生 200ms 内 starting；归档 200ms 内 stopping；并发不超卖 |
| v3.0.6-c | 重命名 CAS + 幂等 + 审计 + open-url 收紧 + 401 语义 | 双击 1 次；409 带 current；审计可查；open-url 无回落 |
| v3.0.6-d | 会话数/体积 TTL 采样 | 请求内 0 递归 stat；stale 有标记 |
| v3.0.7-a | 钩子 + 三色投影 + 确认分级 | AC7-S/T 全绿 |
| v3.0.7-b | 断线/退避/陈旧 + 审计回显 | AC7-N/A 全绿 |
| v3.0.7-c | 键盘/焦点/对比度 + 性能 | AC7-K/V/P 全绿 |

**发布门禁**：后端契约测试（字段存在性/枚举/ETag/幂等/配额/鉴权/审计）先行；UI 验收脚本只认属性；
任何“没有 AC 的按钮”不得进主分支。

---

## 6. 证据索引

- `taskView` 折叠 failed / 丢 exit：`src/plugins/orchestrator.mjs#L330`
- 配额只计 running/ready：`src/plugins/orchestrator.mjs#L413`
- 归档等退出但无 stopping：`src/plugins/orchestrator.mjs#L887`
- `status()` 计数与 max：`src/plugins/orchestrator.mjs#L1053`
- JSON 统一 `no-store`：`src/plugins/orchestrator.mjs#L1270`
- open-url 实现：`src/plugins/orchestrator.mjs#L1320`、`src/plugins/forker.mjs#L1212`
- 鉴权头与 401：`src/lib/http-auth.mjs#L10`
- `publicFork` 已有 startedAt/exitedAt/exit：`src/plugins/forker.mjs#L451`
- `status-store` 的 5s/60s 与 304：`src/lib/status-store.mjs`
- 面板：`client.js`（工作树指纹见文首）中的 `taskHealth`、`refresh`、`startPolling`、`archiveTask`、
  `deleteArchive`、`askConfirm`、`renderConfirmModal`、`button/textAction`、`openTask`、`render`
