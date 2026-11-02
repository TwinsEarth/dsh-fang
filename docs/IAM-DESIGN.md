# dsh-Fang 三层 IAM 设计（Identity & Access Management）

- 状态：提案 v1 · 2026-11-02
- 适用代码线：v3.0.4（`FANG_VERSION`）
- 审查对象：`src/lib/permissions.mjs`、`src/lib/essence.mjs`、`src/plugins/{orchestrator,adapter,forker,auditor}.mjs`、`src/kernel/{role,paths,types,extensions}.mjs`
- 关联文档：`docs/DERIVED-ORCHESTRATION.md`（D-01…D-16）、`docs/REVIEW-三区隔离与快照回流.md`（I1–I3）、`docs/ESSENCE.md`、`docs/PROTOCOL-V3.md`、`docs/ARCHITECTURE-V2.md`

---

## 0. 结论

### 0.1 一句话

把 `mirror / essence / derived` 从**身份**降级为**资源域**，把授权从「环境字符串查表」升级为「认证主体 × 能力 × 资源 × 上下文 → 决策」，把凭据从「原身目录里的明文」移到「原身进程之外的 Broker」。

三层模型今天的三条产品规则——母体只读、原身可装插件/改设置/登录账户、分身只读配置但可开会话——**没有一条在运行时被强制**。它们分别由 UI 文案、profile 里装不装插件、以及调用方自觉来"表达"。本设计的目标是让每条规则都有一个可测试的强制点、一个稳定的拒绝码、一条审计记录。

### 0.2 必须先承认的五个事实

1. `permissions.mjs` 在生产代码中**零调用点**，唯一调用者是 `test/permissions.test.mjs`。它注释里写的"宿主/Adapter 侧的第二道门"目前不存在。
2. 部署角色判定是 **fail-open** 的：`role.mjs` 在环境变量与配置都缺失时返回 `mother`（最高权限）；而 `permissions.mjs` 对未知环境是 fail-closed。两个"角色"系统既不统一，也都不认证主体。
3. `essence.mjs` 在物化时把 `overlay/credentials/**` **复制进** `merged/profile/credentials`，而 `mergedProfileDir()` 的文档写明该目录"供派生实例 `--profile` 使用"。一旦派生接线，"分身不能读原身凭据"当场被违反——这不是未来风险，是已经写进合并语义的设计。
4. VIP 配额是**全局常量表 + 目录扫描 + 调用方自报 tier**：`create({tier})` 接受任意 tier，`setTier()` 可任意改，`skipQuota` 可绕过，没有任何 `tenantId / userId` 字段。额度没有归属，只有一个字符串。
5. 控制面令牌（Adapter Bearer）放在分身的**环境变量**里，而分身里的 agent 会执行 shell 命令并继承环境；同一份令牌同时用于"母体驱动分身"和"分身自证"。结果是：被提示注入的 agent 可以调用自己的控制面，包括 `approval-decide`（自批）与 `archive`（自归档）。

### 0.3 交付物结构

| 章节 | 回答的问题 |
|---|---|
| §2 | 当前 `permissions.mjs` 与 `essence.mjs` 的具体缺口（带证据与影响） |
| §3–§4 | 可落地的授权模型与 mirror/essence/derived × 操作矩阵 |
| §5 | 账户/凭据隔离：为什么必须是 Broker，而不是更严格的目录约定 |
| §6 | 租户/用户与 VIP 额度绑定：单账本 reserve/commit |
| §7 | 会话租约与令牌生命周期 |
| §8 | API 鉴权：Host RPC、HTTP 路由、Adapter、管道 |
| §9 | 审计与访问记录：可信侧记账 |
| §10 | 越权测试清单（81 条） |
| §11 | 实施优先级与退出标准 |
| §12–§13 | 验收指标与待决问题 |

---

## 1. 范围、威胁模型与信任边界

### 1.1 资产

| 资产 | 位置（现状） | 泄露/篡改后果 |
|---|---|---|
| 提供商 API Key / OAuth refresh token | 原身 `overlay/credentials/**`，并被复制到 `merged/profile/credentials/**`；母体 `process.env` | 直接计费损失、账户被接管、可冒充用户向模型/工具侧发请求 |
| 会话内容 | 分身 `homeDir/sessions/**`；母体可经 session-catalog 读取 | 用户隐私、商业机密、提示注入的持久化载体 |
| 审计账本 | `<dataDir>/audit.jsonl`（哈希链） | 事后无法定责；合规证据失效 |
| 配额权益 | `VIP_QUOTAS` 常量 + `meta.tier` | 收入损失（越级使用）、资源超卖 |
| 镜像完整性 | `<mirrorRoot>/active` + `mirror-locked.json` | 供应链攻击：锁定插件被替换/禁用，母体加载非官方代码 |
| 控制面 | `/fang/api/*`、`/adapter/*`、`desktop-bridge.json`、AppContainer 管道 | 任意本机进程可派生/归档/升级/审批；横向移动到其它分身 |

### 1.2 攻击者与入口

| 攻击者 | 入口 | 现有缓解 | 缺口 |
|---|---|---|---|
| 提示注入的 agent（分身内） | shell 工具、MCP、被读入的文档 | Router/Umbrella/Approver 的意图门 | 同一进程持有 Adapter token 与全部环境变量；可自批、可读母体 env、可写依赖树 junction |
| 原身里安装的第三方插件 | `plugin.install`（原身的定义能力） | 评分 A–E、审批 | 插件与原身同进程、同 OS 身份：**装插件 ≈ 读凭据**；`ctx.get` 是环境权限 |
| 同机其它本地进程/用户 | 127.0.0.1 端口、`?token=` URL、`desktop-bridge.json` | 环回绑定、随机端口、token | 路由无逐条鉴权；token 在 URL；描述文件可被替换（token 替换攻击） |
| 浏览器里的恶意页面 | 对 127.0.0.1 的请求 | JSON body 解析、无 CORS | 无 Origin/Host 校验、无 CSRF 头；GET 路由可被读取 |
| 备份/同步/导出 | `backup/`、`restore/`、导出 zip | 路径校验 | 凭据/令牌无排除契约；明文随备份外流 |
| 内部人（多用户/多租户） | 共享 `$DSH_HOME`、`essences/` 目录 | 无 | 无 tenantId/owner 字段，列表即全量枚举 |

### 1.3 信任等级

> 这张表决定"谁能读什么"，比任何角色名都重要。等级越低，越不能持有长期秘密。

| 等级 | 主体 | 代码可信度 | 可持有的秘密 | 备注 |
|---|---|---|---|---|
| T0 | 用户本人（有 passkey/系统登录） | — | 会话 cookie | 唯一的授权来源 |
| T1 | 母体进程（supervisor） | 官方代码 + 锁定插件 | 签名私钥、账本写权；**不持有凭据明文** | 只读配置；生命周期写权 |
| T2 | 凭据 Broker（独立进程/身份） | 官方代码 | 凭据明文/refresh token | 唯一能读 store 的进程 |
| T3 | 原身进程 | 官方代码 + **第三方插件** | 短期 broker token | 装插件能力使其等价于"不可信代码宿主" |
| T4 | 分身进程 | 官方代码 + agent 工作负载 | 短期 lease token、短期 broker token | 完全不可信：可执行任意命令 |
| T5 | agent 起的工具子进程 | 任意 | 无（不得继承任何令牌） | 环境必须白名单 |

**关键推论**：T3 里跑着第三方代码，所以"原身凭据放在原身目录、由原身进程读"在威胁模型上等价于"把凭据交给第三方插件"。凭据必须由 T2 持有，T3/T4 只拿**短期、限定用途、可撤销**的派生凭据。这条推论直接否定了"再加一层目录权限就能隔离"的方案。

### 1.4 三条设计原则

- **P1 主体来自认证，不来自请求或环境。** `envType`、`role`、`tier`、`tenantId` 只要来自 body/query/env，就不是身份，只是声明。
- **P2 决策在资源拥有者侧做，fail-closed。** 未知主体、未知动作、未知资源、未知策略版本一律拒绝；拒绝必须带稳定 `code`。
- **P3 审计在可信侧记账。** 不可信侧（分身、第三方插件）只能提交"声明"；安全事实必须由母体或 Broker 写。

---

## 2. 现状缺口

### 2.1 `permissions.mjs`：静态矩阵的十个问题

