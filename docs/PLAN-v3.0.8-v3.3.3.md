# dsh-Fang v3.0.8 → v3.3.3 总体架构与分阶段实施计划

> **状态**：计划稿（docs-only，未提交、未推 main、未打 tag、未发布）。
> **生成时间**：2026-11-05（Asia/Shanghai）。
> **输入**：`<v3.1.1规格书>`（用户路线图 v3.0.8–v3.0.12 + 三层升级路径设计）；仓库 `dsh-fang`。
> **代码基线**：`HEAD = d3e2989`（分支 `feat/upgrade-coordinator`，`git describe = v3.0.7-8-gd3e2989`）；tag `v3.0.7`（annotated → commit `3bf976d`）是唯一正式 Release。
> **写作原则**：本文件只描述计划。**凡未在仓库中实测存在的，一律标注为「不存在 / 待实现」**；已完成与未完成严格分栏，不虚构。

---

## 0. 一页摘要

| 项 | 内容 |
|---|---|
| 目标区间 | v3.0.8 → v3.3.3，共 **17 个连续版本**（3.0.8–3.0.12 五个 / 3.1.0–3.1.3 四个 / 3.2.0–3.2.3 四个 / 3.3.0–3.3.3 四个） |
| 主线 | 从「能派生 + 能备份」升级到「**代际化母体、可重算原身、可回滚插件、唯一 Electron 控制台、可审计的跨根访问**」 |
| 架构核心 | 三根（母体/原身/会话）+ 三指针（`mirror/current.json`、`essence/merged/current.json`、`session.activeBranchId`）+ 一条审计链 |
| 唯一控制台 | **PC Electron**；DSH Web（浏览器）零 fang 面（无面板、无浮层、无 dock、无独立 HTML 路由） |
| 发布纪律 | PR-only；不推 main（需用户明确指令）；不跳号；**六方发布必须等用户书面确认** |
| 规模估算 | 约 **157 人日**开发 + 每版发布窗口 0.5 人日；2 人并行约 17–19 周 |
| 当前门禁实测 | 单测 **690 / pass 679 / fail 0 / skip 1 / todo 10**（31.7s）；路由契约 **62**；e2e 最新记录 66/66（v3.0.7 审计） |
| 最需要先解决的治理问题 | `origin/main` 是 `v3.0.7` 的祖先，`v3.0.7` 领先 **71 个提交**；即发布线不在 main 上（M0 必须先归位） |
| 并行设施（**工作区未提交**） | 同仓另一工作流已建 `tools/git/{guard-main,pr-gate,version-cut,verify-release,history-audit}.mjs` + `.githooks/pre-push`；**本计划的 G-1/G-3/G-6 复用它们，不再重复造轮子**（见 §2.2） |

---

## 1. 事实基线（不虚构）

### 1.1 已发布、已验证（v3.0.7）

| 能力 | 载体 | 证据 |
|---|---|---|
| 16 行插件装载（母体侧） | `cordis.patch.yml` | preflight `version` 检查 + e2e「16 fang plugin rows composed」 |
| 62 条路由契约 | `src/plugins/*.mjs` + `tools/release/allowlist.mjs` | 本机实测 `routes.count = 62, findings = 0` |
| 镜像层：备份/还原/升级/间隔/ETag/compat 门禁 | `src/lib/mirror.mjs`、`mirror-etag.mjs`、`compat.mjs` | 升级 = `swapActive`（**破坏式**：拷 staging → 删 `active/` → rename） |
| 原身层：overlay×mirror 合并、recompute、CRUD、配额常量 | `src/lib/essence.mjs` | `mergeProfiles` 纯函数 + `essence.mjs` 941 行 |
| 分身层：端口池 18000–18100、spawn/stop/reap/junction、supervisor | `src/plugins/forker.mjs`、`fork-supervisor.mjs` | `buildLaunchSpec`、`publicFork` |
| 跨进程桥：Adapter v3（版本协商/SSE/幂等命令/bearer） | `adapter.mjs`、`adapter-protocol.mjs`、`adapter-client.mjs` | 10 条 adapter 路由 |
| 审批/评分/保护伞/路由/自愈/热更/重启闸门/缓冲/审计链 | 对应 10 个插件 | 哈希链 `sha256(canonical+prevHash)` |
| 发布门禁：preflight(--e2e 不可跳过)、build、package-smoke、allowlist、healthz、compat | `tools/release/*` | v3.0.7 审计记录 GREEN 3.0.7 |
| 客户端半：`mountPanel` 导出 + 浏览器 slot 注入 + `/fang/panel` 链接 | `client.js`（3346 行） | **注意：浏览器面尚未清干净，见 §1.3** |

### 1.2 已在分支、**未合并 main、未发布**（`feat/upgrade-coordinator` 的 8 个提交）

| 提交 | 内容 | 状态 |
|---|---|---|
| `04e09aa` `c5cd6fd` `9d2e8c7` `7b72f95` | v3.0.8 分支：运行时 spike 4/4、`branch.mjs` 模型 5/5、`reflow.mjs` 四态机 + 测试、spike 结论文档 | **库级完成，没有任何路由/插件接线** |
| `41ba258` | v3.0.9 三根访问矩阵（`roots.mjs`，fail-closed）+ 5/5 | 库级完成，未强制到路由 |
| `04e09aa` | `fs-guard.mjs`（`safeJoin`/`assertInside`）+ 13/13；`broker.mjs`/`broker-adapter.mjs` | broker 只读，3/3 |
| `c7d7d31` `a62a7f5` `d3e2989` | v3.0.9 只读升级状态 `GET /api/upgrade/status`、`buildUpgradeStatus`、adapter `resolveIdentity` + 401/403 映射 6/6、62 路由契约 | 后端可跑，**Electron 侧版本角标未接** |
| 另有 | `upgrade-coordinator.mjs`（postUpgradeHook 去重重算）、`essence.recomputeAll`（并发 4 / 单 60s / 失败隔离）、`status-store.mjs`、`preferences.mjs`、`idle-audit.mjs` | 库级完成，**没有任何 UI 消费者**（`status-store` 在 `client.js` 中零引用） |

> 结论：v3.0.8 / v3.0.9 的「库与只读路由」已在分支上落地，但**没有端到端能力**，因此不能算 v3.0.8/v3.0.9 已完成。

### 1.3 **不存在**（本计划要建的东西）

| 缺口 | 现状证据 |
|---|---|
| **MCP 全链路** | 全仓库 `git grep -i mcp` 在 `src/` 零命中；仅 `docs/TEST-PLAN-v3.0.7.md` 有 MCP-01..03 用例占位 |
| **分支/回流的 HTTP 面** | `branch.mjs`、`reflow.mjs` 只被 `test/*.test.mjs` 引用，无插件导入、无路由 |
| **母体代际与指针** | 无 `generations/`、无 `current.json` 指针；`upgrade()` 用 `swapActive` 覆盖式替换，回滚依赖备份整目录拷贝 |
| **原身运行实例管理** | `essence.mjs` 只产出 `merged/profile`；无 `EssenceInstanceManager`、无实例端口段、无健康探针 |
| **插件更新 + 快照/冒烟/回滚** | `approver.snapshot()` 只是目录 A/B 副本；无 `vm_snapshot` 能力（`git grep vm_snapshot` 零命中）；无插件更新路由 |
| **快照后端抽象** | 无 `SnapshotStore`；`approver` 的 A/B 与 `mirror.backup` 各自复制目录，无 manifest/seal |
| **三向合并回流** | `reflow.mjs` 只有 4 态状态机（sealed/verified/quarantine/adopted）+ 凭据字段黑名单，无 base/ours/theirs 合并、无暂存区、无幂等 ID |
| **Electron IPC 契约** | 仓库无 Electron 代码；`mountPanel` 仅导出。IPC 通道名/入参校验/来源校验均无规范文件 |
| **浏览器面清零** | `client.js` 仍注入 `sidebar.panellist`、dock 徽标、`/fang/panel` 链接（397/1981/2491/2608/2782/2883/2894 行）；`/fang/panel` 路由已 404（`install-drill` 断言通过），即**死链仍在 UI** |
| **配额账本 / 端口租约 / 派生幂等** | `createTask` 只数 running/ready（无「派生中」计数）、`/api/derive` 无 `Idempotency-Key`、端口池无租约文件 |
| **不跳号的机器校验** | 规则仅写在 `docs/RELEASE-WAIVER-v3.0.7.md` 文字里；`preflight` 无「前驱版本已发布」检查 |
| **六方发布事务化** | `release.yml` 有 6 个 job，但彼此非事务：npm 成功 + Release 失败会留下半发状态；无 dry-run、无确认闸 |

### 1.4 治理事实（必须在 M0 处理）

| 事实 | 数字 |
|---|---|
| `origin/main` 是 `v3.0.7` 的祖先 | 是（`merge-base --is-ancestor` 退出码 0） |
| `v3.0.7` 领先 `origin/main` | **71 提交** |
| 本地 `main` 落后 `origin/main` | 16 提交（本地 main 停在 `14155e9`，v2.3.1） |
| npm | **未发布**（README §当前状态 ⏳，用户确认） |
| GitHub Release | `v3.0.7` 已发布（唯一） |
| 历史 tag | v3.0.7、v2.9.9、v2.9.3、v2.9.2、v2.9.0、v2.8.3、v2.3.1 …（v3.0.0–v3.0.6 按豁免永不发布） |

> 上述「71 提交不在 main」不是笔误：`tools/git/verify-release.mjs` 的头注释把它称为「重复历史」的根因——
> v2.8.3 → v3.0.7 的 tag 全部打在特性分支上，发布物与 main 各存一份。M0 必须终结这条路径。

### 1.5 并行工作流（本文件写作期间同时在建，**未提交**）

| 设施 | 作用 | 与本计划的关系 |
|---|---|---|
| `tools/git/guard-main.mjs` + `.githooks/pre-push` | 推 `main`/`release/*`/版本 tag 必须显式 `ref@完整sha` 授权（`FANG_ALLOW_PROTECTED_PUSH`） | 直接实现 G-1；**替换**我原计划的"人肉约定" |
| `tools/git/pr-gate.mjs` | PR 结构门禁：版本阶梯 / 线性历史 / 路径禁区 / 提交信息 / SPDX / 证据 | 直接实现 G-2 + A-9 |
| `tools/git/version-cut.mjs` | 一次把版本号改到位（package.json / FANG_VERSION / CHANGELOG / AUDIT）+ `--check`（跳号需 `--waiver`） | 直接实现 G-3；**取代**原计划的 `version-line.mjs` |
| `tools/git/verify-release.mjs` | tag 必须落 main first-parent + 证据齐；`--remote --private` 发布后复核 | 覆盖 A-8 与通道 C6；与本计划的 `publish-six` 互补（它做断言，我加事务与确认闸） |
| `tools/git/history-audit.mjs` | 只读体检：不在 main 的版本 tag / 0 领先分支 / 重复补丁分支 / 陈旧分支 | 为 M0 提供清理清单 |
| `docs/DUP-HISTORY-CLEANUP-v3.0.8.md` | 重复历史清理 runbook（备份→回收分支→只保留 v3.0.8 之前内容→PR；已发布 tag **只记录不移动**） | M0 的执行手册；本计划不重写步骤 |
| `docs/RELEASE-FLOW-v3.0.8-v3.3.3.md` | 单干线 + 版本闸的分支模型与每版提交/tag 时序 | 与 §11 并列；以它为准的"操作步骤"，本文为准的"架构与容量" |
| `docs/CHECKLIST-v3.0.8-v3.3.3.md` | **六方会签清单**（代码库/母体/原身/分身/插件/发布·回滚）+ 一票否决 + 72h 观察窗 | §2.1/§2.2 的口径来源；本计划只引用不复制 |
| `.github/workflows/*` | 已按上述守卫改造（+324 行） | 本计划的 A-5/A-7/A-9 依据它 |

**风险**：这些文件当前是未提交改动，若在 v3.0.8 前未合入，则本计划的相关任务退化为"自建最小版"（见 §13 D-4）。

---

## 2. 约束与治理规则（硬规则，违反即拒绝交付）

