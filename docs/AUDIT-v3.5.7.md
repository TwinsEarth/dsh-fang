# v3.5.7 审计（2026-11-21）

> 用户指令（2026-11-21）：**三方发布，v3.5.7**。本版 = v3.5.5 之后 main 上的项目迁移 + 派生弹窗 UI 改动；
> 跳过未发布的 3.5.6（用户明确指定版本，见 `docs/RELEASE-WAIVER-v3.5.7.md`）。

## 1. 范围（逐项可核对）

| # | 项 | 变更 | 证据 |
|---|---|---|---|
| 1 | 项目迁移 | `E:/GPT/dsh-fang` → `E:\DSH\DS\Fang`；含 `.git`/全部分支与 tag（68）、`dist`、`node_modules`、历史发布物、会话快照/官方 ZIP、契约子仓库、`tools/session/`；旧仓库只读保留 | `docs/MIGRATION-2026-11-21.md`、`docs/AUDIT-migration-2026-11-21.json` |
| 2 | 迁移后工具适配 | allow-list 跳过本地目录；`release-order` contract 默认 `<repo>/contract`；凭据读取加仓库 `.secrets/`；LSP staging/CLI 候选指向新根 | `tools/release/*`、commit `7b54731` / `37ec206` |
| 3 | 派生弹窗三分组 | 最近 7 天活跃（可选）/ 已归档（折叠、灰色 disabled、不可选）/ 更早（>7 天且未归档，折叠可选）；归档优先于时间 | `client.js` `splitSessionsForDerive`、`test/client-derive-picker-timeout.test.mjs` |
| 4 | 派生倒计时 | `DERIVE_PICKER_TIMEOUT_MS` 5000 → 7000；超时默认新建空会话语义不变 | `client.js`、`test/client-derive-picker-timeout.test.mjs` |
| 5 | 页脚清理 | 移除母体面板页脚提示行（提示/刷新时间/版本/独立门户链接）；独立门户入口保留在顶部工具区 | `client.js`、同测试文件 |

## 2. 验证（真实数字，发布前实测）

- `node tools/release/preflight.mjs --e2e`：**GREEN 16/16**；tests **1302 pass / 0 fail / 2 skip**；e2e **125/125**；main-city source grade A；allow-list **0 findings**（110 路由）；artifact sha256 sidecar match。
- 发布 PR CI：待回填（8/8 绿）。
- `release-order`：待回填。
- 本地 profile 手工部署复核：`client.js` 436,094 B（sha256 `2FBC7184…`），确认三分组/7 秒/无页脚文案。

## 3. 风险与边界

- 迁移只换目录，不改运行时行为；`FANG_HOME`（`D:\ToFuture`，约 3.5 GB）未迁移、未改动；
- 三分组只影响派生弹窗展示与可选性；归档会话仍不可被导入派生（服务端行为未变）；
- 三方发布为手工执行（self-hosted Windows runner 离线，e2e 与自动发布 job 不参与）。

## 4. 回滚演练

- 触发方式：插件层 `npm i @twinsearth/fang-dsh-plugin@3.5.5`（或恢复 profile 备份）；仓库层按需 `git reset --hard` 到上一发布提交。
- 恢复耗时：分钟级（无数据库/格式迁移）。
- 证据：`dist/preflight.json`、`tools/e2e.mjs` 输出、`dist/dsh-fang-3.5.7.tgz.sha256`。
