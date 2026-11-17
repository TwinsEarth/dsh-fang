# LSP 真实 provider 接入调研（母体 DSH 工具运行时）

> 调研日期：2026-11-17 · 调研对象：运行中的 Desktop DSH **0.2.2-rc.3** 与加速核 **@twinsearth/dsh 3.5.0**
> 性质：**只读调研**（未安装、未改 profile、未改代码）；结论可复现，证据逐条列在 §1。
> 关联：B-6 `fang.tool.invoke:lsp`（M3 通道已完成，provider 缺位）；`docs/B-CONTRACT-CAPABILITIES.md` §0.4。

## 0. 结论先行

1. **LSP 是 DSH 的“可选安装包族”**（`dsh-lsp` 能力缝 + `dsh-lsp-stdio` stdio provider + `dsh-tool-lsp` 模型工具），当前 Desktop 0.2.2-rc.3 **未安装**；但 npm 上**存在与运行版本一致的 0.2.2-rc.3 包**，可直接安装。
2. **能力缝 `ctx.lsp` 的查询 API 不需要 Agent Session**：`query({operation, filePath, position, workspaceRoot})` 显式接收 `workspaceRoot`。这意味着**母体侧 fang 插件可以绕过 `lsp` 工具、直接调用能力缝**，把委托请求映射成真实 LSP 查询——**接入母体工具运行时的目标可达成**。
3. LSP 能力缝**只提供 4 个只读操作**：`goToDefinition` / `findReferences` / `goToImplementation` / `hover`；**不提供** diagnostics、format、rename、symbols、通用 JSON-RPC。→ **B-6 的动作口径需要修正**（我们此前设想的 diagnostics/写类子命令不在官方语义内）。
4. 推荐双路线（可并存）：
   - **路线 A（本次调研目标，母体委托）**：母体 profile 安装官方 `@deepseek-ai/dsh-lsp@0.2.2-rc.3` 三件套 + `dsh-fs-local`/`dsh-subprocess-local`（已在安装内）+ 语言服务器；fang 母体插件 `ctx.get('lsp').query(...)` 实现 `fang.tool.invoke:lsp`。
   - **路线 B（更贴合“分身自己工作区”的语义）**：加速核侧安装 `@twinsearth/dsh-lsp*@3.5.0` 三件套，LSP 直接跑在分身自己的 workspace；此时无需跨进程委托。
5. 当前阻塞项（非代码）：**本机没有任何语言服务器**（`typescript-language-server`、`clangd` 等均未安装）→ 真实 provider 落地必须先定语言服务器来源与安装策略。

## 1. 证据矩阵（全部实测/实读）

| # | 事实 | 证据 |
|---|---|---|
| E1 | 运行版本 = `@deepseek-ai/dsh 0.2.2-rc.3`（Desktop asar） | `E:\DSH\DS\resources\app.asar` 内 `@deepseek-ai/dsh/package.json`；`docs/AUDIT-v3.5.0.md` 版本对 |
| E2 | 官方 LSP 包**在 npm 有 0.2.2-rc.3 版本**（`latest` tag 只指到 0.0.1-rc.1，需显式按版本安装） | `npm view @deepseek-ai/dsh-lsp versions` → 含 `0.2.2-rc.3`；`dsh-lsp-stdio`、`dsh-tool-lsp` 同 |
| E3 | Desktop 安装**未携带** LSP trio，且官方 bundle 目录**没有** LSP 可选 bundle | 提取 asar 后 `@deepseek-ai` 下 331 个包中 `dsh-lsp*` 缺失；`dsh-official-bundles/lib/index.js` 全文无 `lsp` |
| E4 | LSP 依赖的底座插件**已存在**于母体安装 | `dsh-fs-local`、`dsh-subprocess-local`、`dsh-working-directory` 均在 asar `@deepseek-ai/` 下 |
| E5 | 加速核 3.5.0 **同样未安装** LSP trio，但 npm 有 `@twinsearth/dsh-lsp@3.5.0` 三件套 | `npm view @twinsearth/dsh-lsp version` → 3.5.0（stdio/tool 同）；`D:\ToFuture\accel\cli\node_modules\@twinsearth` 目录实查缺失 |
| E6 | 能力缝是 Cordis 服务 `ctx.lsp`：`registerProvider(provider)` + `query(request, signal)` | `@deepseek-ai/dsh-lsp@0.2.2-rc.3/lib/types/index.d.ts` 的 `class Lsp extends Service` / `LspService` |
| E7 | 查询请求**显式携带 workspaceRoot**，四操作，位置为 0-based UTF-16；结果 `{kind:'locations',locations,resolvedWorkspaceUri}` / `{kind:'hover',hover}` | 同包 `lib/types/types.d.ts` `LspQueryRequest` / `LspQueryResult` / `LspOperation` |
| E8 | 能力缝“故意不暴露” diagnostics / rename / format / symbol / 通用 JSON-RPC | 同包 `README.md`：“Navigation is read-only and deliberately excludes generic JSON-RPC access, rename, formatting, diagnostics, and symbol lists.” |
| E9 | stdio provider 配置：`servers{<id>:{command,args?,extensionToLanguage,env?,...}}`；按 workspace 懒启动并池化；要求 fs/subprocess 同一执行世界 | `@deepseek-ai/dsh-lsp-stdio@0.2.2-rc.3/README.md`“Minimal configuration”“What a query does”“Security boundary” |
| E10 | 模型工具 `lsp` 参数 `operation/file_path/line/character`（1-based）、**要求 Agent Session**（无 Session 直接 `LSP_WORKSPACE_REQUIRED`），workspaceRoot 取 Session 当前工作目录 | `@deepseek-ai/dsh-tool-lsp@0.2.2-rc.3/README.md`“The tool”“Failures and recovery” |
| E11 | 本机**无任何 LSP 服务器**可执行文件 | `Get-Command typescript-language-server` / `clangd` 等均为 missing；`E:\DSH` 全盘无 `typescript-language-server` |
| E12 | 委托层现有 `fang.tool.invoke:lsp` 已具备：白名单、`validateToolInvoke`、读/写分类、审批门禁、审计、e2e 测试缝 | `src/lib/lsp-delegation.mjs`、`src/plugins/orchestrator.mjs`、e2e 断言（M3） |