| # | 规则 | 落地方式（🄿 = 复用工作区并行设施，见 §1.5） |
|---|---|---|
| G-1 | **不推 main**（除用户明确指令） | 🄿 `tools/git/guard-main.mjs` + `.githooks/pre-push`：`main` / `release/*` / 版本 tag 的推送必须携带 `FANG_ALLOW_PROTECTED_PUSH="refs/heads/main@<40位sha>"`，且授权只对那一次提交生效；普通 `feat/*`/`fix/*` 静默放行 |
| G-2 | **PR-only** | 🄿 `tools/git/pr-gate.mjs`（版本阶梯 / 线性历史 / 路径禁区 / 提交信息 / SPDX / 证据）+ 现有 PR 模板；合并由维护者手动 |
| G-3 | **不跳号** | 🄿 `tools/git/version-cut.mjs`：一次改到位 `package.json` / `FANG_VERSION` / `CHANGELOG` / `AUDIT`，`--check` 判版本阶梯（`3.0.7→3.0.8` 允许，`3.0.7→3.0.10` 需 `--waiver` 并写 `docs/RELEASE-WAIVER-*.md`）；**新增**「前驱已发布」台账校验（§6 v3.0.9 T-309-02） |
| G-4 | **浏览器零 fang 面** | 无 `/fang/panel` 路由、无 slot 注入、无 dock、无独立 HTML；新增门禁 `tools/release/browser-surface.mjs`（v3.1.1） |
| G-5 | **PC Electron 为唯一控制台** | 所有写操作只经 Electron → IPC → 宿主路由；浏览器只跑 DSH 自身 |
| G-6 | **六方发布等用户确认** | 六方就绪 → 用户书面确认 → `release-confirm/<version>.json`（原话 + 时间 + manifest.sha256）；无此文件 `publish-six.mjs` **失败关闭**；🄿 `verify-release.mjs` 复核 tag 在 main first-parent |
| G-7 | **不静默成功** | 能力缺失返回 `{ok:false, code, reason}`；门禁 RED 不发版；缺 e2e 不绿灯（v3.0.7 已修） |
| G-8 | **写操作必须可回滚** | 三种机制之一：指针原子切换 / 快照 / 暂存目录；不允许「删了再建」的升级 |
| G-9 | **跨根一律 fail-closed** | 仅 broker 可跨根；路径逃逸、未知角色、缺失 capability → 拒绝 + 审计 |
| G-10 | **每版独立证据** | `docs/AUDIT-vX.Y.Z.md`（本机真实输出）+ `docs/CHANGELOG.md` 段 + `dist/preflight.json` |

### 2.1 「六方」是什么（与并行发布文档对齐）

仓库并行工作流已产出 `docs/CHECKLIST-v3.0.8-v3.3.3.md`，其中把「六方」定义为**六个会签域**（每版一行、六方各一列、外加维护者签核）：

| 方 | 会签域 | 与本计划章节的对应 |
|---|---|---|
| ① 代码库 | Git/仓库结构、PR 门禁、SPDX、包清单 | §11.1、G-1/G-2/G-3 |
| ② 母体 | 代际/指针/备份/回滚/`mirror` 契约 | v3.0.10、§4.3 |
| ③ 原身 | overlay/merged/recompute/冲突 | v3.0.11、v3.1.3 |
| ④ 分身 | 派生/六态/生命周期/端口 | v3.1.2、v3.2.1 |
| ⑤ 插件 | 快照/smoke/回滚/官方清单/兼容矩阵 | v3.0.12、v3.2.3 |
| ⑥ 发布·回滚 | 构建/npm/Release/Docker/healthz/回滚演练 | v3.3.2、§11.2 |

> **规则（不变）**：六方**全部**会签 + 维护者签核 → 才可发布；任一方否决即停。用户确认是第六方之后、tag 之前的最后一道人工闸。

### 2.2 六条发布通道（事务化对象）

六方是"谁签字"，通道是"发到哪"。通道来自 `.github/workflows/release.yml` 的 6 个 job：

| 通道 | job | 产物/动作 | 失败时 |
|---|---|---|---|
| C1 门禁 | `test` | 单测（node 22/24）+ 许可分层 | 阻断全部 |
| C2 构建 | `build`（self-hosted Windows） | `dist/dsh-fang-<ver>.tgz` + `.sha256` + `manifest.json`（内含 preflight.json） | 阻断全部 |
| C3 npm | `npm` | `@twinsearth/dsh-fang@<ver>` | 已发则记 `partial`，走 deprecate 手册 |
| C4 Release | `github-release` | tag 资产（tgz / sha256 / manifest） | 已发则 `partial` |
| C5 Docker | `docker` | `<user>/dsh-fang:<ver>` + `latest` | `partial`（可重跑） |
| C6 复核 | `healthz --remote` | 远端 npm + GitHub + 私有镜像比对 | `partial`，人工复核 |

> **规则**：**六条通道是一个事务**。任一 C3/C4 不可逆方已发而后续失败 → 版本状态记 `partial`，**禁止**开下一版本，先补齐或 deprecate。

### 2.3 与并行设施的分工（避免双实现）

| 能力 | 归属 | 本计划**不做**的事 |
|---|---|---|
| main 守卫 / 预推钩子 | `tools/git/guard-main.mjs` + `.githooks/pre-push` | 不再写"推送前自查"脚本 |
| PR 结构门禁 | `tools/git/pr-gate.mjs` | 不重复解析 PR 模板 |
| 版本号四处对齐 + 阶梯 | `tools/git/version-cut.mjs` | ~~`tools/release/version-line.mjs`~~（取消，改为接入 `--check`） |
| 发布完整性断言 | `tools/git/verify-release.mjs` | 不重复实现 tag/证据校验 |
| 历史体检 / 清理 runbook | `tools/git/history-audit.mjs` + `docs/DUP-HISTORY-CLEANUP-v3.0.8.md` | 不自建 main 落后统计、不重写清理步骤 |
| 六方会签清单 | `docs/CHECKLIST-v3.0.8-v3.3.3.md` | 不重写检查项；本文只引用 |
| 六条通道的**事务**与**人工确认闸** | **本计划**（v3.3.2 `publish-six.mjs`） | 只做编排 + 记账 + 确认闸，判定委托上述工具 |

### 2.4 版本序列对齐（**待确认，见 §13 D-7**）

| 来源 | 序列 |
|---|---|
| 输入文件 `v3.1.1版本.txt` | `v3.0.8 → v3.0.9 → v3.0.10 → v3.0.11 → v3.0.12`（止于此） |
| 本计划 | `3.0.8 → 3.0.9 → 3.0.10 → 3.0.11 → 3.0.12 → 3.1.0 → 3.1.1 → 3.1.2 → 3.1.3 → 3.2.0 → 3.2.1 → 3.2.2 → 3.2.3 → 3.3.0 → 3.3.1 → 3.3.2 → 3.3.3`（17 版） |
| 并行 `CHECKLIST` | 上表基础上**多一个 `v3.0.13`**（在 3.0.12 与 3.1.0 之间） |

**处置**：本计划**不跳号**的判定以"单一序列文档"为准。若最终采用 `CHECKLIST` 的 18 版序列，则在 3.0.12 与 3.1.0 之间插入：

> **v3.0.13 — 升级链收口（0 新路由，3 人日）**：三段状态只读矩阵前置校验、回滚演练记录模板、72h 观察窗机制、`ops` 面板字段冻结；纯校验与文档，不带新能力。

若采用 17 版序列，则由并行工作流把 `CHECKLIST` 的 `v3.0.13` 行删除。**两者不可并存**（否则"不跳号"有两个真相）。

---

## 3. 总体架构

### 3.1 分层

```
┌─ L5 控制面 ───────────────────────────────────────────────┐
│  PC Electron 控制台（仓库外）   ← 唯一 fang 操作入口        │
│      │ IPC（contextBridge，白名单通道 + 入参校验 + 来源校验）│
├─ L4 接口层 ───────────────────────────────────────────────┤
│  orchestrator 路由 /fang/api/*（62 → 106）                 │
│  adapter 跨进程路由 /fang/api/{hello,status,command,...}    │
│  client 半：仅导出 mountPanel 给 Electron；浏览器零注入      │
├─ L3 协调层 ───────────────────────────────────────────────┤
│  UpgradeCoordinator（重算批次）  StatusAggregator（rev/ETag）│
│  OpLedger（长任务 opId）        QuotaLedger（预留/提交/墓碑）│
│  ApprovalQueue（黄/红灯）        FlowbackArbiter（三向合并）  │
├─ L2 实体层 ───────────────────────────────────────────────┤
│  MirrorGenerationManager(新)  EssenceManager(有)            │
│  EssenceInstanceManager(新)   Forker/Supervisor(有)         │
│  PluginUpdater+SnapshotStore(新)  BranchStore(库有/待接)     │
│  McpRegistry(新)              FlowbackService(新)           │
├─ L1 信任边界 ─────────────────────────────────────────────┤
│  kernel(fsx/ledger/paths/types)  http-auth(token/Host/CSRF) │
│  roots+fs-guard(三根 fail-closed)  broker(跨根唯一通道)      │
│  compat gate（模块/路由契约）      audit 哈希链              │
├─ L0 宿主 ─────────────────────────────────────────────────┤
│  Node ≥22 · dsh CLI（每实例） · Windows/Linux 文件系统      │
└───────────────────────────────────────────────────────────┘
```

### 3.2 五个实体与地址空间

| 实体 | 地址 | 可写动作 | 禁止 |
|---|---|---|---|
| 母体 Mother | `<fangRoot>/mirror/generations/g-*`（只读代际） | 升级/回退/克隆/备份/还原 | **删除**（硬禁止） |
| 母体镜像 Mirror | `mirror/backups/*`、`mirror/current.json` | 备份、指针切换 | 原地改代际内容 |
| 运行实例 Instance | 进程（pid + port + token） | 启停、健康探针 | 被当作持久状态 |
| 原身 Essence | `essences/<id>/overlay` + `merged/` | 装插件、改设置、登录 | 开会话/任务/项目（见 §13 D-3） |
| 分身 Derived | `sessions/<forkId>/` | 会话/任务/项目 | 装插件、改设置 |

### 3.3 模块清单

| 模块 | 文件 | 现状 | 引入版本 | 依赖 |
|---|---|---|---|---|
| kernel | `src/kernel/*` | 已发布 | v1 | — |
| http-auth | `src/lib/http-auth.mjs` | 已发布 | v3.0.5 | kernel |
| mirror | `src/lib/mirror.mjs` | 已发布（破坏式升级） | v2.9.9 | kernel |
| mirror-etag | `src/lib/mirror-etag.mjs` | 已发布 | v3.0.1 | mirror |
| compat | `src/lib/compat.mjs` | 已发布 | v3.0.3 | kernel |
| essence | `src/lib/essence.mjs` | 已发布 | v2.9.3 | kernel, mutex, semaphore |
| upgrade-coordinator | `src/lib/upgrade-coordinator.mjs` | 分支（未发布） | v3.0.9 | essence |
| upgrade-status | `src/lib/upgrade-status.mjs` | 分支 | v3.0.9 | — |
| roots / fs-guard | `src/lib/roots.mjs`、`fs-guard.mjs` | 分支 | v3.0.9 | — |
| broker / broker-adapter | `src/lib/broker.mjs` | 分支（只读） | v3.0.9 | roots, fs-guard |
| branch | `src/lib/branch.mjs` | 分支（库） | v3.0.8 | fs |
| reflow | `src/lib/reflow.mjs` | 分支（库，4 态） | v3.0.8 | — |
| **generation** | `src/lib/generation.mjs` 🆕 | 不存在 | v3.0.10 | kernel, compat |
| **instance** | `src/lib/instance.mjs` 🆕 | 不存在 | v3.0.11 | forker 端口池, kernel |
| **snapshot** | `src/lib/snapshot.mjs` 🆕 | 不存在 | v3.0.12 | kernel |
| **plugin-updater** | `src/lib/plugin-updater.mjs` 🆕 | 不存在 | v3.0.12 | snapshot, compat, instance |
| **ops** | `src/lib/ops.mjs` 🆕 | 不存在 | v3.0.8 | kernel |
| **flowback** | `src/lib/flowback.mjs` 🆕 | 不存在 | v3.0.8（骨架）/ v3.1.3（三向） | essence, snapshot, ops |
| **mcp** | `src/lib/mcp.mjs` + `src/plugins/mcp.mjs` 🆕 | 不存在 | v3.1.0 | kernel, roots |
| **ipc-contract** | `src/lib/ipc-contract.mjs` 🆕 | 不存在 | v3.1.1 | — |
| **quota** | `src/lib/quota.mjs` 🆕 | 不存在 | v3.2.1 | kernel |
| **backup-seal** | `src/lib/backup-seal.mjs` 🆕 | 不存在 | v3.2.2 | kernel |

