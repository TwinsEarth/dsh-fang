# @twinsearth/dsh-fang-lsp-fork（路线 B：fork-local 变体）

配置型 bundle：给**加速分身 profile** 装上同版本 LSP 栈，让 LSP 在**分身自己的 workspace/worktree** 执行，
语义上优于“把分身文件路径交给母体进程”。**安装默认关闭**，属于后续增强；本文件只定义可复用形态与启用前提。

## 与母体变体的唯一差异：依赖域

| | 母体（`lsp-provider/`，路线 A） | 分身（本目录，路线 B） |
|---|---|---|
| 依赖 | `@deepseek-ai/dsh-lsp@0.2.2-rc.3` 三件套 | **`@twinsearth/dsh-lsp@3.5.0` 三件套**（E5，与加速核同版本） |
| 语言服务器 | `typescript-language-server@6.1.0` + `typescript@5.9.3`（精确锁定） | 同左 |
| patch 形状 | seam + stdio + tool（+ fs-local/subprocess-local 显式行） | seam + stdio + tool（fs/subprocess 由加速核自带） |
| 执行位置 | 母体进程（委托，经契约） | 分身本地（**不经过契约委托**） |
| 默认 | 母体安装后即可用 | **默认关闭**；需显式安装/启用 |

> 结论：复用方式是**同 patch 形状的变体**（依赖域换成 `@twinsearth`），
> 而不是把 `@deepseek-ai@0.2.2-rc.3` 的母体 bundle 直接装进加速 fork。
> 直接混装会让 0.2.2-rc.3 官方包与 3.5.0 加速核处于不同版本线，且 seam 实现由加速核提供。

## 启用前提（后续增强，默认不做）

1. 加速核安装同版本 LSP trio（当前 `forkLsp.available=false`，见 `detectForkLspSupport()`）；
2. 把本 bundle 装进**分身 profile 模板**（fork profile 每次从模板重放，装到单个 fork home 会被重建冲掉）；
3. 显式开启开关（当前无自动安装；启用时再加 `contract.delegate.lsp` 之外的 fork-local 开关）；
4. 语言服务器 command 若不在 PATH，用分身的 profile patch 覆盖为绝对路径；
5. 验收：分身侧 `ctx.get('lsp')` 存在；`accelerated.forkLsp.available=true`；本地产出 definition/hover；
   契约目录里 `providers['fork-local'].mode='local'`、`available=true`。

## 契约/安全口径

- fork-local **不经过契约委托**，不进 `fang.tool.invoke:lsp` 的白名单/审批/审计路径；
- 能力目录显式区分 `provider: 'mother' | 'fork-local'`，各自只 advertise 实提供能力；
- 写类 LSP（rename/format）不提供（官方只读语义）；diagnostics 不属于官方 seam；
- 允许根策略只约束母体委托；fork-local 的访问面就是分身自己的工作区。

## 验证

- 本目录完整性测试：`node --test test/lsp-provider-fork-bundle.test.mjs`
- 母体真实 provider 闭环（对照）：`npm run setup:lsp-live` → `npm run test:lsp-live`