| 编号 | 现象 | 证据 | 影响 | 级别 |
|---|---|---|---|---|
| P-01 | 生产零调用 | 全仓 grep：除 `test/permissions.test.mjs` 外无 import | "第二道门"是注释，不是门 | 阻断 |
| P-02 | 主体是调用方自报的字符串 | `resolveEnvType(value)` 只做枚举校验；`createEnvironmentGuard(envType)` 由调用方传值 | 任何能改环境/参数的代码都能把自己声明成更宽的角色 | 阻断 |
| P-03 | 只有两个布尔能力 | `PERMISSION_RULES` 仅 `installPlugins / openSessions` | 无法表达改设置、登录账户、读凭据、升级镜像、租约、导出、审批 | 高 |
| P-04 | 无法表达基数/所有权/租户 | 矩阵没有资源参数 | "至多 1 个会话""只能操作自己的原身""跨租户不可见"都写不出来 | 高 |
| P-05 | 动作词表与产品脱节 | `ACTION_GROUPS` 8 个动作；产品实际有 29 条路由 + 9 类 Adapter 命令 | 未列动作一律拒绝（安全），但正常功能也被拒；新增动作要发版 | 中 |
| P-06 | 拒绝只有中文 message，没有稳定码 | `PERMISSION_DENIED` 是唯一 code；`message` 拼中文 | 审计/SIEM/前端无法按原因聚合；i18n 与测试都脆弱 | 中 |
| P-07 | UI 摘要与执行脱节 | `describePermissions()` 返回布尔，UI 可据此显示"允许" | 真正的拒绝发生在别处（或没有），造成"假功能" | 中 |
| P-08 | 与 `essence.mjs` 的产品描述冲突 | `permissions.mjs` 说原身 `openSessions:false`；`essence.mjs` 文件头说原身"建会话"；`ESSENCE.md` 表格又不提会话 | 两个模块编码了两个产品，策略无法定稿 | 高 |
| P-09 | 没有策略版本 | 无 `policyVersion`，无灰度/回滚 | 改矩阵无法审计"当时按哪版规则放行" | 中 |
| P-10 | 没有"未知动作"之外的默认拒绝面 | 只覆盖 8 个动作名 | 新增能力天然落在"无人管"的空白，而不是"默认拒绝 + 显式开启" | 中 |

**结论**：保留 `permissions.mjs` 的 fail-closed 姿态与中文可读文案，但把它降级为**策略表的展示投影**；执行改由 §3 的决策函数完成。

### 2.2 `essence.mjs`：凭据处理的十二个缺口

| 编号 | 现象 | 证据 | 影响 | 级别 |
|---|---|---|---|---|
| C-01 | 明文落盘，无加密、无 0600 | `create()` 建 `overlay/credentials`；`writeJsonAtomic`/`copyTree` 不设 mode（全仓只有 `fork-supervisor` 的 meta 写了 0600） | 备份、同步、同机其它用户直接可读 | 阻断 |
| C-02 | 物化时复制凭据 | `materializeMerged()`：先删 `merged/profile/credentials`，再把 `overlay/credentials` 复制进去 | 两份明文；`mergedProfileDir()` 明确"供派生实例 `--profile` 使用"→ 派生天然继承 | 阻断 |
| C-03 | 镜像剔除只认顶层目录名 | 只 `removeTree(mergedProfile/credentials)`；镜像里以其它文件名/嵌套路径存在的凭据不会被剔除 | "镜像凭据不进原身"只对一种命名成立 | 高 |
| C-04 | 复制吞错 | `copyTree` 对每个文件 `catch { /* ignore */ }`；物化后仍写 `status: ready` | 凭据半份、登录态诡异；无法区分"没有账户"与"复制失败" | 高 |
| C-05 | 无读取 API、无审计、无租户校验 | `loadOverlay()` 直接把 `credentialsPath` 交给任意 `mutator`；`update()` 只检查 `meta.locked` | 任何调用方（未来 HTTP 设置路由）可读写凭据目录；无"谁在何时读了哪个凭据" | 阻断 |
| C-06 | 与原身同进程的第三方插件 | 原身的定义能力是 `plugin.install`，插件与 `EssenceManager` 同进程 | 装插件 = 读凭据；矩阵里的 `installPlugins` 隐含了 `credential.read_raw` | 阻断 |
| C-07 | 无账户模型 | 只有目录，没有 `provider / subject / scopes / linkedAt / lastUsedAt` | 无法回答"这个原身登录了谁"；切换账户无状态、无审计、无回收 | 高 |
| C-08 | settings 可藏 secret | `settings/*.yaml` 是任意 JSON，深合并进 `merged/profile/settings`；无 secret 扫描 | 凭据可以绕过 `credentials/` 的边界，从 settings 泄漏 | 高 |
| C-09 | settings key 未做路径校验 | `saveOverlay()` 用 `${name}.yaml` 拼路径；`name` 来自 `overlay.settings` 的键 | 未来设置写入路由一旦接受用户键名，即可目录穿越（写到凭据目录、`meta.json` 或母体数据目录） | 高（潜在） |
| C-10 | 官方原身 id 可被抢占 | `create({id})` 允许任意合法 id；`ensureOfficialEssence()` 见 `meta.json` 存在即返回，不校验 `locked/official` | 先创建一个 `id=essence-official-dev, locked=false` 的原身，官方原身就不再 seed | 中 |
| C-11 | 锁是字段，不是不变量 | `locked` 由 `create` 的调用方传入；`setTier/update/remove` 仅检查该字段 | 调用方可以创建"未锁定"的伪官方原身；锁定不可信 | 中 |
| C-12 | 备份/导出无凭据排除契约 | 镜像备份只管 `active/`；原身/会话导出没有"凭据永不入包"的声明与测试 | 一次 `zip` 就把明文带出 | 高 |

**结论**：凭据问题的根因不是"目录权限不够"，而是**读取权与使用权的错配**——原身需要"用"凭据，不需要"读"凭据；分身需要"用"一个受限账户，不需要"读"原身的凭据。修复方向是 Broker + 派生凭据（§5），而不是继续加目录约定。

### 2.3 配额与租户：七个缺口

| 编号 | 现象 | 证据 | 影响 |
|---|---|---|---|
| Q-01 | tier 自报、可改 | `create({tier})`、`setTier(id, tier)` 无授权；`normalizeTier` 只做枚举 | 免费用户直接写 `vip100` |
| Q-02 | 扫描计数 + TOCTOU | `create()` 先 `list().length` 再建；无锁（`mutex` 只用于 `ensureFresh`） | 并发超卖；跨进程更糟 |
| Q-03 | 上限语义不一致 | `maxEssences` 只数顶层（`parentId === null`），`maxSubEssences` 是每父；free 实际可 5×5+5=30 个 | 产品文案"原身 5 个"与实现不符 |
| Q-04 | 无 tenantId/ownerUserId | `meta` 只有 `id/name/tier/parentId/...`；`list()` 扫全目录 | 多用户共享 `$DSH_HOME` 时互相可见；无法做资源级授权 |
| Q-05 | 官方原身是全局单例 | `ensureOfficialEssence()` 固定 id，`skipQuota:true`；所有人从它派生 | 一个 principal 的派生占满所有人的"快速派生"（D-10 已指出） |
| Q-06 | 降级不回收 | `setTier` 只改 meta | 50 个原身降到 free 后仍是 50 个，无补救路径、无提示 |
| Q-07 | 活跃会话额度零调用 | `checkActiveSessionQuota` 是纯函数，生产代码无调用点（仅单测）；计数无账本 | 会话额度只存在于文档 |

### 2.4 API 与令牌：十个缺口

| 编号 | 现象 | 证据 | 影响 |
|---|---|---|---|
| A-01 | 29 条路由无逐路由鉴权 | `orchestrator.mjs` 的 `route()` 只做 method 校验 + try/catch，直接进 handler | 只依赖宿主 webServer 的全局 `?token=` 守卫：一个 token、所有动作、所有用户 |
| A-02 | 令牌在 URL | 分身 URL 形如 `http://127.0.0.1:<port>/?token=...`；`parseWebUrl` 依赖它 | 进浏览器历史、Referer、日志、截图；无法按用户区分 |
| A-03 | Adapter 无 token 时放行 | `authorized()`：`if (!expectedTokenBuf) return true` | 环境变量缺失/拼写错误 → 控制面裸奔（v2 兼容的代价） |
| A-04 | 控制面令牌在 env | `forker.spawn` 的 `env` 含 `DSH_ADAPTER_TOKEN`；spawn 的 `env` 又 `...process.env` | agent 的 shell 子进程可读；可自批 `approval-decide`、自归档、读插件源码 |
| A-05 | 无 CSRF/Host/Origin | `readBody` 只 JSON.parse；无 Origin 校验 | 恶意页面可对环回端口发请求；GET 路由可被跨站读取 |
| A-06 | 母体 env 全量下行 | `env = { ...process.env, DSH_HOME, ... }` | 提供商的 API Key 进入不可信的分身；"凭据不进分身"反向成立 |
| A-07 | 探测无鉴权、无 allowlist | `POST /api/mother-link/probe` 接受任意 `{target}`；`normalizeLinkOrigin` 只校验协议/凭据/查询串，不校验内网与环回；`probeLink` 默认跟随重定向 | 本机任意进程可让母体对任意 http(s) 主机发起固定 `/api/status` 探测（内网存活/端口探测），并把网络错误消息回显到响应 |
| A-08 | 错误回显内部消息 | `handler-threw` 的 `detail: String(e.message)` | 路径、模块名、内部状态泄漏 |
| A-09 | 审计无主体 | `AUDIT` 词表全是生命周期事件；记录只有 `pid/inst/at/kind` | 无法回答"谁在何时对哪个租户的哪个资源做了什么决定" |
| A-10 | 分身审计可伪造 | 母体用 HTTP 拉分身账本后 `aggregate`，无签名校验 | 不可信进程可以编造"已审批/已归档"的记录 |

### 2.5 会话与租约：三个缺口

| 编号 | 现象 | 影响 |
|---|---|---|
| S-01 | 无租约服务，单会话无强制点 | `derived.openSessions = true` 只表示"允许"，不表示"至多 1"；静态矩阵无法表达基数（D-04 已指出） |
| S-02 | 会话归属悬空 | 任务/会话没有 `essenceId`；原身删除不检查在途分身；回流无主 |
| S-03 | 归档即删数据 | `reap = stop + removeTree(home)`；无 seal/forfeit 前置；误删不可恢复、崩溃证据被清掉 |

