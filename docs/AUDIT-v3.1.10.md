# AUDIT v3.1.10

> 版本：3.1.10（**未发布**；等待人类授权）
> 范围：把「瓮城防崩溃方案」固化为测试/打包/发布门禁；固化 UI 与发版流程文档。
> 关联事故：2026-11-10 21:33 在运行中的 desktop profile 上执行升级导致 DSH 崩溃与用户层重置。

## 1. 目标

1. 后续会话遵守固定 UI/发版流程，且**发布必须由人类显式授权**；
2. 瓮城既有防崩溃防线（boot-guard、RestartGuard、分身监督、role fail-closed 等）不再只靠“记得别删”：
   源码不变量、打包产物、发布门禁三层强制；
3. 把“运行中 profile 升级”这类环境事故写成可执行的安全规程。

## 2. 交付物

| 文件 | 作用 |
|---|---|
| `docs/WORKFLOW-UI.md` | UI 改动与发版固定流程、发布授权铁律、发版前置硬门禁、预算、profile 升级安全规程、完成定义 |
| `docs/CRASH-SAFETY.md` | 威胁模型、防线清单（代码事实）、强制点矩阵、崩溃处置手册、边界 |
| `tools/release/crash-safety.mjs` | 源码模式 + 打包模式门禁（不写 profile、不联网） |
| `test/crash-safety.test.mjs` | 门禁自身回归：源码绿灯、缺防线文件的包必须红、导出可用、接线与文档约束 |
| `tools/release/preflight.mjs` | 新增 `crash-safety: fail-safe invariants` 检查（RED 即阻断发布） |
| `tools/release/build.mjs` | tarball 生成后跑 `crash-safety --package --tarball`，未过不进 Release/npm |
| `package.json` | 两篇约束文档加入 `files`，随产物发布 |
| `docs/CHANGELOG.md` | v3.1.10 段（含事故记录与未发布状态） |

## 3. 强制点矩阵

| 层 | 触发 | 失败后果 |
|---|---|---|
| 单测（PR CI 全量） | `test/crash-safety.test.mjs` 等 | PR 红 |
| 发布前源码门禁 | `preflight.mjs` → `crash-safety --json` | preflight RED → build 退出 |
| 打包后门禁 | `build.mjs` → `crash-safety --package --tarball` | 构建失败，无产物发布 |
| 发布 workflow | build job 内置上述两步 | GitHub Release / npm 不执行 |

## 4. 本地证据

```text
crash-safety source      : 10 checks, failed=0
crash-safety tests       : 4/4 pass
boot-guard + desktop-launch + fork-supervisor + client-layout + crash-safety: 23/23 pass
preflight (no --e2e)     : crash-safety PASS；tests pass=1042 fail=0 skip=1；allow-list findings=0；
                           e2e 未跑 → 整体 RED（发布时必须 --e2e）
build --skip-preflight   : PASS package smoke；PASS crash-safety(packaged artifact)；
                           tarball 140 entries / 530,031 B
```

## 5. 环境恢复（事故善后）

- 备份：`profiles/desktop/.repair-<ts>/`（package.json / cordis.patch.yml / cordis.yml / pnpm-lock.yaml / pnpm-workspace.yaml）；
- 恢复：bundles 16 项、用户 patch 层（`cordis.patch.yml.bak-1794317591457`）；
- 安装校验：installed `client.js` sha256 = npm 3.1.9 产物 sha256；`boot-guard --profile-dir` dry-run 19 行 PASS；
- 生效条件：重启 DSH；未自动重启（避免二次事故）。

## 6. 已知边界

- 静态 + 隔离冒烟门禁，不是形式化证明；
- 不覆盖宿主内核/Node 自身崩溃；
- 分身与母体同用户同 ACL，非权限隔离；
- 桌面 Electron 壳不在 web 控制台门禁内；
- 本版不发布，发布需人类授权后按 `docs/WORKFLOW-UI.md` §3–§4 执行。
