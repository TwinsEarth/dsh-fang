# 评审：瓮城三区改造（总控 / 工厂 / 车间）与「快照回流」

- 评审对象：`client.js`（面板 UI）、`src/lib/status-store.mjs`（MirrorStatusStore）、`src/lib/mirror.mjs`（镜像层）；对照 `src/plugins/orchestrator.mjs`、`src/plugins/forker.mjs`、`src/lib/essence.mjs`、`src/lib/upgrade-coordinator.mjs`、`src/lib/preferences.mjs`。
- 版本基线：package.json `3.0.4`，client 面板 `3.0.1` 代际（八秒镜像卡 / 五秒面板轮询 / 十秒徽标）。
- 结论口径：**方向成立，前提不成立。** 按「层」分区与项目自身的数据模型（镜像 → 原身 → 分身）完全一致，是这份 UI 最该做的一次重构；但三区要求的状态机、原身层的 HTTP 面、以及"实时"所需的快照契约，今天都不存在。**先修契约（P0，约 1.5 人日），再动布局**，否则新 UI 只是把旧语义画得更漂亮。

---

## 0. 评审门槛：动工前必须先修掉的 6 件事

| # | 前提 | 现状（证据） | 不修的后果 |
|---|---|---|---|
| G1 | 分身状态机要有 `starting` | `taskView()` 用「进程不再跑就判 failed」，而派生中的任务在 forker 里还没有记录，`forker.status()` 对未知 id 返回 `{running:false, error:'not-found'}` → 派生全程被呈现为 **failed**（`src/plugins/orchestrator.mjs:302-306`、`src/plugins/forker.mjs:1135-1140`） | 新 UI 的"启动中"灯永远是假的；派生窗口最长 ≈ provision + spawn + 握手（`adapterTimeoutMs` 10s）期间显示红卡"已停止" |
| G2 | 配额必须计入"派生中" | `createTask` 只数 `running` / `ready`（`orchestrator.mjs:385-391`），而派生中的任务因 G1 被派生成 failed ⇒ 不计入 | 并发派生可越过 `maxForks`（"满员禁用"会漏判，最后变成 forker 的 `max-forks` 报错，用户看到的是"请求失败"） |
| G3 | 归档要有 `stopping` 可见态 | `archiveTask` 同步等 `f.stop()` + 轮询最长 `archiveStopTimeoutMs`=3s，中途 forker 记录已 `running:false`（`orchestrator.mjs:859-899`、`forker.mjs:858-868`） | 归档期间卡片会**闪一下 failed**；其它标签页完全看不到"正在停止" |
| G4 | `taskView` 必须带运行时长与退出信息 | forker 的 `publicFork` 有 `startedAt / exitedAt / exit / lastError`（`forker.mjs:410-429`），但 `taskView` 只透传 `pid/port/url` | 车间卡要的"运行时长 / PID / 崩溃码"没有权威来源，只能前端猜 |
| G5 | 任务必须关联"原身" | `createTask` 只用 `templateDir()`，任务记录里**没有** `essenceId / baseFingerprint`（`orchestrator.mjs:397-422`；`normalizeTask` 只存 `template` 路径，`:176-195`） | 工厂卡无法回答"哪些车间是从我这里派生的"，回流也没有 merge base |
| G6 | 快照要有 `rev` 与容量 | `/fang/api/status`、`/api/tasks` 无 ETag、`cache-control: no-store`（`orchestrator.mjs:1241-1268`）；只有 `/api/mirror/status` 有 ETag（`src/lib/mirror-etag.mjs`） | 无法做陈旧响应丢弃、无法做跨区联动去抖，三处 UI 各自轮询必然漂移 |

> 说明：G1/G2/G3 是**同一个语义空洞**的三个表现（生命周期状态被"failed"吞掉）。修一次 `taskView` + 一个 `starting/stopping` 标志，三处一起好。

---

## 1. 评审基线：现状到底是什么

### 1.1 三个文件的实际职责

| 文件 | 实际职责 | 与三区的关系 |
|---|---|---|
| `client.js` | React client-half：侧栏图标、`main` 面板、输入框徽标；面板内 3:7 两栏（左=母体会话、右=分身任务卡），5s 轮询 + 每任务 N+1 会话请求（`client.js:1772-1779`、`1764-1765`） | **按"实体"分区，不是按"层"分区**。左栏是母体的会话，与"原身"无关；原身在 UI 里完全不存在 |
| `src/lib/status-store.mjs` | 单资源外部 store：`{status, loading, error, lastUpdatedAt}`，订阅计数、active/idle 双档（5s/60s）、`acquireActive` 引用计数 + 30s 空闲降级、`pokeActive`、`onIdleDowngraded`、304 只更新 `lastUpdatedAt` | **未被 client.js 使用**。面板 5s、镜像卡 8s、徽标 10s 各自 `setInterval`（`client.js:1776`、`803`、`2763`），`/api/mirror/preferences` 根本没人读 |
| `src/lib/mirror.mjs` | 镜像（只读基础层）：备份/恢复/升级、staging 原子替换、失败回滚、`onProgress(stage)` 七阶段 | 只覆盖"母体镜像"这一层；没有原身，也没有回流出口 |

### 1.2 现状布局（可直接沿用/必须改）

- 根容器：`padding 18/22/14`、`gap 12`、`overflow hidden`（`client.js:2610-2618`）。
- 分栏：`grid-template-columns: minmax(0,3fr) minmax(0,7fr)`，`≤980px` 单列堆叠（`client.js:2619-2621`）。
- 顶栏：Logo 32×32 + 标题 19px + 状态胶囊条（母体只读 / 就绪 x/max / 运行中 n）+ 6 个操作（读档、临时、刷新、镜像、连接、母体打开）+ 派生 CTA（`client.js:2149-2209`）。
- 右栏卡：标题 15px + 两枚 Pill（生命周期 / 适配器健康）+ taskId 短码 + 端口 + 创建时间 + 打开/归档；下方可折叠"分身会话"（`client.js:1509-1590`）。
- **已经是好东西、不要推翻**：生命周期色与健康色分离（`taskHealth`, `client.js:255-286`）、两栏独立滚动、错误可读可重试、`aliveRef + seqRef` 的陈旧响应丢弃模式、`useMediaQuery` 断点、`Esc/Enter` 键盘路径。

### 1.3 直接影响本方案的行为缺陷（除 G1–G6 外）