---

## 3. 目标授权模型

### 3.1 主体

| 主体 | 认证方式 | 存在形式 | 能力边界 |
|---|---|---|---|
| `owner`（租户管理员） | 本机登录 + passkey/系统凭据 + step-up | 用户记录 | 租户内全部管理动作；不含"读原始凭据"；敏感动作需二次确认 |
| `member` | 同上 | 用户记录 | 自己拥有的原身/任务/会话；无镜像写权、无成员管理 |
| `viewer` | 同上 | 用户记录 | 只读（状态/列表/脱敏配置）；不能读会话内容 |
| `mother` | 进程身份（启动时生成的实例密钥） | 服务主体 | 令牌签发、账本、镜像生命周期、任务/分身生命周期；**无配置写权、无凭据读权、无会话内容读权** |
| `essence:<id>` | 启动时由母体签发的 essence token | 服务主体 | 自身 overlay 写、插件安装、账户使用（经 Broker）；不能开会话、不能碰镜像/他人资源 |
| `derived:<id>` | 每次 spawn 通过管道交付的派生令牌 | 服务主体 | 读 effective 配置；持 1 个会话租约写入；经 Broker 使用受限账户 |
| `plugin:<id>@<host>` | 无独立身份（同进程代码） | 代码主体 | 只应通过窄接口获得能力；默认无 `credential.*`、无 `mirror.*`、无 `task.*` |
| `broker` | 独立进程 + 本机 IPC 对端校验 | 服务主体 | 唯一可读凭据 store；签发派生凭据；记录每次使用 |
| `breakglass` | 双人控制 + 时间盒 | 临时主体 | 预定义动作集；全部审计；到期自动失效 |

> **代行（deputy）规则**：用户在母体 UI 上发起的"改原身设置"，`actor` 是用户，`via` 是母体。母体自身的服务身份没有 `essence.settings.write`；它只能以"用户授权的代行"执行，并在审计里同时记录 `actor=user` 与 `via=mother`。有效权限 = 用户能力 ∩ 代行范围。这样"母体只读"与"用户能改原身设置"不再矛盾。

### 3.2 资源

| 资源 | 标识 | 归属 | 说明 |
|---|---|---|---|
| `mirror` | 单例 + `generationId` | 租户 | 只读基础层；写操作仅升级/回滚/备份 |
| `essence` | `essenceId` | `tenantId + ownerUserId` | 覆盖层；两级树 |
| `settings` | `essenceId + keyPath` | 同 essence | effective 视图与 overlay 视图分离 |
| `plugin` | `essenceId + pluginId` | 同 essence | 安装/配置/锁定 |
| `credential` | `essenceId + provider + accountId` | 同 essence | 明文只在 Broker；外部只见 `credentialRef` |
| `accountLink` | `essenceId + accountId` | 同 essence | 登录了谁、何时、用什么 scope |
| `session` | `conversationId` | `tenantId + essenceId + ownerUserId` | 内容；跨分身长存 |
| `lease` | `leaseId` | 母体 | 会话写权的唯一凭据；带 `epoch` |
| `task` | `taskId` | 租户 | 一次派生的产品面 |
| `quota` | `tenantId` | 租户 | 单账本 |
| `audit` | `tenantId + partition` | 租户 | 追加写、分区读 |
| `tenant` | `tenantId` | — | 成员、权益、策略 |

### 3.3 决策函数

一次授权决策的输入是五元组：

```
decide(principal, action, resource, context, obligations?)
```

- `principal`：来自认证（会话/Bearer/管道对端），**不是** body 字段。
- `action`：稳定能力 id（见附录 A），形如 `domain.verb`，不接受自由字符串。
- `resource`：已加载的真实资源（含 `tenantId/ownerUserId/state`）；跨租户资源在加载阶段就返回 404，不进入决策。
- `context`：`requestId / traceId / now / authTime / stepUp / epoch / leaseId / configDigest / ip / ua`。
- `obligations`：决策附带的义务，如 `stepUp`、`dualControl`、`redact`、`auditOnly`、`rateLimit`。

输出：

| 字段 | 说明 |
|---|---|
| `allow` | 布尔 |
| `code` | 稳定拒绝码（附录 B）；允许时为 `ok` |
| `obligations` | 执行方必须履行的义务；未履行视为拒绝 |
| `policyVersion` | 策略表版本；写入审计 |
| `decisionId` | 幂等/关联 id |

**执行点只有三类**，且每类都必须"注册即声明能力"：

1. HTTP 路由包装器：注册路由时必须提供 `capability` 与 `resource` 解析器；没有声明的路由注册失败（启动期断言）。这直接消灭 A-01。
2. Adapter 命令分发器：每个 `op` 映射一个能力（`approval-decide` → `approval.decide`，`archive` → `task.archive`，`read-plugin` → `plugin.source.read`）。
3. 服务方法护栏：跨主体的服务方法在入口读 `AsyncLocalStorage` 里的请求上下文；无上下文 → `deny.no_context`。这只能做纵深，不能当进程边界（§8.4）。

**拒绝码必须是稳定枚举**，例如：`deny.unauthenticated`、`deny.unknown_principal`、`deny.audience_mismatch`、`deny.layer_forbidden`、`deny.tenant_mismatch`、`deny.owner_mismatch`、`deny.quota_exceeded`、`deny.lease_conflict`、`deny.epoch_stale`、`deny.step_up_required`、`deny.policy_failed`、`deny.unknown_action`。中文文案只是投影，不参与判定。

### 3.4 策略即数据

- **单一来源**：一张版本化表（能力 × 层/角色 × 条件）。服务端执行、UI 渲染、测试夹具都从这张表生成。`permissions.mjs` 的 `describePermissions` 变成它的只读投影。
- **条件谓词**：所有权、租户、基数、租约、时间窗、step-up、双人控制、配额预留、版本钉住——每个都是带单测的纯函数，不写在路由里。
- **策略版本**：`policyVersion` 单调递增；决策与审计都记录它；支持按租户灰度与一键回滚。
- **失败即拒绝**：表里没有的能力、没有的条件实现、抛出异常的条件，一律 `deny.policy_failed`，并告警（复用 `remoteAccess` 的 `policy-failed` 语义）。

### 3.5 与宿主 `remoteAccess` 的关系

较新的宿主已提供 `ctx.remoteAccess`：按 principal kind 注册 policy，`bindings` 给出 `role.actions + resource + condition`，`decide()` 返回 allow / deny(reason)，`allows()` 供 list 过滤，`explain()` 给出拒绝原因，`invalidate()` 在授权变化时推送。这正是本设计需要的形状。

- **能复用就复用**：策略注册、决策、快照、失效通知都走宿主，避免第二套策略引擎。
- **不能复用就同形状适配**：dsh-fang 支持的最低宿主版本若没有该服务，在本仓实现 `authz` 适配层，保持 `{kind, reason}` 的决策形状与 `allows/decide` 的调用签名；宿主可用时替换实现，调用点不动。
- **注意**：宿主策略只覆盖 Typert Remote 方法；`webServer.register` 的裸 HTTP 路由不经过它。要么把路由改成 Remote 方法，要么用同一个决策服务包住裸路由。不要假设"宿主有 remoteAccess，所以路由就安全了"。

---

## 4. 角色与权限矩阵

### 4.1 层 × 能力（服务主体的环境权限）

> 列 = **该层自身的服务主体**（不是"经过该层的用户请求"）。用户请求的能力见 §4.2；代行规则见 §3.1。
> ✅=允许；❌=拒绝；🔒=仅系统内部/签名同步；⚠️=允许但有条件（见 §4.3）。