## 2. 关键设计事实解读

### 2.1 为什么“母体委托”可行

`lsp` 模型工具要求 Agent Session（E10），但**能力缝本身不需要**（E7：`workspaceRoot` 是调用者显式传入的必填字段）。因此母体侧 fang 插件的处理器可以：

```js
const lsp = ctx.get('lsp')            // 母体安装 dsh-lsp 后存在
const result = await lsp.query({
  operation: 'goToDefinition',        // 四选一
  filePath: 'src/x.ts',               // 相对 workspaceRoot 或绝对
  position: { line: 0, character: 4 },
  workspaceRoot: '<委托方给的绝对工作区根>',
}, signal)
```

不需要伪造 Agent Session，也不经过 `tools` 服务；这正是“接入母体 DSH 工具运行时（能力缝）”的最小正确路径。

### 2.2 需要补的口径：B-6 动作集合

| 现设计（B 契约） | 官方 LSP 能力缝 | 结论 |
|---|---|---|
| `definition` / `hover` / `references` | `goToDefinition` / `hover` / `findReferences` | ✅ 可映射 |
| — | `goToImplementation` | ➕ 可新增 |
| `diagnostics` | **不支持**（能力缝明确排除） | ⚠️ 必须从“真实 provider 能力”中移除；测试缝可以保留但不得对外宣称 |
| `format` / `rename` / `codeAction` / `apply`（写类） | **不支持**（能力缝只读，无 mutation） | ⚠️ 写类审批门禁对官方 LSP 无对象；保留为“未来自定义 provider”的通用门禁即可 |

→ 实现阶段应把契约动作名与 seam 操作对齐（`definition→goToDefinition` 等），并在能力目录中按“provider 实提供”能力 advertise，避免**宣称支持 diagnostics 而实际 provider 不支持**。

### 2.3 安装方式（母体，路线 A）

LSP trio 不在官方 bundle 目录（E3），因此走**config-only bundle**（DSH 插件规范：bundle 的 `cordis.patch.yml` 挂载插件行，`package.json` 声明依赖）：

- bundle 依赖：`@deepseek-ai/dsh-lsp@0.2.2-rc.3`、`dsh-lsp-stdio@0.2.2-rc.3`、`dsh-tool-lsp@0.2.2-rc.3`（可选，若也想给母体 Agent 用）；
- patch 行（最小组合，README 原样）：
  ```yaml
  - name: '@deepseek-ai/dsh-fs-local'
  - name: '@deepseek-ai/dsh-subprocess-local'
  - name: '@deepseek-ai/dsh-lsp'
  - name: '@deepseek-ai/dsh-lsp-stdio'
    config:
      servers:
        typescript:
          command: typescript-language-server   # 绝对路径或子进程 PATH 可解析；本机缺失（E11）
          args: ['--stdio']
          extensionToLanguage:
            '.ts': typescript
  - name: '@deepseek-ai/dsh-tool-lsp'           # 可选
  ```
