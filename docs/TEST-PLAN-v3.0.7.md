# dsh-Fang 测试计划与测试用例（v3.0.7 基线 / v3.0.8 预置）

> 状态：评审稿（未提交）。适用版本：v3.0.7；v3.0.8 用例标注「预置」。
> 目标：用风险驱动的方式覆盖安装、权限、数据、UI、升级、发布与故障恢复，并给出可执行的自动化/手动划分。

## 1. 范围

**范围内**
- 安装/升级/回滚/发布产物（tarball、sha256、profile bundle、client loader row）；
- 三层权限：母体（mirror）/ 元主（essence）/ 分身（derived）与 HTTP 鉴权（B1–B8）；
- 元主 CRUD、默认元主、配额与 locked 校验；
- 分身生命周期、列表契约字段、归档/删除、单会话 1:1（v3.0.8）；
- UI 三区控制台、Mother 浮层、双击重命名、data-* 钩子；
- 镜像备份/升级/回滚、compat 门禁、ETag；
- 分支切换/回流、MCP op 适配器（v3.0.8 预置）；
- 可靠性：崩溃恢复、并发、路径安全、数据不丢失。

**范围外（本期不做）**
- 浏览器级像素截图回归（当前用 vm 物化 + DOM 断言；是否引入 Playwright 待决策）；
- 云厂商/第三方商业 provider（commercial hooks）；
- 非 Windows 平台的真实分身启动（CI 仅 Windows 自托管）；
- 大规模多租户/计费系统。

## 2. 质量门禁

### 2.1 进入准则
- 代码冻结在目标版本提交；`git status` 干净；
- `node --test` 全绿；`tools/e2e.mjs` 环境可用（真实 dsh CLI + Windows）。

### 2.2 退出准则（P0 全绿才可发布）
1. `preflight --e2e` **GREEN**，且 `e2e` 字段非 null（当前已强制）；
2. 641+ 单测全绿、e2e 63/63（v3.0.7 基线）；
3. `dist/*.tgz.sha256` 与 tarball 一致，`preflight` 校验 `match`；
4. 干净 profile 安装后：16 个 `fang-*` 行 + 1 个 `ui-fang` 行全部 active，页面无 `invalid plugin`；
5. P0 安全用例（AUTH/路径/凭据）全部通过；
6. 无 P0/P1 未关闭缺陷；P1 允许带规避方案发布但需记录。

### 2.3 缺陷等级
- **P0**：数据丢失、越权、母体不可启动、页面完全不可用、发布物不可安装；
- **P1**：核心功能不可用/需重启绕过、配额超卖、状态错误导致误操作；
- **P2**：局部体验/文案/非关键字段缺失；**P3**：建议类。

## 3. 环境与工具矩阵

| 环境 | 用途 | 要求 |
|---|---|---|
| 本机 Windows（开发） | 单测、e2e、构建 | Node 22/24；真实 dsh CLI；仓库根 `<repo>` |
| 自托管 Windows runner | 发布门禁 | 能启动真实 dsh；`RUN_E2E=1` 语义 |
| GitHub ubuntu runner | 单测/许可/纯逻辑 | 无真实 dsh，不跑 e2e |
| 干净 profile | 安装回归 | 新建 `$DSH_HOME`，不引用 live junction |

工具：
- `node --test --test-concurrency=1 "test/*.test.mjs"`
- `node tools/e2e.mjs`（真实母体 + 真分身）
- `node tools/release/preflight.mjs --e2e`
- `node tools/release/build.mjs`
- `node tools/release/healthz.mjs`
- `dsh --profile <p> --dump-config`（行完整性/客户端行）
- 浏览器：Chrome/Edge，手动 UI 验收与截图存档

## 4. 风险驱动的重点（R1–R10）

| ID | 风险 | 对应用例域 |
|---|---|---|
| R1 | client half 未物化 → 页面插件报错 | PKG/UI |
| R2 | 发布跳过 e2e 仍绿灯 | PKG |
| R3 | token 进 URL/落盘 → 泄漏 | SEC |
| R4 | 路径穿越/压缩炸弹 → 读写越界 | SEC |
| R5 | 官方元主被抢占/锁定失效 | ESS |
| R6 | 归档/删除误删生产数据 | DRV |
| R7 | 配额超卖/满员后仍请求 | ESS/DRV |
| R8 | 升级/回滚丢母体或备份不可信 | MIR |
| R9 | 分支并发写坏会话 | BR（预置） |
| R10 | 回流把被污染配置带回工厂 | BR（预置） |