**依赖方向（架构门禁）**：`kernel ← lib ← plugins ← routes`。禁止 `lib` 反向导入 `plugins`；禁止循环导入；新增 `test/architecture.test.mjs` 静态断言（v3.1.0 起）。

### 3.4 五条不变量（写进测试）

- **I-1 母体不可删除**：任何路由/服务不得对 `mirror/generations/*` 做删除语义（GC 只能删 `retired` 且不经 API 显式删除当前代际）。
- **I-2 控制台唯一**：浏览器上下文中不存在 fang slot/路由/dock/浮层。
- **I-3 三根 fail-closed**：跨根写入必须携带 capability token，无 token → `403 root-denied` + 审计。
- **I-4 升级可回滚**：每次升级前必有可寻址的回滚点（代际指针 / 快照 ID / 暂存目录）。
- **I-5 不静默成功**：任何降级路径必须带 `code` 与 `reason`，UI 不得把 `{ok:false}` 渲染成成功。

### 3.5 失败模式与恢复矩阵

| # | 失败 | 检测 | 恢复 | 用户可见 |
|---|---|---|---|---|
| F-1 | 母体代际半写（下载中断） | `generations/.staging-*` + manifest 校验失败 | 删 staging，指针不动 | 「升级未开始，母体仍是 vX」 |
| F-2 | 指针切换后新代际不可用 | post-check（模块导入 + compat + profile 骨架比对） | 指针回滚到 `prevGen` | 「已回滚到 vX，用时 N 秒」 |
| F-3 | 原身合并 fatal | `recompute` → `conflicted` + `conflicts.json` | 保留上次 `merged/current`，旧实例继续跑 | 卡片橙灯 + 冲突明细 |
| F-4 | 影子实例起不来/探针超时 | `HealthProbe.waitForReady` 超时 | SIGKILL 子树 + 端口回收 + 保留旧实例 | 「插件 X 不兼容，已保留旧环境」 |
| F-5 | 插件更新依赖冲突 | `pnpm/npm update` 非零退出 | snapshot restore（秒级，目录级硬回滚） | 「已回滚（耗时 N 秒），日志见 op」 |
| F-6 | 分支双写 | `writer.lock`（`wx`）已存在 | `409 writer-alive`，不损坏日志 | 「该分支正在被另一个会话写入」 |
| F-7 | 陈锁（进程崩溃） | lock 内 pid 不存在 + mtime > TTL | 启动 GC / 显式 `releaseStale` | 无感 |
| F-8 | 回流重放 | `flowbackId = sha256(essenceId+taskId+baseRev+digest)` | 命中即收敛，审计 `flowback-idempotent-hit` | 「已应用过」 |
| F-9 | 回流三向冲突 | `base/ours/theirs` 逐键比 | `needs-decision` 清单，未解决不得提交 | 冲突清单（三列对照） |
| F-10 | MCP 服务挂/超时 | 握手超时 + 工具调用超时 | 熔断该 server（工具表标 `degraded`），不影响主体 | 工具不可用提示 |
| F-11 | 派生超配额/满员 | QuotaLedger 预留失败 | 同步拒绝（不再落到 forker 才报错） | 「满员 8/8」 |
| F-12 | 六方半发 | publish-six 逐步记账 | 停发下一版本 + 人工 deprecate/补发 | 发布看板 `partial` |
| F-13 | 浏览器出现 fang 面（回归） | `browser-surface` 门禁 | 门禁 RED，禁止发版 | 无（拦截在发布前） |

### 3.6 可观测性契约

所有写操作统一为 **op（长任务）**：

```json
{ "opId": "op_01J...", "kind": "mirror.upgrade|essence.sync-update|plugins.update|flowback.commit|mcp.call",
  "target": { "mirror": "...", "essenceId": "...", "forkId": "..." },
  "phase": "precheck|staging|switch|verify|done|failed|rolled-back",
  "progress": { "done": 3, "total": 7, "current": "install" },
  "startedAt": 0, "finishedAt": 0, "result": {}, "error": null }
```

- 落盘：`<fangRoot>/ops/<opId>.json`（原子写）；列表 `GET /api/ops`；
- 审计链：每个 op 的 `start/phase/end` 各一条 `appendChained` 记录（`opId` 为关联键）；
- 日志：`[fang][op=<opId>][trace=<traceId>]` 前缀；HTTP 响应带 `x-fang-op`；
- UI：Electron 控制台读 `/api/ops?active=1`（500ms 高频档，结束降回 5s/60s）。

---

## 4. 数据模型

### 4.1 磁盘布局（v3 终点形态；🆕 为新增）

```
<fangRoot>/
  mirror/
    generations/                      🆕 v3.0.10
      g-3.0.7-01/{version.json, profile/**, manifest.json(sealed)}
      .staging-<id>/                  🆕 半成品，启动 GC
    current.json                      🆕 {gen, version, prevGen, switchedAt, sha256}
    generations.json                  🆕 [{gen, version, createdAt, state: ready|retired, bytes}]
    backups/<id>/ + backups.json      ✅ 既有（v3.2.2 加 SEAL/MANIFEST）
    restore/<id>/                     ✅ 既有
    meta.json                         ✅ 既有（v3.0.10 增 generation 字段）
    active/                           ⚠️ 兼容期保留，= generations/current 的物化视图（v3.1.0 移除）
  essences/<essenceId>/
    meta.json                         ✅ 增 baseMirrorVersion / baseOverlayRev / generation
    overlay/{cordis.patch.yml,package.json,settings/*.yaml,credentials/}  ✅
    merged/<gen>/profile/**           🆕 v3.0.11 按代际分目录
    merged/current.json               🆕 {generation, mirrorVersion, fingerprint, materializedAt}
    instance.json                     🆕 v3.0.11 {pid, port, url, generation, startedAt, health}
    home/                             🆕 v3.0.11 原身配置态实例的 DSH_HOME
    snapshots/<snapId>/{manifest.json, tree/}   🆕 v3.0.12
    flowback/{inbox,quarantine}/<flowbackId>/   🆕 v3.0.8 / v3.1.3
    conflicts.json | flowback-conflicts.json    ✅ / 🆕
  sessions/<forkId>/
    session.jsonl                     ✅
    branches/<branchId>/{log.jsonl,writer.lock,meta.json}   🆕 v3.0.8
    workspaces/<branchId>/            🆕 v3.0.8（同根内，不跨根）
    meta.json                         ✅（v3.1.2 增 rev/phase）
  ops/<opId>.json                     🆕 v3.0.8
  quarantine/<flowbackId>/            🆕 v3.0.8
  ledger/audit.jsonl                  ✅ 哈希链
  compat-status.json                  ✅
  ports.json / ports-lease.json       ✅ / 🆕 v3.2.1
  tasks.json / forks.json             ✅
```

### 4.2 关键 JSON 契约

```jsonc
// mirror/current.json —— 母体指针（唯一权威，不做 symlink）
{ "gen": "g-3.0.10-01", "version": "3.0.10", "prevGen": "g-3.0.9-01",
  "switchedAt": 1762300000000, "sha256": "<canonical(上述字段)>" }

// mirror/generations/g-*/manifest.json —— 代际封印
{ "gen": "g-3.0.10-01", "version": "3.0.10", "sealed": true, "createdAt": 0,
  "digest": "<sha256 of tree>", "files": [{ "path": "profile/package.json", "sha256": "...", "bytes": 812 }] }

// essences/<id>/meta.json —— 原身状态（🆕 字段加 *）
{ "id": "essence-a1", "name": "前端组", "tier": "vip10", "parentId": null,
  "status": "ready|conflicted|stale", "locked": false, "archived": false,
  "baseMirrorVersion": "3.0.9", "*generation": "g-3.0.10-01",
  "lastMergedFingerprint": "...", "*baseOverlayRev": 7, "lastMergeConflicts": 0,
  "createdAt": 0, "updatedAt": 0 }

// essences/<id>/instance.json —— 原身配置态实例
{ "pid": 12345, "port": 18203, "url": "http://127.0.0.1:18203/?token=...",  // token 不放盘，见 SEC-07
  "generation": "g-3.0.10-01", "startedAt": 0, "health": "handshaked|no-adapter|starting" }

// sessions/<forkId>/branches/<branchId>/meta.json
{ "branchId": "main", "parentBranchId": null, "baseTurn": 0, "status": "active|sealed|archived",
  "createdAt": 0, "writer": { "pid": 1234, "at": 0 } }

// essences/<id>/flowback/<flowbackId>/proposal.json
{ "flowbackId": "fb_<sha256-16>", "essenceId": "essence-a1", "taskId": "task-9",
  "baseOverlayRev": 7, "baseFingerprint": "...", "artifacts": [{ "path": "overlay/package.json", "sha256": "..." }],
  "state": "collected|verified|quarantine|needs-decision|merged|committed|blocked", "createdAt": 0 }

// ops/<opId>.json —— 见 §3.6
```

### 4.3 指针语义（为什么不用 symlink）

| 平台 | 风险 | 决策 |
|---|---|---|
| Windows 普通用户 | `symlink` 需管理员/开发者模式；`mklink /J` 只能目录 junction 且语义与 rename 不同 | **指针文件 + 原子 rename**：写 `<root>/.current.tmp` → `fs.renameSync` → `current.json`（同卷原子） |
| 读取方 | 需要「读到旧或新，绝不半新」 | 读方只读 `current.json` 一次并缓存到进程内 per-request；`sha256` 自校验，校验失败视为损坏 → 只用 `prevGen` |
| 回滚 | 必须秒级 | 指针 rename 回 `prevGen`；不拷贝、不删文件 |

> `junction` 继续只用于 `node_modules`（既有语义），**绝不**用于代际/分支指针。

### 4.4 审计事件清单（新增）

`mirror.generation.staged` · `mirror.pointer.switched` · `mirror.pointer.rolled-back` · `mirror.generation.gc`
`essence.recompute.start|done|conflicted` · `essence.instance.start|health-failed|stopped`
`plugin.update.start|smoke-failed|rolled-back|done` · `snapshot.create|restore`
`branch.created|activated|sealed|writer-conflict|stale-lock-released`
`flowback.collected|verified|quarantine|needs-decision|committed|idempotent-hit|blocked`
`mcp.server.mounted|tool.denied|server.circuit-open`
`quota.reserve|commit|release` · `root.denied`

---

## 5. 接口契约

### 5.1 通用约定（沿用既有形状，不新造）

- 成功 `{ ok: true, ... }`；失败 `{ ok: false, code, reason, details? }`（HTTP 4xx/5xx + code）
- 所有 `POST` 需 JSON `content-type` + `x-fang-auth`（既有 http-auth）+ 同源校验
- 幂等：写操作接受 `Idempotency-Key`（v3.2.1 起强制用于 `derive`/`flowback`/`plugins/update`）
- 条件 GET：`/api/status`、`/api/tasks`、`/api/mirror/status`、`/api/upgrade/status` 支持 `If-None-Match` → `304`
- 长任务：返回 `202 { ok:true, opId }`，进度读 `GET /api/ops/<opId>`

### 5.2 错误码表（新增部分）