- 语言服务器来源需要单独决策（npm 安装 `typescript-language-server` 到 bundle/依赖、或系统级安装、或先用现成服务器如 `clangd`/`rust-analyzer`）。

### 2.4 路线 B（fork-local）为什么值得并行

- 加速核有**同版本** LSP trio（E5），安装后 LSP 跑在分身自己的 workspace（fork worktree），语义上比“把分身文件路径交给母体进程”更合理；
- 母体委托会引入**跨工作区可见性/安全边界**：`workspaceRoot` 由委托方传入，母体必须限制允许根（否则等于把母体进程的文件读取面扩大到调用方任意路径——而 `dsh-lsp-stdio` 明确“trusts its configured server，无沙箱”）；
- 但 fork-local 无法覆盖“LSP 服务器只装在母体/共享缓存”的场景，故两条路线可并存，按能力目录显式区分（`provider: 'mother' | 'fork-local'`）。

## 3. 推荐实现设计（路线 A：母体委托）

### 3.1 母体侧

1. 交付 `fang-lsp-provider` 配置型 bundle（含 LSP trio 依赖 + patch 行 + 默认 language server 配置模板）；
2. fang 母体插件：`ctx.get('lsp')` 可用时注册 `fang.tool.invoke:lsp` 的真实 provider；不可用则保持 `contract-unavailable`；
3. 动作映射：`definition→goToDefinition`、`references→findReferences`、`implementation→goToImplementation`、`hover→hover`；
4. 参数校验（复用/扩展 `lsp-delegation.mjs`）：`file` 必填、`line`/`character` 为非负整数（seam 0-based）、operation 闭集；
5. **workspaceRoot 策略**：委托请求必须带 `workspaceRoot`；母体按配置允许根（例如母体挂载的工作区 + fork 工作区根）做 realpath 包含校验，越界返回 `contract-invalid-request`；
6. 结果归一化：locations → `{path,line,character}`（1-based 展示）、hover → `{contents}`；超限裁剪沿用 tool 的 `maxLocations/maxResultChars` 思路；
7. 超时/并发/审计复用 M5 机制（`readTimeoutMs`、`maxConcurrent`、`contract-delegate` 审计 outcome）。

### 3.2 契约侧（B-6 修订）

- 能力目录 `fang.tool.invoke` 仅 advertise **provider 实提供**的只读操作：`definition | references | implementation | hover`；
- 移除 `diagnostics` 的对外宣称（保留 e2e 测试缝内部用，但标记 non-production）；
- 写类动作（format/rename/...）从官方 LSP 语义中移除；保留“未来自定义 provider 需审批”的通用门禁路径；
- 错误码映射：`LSP_UNAVAILABLE → contract-unavailable`；`LSP_FILE_OUTSIDE_WORKSPACE / LSP_INVALID_PROVIDER` → `contract-invalid-request`；`LSP_MALFORMED_RESPONSE / LSP_SERVER_ERROR` → `contract-unavailable`（附 detail）。

### 3.3 验收（实现阶段）

- [ ] 母体安装 LSP 栈后，`/fang/api/contract/invoke` 的 `fang.capability.list` 中出现 `fang.tool.invoke` 且 **provider='mother-lsp'**（不是 test-hook）；
- [ ] 真实语言服务器（先 TS）对 fixture 文件返回 definition/hover；
- [ ] 越界 `workspaceRoot` 被拒（`contract-invalid-request`），审计可见；
- [ ] 无 provider 时仍显式 `contract-unavailable`（不虚假成功）；
- [ ] e2e：用真实 provider 替换测试缝，至少 1 个 operation 走通；测试缝保留但由 env 显式开启。

## 4. 风险与开放决策（需要人确认）

| 决策点 | 选项 | 建议 |
|---|---|---|
| 语言服务器来源 | ① bundle 依赖 npm `typescript-language-server`；② 系统安装；③ 先支持 clangd/rust-analyzer 等已有服务器 | ① 最可控（随 bundle 版本化），但增包体 |
| 安装位置 | ① 仅母体（路线 A）；② 仅加速分身（路线 B）；③ 两者都装、能力目录区分 | ③ 渐进：先 A（本次目标），B 作为后续增强 |
| workspaceRoot 允许范围 | ① 仅母体工作区；② 母体 + 所有 fork 工作区根（显式登记）；③ 任意路径 | ②：显式登记、realpath 校验、审计 |
| 写类 LSP（rename/format） | ① 不提供；② 自研 provider + 审批 | ①：跟随官方语义，不扩大攻击面 |
| 是否同时给母体 Agent 挂 `lsp` 工具 | ① 是（装 dsh-tool-lsp）；② 只给委托用 | ①：一次装齐，母体自身也受益 |