## 5. 分层与自动化映射

| 层 | 工具 | 现有覆盖 | 缺口 |
|---|---|---|---|
| 单元 | node:test | kernel/fsx/mirror/essence/compat/auth/bundle 等 | 配额账本、分支 refs |
| 集成（插件内） | node:test + 假 webServer | orchestrator/session-sync/adapter | actions/blocks、UI 状态 selector |
| 真机 e2e | tools/e2e.mjs | 母体启动、派生、归档、鉴权、client 物化、行完整性 | 干净 profile 安装、分支切换、回流 |
| 发布物 | preflight/build/healthz | e2e 强制、sha256、allow-list | 干净 profile 安装自动断言 |
| 安全 | 单测 + e2e | B1/B2/B3/B4/B5/B6/B8 回归 | B7/B9/B10、CSRF 浏览器实测 |
| UI | e2e DOM + 手动 | loader/物化/面板可达 | `data-btn-id`/`data-reason` 断言、双击重命名 e2e |

## 6. 用例目录

状态：✅ 已自动化/已覆盖；🟡 部分覆盖；⬜ 计划；🔒 手动。

### 6.1 安装/升级/发布（PKG）

| ID | 优先级 | 用例 | 期望 | 状态 |
|---|---|---|---|---|
| PKG-01 | P0 | 干净 profile 安装 3.0.7 tarball | 启动成功；16 `fang-*` + 1 `ui-fang` active | ⬜ |
| PKG-02 | P0 | 页面加载 client half | 无 `invalid plugin`；面板/徽章可见 | 🔒（需重启） |
| PKG-03 | P0 | `preflight` 不带 `--e2e` | RED：`e2e: required` | ✅ |
| PKG-04 | P0 | `preflight --e2e` | GREEN；e2e 非 null | ✅ |
| PKG-05 | P0 | tarball 与 `.sha256` | 哈希一致；缺失/不匹配 → RED | ✅ |
| PKG-06 | P0 | `release.yml` 无自托管 runner | release job 失败而非跳过 e2e | ✅（配置级） |
| PKG-07 | P1 | 重复注册检查 | `ui-fang` 行唯一；无双面板 | 🔒 |
| PKG-08 | P1 | 回滚 `ui-fang` 行 | 移除后启动正常（客户端功能降级但服务端健康） | 🔒 |
| PKG-09 | P2 | 安装包内容 | 104 entries；含 client.js/cordis.patch.yml；无 dist 污染 | ✅ |

### 6.2 鉴权与安全（SEC）

| ID | 优先级 | 用例 | 期望 | 状态 |
|---|---|---|---|---|
| SEC-01 | P0 | 无 token 请求 `/fang/api/tasks` | 401 unauthorized | ✅ |
| SEC-02 | P0 | 错误 token / 长度相同 | 401（恒定时间比较） | ✅ |
| SEC-03 | P0 | 非 loopback Host | 403 bad-host | ✅ |
| SEC-04 | P0 | 跨站 Origin / `Sec-Fetch-Site: cross-site` | 403 | ✅ |
| SEC-05 | P0 | POST 非 JSON content-type | 415 | ✅ |
| SEC-06 | P0 | `auth-token` bootstrap 带坏 Host/Origin | 403 | ✅ |
| SEC-07 | P0 | token 不出现在任务列表/URL/tasks.json | 无 `token=`；tasks.json 无 token | ✅ |
| SEC-08 | P0 | adapter fork 无 `DSH_ADAPTER_TOKEN` | 控制面 401（fail-closed） | ✅ |
| SEC-09 | P0 | 会话包 `../` 路径穿越 | 跳过/拒绝，无越界写读 | ✅ |
| SEC-10 | P0 | 导入超大文件/超过数量 | 跳过并记录；不 OOM | ✅ |
| SEC-11 | P1 | SSE `eventsUrl` token | 已知例外：仍 query；记录风险 | 🟡 |
| SEC-12 | P1 | session-sync 路由鉴权 | v3.0.6 未接 B1；当前无 token 也可访问 | ⬜（已知缺口） |
| SEC-13 | P0 | 派生进程 env | 云密钥/自定义 token 不继承；只白名单 | ✅ |
| SEC-14 | P0 | 物化凭据 | merged/profile 无 credentials | ✅ |
| SEC-15 | P1 | 插件安装供应链 | 仅白名单/签名（v3.0.7+ 预置） | ⬜ |

