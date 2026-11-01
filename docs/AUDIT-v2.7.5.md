# 审计报告 · dsh-Fang v2.7.5（端口生命周期文档化）

> 证据来自本机真实门禁输出（2026-11-01，Windows / Node 24.16.0）。
> 报告不含凭据、不含本机绝对路径（allow-list 同时扫描这两类内容）。
> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 5 个补丁位（`2.7.4` → `2.7.5`）。

## 1. 设计评审结论（非代码变更）

设计稿要求把 `AdapterServer` 与 `Forker` 的端口分配协同起来：Forker 分配两个端口、
写 `meta.adapterPort`、注入 `DSH_ADAPTER_PORT`、AdapterServer 独立 listen、双端口 waitReady/归还。

**本仓库在 v2.6.8 已明确采用单端口方案**：Adapter 的 HTTP 路由挂在分身自己的 DSH
`webServer` 上（`ctx.inject(['webServer'])` → `webServer.register({kind:'exact', path, handler})`），
与 DSH 共用同一端口。证据：

- `docs/ADAPTER-COMMANDS.md §1`：「为什么没有独立 AdapterServer：本仓库的 DSH `webServer`
  确实支持 `register({path, handler})`，Adapter 已复用分身端口（e2e 验证），不需要 Forker
  再分配第二个端口」；
- 全仓库无 `DSH_ADAPTER_PORT` 引用（`Select-String` 0 命中）；`forker.mjs` 只注入
  `DSH_ADAPTER_TOKEN`；
- `forks.json` / `fang-meta.json` 只有 `port`，无 `adapterPort`；
- e2e 57/57 在真实 mother+fork 上验证了同端口 `/fang/adapter/*` 握手链路。

因此本版本不改端口模型，只把生命周期文档化（`docs/PORT-LIFECYCLE.md`），避免后续重复讨论。

## 2. 文档内容

- **谁拥有端口**：Forker 是唯一分配者（`pool.acquire()` 一次）；Adapter 是纯消费者。
- **容量**：18000–18100 共 101 个端口，1 个/分身，`maxForks` 默认 8，容量充足、无需翻倍。
- **env 契约**：`DSH_HOME` / `DSH_FANG_ROLE` / `DSH_FANG_TASK_ID` / `DSH_ADAPTER_TOKEN`；
  明确 `DSH_ADAPTER_PORT` 不存在及原因。
- **就绪判定**：forker 解析 banner + 探 DSH 端口；Adapter 就绪由 Orchestrator 在同端口
  `GET /fang/adapter/hello` + `/adapter/version` 握手判定（分层正确，不把 Adapter 协议塞进 forker）。
- **六条归还路径**：spawn 失败 / dispose 取消 / spawn 超时 / 子进程退出 / `stop()` / `reap()` /
  `recover()` 死孤儿；活孤儿不归还（无 token、靠 `isPortAvailable` 预检跳过）。
- **回退清单**：若未来真要独立 Adapter 端口，需同时改七处（schema、双 acquire、env、
  listen 失败标记、双端口 waitReady、归还路径、e2e）并接受三类新风险。

## 3. 门禁结果

| 门禁 | 命令 | 结果 |
|---|---|---|
| 版本一致性 | `node tools/release/preflight.mjs --e2e` | **GREEN 2.7.5** |
| Client 半可解析 | 同上 | `node --check client.js` **green** |
| 单元/集成测试 | 同上（内嵌全量） | **409 pass / 0 fail / 1 skip（410 项，24.1s）** |
| e2e 实机验收 | 同上 | **57/57（16.0s）** |
| allow-list + 秘密/本机路径扫描 | `node tools/release/allowlist.mjs --with-manifest` | **PASS**：36 路由、0 findings、151 文件扫描、包内 69 文件 allow-listed |
| 构建 | `node tools/release/build.mjs` | `dist/dsh-fang-2.7.5.tgz`（**248,536 B，85 entries**）<br>sha256 `81225245d5841c34d05a636434165692f0e361f6c220960b990a0bc715e795c7` |
| 产物健康检查 | `node tools/release/healthz.mjs` | **HEALTHY** `@twinsearth/dsh-fang@2.7.5`（15 个模块可 import） |

测试计数不变：**410 项**（409 pass / 1 skip）——本版本是文档变更，不新增代码路径。

## 4. 边界

- 文档明确「新增 `adapterPort`/`DSH_ADAPTER_PORT` 属于协议变更，需走 PROTOCOL 版本流程」；
- acquire 与 bind 之间的被抢窗口无法归零（预检 + spawn 失败归还兜底），文档已注明；
- 活孤儿端口不归还，靠池预检跳过；上层可 kill 后回收。

## 5. 提交状态

- 分支：`docs/port-lifecycle`（stacked 在 PR #23 的 `feat/connect-version-preflight` 之上）；
- 发布物：`dist/dsh-fang-2.7.5.tgz` + `dist/manifest.json` + `dist/preflight.json` + `dist/allowlist.json`；
- npm/GitHub Release 未执行：等待 PR 合并与维护者确认；
- 未合并 main：本 PR 只推送分支与 PR，合并由维护者手动审核。