| 能力 | 母体 mirror | 原身 essence | 分身 derived |
|---|---|---|---|
| `mirror.read` | ✅ 全量 | ✅ 版本+指纹 | ✅ 仅 `baseGeneration` |
| `mirror.upgrade / rollback` | ✅ step-up + 签名 + 备份 | ❌ | ❌ |
| `mirror.backup / restore / delete` | ✅ step-up | ❌ | ❌ |
| `mirror.lock.set` | 🔒 仅签名发布 | ❌ | ❌ |
| `essence.read` | ✅ 租户内列表 | ✅ 自身 | ✅ 自身（effective） |
| `essence.create / delete` | ✅ 代用户 + 配额/封印检查 | ❌ | ❌ |
| `essence.update`（overlay） | ❌ 无环境权限（仅代行） | ✅ 自身 | ❌ |
| `essence.tier.set` | 🔒 仅权益同步 | ❌ | ❌ |
| `essence.clone / promote` | ✅ 代用户 + 配额 | ❌ | ❌ |
| `settings.read` | ✅ 脱敏 | ✅ 自身 | ✅ effective + 脱敏 |
| `settings.write` | ❌（仅代行） | ✅ 自身 | ❌ |
| `plugin.list / read` | ✅ | ✅ 自身 | ✅ 仅清单 |
| `plugin.install / remove / update` | ❌（镜像只装官方） | ✅ allowlist + 评分 | ❌ |
| `plugin.config.write` | ❌ | ✅ 自身 | ❌ |
| `plugin.promote_to_mirror` | ✅ admin + 审批 | ❌ | ❌ |
| `account.login / logout / link` | ❌（无账户库） | ✅ 经 Broker + step-up | ❌ |
| `account.list` | ✅ 元数据（无 secret） | ✅ 自身 | ❌ |
| `credential.read_raw` | ❌ | ❌ | ❌ |
| `credential.use` | ❌ | ✅ Broker 注入 | ✅ 短时派生凭证（单 provider、只读/会话 scope） |
| `credential.rotate / revoke` | ❌（仅代行） | ✅ 自身 | ❌ |
| `session.create` | ❌ | ❌ | ✅ 需准入 + 租约，≤1 |
| `session.list_meta` | ✅ 租户内 | ✅ 自身 | ✅ 自身 |
| `session.read_content` | ⚠️ 仅 admin 导出（审计） | ❌（仅经 seal/export） | ✅ 仅自身租约 |
| `session.write` | ❌ | ❌ | ✅ 仅持租约 + epoch 匹配 |
| `session.archive / seal` | ✅ 任务生命周期 | ✅ 发起回流 | ✅ 关闭自身时 |
| `lease.grant / revoke` | ✅ 准入单点 | ❌ | ⚠️ 仅续约自身 |
| `task.*`（create/read/archive/delete） | ✅ 租户内 | ❌ | ❌ |
| `quota.read` | ✅ 租户 | ✅ 自身用量 | ❌ |
| `quota.reserve / commit / refund` | ✅ 仅内部 | ❌ | ❌ |
| `audit.append` | ✅ 本租户 | ⚠️ 仅自身分区（untrusted） | ⚠️ 仅自身分区（untrusted） |
| `audit.read` | ✅ 租户 | ⚠️ 仅自身 | ❌ |
| `audit.verify` | ✅ | ❌ | ❌ |
| `tenant.member.*` | ✅ admin + step-up | ❌ | ❌ |
| `token.issue` | ✅ 唯一签发者 | ❌ | ❌ |
| `admin.breakglass` | ⚠️ 双人 + 时间盒 | ❌ | ❌ |

### 4.2 人的角色 × 能力

| 能力组 | owner（租户管理员） | member（原身所有者） | viewer |
|---|---|---|---|
| 查看状态/列表/脱敏配置 | ✅ | ✅ | ✅ |
| 创建/删除原身 | ✅ | ✅（自己名下，配额内） | ❌ |
| 改设置/装插件/登录账户 | ✅ | ✅（仅自己的原身） | ❌ |
| 派生/归档/删除任务 | ✅ | ✅（自己的） | ❌ |
| 读会话内容 | ⚠️ 仅导出且审计 | ✅ 自己的 | ❌ |
| 镜像升级/回滚/备份 | ✅ step-up | ❌ | ❌ |
| 成员与权益管理 | ✅ | ❌ | ❌ |
| 审计读取/导出 | ✅ | ✅ 自己的 | ❌ |
| 破窗 | ⚠️ 发起（需第二人批） | ❌ | ❌ |

### 4.3 静态矩阵表达不了的约束（必须由条件谓词承担）

| 约束 | 谓词 | 失败码 | 强制点 |
|---|---|---|---|
| 所有权 | `resource.ownerUserId === principal.userId` | `deny.owner_mismatch` | 资源加载后 |
| 租户隔离 | `resource.tenantId === principal.tenantId` | `deny.tenant_mismatch`（对外 404） | 资源加载后 |
| 单会话 | `activeLeases(derivedId) < 1` | `deny.lease_conflict` | 租约授予点（唯一） |
| 租约有效 | `lease.expiresAt > now && lease.epoch === ctx.epoch` | `deny.epoch_stale` | 每次写入 |
| 锁定 | `essence.locked === false` | `deny.locked` | 写 overlay 前 |
| 状态机 | `task.state ∈ {ready, archived}` | `deny.state_conflict` | 动作入口 |
| 配额 | `reservation.tenantId === principal.tenantId && reservation.kind === ...` | `deny.quota_exceeded` | reserve 时 |
| step-up | `now - authTime < 5min && amr 含 passkey` | `deny.step_up_required` | 敏感动作前 |
| 双人控制 | 两个不同 principal 的批准 | `deny.dual_control_required` | 破窗/镜像升级 |
| 版本钉住 | `derived.baseGeneration === mirror.generation` | `deny.generation_mismatch` | 派生/写入 |
| 脱敏 | 响应过滤器 | `obligation.redact` | 序列化前 |
| 网络来源 | `host ∈ allowlist && origin ∈ allowlist` | `deny.origin_mismatch` | 中间件最先 |

**为什么这决定了"静态矩阵必须被替换"**：矩阵只能回答"这个动作在这个层允不允许"，回答不了"对谁的哪个资源、在什么状态、还差什么条件"。把条件硬编码进 handler 会重演今天"三处配额真相"的问题；条件必须是具名谓词 + 单测 + 决策记录。

### 4.4 命名与版本治理

- 能力 id 一旦发布不复用、不改语义；废弃走 `deprecated` 标记 + 迁移期双写。
- 表带 `policyVersion`；每次发布生成快照，测试夹具引用快照。
- 新增能力必须同时提交：矩阵行、条件（若有）、拒绝码、审计事件、越权用例。没有这五项不允许合并。
- UI 只消费 `describeCapabilities()` 的投影，不自己拼规则。

---

## 5. 账户与凭据隔离

### 5.1 账户模型

```
Tenant 1 ──< User 1 ──< Membership(role)
Tenant 1 ──< Entitlement(tier, limits, validFrom/To, signature)
Essence 1 ──< AccountLink(provider, subject, credentialRef, scopes, linkedAt, lastUsedAt)
Essence 1 ──< CredentialRef(provider, accountId, storeKey, version, rotatedAt)
Conversation 1 ── 1 AccountBinding(accountId)     # 会话绑定账户，不绑定"默认账户"
```

- `AccountLink` 是"这个原身登录了谁"的唯一真相；凭据本体只在 Broker。
- 一个原身可登录多个账户（产品要求），但**每个会话必须显式绑定一个 `accountId`**；切换账户 = 新会话或显式 rebind（审计 + 旧租约失效）。
- 身份关联规则：如果 SSO/邮箱匹配到已有账户，**不得自动合并**；要求原账户持有者确认（防账户接管）。这条规则在本地单用户时退化为"同一 provider 同一 subject 唯一"。
- 删除 `AccountLink` 必须撤销该账户的所有派生凭据与租约（§7.3）。

### 5.2 凭据存储分级

| 级别 | 做法 | 防住什么 | 防不住什么 |
|---|---|---|---|
| L0（现状） | 明文目录 + 路径约定 | 无 | 同机任何进程/用户、备份、同步 |
| L1 | 加密 at rest（DPAPI/TPM 包裹的密钥）+ ACL + 0600 + 不复制 + 扫描 | 备份/同步/离线窃取/误提交 | 同用户的运行中进程（DPAPI 可被同用户调用） |
| L2 | **独立 Broker 进程/身份** + 本机 IPC 对端校验 + 只发派生凭据 | 原身/分身/第三方插件读明文 | 拥有调试权限的同用户管理员 |
| L3 | 提供商原生短时凭证（OAuth token exchange / STS / GitHub App installation token） | 长期秘密根本不下发 | 提供商不支持时的降级 |

**建议**：P0 先做 L1 的"不复制 + 加密 + 扫描 + 审计"，P1 做 L2，L3 按 provider 逐个接。不要把 L1 当终点——同用户同进程的威胁模型里，L1 不构成边界。

### 5.3 Broker 架构

```
原身/分身 ──(本机 IPC，短时 token)──> Broker ──(注入/交换)──> Provider
                                      │
                                      └── 凭据 store（加密；唯一读者）
```

两种使用模式，优先前者：

1. **Vending（推荐）**：Broker 向 provider 换取短时、限定 scope 的凭据（如 5 分钟 STS、只读 token、installation token），把**派生凭据**交给调用方。原身/分身的内存里没有长期秘密。
2. **Proxying（兜底）**：provider 不支持短时凭证时，调用方把请求发给 Broker 的本地代理，Broker 注入 `Authorization` 后转发。长期秘密永不进入调用方进程。

Broker 的接口只暴露四类动作：`use(credentialRef, scope, audience) -> 派生凭据或代理句柄`、`rotate(credentialRef)`、`revoke(credentialRef)`、`describe(credentialRef)`。**没有 `read()`**。这从 API 形状上消灭 `credential.read_raw`。

Broker 的强制点：

- 校验调用方令牌的 `aud`（必须是 `essence:<id>` 或 `derived:<id>`）、`scope`、`exp`、`epoch`、`accountId`。
- 校验 `credentialRef` 属于该 `essenceId` 且该 `essenceId` 属于该 `tenantId`。
- 每次使用写 `credential.used` 审计（provider/account/scope/调用方，不含 secret）。
- 失败一律 `deny.credential_scope`，不区分"不存在"与"无权"。

### 5.4 三条硬不变量与检测

