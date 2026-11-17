# B 契约委托 · 首批能力清单（v1 提案）

> 阶段：D2 下一阶段（**不阻塞 v3.5.0 发布**）。本文给出契约委托的第一批候选能力、协议设计、安全门禁与验收标准；**实现前需用户确认所选范围**。
> 现状依据：`src/contract/constants.js`（METHODS / METHOD_VERSION / ERROR_CODES）、`src/plugins/orchestrator.mjs`（契约 handler 组装，约 2069–2095 行）、`docs/D2-NEXT-PHASE.md`。

## 0. 实现状态（2026-11-17 · P0 已落地）

**已实现**（`src/lib/contract-delegation.mjs` + orchestrator invoke 路由委托守卫）：

| 项 | 内容 |
|---|---|
| 委托声明 | `envelope.meta.delegate === true` 才进入委托校验；未声明 = 旧调用方语义不变（不回归） |
| 白名单 | 默认只读 5 项：`fang.capability.list` / `fang.orchestrator.status` / `fang.session.list` / `fang.decision.list` / `fang.approvals.list`；未登记 → `contract-unsupported` |
| 配置 | `contract.delegate = { enabled, allow[], maxPayloadBytes=64KiB, readTimeoutMs=5s, writeTimeoutMs=30s }`；`enabled:false` → `contract-unavailable` |
| 错误码 | `contract-unavailable` / `contract-unsupported` / `contract-timeout` / `contract-invalid-request`（服务不可用统一映射为 contract-unavailable） |
| 限额/超时 | 超 64KiB → `contract-invalid-request`；读超时（默认 5s）→ `contract-timeout` |
| 审计 | 每次委托写 `contract-delegate`：`{capability, source, outcome, error, latencyMs}`（拒绝/成功/错误都记） |
| 新增方法 | `fang.capability.list`、`fang.decision.list`、`fang.approvals.list`、`fang.session.events`（母体 sessionCatalog.readHead 有界头读，≤200 行 / ≤256KB；服务缺失显式报错）、`fang.tool.invoke`（首批 `tool:'lsp'`） |

