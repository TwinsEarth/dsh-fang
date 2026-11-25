# v3.5.8 审计（2026-11-21）

> 用户指令（2026-11-21）：**三方发布，v3.5.8**。本版 = v3.5.7 之后的两项会话目录修复：
> 三方会话列表不一致（宿主侧栏 / 母体面板 / 派生弹窗）+ 三分组展示。

## 1. 范围（逐项可核对）

| # | 项 | 变更 | 证据 |
|---|---|---|---|
| 1 | 会话目录与 DSH 对齐 | `session-catalog` 只列 `workspace.json` 工作区成员里的根会话；子代理会话（裸 UUID 目录）与未登记目录不再列出；归档/置顶取 `global` 记账 | `src/plugins/session-catalog.mjs`、`test/session-catalog.test.mjs` 新增回归 |
| 2 | 标题与宿主侧栏一致 | 标题优先读 DSH 投影缓存 `storages/session_projcache/sessions/<id>.json`（`titleSource=projection`），日志有界读取仅兜底；空会话读取 `sessionListMetadata.blank` | 同上 |
| 3 | 三分组 + 组内排序 | 活跃中（7 天、未归档）→ 已归档 → 旧会话（>7 天、未归档），组内按 `updatedAt` 倒序；面板分组小标题/计数；派生弹窗归档灰色只读、旧会话折叠可选；空会话不进入派生列表 | `client.js`、`test/client-derive-picker-timeout.test.mjs` |
| 4 | 归档分组可见 | `cordis.patch.yml` `fang-session-catalog.allowArchived: false → true` | `cordis.patch.yml`、`test/plugins-shape.test.mjs` |

真机只读核对（修复后、宿主重启）：默认列表 **6 条活跃会话**（5 条可见 + 1 条空会话被隐藏），标题与宿主侧栏逐字一致；`includeArchived=1` 注册表侧 **12 条**（5 活跃 + 6 归档 + 1 空，含 Master 工作区 1 条）；子代理会话 0 条。

## 2. 验证（真实数字）

- preflight --e2e（发布提交 `9ba79cac`）：**GREEN 15/15**；tests **1306 pass / 0 fail / 2 skip**；e2e **125/125**；main-city source grade A；allow-list **0 findings**（110 路由）；artifact sha256 sidecar match。
- 发布 PR **#137** CI：**8/8 绿**（gate required / test node22+24 / compat node22+24 / hygiene / license；e2e self-hosted skipped——runner 离线）。
- `release-order`：pre-tag **10/10 GREEN**；发布后复跑 **10/10 GREEN，warnings=0**。
- `verify-release --remote`：**GREEN**；`healthz --remote`：**HEALTHY @twinsearth/fang-dsh-plugin@3.5.8**。

## 3. 风险与边界

- 归档会话仅展示/分组，不能作为派生导入源（服务端校验不变）；
- 标题来自投影缓存（派生数据）：缓存缺失/过期时回退日志有界读取并标注 `titleSource`，不假装有原生标题；
- 读取面保持只读：不写 `workspace.json`、不写缓存、不写会话日志；
- 私有镜像 verify 未执行（无 MIRROR_TOKEN）。

## 4. 回滚演练

- 触发方式：插件层 `npm i @twinsearth/fang-dsh-plugin@3.5.7`（或恢复 profile 备份）；仓库层按需 `git reset --hard` 到上一发布提交。
- 恢复耗时：分钟级（无数据格式迁移）。
- 证据：`dist/preflight.json`、`dist/release-verify.json`、`dist/dsh-fang-3.5.8.tgz.sha256`。

## 5. 发布（2026-11-21 已完成）

- 三方发布完成：annotated tag **v3.5.8**（tag object `a5ef90b0dd68f52e068a48c0075d5c0ff0b6d093` → commit `9ba79cac9c1dd1cec6696e62b49578784fb55825`）、GitHub Release `453692848`（4 资产，tgz 693,155 B / sha256 `f6662452…`）、npm `@twinsearth/fang-dsh-plugin@3.5.8`（`latest=3.5.8`，shasum `f53e35ff…`）；
- 发布 PR #137 squash 合并（main 线性）；`verify-release --remote` GREEN；`healthz --remote` HEALTHY。
