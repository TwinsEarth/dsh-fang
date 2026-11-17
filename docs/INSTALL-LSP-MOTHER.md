# 把 LSP provider 装进母体正式 profile（路线 A）

> 本文是**人工执行清单**：DSH 插件安装/重启属于本会话被自动拒绝的审批动作，不能由 Agent 代装。
> 自检脚本：`npm run check:lsp-mother`（只读，不安装、不改 profile、不重启）。

## 0. 当前实测状态（2026-11-17）

| 项 | 实测 |
|---|---|
| 正式 profile | `<DSH_HOME>\profiles\desktop` |
| fang 插件 | **3.4.2**（LSP 委托代码在 **3.5.0** 才落地 → 必须先升级） |
| lsp-provider bundle | 未安装（`node_modules\@twinsearth\dsh-fang-lsp` 缺失） |
| 语言服务器 | 本机 PATH 无 `typescript-language-server`；`E:\DSH` 内无捆绑（E11） |
| 运行中的母体 | 在跑（50895），但自检脚本用 dataDir token 探测返回 401 → 需要生产配置 token |

## 1. 升级 fang 插件到 3.5.0（前置）

1. 走插件面板/更新（或 `@twinsearth/fang-dsh-plugin@3.5.0` 已发布，可 `Plugins` 里更新）；
2. 重启母体；
3. 预期：`npm run check:lsp-mother` 的 “fang plugin supports LSP delegation” 从 TODO 变 PASS。

## 2. 安装 lsp-provider bundle

1. DSH 插件面板 **Plugins → Add plugin**，选择目录 **`<repo>\lsp-provider`**（`@twinsearth/dsh-fang-lsp`）；
2. 安装器会解析 bundle 依赖：官方 LSP trio `0.2.2-rc.3` + `typescript-language-server@6.1.0` + `typescript@5.9.3`（版本已在 `lsp-provider/LOCKED-VERSIONS.json` 锁定）；
3. 重启母体；
4. 预期：`check:lsp-mother` 显示 bundle installed、patch rows complete、tls available（或下一步覆盖路径）。

> bundle patch 会插入 5 行：`fang-lsp-fs-local`、`fang-lsp-subprocess-local`、`fang-lsp-seam`、`fang-lsp-stdio`、`fang-lsp-tool`。

## 3. 语言服务器不在 PATH → 用 profile patch 覆盖 command 为绝对路径

`dsh-lsp-stdio` 默认按子进程 PATH 解析 `typescript-language-server`；profile 安装的 `.bin` 通常不在 PATH。
`check:lsp-mother` 会直接打印可粘贴片段（用 profile 内真实路径 + 本机 node 绝对路径）：

```yaml
- id: fang-lsp-stdio
  config:
    servers:
      typescript:
        command: '<node.exe 绝对路径（`where node`）>'
        args:
          - '<DSH_HOME>\profiles\desktop\node_modules\typescript-language-server\lib\cli.mjs'
          - '--stdio'
        extensionToLanguage:
          '.ts': typescript
          '.tsx': typescriptreact
          '.js': javascript
          '.jsx': javascriptreact
```

把该片段追加到 profile 的 `cordis.patch.yml`（不存在则新建）：

```
<DSH_HOME>\profiles\desktop\cordis.patch.yml
```

## 4. 配置 workspaceRoot 允许根（安全边界，必做）

`dsh-lsp-stdio` 明确 **trusts its configured server、无沙箱**；委托请求的 `workspaceRoot` 由调用方传入，
因此母体必须显式登记允许根（空 = 全部拒绝，fail-closed）：

```yaml
- id: fang-orchestrator
  config:
    contract:
      delegate:
        lsp:
          allowedRoots:
            - '<允许的工作区根，例如仓库绝对路径>'
          includeForkWorktrees: true
          maxLocations: 200
          maxResultChars: 20000
```

> 说明：fork 工作区根在 `includeForkWorktrees: true` 时由任务 registry 自动登记；
> 越界根/文件逃逸 → `contract-invalid-request`，且每次尝试入 `contract-delegate` 审计。

## 5. 重启并验收

1. 重启母体（让新 bundle 行、patch 覆盖、配置生效）；
2. 只读自检（把生产 token 传入；token 可能在 fang 配置里而不是 dataDir 文件）：

```powershell
npm run check:lsp-mother -- --base http://127.0.0.1:50895 --token <生产 token>
# 真实一次 definition（fixture 工作区自备且必须在 allowedRoots 内）：
npm run check:lsp-mother -- --base http://127.0.0.1:50895 --token <token> ^
  --workspace-root <仓库绝对路径> --definition-file README.md --line 0 --character 0
```

3. 预期：`lsp provider` PASS（`default=mother`、`actions=definition,references,implementation,hover`）；
   `real definition` PASS（返回 `{path,line,character}` 1-based 展示）。

## 6. 回滚

1. 插件面板卸载 `@twinsearth/dsh-fang-lsp`；
2. 删除 profile `cordis.patch.yml` 里 `fang-lsp-stdio` / `fang-orchestrator` 的覆盖片段；
3. 重启母体；`check:lsp-mother` 回到 PENDING（bundle missing）即回滚完成。

## 7. 已知限制

- 本会话审批被自动拒绝，**无法代装/重启**；以上均为用户操作；
- 生产母体当前仍 3.4.2，未升级前 LSP 委托不可用（`fang.capability.list` 无 lsp provider 字段属预期）；
- 安装后若 `ctx.lsp` 存在但查询报 `LSP_UNAVAILABLE`，优先检查 stdio 的 `command` 绝对路径与工作区是否在允许根内。