| 不变量 | 强制手段 | 检测手段 |
|---|---|---|
| **K-1 凭据不进母体** | 母体只持 `credentialRef`；`EssenceManager` 没有读 secret 的方法；Broker 先从受保护存储读取，母体随后从环境擦除 provider key | 母体进程内存扫描（测试夹具）；`grep` 门禁：`merged/`、导出包、日志中无 secret 模式 |
| **K-2 凭据不进分身** | 物化不复制 `credentials/`；派生 profile 不含；Broker 只发派生凭据 | 派生 home/profile 的 secret 扫描；对 `essences/` 目录的读取测试 |
| **K-3 分身读不到原身凭据** | 数据不在其可读路径 + Broker 令牌 `aud/scope` 排除 raw + OS ACL/AppContainer 拒绝 | 金丝雀文件 + 访问监控（同 SID 时只能检测，需如实写进威胁模型） |

> **诚实说明**：Windows 同用户下 ACL 只能"减弱"不能"根除"（与 D-02 的结论一致）。如果分身不作为独立 OS 身份运行，K-3 的运行时部分是"检测 + 告警"，不是硬边界。产品文案与安全白皮书必须这样写，不能宣称"隔离"。

### 5.5 登录不同账户

- `account.login` 必须 step-up（passkey/系统凭据）；登录结果写 `account.linked`，并记录 `provider/subject/scopes/authTime`。
- 登录流程本身用标准 OAuth/OIDC 授权码 + PKCE（本地回环 redirect，state/nonce 校验，精确 redirect URI）；不要自研"设备码简化版"。
- 凭据写入只经 Broker；原身拿回 `credentialRef` 与 `accountId`，不拿 secret。
- 多账户并存时，UI 必须显示"当前会话绑定的是哪个账户"；切换账户不静默复用旧 token。

### 5.6 轮换、撤销、恢复

| 事件 | 动作 | SLA |
|---|---|---|
| 手动轮换 | Broker 生成新版本，旧版本 `retire`；已发派生凭据到期失效 | 新版本立即生效；旧派生 ≤ 其 TTL |
| 账户登出 | 撤销 `AccountLink` + 该账户所有派生凭据 + 相关租约 | ≤ 60s |
| 成员移除 | 撤销其全部会话 + 其名下分身的令牌/租约 | ≤ 60s |
| 凭据泄露疑似 | 全量轮换该 provider + 提升 epoch（分身的旧写入被 fence） | 立即 |
| 恢复 | 恢复走"账户持有者 + step-up + 新会话"，不得恢复旧 refresh token | 人工 |

---

## 6. 租户、用户与 VIP 额度

### 6.1 实体与归属

| 实体 | 关键字段 | 归属 | 说明 |
|---|---|---|---|
| `Tenant` | `tenantId, name, plan, status` | — | 本地单用户模式退化为"安装 id + 本机用户" |
| `User` | `userId, tenantId, status` | 租户 | |
| `Membership` | `userId, role` | 租户 | `owner/member/viewer` |
| `Entitlement` | `tenantId, tier, limits, validFrom, validTo, signature` | 许可方 | 唯一的 tier 真相 |
| `Essence` | `essenceId, tenantId, ownerUserId, parentId, locked, official, entitlementRef` | 租户+用户 | **移除可写 `tier` 字段**，改为投影 |
| `DerivedInstance` | `derivedId, essenceId, principalId, baseGeneration, epoch, leaseId` | 母体 | 额度按 `principalId` 计 |
| `QuotaReservation` | `reservationId, tenantId, kind, amount, expiresAt` | 租户 | 账本条目 |
| `Lease` | `leaseId, conversationId, derivedId, epoch, expiresAt` | 母体 | 会话额度占位 |

### 6.2 权益与 tier 投影

- `tier` 只能由 `Entitlement` 派生（签名验证 + 有效期）；API 不接受 `tier` 参数。
- 本地模式：许可文件（离线签名）→ 同一模型；托管模式：relay 下发短时权益（含 `tenantId`），母体缓存并在过期后降级。
- 额度上限来自版本化表（`limits`），不再硬编码 `VIP_QUOTAS`；表随权益版本走，可审计。
- `OFFICIAL_ESSENCE_MIN_TIER` 这类"tier 兼作功能门"的用法要拆开：**tier = 额度**，**feature flag = 功能**。不要用一个字符串表达两件事。

### 6.3 单账本 reserve / commit

```
reserve(tenantId, kind, amount, requestId) -> {ok, reservationId} | {ok:false, code, remediation}
commit(reservationId)
refund(reservationId)
```

- 账本 `quota/ledger.jsonl` + 快照；按 `tenantId` 加锁（`KeyedMutex` 已有）。
- `requestId` 幂等：同键重复调用返回同一 `reservationId`（与 §8.2 的 `Idempotency-Key` 同一套机制）。
- 预留 TTL（如 5 分钟）+ 定期 GC：崩溃在 reserve 与 commit 之间不会永久泄漏额度。
- 上限检查读账本，不读目录；`list().length` 只用于展示对账，不参与准入。
- 三种额度是同一账本的三个投影：原身数（`kind=essence`）、分身数（`kind=derived`）、活跃会话（`kind=session`，由租约占位）。

### 6.4 三视图与并发

| 视图 | 数据源 | 用途 |
|---|---|---|
| 已提交量 | 账本 commit 条目 | 准入、计费 |
| 预留量 | 未过期 reservation | 防超卖 |
| 物理量 | 目录/进程扫描 | 对账、告警（不一致即告警，不以它为准） |

并发压测门槛：200 个并发派生 → `物理数 == 账本数 == 成功数 ≤ limit`（D-09 的验收口径）。

### 6.5 官方原身与降级

- 官方原身是**模板**，不计入任何用户的"原身数"；从它派生时额度记在**派生者 principal** 名下（D-10）。
- 降级：立即阻止新 reserve；已存在的租约/分身允许到期；UI 显示"超出 n 个，需归档/删除"并提供一键选择；不得静默删除。
- 升级：只放宽上限；不自动创建资源。

---

## 7. 会话租约与令牌生命周期

### 7.1 令牌类型

| 令牌 | 签发者 | 受众 `aud` | 作用域 | TTL | 存放 | 轮换/撤销 |
|---|---|---|---|---|---|---|
| 浏览器会话 | 母体 | `fang-web` | 用户身份 | 12h idle / 7d absolute | `HttpOnly; Secure; SameSite=Strict` cookie（`__Host-` 前缀） | 登录/提权即轮换；删服务端会话即时失效 |
| CSRF token | 母体 | `fang-web` | 单会话 | 随会话 | 页面内存 + 请求头 | 随会话轮换 |
| Adapter 控制令牌 | 母体 | `derived:<id>` | 控制面 ops | 进程生命周期 | **仅 fork 内存**（spawn 时管道交付） | 每次 spawn 新生成；进程死即失效 |
| 派生工作负载令牌 | 母体 | `derived:<id>` | 仅 `status/ping` | ≤ 15 min | fork 内存 | 重启即换 |
| Lease token | 母体 | `session-service` | `session.write:<conversationId>` | 60–120s | fork 内存 | 心跳续期；租约撤销/epoch+1 |
| Broker token | Broker | `provider-proxy:<provider>` | 单 provider + 操作集 | ≤ 5 min | 调用方内存 | 每次使用或每会话；凭据轮换即失效 |
| Step-up token | 母体 | `fang-web` | 单次敏感动作 | 5 min | 页面内存 | 一次性消费 |
| 权益签名 | 许可方 | — | 非 bearer | 有效期 | 文件 | 密钥轮换 |

规则：

- 浏览器会话用**不透明随机值 + 服务端存储**，不用 JWT——即时撤销比无状态验证重要。
- 服务间令牌用标准 JWS（ES256/Ed25519），带 `iss/aud/sub/scope/tenant/sid/epoch/jti/iat/exp/kid`；**母体签名、分身验证**，绝不给分身 HMAC 共享密钥（否则分身可伪造母体 audience 的令牌）。
- 任何令牌不进 URL、不进日志、不进状态接口、不进审计；只记录 `jti` 或哈希。
- 校验：`alg` 白名单、`kid` 轮换、`iss/aud/exp/nbf`、时钟偏移 ≤ 60s、`jti` 重放缓存（仅长令牌需要）。

### 7.2 租约状态机与 fencing

```
none ──request──> granted(active) ──heartbeat──> active
                     │  │  │
                     │  │  └──release(archive/seal)──> released
                     │  └──expire(TTL)──> expired
                     └──revoke(mother/admin)──> revoked
```

- 授予点**唯一**：母体准入（配额 + 单会话 + 端口/内存/磁盘）→ 写 `quota/leases.jsonl` → 发 lease token。
- 心跳：每 `TTL/3`；连续 2 次缺失 → `expired`，写审计，释放额度。
- 写入：每次携带 `leaseId + epoch`；不匹配 → `409 stale-writer`，**不做 last-write-wins**。
- 回收：`archive` 前必须 `seal` 或显式 `forfeit`（D-16）；无标记不得删 home。
- 分身重启：新 `epoch`，旧租约失效；同一 `conversationId` 可恢复，但必须重新授予租约。

### 7.3 撤销矩阵

| 事件 | 撤销对象 | SLA |
|---|---|---|
| 登出 | 浏览器会话 + step-up | 即时 |
| 角色变更 | 该用户全部会话 | ≤ 60s |
| 成员移除 | 该用户会话 + 其分身的 Adapter/Lease/Broker 令牌 | ≤ 60s |
| 原身删除 | 该原身全部派生令牌 + 租约 | ≤ 60s |
| 账户登出/轮换 | 该账户的 Broker 令牌 + 绑定租约 | ≤ 60s |
| 疑似令牌泄露 | 该 principal 全部令牌 + `epoch+1` | 立即 |
| 破窗结束 | 破窗 step-up 令牌 | 即时 |
| tier 降级 | 不撤销，仅阻止新 reserve | — |