| code | HTTP | 含义 | 恢复 |
|---|---|---|---|
| `read-only-violation` | 409 | 只读面被写入 | 拒绝 + 审计 |
| `root-denied` | 403 | 跨根无 capability | 走 broker 授权 |
| `path-escape` | 400 | 路径逃逸 | 拒绝（既有） |
| `writer-alive` | 409 | 分支有活跃写者 | 等待/切换分支 |
| `session-locked` | 409 | 分身已有会话 | 复用已有会话 |
| `generation-missing` | 404 | 代际不存在/已 GC | 重新物化 |
| `pointer-corrupt` | 500 | 指针自校验失败 | 自动回 `prevGen` |
| `health-probe-timeout` | 504 | 影子实例不健康 | 保留旧实例 |
| `snapshot-missing` | 404 | 快照不存在 | 不可回滚，人工介入 |
| `plugin-update-conflict` | 409 | 依赖冲突 | 回滚 + 报冲突包名 |
| `mcp-tool-forbidden` | 403 | 工具在禁止暴露名单 | 拒绝 |
| `mcp-server-unavailable` | 503 | 熔断中 | 重试/换 server |
| `flowback-needs-decision` | 409 | 三向冲突未决 | 走冲突清单 |
| `flowback-blocked` | 422 | 凭据/锁定/评分 D-E/路径逃逸 | 明示不可回流原因 |
| `quota-exceeded` | 429 | 配额预留失败 | 归档/升级 tier |

### 5.3 路由增量台账（62 → 106）

| 版本 | 新增 | 累计 | 主题 |
|---|---|---|---|
| v3.0.7 | — | **62** | 基线（实测） |
| v3.0.8 | 10 | 72 | 分支 6 + 回流 4 |
| v3.0.9 | 0 | 72 | 只读面冻结（不加路由） |
| v3.0.10 | 4 | 76 | 代际/回滚/GC/ops |
| v3.0.11 | 3 | 79 | 原身同步更新/实例/停实例 |
| v3.0.12 | 4 | 83 | 插件更新/状态/快照恢复/列表 |
| v3.1.0 | 5 | 88 | MCP servers/ops |
| v3.1.1 | 1 | 89 | version/matrix |
| v3.1.2 | 1 | 90 | state/rev |
| v3.1.3 | 4 | 94 | 回流提案/决策/提交/详情 |
| v3.2.0 | 2 | 96 | roots 矩阵 / broker 授权 |
| v3.2.1 | 3 | 99 | 配额 reserve/commit/release |
| v3.2.2 | 4 | 103 | 备份 SEAL/verify/GC/列表 |
| v3.2.3 | 3 | 106 | 官方清单/刷新/兼容矩阵 |
| v3.3.x | 0 | **106** | 硬化与发布 |

> **维护规则**：每版 PR 必须同时更新 ①`tools/release/allowlist.mjs` 计数 ②`src/lib/compat.mjs` 的 `DEFAULT_EXPECTED_ROUTE_COUNT` ③`tools/e2e.mjs` 路由断言 ④`docs/API-v3.x.md`。三处不一致 → preflight RED。（v3.2.0 追加：改为 `routes.manifest.json` 单一来源，消灭三处硬编码。）

### 5.4 Electron IPC 契约（v3.1.1，仓库外实现，本仓库提供规范与校验器）

| 通道 | 方向 | 入参（校验） | 返回 |
|---|---|---|---|
| `dsh:fang:snapshot` | invoke | `{}` | 三段状态（母体/原身/插件）快照 + `rev` |
| `dsh:fang:mirror-upgrade` | invoke | `{ targetVersion }`（semver 校验，必须在 `latest` 列表内） | `{ ok, opId }` |
| `dsh:fang:essence-sync-update` | invoke | `{ essenceId }`（id 正则） | `{ ok, opId }` |
| `dsh:fang:plugins-update` | invoke | `{ essenceId }` | `{ ok, opId }` |
| `dsh:fang:op` | invoke | `{ opId }` | op 记录 |
| `dsh:fang:select-profile-dir` | invoke | `{}` | `string \| null`（仅 `dialog.showOpenDialog`） |
| `dsh:fang:event` | main → renderer | — | `{ type:'op', op } \| { type:'state', rev }` |

安全要求：`contextIsolation: true`、只暴露白名单通道、主进程对 `event.senderFrame.url` 做同源校验、路径参数 `path.resolve` + 根内约束。禁止任何 `executeShell(command)` 类万能口子。

---

## 6. 分阶段计划（17 个版本）

> 每版结构：**目标 / 范围与非范围 / 模块与接口 / 数据 / 依赖 / 验收 / 回滚 / 风险**。所有「验收」均为可执行命令或可断言事实。

### v3.0.8 — 分支运行时转正 + 回流契约 + MCP 政策面

- **目标**：把分支从「spike + 库」变成可用能力；把回流从「4 态机」变成可提交的提案骨架；把 MCP 只做到「策略与禁止暴露」层面，不接真服务。
- **范围**：分支 CRUD/切换/封存/归档 + 工作区隔离 + 单写者 409；回流 collect/verify/adopt（无三向合并，冲突一律 `needs-decision` 占位）；`GET /api/mcp/policy`（允许的 server 形态 + 禁止暴露工具名单）；`ops.mjs` 长任务账本。
- **非范围**：MCP 客户端挂载（v3.1.0）；三向合并（v3.1.3）；分支 UI（Electron，v3.1.1 起）。
- **模块/接口**
  - 新增 `src/lib/ops.mjs`：`open({kind,target}) / phase(opId,phase,progress) / close(opId,result|error) / get(opId) / list({active})`
  - 新增 `src/lib/flowback.mjs`：`collect({forkId, essenceId, paths}) → proposal`（复用 `reflow.transition`）
  - 修改 `src/plugins/orchestrator.mjs`：`+10` 路由（§5.3）
  - 修改 `src/lib/branch.mjs`：`acquireWriter` 陈锁回收（pid 存活 + TTL）
- **数据**：`sessions/<forkId>/branches/*`、`workspaces/*`、`ops/*`、`essences/<id>/flowback/inbox/*`；`meta.json` 增 `baseOverlayRev`
- **依赖**：无前置版本（分支库已在分支上）；依赖 v3.0.7 已发布的 kernel/essence/forker
- **验收（DoD）**
  - `node --test "test/*.test.mjs"`：新增 ≥22 条（分支 HTTP 8 / 回流 6 / ops 4 / 陈锁 2 / 只读防呆 2），总量 ≥ 712，fail 0
  - `node tools/release/allowlist.mjs --json` → `routes.count === 72`
  - `node tools/e2e.mjs`：新增 6 条断言 —— 建分支→切分支→删文件→切回主干文件仍在；第二写者 409；回流 collect→verify→adopt 出现在 `inbox`；`flowback` 携带 `token` 字段被拒 `flowback-blocked`
  - spike 文档升级为 `docs/BRANCH.md`（含陈锁回收与 Windows 限制）
- **回滚**：纯新增路由与目录；回滚 = `git revert` + 删除新增目录，无数据迁移
- **风险**：工作区隔离若用硬拷贝，8 分支 × 大项目会爆盘 → 限制 `workspaces` 单分支 ≤200MB，超限走「仅 main 工作区」模式并 `code:'workspace-too-large'`
- **预估**：12 人日

### v3.0.9 — 只读升级状态面冻结（收口 + 不跳号机器校验）

- **目标**：把分支上已有的 v3.0.9 代码（`upgrade-status` / `GET /api/upgrade/status` / `roots` / `broker`）收口成**可发布的只读面**，并补上「不跳号」的机器校验。
- **范围**：`/api/upgrade/status` 增 `essences[].baseMirrorVersion/stale`、ETag/304、断网静默；`docs/releases.json` 版本台账 + 接入 🄿`tools/git/version-cut.mjs --check`（版本阶梯）与 🄿`verify-release.mjs`（tag/证据）；「前驱已发布」由台账断言；只读防呆断言（只读路由不得触达任何写函数）。
- **非范围**：任何写操作按钮/路由（v3.0.10 起）；Electron 角标（v3.1.1）。
- **模块/接口**：修改 `src/lib/upgrade-status.mjs`（纯函数，加字段）；新增 `docs/releases.json` + `tools/release/releases-ledger.mjs`（仅台账读写与「前驱已发布」判定，约 60 行，不重复实现阶梯判定）；`preflight.mjs` +2 检查：`version: step via version-cut --check`、`version: predecessor released`
- **数据**：`docs/releases.json`（`[{version, releasedAt, surfaces:{npm,github,docker,healthz}}]`）
- **依赖**：v3.0.8
- **验收**
  - `node tools/git/version-cut.mjs --check --version 3.0.9` → 通过；`--version 3.0.11` 在当前 package.json 为 3.0.9 时 → 失败（跳号需 `--waiver`）\n  - `node tools/release/releases-ledger.mjs --assert-predecessor 3.0.9` → 通过（3.0.8 在台账中）；`--assert-predecessor 3.0.10` → 失败
  - `node --test`：新增 12 条（状态形状 2 / 304 2 / 断网静默 1 / 只读守卫 2 / 台账 5）
  - `node tools/e2e.mjs`：`GET /fang/api/upgrade/status` 在无官方源时返回 `{ok:true, updateAvailable:false}` 而不是 5xx
  - 静态断言：`GET /api/upgrade/status` 处理函数体内不含 `mirror.upgrade|essence.recompute|restart` 字样
- **回滚**：无状态变更；revert 即可
- **风险**：`baseMirrorVersion` 依赖 `essence.meta` 新字段，旧原身需一次性回填 → 提供 `ensureMetaBackfill()`（recompute 时补写，不做迁移脚本）
- **预估**：4 人日

### v3.0.10 — 母体代际 + 指针切换 + 秒级回滚

- **目标**：把「破坏式 `swapActive`」换成**代际 + 指针**：升级不改当前代际，失败只回滚指针。
- **范围**：`generations/` 目录、`current.json` 指针（原子 rename）、staging 校验、compat 门禁前移（对 staging 代际跑）、post-check、GC（保留 current + prev + 24h）、`POST /api/mirror/rollback`；`mirror/active` 降级为兼容视图。
- **非范围**：原身联动（v3.0.11 已有 recompute 协调器，本版仅确保 hook 触发）；宿主进程自动重启（**不做**，交给 restart-guard + Electron 提示）。
- **模块/接口**
  - 新增 `src/lib/generation.mjs`：`stage(version) → {gen, dir}`、`verify(gen)`、`switchTo(gen)`、`rollback() → prevGen`、`gc({keep})`、`readPointer()`
  - 修改 `src/lib/mirror.mjs`：`upgrade()` 改为委托 `generation`；`restore()` 保留（针对 backups），新增 `restoreGeneration(gen)`
  - 路由：`GET /api/mirror/generations`、`POST /api/mirror/rollback`、`POST /api/mirror/gc`、`GET /api/ops/<opId>`（+4 → 76）
- **数据**：`mirror/generations/*`、`mirror/current.json`、`mirror/generations.json`；`meta.json` 增 `generation`
- **依赖**：v3.0.9（只读状态是前置观测面）
- **验收**
  - 崩溃注入：`stage` 阶段抛错 → 指针不变、`generations/.staging-*` 被清、`GET /api/mirror/status` 仍报旧版本
  - 切换成功：`current.json` 的 `gen/prevGen/switchedAt/sha256` 自校验通过；`GET /api/mirror/generations` 两个 ready 代际
  - 回滚：`POST /api/mirror/rollback` 后 `current.json.gen === prevGen`，耗时 <500ms（本机实测）
  - 隔离：升级期间一个运行中的分身任务不中断（e2e：起任务 → 升级 → 任务仍 `running`）
  - 幂等：连续两次 `rollback` 第二次返回 `{ok:false, code:'already-previous'}`
  - 单测新增 ≥18（generation 12 / mirror 委托 4 / 路由 2），总量 ≥ 740
- **回滚**：本版自身可用 `rollback` 自证；代码回滚 = revert（`active/` 兼容视图保证旧代码仍能跑）
- **风险**：磁盘占用翻倍 → GC 策略（keep=2 + 24h）+ 升级前 `diskSpace` 预检（需 ≥2.5× 代际体积）；Windows rename 跨卷失败 → 强制 staging 与 `current.json` 同卷
- **预估**：10 人日

### v3.0.11 — 原身重算 + 影子实例 + 健康检查 + 切换