## 6. 决策落地（2026-11-17，已实现代码）

用户确认：**路线 A 先行（对应 B-6 目标），路线 B 作为增强，能力目录按 provider 区分**。已实现：

| 项 | 实现 | 验证 |
|---|---|---|
| 路线 A 真实 provider 适配 | `src/lib/lsp-provider.mjs`：契约动作 `definition/references/implementation/hover` → `ctx.lsp.query` 四操作；1-based→0-based；locations/hover 归一化；seam 错误码映射（`LSP_UNAVAILABLE`→contract-unavailable 等）；**workspaceRoot 显式传入 + `contract.delegate.lsp.allowedRoots` realpath 包含校验（空=拒绝，fail-closed）** | `test/lsp-provider.test.mjs` 6 项 |
| 契约口径对齐 | `src/lib/lsp-delegation.mjs` 只读四动作；legacy `format/rename/codeAction/apply` → `contract-unsupported`；**`diagnostics` 仅测试缝可用且不 advertise**；位置必填校验 | `test/lsp-delegation.test.mjs` 5 项；e2e 更新 |
| 能力目录按 provider 区分 | `fang.capability.list` 的 `fang.tool.invoke` 带 `provider:{available,default,services,actions}`，顶层 `lspProvider`；未安装时为 `available:false`（显式，不假成功） | e2e provider-tagged 断言 |
| 路线 B（增强）探测 | `detectForkLspSupport(accelNodeModules)`：检测 `@twinsearth/dsh-lsp`/`dsh-lsp-stdio`/`dsh-tool-lsp`；结果暴露在 `writeAcceleratedForkProfile(...).forkLsp`，默认不启用 | `test/accelerated-alias.test.mjs` |
| 诚实边界 | 母体正式 profile 尚未安装 LSP 栈；未安装时读类动作显式 `contract-unavailable`。**但路线 A 真实 provider 已在隔离 staging 中跑通**：`npm run setup:lsp-live` → `npm run test:lsp-live`（e2e `--lsp` 模式，真实官方 LSP 栈 + typescript-language-server）| e2e `--lsp`：**119/119**，`definition` 返回 `provider='mother-lsp'` + 1 个 location，`hover` 返回归一化 hover；`diagnostics` 真实 provider 下被 `contract-unsupported`（test-seam-only） |

**真实 provider e2e（路线 A 首个真实闭环，2026-11-17 实测）**：
- 准备：`npm run setup:lsp-live`（隔离 staging 安装 `@deepseek-ai/dsh-lsp@0.2.2-rc.3` 三件套 + `typescript-language-server` + `typescript@5.9.3`；不写用户 profile）；
- 运行：`npm run test:lsp-live`（`tools/e2e.mjs --lsp`：profile 内挂载 dsh-lsp/dsh-lsp-stdio，`ctx.lsp` 就绪，fang 委托走真实 provider）；
- 断言：catalog provider=`mother-lsp`、actions 4 项；definition → `mother-lsp` + 真实 location；hover → 归一化；diagnostics → `contract-unsupported`（test-seam-only）；legacy 写类仍可读拒绝。

**剩余（安装到正式 profile）**：① 把同一组合以 config-only bundle 装进母体正式 profile（含语言服务器来源/版本锁定）；② 生产母体重启后跑 `probe:mother` + `test:lsp-live` 的等价探测。

## 7. 原下一步（已由 §6 取代）

1. ~~M3.2 母体 LSP 栈原型~~ → provider 适配代码已完成，安装待办；
2. ~~M3.3 真实 provider 接入~~ → `ctx.lsp.query` 映射/根策略/归一化已完成；
3. M3.4 e2e：TS fixture 真实 definition/hover（阻塞于语言服务器安装）；
4. M3.5：语言服务器来源/版本随 bundle 锁定；
5. 路线 B（fork-local）：已具备安装探测与目录区分，默认关闭。

---

**证据文件位置（只读，未改动 profile/代码）**：npm 包元数据来自 `npm view`；包文档/类型来自 `%TEMP%` 下载的 tarball 解压（`@deepseek-ai/dsh-lsp@0.2.2-rc.3` 等）；安装内证据来自 `app.asar` 的只读提取；版本矩阵与命令输出见本次会话记录。