**e2e 真实断言**（`tools/e2e.mjs`，2026-11-17）：hello 200/`contractVersion=1.1.0`/**14 个方法**；`capability.list` 返回只读 5 项；`fang.fork.spawn` 委托被拒 `contract-unsupported`；`fang.orchestrator.status` 委托成功；`fang.session.list` 缺服务映射 `contract-unavailable`。

**未实现（待确认后推进）**：P1 `fang.tool.invoke`（lsp）/ `fang.chat.import`；异步长任务模型；背压/并发上限；分侧调用方身份（目前记录 `meta.source` 审计，未做 per-fork 鉴权策略）；UI client half。

### 0.1 生产母体服务确认（2026-11-17，`npm run probe:mother`）

工具：`node tools/release/mother-capability-probe.mjs --base <motherUrl> --token-file <dataDir>/fang-auth.json`

本机生产母体实测：

```
mother http://127.0.0.1:50895 role=mother version=3.4.2 status=200 auth=true
contract version=1.1.0 methods=11 delegation=false   ← 生产仍在 3.4.2，重启 3.5.0 后才有委托方法
readiness: fang.orchestrator.status=READY | fang.session.list=READY | fang.capability.list=MISSING(旧版本)
evidence: /fang/api/sessions -> 200 (5 item(s))
```

结论：
- **`session-catalog` 插件在生产母体已挂载并服务**（`/fang/api/sessions` 200 + 真实会话项；该路由由 `src/plugins/session-catalog.mjs` 注册），因此 `fang.session.list` 可以保留在首批；
- e2e 环境是**精简 profile**，未挂载 session-catalog，故 e2e 中委托返回 `contract-unavailable` 属于已覆盖的“服务缺失”分支；
- `fang.capability.list` 在生产缺失仅因为运行版本为 3.4.2（委托功能在 3.5.0 才引入）——**重启到 3.5.0 后需用同一 probe 复测**，作为发布后验收项。

### 0.2 M1 验收（2026-11-17）

| M1 要求 | 实现 | 单测 |
|---|---|---|
| 能力注册表 | `CAPABILITY_CATALOG`（fang 委托层，6 项只读）+ `DEFAULT_READ_ALLOW`；未登记默认拒绝 | `M1 registry: fang delegation catalog is append-only, read-only and whitelist-consistent` |
| hello 广告 | `contract.hello` 广告 **实际注册的 handler**（新增 3 个委托方法随注册自动出现；vendored contract SDK 保持 1.1.0 逐字节不变） | `M1 hello advertises fang-layer handlers registered on the contract server` |
| 白名单校验 | invoke 路由 `meta.delegate=true` + `checkDelegation()`；未登记 → `contract-unsupported`；`enabled:false` → `contract-unavailable` | `checkDelegation: disabled → contract-unavailable, not listed → contract-unsupported, listed → ok` |
| 错误码 | fang 委托层稳定表：`contract-unavailable/unauthorized/unsupported/timeout/invalid-request`（唯一性 + 稳定性断言） | `M1 error codes: fang delegation codes are a unique, stable append-only table` |
| 版本裁剪 | `negotiate()` 按 `METHOD_VERSION` 裁剪：1.0 对端拿不到 1.1 方法（relay），1.1 对端完整可见 | 2 个 `M1 version trimming` 用例 |
| payload 上限 | `exceedPayloadLimit()`（默认 64KiB）→ `contract-invalid-request` | `exceedPayloadLimit: default 64KiB boundary` |

> 设计取舍：为保持 vendored contract SDK（`@twinsearth/dsh-fang-contract@1.1.0`）**逐字节一致**（有 vendor-sync 门禁），委托方法名/错误码注册在 fang 层；hello 广告仍由实际注册 handler 驱动，对端看到的能力与白名单一致。

### 0.3 M2 验收（P0 只读四件 + B-5 复用，2026-11-17）

| 能力 | 实现 | 单测 / e2e |
|---|---|---|
| B-1 `fang.capability.list` | fang 层目录 + limits 自述 | 单测 catalog/hello；e2e 200 返回只读 6 项 |
| B-2 `fang.session.events` | 母体 `sessionCatalog.readHead`（有界 ≤200 行 / ≤256KB、只读） | e2e 200（有结果，或服务缺失 → contract-unavailable） |
| B-3 `fang.decision.list` | decisionCenter.snapshot（只读、≤50 条） | 单测白名单；e2e 目录含该能力（服务缺失 → contract-unavailable） |
| B-4 `fang.approvals.list` | approver.pending（只读、≤50 条） | 同上 |
| B-5 `fang.session.list` | 复用既有 `sessionCatalog.list` | e2e 真实委托调用成功（生产已确认 sessionCatalog READY） |
| 越权被拒 | `fang.fork.spawn` 委托 → `contract-unsupported` | e2e 200 + contract-unsupported |
| 超时错误 | e2e 母体 `readTimeoutMs=100` + 测试缝 `fang.test.sleep`（仅 `FANG_CONTRACT_TEST_HOOKS=1`，必须 `meta.delegate=true`） | e2e → `contract-timeout` |

> 测试缝只存在于 e2e 进程（环境变量控制），不进目录/生产部署；`allow` 白名单是权威放行表，目录仅用于能力自述。

### 0.4 M3 验收（B-6 lsp 委托，2026-11-17）

| 项 | 实现 | 单测 / e2e |
|---|---|---|
| `fang.tool.invoke`（首批仅 `tool:'lsp'`） | `validateToolInvoke()` 校验 tool/action/file；目录登记 kind=`write`、approval=`required`，**默认不在白名单**，需操作者显式放行 | 单测 `test/lsp-delegation.test.mjs` 4 项 |
| 只读子命令 | `diagnostics` / `hover` / `definition` / `references` → 自动放行 | e2e：diagnostics 成功（provider=test-hook） |
| 写类子命令 | `format` / `rename` / `codeAction` / `apply` → **委托层拒绝执行**，返回 `contract-approval-required`（无副作用） | e2e：format → contract-approval-required |
| 非法子命令 | 未知 action → `contract-invalid-request` | e2e：nope → contract-invalid-request |
| 错误码 | 新增 `contract-approval-required`（fang 层表，唯一性断言） | 单测 |

> **诚实的边界**：LSP 的**执行提供方**尚未接入母体 DSH 工具运行时（当前仅 e2e 测试缝提供确定性 diagnostics；生产读类动作会返回 `contract-unavailable`）。委托通道、白名单、审批门禁与错误码已经完整；接入真实 LSP provider 属下一里程碑（需确认母体工具调用 API）。

## 1. 现有契约能力（只读盘点）

| 方法 | 版本 | 类型 | 现有实现 |
|---|---|---|---|
| `contract.hello` / `contract.health` | 1.0 | 只读 | 能力/版本协商（server.js） |
| `fang.fork.spawn` / `stop` / `list` | 1.0 | 写 / 写 / 只读 | forker 服务 |
| `fang.decision.create` / `resolve` | 1.0 | 写 / 写 | decisionCenter |
| `fang.session.list` | 1.0 | 只读 | sessionCatalog.list（母体侧） |
| `fang.orchestrator.status` | 1.0 | 只读 | orchestrator.status |
| `fang.relay.publish` / `status` | 1.1 | 写 / 只读 | relay store |

错误码已标准化：`invalid-envelope` / `unsupported-method` / `unsupported-version` / `contract-incompatible` / `transport-*` / `remote-error` / `all-transports-failed` / `handler-threw`。

**关键点**：现有方法面向「母体被外部调度」，尚缺「加速分身 → 母体申请无头能力」的**白名单委托层**。

### 1.1 e2e 真实基线（2026-11-17，`tools/e2e.mjs` 已加断言）

| 调用 | 结果 | 说明 |
|---|---|---|
| `POST /fang/api/contract/hello`（Bearer） | ✅ 200，`contractVersion=1.1.0`，advertise **11 个方法** | HTTP 契约要求 `contract.token` Bearer；e2e profile 已注入测试 token |
| `POST /fang/api/contract/invoke` → `fang.orchestrator.status` | ✅ 200 + result | 委托只读能力**已真实可用** |
| `POST .../invoke` → `fang.session.list` | ⚠️ 200 + `fang-service-unavailable`（e2e 精简 profile 未挂载 session-catalog） | **生产母体已确认具备**（§0.1：`/fang/api/sessions` 200 + 真实会话项），保留首批；e2e 覆盖“服务缺失→contract-unavailable”分支 |
| 无 Bearer / 未配 token | 401 / 503（`contract-unauthorized` / `contract-token-required`） | fail-closed 已生效 |

## 2. 第一批候选能力

### P0 · 只读（无需审批，先打通链路）

| # | 提议方法 | 输入 | 输出 | 错误码 | 备注 |
|---|---|---|---|---|---|
| B-1 | `fang.capability.list` | `{}` | `{contractVersion, capabilities:[{name, version, kind:'read'|'write', approval, since}]}` | `unsupported-version` | 引导方法：加速分身先取可用清单再调用；白名单由母体配置决定 |
| B-2 | `fang.session.events` | `{sessionId, limit<=200, sinceSeq?}` | `{sessionId, events:[…], truncated, nextSeq}` | `unknown-session`, `session-unreadable`, `payload-too-large` | 有界只读；供加速分身 UI/插件读取母体会话投影（不做写） |
| B-3 | `fang.decision.list` | `{status?, limit<=50}` | `{items:[{id,level,status,title,at}]}` | `decision-center-unavailable` | 母体决策中心快照（只读） |
| B-4 | `fang.approvals.list` | `{limit<=50}` | `{items:[{id,kind,risk,state,title,at}]}` | `approver-unavailable` | 母体审批队列只读视图 |
| B-5 | （复用）`fang.session.list` | 既有 | 既有 | 既有 | 已有能力，作为首个**无需新增代码**的委托样例入冒烟 |

### P1 · 受控写/执行（显式审批 + 审计）

| # | 提议方法 | 输入 | 输出 | 审批策略 | 备注 |
|---|---|---|---|---|---|
| B-6 | `fang.tool.invoke`（首批只放开 `tool:'lsp'`）**已实现通道+审批门禁；执行 provider 待接入（见 §0.4）** | `{tool:'lsp', action:'diagnostics'\|'hover'\|'definition'\|'references', file, line?, character?}` | 工具结果原样（大小上限 256KB） | 只读子命令自动放行；任何写类子命令需瓮城审批 | 加速核缺 `dsh-tool-lsp`（COMPAT §3.5 `string-reference`），这是最明确的能力缺口 |
| B-7 | `fang.chat.import` | `{source:'deepseek', sessionId, dryRun?:true}` | `{imported, skipped, digest}` | 默认 `dryRun:true`；实际导入需审批 | 加速核无 chat-import bundle（COMPAT §2） |

### P2 · 暂缓（高风险/待定）

| # | 能力 | 原因 |
|---|---|---|
| B-8 | `fang.code.run`（run_code / code-runtime） | 加速核缺 `dsh-code-runtime`；代码执行安全边界大，需独立评审 |
| B-9 | UI client half 代理 | 契约只覆盖无头能力；UI 走浏览器模块映射（另一阶段） |
| B-10 | 任意第三方工具透传 | 违反白名单原则，不做 |

## 3. 安全与门禁（所有委托共享）

1. **白名单**：母体 config 显式声明 `contract.delegate.allow = ['fang.session.events', 'fang.tool.invoke:lsp', …]`；未登记 → `unsupported-method`，**不静默降级**。
2. **鉴权**：复用安装级 token + 契约 transport 鉴权；仅接受 `role:'fork'` 的调用方身份。
3. **审批**：`kind:'write'` 能力必须经母体审批队列（复用 decisionCenter/approver）；拒绝/超时 → 明确错误码。
4. **限额**：单次 payload ≤ 256KB、输出 ≤ 256KB；每能力超时（读 5s / 写 30s）；每分身并发上限。
5. **审计**：每次委托记录 `capability / callerForkId / outcome / latencyMs / approvalId?`，写母体审计账本。
6. **隔离**：只读能力不触碰母体写路径；写能力走既有审批与门禁（主城门禁不绕过）。

## 4. 契约版本与兼容

- **只能追加方法**（现有约定）；新增方法标记 `METHOD_VERSION = '1.2'`，`CONTRACT_VERSION` 1.1 → **1.2**（需用户确认）；
- `contract.hello` 自动广告已注册方法（server.js 由 handlers 生成 methods 列表），旧调用方不受影响；
- 未登记/旧版本 → `unsupported-method` / `unsupported-version`（可读错误，不静默）。

## 5. 实现里程碑与验收

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 | 能力注册表 + hello 广告 + 白名单校验 + 错误码 | 单测：未登记拒绝、版本裁剪、payload 上限 |
| M2 | P0 只读四件（B-1..B-4）+ B-5 复用 | 单测 + e2e：真实母体上调用成功、越权被拒、超时错误 |
| M3 | B-6 `lsp` 委托：只读子命令打通 + 审批路径 | e2e：加速分身调用 lsp diagnostics 成功；写类子命令需审批 |
| M4 | B-7 dryRun/审批导入 + 冒烟脚本 + 文档 | 冒烟：dryRun 结果一致；审批拒绝路径明确 |
| M5 | 审计与限流压测 | 审计记录完整；超时/并发上限生效 |

## 6. 待用户确认

1. **首批范围**：建议 `B-1..B-4 + B-5（复用）` 先做（纯只读、零审批），`B-6 lsp` 紧随；`B-7 chat.import` 是否入首批？
2. **写操作审批策略**：tool.invoke 的只读/写子命令划分是否按上表？
3. **契约版本**：是否同意 `CONTRACT_VERSION` 升到 1.2（仅追加）？
4. **P2 的 `fang.code.run`**：是否后续立项（高风险需单独评审）？