### 7.4 密钥与轮换

- 母体签名密钥：安装时生成，私钥由 OS keystore 保护（DPAPI/TPM），只在母体内存中解封；`kid` 轮换，公钥分发给分身/ Broker。
- Broker 存储密钥：与母体签名密钥分离；轮换时重加密，旧密文保留可读窗口。
- 证书/密钥到期监控：提前 30 天告警（对应"季度评审"的日历项）。
- 绝不用"文件名/环境变量"当密钥；绝不在代码里放默认密钥。

---

## 8. API 鉴权

### 8.1 边界清单

| 边界 | 协议 | 现状 | 目标 |
|---|---|---|---|
| 插件间服务调用 | 进程内 `ctx` | 环境权限 | 请求上下文 + 窄接口 + 服务护栏（纵深，非硬边界） |
| 母体 HTTP | `/fang/api/*` | 仅宿主全局 token | 会话/Bearer + 逐路由能力 + CSRF/Origin/Host |
| 分身控制面 | `/adapter/*` | Bearer，缺失即放行 | 强制 Bearer + 控制/工作负载令牌分离 + 环回/Host 校验 |
| 桌面桥 | `desktop-bridge.json` + 环回 HTTP | 文件里的 Bearer | 0600 + 轮换 + 对端真实性校验 |
| 容器/AppContainer | 命名管道 | 帧协议 | 管道 DACL + 对端 SID/PID 校验 + nonce |
| 出站探测 | `mother-link/probe` | 任意 http(s) | 能力 + allowlist + 禁内网/元数据/重定向 |

### 8.2 HTTP 中间件顺序

```
Host/Origin 校验 → 认证（cookie 或 Bearer）→ CSRF → 能力决策 → 资源加载
→ 租户/所有权校验 → step-up/双人控制义务 → handler → 审计
```

- **Host**：只接受 `127.0.0.1:<port>`、`localhost:<port>`、`[::1]:<port>`；其余 403（防 DNS rebinding）。
- **Origin**：无 Origin（同源导航/CLI）或 allowlist 内才放行；跨站 POST 一律 403。
- **CSRF**：写请求必须带 `X-Fang-CSRF`；拒绝 `text/plain`/`x-www-form-urlencoded`/`multipart` 作为 JSON API 的 content-type。
- **Cookie**：`HttpOnly; Secure; SameSite=Strict; Path=/`，`__Host-` 前缀；环回 http 下实测浏览器兼容性，不行则退化为无前缀 + 同源校验（并记录原因）。
- **Bearer（CLI/自动化）**：`aud=fang-cli`，scope 最小化，独立于浏览器会话，可单独撤销。
- **幂等**：`POST /api/derive`、`/api/tasks/create` 要求 `Idempotency-Key`；服务端保留 2 分钟窗口（同一键返回同一 `taskId`）。
- **限流**：按 principal + 路由；探测/升级/导出单独更严。
- **错误**：401 未认证 / 403 已认证但拒绝 / 404 跨租户或不存在（不泄漏存在性）/ 409 冲突 / 429 限流；响应体只给稳定 code，不给内部 message。

### 8.3 路由能力表（29 条）

| 路由 | 方法 | 能力 | 额外义务 |
|---|---|---|---|
| `/fang/panel` | GET | `ui.panel.read` | 需会话；CSP |
| `/fang/api/status` | GET | `mother.status.read` | 脱敏 |
| `/fang/api/tasks` | GET | `task.list` | 租户过滤 |
| `/fang/api/tasks/create` | POST | `task.create` | 配额 reserve + 幂等键 |
| `/fang/api/tasks/status` | GET | `task.read` | 所有权 |
| `/fang/api/tasks/archive` | POST | `task.archive` | seal/forfeit |
| `/fang/api/tasks/restore` | POST | `task.restore` | 配额 + 端口 |
| `/fang/api/tasks/archive/delete` | POST | `task.delete` | step-up + 二次确认 |
| `/fang/api/tasks/promote` | POST | `plugin.promote_to_mirror` | admin + 审批 |
| `/fang/api/derive` | POST | `task.derive` | `essenceId` 必填 + 配额 + 幂等 |
| `/fang/api/tasks/sessions` | GET | `session.list_meta` | 所有权 + 脱敏 |
| `/fang/api/forks` | GET | `task.list` | 租户过滤 |
| `/fang/api/forks/create` | POST | `task.derive` | 同上（兼容别名） |
| `/fang/api/reap` | POST | `task.reap` | seal/forfeit |
| `/fang/api/promote` | POST | `plugin.promote_to_mirror` | 同上 |
| `/fang/api/mother-link` | GET | `link.read` | 无 token/凭据 |
| `/fang/api/mother-link/probe` | POST | `link.probe` | admin + allowlist + 限流 |
| `/fang/api/mirror/status` | GET | `mirror.read` | ETag |
| `/fang/api/mirror/backup` | POST | `mirror.backup` | step-up |
| `/fang/api/mirror/restore` | POST | `mirror.restore` | step-up + 先备份 |
| `/fang/api/mirror/backup/delete` | POST | `mirror.delete` | step-up |
| `/fang/api/mirror/backup-interval` | POST | `mirror.settings.write` | step-up |
| `/fang/api/mirror/preferences` | GET | `mirror.read` | — |
| `/fang/api/mirror/preferences/set` | POST | `mirror.settings.write` | 白名单键 |
| `/fang/api/mirror/recompute-status` | GET | `mirror.read` | — |
| `/fang/api/essence/list` | GET | `essence.list` | 租户过滤 |
| `/fang/api/compat` | GET | `compat.read` | — |
| `/fang/api/compat/check` | POST | `compat.run` | admin + 限流 |
| `/fang/api/mirror/upgrade` | POST | `mirror.upgrade` | admin + step-up + 签名 + 备份 |

**启动期断言**：路由注册器要求 `capability` 字段；缺省即抛错，不允许"默认放行"。这条断言比任何文档都可靠。

### 8.4 Host RPC / 管道 / 桌面桥

- **进程内**：`ctx.get` 是环境权限，不是授权。第三方插件与原身同进程，JS 层无法做硬隔离。因此：对插件只暴露窄门面（如 `essenceApi.readOwnConfig()`），不暴露 `fangMirror`、`fangForker`、Broker 原始接口；服务护栏读 `AsyncLocalStorage` 上下文，无上下文拒绝。**如实承认**：这是纵深，不是边界；真正的边界是 §5 的进程隔离。
- **命名管道**：管道 DACL 只允许服务 SID；服务端校验客户端 PID/SID（不是只看 token）；启动 nonce 挑战；帧大小上限；不把 secret 放 argv/env。
- **桌面桥**：`desktop-bridge.json` 必须 0600；token 短 TTL + 轮换；校验描述文件真实性（桥私钥签名或挑战-应答），否则同机进程可替换描述文件把客户端引到自己的服务上并收割 token（token 替换攻击）。P2 前至少记录为已知风险。
- **出站探测**：能力 `link.probe` + 目标 allowlist（默认只允许公网主机，禁环回/内网/链路本地，含 `169.254.169.254`；禁 `file:` 与带凭据的 URL）+ 重定向不跟随或只允许 allowlist 内 + 超时 + 限流 + 错误消息不回显对端细节。

### 8.5 Adapter 控制面

- **fail-closed**：没有令牌就拒绝；v2 兼容期用显式开关 `FANG_ALLOW_UNAUTHENTICATED_ADAPTER=1` + 启动告警 + 截止日期。
- **令牌分离**：控制令牌（母体专用，管道交付，不进 env）与工作负载令牌（agent 可用，只允许 `status/ping`）。今天的单一令牌让 agent 能 `approval-decide`、`archive`、`read-plugin`，这是权限提升。
- **绑定**：令牌 `aud=derived:<id>` + `sid`（本次 spawn 的 nonce）；换 spawn 即失效；不把令牌写进 `/adapter/status`。
- **逐 op 能力**：`ping/status` → `derived.self.read`；`flush-buffer` → `derived.buffer.flush`；`score-plugin/read-plugin` → `plugin.source.read`（默认不给 agent）；`approval-decide` → `approval.decide`（**agent 不得拥有**）；`archive` → `task.archive`（母体）。
- **网络**：绑定 127.0.0.1；校验 Host；拒绝非环回；限流；body 上限已有（1MB），补超时。

### 8.6 迁移（不打断现有用户）

1. 双轨：新路由只认 Bearer/cookie；旧 `?token=` 仅用于 `GET /fang/panel` 的一次性 bootstrap：校验 → 换取 cookie → 302 到去掉 token 的 URL → 令牌单次消费。
2. 影子模式：新决策先只记录 `authz.shadow_deny`，不拦截；观察 1–2 个版本后切换为强制。
3. 开关按租户/安装灰度；保留 kill switch。
4. 截止日期写进发布说明；到期删除兼容分支与测试。

---

## 9. 审计与访问记录

### 9.1 事件模型

在现有哈希链（`kind/pid/at/inst/seq/prevHash/hash`）上扩展：

