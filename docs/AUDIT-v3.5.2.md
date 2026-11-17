# v3.5.2 审计（2026-11-17）

> 本版为 v3.5.0 之后的三方发布合并版；用户指令：**三方发布 v3.5.2，统一走 PR → 门禁 → 合并 → 发布**。
> 契约版本不变（`@twinsearth/dsh-fang-contract@1.2.0` 已随 v3.5.0 同窗发布，本版不重发）。

## 1. 合并清单（来源 → 内容）

| 分支 | 内容 | 单测/e2e |
|---|---|---|
| `feat/b8-pro-activation` | B-8 专业版激活链（`fang.code.run` 默认关闭；四环 + 一次性审批票 + 审计/限额；provider 缺失显式 `provider-missing`） | `test/pro-delegation.test.mjs` 10 项；e2e 5 项 |
| `feat/ui-client-half-map` | 第三方 client half 浏览器作用域重写、`ui-theme` 行纠正、headless 渲染冒烟 | `test/accelerated-alias.test.mjs` 新增 5 项；`smoke:ui-client-render` |
| `feat/lsp-provider-a` | LSP 能力缝路线 A（`ctx.lsp` 四只读操作、workspaceRoot 允许根 fail-closed、审计）+ 路线 B 变体 bundle（默认关闭）+ provider 目录显式区分 + 证据/自检脚本 + **M5 回流对端交付** | LSP 相关 19 项 + `test/m5-contract-delivery.test.mjs` 6 项；e2e `--lsp` 130/130 |
| `fix/release-order-state` | `release:check` 把 registry/tag 状态视为信息项（不误报 RED） | `release:check` 实跑 |

## 2. 门禁结果（发布前实测）

```
allow-list self-check        findings=0（routes 110，scanned 454 files）
main-city source gate        见 §3（AUDIT/版本一致性已修复）
tests（全量）                 1270 pass / 0 fail / 2 skip
e2e 默认                      123/123
e2e --lsp（真实 provider）    130/130
preflight --e2e              GREEN 3.5.2
```

## 3. 合并期修复项（必须记录）

1. **版本一致性**：`package.json` / `src/kernel/types.mjs`（`FANG_VERSION`）/ `test/kernel.test.mjs` / `test/plugins-shape.test.mjs` / `test/role-extensions.test.mjs` 全部更新为 `3.5.2`；`docs/CHANGELOG.md` 增加 `## v3.5.2（2026-11-17）` 段；本文件补齐（main-gate 要求 `docs/AUDIT-v<version>.md`）。
2. **合并冲突（语义级）**：
   - `src/plugins/orchestrator.mjs`：`delegate` 配置 schema 同时保留 `pro` 与 `lsp` 两个子键（各自闭合）；声明区同时保留 `proCfg/proGate/proApprovals` 与 LSP provider 相关声明；HTTP 路由保留 B-8 的 `pro/approval`、`pro/status`，并采用 M5 的公共 `health`（`{ok,role,version,peer,accepted}`）。
   - `src/lib/accelerated-fork.mjs`：保留 UI client-half 的 `STATIC_CLIENT_MODULES`/`availableClientModules`/`rewriteClientSpecifiers`/`applyClientRowOverrides` 与路线 B 的 `FORK_LSP_PACKAGES`/`detectForkLspSupport`（两段独立，闭合括号已校正）。
   - `tools/e2e.mjs`：profile patch 同时写入 `lsp` 委托根（`LSP_MODE`）与 `pro` 激活配置；检查项同时保留 LSP 与 B-8 两组。
   - `test/accelerated-alias.test.mjs`：导入与测试块双方保留。
3. **产物重建**：升级后必须重跑 `tools/release/build.mjs`，否则 manifest 版本仍是 3.5.0（门禁会拦截）。

## 4. 诚实边界（本版未覆盖）

- **母体正式 profile 仍是 3.4.2 且未安装 `lsp-provider/`**：生产 LSP 委托仍 `contract-unavailable`；安装步骤见 `docs/INSTALL-LSP-MOTHER.md`（需要用户面板操作 + 重启，本会话审批自动化关闭，无法代装）。
- **fork-local（路线 B）默认关闭**：仅提供变体 bundle + 探测（`forkLsp.available=false`）。
- **M5 自测**：本会话 `npm pack` 受打包守卫限制，使用内容等价解包目录；发布后建议对 npm tarball 复跑 `fang-relay-probe`。
- **v3.5.1 未发布**：当前版本号由用户当次指令指定为 3.5.2（跳号已由用户明确指定，符合发布纪律）。

## 5. 发布渠道

1. git：`release/v3.5.2-linear` → PR **#123**（CI 全绿）→ squash 合并 `main` `b0d1633` → annotated tag `v3.5.2`（API 创建，tag object `19c7a091…`）；
2. GitHub Release `v3.5.2`（tgz 680,053 B + sha256 + manifest）；
3. npm `@twinsearth/fang-dsh-plugin@3.5.2`：`latest=3.5.2`，shasum 与本地 tarball 一致（`08024e94…`），sha256 `9d5d3518…`；`release` 工作流因自托管 runner 离线被取消（与 v3.5.0 同处置）。
