# v3.5.2 三方发布记录（2026-11-17）

> 用户指令（2026-11-17）：**三方发布 v3.5.2，统一走 PR → 门禁 → 合并 → 发布**。
> 本版为 v3.5.0 之后的合并版：把三个待合并功能分支 + release 自检修正统一并入 main 后发布。
> 契约版本不变（`@twinsearth/dsh-fang-contract@1.2.0`，已于 v3.5.0 同窗发布），本版不重发 contract。

## 0. 版本矩阵

| 组件 | 版本 | 说明 |
|---|---|---|
| `@twinsearth/fang-dsh-plugin` | **3.5.2** | 本次三方发布主体 |
| `@twinsearth/dsh-fang-contract` | 1.2.0（已发布） | vendored pin 不变（8 文件 sha256，`sourceCommit=f5b7b05`） |
| 加速核 `@twinsearth/dsh` | 3.5.0 | 加速分身依赖；不随本版发布 |
| 官方 DSH | 0.2.2-rc.3 | 母体依赖；不发布 |

## 1. 本版内容（合并清单）

| 来源分支 | 内容 |
|---|---|
| `feat/b8-pro-activation` | B-8 专业版激活链：`fang.code.run` 默认关闭，四环（总开关→逐项 allow→一次性审批票→审计+限额），provider 缺失显式 `provider-missing`，零副作用 |
| `feat/ui-client-half-map` | UI client half 浏览器作用域重写（`dsh.client.inject/external` + 客户端 bundle specifier → `@twinsearth`）、`ui-theme` 行纠正、headless 渲染冒烟 |
| `feat/lsp-provider-a` | LSP 能力缝路线 A（母体 `ctx.lsp` 四只读操作）+ 路线 B 形态（fork-local 变体 bundle，默认关闭）；`lsp-provider/`、`lsp-provider-fork/` 配置型 bundle；workspaceRoot 允许根 realpath fail-closed + 审计；provider 目录显式区分 `mother`/`fork-local`；证据脚本 `verify:lsp-evidence`（15 项）、`check:lsp-mother`、`probe:mother` 扩展；**M5 回流对端交付**（公共 health `{ok,role,version,peer,accepted}`、relay 批次口径 32/512000、evidence） |
| `fix/release-order-state` | `release:check` 把 registry/tag 状态视为信息项（发布前后不再误报 RED） |

## 2. 门禁结果（发布前实测）

```
node tools/release/preflight.mjs --e2e     # GREEN：tests + e2e 默认 123/123
node tools/e2e.mjs --lsp                   # 真实 LSP 130/130
node tools/release/allowlist.mjs           # findings 0
node tools/gate/main-city.mjs              # grade A / blockers 0
node tools/release/build.mjs               # dist-host / dist/npm 重建
node tools/release/release-order.mjs       # 发布顺序/版本一致性
```

## 3. 发布渠道（三方）

1. **git**：`release/v3.5.2` → PR → 门禁 → squash/merge 进 `main` → annotated tag `v3.5.2`；
2. **GitHub Release**：`v3.5.2` + 资产（`@twinsearth-fang-dsh-plugin-3.5.2.tgz` + sha256 + manifest）；
3. **npm**：`npm publish`（`dist/npm/package`），轮询 registry 至 200 后核验 sha1/sha256/bytes 与 `dist-tags.latest`。

## 4. 已知限制（诚实边界）

- **母体正式 profile 仍是 3.4.2**，且未安装 `lsp-provider/`：生产上 LSP 委托仍 `contract-unavailable`；
  安装步骤见 [`docs/INSTALL-LSP-MOTHER.md`](INSTALL-LSP-MOTHER.md)（需用户面板操作 + 重启）。
- **fork-local（路线 B）安装默认关闭**：现在只提供变体 bundle 与探测（`forkLsp.available=false`）。
- 语言服务器需 bundle 依赖安装（已精确锁定 `typescript-language-server@6.1.0` + `typescript@5.9.3`）。
- M5 探针自测受本会话打包守卫限制，采用内容等价解包目录；发布后建议对 npm tarball 复跑。
