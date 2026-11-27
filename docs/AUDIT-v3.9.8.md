# Fang v3.9.8 审计记录

日期：2026-11-27
范围：打开分身健康探针；一键修复 `fork-bundle-unavailable`；不改 v3.9.6/v3.9.7 的 zstd 与体量阈值逻辑。

## 一、问题证据

用户报告：
1. 双击“打开分身”失败，`browser-health.jsonl` 对 `task_mwqenfnxpobe` 记录 `http.ok=false / status=401 / path=/api/health / error=http-401`，session 与 adapter 均为 `ok:true`。
2. 一键修复失败：
   `stop-stale: ok · prune-alias-stubs: ok · reset-profile-config: ok · spawn: fork-bundle-unavailable`
   路径 `D:\ToFuture\FangData\forks\task_mwqenfnxpobe\profiles\fang-mwqenfnxpobe`。

根因一：
- `GET /fang/api/health` 只由 `orchestrator` 注册（`src/plugins/orchestrator.mjs` 约 7372 行，`public:true`）。
- `orchestrator` 的 `roleGate` 只在 mother 激活；fork 进程实际只加载 `adapter`，因此该路径在 fork 内 404。
- `probeForkHealth()` 先请求 `/fang/api/health`，只有 404 才回退 `/api/health`；后者是 DSH 核心受保护路由，返回 401。
- `evaluateForkHealth()` 只要 `http.ok !== true` 就报 `fork-health-endpoint-unavailable`，即使 session/adapter 正常也拒绝打开。

根因二：
- `restoreTask()` 与 `autostartForks()` 原先在 `syncForkCoreMode()`/`provision()` 之前检查 `forkBundlePath()`。
- 一键修复 `resetForkConfig` 后 profile 的 `node_modules/@twinsearth` 可能缺失；旧顺序立即返回 `fork-bundle-unavailable`，provision 永远没有机会重建 node_modules，形成死锁。

## 二、代码变更

| 文件 | 变更 |
|---|---|
| `src/plugins/adapter.mjs` | fork 角色注册公开 `GET <prefix>/api/health`（默认 `/fang/api/health`），返回 `ok/status/pid/taskId/sessionId/protocol/uptimeMs/at`、`role:'fork'`、`adapter:{ok:true}`；仍校验 loopback Host/Origin/Sec-Fetch-Site，公开只读不要求 Bearer |
| `src/plugins/orchestrator.mjs` | `restoreTask()` 将 `forkBundlePath()` 检查移到 `syncForkCoreMode(task,{force:true})` 之后；`autostartForks()` 在 bundle 缺失时强制 provision 并复查；失败时置 failed、清 pid/port/url、写 meta、审计 `FORK_CRASHED` |
| `test/adapter.test.mjs` | 路由期望改为 15 条；新增公开健康路由 200、role、taskId、adapter.ok、不泄露 token 断言 |
| `test/kernel.test.mjs`、`test/plugins-shape.test.mjs`、`test/role-extensions.test.mjs` | 版本断言改为 3.9.8 |
| `package.json`、`package-lock.json`、`src/kernel/types.mjs` | 版本 3.9.8 |
| `README.md`、`docs/CHANGELOG.md`、`docs/RELEASES.md`、`docs/RELEASE-v3.9.8.md` | 发布线、变更记录、版本索引与说明 |

## 三、验证

### 临时 fork

- 使用 `E:\DBH\fang-report\temp-fork-398` + 模板 node_modules + `dist/npm/package` 作为 `@twinsearth/fang-dsh-plugin` 启动。
- `GET /fang/adapter/identity` → 200，`version:"3.9.8"`、`role:"fork"`、`protocol:3`。
- `GET /fang/api/health` → 200，`ok:true`、`role:"fork"`、`taskId:"task_temp398"`、`sessionId`、`protocol:3`、`adapter:{ok:true}`。
- `GET /api/health` → 401（核心受保护路由，符合预期）。

### 真实宿主端到端

宿主：`http://127.0.0.1:61412`，pid 19020，version 3.9.8，role mother，dataDir `D:\ToFuture\FangData\mirror\desktop`。

一键修复 `task_mwqenfnxpobe` 的审计序列：
- `03:06:22.818Z` `fork-created`，template `...\templates\web-base`，coreMode stock。
- `03:08:28.881Z` `fork-started`，pid 3088，port 18000，profile `fang-mwqenfnxpobe`，restored true。
- `03:08:30.180Z` `adapter-handshake`，ok true，version 3.9.8，protocol 3。
- `03:08:30.221Z` `task-restored`，adapter ok true，role fork。
- `03:08:30.250Z` `task-repaired`，steps：stop-stale ok（skipped）、prune-alias-stubs ok、reset-profile-config ok、spawn ok。

任务状态：
- `tasks.json`：`status:"ready"`、`pid:3088`、`port:18000`、`adapter.ok:true`、`version:"3.9.8"`、`protocol:3`。
- fork `/fang/api/health`：200，`taskId:"task_mwqenfnxpobe"`、`role:"fork"`、`adapter:{ok:true}`。
- 打开分身：`POST /fang/api/tasks/open` 返回 200，`managed:true`、`port:19300`、browser pid 9220；审计 `fork-browser-opened` 03:09:37.444Z。
- `browser-health.jsonl` 最后一条：`ok:true`、`error:null`、`http.ok:true`、`status:200`、`path:"/fang/api/health"`、`latencyMs:37`、`adapter.ok:true`。
- 打开返回的 `sessionPolicy`：`largestMB≈2.97`、`totalMB≈2.98`、`level:"ok"`；阈值 `500/200/300`、`3900/3000/3600`。

## 四、测试与构建

- `node --test test/adapter.test.mjs`：43/43 PASS。
- 未跑 v3.9.8 全量测试；v3.9.7 全量基线为 1566 tests / 1511 pass / 32 fail / 13 skipped / 10 todo，32 条为既有夹具/清理竞态，未在本版修复。
- 构建：`node tools/release/build.mjs --skip-preflight`，日志 `E:\DBH\fang-report\build-398.log`。
- tarball：`dist/dsh-fang-3.9.8.tgz`，935,321 bytes，SHA-256 `8fe2c0ae3590a40c6c434d4cb57eafac0b9a102a3c22d0a819401b6b15a74fcc`。
- `manifest.preflight`：`skipped:true / green:false`，不得表述为 preflight GREEN。
- 本机 profile 部署 `@twinsearth/fang-dsh-plugin@3.9.8`，部署 digest `6f2c7fd029cc24cd4b97d88bc38c73f10a5d6d524b053531060173edd58378a4`。

## 五、观察与未覆盖

- 本机一键修复从 03:05:01 到 03:08:30 完成，约 3.5 分钟；主要耗时在 reset/provision/mirror node_modules 与 spawn。面板 `api()` 无客户端超时，会等待最终响应；但外部脚本若设 90s 超时会先断开，宿主仍会继续完成修复。
- 未跑全量测试；未修 v3.9.7 已记录的 30 条 orchestrator 夹具与 2 条 forker 清理竞态。
- 未改宿主压力阈值、Host JS heap、多帧 zstd 逻辑。
- 未执行 npm/GitHub/tag/Release 发布；npm `latest` 仍为 3.9.6。
- 临时目录 `E:\DBH\fang-report\temp-fork-min`、`temp-fork-398` 未清理。
