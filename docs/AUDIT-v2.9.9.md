# 审计报告 · dsh-Fang v2.9.9（母体镜像管理 + 小光盘入口）

> 证据来自本机真实输出（2026-11-02，Windows / Node 24.16.0）。
> 版本策略：`x.y.z`；新增能力进 minor 位。

## 1. 交付范围（文件夹 1 镜像层）

| 交付物 | 内容 |
|---|---|
| `src/lib/mirror.mjs`（零依赖） | 备份/恢复/删除/间隔/自动备份/检查更新/升级（事务化，失败自动回滚），`backupId` 正则防穿越 |
| orchestrator 接线 | `SERVICE.mirror='fangMirror'`、6 条 `/fang/api/mirror/*` 路由、每 60s 自动备份检查、`Config.mirrorRoot` |
| `client.js` | 顶栏「镜像」（蓝色小光盘 `IconDisc`）+ 「母体镜像」卡片：状态轮询 8s、6/12/24h、立即备份、备份列表恢复/删除（二次确认）、升级（indeterminate + 已用时间） |
| 测试 | `test/mirror.test.mjs` 16 项；`test/orchestrator.test.mjs` 新增 6 路由与处理器断言 |
| 文档 | `docs/MIRROR.md`（布局/路由/升级语义/边界/未交付） |

## 2. React 草案的落地映射（工程约束）

dsh-fang 的客户端是零依赖 `client.js`（`h()` hyperscript，非 React、无 TS 构建），因此：

| 草案 | 本仓库实现 |
|---|---|
| `useMirrorStatus` 轮询 hook | 卡片挂载期间 `setInterval(loadStatus, 8000)`，卸载清理；关闭卡片即停止轮询 |
| `useMirrorUpgrade` 状态机 | `upgrading` + `upgradeStartedAt` + `elapsed`（每秒） + `act('upgrade')` 结果处理 |
| `Modal` / `ConfirmDialog` | 内联卡片（与「母体连接」同风格）+ `window.confirm`（与面板既有归档/删除一致） |
| 按钮层持有升级状态 | 升级请求在卡片内发起；关闭卡片不取消已发出的 POST，重开通过状态轮询看到新版本 |
| 备份/恢复/删除交互 | 同草案：立即备份写 `restore/`，恢复/删除均二次确认，失败显示可读错误 |

## 3. 门禁结果（v2.9.9）

| 门禁 | 结果 |
|---|---|
| `preflight --e2e` | **GREEN 2.9.9** |
| 测试 | **552 pass / 0 fail / 1 skip**（新增 mirror 16 项） |
| e2e | **58/58** |
| allow-list | **44 路由 / 0 findings**（181 文件扫描；76 包文件） |
| 构建 | `dist/dsh-fang-2.9.9.tgz`（306,745 B / 93 entries / sha256 `1d18476e03c82b470cfa4740b0de925c6731cfec43ce4832dce3eb3713b58b5b`） |
| 产物健康检查 | **HEALTHY** `@twinsearth/dsh-fang@2.9.9`（16 模块） |

## 4. 语义不变量（有测试）

- 自动备份落 `backup/`、手动备份落 `restore/`；索引 + meta 同步；
- `restore` 先自动备份当前 active（`preBackupId`），再替换并更新 `meta.version`；
- 升级失败自动回滚（内部回滚不再产生额外备份），`active` 保持在失败前状态；
- `backupId` 非法（`../` 等）直接拒绝；备份间隔只接受 6/12/24；
- 无官方源时 `checkUpdate/upgrade` 返回 `official-source-unavailable`（409），不假装成功；
- 自动备份到期前不备份、到期后备份并把 `nextBackupAt` 推后。

## 5. 已知缺口

1. **官方源未接入**：升级按钮当前只在 `updateAvailable` 时可用，而默认无源 → 禁用；接入 npm/官方 Release 后在 `MirrorManager({officialSource})` 注入即可。
2. 升级进度是 indeterminate + 已用时间；`upgrade({onProgress})` 已留好回调，未来接 SSE 推送。
3. 原身/会话文件夹（P2/P3）与 `recomputeAll` 的升级后联动未接。
4. 自动备份只保留滚动备份，未实现保留策略（按数量/天数清理）。

## 6. 提交状态

- 分支：`feat/mirror-settings`（stacked 在 `feat/essence-overlay` / v2.10.0 之上）
- 发布物：`dist/dsh-fang-2.9.9.tgz` + manifest/preflight/allowlist
- 未合并 main；Release/tag 与私有镜像同步留待 PR 合并后执行