- **目标**：母体换代后，把任一原身安全地拉到新代际：**影子实例先健康，再切流量**；失败保留旧实例。
- **范围**：`EssenceInstanceManager`（启动/停止/探针/端口段 18200–18300）、`merged/<gen>/` 按代际分目录、`merged/current.json` 指针、影子启动 → 探针 → 优雅停旧 → 指针切；`POST /api/essence/sync-update`、`GET /api/essence/instance`、`POST /api/essence/instance/stop`。
- **非范围**：插件级更新（v3.0.12）；原身实例是否能开会话（术语冲突见 §13 D-3）。
- **模块/接口**
  - 新增 `src/lib/instance.mjs`：`start(essenceId, {generation, port}) → {pid,port,url}`、`probe(instance, {timeoutMs}) → {ok, health}`、`stop(instance, {graceful})`、`list()`
  - 修改 `src/lib/essence.mjs`：`materializeMerged` 写 `merged/<gen>/profile` + `merged/current.json`；`recompute(essenceId, {generation})`
  - 修改 `src/lib/upgrade-coordinator.mjs`：批次内按代际并发重算（已有 concurrency 4）
  - +3 路由 → 79
- **数据**：`essences/<id>/merged/<gen>/`、`merged/current.json`、`instance.json`、`home/`
- **依赖**：v3.0.10（代际 ID 是重算的输入）、v3.0.9（协调器已在分支上）
- **验收**
  - 探针：注入一个语法错误的 overlay 插件 → 影子实例 `health-probe-timeout` → 旧实例仍 `running`、`merged/current` 不变、UI 状态 `conflicted/health-failed`
  - 正常切换：`merged/current.generation === 新代际`；`instance.json.pid` 变化；旧实例 pid 不存在（无僵尸）
  - 端口：连续 5 次 sync-update 无端口泄漏（`ports.json` 与 `instance.json` 一致）
  - 目录清理：成功后旧 `merged/<oldGen>` 被 GC（保留 1 个）
  - 单测新增 ≥16，总量 ≥ 756；e2e 新增 5 条
- **回滚**：指针回 `merged/previous`；`POST /api/essence/instance/stop` 可强制清场
- **风险**：原身实例资源占用（每个 ≈1 个 dsh 进程）→ 默认**懒启动**（只有用户点「配置」才起），批量重算只做物化不启实例（`materializeOnly: true`）
- **预估**：14 人日

### v3.0.12 — 插件更新 + 快照/冒烟/回滚

- **目标**：原身「一键更新插件」在**可秒级回滚**的前提下可用。
- **范围**：`SnapshotStore`（目录级、manifest + 内容寻址、可插拔 backend）、`PluginUpdater`（snapshot → update → smoke → rollback）、`POST /api/plugins/update`、`GET /api/plugins/update/status`、`POST /api/plugins/snapshot/restore`、`GET /api/plugins/list`。
- **非范围**：VM 级快照（见 §13 D-2：仓库内无 `dsh-plugin-vm-sandbox`，先做 `SnapshotBackend = dir`，接口留 `vm` 位）。
- **模块/接口**
  - 新增 `src/lib/snapshot.mjs`：`create({root,label}) → {snapId,manifest}`、`restore(snapId)`、`verify(snapId)`、`gc({keep})`
  - 新增 `src/lib/plugin-updater.mjs`：`plan(essenceId)`（读 overlay + 现装清单 → 目标版本）、`apply(opId, plan)`（执行 `pnpm update`/`npm install`，**在 essences/<id>/home 内**，不走宿主）
  - smoke = `dsh --profile <merged> --dump-config`（行数/插件 apply）+ 模块导入 + `runCompatGate` + 实例探针（若实例在跑）
  - +4 路由 → 83
- **数据**：`essences/<id>/snapshots/<snapId>/{manifest.json,tree/}`；`ops` 记录 phase `snapshot→update→smoke→rollback`
- **依赖**：v3.0.11（冒烟需要能起/探测实例）、v3.0.3 的 compat gate
- **验收**
  - 故意把某插件 pin 到与镜像主版本冲突的依赖 → `plugin-update-conflict` → 快照恢复后 `overlay/package.json` 与更新前 **逐字节一致**（sha256 比对）
  - 冒烟失败注入（插件 `apply` throw）→ 回滚成功、耗时记录 <60s、实例仍健康
  - 快照空间：单快照 ≤50MB、保留 3 个；GC 后 manifest 与目录一致
  - 单测新增 ≥20，总量 ≥ 776；e2e 新增 6 条
- **回滚**：`POST /api/plugins/snapshot/restore {snapId}`
- **风险**：`pnpm` 依赖网络与 registry 可用性 → 失败即回滚 + `registry-unreachable` 明确码（不静默）
- **预估**：12 人日

### v3.1.0 — MCP 接入（客户端 + 工具投影 + 禁止暴露）

- **目标**：让 MCP server 成为**可挂载、可熔断、可审计**的能力源，且**绝不暴露控制面工具**。
- **范围**：`McpRegistry`（server 配置 CRUD、stdio/HTTP 传输、工具发现、命名空间 `mcp_<server>_<tool>`）、长任务 op（`opId` + `abandon_op` 语义：不停止服务）、熔断、env 白名单、禁止暴露名单（`promote/adapter/session-bridge/restart/mirror.*`）、`fang-mcp` 插件行（16 → 17 行）。
- **非范围**：MCP server 自身实现；跨机器 MCP。
- **模块/接口**
  - 新增 `src/lib/mcp.mjs` + `src/plugins/mcp.mjs`（服务 key `fangMcp`）
  - 路由 +5 → 88：`GET/POST /api/mcp/servers`、`GET/POST /api/mcp/ops`、`POST /api/mcp/ops/<opId>/abandon`
  - 工具投影只给**分身/原身配置态实例**；母体自身不挂第三方 MCP
- **数据**：`<fangRoot>/mcp/servers.json`（无凭据落盘：凭据走实例 env 注入或 OS keychain 占位）、`mcp/ops/*.json`
- **依赖**：v3.0.8 的 ops；v3.0.5 的 env 白名单
- **验收**
  - MCP-01：长任务调用立即返回 `opId`，轮询 `GET /api/mcp/ops/<opId>` 得到结果；重放同 `Idempotency-Key` 只执行一次
  - MCP-02：`POST .../abandon` 明确返回 `{stopped:false, reason:'abandon-does-not-stop-server'}`
  - MCP-03：对每个已挂载 server，断言工具表**不含** `promote|adapter|session-bridge|restart|mirror` 前缀；命中即 `mcp-tool-forbidden` + 审计
  - 熔断：server 连续 3 次超时 → `mcp-server-unavailable`，主体路由不受影响
  - 行数门禁：`package-smoke` / e2e 的「16 行」断言同步改为 **17 行**（同一 PR 内改，否则 RED）
  - 新增 `test/architecture.test.mjs`（依赖方向 + 无环）
  - 单测新增 ≥24，总量 ≥ 800
- **回滚**：移除 `fang-mcp` 行（配置级）+ 路由 revert
- **风险**：MCP 是**外部内容来源** → 与 `reflow`/`session-bridge` 同一信任级：工具输出视为数据，不进入系统提示；工具名/描述做注入特征扫描（新增 `assertToolDescriptorSafe`）
- **预估**：10 人日

### v3.1.1 — 升级路径控制台 + IPC 桥 + 浏览器面清零

> 对应输入文件 `v3.1.1版本.txt` 的四步升级路径。**本版是本计划与用户路线图对齐的关键版本。**

- **目标**：Electron 控制台上「母体同步/一键更新 → 原主同步&更新 → 插件一键更新」三段可见、可点、可回滚；浏览器彻底没有 fang 面。
- **范围**
  1. `GET /api/version/matrix` 三段状态（母体 `current/latest/updateAvailable`、原身 `baseMirrorVersion/needsRecompute`、插件 `outdatedCount`）
  2. `src/lib/ipc-contract.mjs`：通道名常量 + 入参 schema + `assertChannelPayload()`（Electron 与本仓库共用）
  3. `client.js` **清零**：删除 `sidebar.panellist` 注入、dock 徽标、`/fang/panel` 全部链接；保留 `mountPanel` 导出（Electron 壳专用）
  4. `tools/release/browser-surface.mjs` 门禁
  5. `docs/IPC-CONTRACT.md`（给 Electron 仓库的实现说明）
- **非范围**：Electron 壳本体（仓库外，需另一 PR 流）；升级进度 UI 的视觉稿。
- **接口**：+1 路由 → 89；7 个 IPC 通道（§5.4）
- **数据**：`version-matrix` 为纯组合（不落盘）；`ops` 复用
- **依赖**：v3.0.10/11/12 三条升级链全部可用（否则按钮是死的，禁止上线死按钮）
- **验收**
  - `node tools/release/browser-surface.mjs` → `{ ok:true, findings:[] }`：断言 ①无 `/fang/panel` 路由 ②`client.js` 无 `sidebar.*` 注入 ③无 `<a href="/fang/panel"` ④无 `registerPanel`
  - `node tools/e2e.mjs`：dump-config 仍 ≥17 行、client half 仍物化（`{inject, apply}`），但断言「browser slots 未被注入」
  - `node tools/ui-rich-smoke.mjs`（desktop panel harness）通过：4 个状态位（idle/updating/success/failed）× 3 段
  - `GET /api/version/matrix` 在断网时 `{ok:true, mirror:{updateAvailable:false, degraded:'offline'}}`（静默降级，不 5xx）
  - IPC 契约测试：伪造 `essenceId: '../etc'` → `assertChannelPayload` 抛错
  - 单测新增 ≥16，总量 ≥ 816
- **回滚**：路由与 client 变更可 revert；浏览器面清零**不回滚**（安全约束）
- **风险**：删 slot 会打破既有 UI 用例（`test/ui-cases.test.mjs` 与 e2e 5 条断言）→ 必须同 PR 更新，且**先把 Electron 壳的 `mountPanel` 通路验证通过**再删
- **预估**：12 人日

### v3.1.2 — 状态同步单一真相（rev/ETag/六态/轮询统一）

- **目标**：消灭「同一事实三处各算一遍」与「5s/8s/10s 三套轮询」；`starting/stopping` 不再被伪装成 `failed`。
- **范围**：`snapshot.rev` + `ETag`（`/api/status`、`/api/tasks`）、六态 `starting|running|stopping|failed|crashed|archived`、`taskView` 纯函数化、会话列表 N+1 收敛（并发 ≤8、30s 缓存、折叠即停）、`GET /api/state/rev`、陈旧响应丢弃（`rev` 单调）。
- **非范围**：SSE 推送（v3.2.x 再评估）；跨机同步。
- **模块/接口**：修改 `orchestrator.taskView`、`status-store.mjs`（接线路由/UI 消费者）、`session-catalog`（缓存）；+1 路由 → 90
- **数据**：`tasks.json`/`sessions/*/meta.json` 增 `phase/startedAt/stopRequestedAt/exit`；`state.rev` 全局单调计数（落盘 `state-rev.json`）
- **依赖**：v3.1.1（Electron 消费方已在）
- **验收**
  - G1/G2/G3 回归：派生窗口内 `phase === 'starting'`（≤200ms 可见）、并发派生 10 个不超卖、归档期 `stopping` 不闪 failed
  - 304：两次 `GET /api/status` 第二次命中 304 且不替换引用（`useSyncExternalStore` 引用稳定）
  - 轮询：同一时间只有一条活跃轮询（5s 活跃 / 60s 空闲 / 页面隐藏暂停）
  - N+1：8 个分身、卡片全折叠时，5s 内 `tasks/sessions` 请求数 = 0
  - 单测新增 ≥20，总量 ≥ 836
- **回滚**：`rev` 为新增字段，旧 UI 忽略即可；ETag 可关（配置）
- **风险**：`state.rev` 落盘写放大 → 批量合并（≤1 次/秒）
- **预估**：10 人日

### v3.1.3 — 三向合并回流（base / ours / theirs）

