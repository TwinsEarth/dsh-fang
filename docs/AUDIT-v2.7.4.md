# 审计报告 · dsh-Fang v2.7.4（连接三步流程可观测化）

> 证据来自本机真实门禁输出（2026-11-01，Windows / Node 24.16.0）。
> 报告不含凭据、不含本机绝对路径（allow-list 同时扫描这两类内容）。
> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 4 个补丁位（`2.7.3` → `2.7.4`）。

## 1. 背景：三步流程自 v2.6.1 已存在

设计稿要求 `ForkClientImpl.connect()` 先 `GET /version` 协商、再 `GET /state`、再订阅 SSE。
本仓库对应实现是 `src/lib/adapter-client.mjs` 的 `createAdapterClient().connect()`，顺序自
v2.6.1 起就是：

1. `remote.version()` → `negotiateProtocol(protocol, {min,max})`，不兼容直接
   `{ok:false, code}`，**不拉 state、不订阅**；
2. `remote.state()` → 设 `sessionId` / `lastCursor`；
3. `openOnce()` → `GET /events?since=<cursor>&session=<sessionId>`；
   409/410 走 `resyncFromState`（重拉 state + `resetCursor=true`），401 fatal。

既有测试已覆盖：三步成功、协议过新拒绝、401 致命、409 resync。

## 2. 本版本变更：只补可观测性

- `connect()` 结果新增 `version`、`sessionMismatch` 字段（向后兼容，只加字段）；
- `client.lastVersionInfo`：最近一次 `/adapter/version` 原始响应；
- `client.protocolRange`：本次协商实际使用的 `{min,max}`；
- `client.sessionMismatch`：version 与 state 的 `sessionId` 不一致时记录
  `{versionSession, stateSession, at}`；此时仍以 **state** 为准续流（state 是重启后最新快照），
  不重试三步（重试只会得到同一个 state）。

## 3. 与设计稿的刻意差异

| 设计稿 | 仓库实现 | 原因 |
|---|---|---|
| 抛 `UnsupportedProtocolError` | 返回 `{ok:false, code:'protocol-too-new'|'protocol-too-old'|'protocol-invalid'}` + fatal disconnect 事件 | 仓库传输层契约「永不抛，全部降级为可判定结果」 |
| 抛 `SessionChangedError` 并重试三步 | 记录 `sessionMismatch`，继续用 state 的 session | state 已由新进程生成，重试无新信息 |
| `connectWithSnapshot` 拆分 + 同步 N 次重试 | 不拆；`openOnce` + `resyncFromState`；失败转后台 `reconnectLoop` | 单一 connect 状态机更简单；母体不放弃分身 |
| `VersionInfo.adapter/dsh` 字段 | `lastVersionInfo` 原样保留对端响应（含 version/sessionId/taskId…） | 不假设对端字段名，原样透传 |

## 4. 门禁结果

| 门禁 | 命令 | 结果 |
|---|---|---|
| 版本一致性 | `node tools/release/preflight.mjs --e2e` | **GREEN 2.7.4** |
| Client 半可解析 | 同上 | `node --check client.js` **green** |
| 单元/集成测试 | 同上（内嵌全量） | **409 pass / 0 fail / 1 skip（410 项，24.5s）** |
| e2e 实机验收 | 同上 | **57/57（16.7s）** |
| allow-list + 秘密/本机路径扫描 | `node tools/release/allowlist.mjs --with-manifest` | **PASS**：36 路由、0 findings、149 文件扫描、包内 69 文件 allow-listed |
| 构建 | `node tools/release/build.mjs` | `dist/dsh-fang-2.7.4.tgz`（**248,526 B，85 entries**）<br>sha256 `692f83427b3e33d4026dddf34ac43102e0653d3151d9c3d855b2a1257abca269` |
| 产物健康检查 | `node tools/release/healthz.mjs` | **HEALTHY** `@twinsearth/dsh-fang@2.7.4`（15 个模块可 import） |

## 5. 新增测试（`test/adapter-client.test.mjs`，8 项）

1. 「version 信息与协议区间可观测」：`connected.version.version`、`lastVersionInfo.protocol`、
   `protocolRange.min/max`、`sessionMismatch === null`；
2. 「version/state sessionId 不一致」：记录 `sessionMismatch`（s-old→s-new），
   `connected.sessionId === 's-new'`，SSE URL 带 `since=4&session=s-new`。

测试计数：408（v2.7.3）+ 2 = **410 项**（409 pass / 1 skip），与 preflight 输出一致。

## 6. 边界

- `sessionMismatch` 只在两次请求之间发生进程重启时出现；Adapter 的 `sessionId` 进程内不变，
  所以该信号精确、不误报。
- 协议协商失败时 `lastVersionInfo` 仍记录对端响应（便于排障），但不建立任何连接。
- 401 在 version / state / SSE 任一步都 fatal，不重试。
- 本版本不改变任何连接顺序或重试策略，只是把既有信息暴露出来。

## 7. 提交状态

- 分支：`feat/connect-version-preflight`（stacked 在 PR #22 的 `feat/restart-events` 之上）；
- 发布物：`dist/dsh-fang-2.7.4.tgz` + `dist/manifest.json` + `dist/preflight.json` + `dist/allowlist.json`；
- npm/GitHub Release 未执行：等待 PR 合并与维护者确认；
- 未合并 main：本 PR 只推送分支与 PR，合并由维护者手动审核。