```json
{
  "v": 2,
  "eventId": "evt_...",
  "at": "2026-11-02T14:03:11.482Z",
  "seq": 1042,
  "tenantId": "t_...",
  "actor": { "type": "user", "id": "u_...", "via": { "type": "mother", "instance": "inst_..." } },
  "action": "essence.settings.write",
  "resource": { "type": "essence", "id": "essence-...", "ownerUserId": "u_..." },
  "decision": { "allow": false, "code": "deny.step_up_required", "policyVersion": "2026-11-02.1", "decisionId": "dec_..." },
  "context": { "requestId": "req_...", "ip": "127.0.0.1", "ua": "…", "epoch": 7, "leaseId": null },
  "evidence": { "tokenJti": "…", "configDigest": "…", "credentialRef": "…" }
}
```

- 链式哈希保留；`eventId` 供跨源关联；`policyVersion/decisionId` 让"当时按哪版规则"可回溯。
- 记录**决策**而不只是结果：允许的敏感动作也要记（导出、凭据使用、镜像升级、成员变更）。

### 9.2 事件词表（新增）

| 域 | 事件 |
|---|---|
| 认证 | `auth.login.succeeded/failed`、`auth.logout`、`auth.step_up`、`auth.token.issued/revoked`、`auth.token.reuse_detected` |
| 授权 | `authz.denied`、`authz.allowed_sensitive`、`authz.policy_changed` |
| 账户 | `account.linked/unlinked`、`credential.created/rotated/revoked/used`、`credential.read_denied` |
| 原身 | `essence.created/updated/deleted`、`essence.tier_changed`、`plugin.installed/removed/updated` |
| 镜像 | `mirror.upgrade_started/succeeded/failed`、`mirror.rollback`、`mirror.locked_changed` |
| 会话 | `session.created/attached/sealed/archived`、`lease.granted/renewed/expired/revoked`、`session.single_violation` |
| 配额 | `quota.reserved/committed/refunded/rejected` |
| 租户 | `tenant.member_added/removed`、`tenant.entitlement_changed` |
| 破窗 | `admin.breakglass.started/ended`、`admin.breakglass.action` |

### 9.3 可信侧记账

- 安全事实（认证、授权、凭据、租约、权益）**只由母体/Broker 写**。
- 分身账本可以继续存在（用于本地诊断），但母体聚合时必须标 `trust: "untrusted"`；它不能作为"已审批/已授权"的证据。
- 现有 `aggregate()` 把分身记录与本地记录混排；改为保留 `sourceTrust` 字段，安全查询默认过滤掉 untrusted。
- 启动自检（`bootCheck`）保留：未干净收尾、重启未闭合仍然告警。

### 9.4 访问记录

"谁访问了什么"是审计的一个投影，至少覆盖：

| 访问 | 记录字段 | 频率 |
|---|---|---|
| 凭据使用 | `credentialRef, accountId, provider, scope, caller, decision` | 每次 |
| 会话内容读取/导出 | `conversationId, mode(export/read), sizeBytes, actor` | 每次 |
| 原身 overlay 读写 | `essenceId, keys, digestBefore/After` | 每次 |
| 镜像升级/恢复 | `fromGeneration, toGeneration, actor, approvedBy` | 每次 |
| 审计读取/导出 | `range, actor` | 每次 |

隐私：安全账本不含会话正文、不含 secret、不含完整令牌；只放 id/哈希/长度。会话正文留在会话存储，按产品保留策略处理。

### 9.5 保留、导出、校验

- 每日把链头哈希写到账本之外（单独文件/外部 sink），防"整链替换"。
- 保留：安全事件 ≥ 1 年；运维事件 30–90 天；会话按产品策略。
- 导出：仅 `audit.export` 能力 + 审计；导出内容与源一致，带链校验清单。
- 校验：`verify()` 在启动与导出前各跑一次；链断裂后拒绝追加（现有行为保留）。

---

## 10. 越权测试清单

> 每条都要有"预期状态码/拒绝码 + 预期审计事件"。测试属于 CI 门禁，不是发布前手工清单。

### A. 主体与令牌（10）

| ID | 场景 | 预期 |
|---|---|---|
| A1 | 分身里设 `DSH_FANG_ROLE=mother` / `DSH_FANG_ENV=essence` 后调用母体能力 | 拒绝；能力仍按认证主体；记 `authz.denied` |
| A2 | 无凭据调用任一写路由 | 401 + `deny.unauthenticated`；无状态变更 |
| A3 | 用分身令牌调母体路由 | 403 + `deny.audience_mismatch` |
| A4 | 过期令牌 | 401；不产生副作用 |
| A5 | `alg=none` / 错误 `kid` / 错误签名 | 401；不泄漏校验细节 |
| A6 | `?token=` 在 bootstrap 后再用一次 | 401（单次消费） |
| A7 | 写请求缺 CSRF 头 | 403 + `deny.csrf` |
| A8 | `Origin: https://evil.example` | 403 + `deny.origin_mismatch` |
| A9 | `Host: evil.example` | 403（防 rebinding） |
| A10 | 撤销后 60s 内重放 | 401 + `auth.token.reuse_detected` |

### B. 层权限（10）

| ID | 场景 | 预期 |
|---|---|---|
| B1 | 母体服务身份直接改原身设置（无用户上下文） | 403 + `deny.no_context` |
| B2 | 用户经 UI 改自己原身设置（step-up 完成） | 200；审计 `actor=user via=mother` |
| B3 | 原身装插件 | 200（allowlist 内）；矩阵记录 |
| B4 | 分身装插件 | 403 + `deny.layer_forbidden` |
| B5 | 原身开会话 | 403（产品规则；同时验证与文档一致） |
| B6 | 分身开第 2 个会话 | 409 + `deny.lease_conflict` |
| B7 | 分身改设置 | 403 |
| B8 | 分身读原身 overlay | 404/403；effective 配置可读且已脱敏 |
| B9 | 母体无 `audit.export` 读会话正文 | 403；有该能力时 200 + 审计 |
| B10 | 未知动作/未知能力 | 403 + `deny.unknown_action` |

### C. 租户与所有权（8）

| ID | 场景 | 预期 |
|---|---|---|
| C1 | 用户 A 的令牌访问 B 的原身 | 404（不泄漏存在性） |
| C2 | 分身 A 的租约写 B 的会话 | 409 + `deny.epoch_stale`/`owner_mismatch` |
| C3 | A 创建原身不消耗 B 的额度 | 账本租户隔离 |
| C4 | 跨租户读审计 | 404 |
| C5 | 跨租户导出会话 | 404 |
| C6 | body 里伪造 `tenantId` | 被忽略；以令牌为准 |
| C7 | 移除成员后旧令牌 | 60s 内 401 |
| C8 | 降级后新建资源 | 409 `quota_exceeded` + remediation；已有租约自然到期 |

### D. 凭据（10）

| ID | 场景 | 预期 |
|---|---|---|
| D1 | 扫描分身 home/profile | 无 secret 模式 |
| D2 | 分身进程读 `essences/*/overlay/credentials` | 拒绝（硬隔离）或检测告警（同 SID 降级模式），二者必须显式记录 |
| D3 | 分身用原身令牌调 Broker | 403 `audience_mismatch` |
| D4 | 原身调 Broker `read_raw` | 404/403（接口不存在） |
| D5 | Broker 令牌过期 | 401 |
| D6 | scope 与 provider 不匹配 | 403 `credential_scope` |
| D7 | 会话绑定账户 A，改用账户 B 的凭据 | 403；审计 |
| D8 | 轮换凭据后旧派生令牌 | 401 |
| D9 | 导出/备份扫描 | 无 secret |
| D10 | 母体启动后环境扫描 | 无 provider key（L2 后） |

### E. 配额（8）

| ID | 场景 | 预期 |
|---|---|---|
| E1 | 200 并发创建原身 | `物理 == 账本 == 成功 <= limit` |
| E2 | 传 `skipQuota` | 参数被拒/忽略；403 |
| E3 | 传 `tier: vip100` | 被拒/忽略；tier 由权益决定 |
| E4 | 活跃会话数 | 等于租约数，不来自目录扫描 |
| E5 | 预留后崩溃 | TTL 到期自动 refund |
| E6 | reserve/commit 之间进程崩溃 | 不泄漏额度 |
| E7 | 从官方原身派生 | 记在派生者 principal 名下 |
| E8 | 第三级子原身 | 400 |

### F. 租约与会话（8）

| ID | 场景 | 预期 |
|---|---|---|
| F1 | 两个分身争同一 `conversationId` | 第二个拒绝；`session.single_violation` |
| F2 | 旧 epoch 写入 | 409 + `stale-writer` |
| F3 | 心跳丢失 | 租约过期；后续写 409 |
| F4 | 未 seal/forfeit 就归档 | 409 |
| F5 | 重放 seal | 幂等（`manifestDigest`） |
| F6 | 分身重启 | 新 epoch；旧租约失效 |
| F7 | 租约令牌从另一进程/端口使用 | 403（绑定 spawn nonce） |
| F8 | 母体直接读会话正文 | 403（除导出能力） |

### G. 传输/CSRF/SSRF（8）