- **目标**：把 v3.0.8 的「提案骨架」升级为**可自动合并、冲突上浮、幂等、原子**的回流。
- **范围**：三向合并矩阵（patch 条目 / settings / package.json / 删除 / 新增）、冲突分级（auto/merged/needs-decision/blocked）、`flowbackId` 幂等、staging + 原子 swap + recompute、冲突清单（Electron）、`flowback-conflicts.json`。
- **非范围**：凭据回流（**永久禁止**）；会话/日志回流（只允许「下载导出 + 人工导入」）。
- **接口**：+4 路由 → 94：`POST /api/flowback/propose`、`GET /api/flowback/<id>`、`POST /api/flowback/<id>/decide`、`POST /api/flowback/<id>/commit`
- **数据**：`flowback/<id>/proposal.json|base/|theirs/`、`flowback-conflicts.json`；审计 `flowback-*`
- **依赖**：v3.0.8（骨架）、v3.1.2（rev 用于陈旧丢弃）、`essence.materializeMerged`
- **验收**
  - 快速前进：`ours.rev === baseRev && fingerprint 未变` → 直接 apply，无冲突清单
  - 逐键冲突：两侧改同一 `settings.routing.timeout` → `needs-decision`，未解决 `commit` 返回 409
  - 幂等：同参数重复 `propose` → 同一 `flowbackId`；审计含 `flowback-idempotent-hit`
  - blocked：`credentials/**` 变更 → `flowback-blocked`，不回显明文
  - 原子性：`commit` 中途杀进程 → 重启后 `merged/current` 要么旧要么新（`staging` 残留被 GC）
  - 单测新增 ≥22，总量 ≥ 858
- **回滚**：`commit` 前自动 `snapshot.create(label:'pre-flowback-<id>')`，可 `snapshot.restore`
- **风险**：三向合并是**语义密集**区（`REVIEW-三区隔离与快照回流.md §7.3`）→ 先写矩阵测试再写实现（测试先行）
- **预估**：14 人日

### v3.2.0 — 三根 fail-closed 强制 + broker 唯一通道

- **目标**：把 `roots.mjs` 的访问矩阵从「库 + 单测」变成**路由级强制**。
- **范围**：所有读写路径经 `broker`（携带 capability token）；`GET /api/roots/matrix`；`POST /api/broker/grant`（默认关闭，仅协调器内部调用）；跨根拒绝审计；路径逃逸统一 `path-escape`；`routes.manifest.json` 单一来源替换三处硬编码。
- **接口**：+2 → 96
- **依赖**：v3.0.9 roots（分支）、v3.1.3（回流已走同一通道）
- **验收**
  - 角色矩阵 4×3×2 = 24 组全断言（母体 Web 只读母体根、原身只读母体根 + 读写自己、分身只读所属原身 + 读写自己 session）
  - 无 capability 的跨根写 → `403 root-denied` + 审计 1 条
  - `routes.manifest.json` 与 allowlist/e2e/compat 三处一致（单一来源生效）
  - 单测新增 ≥18，总量 ≥ 876
- **回滚**：broker 有 `enforce:false` 灰度位（默认 false → 只记不拦；本版末翻 true）
- **风险**：强制后可能打断既有 62 路由中的隐式跨根读写 → 先跑「影子模式」一周（审计不拦），再翻 enforce
- **预估**：8 人日

### v3.2.1 — 配额账本 + 端口租约 + 派生幂等

- **目标**：满员/超配额在**受理时**判定；派生可重复点击不产生双实例。
- **范围**：`QuotaLedger`（reserve/commit/release/墓碑，计入 `starting`）、`ports-lease.json` 租约（TTL + pid 存活）、`Idempotency-Key` 强制（derive/flowback/plugins-update）、`POST /api/quota/*`。
- **接口**：+3 → 99
- **依赖**：v3.1.2（六态里的 `starting` 是配额输入）
- **验收**
  - 并发 10 派生（`maxForks=8`）→ 8 成功 + 2 `quota-exceeded`，无 forker 层 `max-forks` 报错
  - 同 `Idempotency-Key` 双击 → 1 个分身（第二次返回同一 taskId）
  - 进程崩溃后墓碑 TTL 到期释放；端口租约无泄漏（100 次派生后 `ports.json` 条目 ≤ 活跃数 + 2）
  - 单测新增 ≥18，总量 ≥ 894
- **回滚**：账本为新增文件；`enforce:false` 可退回仅统计
- **风险**：墓碑回收误判（任务仍在派生）→ 墓碑与 forker 记录双源核对，冲突以 forker 为准
- **预估**：8 人日

### v3.2.2 — 备份封印（SEAL/MANIFEST）+ 崩溃注入 + 启动 GC

- **目标**：备份/代际「缺文件不记成功」；任何中断都不留半成品。
- **范围**：`backup-seal.mjs`（`manifest.json` + `SEAL` + `verify`）、`POST /api/backups/{seal,verify,gc}`、`GET /api/backups`、启动 GC（`.staging-*`、`.swap-*`、expired tombs）、崩溃注入测试套（MIR-07）。
- **接口**：+4 → 103
- **依赖**：v3.0.10 代际、v3.0.12 快照
- **验收**
  - 删掉备份里一个文件 → `verify` 失败，`restore` 拒绝（不静默恢复半套配置）
  - 在 7 个阶段（stage/verify/switch/post-check/compat/GC/rollback）各注入一次 kill → 重启后自洽（无 `pointer-corrupt`、无孤儿 staging）
  - GC 幂等：连续两次启动 GC，第二次 0 删除
  - 单测新增 ≥16，总量 ≥ 910
- **回滚**：SEAL 为新增旁路文件；旧备份无 SEAL 时按「未封印」处理（只读可恢复、不记成功）
- **风险**：GC 误删正在使用的代际 → GC 只删 `state==='retired'` 且 `!= current && != prev`
- **预估**：8 人日

### v3.2.3 — 官方插件清单版本化 + 兼容矩阵

- **目标**：插件清单与 DSH 版本解耦发布；compat 结论可操作化。
- **范围**：`plugins/official`（清单版本 + 与母体代际的兼容区间）、`POST /api/plugins/official/refresh`、`GET /api/compat/matrix`（模块 × 代际 × 结论 + 修复建议）、compat findings → 可点击动作（禁用/替换/等待）。
- **接口**：+3 → 106
- **依赖**：v3.2.2（封印的代际是可测矩阵维度）
- **验收**
  - 清单刷新：新增一个插件条目 → 原身 `recompute` 后 `pluginCount` 变化，锁定项不可被禁用（既有规则）
  - 兼容矩阵：注入一个只在新代际可导入的模块 → 矩阵给出 `{module, generation, ok:false, suggestion}`
  - compat 失败时子插件保持关闭（既有语义不回退）
  - 单测新增 ≥14，总量 ≥ 924
- **回滚**：清单版本可回退（`plugins/official@prev`）
- **风险**：清单与 `package.json` 依赖并集冲突 → 清单只声明「安装+激活状态」，不声明版本区间
- **预估**：6 人日

### v3.3.0 — 长稳与性能（REL 全量）

- **目标**：把「demo 能跑」变成「跑一周不塌」。
- **范围**：REL-01..05（8h 空闲内存 <10% 增长、100 任务首屏 <1s、磁盘满、崩溃重启、并发 10 派生）、计时器泄漏审计、`sampleResources` 趋势记录、soak 脚本。
- **接口**：0 新路由（106 冻结）
- **验收**
  - `node tools/soak.mjs --hours 8` 报告：RSS 增长 <10%、句柄数不增长、无 pending timer 泄漏
  - 100 任务 `GET /api/tasks` 首屏 <1s（P95）
  - 磁盘满：`quota-exceeded`/`enospc` 明确码，索引不损坏
  - 单测新增 ≥10，总量 ≥ 934
- **回滚**：无契约变更
- **风险**：soak 需要专用机器时间 → 排到发布窗口前的空档
- **预估**：10 人日

### v3.3.1 — 安全复审（注入 / token / IPC / 审计覆盖）

- **目标**：把"外部内容视为敌意"落成代码与测试。
- **范围**：MCP 工具描述与输出注入扫描、`reflow`/`flowback` 产物特征扫描、token 生命周期（内存 only、不落盘、不进 URL——已有 SEC-07 扩展）、IPC 入参/来源校验双端测试、审计覆盖率报告（每个写路由至少 1 条事件）。
- **验收**
  - 注入语料 30 条（工具描述/输出/回流产物）→ 全部被标 `suspicious` 且不进入系统提示
  - 审计覆盖：106 路由中所有写路由（POST）100% 有对应审计事件
  - token：`tasks.json`/`forks.json`/`instance.json`/`ops/*` 无 `token` 字段（静态扫描 + e2e 断言）
  - 单测新增 ≥16，总量 ≥ 950
- **回滚**：扫描默认 `warn`，可按版本翻 `block`
- **风险**：误报导致功能不可用 → 分级 + 白名单（可审计）
- **预估**：8 人日

### v3.3.2 — 六方发布事务化 + 确认闸

- **目标**：发布是一件事务，不是六个脚本。
- **范围**：`tools/release/publish-six.mjs`（`--dry-run` / `--confirm`）**只做编排与记账**，判定委托既有工具（`build.mjs` / `healthz.mjs` / `package-smoke.mjs` / 🄿`tools/git/verify-release.mjs`）；`release-confirm/<ver>.json` 确认文件校验（用户原话 + 时间 + manifest.sha256）；逐步记账 `dist/publish-<ver>.json`；失败即停 + 不可逆方 deprecate 手册；`release.yml` 改为调用该脚本。
- **验收**
  - `--dry-run` 全绿且**不产生**任何远端副作用（断言 npm view 无新版本、无新 Release）
  - 无 `release-confirm/<ver>.json` → 退出码 1，输出「需用户确认」
  - 确认文件哈希不匹配（版本/时间/用户原话被改）→ 拒绝
  - 模拟 C5 失败 → 状态 `partial`，后续版本发布被 `releases-ledger --assert-predecessor` 与 `version-cut --check` 双重拦截
  - 单测新增 ≥10，总量 ≥ 960
- **回滚**：脚本可回退；已发 npm 版本走 deprecate（不可 unpublish）
- **风险**：six-party 定义若与用户口径不同（§13 D-1）→ 本任务排在确认之后
- **预估**：6 人日

### v3.3.3 — GA 收口

- **目标**：文档、门禁、边界、发布一次对齐，宣布 GA。
- **范围**：`docs/ARCHITECTURE.md` 重写为 v3 终态、`GLOSSARY`/`UI-瓮城入口`/`CONTRACTS` 终检（浏览器零 fang 面表述统一）、`TEST-PLAN` 全量勾选、`CHANGELOG v3.3.3`、`AUDIT-v3.3.3`、六方发布执行（**等用户确认后**）。
- **验收**
  - `node tools/release/preflight.mjs --e2e` GREEN（单测 ≥960、e2e 全绿、sha256 匹配）
  - `node tools/release/browser-surface.mjs` GREEN
  - `node tools/git/version-cut.mjs --check --version 3.3.3` GREEN + `node tools/release/releases-ledger.mjs --assert-predecessor 3.3.3` GREEN
  - 六方 `publish-six.mjs --confirm release-confirm/3.3.3.json` 全绿，`healthz --remote` 通过
  - 文档一致性：`GLOSSARY` 与代码命名零冲突（脚本断言关键字）
- **回滚**：发布不可回滚 → 只允许 deprecate + 补发
- **预估**：5 人日

---

## 7. 里程碑与排期（2 人并行，1 人日 = 1 dev-day）

