# 审计报告 · dsh-Fang v2.6.4（ForkClient 完整实现）

> 证据全部来自本机真实门禁输出（2026-11-01，Windows / Node 24.16.0）。
> 报告不含凭据、不含本机绝对路径（allow-list 自检同时扫描这两类内容）。
> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.6 的第 4 个补丁位（`2.6.3` → `2.6.4`）。

## 1. 范围

在 AdapterClient（传输 + SSE）与 CommandCache（幂等）之上实现母体侧命令外观 `ForkClient`：

1. **同步命令**：POST completed → 直接返回；同 commandId 命中缓存不重复 POST；
2. **异步命令**：202 accepted + trackingId → `inflight` Map 等待 SSE `command-done`；
   **缓存终态结果**（不是 accepted），避免把「已接受」误报成「已完成」；
3. **command-done 匹配**：按 trackingId（不是 commandId）；stale 事件静默忽略；
   重复 trackingId → `duplicate-tracking-id`；
4. **超时兜底**：同步 POST 走传输层 AbortController；异步命令 `asynchronousTimeoutMs`（默认 120s）
   timer，超时 reject `command-timeout` → 缓存移除 → 同 commandId 可重试；
5. **SSE 生命周期**：断开保留 inflight（cursor 补发）；`resetCursor=true`（分身重启）与
   `disconnect()`（用户主动）→ 全部 inflight reject；
6. **事件扇出**：`onEvent/onReconnect/onDisconnect`、handler 异常隔离、`state-changed` 更新快照；
7. **fail-closed**：未 connect / 已 disconnect 时命令直接 reject；
8. 覆盖 dsh-Fang 的 9 个 Adapter op 便捷方法。

文档：`docs/FORK-CLIENT.md`（TS 接口形状 ↔ `.mjs` 映射、生命周期、超时矩阵、错误码、测试、边界）。

## 2. 门禁结果

| 门禁 | 命令 | 结果 |
|---|---|---|
| 版本一致性 | `node tools/release/preflight.mjs --e2e` | **GREEN 2.6.4** |
| Client 半可解析 | 同上（v2.6.2 起） | `node --check client.js` **green** |
| 单元/集成测试 | 同上（内嵌全量） | **360 pass / 0 fail / 1 skip（361 项，15.5s）** |
| e2e 实机验收 | 同上（内嵌 `tools/e2e.mjs`） | **45/45（12.3s）** |
| 路由 allow-list + 秘密/本机路径扫描 | `node tools/release/allowlist.mjs --with-manifest` | **PASS**：34 路由、0 findings、120 文件扫描、包内 67 文件 allow-listed |
| 构建 | `node tools/release/build.mjs` | `dist/dsh-fang-2.6.4.tgz`（**235,595 B，83 entries**）<br>sha256 `a31ae9e0bc52ae71a6d7ec736d54b2450d46b37822574a5df6f74671f7706a29` |
| 产物健康检查 | `node tools/release/healthz.mjs` | **HEALTHY** `@twinsearth/dsh-fang@2.6.4`（15 个模块可 import） |

## 3. 新增测试（13 项，`test/fork-client.test.mjs`）

同步直通 + 缓存命中；异步 accepted → command-done → 缓存终态；异步超时（command-timeout + 缓存移除
+ 同 id 重试）；传输失败不缓存；SSE 断开保留 inflight；session 变化清空 inflight；主动 disconnect
清空 inflight + 传输层幂等停止；stale command-done 静默；重复 trackingId；事件扇出隔离 /
state-changed；connect 失败错误码 + 未 connect 拒绝；参数边界 / nextCommandId 唯一；
9 个 op 便捷方法走 runCommand/缓存。

测试计数：348（v2.6.3）+ 13 = **361 项**（360 pass / 1 skip），与 preflight 输出一致。

## 4. TypeScript 说明

需求稿要求「可编译的 TypeScript 代码」。本仓库是纯 JS（`.mjs`，无 `tsc`/`tsconfig`/类型声明），
因此：

- 落地为 `src/lib/fork-client.mjs`（JSDoc 类型），与仓库其它模块一致，可直接被 Node 运行；
- `docs/FORK-CLIENT.md §2` 给出与实现一一对应的 TypeScript 形状（`ForkClientOptions`、
  `ForkTransport`、`ForkClient` 方法签名），可据此生成 `.d.ts` 或迁移 `.ts`；
- 若要引入真正的 `tsc` 编译门禁，需要独立 PR 增加 TypeScript 工具链（会影响零依赖门禁），
  本次不改变构建模型。

## 5. 风险

1. **异步缓存语义**：缓存的是 command-done 终态；若 Adapter 之后改变 accepted/trackingId 语义，
   `runCommand` 的分支需同步（契约已写入 `docs/PROTOCOL-V3.md §6.2`）。
2. **默认超时**：异步 120s、同步 30s（传输层实际默认 8s 由 `createAdapterClient` 决定）；
   `synchronousTimeoutMs` 透传给传输层会影响 state/version 等请求超时，需注意。
3. **传输层仍是 fetch SSE**：设计稿的裸 `node:http.request` ForkSseClient 尚未实现；`ForkClient`
   已留 `transport`/`transportFactory` 注入点，替换默认工厂即可，不影响本类语义。
4. **尚未接线**：Orchestrator 仍只用 `remote.mjs`；ForkClient 未驱动任务状态/UI。
5. **命令失败与 reject 的区分**：command-done 返回的业务失败会作为结果 resolve（不 reject）；
   只有传输/超时/session/disconnect 才 reject。上层需要按 `ok`/`status` 字段判断业务结果。

## 6. 提交状态

- 分支：`feat/fork-client`（stacked 在 PR #12 的 `feat/command-cache` 之上）；
- 发布物：`dist/dsh-fang-2.6.4.tgz` + `dist/manifest.json` + `dist/preflight.json` + `dist/allowlist.json`；
- npm/GitHub Release 未执行：等待 PR 合并与维护者确认；
- 未合并 main：本 PR 只推送分支与 PR，合并由维护者手动审核。