| # | 缺陷 | 证据 | 影响 |
|---|---|---|---|
| F7 | 派生是同步长请求：`POST /api/derive` 直到握手结束才返回 | `orchestrator.mjs:1301-1305` → `createTask` 内 `await provision/spawn/handshake` | 拿不到 taskId 就无法做进度条与落位，只能本地乐观卡；双击派生期间面板"派生中…"最长挂 10s+ |
| F8 | 无幂等键：`/api/derive` 无 `Idempotency-Key`；`quickDerive` 的 2s 冷却只是模块内单飞 | `client.js:425-459` | 两个标签页（React 面板 + `/fang/panel` 独立门户）各双击一次 = **两个分身**。归档倒是幂等的（`already:true`，`orchestrator.mjs:864-866`），派生不是 |
| F9 | 面板默认展开所有分身的会话 → 每 5s 对每个活跃任务打一次 `tasks/sessions` | `collapsedTasks` 初值空 Set（`client.js:1616`）+ `1764-1765` | 8 个分身时 ≈ 2.4 rps 的目录扫描；每张卡的会话列表都在默认渲染中 |
| F10 | 同一事实三处各算一遍："异常数"在 `taskHealth`、顶栏（`2070-2072`）、徽标（`2746-2749`）各有一套近似逻辑 | `client.js` 上述三处 | 三区联动表做不了"单一真相"；两处口径已不一致（一处用 `tasks.list`，一处回退到计数） |
| F11 | `/fang/api/status` 已经返回完整 `tasks.list`，面板又额外拉 `/api/tasks` | `orchestrator.mjs:1025-1037` + `1268-1269` | 每次轮询 2 份任务列表；两份来源漂移就是联动 bug 的温床 |
| F12 | 独立门户 `/fang/panel` 是第二套 UI（服务端内联 HTML 表格：任务/状态/Adapter/端口/PID/操作） | `orchestrator.mjs:1264-1267`、`1424+` | 三区改造若只做 React 面板，门户必然漂移；它是"面板不可用时的兜底入口"，不能删 |
| F13 | `mirror.getStatus()` 的 `activeEssenceCount` 被硬编码为 `0` | `orchestrator.mjs:1121-1126` | 总控要显示"工厂 n 个原身"时，现有字段是假的 |
| F14 | 原身层只有一条 HTTP 路由（`GET /api/essence/list`，且只返回 meta，无插件数/配置版本） | `orchestrator.mjs:1394`、`1151-1155`；`essence.mjs:419-430` | "工厂卡显示插件数/配置版本"**没有数据源**；"设置/克隆"两个动作**没有 API** |

---

## 2. 三区模型：把 UX 诉求落成三条不变量

### 2.1 地址空间（沿用项目自己的三层定义，见 `docs/ESSENCE.md`）

```
镜像 mirror   <mirrorRoot>/active         只读基础层（DSH 版本 + 基础插件集）   ← 总控（母体）唯一可写动作：升级/回退/备份
原身 essence  <essencesRoot>/<id>/overlay 可写覆盖层（patch/settings/credentials）← 工厂（原身）唯一可写动作：派生/设置/克隆
分身 fork     <forksRoot>/<taskId>        运行时临时实例（不落配置，只持久化数据）← 车间（分身）唯一可写动作：打开/归档/下载
```

### 2.2 三条不变量（评审建议写进产品契约）

- **I1 动作面互斥**：工厂卡上不出现任何"停止/归档/删除运行时"的动作；车间卡上不出现任何"改配置"的动作。跨层只能走一条受控通道（回流），且必须在总控可见。
- **I2 数据面分层**：车壳（配置）可回流；黑匣子（会话/缓冲/日志/端口账本）**永不回流**，只能归档冻结或导出。"归档"不是"删除"，也不是"备份到工厂"——三个概念必须分开命名。
- **I3 状态单向**：权威状态由母体进程写；客户端只读、只派生视图，不回写状态。卡上的局部态（`归档中…`、`派生中…`）必须能被权威状态覆盖并对账，超时即撤下。

### 2.3 三个必须点破的模型风险

1. **"总控 = 母体"会让人以为总控能改镜像。** 总控实际是三件事：镜像版本与健康、全局容量（车间 x/max、端口池）、唯一主操作入口。镜像的写操作（升级/备份）应保持现在的独立弹层（`MirrorSettingsCard`），并在入口上明写"改的是**镜像**，不是原身"。
2. **工厂 ≠ 单卡。** `EssenceManager` 本来就支持多原身 + 两级子原身（父/子，`essence.mjs:483-497`）。若产品只要"一个原身卡"，就把"列表"降级为单卡 + 展开抽屉；但数据模型不必砍。
3. **六个动作里三个没有 API。** 工厂的"设置/克隆"、车间的"下载"今天都没有路由（克隆的 manager 能力存在但未接 HTTP）。**不要上线死按钮**：先占位禁用并在 tooltip 写明"待 P2"，否则这是最容易被用户判定为"假功能"的一类 UI。

---

## 3. 布局规格

### 3.1 线框（桌面 ≥1200px）

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 瓮城  ▸ 母体 v3.0.4 · 镜像 3.0.4   ●母体 ●工厂 ●车间   车间 3/8 · 端口 18042  │ 56px 固定，不滚动
│                                    工厂 2 个原身 · 1 冲突      [+ 派生新分身]  │
├───────────────────────────────┬──────────────────────────────────────────────┤
│ 工厂 · 原身 (2)               │ 车间 · 分身 (3)                    3 项目    │ 区头 44px
│ 基于镜像 v3.0.4 的覆盖层       │ 运行 2 · 启动 1 · 异常 0                     │
├───────────────────────────────┼──────────────────────────────────────────────┤
│ ┌───────────────────────────┐ │ ┌──────────────────────────────────────────┐ │
│ │ ● 开发者推荐（官方）  VIP100│ │ │ ● 修复路由守卫           运行中 00:42:17 │ │
│ │ 插件 14 · 配置 a3f9c1d 锁 │ │ │ 端口 18042 · PID 21488 · 适配器就绪       │ │
│ │ [派生] [设置] [克隆]      │ │ │ [打开] [归档] [下载]                     │ │
│ └───────────────────────────┘ │ └──────────────────────────────────────────┘ │
│ ┌───────────────────────────┐ │ ┌──────────────────────────────────────────┐ │
│ │ ● 我的实验台    VIP10 冲突1│ │ │ ◐ 空白实验               启动中 · 握手…   │ │
│ │ 插件 6 · 配置 7d2b40e     │ │ │ 端口 18043 · PID 21502 · 适配器未就绪     │ │
│ │ [派生] [设置] [克隆]      │ │ │ [打开] [归档] [下载]                     │ │
│ └───────────────────────────┘ │ └──────────────────────────────────────────┘ │
│                               │ ┌──────────────────────────────────────────┐ │
│ ┌ 归档 / 备份（折叠）        ┐ │ │ ○ 旧实验               已归档 · 3 天前     │ │
│ │ restore/ 2 · backup/ 7     │ │ │ home 保留 1.2 GB                          │ │
│ └───────────────────────────┘ │ │ [还原] [下载] [删除]                      │ │
│                               │ └──────────────────────────────────────────┘ │
└───────────────────────────────┴──────────────────────────────────────────────┘
        30% (min 280 / max 400)                70% (min 520)
