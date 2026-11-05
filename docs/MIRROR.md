# 母体镜像管理（v3.0.1）

文件夹 1（镜像层）的唯一管理入口：备份 / 恢复 / 自动备份 / 升级 / 回退。
原身（文件夹 2）与分身（文件夹 3）不在本版本内。

## 1. 目录布局

```
<mirrorRoot>/                     # 默认 <dataRoot>/mirror，可用 Config.mirrorRoot 覆盖
  active/                         # 正在运行的镜像内容（升级/回退只替换这一层）
  backup/<id>/                    # 自动备份（按 6/12/24h 滚动）
  restore/<id>/                   # 手动恢复点（「立即备份」写入这里）
  backups.json                    # 备份索引：id/label/createdAt/sizeBytes/version/kind/bucket
  meta.json                       # version/installedAt/backupIntervalHours/lastBackupAt/nextBackupAt
  mirror-locked.json              # 可选：锁定插件清单（EssenceManager 读取）
```

## 2. 服务与路由（仅母体角色）

服务 `SERVICE.mirror = 'fangMirror'`（由 `fang-orchestrator` 提供）：
`status / backup / restore / deleteBackup / setBackupInterval / checkUpdate / upgrade`。

| 路由 | 方法 | 说明 |
|---|---|---|
| `/fang/api/mirror/status` | GET | 版本、官方最新、更新可用、备份列表、磁盘占用、活跃分身数 |
| `/fang/api/mirror/backup` | POST | `{label?, bucket?: 'backup'|'restore'}`；手动备份默认写 `restore/` |
| `/fang/api/mirror/restore` | POST | `{backupId}`；**先自动备份当前 active**，再替换 |
| `/fang/api/mirror/backup/delete` | POST | `{backupId}`；删除备份目录 + 索引 |
| `/fang/api/mirror/backup-interval` | POST | `{hours}`，只接受 6/12/24 |
| `/fang/api/mirror/upgrade` | POST | `{autoBackup?, autoRollback?}`；无官方源时返回 409 `official-source-unavailable` |

## 3. 升级语义

`upgrade()` = 检查最新 → 自动备份 → 下载到 staging → 原子替换 `active/` → 写 meta/version.json；
任一步失败且 `autoRollback !== false` 时用升级前备份回滚（回滚不再额外备份）。
进度通过可选 `onProgress(stage)` 回调（checking/backing-up/downloading/swapping/finalizing/done/failed），
供未来 SSE 接入；当前 UI 用 indeterminate 进度 + 已用时间。

**官方源未接入**：本版本不配置官方源，`checkUpdate/upgrade` 显式降级（不假装成功）；
后续接入 npm/官方发布源后即可打开升级按钮。

## 4. 自动备份

orchestrator 每 60s 检查一次 `meta.nextBackupAt`，到期调用 `maybeAutoBackup()` 写 `backup/`。
间隔 6/12/24 小时，修改间隔会立即重算下次时间。`nextBackupAt` 为 null（首次）时只安排不执行。

## 5. 安全与边界

- `backupId` 必须匹配 `^\d{10,16}-[a-z0-9]{4,12}$`，拒绝路径穿越；
- 恢复/删除/备份都是本机文件夹操作，不触碰原身与会话文件夹；
- 升级替换失败时 active 目录保持在中断前状态（staging 目录 finally 清理）；
- 镜像带 `credentials/` 不会影响原身：凭据隔离在 EssenceManager 物化时处理。

## 6. 后续（未交付）

1. 官方源接入（npm registry / 官方 Release 资产）+ 下载校验；
2. UI 升级阶段改为后端 `onProgress` 推送（SSE）而非 indeterminate；
3. 原身（文件夹 2）与会话（文件夹 3）的派生/隔离（P2/P3）。
