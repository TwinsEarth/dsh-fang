# Fang v3.9.8 — 打开分身热修版

版本：`@twinsearth/fang-dsh-plugin@3.9.8`
日期：2026-11-27
基线：v3.9.7（宿主压力阈值对齐）

## 修复

1. **fork 公开健康探针**
   - `GET /fang/api/health` 原本只由 `orchestrator` 注册；`orchestrator` 的 roleGate 只在 mother 激活，fork 进程从不加载。
   - `probeForkHealth()` 先请求 `/fang/api/health`（404），再回退到 DSH 核心受保护的 `/api/health`（401），导致打开分身报 `fork-health-endpoint-unavailable`。
   - v3.9.8 由 fork 必装的 `adapter` 注册公开 `GET <prefix>/api/health`（默认 `/fang/api/health`），返回 `ok/role/version/pid/taskId/sessionId/uptimeMs/adapter`；仍校验 loopback Host、Origin、Sec-Fetch-Site，但公开只读不要求 Bearer。

2. **一键修复的 bundle 复检**
   - `restoreTask()` 原先在 `syncForkCoreMode()`/`provision()` 之前检查 `forkBundlePath()`；`resetForkConfig` 后 `node_modules/@twinsearth` 缺失时直接报 `fork-bundle-unavailable`。
   - v3.9.8 把 bundle 检查移到 `syncForkCoreMode(task,{force:true})` 之后，让 provision 从模板/原身重新镜像 node_modules 后再复查。
   - `autostartForks()` 在 bundle 缺失时强制 `syncForkCoreMode(task,{force:true})` 并复查，不再提前跳过。

## 保持不变

- v3.9.7 的宿主压力阈值：单文件 200/300/500 MB、合计 3000/3600/3900 MB。
- v3.9.6 的多帧 zstd 崩溃修复与打开前二次确认。
- Host JS heap 1024/1536/2048 MB 阈值未改。

## 资产

- npm：`@twinsearth/fang-dsh-plugin@3.9.8`（https://www.npmjs.com/package/@twinsearth/fang-dsh-plugin/v/3.9.8）
- GitHub Release：`v3.9.8`（https://github.com/TwinsEarth/fang-dsh-plugin/releases/tag/v3.9.8）
- 交付目录：`E:\DBH\Fang-v3.9.8\`
- tarball：`dsh-fang-3.9.8.tgz`，935,321 bytes，SHA-256 `8fe2c0ae3590a40c6c434d4cb57eafac0b9a102a3c22d0a819401b6b15a74fcc`

## 验收

- `test/adapter.test.mjs` 43/43 PASS，新增 `/fang/api/health` 公开探针断言。
- 真机 fork 模板：3.9.7 `/fang/api/health` 404、`/api/health` 401；3.9.8 构建产物 `/fang/api/health` 200，`role:"fork"`、`adapter.ok:true`。
- 真实宿主一键修复 `task_mwqenfnxpobe` 成功：`fork-created → fork-started（pid 3088，port 18000）→ adapter-handshake 3.9.8 → task-restored → task-repaired`；任务状态 `ready`。
- 打开分身成功：托管浏览器 pid 9220、port 19300；`browser-health.jsonl` 记录 `ok:true`、`http.status:200`、`path:/fang/api/health`。
- 本地 profile 已部署 3.9.8；npm/GitHub/tag/Release 发布状态以本节资产链接为准。
