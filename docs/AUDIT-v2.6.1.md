# 审计报告 · dsh-Fang v2.6.1（Adapter v3 协议化）

> 证据全部来自本机真实门禁输出（2026-11-01，Windows / Node 24.16.0）。
> 报告不含凭据、不含本机绝对路径（allow-list 自检同时扫描这两类内容）。
> 版本策略：`x.y.z` 每一位 0–9（一个次版本 10 个小版本）；本次发布位是 **2.6.1**，不是 2.7.0。

## 1. 范围

把分身体内 Adapter 的 HTTP 协议与状态同步机制展开到接口粒度，并落地为可运行的 v3
（**向后兼容 v2**）：

- 协议词汇与唯一错误码映射（`src/kernel/types.mjs`）；
- 共享协议库（`src/lib/adapter-protocol.mjs`）：cursor/环形缓冲/幂等缓存/版本协商/Bearer/SSE 帧；
- 分身侧 5 条新路由：`version` / `health` / `state` / `events`(SSE) / `commands`(幂等)；
- 母体侧 `Remote` v3 方法 + 新 `AdapterClient`（SSE 解析、断线退避、409/410 自动重拉、同 commandId 重试）；
- Forker 每次 spawn 生成 Adapter Bearer token 并经 env 注入（内存 only）；Orchestrator 协商版本并透传 token；
- 协议文档 `docs/PROTOCOL-V3.md`。

设计取舍（与需求稿的差异，均在文档 §3/§6/§12 说明）：

1. 路径使用 `${prefix}/adapter/*`（默认 `/fang/adapter/*`），不用 `/api/adapter/*`——避免与 DSH 自身 `/api`
   命名空间冲突，并与 v2 五条路由共用前缀与 allow-list 规则。
2. token 为 24 随机字节（48 hex），而非 32 字节；熵足够且更短。不落盘、不进 URL。
3. 心跳是 SSE **注释帧**（`: heartbeat`），不占 cursor、不污染审计事件流；同时驱动待审批 diff。
4. 母体对孤儿分身**只重建、不接管**（旧 token 随母体进程丢失 → 401 自然拒绝）。

## 2. 门禁结果

| 门禁 | 命令 | 结果 |
|---|---|---|
| 版本一致性 | `node tools/release/preflight.mjs --e2e` | **GREEN 2.6.1** |
| 单元/集成测试 | 同上（内嵌全量） | **330 pass / 0 fail / 1 skip（331 项，15.9s）** |
| e2e 实机验收 | 同上（内嵌 `tools/e2e.mjs`） | **45/45（12.6s）** |
| 路由 allow-list + 秘密/本机路径扫描 | `node tools/release/allowlist.mjs --with-manifest` | **PASS**：34 路由、0 findings、112 文件扫描、包内 65 文件 allow-listed |
| 构建 | `node tools/release/build.mjs` | `dist/dsh-fang-2.6.1.tgz`（**225,749 B，81 entries**）<br>sha256 `11b5691f94639773425078653429ce93a36b8f6cb5574bcad3d9d461e24e9c28` |
| 产物健康检查 | `node tools/release/healthz.mjs` | **HEALTHY** `@twinsearth/dsh-fang@2.6.1`（15 个模块可 import） |

## 3. 新增测试（25 项）

| 文件 | 数量 | 覆盖 |
|---|---|---|
| `test/adapter-protocol.test.mjs` | 11 | uint64 cursor 边界、环形缓冲裁剪与 gap、LRU 幂等缓存、版本区间、Bearer 解析、命令信封校验、错误码映射、SSE 跨 chunk 解析、命令 id |
| `test/adapter.test.mjs` | +5（共 31） | v3 路由顺序、version/health/state 形状、审批 diff 事件、SSE 回放/410/409/关闭清理、命令幂等+202+校验、Bearer 401/放行 |
| `test/adapter-client.test.mjs` | 6 | connect 三步、协议过新拒绝、401 致命、409 重拉快照+续流、网络失败同 commandId 重试、400 不重试 |
| `test/remote.test.mjs` | +2（共 14） | v3 路径 + Bearer 头、eventsUrl 的 since/session/token |
| `test/forker.test.mjs` | +1（共 25） | token 每次 spawn 重新生成、进 env、stop 作废、不落 forks.json / fang-meta.json / status |

## 4. 实机证据（e2e 45/45 中的关键项）

- `adapter handshake succeeded {"ok":true,"version":"2.6.1"}` —— 真实分身（新 bundle）在 **Bearer 认证开启** 下完成
  `/hello` + `/version` 协商，说明 Forker 注入 token、Orchestrator 透传 token、Adapter 校验三方闭环成立；
- `fork adapter is up`：分身 7 个业务服务 + adapter 全部在线；`fork does NOT expose forker/orchestrator`：角色矩阵未被破坏；
- 派生前注入历史会话、派生/归档回收、母体审计哈希链（20 条）全部通过；
- `fork home reaped after archive`：归档后不留僵尸目录（v2.6.1 修复未回归）。

## 5. 风险与遗留

1. **SSE 尚未接线到 UI**：`AdapterClient` 已交付并有单测，但 Orchestrator 仍只做 JSON 握手/命令；
   任务状态流/审批推送仍靠轮询。下一个 PR 把 `onEvent` 接到 `task.adapter.*` 与 UI。
2. **UI「适配器失联」文案**（上一轮用户截图问题）尚未修：母体重启后的旧任务应在 UI 显示「已失效/可归档」，
   而不是把 `http-404` 说成适配器失联。这是独立小修，需在 v2.7 合并后单独 PR。
3. **`CommandCache` 跨重启不持久**：极端窗口（执行成功→响应丢失→分身重启→母体重试）可能重复执行；
   缓解方案见 `PROTOCOL-V3.md §12`（命令副作用自身幂等），不建议落盘。
4. **`/state` 压缩**：快照较大时未 gzip；取决于 DSH webServer 是否已有压缩中间件，留待接线时确认。
5. PR 纪律：本分支只提交/推送/开 PR，**不合并 main**；合并顺序仍为 #7 → #8 → #9 → 本 PR。

## 6. 提交与发布状态

- 分支：`feat/adapter-protocol-v3`（基于 `feat/forker-supervisor`，stacked PR）；
- 发布物：`dist/dsh-fang-2.6.1.tgz` + `dist/manifest.json` + `dist/preflight.json` + `dist/allowlist.json`；
- npm/GitHub Release 未执行：等待 PR 合并与维护者确认（沿用 v2.6.0 的 8 方发布流程）。