### 6.3 元主（ESS）

| ID | 优先级 | 用例 | 期望 | 状态 |
|---|---|---|---|---|
| ESS-01 | P0 | 官方元主 seed 幂等 | 仅 1 个；locked/official | ✅ |
| ESS-02 | P0 | `create` 已存在 id | 拒绝（create-only） | ✅ |
| ESS-03 | P0 | 篡改 locked/official 后 seed | 修复为 locked/official | ✅ |
| ESS-04 | P0 | locked 元主 rename/archive/delete | 全部拒绝 | ✅ |
| ESS-05 | P0 | rename 正常/空名/超长 | 生效/400 | ✅ |
| ESS-06 | P0 | archive/取消归档 | 仅改元数据；目录保留 | ✅ |
| ESS-07 | P0 | copy | 复制 overlay/settings；无 credentials | ✅ |
| ESS-08 | P0 | default 设置/读取/官方兜底 | 生效；不存在回官方 | ✅ |
| ESS-09 | P0 | downloadBundle | 只含 overlay；无 credentials；>32MB 拒绝 | ✅ |
| ESS-10 | P0 | 配额 5/10/30/50/100 | 超限拒绝 | 🟡（单测有，路由级缺） |
| ESS-11 | P1 | 子元主两级限制 | 子元主不能再建子元主 | 🟡 |
| ESS-12 | P1 | 并发 create 不超卖 | 账本/租约下不超卖 | ⬜（v3.0.8） |

### 6.4 分身（DRV）

| ID | 优先级 | 用例 | 期望 | 状态 |
|---|---|---|---|---|
| DRV-01 | P0 | 派生真分身 | 202/返回 taskId；adapter 握手 | ✅ e2e |
| DRV-02 | P0 | 分身 rename | 生效；archived 拒绝 | ✅ 路由级 |
| DRV-03 | P0 | tasks/copy | 返回去 token 访问信息 | ✅ |
| DRV-04 | P0 | tasks/download | 元数据 manifest（非完整归档） | ✅ |
| DRV-05 | P0 | 打开分身 | `open-url` 返回带 token URL（仅内存） | ✅ |
| DRV-06 | P0 | 归档 | 进程退出后 archived；home 保留 | ✅ e2e |
| DRV-07 | P0 | 删除存档 | home 删除；列表收敛 | ✅ e2e |
| DRV-08 | P0 | phase 字段 | provisioning/starting/running/failed/archived 映射 | 🟡 |
| DRV-09 | P1 | 重启后配置重置 | 从 merged/profile 重物化 | ⬜（v3.0.8） |
| DRV-10 | P0 | 单会话 1:1 | 第二个会话被拒；租约授权 | ⬜（v3.0.8） |
| DRV-11 | P1 | 配额满员前置 | 零 POST、可见原因、409 仲裁 | ⬜ |
| DRV-12 | P0 | 并发双开派生 | 同 opId 只生成一个 | ⬜ |

### 6.5 UI（UI）

