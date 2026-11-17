# @twinsearth/dsh-fang-lsp（LSP provider bundle）

配置型 bundle：把官方 LSP 栈装进 DSH profile，供 **瓮城母体委托（路线 A）** 或 **加速分身本地（路线 B）** 使用。
不含宿主代码，只含 `cordis.patch.yml` 与依赖声明。

## 已定决策（2026-11-17）

| 决策点 | 选择 |
|---|---|
| 语言服务器来源 | **bundle 依赖 npm `typescript-language-server`**（随 bundle 版本化；**精确锁定 `typescript-language-server@6.1.0` + `typescript@5.9.3`**——TS 7 native preview 无 `lib/typescript.js`，语言服务器会初始化失败；精确版本清单见 `LOCKED-VERSIONS.json`） |
| 安装位置 | **A + B 都装、能力目录区分**：A（母体正式 profile）本次先做；B（加速分身 profile）作为后续增强，安装默认关闭 |
| workspaceRoot 允许范围 | **母体根 + 所有 fork 工作区根（显式登记）**；realpath 包含校验、审计（由 fang 委托层执行） |
| 写类 LSP（rename/format） | **不提供**（跟随官方只读语义，不扩大攻击面） |
| 母体 Agent 的 `lsp` 工具 | **同时挂载**（`dsh-tool-lsp`；母体自身也受益） |

## 安装（母体正式 profile，路线 A）

1. 在插件面板 **Plugins → Add plugin** 选择本目录（`lsp-provider/`），或由 `plugin_manager` 的 `install_bundle` 安装；
2. 安装后 bundle 依赖会写入 profile；若语言服务器无法按 PATH 解析，在 profile 的 `cordis.patch.yml` 覆盖 `fang-lsp-stdio` 的 `config.servers.typescript.command` 为绝对路径（profile `node_modules/.bin/typescript-language-server.cmd`）；
3. 在 fang orchestrator 配置里显式登记允许根：
   ```yaml
   contract:
     delegate:
       lsp:
         allowedRoots:
           - 'C:\\path\\to\\mother-workspace'
           # fork 工作区根可显式追加；includeForkWorktrees=true 时自动登记全部任务工作区根
         includeForkWorktrees: true
   ```
4. 重启 DSH 后：`fang.capability.list` 的 `fang.tool.invoke.provider` 应显示
   `available:true / default:'mother' / actions:[definition,references,implementation,hover]`。

## 契约口径（摘要）

- 委托动作：`definition` / `references` / `implementation` / `hover`（映射官方 seam 4 操作，1-based 位置）；
- `format/rename/...`：可读拒绝（`contract-unsupported`）；`diagnostics` 仅测试缝可用、不 advertise；
- 能力目录按 provider 区分，**无 provider 时 `actions: []`**（不虚假宣称）；
- 路线 B（fork-local）**不进契约委托**：LSP 在分身本地 `ctx.lsp` 执行，可用性走任务记录 `accelerated.forkLsp`。

## 验证

- 本机隔离 staging 原型（不写 profile）：
  `npm run setup:lsp-live` → `npm run test:lsp-live`（e2e `--lsp`：真实 `ctx.lsp`，definition/hover `provider='mother'`）；
- 安装到正式 profile 后：按 [`docs/LSP-PROVIDER-RESEARCH.md`](../docs/LSP-PROVIDER-RESEARCH.md) §6 的剩余步骤复测。