| ID | 场景 | 预期 |
|---|---|---|
| G1 | 枚举所有写路由无凭据 | 全部 401（CI 自动枚举，防新增路由漏网） |
| G2 | 检查是否存在有副作用的 GET | 无 |
| G3 | `probe` 指向元数据地址 | 403/400 + `deny.target` |
| G4 | `probe` 指向 `file://` | 400 |
| G5 | `probe` 302 到内网 | 拒绝跟随 |
| G6 | 分身 shell 读 `DSH_ADAPTER_TOKEN` | 不可见（管道交付后） |
| G7 | 替换 `desktop-bridge.json` | 对端校验失败 |
| G8 | 超大 body / 慢速请求 | 413 / 超时 |

### H. 审计（8）

| ID | 场景 | 预期 |
|---|---|---|
| H1 | 改一条记录 | `verify()` 在对应 index 失败 |
| H2 | 删一行 | 同上 |
| H3 | 分身伪造"已批准"记录 | 标 `untrusted`，不满足安全查询 |
| H4 | 拒绝请求 | 有 `authz.denied` + code + policyVersion |
| H5 | 审计里出现 secret | 扫描门禁失败 |
| H6 | 未授权导出审计 | 403 + 审计尝试 |
| H7 | 上次未干净退出 | `bootCheck` 告警 |
| H8 | 链断后继续追加 | 拒绝追加 |

### I. 破窗/恢复（5）

| ID | 场景 | 预期 |
|---|---|---|
| I1 | 单人发起破窗 | 拒绝（需第二人） |
| I2 | 窗口外使用破窗令牌 | 401 |
| I3 | 破窗动作 | 全部审计 `actor=breakglass` |
| I4 | 重置凭据 | 相关会话/令牌撤销 |
| I5 | 会话中途被降权 | 下一次敏感动作 step-up 失败 |

### J. 镜像/升级（6）

| ID | 场景 | 预期 |
|---|---|---|
| J1 | 未签名镜像包 | 拒绝 + 审计 |
| J2 | 降级到旧代 | 需显式确认 + 审计 |
| J3 | overlay 禁用锁定插件 | fatal conflict（现有行为） |
| J4 | 升级时分身在跑 | 旧代钉住；不热迁移 |
| J5 | 回滚 | 恢复代际 + 审计 |
| J6 | 镜像内藏凭据 | 不进入任何原身/分身（扫描） |

---

## 11. 实施优先级

### P0 —— 阻断项（不完成就不能对外宣称"三层权限"或"多租户"）

| 编号 | 事项 | 依赖 | 退出标准 |
|---|---|---|---|
| P0-1 | 认证主体 + 决策函数 + 路由能力表（29 条 + Adapter op） | 无 | 启动期断言"无能力即拒绝"；全部拒绝有 code + 审计；A1–A3、B1、B10 通过 |
| P0-2 | 传输 fail-closed：Adapter 无令牌拒绝；新路由禁用 `?token=`；Host/Origin/CSRF；fork env 白名单（不再 `...process.env`） | P0-1 | G1/G6/G8、A2/A7/A8/A9 通过；母体 env 无 provider key 的扫描用例建立 |
| P0-3 | 凭据不外泄：物化不复制 `credentials/`；派生 profile 不含；加密 + 0600 + 扫描门禁；凭据使用审计 | P0-1 | D1/D9 通过；`merged/`、导出包、日志 secret 扫描为 0；C-02 移除 |
| P0-4 | 额度绑定：`tenantId/ownerUserId/entitlementRef` 落 meta；tier 只读；reserve/commit；移除 `skipQuota/setTier` 外部入口；官方原身按 principal 计 | P0-1 | E1–E4/E7 通过；并发 200 不超卖 |
| P0-5 | 任务/分身携带 `essenceId` + `baseGeneration`（资源级授权的前提） | 无 | 派生请求必须带 `essenceId`；C1/C2 可测 |

> P0 的顺序：**P0-1 → P0-2 → P0-3 → P0-4 → P0-5**。P0-3 的"不复制"可以先于 Broker 落地；它只改合并语义，风险最小、收益最大。

### P1 —— 产品不变量（3–4 周量级）

| 编号 | 事项 | 退出标准 |
|---|---|---|
| P1-1 | Broker 进程（L2）+ vending/proxying + 本机 IPC 对端校验 | D2–D8 通过；母体只持 `credentialRef` |
| P1-2 | 租约服务 + 单会话 + fencing + seal/forfeit | F1–F7 通过；`checkActiveSessionQuota` 由租约授予点调用 |
| P1-3 | 审计 v2 词表 + 可信侧记账 + `trust` 标记 + 每日锚点 | H3/H4/H5 通过；导出可校验 |
| P1-4 | 角色/成员/step-up + 多账户绑定与会话绑定 | C7/I1–I5 通过 |
| P1-5 | `?token=` → cookie 双轨迁移 + 影子模式 | 影子期 1–2 版本；截止日期生效 |

### P2 —— 企业化与加固

| 编号 | 事项 |
|---|---|
| P2-1 | 复用宿主 `remoteAccess` / 统一策略引擎；策略即代码 + CI 策略测试 + 决策日志 |
| P2-2 | OS 级隔离：分身独立账户/AppContainer/Job Object；管道 SID/PID 校验 |
| P2-3 | SSO/SCIM/多租户托管：映射到同一 tenant/membership/entitlement 模型，不建第二套 |
| P2-4 | KMS/HSM、密钥轮换自动化、到期监控、SIEM 导出、季度评审日历 |

### 不做清单（明确否决）

- 不自研 token 格式或加密；用 JWS + 标准库 + OS keystore。
- 不把 `role/tier/tenantId` 放进请求体或前端存储。
- 不给不可信分身签发母体 audience 的 HMAC 令牌。
- 不在 URL 里放长期令牌；不把令牌写日志。
- 不把 UI 隐藏当权限；不把"静态矩阵"当强制点。
- 不把"同进程插件沙箱"当安全边界。
- 不先做 SSO 再补租户模型（顺序反了会返工）。

---

## 12. 验收指标

| 指标 | 目标 | 验证方式 |
|---|---|---|
| 未声明能力的路由 | 0 | 启动期断言 + CI 路由枚举 |
| 拒绝无审计 | 0 | H4 + 采样对账 |
| 跨租户成功访问 | 0 | C1–C5 持续运行 |
| 派生进程读凭据成功 | 0（硬隔离）/ 0 未告警（检测模式） | D2 |
| secret 出现在产物/日志/备份 | 0 | D1/D9 扫描门禁 |
| 撤销生效时延 | ≤ 60s | C7/A10 |
| 并发超卖 | 0/200 | E1 |
| 令牌 TTL 漂移 | 0 | 配置快照测试锁定 §7.1 表 |
| 策略版本可回溯 | 100% 决策带 `policyVersion` | 审计抽查 |
| 镜像包签名校验 | 100% | J1/J6 |

---

## 13. 待决问题（需要产品/架构拍板）

1. **权益权威在哪**：relay 托管账户/权益，还是本地签名许可文件？这决定 `tenant` 是真实多租户还是"本机单租户"的退化模型。
2. **分身是否允许独立 OS 身份**（独立账户/AppContainer）？决定 K-3 是硬边界还是"检测 + 缓解"；也决定 P2-2 的必要性。
3. **一个原身允许多少账户同时在线**？默认账户如何选？切换账户是否强制新会话？
4. **母体是否允许读会话正文**（客服/合规导出）？若允许，需要什么审批与保留策略？
5. **是否复用宿主 `remoteAccess`**？取决于 dsh-fang 声明支持的最低宿主版本；若不复用，需要维护一个同形状适配层。
6. **官方原身是否计入用户额度**？建议不计，额度按派生者 principal 计（D-10）。
7. **破窗的双人控制在单人/小团队是否可行**？可用"延迟 + 通知 + 事后复核"替代第二人。
8. **`essence.mjs` 文件头"原身可建会话"是否笔误**？必须与 `permissions.mjs`、`ESSENCE.md`、产品文案统一，否则策略无法定稿（P-08）。

---

## 附录 A：能力清单（命名规范）

```
mirror.{read,upgrade,rollback,backup,restore,delete,settings.write,lock.set}
essence.{read,list,create,update,delete,clone,promote,tier.set}
settings.{read,write}
plugin.{list,read,install,remove,update,config.write,promote_to_mirror,source.read}
account.{list,login,logout,link}
credential.{use,rotate,revoke,describe}          # 无 read_raw
session.{create,list_meta,read_content,write,archive,seal,export}
lease.{grant,renew,revoke}
task.{create,read,list,archive,restore,delete,reap,derive}
quota.{read,reserve,commit,refund}
audit.{append,read,verify,export}
tenant.{member.read,member.add,member.remove,entitlement.read,entitlement.set}
auth.{login,logout,step_up,token.issue,token.revoke}
admin.breakglass.{start,action,end}
ui.panel.read
```

## 附录 B：拒绝码

```
deny.unauthenticated
deny.unknown_principal
deny.unknown_action
deny.audience_mismatch
deny.layer_forbidden
deny.no_context
deny.tenant_mismatch
deny.owner_mismatch
deny.locked
deny.state_conflict
deny.quota_exceeded
deny.lease_conflict
deny.epoch_stale
deny.step_up_required
deny.dual_control_required
deny.credential_scope
deny.generation_mismatch
deny.origin_mismatch
deny.csrf
deny.rate_limited
deny.policy_failed
deny.target_forbidden
```

---

*本文件是设计提案，不改变现有代码行为。P0-1 落地时，`permissions.mjs` 保留为矩阵的只读投影，执行路径切换到本文 §3 的决策函数。*
