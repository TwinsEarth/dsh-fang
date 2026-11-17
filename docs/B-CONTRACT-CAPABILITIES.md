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

**e2e 真实断言**（`tools/e2e.mjs`，2026-11-17）：hello 200/`contractVersion=1.2.0`/**18 个方法**；`capability.list` 返回只读 6 项；`fang.fork.spawn` 委托被拒 `contract-unsupported`；`fang.orchestrator.status` 委托成功；`fang.session.list` 缺服务映射 `contract-unavailable`。

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
| hello 广告 | `contract.hello` 广告 **实际注册的 handler**（新增 3 个委托方法随注册自动出现；vendored contract SDK 已升到 **1.2.0**，委托方法与错误码进入 append-only 注册表） | `M1 hello advertises registered methods` |
| 白名单校验 | invoke 路由 `meta.delegate=true` + `checkDelegation()`；未登记 → `contract-unsupported`；`enabled:false` → `contract-unavailable` | `checkDelegation: disabled → contract-unavailable, not listed → contract-unsupported, listed → ok` |
| 错误码 | fang 委托层稳定表：`contract-unavailable/unauthorized/unsupported/timeout/invalid-request`（唯一性 + 稳定性断言） | `M1 error codes: fang delegation codes are a unique, stable append-only table` |
| 版本裁剪 | `negotiate()` 按 `METHOD_VERSION` 裁剪：1.0 对端拿不到 1.1 方法（relay），1.1 对端完整可见 | 2 个 `M1 version trimming` 用例 |
| payload 上限 | `exceedPayloadLimit()`（默认 64KiB）→ `contract-invalid-request` | `exceedPayloadLimit: default 64KiB boundary` |

> 设计取舍：契约 SDK 1.2.0 仅做 **append-only**（新增 3 个委托方法 + 7 个委托错误码 + METHOD_VERSION；不改既有方法语义）；vendored 副本已从 contract 仓库重新同步（8 文件 sha256 钉死，vendor-sync 门禁绿色）。委托白名单/限额/审计仍由 fang 层实现。

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

### 0.4 M3–M3.1 验收（B-6 lsp 委托：通道 + 真实 provider 接入，2026-11-17）

| 项 | 实现 | 单测 / e2e |
|---|---|---|
| `fang.tool.invoke`（首批仅 `tool:'lsp'`） | `validateToolInvoke()` 校验 tool/action/file/line/character；目录登记 kind=`write`、approval=`required`，**默认不在白名单**，需操作者显式放行 | 单测 `test/lsp-delegation.test.mjs` 5 项 |
| 只读动作（官方口径，目录只 advertise 这 4 项） | `definition` / `references` / `implementation` / `hover` → 映射官方 seam `goToDefinition/findReferences/goToImplementation/hover`；**参数 `line/character` 为 0-based 非负整数（seam 原生坐标，直接透传；非整数/负数 → contract-invalid-request）**；`file` 必填、operation 闭集；自动放行；**目录 actions 仅取 provider 实提供能力（无 provider 时 `[]`）** | 单测 `test/lsp-delegation.test.mjs` 5 项 + `test/lsp-provider.test.mjs` 11 项；e2e：真实 provider definition/references/hover |
| 写类/legacy 动作 | 官方能力缝明确只读；`format` / `rename` / `codeAction` / `apply` 从官方语义移除 → **可读拒绝** `contract-unsupported`（消息含 “official LSP seam is read-only”），无副作用；**通用审批门禁路径保留**（`kind=write` → `contract-approval-required`，未来自定义 provider 显式登记写类动作才可达） | e2e：format → contract-unsupported；单测 `lsp-delegation` 5 项 |
| `diagnostics`（仅测试缝，non-production） | 不属于官方 provider 能力：**不进入能力目录、不对外 advertise**；能力目录 `provider.nonProduction` 明确标记 `test-hook`；仅 `FANG_CONTRACT_TEST_HOOKS=1` 且无真实 provider 时返回确定性 stub（`testSeam:true / nonProduction:true`）；真实 provider/生产 → `contract-unsupported`（detail.reason=test-seam-only） | e2e：目录 nonProduction 标记 + 测试缝结果标记 + 真实 provider 下可读拒绝 |
| 按“实提供能力”advertise | `advertisedActionsFromSeam(lspService)`：真实 provider 若声明 `supportedOperations`/`capabilities`，只 advertise 与官方 4 操作的**交集**；无 provider 时 `actions: []`（不虚假宣称）；测试缝/ fork-local 未安装时均不产生 actions | 单测交集/空集/nonProduction |
| **错误码映射（契约口径）** | `LSP_UNAVAILABLE`→`contract-unavailable`；`LSP_FILE_OUTSIDE_WORKSPACE` / `LSP_INVALID_PROVIDER`→`contract-invalid-request`；`LSP_MALFORMED_RESPONSE` / `LSP_SERVER_ERROR`→`contract-unavailable`（附 `detail.lspCode` + `detail.serverMessage`，可读） | 单测 `lsp-provider`：5 组映射逐条断言 |
| **结果归一化（契约口径）** | `locations` → `[{path, line, character}]`（**1-based 展示**，path 由 file:// URI 解码）；`hover` → `{contents}`；**超限裁剪**：`contract.delegate.lsp.maxLocations`（默认 200）/`maxResultChars`（默认 20000），超出标记 `truncated` 并附 `totalLocations` | 单测：路径/1-based/裁剪断言 |
| **超时/并发/审计** | 复用 M5：`maxConcurrent` 门禁、`contract-delegate` 审计 outcome（ok/denied/error + workspaceRoot + latencyMs）；LSP 查询使用 `writeTimeoutMs` 冷启动预算（语言服务器首次拉起），其余只读能力仍用 `readTimeoutMs` | 单测审计 record；e2e：lspRecords outcomes=[ok,denied] |
| **路线 A（母体 provider，优先）** | 母体 fang 插件从 host ctx 取 `ctx.lsp`，直接 `query({operation,filePath,position,workspaceRoot})`；**workspaceRoot 允许范围 = 母体配置根 + 所有 fork 工作区根（显式登记：任务 registry 的 workspace 索引；`includeForkWorktrees` 可关）**，realpath 包含校验；结果归一化 locations/hover；seam 错误码映射 | `src/lib/lsp-provider.mjs`；真实 provider 闭环：`setup:lsp-live` + `test:lsp-live`（e2e `--lsp` **125/125**：definition/hover/references 真实语义、fork 根自动登记、越界根 `contract-unauthorized`、文件逃逸 `contract-invalid-request`、审计含 workspaceRoot/outcome） |
| **安装形态（bundle）** | `lsp-provider/` 配置型 bundle：依赖官方三件套（0.2.2-rc.3）+ npm `typescript-language-server@6.1.0` + `typescript@5.9.3`（精确锁定）；patch **最小组合** = fs-local + subprocess-local + dsh-lsp + dsh-lsp-stdio + dsh-tool-lsp（官方 README 组件集；本 DSH 解析器要求 `insert:` + id，裸 `- name:` 行会被静默忽略——已由 boot 探针实测）；**写类不提供**（跟随官方只读）；A=母体 profile（先做），B=加速分身 profile（后续增强） | `test/lsp-provider-bundle.test.mjs` **4 项** + `test:lsp-bundle` **5/5**（真实 install→boot：ctx.lsp + tools/lsp）；安装：Plugins → Add plugin 选目录 |
| **M3.3 真实 provider 接入（已验收）** | fang 插件实现 `ctx.lsp.query` 映射（4 只读动作→官方 seam ops）+ workspaceRoot 策略（配置根 + 任务 registry 的 fork 工作区根自动登记 + realpath 包含校验）+ 审计（workspaceRoot/outcome/latency 入 `contract-delegate`） | e2e `--lsp` **125/125**：主工作区 definition/hover/references、**fork 工作区根自动登记后可查询**、越界根/文件逃逸均 `contract-invalid-request`、审计 `ok/denied` trail |
| **M3.5 语言服务器锁定（已落地）** | `typescript-language-server@6.1.0` + `typescript@5.9.3` + 官方三件套 `0.2.2-rc.3` 精确随 bundle 依赖锁定；`LOCKED-VERSIONS.json` 与 package.json 双向一致性测试；`setup:lsp-live` 同版本可复现 | `test/lsp-provider-bundle.test.mjs` **4 项**；锁版本后 e2e `--lsp` 125/125、`test:lsp-bundle` 5/5 |
| **M3.4 e2e TS fixture（已验收）** | 真实 TS 双文件 fixture（`a.ts` import `base.ts`）：definition（alias→import 位置）、**references 跨文件解析**（base.ts + a.ts）、hover（含 `(alias) const base: 1`）；根策略：fork 工作区根自动登记、越界根 `contract-unauthorized`（reason=root-not-allowed）、文件逃逸 `contract-invalid-request`（reason=file-outside-root） | e2e `--lsp` **125/125** |
| **M3.2 bundle 安装到测试 profile（已验收）** | `npm run test:lsp-bundle`（`tools/release/lsp-bundle-install.mjs`）：临时 `$DSH_HOME` 测试 profile 内链接 `lsp-provider/` bundle + staging 依赖，诊断探针在插件树稳定后采样 | **5/5 PASS**：bundle 链接 ✓、母体 boot ✓、`ctx.lsp` 存在且 `query` 可用 ✓、`tools` 服务可见 ✓、**已知工具含 `lsp`** ✓ |
| **路线 A 审计** | 每次 LSP 尝试写 `contract-delegate`（`tool:'lsp'`、action、provider、workspaceRoot、outcome、latencyMs）；拒绝（越界根/动作不支持）同样入账 | e2e：lspRecords=3，outcomes=[ok,denied] |
| **路线 B（fork-local，增强）** | 加速核检测 `@twinsearth/dsh-lsp` / `dsh-lsp-stdio` / `dsh-tool-lsp`（`detectForkLspSupport`），安装后 LSP 跑在分身自己工作区；未安装时保持路线 A/显式不可用 | `writeAcceleratedForkProfile(...).forkLsp`；单测 |
| 能力目录按 provider 区分 | `fang.capability.list` 的 `fang.tool.invoke` 附带 `provider: {available, default, services, actions}`，顶层另有 `lspProvider`；生产未装 LSP 栈时 `available=false` 显式可读 | e2e：catalog provider-tagged 断言 |
| 非法子命令 | 未知 action → `contract-invalid-request`；缺 file/位置 → `contract-invalid-request` | e2e：nope → contract-invalid-request |
| 错误码 | 复用 contract 1.2 的委托错误码（approval-required/timeout/unauthorized 等） | 单测 |

> **路线 B（fork-local）契约口径（2026-11-17 定；语言服务器来源已定 ①，B 安装仍默认关闭）**：
> 1. **契约不新增 fork-local 方法/错误码**：`fang.tool.invoke:lsp` 仍只承载**母体侧 provider**（路线 A，provider=`mother`）；fork-local 的 LSP 在加速分身本地 `ctx.lsp` 执行，**不经过契约委托**；
> 2. **能力目录按 provider 显式区分**：`lspProvider.providers` 含 `mother`（mode=`delegated`，source=`mother-process`）与 `fork-local`（mode=`local`，source=`fork-worktree`），各自只 advertise **实提供**的只读操作；未安装 fork-local 时 `available:false`、`actions:[]`（不产生虚假条目）；测试缝只出现在 `nonProduction` 标记里；
> 3. **fork-local 的可用性**由分身侧 `writeAcceleratedForkProfile(...).forkLsp`（`available/packages/missing`）+ 任务记录 `accelerated.forkLsp` 呈现，母体目录里只作就绪探测（不改变执行路径）；
> 4. **安装默认关闭**：bundle 依赖已锁定；路线 B 安装作为后续增强，需显式安装/启用，不自动装载到 fork profile。

> **动作集合对齐（B-6 口径，2026-11-17）**：契约动作 ↔ 官方 seam 操作 = `definition`↔`goToDefinition`、`references`↔`findReferences`、`implementation`↔`goToImplementation`（本表新增，真实 TS interface implementation e2e 已验证）、`hover`↔`hover`；`diagnostics` 不在官方能力缝（仅测试缝保留、`nonProduction` 标记、不 advertise）；写类（format/rename/codeAction/apply）官方无对象，可读拒绝，通用审批门禁保留给未来自定义 provider。

> **母体接入最小正确路径（2026-11-17 确认）**：无需伪造 Agent Session、也不经过 tools 服务，直接：
> `const lsp = ctx.get('lsp'); const result = await lsp.query({ operation: 'goToDefinition', filePath, position: { line, character }, workspaceRoot }, signal)`。
> 依据：能力缝本身不要求 Agent Session（E7：`workspaceRoot` 是调用者显式传入的必填字段）；`dsh-tool-lsp` 的 Agent Session 要求（E10）只约束**模型工具**，不约束委托。fang 的 handler 即走该 seam（`queryMotherLsp`），e2e 母体无 Agent Session 也能完成 definition/references/implementation/hover。
> **安全边界（2026-11-17，E5 事实）**：加速核有同版本 LSP trio 时，fork-local 让 LSP 跑在**分身自己的 workspace/worktree**，语义上优于“把分身文件路径交给母体进程”；而母体委托的 `workspaceRoot` 由调用方传入，`dsh-lsp-stdio` 明确 **trusts its configured server，无沙箱**，因此母体必须用允许根限制文件读取面（realpath 包含 + fail-closed，越界 `contract-invalid-request`），否则等于把母体进程的读取面扩大到调用方任意路径。两条路线**并存**：`provider: 'mother' | 'fork-local'` 在能力目录显式区分；fork-local 无法覆盖“LSP 服务器只装在母体/共享缓存”的场景，故母体 provider 仍是默认。
>
> **诚实的边界**：路线 A 的**代码路径已完整**并在隔离 staging 中用真实 provider 跑通（`setup:lsp-live` / `test:lsp-live`）；但**母体正式 profile 尚未安装**官方 LSP 栈，生产读类动作仍显式 `contract-unavailable`，默认 e2e 使用测试缝提供确定性结果。
>
> **调研与决策（2026-11-17）**：官方 LSP 为可选包族；能力缝 `ctx.lsp.query` 不需要 Agent Session；只支持 4 个只读操作。**路线 A 先行（对应 B-6 目标），路线 B 作为增强，能力目录按 provider 区分**。详见 [`docs/LSP-PROVIDER-RESEARCH.md`](LSP-PROVIDER-RESEARCH.md)。

### 0.5 M4 验收（B-7 chat.import，2026-11-17）

| 项 | 实现 | 单测 / e2e / 冒烟 |
|---|---|---|
| `fang.chat.import` | `validateChatImport()`（source 仅 `deepseek`、sessionId 白名单正则、`dryRun` 默认 true）；kind=`write`、approval=`required`、默认不在白名单 | 单测 `test/chat-import-delegation.test.mjs` 4 项 |
| dryRun 一致性 | 纯函数 `buildChatImportDryRun()`（确定性 digest、found/wouldImport/skipped、approvalRequired）；同输入两次调用**逐字节一致** | e2e：两次 dryRun 结果 JSON 相等 |
| 审批拒绝路径 | `dryRun:false` → 委托层拒绝执行、零副作用，返回 `contract-approval-required`（detail 含 dryRun 预览） | e2e：real import → contract-approval-required |
| 冒烟脚本 | `npm run smoke:contract-delegation -- --base <motherUrl> --token-file <dataDir>/fang-auth.json`：capability.list / session.list / session.events / lsp 读+写 / chat.import dryRun 两次一致性 + 真实导入审批拒绝；写能力未放行时记 SKIP | 对生产 3.4.2 实跑：`PASS health` → `SKIP older build`（重启 3.5.0 后应转绿） |

### 0.6 M5 验收（审计与限流压测，2026-11-17）

| 项 | 实现 | 单测 / e2e |
|---|---|---|
| 审计完整性 | 每次委托（成功 / 白名单拒绝 / 超时 / 限流 / 服务不可用）都写 `contract-delegate`：`{capability, source, outcome, error, latencyMs}` | 单测 audit 形状；e2e 审计账本断言 `records=20`，outcome 覆盖 `ok/rejected/error/rate-limited`，且记录 `contract-timeout` |
| 并发上限 | `contract.delegate.maxConcurrent`（默认 4，1–64）；`createDelegationGate()` 超限**立即**返回 `contract-rate-limited`（fail-closed，不排队） | 单测 gate 获取/释放/超限；e2e：母体 `maxConcurrent=2` + 8 并发 80ms 委托 → `ok=2, rateLimited=6` |
| 超时上限 | `readTimeoutMs`（默认 5s）→ `contract-timeout`（已覆盖） | e2e 断言 |
| 错误码 | 新增 `contract-rate-limited`（fang 层表，唯一性断言） | 单测 |

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
| B-7 | `fang.chat.import` **已实现通道+dryRun+审批门禁（§0.5）** | `{source:'deepseek', sessionId, dryRun?:true}` | `{imported, skipped, digest}` | 默认 `dryRun:true`；实际导入需审批 | 加速核无 chat-import bundle（COMPAT §2） |

### P2 · 决议（2026-11-17，用户确认）

| # | 能力 | 决议 |
|---|---|---|
| B-8 | `fang.code.run`（run_code / code-runtime） | **单独专业版能力**：默认**不开启**，不进普通能力目录/默认白名单；需**手动单独每项授权激活**（专业版配置启用 + 该项显式 allow + 每次调用审批）；实现前必须**独立安全评审**。当前未注册 handler → 请求返回 `contract-unsupported`（有单测 + e2e 覆盖） |
| B-9 | UI client half 代理 | 契约只覆盖**无头能力**；UI 走**浏览器模块映射**（独立阶段，先 spike），不进入契约委托 |
| B-10 | 任意第三方工具透传 | **明确不做**（违反白名单原则）；只允许“已注册 + 白名单”的能力，未注册一律 `contract-unsupported`（单测覆盖） |

> B-8 的激活链（实现时按此设计）：① 专业版构建/配置开启 `code.run` 专项开关（默认 false）→ ② 该项加入委托 allow → ③ 每次调用仍需审批票 → ④ 全程审计 + 资源限额（超时/并发/输出上限）。三项缺一即拒绝，且拒绝路径显式可读。

## 3. 安全与门禁（所有委托共享）

1. **白名单**：母体 config 显式声明 `contract.delegate.allow = ['fang.session.events', 'fang.tool.invoke:lsp', …]`；未登记 → `unsupported-method`，**不静默降级**。
2. **鉴权**：复用安装级 token + 契约 transport 鉴权；仅接受 `role:'fork'` 的调用方身份。
3. **审批**：`kind:'write'` 能力必须经母体审批队列（复用 decisionCenter/approver）；拒绝/超时 → 明确错误码。
4. **限额**：单次 payload ≤ 256KB、输出 ≤ 256KB；每能力超时（读 5s / 写 30s）；**委托并发上限 `maxConcurrent`（默认 4，超过立即 `contract-rate-limited`，不排队）**。
5. **审计**：每次委托记录 `capability / callerForkId / outcome / latencyMs / approvalId?`，写母体审计账本。
6. **隔离**：只读能力不触碰母体写路径；写能力走既有审批与门禁（主城门禁不绕过）。

## 4. 契约版本与兼容

- **只能追加方法**（现有约定）；新增方法标记 `METHOD_VERSION = '1.2'`，`CONTRACT_VERSION` 1.1 → **1.2.0（用户已确认，已实施）**；vendored `src/contract` 从 contract 仓库 1.2.0 重新同步（8 文件 sha256 钉死）；
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

## 6. 首批范围（已确认 · 2026-11-17）

用户确认口径：**B-1..B-4 + B-5（复用）先做（纯只读、零审批）→ B-6 lsp 紧随 → B-7 chat.import 纳入**。执行结果：

| 范围 | 能力 | 状态 |
|---|---|---|
| 先行（只读） | B-1 `capability.list`、B-2 `session.events`、B-3 `decision.list`、B-4 `approvals.list`、B-5 `session.list`（复用） | ✅ M2 完成 |
| 紧随 | B-6 `fang.tool.invoke`（lsp：只读子命令放行；写类 `contract-approval-required`） | ✅ M3 完成（真实 LSP provider 待接入） |
| 纳入 | B-7 `fang.chat.import`（dryRun 默认、确定性预览；真实导入审批拒绝） | ✅ M4 完成 |
| 加强 | 审计完整性 + 并发/超时上限（`contract-rate-limited` / `contract-timeout`） | ✅ M5 完成 |

**范围外（保持待定/后续）**：
1. `fang.code.run`（P2）：**单独专业版**，默认关闭，需手动单独每项授权激活 + 独立安全评审；当前请求显式 `contract-unsupported`；
2. LSP **真实执行 provider** 接入母体 DSH 工具运行时（需确认工具调用 API）；
3. UI client half 浏览器映射（独立阶段，先做单个 spike；契约不代理 UI）；
4. 任意第三方工具透传：**明确不做**（B-10）；
5. 契约 SDK 版本：**已按用户确认升到 1.2.0（仅追加）**；vendored 副本从 contract 仓库重新同步（8 文件 sha256 钉死），旧 1.1 对端按 METHOD_VERSION 自动裁剪 1.2 方法。