| 里程碑 | 版本 | 交付判据 | 人日 | 累计 | 周（2 人） |
|---|---|---|---|---|---|
| M0 治理归位 | — | 释放线回到 main（PR 合并 71 提交或书面豁免）；`guard-main` + `version-cut --check` 可用 | 3 | 3 | 0.5 |
| M1 分支/回流地基 | v3.0.8 | 72 路由、分支 e2e 6 条 | 12 | 15 | 2.5 |
| M2 只读面冻结 | v3.0.9 | 只读防呆 + 不跳号校验 | 4 | 19 | 3 |
| M3 母体代际 | v3.0.10 | 指针切换 + 秒级回滚 e2e | 10 | 29 | 5 |
| M4 原身代际 | v3.0.11 | 影子实例健康后才切 | 14 | 43 | 7.5 |
| M5 插件可回滚 | v3.0.12 | 快照回滚逐字节一致 | 12 | 55 | 9.5 |
| M6 MCP | v3.1.0 | 禁止暴露 + 熔断 | 10 | 65 | 11 |
| M7 控制台唯一化 | v3.1.1 | 浏览器零 fang 面 GREEN | 12 | 77 | 13 |
| M8 单一真相 | v3.1.2 | 六态 + rev/304 + 轮询收敛 | 10 | 87 | 15 |
| M9 三向回流 | v3.1.3 | 冲突上浮 + 幂等 + 原子 | 14 | 101 | 17.5 |
| M10 纵深 | v3.2.0–3.2.3 | fail-closed + 配额 + 封印 + 矩阵 | 30 | 131 | 22.5 |
| M11 硬化 | v3.3.0–3.3.1 | soak + 安全复审 | 18 | 149 | 25.5 |
| M12 GA | v3.3.2–3.3.3 | 六方事务化 + 发布 | 11 | 160 | 27 |

> 注：G-6 规定每个版本都要用户确认六方发布，因此**日历时间 = 开发时间 + 17 × 发布窗口（约 0.5 人日 + 用户确认等待）**。若按每版一个发布窗口串行，最快 6–7 个月；若用户授权"每 2–3 版合并确认一次"（需书面），可压缩到 4–5 个月。

---

## 8. 验收标准

### 8.1 全局 DoD（每版必须全部满足）

| # | 门 | 命令 | 通过条件 |
|---|---|---|---|
| A-1 | 版本一致 | `preflight` | package.json / `FANG_VERSION` / CHANGELOG 段 三者一致 |
| A-2 | 不跳号 | `version-cut --check --version <ver>` + `releases-ledger --assert-predecessor <ver>` | 阶梯合法且前驱已发布 |
| A-3 | 单测 | `node --test --test-concurrency=1 "test/*.test.mjs"` | fail=0；总量 ≥ 上版基线 + 新增数（§9 列明） |
| A-4 | e2e | `node tools/e2e.mjs` | N/N 全绿（当前 66，逐版增加，见各版） |
| A-5 | 路由契约 | `allowlist --json` | count = 台账值；findings=0 |
| A-6 | 浏览器零 fang 面 | `browser-surface` | findings=0 |
| A-7 | 构建 | `build.mjs` | tarball + sha256 + manifest + package-smoke + allowlist |
| A-8 | 文档 | `docs/CHANGELOG.md` + `docs/AUDIT-vX.Y.Z.md` + `docs/API-v3.x.md` | 三件齐 |
| A-9 | PR | `gh pr create` | PR 模板全项填写；未直接推 main |
| A-10 | 六方确认 | `release-confirm/<ver>.json` | 用户书面确认存在 |

### 8.2 版本级"不许合并"红线

- 出现「死按钮」（UI 有入口、后端无能力）→ 禁止合并（对应 v3.1.1 前置依赖要求）
- 出现「静默降级」（失败返回 `ok:true`）→ 禁止合并
- 升级类 PR 无回滚点 → 禁止合并
- 路由计数未同步（allowlist / compat / e2e 三处）→ 禁止合并

---

## 9. 任务队列

> 完整机器可读版本：`docs/plan/tasks-v3.json`（字段：`id/version/title/depends_on/files/acceptance/estimate_days/lane`）。
> 下面按版本列出**可派工**的任务卡，`lane` 相同者可并行（不同人/不同分支）。

### v3.0.8（12 人日）

| ID | 任务 | 依赖 | 文件 | 验收 | 人日 | lane |
|---|---|---|---|---|---|---|
| T-308-01 | ops 长任务账本 | — | `src/lib/ops.mjs`, `test/ops.test.mjs` | open/phase/close/get/list 6 条测试 | 1.5 | A |
| T-308-02 | branch 库补陈锁回收 | — | `src/lib/branch.mjs` | 死 pid 锁可回收、活 pid 拒绝 2 条 | 1 | A |
| T-308-03 | 分支 HTTP（6 路由） | 02 | `orchestrator.mjs` | 建/切/封/档/日志/列表 | 3 | B |
| T-308-04 | 分支工作区隔离 | 02 | `orchestrator.mjs`, `workspaces/*` | 删文件后切回仍在；>200MB 拒绝 | 2 | B |
| T-308-05 | 回流 collect/verify（4 路由） | 01 | `src/lib/flowback.mjs` | 凭据字段拒绝；inbox 落位 | 2.5 | C |
| T-308-06 | MCP 政策只读路由 + 禁止名单常量 | — | `orchestrator.mjs`, `src/lib/mcp-policy.mjs` | 名单含 promote/adapter/session-bridge | 0.5 | C |
| T-308-07 | e2e 新增 6 条 + 路由计数 72 | 03,04,05 | `tools/e2e.mjs`, `allowlist`, `compat` | e2e 全绿 | 1 | D |
| T-308-08 | 文档 `docs/BRANCH.md` + CHANGELOG/AUDIT | 全部 | docs | 三件齐 | 0.5 | D |

### v3.0.9（4 人日）

| ID | 任务 | 依赖 | 文件 | 验收 | 人日 | lane |
|---|---|---|---|---|---|---|
| T-309-01 | upgrade-status 增 `baseMirrorVersion/stale` + ETag | 308 | `upgrade-status.mjs`, `orchestrator` | 304 命中、字段齐 | 1.5 | A |
| T-309-02 | `docs/releases.json` + `releases-ledger.mjs`（复用 `version-cut --check`） | — | `docs/releases.json`, `tools/release/releases-ledger.mjs` | 3.0.9 通过 / 3.0.10 失败 | 1.5 | B |
| T-309-03 | preflight 接入 version-cut + ledger | 02 | `preflight.mjs` | 少一环即 RED | 0.5 | B |
| T-309-04 | 只读防呆静态断言 | 01 | `test/upgrade-status.test.mjs`, `tools/e2e.mjs` | 处理函数无写调用 | 0.5 | A |

### v3.0.10（10 人日）

| ID | 任务 | 依赖 | 文件 | 验收 | 人日 | lane |
|---|---|---|---|---|---|---|
| T-310-01 | generation.mjs（stage/verify/switch/rollback/gc） | — | `src/lib/generation.mjs` | 12 条单测 | 3.5 | A |
| T-310-02 | mirror.upgrade 委托 generation | 01 | `src/lib/mirror.mjs` | 旧测试等价通过 | 2 | A |
| T-310-03 | 指针原子性与自校验 | 01 | `generation.mjs` | 半写→指针不变；sha 不匹配→用 prev | 1.5 | B |
| T-310-04 | compat 门禁前移到 staging | 01 | `orchestrator`, `compat` | compat 失败不发指针 | 1 | B |
| T-310-05 | 4 条路由 + 崩溃注入 e2e | 02,03 | `orchestrator`, `e2e` | 7 阶段注入通过 | 1.5 | C |
| T-310-06 | 磁盘预检 + GC 策略 + 文档 | 01 | `generation.mjs`, docs | ≥2.5× 预检；keep=2/24h | 0.5 | C |

### v3.0.11（14 人日）

| ID | 任务 | 依赖 | 文件 | 验收 | 人日 | lane |
|---|---|---|---|---|---|---|
| T-311-01 | instance.mjs（start/probe/stop/list） | — | `src/lib/instance.mjs` | 端口段/探针/无僵尸 3 组测试 | 3.5 | A |
| T-311-02 | merged 按代际分目录 + 指针 | 310 | `src/lib/essence.mjs` | `merged/current.json` 正确 | 3 | A |
| T-311-03 | 影子启动→探针→切流量 | 01,02 | `orchestrator` | 注入坏插件→保留旧实例 | 3 | B |
| T-311-04 | recompute 协调器按代际批次 | 02 | `upgrade-coordinator.mjs` | 并发 4 / 60s / 失败隔离 | 1.5 | B |
| T-311-05 | 3 条路由 + 端口泄漏测试 | 03 | `orchestrator`, `e2e` | 5 次连续无泄漏 | 2 | C |
| T-311-06 | 目录 GC + 文档 | 02 | `essence.mjs`, docs | 旧 merged 保留 1 | 1 | C |

### v3.0.12（12 人日）

| ID | 任务 | 依赖 | 文件 | 验收 | 人日 | lane |
|---|---|---|---|---|---|---|
| T-312-01 | snapshot.mjs（create/restore/verify/gc） | — | `src/lib/snapshot.mjs` | 逐字节还原 8 条 | 3 | A |
| T-312-02 | SnapshotBackend 接口 + dir 实现 | 01 | `snapshot.mjs` | 可插拔（vm 占位抛 `unsupported`） | 1 | A |
| T-312-03 | plugin-updater plan/apply | 01 | `src/lib/plugin-updater.mjs` | 依赖冲突→回滚 | 3 | B |
| T-312-04 | smoke（dump-config + import + compat + probe） | 03,311 | `plugin-updater.mjs` | 4 项任一失败即回滚 | 2 | B |
| T-312-05 | 4 条路由 + e2e 6 条 | 03,04 | `orchestrator`, `e2e` | 回滚耗时记录 | 2 | C |
| T-312-06 | 快照空间治理 + 文档 | 01 | `snapshot.mjs`, docs | ≤50MB/份，保留 3 | 1 | C |

### v3.1.0（10 人日）

| ID | 任务 | 依赖 | 文件 | 验收 | 人日 | lane |
|---|---|---|---|---|---|---|
| T-3100-01 | mcp.mjs（registry/transport/tools） | 308 ops | `src/lib/mcp.mjs` | 挂载/发现/命名空间 | 3.5 | A |
| T-3100-02 | 禁止暴露 + 工具描述注入扫描 | 01 | `mcp.mjs` | MCP-03 断言 + 30 语料 | 2 | A |
| T-3100-03 | 熔断 + 超时 + env 白名单 | 01 | `mcp.mjs` | 3 次超时→circuit-open | 1.5 | B |
| T-3100-04 | 5 条路由 + fang-mcp 行（16→17） | 01 | `plugins/mcp.mjs`, `cordis.patch.yml` | 行数门禁同步改 | 2 | B |
| T-3100-05 | `test/architecture.test.mjs` 依赖方向 | — | test | 无环、lib 不导入 plugins | 1 | C |

### v3.1.1（12 人日）

| ID | 任务 | 依赖 | 文件 | 验收 | 人日 | lane |
|---|---|---|---|---|---|---|
| T-3111-01 | `/api/version/matrix` 三段状态 | 310,311,312 | `orchestrator`, `upgrade-status` | 三段字段 + 断网降级 | 2 | A |
| T-3111-02 | `ipc-contract.mjs` + 校验器 | — | `src/lib/ipc-contract.mjs` | 7 通道 + 路径注入拒绝 | 2 | A |
| T-3111-03 | `docs/IPC-CONTRACT.md`（给 Electron 仓库） | 02 | docs | 通道/入参/来源校验齐 | 1 | B |
| T-3111-04 | `client.js` 浏览器面清零（保 mountPanel） | — | `client.js` | 无 slot/dock/面板链接 | 2.5 | C |
| T-3111-05 | `browser-surface.mjs` 门禁 + preflight 接入 | 04 | `tools/release` | findings=0 才 GREEN | 1.5 | C |
| T-3111-06 | UI 用例迁移（删除项 → desktop harness） | 04 | `test/ui-cases`, `ui-rich-smoke` | 用例不减少（迁移） | 2 | D |
| T-3111-07 | e2e 断言：client 物化但无 slot | 04 | `tools/e2e.mjs` | 2 条新断言 | 1 | D |

### v3.1.2（10 人日）／v3.1.3（14 人日）／v3.2.x（30 人日）／v3.3.x（29 人日）

