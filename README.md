[![CI](https://github.com/TwinsEarth/dsh-fang/actions/workflows/ci.yml/badge.svg)](https://github.com/TwinsEarth/dsh-fang/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE-CORE)
[![SDK: MIT](https://img.shields.io/badge/SDK-MIT-green.svg)](LICENSE-SDK)
[![npm latest](https://img.shields.io/npm/v/@twinsearth/dsh-fang.svg?label=npm&color=red)](https://www.npmjs.com/package/@twinsearth/dsh-fang)


# 瓮城：DSH 的第一台虚拟机！

> Dsh-瓮城，诞生于一群热爱折腾、也被折腾过无数次的极客之手。
> 我们深知在「自进化 AI」时代，**「如何安全地尝试新事物」比「新事物本身」更重要**。

## 如果你是以下三类人，瓮城就是为你量身定制的

### 1. 插件开发狂魔
每天要写 N 个新插件、改几百次代码。以前改一次重启一次 DSH；现在在瓮城里随便热更新，坏了直接秒回滚。

### 2. 多任务并发狂
一个窗口跑数据分析，一个窗口写爬虫，一个窗口做长周期测试。瓮城让你像开浏览器一样「多开不崩」，并且各跑各的绝对隔离。

### 3. 安全焦虑症患者
不敢把客户端交给第三方插件，怕乱删文件、怕被盗取 API Key。瓮城的审核系统和独立沙箱，把危险代码安排得明明白白。

---

## 它怎么做到

**母体大脑 + 分身器官 + 容器兜底**：

- 一个只读母体，每个任务派生一个用完即弃的子 dsh-Web；
- 开发都在分身里，母体只在「提升」时被显式更新；
- 崩溃不扩散、污染不残留、插件不串味。

> 技术定位：**DeepSeek Harness 的第一台虚拟机**。
> 用 dsh-Web 当瓮城完成风险阻隔与审批（Beta），把 DeepSeek Harness 当主城保存原样不变（稳定版）。

---

> v2.3.1 把「瓮城」做进 Web UI（左侧导航 + 3:7 分屏控制面板 + 双击派生 + 母体/分身会话继续开发）；
> v2.0.0 按三层拓扑重新部署，
> 新增 **Adapter** 跨进程桥、任务语义、端口池、干净模板、Router 双阶段、评分环境阈值、
> 审计汇总、容器执行与申报写代理、商用钩子。

## 当前状态（2026-11-01，v2.3.1）

- UI：左侧导航「瓮城」（红色城门图标）· 中列控制面板 **3:7 分屏**（左=母体项目&会话，右=分身项目&会话，两栏独立滚动）· dock 徽标双击快速派生；
- 测试：**292 tests / 291 pass / 0 fail / 1 skip**（skip = `FANG_CONTAINER_LIVE=1` 手动容器探针，已单独跑 **9/9**）；
- 实机端到端：`node tools/e2e.mjs` → **41/41 checks passed**（临时 `$DSH_HOME` + 真实 dsh 母体 + 真分身：
  派生 → Adapter 握手 → 角色矩阵 → 任务/分身会话标题 → 归档 → 审计链 → 回收）；
- desktop profile 已挂 `@local/dsh-fang` bundle 层（通过 `link:` 指到本仓库，包版本 2.3.1）；
- ✅ v2.1.0 的「瓮城」UI 已在运行中的宿主生效（活体实测）：`sidebar.panellist` 有 `id=fang`（order 90, active）、
  `main` 的 key `fang` 已注册、dock 的 `fang-badge` active；宿主行 `include:fang-session-catalog` 已加载。
- 🔧 v2.3.1（3:7 分屏面板 + 分身会话 API + 会话原生标题 + 僵尸防护）代码与测试已就绪；
  宿主侧需**重启**加载、页面刷新即可看到新布局与新标题。
  交付与证据见 [docs/v2.3.1-交付报告.md](docs/v2.3.1-交付报告.md) 与 [docs/UI-瓮城入口.md](docs/UI-瓮城入口.md)。
- ✅ v2.3.1 已发布：GitHub Release 附 `dsh-fang-2.3.1.tgz` + `manifest.json`，CI/compat 全绿；
- ⏳ npm：`@twinsearth/dsh-fang@2.3.1` 构建与本地 healthz 已就绪，等待 npm 组织 `@twinsearth` 创建后发布；
- 🔒 **main 为 PR-only**：直接 push 会被拒绝；变更走分支 + PR + 维护者手动审核合并（见 [CONTRIBUTING](CONTRIBUTING.md)）。

---

## v2.1.0 新增入口

- 左侧导航「**瓮城**」：红色城门图标（`sidebar.panellist`）；单击 → 中列控制面板；双击图标 → 快速派生并打开分身标签页。
- 控制面板（`main` key=`fang`）：任务列表 + 母体已有会话列表，**选中 → 确认条 → 继续开发**（会话走 ≤32KiB lineage 种子）。
- 输入框 dock 徽标：单击开面板，双击快速派生（可发现性提示在 tooltip 里）。

规格与平台约束见 [docs/UI-瓮城入口.md](docs/UI-瓮城入口.md)；交付记录见
[docs/v2.3.1-交付报告.md](docs/v2.3.1-交付报告.md)。

## 快速开始

```powershell
git clone https://github.com/TwinsEarth/dsh-fang.git && cd dsh-fang

# 1. 离线自检（不修改任何东西）
node tools/fangctl.mjs doctor
node tools/fangctl.mjs status

# 2. 全量单测（node v24 不接受目录参数）
node --test --test-concurrency=1 "test/*.test.mjs"

# 3. 实机端到端验收（临时 $DSH_HOME + 真实 dsh 母体 + 真分身，不碰你的 profile）
node tools/e2e.mjs

# 4. 安装到当前 profile（DSH 内 plugin_manager install_bundle，target = 本目录）
```

安装后刷新页面：输入框下方出现「瓮城 N/M」徽标，点「门户」进入 `/fang/panel`：

- **派生新任务**：端口池确定性分配（18000–18100）、独立 `$DSH_HOME`、干净模板、Adapter 握手后 `ready`；
- **打开**：带 token 的分身标签页；
- **归档**：先让分身 flush 缓冲并落审计，再 kill 进程树 + 安全删除 home（junction 只解链）；
- **提升插件…**：跨进程取源码 → 母体阈值复核 → Router 初判 → 审批 → A/B 备份 → 母体 staging。

---

## 十二个插件（部署矩阵）

| 行 id | 模块 | 母体 | 分身 | 职责 | 服务 key |
|---|---|---|---|---|---|
| `fang-orchestrator` | orchestrator.mjs | ✅ | ❌ | 任务语义：create/status/promote/archive、门户 | `fang` |
| `fang-forker` | forker.mjs | ✅ | ❌ | 端口池、spawn/kill、junction、URL 解析 | `fangForker` |
| `fang-restart-guard` | restart-guard.mjs | ✅ | ❌ | 母体重启唯一闸门（只决策/审批/审计） | `fangRestart` |
| `fang-scorer` | scorer.mjs | ✅（复核） | ✅（主） | 静态 A–E + 动作灯色，阈值按环境分叉 | `fangScorer` |
| `fang-umbrella` | umbrella.mjs | ✅ | ✅ | 保护伞：A–E 下限抬高动作灯色 + allow/mark/ask/delegate/deny | `fangUmbrella` |
| `fang-router` | router.mjs | ✅（初判） | ✅（复核） | decide / confirm（只升不降）/ 容器分支 | `fangRouter` |
| `fang-healer` | healer.mjs | ❌ | ✅ | 自检/证据/G1–G12/补丁建议（不放行） | `fangHealer` |
| `fang-approver` | approver.mjs | ✅（汇总） | ✅（本地） | 待批队列/A-B/监控/回滚 | `fangApprover` |
| `fang-hot-reloader` | hot-reloader.mjs | ❌ | ✅ | 真 ESM 换版 + 健康窗 | `fangHotReloader` |
| `fang-buffer-keeper` | buffer-keeper.mjs | ❌ | ✅ | 三态监视 + 容器申报写代理 | `fangBuffer` |
| `fang-auditor` | auditor.mjs | ✅ | ✅ | 双侧哈希链审计 + aggregate | `fangAudit` |
| `fang-adapter` | adapter.mjs | ❌ | ✅ | 跨进程桥：HTTP 控制/状态/审批/审计 | `fangAdapter` |

契约：[CONTRACTS-V2.md](docs/CONTRACTS-V2.md) · 协议：[PROTOCOL-V2.md](docs/PROTOCOL-V2.md) ·
架构：[ARCHITECTURE-V2.md](docs/ARCHITECTURE-V2.md) · 变更：[CHANGELOG.md](docs/CHANGELOG.md)。
发布：[RULES-BASELINE.md](docs/RULES-BASELINE.md)（规则基线） · [RELEASE-MIRROR.md](docs/RELEASE-MIRROR.md)（公共/私有仓发布管理）。

---

## 安全与边界

- 角色矩阵由 `src/kernel/role.mjs` 单点决定；`DSH_FANG_ROLE=fork` 由 forker 注入，分身无法自升为母体。
- 数据目录：`$DSH_HOME/fang/<profileTag>/`；分身各用自己的 `$DSH_HOME`，天然隔离。
- 分身 `node_modules` 指向母版 junction；删除必须走 kernel `removeTree()`（junction 只解链）。
- 审计是哈希链 `sha256(canonical(record)+prevHash)`，可发现改字段/删行/换序/伪造追加。
- 红灯不可被自动批准绕过：`strictRedLine=true` 时 `risk==='red'` 必须显式 `decide()`；无人应答 fail-closed。
- 容器写代理：容器内插件无直接写权限，写请求必须落在 bufferRoot 内 + 命中申报名单 + ≤1MB。
- `parseWebUrl` 只认带 `?token=` 的启动行——裸地址 401。

---

## 已知限制（v2.0.0，诚实清单）

AppContainer **真实执行**需 `FANG_CONTAINER_LIVE=1` 手动探针（CI 只覆盖降级路径）；
Job Object 层未接入；分身会话迁移/跨宿主接管未做；Relay 付费五项只有钩子与配置开关。
v1 运行中的宿主缓存旧模块，v2 生效需母体重启（红线：由用户确认执行）。
完整清单见 [ARCHITECTURE-V2.md](docs/ARCHITECTURE-V2.md) §8。

---

## 许可证（分层）

| 层 | 路径 | 协议 | 你能做什么 |
|---|---|---|---|
| **核心层** | `src/` · `probes/` · `client.js` · `cordis.patch*.yml` · `test/` · `tools/e2e.mjs` | **AGPL-3.0-or-later** | 自由使用/修改；**对外提供网络服务时须按 AGPL 提供源码** |
| **生态层** | `sdk/` · `tools/fangctl.mjs` | **MIT** | 零摩擦复制、修改、二次分发、闭源集成 |
| **商业层** | `relay-server/` · `enterprise/` | 商业许可（闭源） | 需购买许可；不随开源分发包 |

- 逐目录许可地图：[NOTICE](NOTICE)；方案与边界分析：[docs/LICENSING.md](docs/LICENSING.md)。
- 许可全文：[LICENSE-CORE](LICENSE-CORE) · [LICENSE-SDK](LICENSE-SDK) · [LICENSE-COMMERCIAL](LICENSE-COMMERCIAL)。
- 贡献前请阅读并签署 [CLA.md](CLA.md)（用于双许可证与商业授权）。
- 商业授权/OEM：`licensing@example.com`（占位，发布前替换）。
- 本仓库不含第三方运行时依赖；vendored schemastery/cosmokit 保留上游 MIT（见 [LICENSES/cordis-MIT.txt](LICENSES/cordis-MIT.txt)）。
- 所有源码文件头带 `SPDX-License-Identifier`；`test/licensing.test.mjs` 防止分层漂移。
