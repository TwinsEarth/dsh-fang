# CHANGELOG

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