| ID | 优先级 | 用例 | 期望 | 状态 |
|---|---|---|---|---|
| UI-01 | P0 | Header 三计数 | 母体 1 / 元主 N / 分身 N 与 API 一致 | ⬜ |
| UI-02 | P0 | Mother 单击 | 浮层打开（克隆/打开/备份） | ⬜ |
| UI-03 | P0 | Mother 双击 | 直接打开母体 Web | ⬜ |
| UI-04 | P0 | 浮层 Esc/遮罩/焦点 | 关闭且焦点返回触发按钮 | ⬜ |
| UI-05 | P0 | 左 7 槽 / 5 配额 | 5 实卡位 + 2 锁定槽；满员禁用 | ⬜ |
| UI-06 | P0 | 状态色 | running 绿 / paused 蓝 / crashed 红 / 离线灰 | ⬜ |
| UI-07 | P0 | 双击重命名 | Enter 保存；Esc 取消；失败回滚；刷新持久 | ⬜ |
| UI-08 | P0 | 分身折叠 + 五项操作 | 打开/复制/归档/下载/删除；折叠保留 | ⬜ |
| UI-09 | P0 | 信息栏 | 对话名/创建/更新/体积 | ⬜ |
| UI-10 | P1 | 官方 locked 元主 | 不生成配置/删除按钮（非禁用） | ⬜ |
| UI-11 | P1 | `data-btn-id`/`data-reason` | 每条动作有稳定钩子与原因 | ⬜ |
| UI-12 | P1 | 触屏/键盘可达性 | hover:none 常显；目标 ≥34px；F2 | ⬜ |

### 6.6 镜像/升级（MIR）

| ID | 优先级 | 用例 | 期望 | 状态 |
|---|---|---|---|---|
| MIR-01 | P0 | 手动备份/还原 | 成功；恢复点可还原 | ✅ |
| MIR-02 | P0 | 自动备份 6/12/24h | 到点触发；不重复重试风暴 | 🟡 |
| MIR-03 | P0 | 升级 + compat 通过 | 新版本生效；子插件启用；重算触发 | ✅ |
| MIR-04 | P0 | 升级 + compat 失败 | 保留新版本；子插件关闭；跳过重算 | ✅ |
| MIR-05 | P1 | 升级回滚 | 失败自动回滚/手动 restore | 🟡 |
| MIR-06 | P0 | ETag 304 | 304 不换引用、不清列表 | ✅ |
| MIR-07 | P1 | 崩溃注入（swap 中断） | 可恢复；不出现半旧半新 | ⬜ |
| MIR-08 | P1 | 备份完整性 MANIFEST/SEAL | 缺文件不记成功 | ⬜ |

### 6.7 兼容门禁（CMP）

| ID | 优先级 | 用例 | 期望 | 状态 |
|---|---|---|---|---|
| CMP-01 | P0 | 16 模块全部可导入 + apply | ok=true | ✅ |
| CMP-02 | P0 | 路由契约 62 + 必需路径 | 通过；少一条失败 | ✅ |
| CMP-03 | P0 | 门禁失败 | subPluginsEnabled=false；升级保留 | ✅ |
| CMP-04 | P1 | 门禁修复后重检 | POST compat/check 转 ok | ✅ |

### 6.8 分支/回流/MCP（v3.0.8 预置）

| ID | 优先级 | 用例 | 期望 | 状态 |
|---|---|---|---|---|
| BR-01 | P0 | 从当前会话分叉 | 引用+前缀锚定；不复制整段日志 | ⬜ |
| BR-02 | P0 | 分支切换（无写者） | 5 态完成；ETag 含 activeBranchId | ⬜ |
| BR-03 | P0 | 运行中切换 | 409 writer-alive；不损坏日志 | ⬜ |
| BR-04 | P1 | 并发双写 | fencing 检测；只保留一个 writer | ⬜ |
| BR-05 | P0 | 归档=冻结 | 保数据；删除才销毁；无 seal/forfeit 拒绝删 home | ⬜ |
| BR-06 | P0 | 回流四态 | seal→verify→quarantine→adopt；不可跳步 | ⬜ |
| BR-07 | P0 | 配置/凭据上行 | 拒绝；只允许会话/声明产物 | ⬜ |
| MCP-01 | P0 | 长任务 opId | 立即返回；轮询 get_op；重放幂等 | ⬜ |
| MCP-02 | P1 | 取消语义 | 无 cancel_*；abandon_op 明示不停止服务 | ⬜ |
| MCP-03 | P0 | 禁止暴露 | promote/adapter/session-bridge 不在工具表 | ⬜ |

### 6.9 可靠性与性能（REL）

