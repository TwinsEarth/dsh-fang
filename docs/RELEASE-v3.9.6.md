# v3.9.6 · 会话健康阈值版

> 基线：v3.9.5。发布日期：2026-11-27。npm / GitHub Release / 项目交付目录三方发布。

## 这一版解决什么

1. **双击“打开分身”导致 DSH 客户端崩溃**：`countSessionEvents()` 对 DSH 的多帧 `session.v4.jsonl.zstd` 使用 `createReadStream().pipe(createZstdDecompress())`。Node 流式 zstd 只解第一帧，第二帧的 magic 被当成未知帧，抛出 `ZSTD_error_prefix_unknown`；错误在流结束后成为未捕获异常，母体 host 直接退出（Electron 44.7.0 / Node 24.21.0 / zlib 1.3.1，栈落在 `node:zlib:193`）。
2. **旧 20 MB 阈值误伤真实会话**：瓮城Plus 21.8 MB、W2M 63.9 MB、IM2A 26.2 MB 被直接判 `session-too-large`，无法打开。

## 新口径（用户确认）

| 范围 | 警告 | 二次确认 | 硬上限 |
|---|---:|---:|---:|
| 单个会话文件 | >200 MB | >300 MB | >500 MB |
| 分身内会话合计 | >3000 MB | >3600 MB | >3900 MB |

边界语义为“超过”：恰好 200 / 300 / 500 MB 仍属于较低一档；合计同理。二次确认只放行确认档，**硬上限即使确认也拒绝**。

## 代码改动

### 多帧 zstd 解码

- `src/lib/fork-health.mjs` 不再把多帧日志接到流式解码器。
- 新增按 zstd 帧结构扫描边界，每帧单独 `zlib.zstdDecompressSync`，逐帧累计行/字节。
- 压缩文件读取上限：`MAX_COUNT_COMPRESSED_BYTES = 256 MiB`；解压预算 `min(1 GiB, max(64 MiB, 压缩上限 × 4))`。
- 修复后同一 3.1 MB“房主”会话：`ok:true`、`events:9553`、`bytes:17797140`，无未捕获异常。

### 阈值与确认流程

- `FORK_HEALTH_DEFAULTS`：`maxSessionMB:500`、`warnSessionMB:200`、`confirmSessionMB:300`、`warnTotalMB:3000`、`confirmTotalMB:3600`、`hardTotalMB:3900`、`maxEvents:1_000_000`、`maxUncompressedBytes:1 GiB`。
- `orchestrator` schema 新增 `forkHealthWarnSessionMB` / `forkHealthConfirmSessionMB` / `forkHealthWarnTotalMB` / `forkHealthConfirmTotalMB` / `forkHealthHardTotalMB`；`forkHealthMaxSessionMB` 默认 500，`forkHealthMaxEvents` 默认 1,000,000。
- 警告/确认档跳过事件计数（`scanSkipped:true`），返回 `policy`；不把大会话整读进内存。
- `POST /fang/api/tasks/open` 接受 `confirmLargeSession:true`：
  - 需确认：HTTP 409，`error:fork-session-confirmation-required`，带 `sessionPolicy` / `detail`；
  - 硬上限：HTTP 409，`error:fork-health-session-hard-limit`；
  - 确认后放行：返回 200，成功体带 `sessionWarning` / `sessionPolicy`。
- 客户端 `openTask` 支持确认参数、二次确认弹窗、200 MB 警告提示、硬上限拒绝提示。
- `browser-health.jsonl` 记录 `scanSkipped` / `policy`；`fork-open-session-confirmation-required` 写入审计。

## 升级与重启

- 本版必须重装插件并**完全退出 DSH 客户端再启动**，旧母体仍缓存 3.9.5 的 `fork-health`。
- 已装旧版 3.9.5 热补丁的机器，安装 3.9.6 后会以本版代码为准。
- 配置里若手工写过旧 `forkHealthMaxSessionMB:20`，请删除该覆盖或改成 500；否则 20 MB 硬上限仍会生效。

## 验证

- 多帧 zstd 回归：`test/v386-crash-closures.test.mjs` 10/10 PASS。
- 阈值策略：200/300/500 MB 单文件、3000/3600/3900 MB 合计、确认后放行、硬上限拒绝、跳过事件计数均覆盖。
- 真机 fork 复验：房主 2.98 MB / 9553 事件、2Xray 1.36 MB / 2113 事件、瓮城Plus 25.17 MB / 48931 事件、W2M 60.9 MB / 143549 事件、IM2A 25 MB / 52368 事件，全部 `ok`；旧 20 MB 口径下后三者会被误拒。
- 全量测试结果与已知夹具失败见 `docs/AUDIT-v3.9.6.md`，不把既有夹具问题写成 GREEN。

## 资产

- npm：`@twinsearth/fang-dsh-plugin@3.9.6`
- GitHub Release：`v3.9.6`
- 交付目录：`E:\DBH\Fang-v3.9.6\`
