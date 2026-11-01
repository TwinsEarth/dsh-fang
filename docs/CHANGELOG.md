# CHANGELOG

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
