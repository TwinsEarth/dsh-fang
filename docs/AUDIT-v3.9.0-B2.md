# B2：单文件 session 紧急线 48 → 64 MB（未发布）

- 日期：2026-11-26
- 触发现场：TOFUTURE Host 最大单文件 `session.v4.jsonl.zstd` 60.91 MB
- 选择：B2 —— 把单文件紧急线调到 64 MB，保留合计门
- 状态：工作树已调整；**未提升版本、未构建、未发布**。v3.9.0 已发布包仍使用 48 MB 单文件紧急线。

## 一、改动

`src/lib/host-pressure.mjs`：

- `SESSION_FOOTPRINT_DEFAULTS.fileEmergencyMB`：`48` → `64`
- `fileWarnMB=16`、`fileCriticalMB=32` 保持不变
- 合计门 `warn=512 / critical=1024 / emergency=2048 MB` 保持不变
- 仍只有单文件 emergency 置 `gate:true`；合计 emergency 只置 `totalGate:true`

`src/plugins/orchestrator.mjs`：

- Config `sessionFileEmergencyMB` 默认值 `48` → `64`
- 其余 `sessionFileWarnMB` / `sessionFileCriticalMB` / 合计阈值不变

## 二、行为变化

| 单文件最大体量 | 调整前（48 MB 紧急线） | 调整后（64 MB 紧急线） |
|---|---|---|
| 60.91 MB | emergency / gate=true | critical / gate=false |
| 63.99 MB | emergency / gate=true | critical / gate=false |
| 64.00 MB | emergency / gate=true | emergency / gate=true |
| 合计 5000 MB、单文件 10 MB | totalGate=true / gate=false | 不变 |

这次只放宽“单个大 session 直接拒绝新任务”的紧急线；合计 session 体量的 512/1024/2048 MB 审计与 `totalGate` 不变，因此不会把“很多小文件”误判为安全。

## 三、测试

- 定向 `test/v3814-host-guard.test.mjs` + `test/install-docs.test.mjs` + `test/main-gate.test.mjs`：20 tests / 20 pass / 0 fail。
- 新增边界：60.91 MB 不 gate；64 MB gate；合计 5000 MB 仍只 `totalGate`。
- 全量：1585 tests / 1562 pass / 0 fail / 13 skipped / 10 todo，`duration_ms=200067.86`。

## 四、边界

- 这是**阈值策略调整**，不是自动归档/压缩；60.91 MB 文件本身仍在，只是不再触发单文件 gate。
- 64 MB 单文件仍可能在打开时进入 Host JS heap；如果 heap 压力继续上升，heap 门仍会独立拒绝新任务。
- 未改客户端/服务端其他 gate，未改 `openMigrationReport`，未并入 C/D/E 项。
- 未构建、未打 tag、未发布 npm/GitHub；如需发布，需另行确认版本号与发布范围。
