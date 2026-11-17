# B 契约委托 · 首批能力清单（v1 提案）

> 阶段：D2 下一阶段（**不阻塞 v3.5.0 发布**）。本文给出契约委托的第一批候选能力、协议设计、安全门禁与验收标准；**实现前需用户确认所选范围**。
> 现状依据：`src/contract/constants.js`（METHODS / METHOD_VERSION / ERROR_CODES）、`src/plugins/orchestrator.mjs`（契约 handler 组装，约 2069–2095 行）、`docs/D2-NEXT-PHASE.md`。

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
| `POST .../invoke` → `fang.session.list` | ⚠️ 200 + `fang-service-unavailable` | 该能力依赖母体 `sessionCatalog` 服务；e2e 精简 profile 未挂载。生产母体需确认服务存在后才能列入首批 |
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
| B-6 | `fang.tool.invoke`（首批只放开 `tool:'lsp'`） | `{tool:'lsp', action:'diagnostics'\|'hover'\|'definition'\|'references', file, line?, character?}` | 工具结果原样（大小上限 256KB） | 只读子命令自动放行；任何写类子命令需瓮城审批 | 加速核缺 `dsh-tool-lsp`（COMPAT §3.5 `string-reference`），这是最明确的能力缺口 |
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