| ID | 任务 | 依赖 | 验收 | 人日 |
|---|---|---|---|---|
| T-3112-01 | `snapshot.rev` + ETag（status/tasks） | 3111 | 304 且引用稳定 | 2.5 |
| T-3112-02 | 六态 taskView（starting/stopping/crashed） | 3112-01 | G1/G2/G3 回归 | 2.5 |
| T-3112-03 | 会话列表 N+1 收敛（并发 8/缓存 30s/折叠即停） | — | 全折叠时 0 请求 | 2 |
| T-3112-04 | 轮询统一（5s/60s/隐藏暂停）+ status-store 接线 | 01 | 只一条活跃轮询 | 2 |
| T-3112-05 | `GET /api/state/rev` + 陈旧丢弃 | 01 | rev 单调 | 1 |
| T-3113-01 | 三向合并矩阵（先测试后实现） | 308 | 矩阵 6 类全覆盖 | 4 |
| T-3113-02 | 冲突分级 + 清单 + decide | 01 | needs-decision 409 | 3 |
| T-3113-03 | flowbackId 幂等 + 审计 | 01 | 重复提交收敛 | 2 |
| T-3113-04 | staging + 原子 swap + recompute | 01 | kill 后自洽 | 3 |
| T-3113-05 | 4 条路由 + e2e | 02,03,04 | 5 条 e2e | 2 |
| T-320-01 | broker 强制（影子→enforce） | 309 roots | 24 组矩阵 | 4 |
| T-320-02 | `routes.manifest.json` 单一来源 | — | 三处不再硬编码 | 2 |
| T-320-03 | 2 条路由 + 审计覆盖 | 01 | 拒绝即审计 | 2 |
| T-321-01 | QuotaLedger（reserve/commit/release/墓碑） | 3112 | 10 并发不超卖 | 3 |
| T-321-02 | 端口租约 + Idempotency-Key | 01 | 双击 1 实例 | 3 |
| T-321-03 | 3 条路由 + 优雅关闭 | 01 | 墓碑释放 | 2 |
| T-322-01 | backup-seal（SEAL/MANIFEST/verify） | 310,312 | 缺文件不记成功 | 3 |
| T-322-02 | 启动 GC + 7 阶段崩溃注入 | 01 | 重启自洽 | 3 |
| T-322-03 | 4 条路由 + 文档 | 01 | GC 幂等 | 2 |
| T-323-01 | 官方清单版本化 | 322 | 刷新后 pluginCount 变 | 2 |
| T-323-02 | 兼容矩阵 + 修复建议 | 322 | 注入模块→矩阵结论 | 2.5 |
| T-323-03 | 3 条路由 + 文档 | 01,02 | 无回归 | 1.5 |
| T-330-01 | soak 脚本 + 8h 报告 | 全部 | RSS <10% 增长 | 3 |
| T-330-02 | 性能基线（100 任务 <1s） | — | P95 <1s | 2 |
| T-330-03 | 磁盘满/崩溃重启/并发派生 | 321 | REL-02..05 | 3 |
| T-330-04 | 定时器/句柄泄漏审计 | — | 无泄漏 | 2 |
| T-331-01 | 注入语料 30 条 + 分级 | 3100,3113 | 不进入系统提示 | 3 |
| T-331-02 | token 零落盘静态扫描 + e2e | — | 4 类文件无 token | 2 |
| T-331-03 | IPC 双端校验测试 | 3111 | 伪造入参拒绝 | 2 |
| T-331-04 | 审计覆盖报告（写路由 100%） | 320 | 无遗漏 | 1 |
| T-332-01 | publish-six.mjs（复用 build/healthz/verify-release）+ 确认文件校验 | 全部 | dry-run 无副作用 | 3 |
| T-332-02 | release.yml 改造 + partial 手册 | 01 | C5 失败→partial | 2 |
| T-332-03 | 单测与文档 | 01,02 | ≥10 条 | 1 |
| T-333-01 | 文档终态（ARCHITECTURE/GLOSSARY/CONTRACTS/TEST-PLAN） | 全部 | 零冲突断言 | 3 |
| T-333-02 | 六方发布执行（等确认） | 332 | 全绿 + healthz | 2 |

---

## 10. 风险登记册

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R-1 | **发布线不在 main**（71 提交），tag 与 main 脱节 | 已发生 | 高 | M0 先做：PR 合并或书面豁免；此后每版合并后再 tag |
| R-2 | 「六方发布」口径与用户不同 | 中 | 高 | §13 D-1 待确认；`publish-six` 参数化 surface 定义 |
| R-3 | VM 沙箱缺席（`vm_snapshot` 不存在）导致 v3.0.12 设计与实现错位 | 高 | 中 | `SnapshotBackend` 抽象；`dir` 先落地；VM 作为未来 backend |
| R-4 | 原身实例与术语表冲突（原身不得开会话） | 高 | 中 | §13 D-3；默认「配置态」+ 懒启动 + fang 层拒绝 sessions 根 |
| R-5 | 路由计数三处硬编码（62/allowlist/e2e）漂移 | 高 | 中 | 每版同 PR 同步；v3.2.0 改 manifest 单一来源 |
| R-6 | 浏览器面清零打破既有 UI 用例 | 高 | 低 | 同 PR 迁移用例；先验证 Electron `mountPanel` 通路 |
| R-7 | 代际磁盘翻倍 | 中 | 中 | 预检 ≥2.5×；keep=2/24h；GC 幂等 |
| R-8 | 三向合并语义复杂、易回归 | 中 | 高 | 测试先行（矩阵先写）；快速前进路径优先 |
| R-9 | npm 已发但 Release 失败 → 半发 | 中 | 高 | 事务化发布 + `partial` 状态拦截下一版 |
| R-10 | MCP 成为注入与提权新入口 | 中 | 高 | 禁止暴露名单 + 工具描述扫描 + 熔断 + 只挂派生侧 |
| R-11 | 不跳号压力导致合并版本 | 中 | 中 | 规则：宁可拆版本、不可并版本；`version-cut --check` 强制 |
| R-12 | Electron 壳在仓库外，契约双侧漂移 | 中 | 中 | `ipc-contract.mjs` 共用 + 通道版本号 + 兼容矩阵测试 |

---

## 11. PR 与发布流程

### 11.1 分支与 PR

```
main（PR-only，维护者合并）
 └─ feat/v3.0.8-branch-runtime      ← 一个版本一个分支（可再拆 feat/...-part2）
      ├─ 代码 + 测试 + 文档（CHANGELOG 段 / AUDIT / API / PLAN 更新）
      ├─ PR：填全模板（版本、路由增量、门禁输出、回滚方式、无 main push 声明）
      └─ 维护者合并 → main → 打 tag vX.Y.Z（annotated）
```

- **禁止**：`git push origin main`（会被 🄿`.githooks/pre-push` 直接 DENY，除非携带 `ref@sha` 授权）、`git tag` 前跳过 preflight、一个 PR 跨两个版本号、PR 里夹带未声明的路由。
- **PR 模板必填项（在现有 `.github/PULL_REQUEST_TEMPLATE.md` 上追加）**：`version`、`routes: 62→N`、`preflight: <GREEN 摘要>`、`browser-surface: GREEN`、`rollback:`、`六方确认: 待/已`。
- **合并后打 tag 前**：`node tools/git/verify-release.mjs --tag vX.Y.Z --no-artifact`（tag 必须落在 main 的 first-parent）。

### 11.2 发布时序（每版）

```
1) PR 合并到 main（维护者）
2) 本地/CI：preflight --e2e GREEN + browser-surface GREEN + `version-cut --check` GREEN + `guard-main` 放行
3) build（self-hosted Windows）→ tgz + sha256 + manifest + package-smoke
4) ★ 人工确认闸：用户书面确认 → release-confirm/<ver>.json（原话+时间+manifest.sha256）
5) publish-six --confirm=<file>：C3 npm → C4 Release → C5 Docker → C6 healthz → `verify-release --remote`
6) 记账 dist/publish-<ver>.json + docs/releases.json + CHANGELOG/AUDIT 归档
7) 失败：状态 partial，禁止开下一版；按手册补发或 deprecate
```

> ★ 是唯一的「人类在环」闸门。它不存在时，脚本**失败关闭**。

---

## 12. 不做清单（NOT ESTABLISHED，明确排除在 v3.3.3 之外）

1. 母体的**删除**（永久禁止；只有克隆/重建/备份/还原）。
2. 凭据（credentials/token）进入 `merged/`、快照、回流、审计、日志。
3. 浏览器的任何 fang UI（面板/浮层/dock/独立 HTML 路由）——包括"临时兜底面板"。
4. 分支**合并**回父分支（分支不可合并，封存即只读）。
5. 会话/日志「回流」到原身（只允许下载导出 + 人工导入）。
6. 母体宿主进程的自动重启（只经 restart-guard 审批 + Electron 提示；`allowProcessRestart` 保持 false）。
7. VM/容器级隔离后端（`SnapshotBackend='vm'` 只留接口，不实现；容器路由仍只做决策）。
8. 跨机器 Relay 协作、云端备份、团队权限（付费五项仍不在范围）。
9. 浏览器级截图回归（Playwright）——除非另行决策。
10. 端口池扩容（18000–18100 保持；原身实例用独立的 18200–18300 段）。

---

## 13. 待用户确认的决策（阻塞项按序）

| # | 决策 | 默认取向（未确认即按此执行） | 影响版本 | 阻塞度 |
|---|---|---|---|---|
| **D-1** | 「六方发布」= 六个**会签域**（代码库/母体/原身/分身/插件/发布·回滚）还是六条**发布通道**（CI job）？ | 已按并行 `CHECKLIST` 采用"六个会签域"，并把六 job 降级为"六条通道"（§2.1/§2.2）；若用户另有口径，只需改这两张表 | v3.0.8 起每版 | **已降级（口径已可用）** |
| **D-2** | v3.0.12 是否必须等 `dsh-plugin-vm-sandbox`（`vm_snapshot`）就绪？ | 不等：先做目录级 `SnapshotBackend=dir`，接口留 VM 位 | v3.0.12 | 中 |
| **D-3** | 原身是否允许有自己的 Web 实例并发起会话（术语表当前禁止） | 允许"配置态实例"，fang 层拒绝 `sessions` 根；开会话仍禁止 | v3.0.11 | 中 |
| **D-4** | M0 是否现在就把 71 个提交以 PR 方式合回 `main`（需维护者执行合并；🄿`guard-main` 要求 `refs/heads/main@<sha>` 显式授权） | 是：先 M0 再开 v3.0.8；如不允许，则记书面豁免并在每版 PR 中声明基线分支 | M0/v3.0.8 | 高 |
| **D-5** | 发布确认粒度：每版一次，还是每 2–3 版合并一次 | 每版一次（最安全，日历最长） | 全区间 | 中 |
| **D-6** | 工作区里并行设施（`tools/git/*`、`.githooks/`、workflow 改动）是否随 v3.0.8 一并合入 | 随 v3.0.8 一并合入（它们正是 G-1/G-2/G-3 的实现）；否则本计划相关任务退化为最小自建版 | v3.0.8 | 高 |
| **D-7** | 版本序列是否包含 **v3.0.13**（并行 `CHECKLIST` 有、本计划无） | 采用 **17 版**（无 3.0.13）；若要保留，则按 §2.4 插入"升级链收口"版（+3 人日，0 新路由） | v3.0.12 → v3.1.0 | 高（"不跳号"必须只有一个真相） |

---

## 14. 变更记录

| 日期 | 内容 |
|---|---|
| 2026-11-05 | 首版计划稿：事实基线（v3.0.7 已发布 / 8 提交在分支 / 缺口清单）、17 版编排、62→106 路由台账、任务队列 **77 张卡 / 157 人日**、12 项风险与 5 个待确认决策 |
| 2026-11-05 | 复审修订：发现工作区存在**并行建设**的 `tools/git/*`（guard-main / pr-gate / version-cut / verify-release / history-audit）+ `.githooks/pre-push` + workflow 改动；据此取消自建 `version-line.mjs`，G-1/G-2/G-3 改为复用（§1.5、§2.3），新增决策 D-6；v3.0.9 任务 T-309-02/03 与 v3.3.2 范围同步改写 |
| 2026-11-05 | 二次修订（对齐并行发布文档）：采用 `CHECKLIST` 的「六方 = 六个会签域」口径，原六 job 改称「六条发布通道」（§2.1/§2.2，D-1 由阻塞降级）；发现并登记版本序列冲突 `v3.0.13`（§2.4、D-7）；§1.5 增列 `DUP-HISTORY-CLEANUP` / `RELEASE-FLOW` / `CHECKLIST` 三份并行文档 |
