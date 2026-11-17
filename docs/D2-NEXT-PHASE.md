# D2 下一阶段：契约委托（B）与 UI client half 映射

> 状态：**下一阶段（不计入 v3.5.0 发布阻塞）**。v3.5.0 已交付：官方 bundle 映射 + 第三方插件复制 + `@deepseek-ai/*` alias 桩包 + 不支持清单 + 逐插件冒烟。
> 本文定义 B（无头能力契约委托）与 UI client half 浏览器映射两项后续工作的范围、设计、验收与风险。
> **B 首批能力清单已单独成文：[`docs/B-CONTRACT-CAPABILITIES.md`](B-CONTRACT-CAPABILITIES.md)（待用户确认范围后实施）。**

## 1. 契约委托（B：无头能力调母体）

> **进展（2026-11-17）**：P0 只读委托已落地（白名单/超时/审计/错误码 + e2e 断言）；P1 通道（lsp 读/写门禁、chat.import dryRun+审批拒绝）已落地，**LSP 真实执行 provider 待接入**；UI client half 仍后置。详见 [`docs/B-CONTRACT-CAPABILITIES.md`](B-CONTRACT-CAPABILITIES.md)。**LSP 调研（2026-11-17）已完成**：官方可选包族（`dsh-lsp`/`dsh-lsp-stdio`/`dsh-tool-lsp`）有与运行版本一致的 `0.2.2-rc.3`，能力缝 `ctx.lsp.query(...)` 无需 Agent Session、工作区根由调用方显式传入；官方仅 4 个只读操作（definition/references/implementation/hover，无 diagnostics/format/rename）；实现方案与开放决策见 [`docs/LSP-PROVIDER-RESEARCH.md`](LSP-PROVIDER-RESEARCH.md)。

### 1.1 目标

加速分身无法在本地实现的**无头能力**，通过瓮城既有跨进程契约委托给母体（母体运行官方/第三方插件）：

| 能力域 | 典型接口 | 现状 |
|---|---|---|
| 工具执行 | `/fang/api/contract`（contract 1.2）+ adapter 命令通道 | 已有骨架，需补白名单与错误语义 |
| 会话操作 | 会话查询/导出（只读优先） | 已有 `/fang/api/sessions` 只读目录 |
| 决策/审批 | decisions/approvals API | 已有（母体侧） |
| 查询/统计 | status/supervision 等只读接口 | 已有 |

**首批候选能力**：LSP 工具（`dsh-tool-lsp`，加速核无对应实现；见 COMPAT §3.5 的 `string-reference` 归类）可优先走委托验证；以及 dsh-context 等插件在 host 侧需要但加速核缺失的只读能力。

### 1.2 设计要点

1. **能力白名单**：只有显式登记的能力可被加速分身调用；默认拒绝（fail-closed）。
2. **鉴权**：复用 contract token / 安装级 token；分侧身份（fork → mother）与来源校验。
3. **失败语义**：母体离线、超时、能力未登记 → 明确错误码（`contract-unavailable` / `contract-unauthorized` / `contract-unsupported`），**不得**静默本地降级。
4. **超时与背压**：单次能力调用超时上限、并发上限；长任务走异步任务模型（提交 + 轮询）。
5. **隔离**：委托调用只读/受控写；写操作仍走瓮城审批与审计。
6. **可观测**：每次委托记录审计（capability、source fork、outcome、latency）。

### 1.3 验收

- 单测：白名单校验、未登记能力拒绝、超时/离线错误码、审计记录；
- 集成：加速分身调用一个真实只读能力（如 `sessions.read`）成功 + 一个未登记能力被拒；
- e2e：母体离线时能力调用返回明确错误（不静默）；
- 文档：能力清单 + 错误码表 + 安全边界。

## 2. UI client half 浏览器映射

> **进展（2026-11-17）**：spike 已完成（见 [`docs/UI-CLIENT-HALF-SPIKE.md`](UI-CLIENT-HALF-SPIKE.md)）：第三方 client half 已出现在加速分身启动清单、bundle 可正常提供；缺口是 `@deepseek-ai/*` 作用域行别名；首选方案 = fork-provision 生成 client alias shim 行（先做 `dsh-client-ui-primitives` 原型），再做真实浏览器渲染验收。

### 2.1 目标

让官方/第三方插件的 **client half（侧栏/面板/设置页）** 在加速分身的 Web UI 中可用：在浏览器模块解析层把 `@deepseek-ai/dsh-client-*` 映射到 `@twinsearth/dsh-client-*`。

**范围（COMPAT §3.5 归因）**：真正需要映射的是 3 个 client 侧 spec：
`@deepseek-ai/dsh-client-runtime`、`dsh-client-store`、`dsh-client-ui-primitives`
（其余 5 个为 desktop-only / dev-metadata / optional-metadata / string-reference，不需要 UI 映射）。

### 2.2 设计要点

1. **映射层**：分身上下发的 client 模块清单里注入 alias 映射表（bare specifier → 加速版模块 URL），或由 host 生成 `importmap`/模块代理。
2. **桩模块**：浏览器端 stub `export * from '<加速版 client 模块>'`（与 Host 侧桩包同构）。
3. **失败可见**：映射不到的 client 模块列入 `unsupportedClientHalves`，UI 标记“仅原版可用”，不静默隐藏。
4. **安全**：client 模块只允许从分身上下文加载；CSP/完整性校验不放松。

### 2.3 验收

- `ui-rich-smoke`：至少一个官方 client half（如 session-titles / sidebar）在加速分身 UI 中渲染成功；
- 映射失败用例：不支持的 client half 显示显式提示；
- 无回归：原版分身 UI 不受影响。

## 3. 依赖与顺序

1. **B 先行**（无浏览器依赖，风险低）：契约能力清单 → 白名单/鉴权 → 只读能力打通 → 写能力走审批。
2. **UI client half 后置**：需要浏览器模块加载层调研（先做 1 个官方 client half 的 spike，结论再排期）。
3. 两项均不改 v3.5.0 的发布内容；完成后版本节奏由用户指定（不得自行跳号）。

## 4. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 母体离线/重启 | 委托能力不可用 | 明确错误码 + 只读能力本地缓存（可选） |
| 延迟/一致性 | 分身操作变慢 | 超时 + 异步任务模型 + 只读优先 |
| contract 版本漂移 | 调用失败 | contract 版本协商（已有 1.1），失败显式 |
| client API 漂移 | UI 渲染异常 | 逐 client half 冒烟 + 不支持清单 |
| 安全边界扩大 | 未授权能力暴露 | 白名单 + token + 审计 + 写操作审批 |

## 5. 入口与产出

- 入口：用户指令进入下一阶段后，先出 **B 能力清单 + 白名单草案**（只读优先），评审通过再实现；
- 产出：代码 + 单测/集成/e2e + 文档（能力表、错误码、安全边界）+ 版本记录。