| ID | 优先级 | 用例 | 期望 | 状态 |
|---|---|---|---|---|
| REL-01 | P1 | 8h 空闲/轮询 | 内存增长 <10%；无泄漏定时器 | ⬜ |
| REL-02 | P1 | 100 任务列表 | 首屏 <1s；分页可用 | ⬜ |
| REL-03 | P1 | 磁盘满 | 明确错误；不损坏索引 | ⬜ |
| REL-04 | P0 | 崩溃后重启 | 不重复子进程；不误杀；会话可读 | 🟡 |
| REL-05 | P1 | 并发 10 派生 | 不超卖；端口不冲突 | ⬜ |

## 7. 关键用例详细步骤

### SEC-07 token 不出现在磁盘/URL
1. 启动宿主，派生一个分身；
2. 读 `/fang/api/tasks`：断言所有 `url` 不含 `token=`；
3. 读 `<dataDir>/tasks.json`、`forks.json`：断言无 `token`/`token=`；
4. 调 `/fang/api/tasks/open-url?taskId=`：断言返回 URL 含 token；
5. 打开该 URL：页面可进入。
**期望**：1–4 全部通过；5 成功。

### ESS-06 归档不删数据
1. 创建元主 → 写入 overlay/settings；
2. `archive(true)` → 断言 meta.archived、目录仍存在；
3. `archive(false)` → 断言恢复；
4. 删除唯一子元主时父元主删除被拒。
**期望**：目录/配置始终在；销毁只发生在明确删除。

### UI-07 双击重命名（P0，待实现后自动化）
1. 双击名称 → input 出现且自动聚焦；
2. 输入新名 → Enter：请求 `tasks/rename`/`essence/rename`，UI 乐观更新；
3. 刷新后名称持久；
4. 断网/500：回滚到旧名并提示；Esc 取消不请求；
5. 409：保留 draft + 冲突出口。
**期望**：1–5 全部满足，且失败不会双写。

### MIR-04 compat 失败策略
1. 构造 compat gate 失败（模块导入错/路由数不匹配）；
2. 执行 upgrade；
3. 断言返回 `reason=compat-gate-failed`、`compat.ok=false`、`postUpgradeTriggered=false`；
4. 断言新版本已落地、子插件状态 `subPluginsEnabled=false`；
5. 修复后 `POST /api/compat/check` → `ok=true`。
**期望**：升级保留、子插件默认关闭、可重检。

### DRV-10 单会话 1:1（v3.0.8）
1. 派生生分身并绑定 context；
2. 尝试创建第二个会话 → 断言 409 `session-already-bound`；
3. 通过租约接口重复授权 → 只有一个 owner；
4. 归档后尝试复用同会话（若允许）按契约执行。
**期望**：任何路径都无法出现两个活跃会话。

## 8. CI 编排与回归策略

| 触发 | 作业 | 必须通过 |
|---|---|---|
| PR | `ci`（node 22/24）+ `compat` | 单测 + 许可 + 兼容 |
| 合并到基线 | 同上 | 同上 |
| Release tag | `release`：test → **self-hosted Windows build（preflight --e2e）** → artifact+sha256 → npm/GitHub | 全部；e2e 不可跳过 |
| 每日/每周 | 手动/计划：e2e + 长稳 | 记录趋势 |

回归分层：
- **冒烟（每次提交）**：SEC-01/02/03/07、ESS-01/05/07、DRV-01/06、CMP-01/02；
- **全量（发布前）**：本计划 P0 全跑；
- **专项（版本相关）**：v3.0.8 分支/回流/MCP。

## 9. 现有缺口（按优先级）

1. UI 用例 UI-01…UI-12 尚未自动化（`data-btn-id`/`data-reason` 需先落 S1）；
2. 干净 profile 安装（PKG-01）未进 e2e；
3. 分支/回流/MCP 全部未实现（v3.0.8）；
4. session-sync 路由鉴权（SEC-12）仍是缺口；
5. 崩溃注入/配额账本/备份 SEAL（MIR-07/08、ESS-12）未做；
6. 浏览器级截图回归未引入（需 Playwright 决策）。

## 10. 签核

- 测试负责人：待指定
- 发布负责人：待指定
- 签核条件：§2.2 全部满足；本计划 P0 用例通过率 100%，P1 ≥95% 且无未关闭 P0。
