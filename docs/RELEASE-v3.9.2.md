# Fang v3.9.2 发布说明

- 版本：`3.9.2`
- 包名：`@twinsearth/fang-dsh-plugin`
- 基线：`3.9.1` 官方包 + 本地 3.9.1 patched 热修
- 类型：打包/可观测性/定时器热修，不包含新的 OOM 根因修复

## 三项修复

### 1. AppleDouble 打包污染

- 新增 `.npmignore`：排除 `**/._*`、`**/.DS_Store`、`._*`、`.DS_Store`、`*.tgz`。
- 新增 `tools/release/clean-apple-double.mjs`：安装后递归清理整棵插件树的 AppleDouble 与 Finder 元数据，跳过 `node_modules`、`.git`、symlink。
- `postinstall` 改为先全树清理，再执行原有 locale sidecar 清理。
- 结果：tarball 208 entries，AppleDouble 0。

### 2. `__fangUiLog` 无上限

- 客户端新增 `FANG_UI_LOG_MAX_ENTRIES=500`、`FANG_UI_LOG_MAX_BYTES=262144`。
- 新增 `fangUiLogBytes` / `ensureFangUiLog` / `pushFangUiLog`，`diag`、点击事件、`panel-mount`、内嵌状态页全部改走裁剪函数。
- 原有 `__bound` 标记保留。
- 结果：5000 条小事件压到 500 条；1000 条约 1.9 KB 事件压到 135 条 / 261,630 B，低于 262,144 B。

### 3. 5s 级探测/心跳降频

- `client.js`：`POLL_MS 5000→15000`、`INBOX_POLL_MS 5000→15000`、决策 mini section load `5000→15000`。
- `orchestrator.mjs`：`HOST_STATE_WRITE_INTERVAL_MS 5000→15000`，新增 `HOST_WATCHDOG_INTERVAL_MS=15000`，状态页 `setInterval(refresh, 15000)`。
- `adapter.mjs`：`heartbeatMs` 默认 `5000→15000`。
- `memory-guard` / `session-footprint` 的 5s 注释同步改为 15s；实际 `memoryWatchIntervalMs` 仍 15s，`sessionFootprintIntervalMs` 仍 60s，未扩大范围。

## 验证

- `node --check`：6 个修改文件全部通过。
- 静态断言：18/18 PASS。
- UI 日志上限精确代码块测试：PASS。
- 真实 DSH 宿主 smoke：tarball 解包目录 17/17 PASS；`role=mother version=3.9.2`，client 挂载，无 pending/handler-threw，宿主只起一个进程。

## 发布边界

- 3.9.2 是热修候选，未安装进真实 `desktop` profile；真实宿主仍是旧进程。
- 3.9.2 仍保留 3.9.1 热修的 8 分身配额与 `singleActiveFork=false`。
- 本次不保证单独解决 OOM；pagefile 扩容与 RAMMap/ETW 追根因已按用户决定放弃。
- AppleDouble 修复只作用于 npm 包与安装后清理，不改变运行时内存行为。