```

### 3.2 尺寸与栅格

| 项 | 规格 | 备注 |
|---|---|---|
| 根容器 | `padding 16 20 16 20`，`gap 12`，`height 100%`，`overflow hidden` | 沿用现容器，微调内边距 |
| 总控条 | 高 56（单行）/ 88（两行，宽度 <1200 时折行）；`flex-shrink:0`；底部 1px 分隔 | 不随内容区滚动 |
| 三区分栏 | `grid-template-columns: minmax(280px, 30%) minmax(520px, 1fr)`；`gap 16` | 比现在的 3:7 更"硬"，符合工厂窄/车间宽 |
| 区头 | 44px：标题 13px/600 + 计数 Tag + 副标题 11px；右侧 1 个区内操作 | 与卡区之间 1px 分隔 |
| 原身卡 | 高 96–112；圆角 10；左 3px 状态条（颜色=灯） | 两行信息，动作条贴底 |
| 分身卡 | 高 112–132；圆角 10；左 3px 状态条 | 三行：标题态 / 指标 / 动作 |
| 状态灯 | 8px 圆点 + 12px 文本；**灯永不单独存在**（色盲安全） | 复用现有 `TONE` 与宿主 token |
| 断点 | ≥1280 三区并排；1024–1279 工厂 280 + 车间弹性；≤980 单列堆叠（总控 sticky，工厂 `max-height 44vh`，车间 `56vh`，各自滚动）；≤640 动作收进 `⋯` | 沿用现有 980 断点，避免再引入一档 |
| 焦点/键盘 | 三区各一个 `role="region"` + `aria-label`；Tab 顺序：总控 → 工厂 → 车间；卡片是 `article` + 首个可聚焦动作；`Esc` 取消选中 | 沿用现有 `focus-visible` 等效环样式 |
| 动效 | 落位见 3.4；所有动效 `prefers-reduced-motion` 下降为 120ms 透明度 | — |

### 3.3 卡规格（动作面互斥的落地）

**原身卡（工厂）** — 信息：名称 + tier + 锁定/官方标；插件数；配置版本（`lastMergedFingerprint` 前 7 位）；状态（ready / conflicted / stale）；冲突数；派生出的分身数（P2）。动作**只有**：`派生`（主）/`设置`/`克隆`。
- `设置`、`克隆` 在 P2 前**渲染为禁用**，tooltip："原身覆盖层编辑接口未上线（P2）"。
- 工厂卡**不可拖拽排序**、**不可内联编辑**——避免暗示它是运行时目录。

**分身卡（车间）** — 信息：标题；生命周期灯 + 文本；运行时长（`now - startedAt`，1s 刷新只影响这一行，不重渲染整卡）；端口；PID；适配器健康（第二枚 Pill，与现在一致）；来源原身（P2）。动作**只有**：`打开`（无 url 时禁用）/`归档`/`下载`（P2 前禁用，tooltip 同前）。
- 归档：二次确认（保留现在的 `window.confirm` 文案，但补一句"运行中的未保存内容会随进程停止丢失；会话已持久化"）。
- 车间卡**不可内联改配置**；要改配置只能回工厂 → 或走回流（P2）。

**归档行（车间下部折叠区，替代现在独立的"读档"整页）**：`还原 / 下载 / 删除`，删除二次确认并显示 home 体积。

### 3.4 派生过程：进度与落位动画

**进度（4 段，每段最多 3s 的不定态）**

| 段 | 触发 | 文案 | 时长预算 |
|---|---|---|---|
| 受理 | 本地点击 → 收到 `taskId` | 正在受理… | ≤300ms |
| 装配 | 服务端 `provisioning` | 装配 profile… | ≤3s |
| 启动 | 进程 spawn，端口/PID 出现 | 启动进程 · 端口 18043 | ≤5s |
| 握手 | `adapter` 轮询 | 等待适配器握手… | ≤10s |
| 就绪 | `ready` | 已就绪 | — |

- 超总预算（建议 20s）→ 标 `failed · reason=timeout`，**释放槽位**，卡片保留并给"重试/归档"。
- 禁止"假成功"：未收到 `ready` 前不得把卡变绿、不得自动打开窗口（现在的 `startDerive` 在 `body.url` 存在时就 `window.open`，而 `url` 在 spawn 后即有、握手前就有 url —— 会打开一个尚未就绪的分身）。
- 自动打开的规则改为**「就绪后触发一次」**：每个 `taskId` 只允许自动开一次标签页（本地 Set 记已开），且只在用户点了派生（而非后台轮询发现新任务）时触发；派生改为 202 后服务端不再返回 `url`，这条规则必须由客户端持有。

**落位（ghost → real 对账）**

1. 点击即插入一张 **ghost 卡**（骨架 + `opId`），位置在车间列表顶部，`aria-busy`。
2. 服务端返回 `taskId` 后，把 ghost 与 `taskId` 绑定。
3. 快照里出现该 `taskId` → ghost 换成真卡：高度 96→实际高度的 200ms 过渡 + 一次 1.2s 高亮描边（用 `taskId` 记「已播放」，避免每次轮询重播）。
4. **连续 2 个快照周期未见** → ghost 变"未确认"卡：文案"未能确认派生结果，请刷新"，给刷新/关闭。**不自动消失、不假装成功。**
5. 派生失败：ghost 直接变失败卡（保留错误码与"重试"），不做落位动画。

### 3.5 区与区之间的"物理感"

- 三个区**不共享滚动容器**（现在两栏已经如此，保留），工厂与车间各自 `overscroll-behavior: contain`。
- 区与区之间只用 1px `BORDER_SOFT` + 16px 间距，**不用阴影堆叠**（否则看起来像三层浮层，而不是三个房间）。
- 工厂区背景比车间区低一档透明度（`rgba(127,127,127,.02)` vs `.035`）：静态/配置层更"平"，运行时层更"凸"。
- 唯一的跨区通道是总控条右侧的**"回流"入口**（P2）+ 工厂卡的"派生"。任何"从车间直接改工厂"的快捷方式都不做——这是本方案最重要的产品约束。

---

## 4. 状态联动

### 4.1 分身生命周期（6 态，服务端权威）

> 关键建议：**`ready` 不是生命周期状态，而是适配器健康。** 现在 `TASK_STATUS` 把 `ready/running` 并列（`src/kernel/types.mjs:165-171`），顶栏又并列展示"就绪/运行中"（`client.js:2145-2147`），本质是把"进程在不在"和"握手成不成"混进了同一根轴。改成 `runtime ∈ {starting, running, stopping, failed, crashed, archived}` × `health ∈ {handshaked, no-adapter}` 后，六个状态才自洽。

| 态 | 权威判定 | 灯 | 车间卡文本 | 允许 | 禁止 | 现状映射 |
|---|---|---|---|---|---|---|
| `starting` | `task.status=provisioning` 或 forker `starting` 或 已 `reserved` | 黄（呼吸） | 启动中 · 装配/握手 | 查看 | 打开、归档、下载 | **缺失**（被 G1 呈现为 failed） |
| `running` | 进程活（`live.running` 或 pid 活） | 绿 | 运行中 · 00:42:17 | 打开/归档/下载 | 改配置 | `ready`+`running` 合并 |
| `stopping` | `stopRequestedAt≠null` 且进程未退 | 黄（转圈） | 停止中 · 最多 3s | — | 打开、再归档 | **缺失**（G3） |
| `failed` | 进程不在，且非用户停止、非崩溃 | 红 | 已停止 · 可归档 | 归档/删除/查看诊断 | 打开 | `failed`（与 crash 混装） |
| `crashed` | `exit.kind=crash`（`classifyExit`，`forker.mjs:201-207`） | 红（脉冲一次） | 已崩溃 · code 1 | 归档/下载/重试 | 打开 | **缺失**（`taskView` 丢弃 `exit`） |
| `archived` | `task.status=archived` | 灰 | 已归档 · home 1.2 GB | 还原/下载/删除 | 打开、派生 | `archived` |

### 4.2 事件 → 三区联动表

| 事件 | 权威写入者 | 总控（母体） | 工厂（原身） | 车间（分身） | 徽标 | 客户端时延预算 | 失败兜底 |
|---|---|---|---|---|---|---|---|
| 点击派生（受理） | 客户端乐观 | `车间 3/8 → 4/8` 预留 +1 | 该原身"派生中"计数 | 插入 ghost 卡 | `派生中…` | ≤100ms（本地） | 失败回滚 ghost |
| 进程 spawn | forker | 计数不变（已预留） | — | ghost → starting + 端口/PID | — | ≤1 个快照周期（高频档 1s） | 超 5s 仍无 → "启动缓慢"文案 |
| 握手成功 | adapter | 三灯重算；warning 计数 -1 | — | 卡变绿，运行时长从 `startedAt` 起算 | `瓮城 3/8` | ≤5s（推送后 ≤1s） | — |
| 握手超时（10s） | orchestrator | warning +1 | — | 蓝"适配器未就绪" + 重试握手 | `瓮城 · 1 异常` | ≤5s | 视为 `running` 而非失败（保留现语义） |
| 进程异常退出 | forker | danger +1，顶部一次性横幅 | — | `crashed` + code + "归档/重试" | `瓮城 · 1 异常` | ≤5s | 若 3 次轮询仍无 `exit` 信息 → 降级为 `failed · 原因未知` |
| 点击归档 | 客户端 | 预留：`stopping` 计数 +1 | — | `stopping`，该卡动作全禁用 | — | ≤100ms | 3s 未确认 → 回到 `running` + "停止超时"提示 |
| 归档确认 | orchestrator | `stopping -1`、headroom +1（派生按钮复活） | — | 移出车间主区 → 归档行 | 计数更新 | ≤5s | 409 `stop-failed` → 红卡 + "进程仍在" 诊断 |
| 还原 | orchestrator | 预留 +1 | — | `stopping`→`starting` | — | ≤5s | `archive-home-missing` → 卡上给"删除记录"出口 |
| 镜像升级开始 | mirror | 母体灯 warning + 阶段文案 | 全部卡只读 + "重算中"占位 | **不变**（进程不受影响） | 隐藏"派生中…" | ≤1 快照 | 升级失败 → 母体灯 danger + 回滚结论 |
| 重算完成 | coordinator | 母体灯回绿 + "上次重算 xx:xx" | 配置版本前进 / 冲突数刷新 | — | — | ≤1 快照 | 部分失败 → 工厂灯 warning，不阻塞派生 |
| 回流提交（P2） | 回流服务 | 流程条：`校验→评分→审批→合并` | 卡上"回流中 · 阶段 3/5" | 该卡标"已提交回流" | — | 进行中 500ms 一档 | 冲突 → 见 7.4，不阻塞其它操作 |
| 回流冲突（P2） | 回流服务 | warning +1（非阻塞） | 卡上"冲突 n"，进冲突解决 | — | — | ≤1 快照 | 放弃回流 → rev 不变（原子） |

### 4.3 三盏灯与文案规则

| 灯 | green | info | warning | danger | 文案模板 |
|---|---|---|---|---|---|
| 母体 | 镜像就绪、无 update | 有新版本可用 | 升级/重算进行中、compat 门禁失败 | 镜像不可读 / 升级失败且回滚失败 | `母体 v{ver}` + 最多一个附加短语 |
| 工厂 | 全部原身 ready | — | 有 stale / 重算中 | 有 conflicted / 合并 fatal | `工厂 {n} 个` + `{n} 冲突` |
| 车间 | 全部 running 且已握手 | 有 starting | 有未握手 / 有 stopping 超时 | crashed / failed>0 / 满员 | `车间 {used}/{max}` |

规则：**一盏灯只允许一个最高优先级原因**（danger > warning > info > green），其余降级为 tooltip 明细；数字必须来自快照，不允许组件内自行累加（消除 F10）。

### 4.4 单一真相：`snapshot.rev` + 纯 selector

- 服务端维护 `panelRev`（单调递增，任何任务/原身/容量变化 +1）。
- 客户端只做 `snapshot → view model` 的**纯函数**：`deriveZones(snapshot)`，产出 `{ mother, factory, workshop, capacity }`。
- 陈旧丢弃：`incoming.rev < current.rev` → 整包丢弃（比逐字段合并更安全，也更容易测）。
- 联动表的所有"时延预算"都以 `rev` 前进为口径，不用"5 秒"这种墙钟描述（墙钟会随降级档变化）。

---

## 5. 车壳 / 黑匣子：分类归档

### 5.1 分类清单（对现有磁盘布局）

| 路径 | 类 | 可回流 | 可下载 | 入审计 | 生命周期 |
|---|---|---|---|---|---|
| `<essence>/overlay/cordis.patch.yml` | 车壳 | ✅ 按 id 合并 | ✅ | ✅ | 长期 |
| `<essence>/overlay/settings/*.yaml` | 车壳 | ✅ 深合并 | ✅ | ✅ | 长期 |
| `<essence>/overlay/package.json` | 车壳 | ⚠️ 仅并集/兼容版本 | ✅ | ✅ | 长期 |
| `<essence>/overlay/credentials/**` | 车壳（敏感） | ❌ 永不自动合并 | ❌ 默认排除 | 只记"发生过变更" | 长期 |
| `<essence>/merged/profile/**`、`fingerprint.json` | 产物 | — | ✅ | — | 可重建 |
| `<fork>/sessions/**`（`.jsonl.zstd`） | 黑匣子 | ❌ | ✅（zip） | 仅元数据 | 随归档冻结/删除 |
| `<fork>/storages/workspace.json` | 黑匣子 | ❌ | ✅ | — | 同上 |
| `<fork>/fang-seeds/*.md` | 黑匣子（种子） | ❌（单向进入） | ✅ | ✅（hash/字节） | 同上 |
| fork buffers、`logs` | 黑匣子 | ❌ | ✅（可选脱敏） | 仅摘要 | 短期滚动 |
| `forks.json` / `ports.json` | 运行账本 | ❌ | ❌ | ✅ | 进程级 |
| `audit` ledger | 审计 | ❌ | ❌ | — | 只追加 |

### 5.2 三种"归档"必须叫三个名字

| 概念 | 对象 | 语义 | 现有实现 |
|---|---|---|---|
| **冻结**（车间归档） | 分身 | flush + 停进程 + 保留 home + 审计；rev 记一次 | `archiveTask`（`orchestrator.mjs:859-923`）✅ |
| **还原/删除** | 分身 | 重新 spawn（新端口/新 token）/ 永久删 home | `restoreTask` / `deleteArchivedTask` ✅ |
| **备份/恢复**（工厂备份） | 镜像 | 复制 `active/` 到 `backup/<id>` 或 `restore/<id>`，索引 + meta | `MirrorManager.backup/restore` ✅ |

UI 上：车间用"归档"，工厂折叠区用"备份/恢复点"，**不要**把两者都叫"归档"——这是当前文案里最容易让人误以为"归档 = 配置回到了工厂"的地方。

### 5.3 下载（黑匣子导出，P2）

- 路由：`GET /api/tasks/export?taskId=&include=logs`（另有取值 `secrets`），流式 zip，硬上限（建议 512 MB / 200k 文件，对齐 `listFiles({max})` 的既有约束）。
- 运行中导出：**允许**，但语义写清"导出的是**某一时刻的副本**，不保证与随后写入一致"；若要一致性，先归档再导出（推荐：卡片上"下载"在 `running` 时给二次确认，提示先归档）。
- 默认剔除：`token`、`credentials/**`、`ports.json`；`include=secrets` 需显式勾选 + 审计。

---

## 6. 派生流水线（受理 → 推进 → 落位）

### 6.1 契约变更（这是 P0 里唯一"必须改服务端"的一条）

| 项 | 现状 | 目标 |
|---|---|---|
| `POST /api/derive` | 同步，握手后才返回；409 表示各种失败 | **202 + `{ok, taskId, opId, phase:'starting'}` 立即返回**；工作在后台推进；失败写进任务记录 |
| 幂等 | 无 | 请求头 `Idempotency-Key: <opId>`；服务端保留 2 分钟窗口，同键返回同一 `taskId`（不重复派生） |
| 进度 | 无（只能等 POST） | 快照里带 `task.phase ∈ {accepting, provision, spawn, handshake, ready}` + `at` |
| 兼容 | `quickDerive` / 面板 / 独立门户三处调用 | 旧调用方按"没有 `url` 就继续轮询"处理即可；返回体仍带 `taskId`，不破坏 |

### 6.2 阶段与预算

| 阶段 | 预算 | 超时动作 |
|---|---|---|
| 预留（同步，无 await） | 0 | 满员即返回 `quota-exceeded`（不建记录） |
| provision（复制模板 / 建 junction） | 3s | 释放预留、记录 failed(`provision-timeout`) |
| spawn（含端口绑定、URL 解析） | 5s（`startTimeoutMs`） | 杀进程、释放端口、failed |
| handshake | 10s（`adapterTimeoutMs`） | 保留为 `running`（未握手）+ 可重试（不改现有语义） |
| 总计 | 20s | 强制 `failed · timeout` 并释放槽位 |

### 6.3 满员与并发仲裁

- `headroom = max - (running + starting + stopping + reserved)`（**四项都要算**，现在只算 running/ready）。
- UI：`headroom ≤ 0` → 派生 CTA 禁用 + 文案 `车间满员 8/8 · 先归档 1 个`（按钮变成跳转归档行的链接）；`aria-disabled="true"` + 一次性 `aria-live` 提示，**不要**每秒播报。
- 服务端仍是最终仲裁：并发下仍可能 409；UI 必须把 `quota-exceeded` 映射为"满员"提示（现在是通用"派生失败"）。
- 双配额门要合并：`forker.spawn` 的 `max-forks`（`forker.mjs:812`）应作为"最后一道保险"，其错误码要映射成 `quota-exceeded` 而不是 `spawn-failed`（否则用户看到"请求失败"）。

### 6.4 对账规则（配合 3.4 的 ghost）

- ghost 的键 = `opId`；真卡的键 = `taskId`；绑定后只保留真卡（同一 DOM 节点复用，避免闪两次）。
- 快照返回的 `tasks` 若带 `opId`（服务端记录即可），客户端按 `opId` 匹配，比按标题/时间猜更稳。
- ghost TTL：2 个快照周期（高频档 ≈2s，空闲档 ≈2min）——按**周期数**而不是墙钟，避免降级档下 ghost 挂十几分钟。

---

## 7. 快照回流（车间 → 工厂）

### 7.1 一致性模型声明（写进契约，别让实现者猜）

> **回流不是实时协同编辑，而是"带 base 的单向提案 + 服务端仲裁合并"。**
> - 工厂侧：单写者（母体进程）+ 每原身一把锁（`KeyedMutex`，`essence.mjs:414` 已有），`rev` 单调。
> - 车间侧：改动只在分身自己的 home 里，**不实时写工厂**；只有用户显式点"回流"才形成一次提案。
> - 因此这里**不需要** CRDT/OT：配置的语义单位是"键"和"条目 id"，不是字符；需要的是三向合并 + 冲突上浮。文本协作用的 CRDT 结论（`ESSENCE.md` 的合并语义）在这里不适用。

### 7.2 数据流

```
车间 home（车壳白名单）
      │  collect：只取 overlay/**（patch / settings / package.json，排除 credentials）
      ▼
   verify：路径逃逸 / 大小上限 / 内容 hash / 禁用项黑名单
      ▼
   score（可选，复用 scorer）+ approve（复用 approver，risk=red）
      ▼
   merge（三向：base = 派生时记录的 baseFp / baseOverlayRev；ours = 工厂当前；theirs = 提案）
      ▼
   staging 目录 → 原子 swap（沿用 mirror.swapActive 的 rename 语义）→ recompute（EssenceManager）
      ▼
   rev+1 · 审计 flowback-committed · 广播 panelRev
```

### 7.3 三向合并矩阵

| 对象 | 合并规则 | 冲突条件 | 冲突结论 |
|---|---|---|---|
| `patch` 条目（按 id） | 新增→追加；仅一侧改→取该侧；两侧都改→逐键比 | 同 id 同键不同值；锁定项被改 | needs-decision / blocked |
| `settings/*.yaml` | 深合并，叶子键三向 | 同 key 两侧不同值 | needs-decision（默认"保留工厂"，需一次点击才覆盖） |
| `package.json` 依赖 | 并集；同包 semver 兼容取高 | 主版本不同 | blocked（需人工选版本） |
| `credentials/**` | **不合并** | 任何并发变更 | blocked（人工确认，且不落日志/不回显） |
| 删除（车间删了工厂有的项） | 工厂侧未改 → 执行删除；工厂侧改过 → 冲突 | 两侧不同 | needs-decision |
| 全新插件/文件 | 直接合并（但要走评分门禁） | 路径逃逸 / 评分 D-E / route 拒绝 | blocked |

- **base 从哪来**：派生时在任务记录里写 `essenceId + baseOverlayRev + mirrorFingerprint`（G5）。没有 base 就只能"覆盖"，那就等于把工厂的并发改动静默丢弃——**必须在 P0 落下这三个字段**，否则 P2 做不了。
- **快速前进**：工厂 `rev == baseOverlayRev` 且 fingerprint 未变 → 直接 apply，不产生冲突清单（这是最常见路径，要最快）。

### 7.4 冲突分级与 UI（P2）

| 级别 | 表现 | UI |
|---|---|---|
| auto（自动应用） | 无冲突 | 工厂卡 toast：`已回流 3 项`（可撤销指向 pre-backup） |
| merged（自动合并） | 有合并但不冲突 | 卡片展开"变更清单"：`settings.routing.timeout 车间→工厂` |
| needs-decision | 逐键冲突 | **冲突清单**（类似 PR review）：每行三列 `工厂值 / base / 车间值`，单选 + "全部保留工厂"；未解决不得提交 |
| blocked | 凭据改动 / 锁定项 / 评分 D-E / 路径逃逸 | 只读说明 + 明确"不可回流原因"，给"仍要改请到工厂手动设置" |

- 回流**永不**自动覆盖工厂：所有 needs-decision/blocked 都必须由人在工厂侧确认（呼应既有 approver 的红色风险流程）。
- 冲突文件落盘建议沿用 `conflicts.json` 的既有形状（`essence.mjs` 已用它承载 fatal 明细），新增 `flowback-conflicts.json`，避免与 recompute 冲突破坏既有读取方。

### 7.5 幂等、断点、原子性

- `flowbackId = sha256(essenceId + taskId + baseRev + 内容摘要)`：同一次语义提交重复点击、网络重试、双标签页重复提交 → 全部收敛为一次（审计里记 `flowback-idempotent-hit`）。
- 已应用集合写进 audit ledger（已有 append-only），窗口 ≥ 7 天。
- 中断恢复：`staging/flowback-*` 残留由启动 GC 清理（复用 mirror 的 staging 命名习惯）；swap 用 rename，**要么旧 rev 要么新 rev**，不存在半个工厂。
- 失败语义：merge 或 recompute 失败 → 回滚到 staging 前状态，工厂 `rev` 不变，冲突清单保留供重试。

### 7.6 实时进度

- 阶段事件统一成一个形状：`{flowbackId, phase, at, detail}`；阶段 = `collect → verify → score → approve → merge → materialize → recompute → done`。
- 客户端：回流进行中用 **500ms 高频档**（`acquireActive` 的语义正好用于此）；结束立刻降回 5s/60s。
- 不建议为回流单开 SSE：先复用 500ms 轮询 + `rev` 去抖；P3 再统一切到推送（见 9.3）。

### 7.7 边界：黑匣子永不过界

- 现有设计已经守住了"单向"：从母体会话派生时只把 **有界的 lineage seed**（≤64 KiB）种进分身（`orchestrator.mjs:444-466`），母体只读。
- 回流是反方向，**只允许车壳**。会话/缓冲/日志若要"带回工厂"，唯一合法路径是"下载导出 + 人工/后续导入流程"，不是回流。

---

## 8. 并发 / 资源上限与降级策略

### 8.1 上限表（当前值 → 建议值）

| 资源 | 当前 | 建议 | 依据 |
|---|---|---|---|
| 同时存活分身 `maxForks` | 8（1..64） | 保持 8 默认，UI 只读展示 | `orchestrator.mjs:35-36` |
| 端口池 | 18000–18100（101） | 保持；`headroom` 同时受端口数约束 | `forker.mjs` 端口池 + `ports.json` 死 pid 回收 |
| 派生总预算 | 无（分散在 provision/spawn/handshake） | 20s 硬上限 | 6.2 |
| 握手超时 | 10s（`adapterTimeoutMs`） | 保持 | `orchestrator.mjs:49-52` |
| 归档停止确认 | 3s（`archiveStopTimeoutMs`） | 保持；UI 的 `stopping` TTL = 3s + 1 快照周期 | `orchestrator.mjs:59-60` |
| 会话列表读取 | 每任务串行、无缓存 | 并发 ≤8、单次 ≤200ms 预算、卡片折叠即停、缓存 30s | 消除 N+1（F9） |
| 回流 | 无 | 每原身 1 个在飞（mutex 已有），全局 1 | 7.5 |
| 重算 | 并发 4、每原身 60s | 保持 | `upgrade-coordinator.mjs:20-21` |
| 快照载荷 | `tasks.list` 全量 + 会话 N+1 | 单包 ≤256 KB；会话列表独立按需拉 | 8.3 |
| 轮询 | 5s / 8s / 10s 三套 | 5s 活跃、60s 空闲、隐藏暂停；单一节奏 | 9.1/9.2 |

### 8.2 降级阶梯

| 档 | 触发 | 行为 | 用户可见 |
|---|---|---|---|
| L0 | 正常 | 5s 快照；卡片展开才拉会话 | — |
| L1 | `document.hidden` | 停止轮询；`visible` 时强制刷一次 | — |
| L2 | 30s 无交互 | 降到 `idlePollIntervalMs`（60s）；仍在进行的回流/派生保持高频档 | 不提示（默认 `silent`，遵循偏好） |
| L3 | 连续 3 次失败 | 退避 5→10→20→40→60s（封顶）；保留上次数据 + "上次成功 xx:xx" | 顶部 Callout（已有 `statusBanner` 模式） |
| L4 | 429 / `overloaded:true` | 停掉所有按需会话请求与落位动画；只留快照；线程内请求合并 | 徽标"降级" + tooltip |
| L5 | 满员 / 工厂冲突 | 派生禁用、回流禁用；打开/归档/还原仍可用 | 明确的阻塞原因与出口 |

### 8.3 背压与陈旧丢弃

- **请求合并**：同一资源同一时刻只允许一个在飞（现有 `refreshLock` 思路保留，但要按资源而非全局）。
- **陈旧丢弃**：`rev` 比较（4.4）；分身的会话列表用现有 `seqRef` 模式（`client.js:1674-1686`）——这套模式是对的，推广到快照即可。
- **慢消费者**：面板是请求-响应，不存在服务端 per-connection 缓冲；真正的风险是**多标签页放大**（见 9.1 C5）与 N+1。建议 `BroadcastChannel` 选主：leader 轮询、其它标签订阅 leader 广播的 `rev` 通知；leader 卸载时重新选举（`navigator.locks` 或心跳 1s + 超时 3s）。

### 8.4 泄漏与清理

- 端口：已有死 pid 回收（`ports.json`），保持；新增"派生失败必须释放预留端口"的用例。
- staging：`mirror` 的 `.staging-*` / `.swap-*` 已有 finally 清理；回流的 `staging/flowback-*` 需要启动 GC。
- ghost 卡：周期计数 TTL（6.4）。
- in-flight fetch：卸载时 abort（现有 `aliveRef` + `AbortController` 在 store 里已有，客户端还没用）。

---

## 9. 与 `status-store` / `upgrade-coordinator` 的接口冲突

### 9.1 `MirrorStatusStore`（`src/lib/status-store.mjs`）

| # | 冲突点 | 现状 | 为什么不能直接用 | 建议 |
|---|---|---|---|---|
| C1 | 单文档 vs 三区多资源 | 快照是 `{status, loading, error, lastUpdatedAt}` 一个资源 | 总控/工厂/车间是三个独立新鲜度的资源，塞进一个 `status` 字段会让"工厂刷新失败但车间正常"无法表达 | 保留该 store 的语义，**新增 `PanelSnapshotStore` 组合**（1 个快照 = 1 个资源）；或按资源各建一个实例 + 纯 selector 组合。**不要**把它改成多资源 store（会破坏既有测试与 idle-audit 契约） |
| C2 | 每次 tick 都 `update({loading:true})` | `refresh()` 开头无条件置 `loading`（`status-store.mjs:157-182`） | 每个订阅者每 5s 收到一次新快照 → 三区仪表盘整树重渲染（语义上没变也重渲染） | 加 `quiet` 模式：仅在 `status===null` 时置 `loading`；或由调用方传 `{silent:true}` |
| C3 | 全局单飞 | `inFlight` 是实例级（`:158`） | 组合三个资源后，一个慢请求会占死整个 store | 按 key 单飞（Map<key, Promise>）；单资源场景行为不变 |
| C4 | fetcher 契约无 `rev` | 只回 `{status, notModified}` | 无法做陈旧丢弃（4.4），也无法把服务端 `panelRev` 带到 UI | 扩展为 `{data, rev, notModified}`，保留 `status` 别名兼容旧调用 |
| C5 | `acquireActive` 是"整面板一个消费者" | 引用计数 + 单一 idle 计时器（`:76-113`） | 派生中/回流中需要 500ms–1s 的**局部**高频档，与面板 5s 档并存；现在只能整体提速或整体降速 | 命名空间化：`acquireActive('flowback')`，内部取"最高档"；或给高频消费者单独一个轻 store |
| C6 | 设置真值有两份 | store 的 `activeIdleTimeoutMs`（内存，`:144-155`）vs 服务端 `preferences.activeIdleTimeoutMs`（`preferences.mjs:23-29`） | 用户在镜像设置里改 15/30/60s 后，store 不会自动同步；现在压根没人调用 `/api/mirror/preferences` | 启动时 hydrate + 保存后 `setActiveIdleTimeout`；偏好是服务端真值，store 是缓存 |
| C7 | 客户端根本没用它 | 面板 5s（`client.js:1776`）、镜像卡 8s（`803`）、徽标 10s（`2763`） | 直接接上会**改变现有节奏**（镜像卡 8s→5s、徽标 10s→5s），需要一次显式迁移清单而不是悄悄切换 | 分两步：① 先把三个 `setInterval` 收敛到同一节奏并接 store；② 再上 `acquireActive` |
| C8 | `onIdleDowngraded` 在生产里没有消费者 | `IdleAuditAggregator` 只在 lib + 测试里出现（`src/lib/idle-audit.mjs:13`），orchestrator 未接线 | "用户走开多久"的统计与建议是空管道；写进联动表会变成假指标 | 要么真接线（客户端上报 → 审计），要么从产品指标里删掉 |

### 9.2 `MirrorUpgradeCoordinator`（`src/lib/upgrade-coordinator.mjs`）

| # | 冲突点 | 现状 | 影响 | 建议 |
|---|---|---|---|---|
| C9 | `getRecomputeStatus()` 每次返回新对象 | 深一层的浅拷贝（`:32-44`） | 直接喂 `useSyncExternalStore` 会**无限重渲染**（React 要求 snapshot 引用稳定） | store 层缓存 + `rev` 只在进度真变化时 +1 |
| C10 | 单飞 join，无 rerun | 已有 run 时直接 `return this.currentRun`（`:50-57`） | 回流触发的 recompute 与升级触发的 recompute 撞车时，后者被静默丢弃——**正是"快照回流"最容易踩的坑** | 加 `rerunRequested` 标志 + 循环：本轮结束后若置位则再跑一轮 |
| C11 | 没有因果链 | 状态里没有 `runId` / `startedBy`（`upgrade` 或 `flowback`）/ `from,to` | 总控无法把"升级中 → 重算中 → 回流中"画成一条链；冲突归因不到哪次升级 | 加 `runId` 与 `startedBy`；`mirror.upgrade` 把 `runId` 透传给 hook |
| C12 | 冲突只有 id 数组 | `lastResult.conflicted` 是 id 列表 | 工厂卡"冲突 1"点不进去；用户不知道哪个键冲突 | 补 `conflictSummary`（或前端按 id 再调 `essence` 路由取明细） |
| C13 | 阶段词汇不统一 | `UPGRADE_STAGE` 七个字符串（`mirror.mjs:39-42`）vs 派生四阶段 vs 回流七阶段 | 三区顶部只能各画各的进度条，无法统一"正在发生什么" | 统一为 `{phase, at, pct?, detail}`；`UPGRADE_STAGE` 做映射表，不破坏旧调用 |
| C14 | 漂移字段 | `diskUsageBytes` 每次请求都在变（已被 ETag 排除，`mirror-etag.mjs:41`） | 三区快照若照抄会把每包都判为"变了" | 快照稳定字段与漂移字段分离，漂移字段单独低频拉 |

### 9.3 建议的目标契约（只列形状，不写代码）

- `GET /fang/api/panel/snapshot?rev=<n>` → `{ rev, mother:{version,mirror,update,caps}, factory:{essences[],rev,conflicts}, workshop:{tasks[],capacity,counters}, flowback:{active,phase} }`，支持 `If-None-Match`（沿用 `mirror-etag` 的稳定字段思路），单包 ≤256 KB。
- `POST /fang/api/derive` → 202 + `{taskId, opId, phase}`；请求头 `Idempotency-Key`。
- `GET /fang/api/tasks/sessions?taskId=` 保持独立按需（不进快照）。
- `POST /fang/api/essence/flowback` → `{flowbackId, essenceId, taskId, baseRev, changes, conflicts[], staged:true}`；`POST /fang/api/essence/flowback/apply` 逐条决策后提交。
- 兼容层：`/api/status`、`/api/tasks` 保留（徽标、独立门户、旧客户端），但内部改为读同一份快照，避免 F11 的双源。

---

## 10. 实现优先级

| 阶段 | 内容 | 工作量 | 验收标准 |
|---|---|---|---|
| **P0 契约修正** | 修 G1/G2/G3（`taskView` 引入 `phase`/`startedAt`/`exit`/`stopRequestedAt`；`provisioning` 不再呈现为 failed；配额计入 starting；`max-forks` → `quota-exceeded`）；`/api/derive` 改 202 + `Idempotency-Key`；任务记录补 `essenceId/baseOverlayRev/baseFingerprint`；快照加 `rev` 与 `capacity` | 1.5 人日 | 派生 200ms 内快照显示 `starting`；两只标签页并发双击只产生 1 个分身；`maxForks=2` 时第 3 个并发派生得到 `quota-exceeded`；归档 200ms 内 `stopping` 可见 |
| **P1 三区骨架** | 总控条 + 工厂列表（只读：插件数/配置版本/冲突）+ 车间卡（时长/端口/PID/灯）+ 六态状态机 + 满员禁用 + ghost/落位动画 + 响应式 + 单一 selector | 2.5–3 人日 | 六个动作中三个存在项可用、三个"无 API"项明确禁用并给出原因；三档断点无重叠；`prefers-reduced-motion` 下无位移动画；键盘可完成派生/归档 |
| **P2 回流 MVP** | 车壳白名单 collect → verify → (score) → approve → 三向 merge → staging/swap → recompute；冲突清单 UI；`flowbackId` 幂等；工厂"设置/克隆"路由 | 3–4 人日 | 同 base 下工厂改 A、车间改 A+B：A 冲突、B 自动合并、工厂 rev+1；重复提交同一 flowbackId 为 no-op；swap 前后杀进程都能恢复 |
| **P3 实时化** | 统一阶段事件 + 500ms 高频档 + `BroadcastChannel` 选主 + idle 审计接线 +（可选）SSE 推送 | 2–3 人日 | 两个标签页只产生 1 条轮询流；隐藏 10 分钟 0 请求；回流进度端到端 ≤1s 可见 |
| **明确不做** | CRDT/OT（配置不是文本）、WebTransport（本机）、每卡独立轮询、独立门户三区化（门户保持精简表格视图 + 派生，顶部注明"精简视图，完整控制台在面板"） | — | — |

---

## 11. 测试清单

> 归属建议：服务端 `test/*.test.mjs`（node:test，现有风格）；纯函数（selector、状态机、合并判定）抽到 `src/lib/` 后单测；UI 交互用现有面板手工清单 +（可选）Playwright。

| # | 层 | 场景 | 期望 |
|---|---|---|---|
| T1 | 服务端 | 派生请求发出后 200ms 读快照 | 该任务为 `starting`，**绝不是** `failed` |
| T2 | 服务端 | `maxForks=2`，3 个并发派生 | 恰好 2 个受理，第 3 个 409 `quota-exceeded`；前 2 个不被误杀 |
| T3 | 服务端 | 同 `Idempotency-Key` 连发 3 次 | 只创建 1 个任务，返回同一 `taskId` |
| T4 | 服务端 | 归档中（stop 未完成）读快照 | `stopping`；3s+1 周期后 `archived`；`stop-failed` 时回 `running` 且带 `alive:true` |
| T5 | 服务端 | `kill -9` 子进程 | 1 个轮询周期内 `crashed` + `exit.code`；不是 `failed` |
| T6 | 服务端 | 宿主重启后读任务列表 | 历史 RUNNING/READY 且进程已死的任务 = `failed`；`archived` 不变 |
| T7 | 纯函数 | `deriveZones(snapshot)` 对 30 组快照 | 三灯优先序正确；`headroom = max-(running+starting+stopping+reserved)`；不出现负数/负数显示 |
| T8 | 纯函数 | 三向合并矩阵 6 类对象 × 3 种基线 | 返回 `auto/merged/needs-decision/blocked` 与矩阵一致；凭据永不 `auto` |
| T9 | 服务端 | 回流：工厂改 A，车间改 A+B，同 base | A=needs-decision，B=merged，工厂 rev+1；冲突文件不影响既有 `conflicts.json` 读取 |
| T10 | 服务端 | 回流重复提交（同 flowbackId）×3 | 1 次提交，其余 idempotent-hit；rev 只 +1 |
| T11 | 服务端 | 回流 swap 前后各杀进程一次 | 工厂要么旧 rev 要么新 rev；`staging/flowback-*` 被 GC；不产生半个 profile |
| T12 | 服务端 | 升级触发 recompute 期间提交回流 | 两者串行；回流不被静默丢弃（`rerunRequested` 生效）；最终 fingerprint 一致 |
| T13 | 服务端 | 8 个分身 + 20 轮归档/还原 | `ports.json` 无死 pid 残留；端口无泄漏；`quota` 计数无漂移 |
| T14 | UI 逻辑 | ghost 卡：2 个周期未见到真卡 | 变"未确认"卡；不自动消失；不出现"假成功" |
| T15 | UI 逻辑 | 慢响应：先发后到的旧快照 | 按 `rev` 丢弃；界面不倒退（卡片不闪回旧状态） |
| T16 | UI 逻辑 | 满员时点派生 | 按钮 `aria-disabled`；出现一次"满员 8/8"提示；不发请求 |
| T17 | UI 逻辑 | 归档双击 / 两个标签各点一次 | 只发一次有效归档；第二次返回 `already` 时不弹失败 |
| T18 | UI 交互 | 隐藏 10 分钟再回前台 | 期间 0 请求；回台 1 次刷新；`ghost` 不误判超时 |
| T19 | UI 交互 | `prefers-reduced-motion` | 无高度/位移动画，仅 120ms 透明度 |
| T20 | UI 交互 | 键盘：Tab 顺序 + `Esc` | 总控→工厂→车间；所有动作可聚焦、可读屏（灯有文本） |
| T21 | 视觉 | 1440 / 1280 / 1024 / 980 / 640 | 工厂窄栏不挤压标题；车间卡动作不换行错位；归档折叠区可发现 |
| T22 | 独立门户 | `/fang/panel` 与面板同时开 | 都只做派生/只读；门户顶部标注"精简视图"；不出现第二套三区 |

---

## 12. 待产品确认（5 条，决定 P1/P2 的具体形状）

1. **工厂 = 一个原身，还是原身列表？** 数据层支持多原身 + 两级子原身；若产品只要单卡，P1 可省掉列表/抽屉。
2. **满员是"拒绝"还是"排队"？** 拒绝（当前）实现简单、语义清晰；排队需要队列 + 位置 + 取消，工作量翻倍且与 `maxForks` 的"同时存活"语义冲突。建议：拒绝 + 明确出口。
3. **"下载"是否允许运行中导出？** 允许则必须写明"某一时刻副本、不保证一致"；不允许则"下载"在 `running` 时置灰并引导先归档。
4. **回流是否强制审批？** 建议强制（复用 approver 的 red 风险流程），因为它写的是工厂/生产配置。
5. **镜像升级与"工厂"的关系怎么讲？** 建议在工厂区头固定一行"基于镜像 vX 的覆盖层"——否则用户会把"改原身设置"误当成"升级母体"。

---

## 附：本次评审的证据索引

| 结论 | 位置 |
|---|---|
| 派生中任务被呈现为 failed | `src/plugins/orchestrator.mjs:302-306` + `src/plugins/forker.mjs:1135-1140` |
| 配额只数 running/ready | `src/plugins/orchestrator.mjs:385-391` |
| forker 另有一套配额（max-forks） | `src/plugins/forker.mjs:812` |
| 归档无 stopping，最长 3s | `src/plugins/orchestrator.mjs:859-899`（`archiveStopTimeoutMs`，`:59-60`） |
| `taskView` 丢 `startedAt/exit` | `src/plugins/forker.mjs:410-429` vs `orchestrator.mjs:307-326` |
| 任务无 essence 关联 | `src/plugins/orchestrator.mjs:397-422` |
| 原身仅一条 HTTP 路由 | `src/plugins/orchestrator.mjs:1394`、`1151-1155` |
| `activeEssenceCount` 恒为 0 | `src/plugins/orchestrator.mjs:1121-1126` |
| 快照无 ETag / 无 rev | `src/plugins/orchestrator.mjs:1241-1268`；对比 `src/lib/mirror-etag.mjs` |
| 三套轮询节奏 | `client.js:1776` / `803` / `2763` |
| 默认展开所有分身会话（N+1） | `client.js:1616`、`1764-1765` |
| status-store 每 tick 置 loading | `src/lib/status-store.mjs:157-182` |
| status-store 未被使用、偏好未消费 | 全文无 `preferences` / `essence` / `recompute` 调用（`client.js`） |
| coordinator 浅拷贝快照 | `src/lib/upgrade-coordinator.mjs:32-44` |
| coordinator 单飞无 rerun | `src/lib/upgrade-coordinator.mjs:50-57` |
| 镜像升级阶段枚举 | `src/lib/mirror.mjs:39-42`、`346-432` |
| 原身合并语义与配额 | `src/lib/essence.mjs`、`docs/ESSENCE.md` |
| 独立门户是第二套 UI | `src/plugins/orchestrator.mjs:1264-1267`、`1424+` |
