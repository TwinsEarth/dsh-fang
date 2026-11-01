# 审计报告 · dsh-Fang v2.7.0（ForkSseClient 网络层模糊测试）

> 证据来自本机真实门禁输出（2026-11-01，Windows / Node 24.16.0）。
> 报告不含凭据、不含本机绝对路径（allow-list 同时扫描这两类内容）。
> 版本策略：`x.y.z` 每一位 0–9；v2.6.9 后进位为 **v2.7.0**。

## 1. 范围

对 SSE 网络层（`src/lib/adapter-client.mjs` 的 `createAdapterClient()`，即设计稿中的
`ForkSseClient`）做“随机 HTTP 分块 + 随机断连”的等价性模糊测试：

- **真实 HTTP mock**（`http.createServer`）提供 `/fang/adapter/version|state|events`，
  按 `since` 过滤帧并记录请求；plan 控制 200/401/409/410/503、`serve` 帧数、
  `ending`（hold/end/destroy）与心跳插入；
- **生成器**：3–10 个事件；每帧 4 种切块模式；四类策略（无断/单断/多断/心跳）；
- **性质**：401 致命不重试；409/410 触发 `resetCursor=true` 并从快照重置；心跳不产帧；
  断连后 cursor 无重复/无空洞且 `since` 正确；
- **随机循环**：每 case 新 client → `connect()` → 等覆盖全部 cursor → 比较**未去重**的
  cursor 序列与请求 `since`；失败报告含 seed/iteration/strategy/expected/actual/requests；
- CLI：`node tools/fuzz/sse-client-fuzz.mjs --iterations 200 --seed 20261110`。

## 2. 门禁结果

| 门禁 | 命令 | 结果 |
|---|---|---|
| 版本一致性 | `node tools/release/preflight.mjs --e2e` | **GREEN 2.7.0** |
| Client 半可解析 | 同上 | `node --check client.js` **green** |
| 单元/集成测试 | 同上（内嵌全量） | **399 pass / 0 fail / 1 skip（400 项，23.2s）** |
| e2e 实机验收 | 同上 | **45/45（11.8s）** |
| allow-list + 秘密/本机路径扫描 | `node tools/release/allowlist.mjs --with-manifest` | **PASS**：34 路由、0 findings、142 文件扫描、包内 69 文件 allow-listed |
| 构建 | `node tools/release/build.mjs` | `dist/dsh-fang-2.7.0.tgz`（**244,116 B，85 entries**）<br>sha256 `64f6f1add960f3f30973a81ba7876bfc30537b79fe8f65ed18007080f33e2b53` |
| 产物健康检查 | `node tools/release/healthz.mjs` | **HEALTHY** `@twinsearth/dsh-fang@2.7.0`（15 个模块可 import） |
| 200 次随机 fuzz | `node tools/fuzz/sse-client-fuzz.mjs --iterations 200 --seed 20261110` | **0 failures**（10.8s）；noDisconnect 47 / single 51 / multi 53 / heartbeats 49 |
| 60 次随机 fuzz | 同上 `--iterations 60` | **0 failures**（3.6s）；13 / 14 / 16 / 17 |

## 3. 新增测试（3 项，`test/sse-client-fuzz.test.mjs`）

1. **性质套件**（约 0.3s）：401 致命不重试；409/410 resetCursor + `/state` 重拉；
   心跳无害；断连后 cursor 无重复且 `since` 等于上一段最后 cursor（`0` → `2`）。
2. **120 次随机 fuzz**：0 failures；四类策略均覆盖（策略计数总和 120）。
3. **同 seed 可复现**：8 次 ×2 的 strategyCounts 完全一致、零失败。

测试计数：397（v2.6.9）+ 3 = **400 项**（399 pass / 1 skip），与 preflight 输出一致。

## 4. 与设计稿的差异（诚实记录）

| 设计稿 | 本仓库落地 |
|---|---|
| `ForkSseClient`（`http.request` + 手写流解析） | 被测对象是 `createAdapterClient()`（fetch + `ReadableStream` + `TextDecoder`），网络路径同为真实 HTTP；mock 服务端不替换客户端 |
| `MockSseServer` 预切 chunks、不按 since 过滤 | mock 按 `since` 过滤帧（模拟 EventLog），因此“客户端 since 错误”会自然表现为重复/空洞，而不是被预切计划掩盖 |
| I5 心跳超时触发重连 | 本仓库客户端**没有 heartbeat timeout**；I4 只验证“心跳不产生帧、不影响 cursor”，未实现不存在的语义 |
| 409 只清 session、410 只清 cursor | 当前实现两者都 `resyncFromState`（清 cursor/session + 重拉快照），差异只在 reason |
| 字节级 UTF-8 分块 | 不测：fetch/undici 保证字符边界；若未来改手写 Buffer+TextDecoder 再补 |
| 背压 | 不测：`dispatchFrame` 同步扇出，属已知设计边界 |

## 5. 边界

- **hold 连接**：最后一个 plan 保持连接直到测试 `client.stop()`，因此不验证“服务端正常 EOF
  后自动重连”的路径（该路径由断连/409/410 覆盖）。
- **destroy 语义**：mock 用 `res.destroy()` 模拟网络中断；与 `res.end()` 的 FIN 语义不同，
  但都触发客户端 `onDisconnect`。
- **测试时长**：120 次随机 fuzz 约 6s，占全量测试约 1/4；CLI 手动跑 200 次约 11s。
- **无 instrumentation**：不统计代码覆盖率；策略计数只表示输入类型命中。

## 6. 提交状态

- 分支：`feat/fork-sse-fuzz`（stacked 在 PR #18 的 `feat/sse-directed` 之上）；
- 发布物：`dist/dsh-fang-2.7.0.tgz` + `dist/manifest.json` + `dist/preflight.json` + `dist/allowlist.json`；
- npm/GitHub Release 未执行：等待 PR 合并与维护者确认；
- 未合并 main：本 PR 只推送分支与 PR，合并由维护者手动审核。
