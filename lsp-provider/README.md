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

## bundle 组成（DSH config-only bundle 规范）

`cordis.patch.yml` 挂载**最小组合**（官方 dsh-lsp README 的组件集）：

```yaml
- insert:
    - id: fang-lsp-fs-local
      name: '@deepseek-ai/dsh-fs-local'          # stdio provider 的宿主能力
    - id: fang-lsp-subprocess-local
      name: '@deepseek-ai/dsh-subprocess-local'
    - id: fang-lsp-seam
      name: '@deepseek-ai/dsh-lsp'               # 能力缝 ctx.lsp
    - id: fang-lsp-stdio
      name: '@deepseek-ai/dsh-lsp-stdio'         # 按 workspace 懒启动语言服务器
      config:
        servers:
          typescript:
            command: typescript-language-server  # 绝对路径或子进程 PATH 可解析
            args: ['--stdio']
            extensionToLanguage:
              '.ts': typescript
    - id: fang-lsp-tool
      name: '@deepseek-ai/dsh-tool-lsp'          # 可选：给母体 Agent 的模型工具 lsp
```

> 注意：官方 README 常以 `- name:` 裸行展示；但本仓库当前 DSH 的 patch 解析器要求
> `- insert:` + 行 id。实测裸 `- name:` 行会被**静默忽略**（boot 探针 `ctx.lsp` 缺失），
> 因此 bundle 使用 insert 形式，**组件组合与官方 README 一致**。

`package.json` 声明依赖：官方 LSP trio `@deepseek-ai/dsh-lsp@0.2.2-rc.3` 三件套（`dsh-tool-lsp` 可选）
+ npm `typescript-language-server@6.1.0` + `typescript@5.9.3`（精确锁定，见 `LOCKED-VERSIONS.json`）。
`dsh-fs-local` / `dsh-subprocess-local` 由 DSH 安装本身提供（E3：LSP trio 不在官方 bundle 目录，故必须走 config-only bundle）。

## 安装（母体正式 profile，路线 A）

1. 在插件面板 **Plugins → Add plugin** 选择本目录（`lsp-provider/`），或由 `plugin_manager` 的 `install_bundle` 安装；
2. 安装后 bundle 依赖会写入 profile；若语言服务器无法按 PATH 解析，在 profile 的 `cordis.patch.yml` 用生成后的行 id 覆盖 `@deepseek-ai/dsh-lsp-stdio` 的 `config.servers.typescript.command` 为绝对路径（`dsh --profile <name> --dump-config` 可看到行 id，例如 `dsh-lsp-stdio` / `plugin-…`）；也可以在安装前把 bundle `cordis.patch.yml` 里的 `command` 改成绝对路径；
3. 在 fang orchestrator 配置里显式登记允许根：
   ```yaml
   contract:
     delegate:
       lsp:
         allowedRoots:
           - 'C:\\path\\to\\mother-workspace'
           # fork 工作区根可显式追加；includeForkWorktrees=true 时自动登记全部任务工作区根
         includeForkWorktrees: true
         maxLocations: 200
         maxResultChars: 20000
   ```
4. 重启 DSH 后：`fang.capability.list` 的 `fang.tool.invoke.provider` 应显示
   `available:true / default:'mother' / actions:[definition,references,implementation,hover]`，
   `providers` 里同时可见 `mother`(delegated) 与 `fork-local`(local)。

> **语言服务器来源（单独决策，已定 ①）**：bundle 依赖 npm `typescript-language-server` 并精确锁定；
> 备选：② 系统级安装（profile 覆盖 command 为系统路径）/ ③ 复用现成服务器（如 clangd/rust-analyzer，
> 在 `servers` 里另加条目）。来源变更只影响 `command`/`args`，不改变契约口径。

## 契约口径（摘要）

- 委托动作：`definition` / `references` / `implementation` / `hover`（映射官方 seam 4 操作）；**参数 `line/character` 为 0-based 非负整数（seam 原生坐标透传）**，结果 locations 归一化为 `{path,line,character}`（1-based 展示）、hover 为 `{contents}`，超限按 `maxLocations/maxResultChars` 裁剪并标记 `truncated`；
- `format/rename/...`：可读拒绝（`contract-unsupported`）；`diagnostics` 仅测试缝可用、不 advertise；
- 能力目录按 provider 区分，**无 provider 时 `actions: []`**（不虚假宣称）；
- 路线 B（fork-local）**不进契约委托**：LSP 在分身本地 `ctx.lsp` 执行，可用性走任务记录 `accelerated.forkLsp`。

## 验证

- 本机隔离 staging 原型（不写 profile）：
  `npm run setup:lsp-live` → `npm run test:lsp-live`（e2e `--lsp`：真实 `ctx.lsp`，definition/hover `provider='mother'`）；
- 安装到正式 profile 后：按 [`docs/LSP-PROVIDER-RESEARCH.md`](../docs/LSP-PROVIDER-RESEARCH.md) §6 的剩余步骤复测。
