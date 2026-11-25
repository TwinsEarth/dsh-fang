# 审计报告 · dsh-Fang v2.7.2（Forker token 公开面 / TokenRegistry 对齐）

> 证据来自本机真实门禁输出（2026-11-01，Windows / Node 24.16.0）。
> 报告不含凭据、不含本机绝对路径（allow-list 同时扫描这两类内容）。
> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 2 个补丁位（`2.7.1` → `2.7.2`）。

## 1. 背景与诚实结论

设计稿要求「把 TokenRegistry 集成进 `Forker.ts`」。本仓库是纯 `.mjs`，**没有
`Forker.ts`**；且 token 生命周期自 v2.6.1 起已在 `src/plugins/forker.mjs` 内联实现：

- 每次 `spawn()` 用 `randomBytes(24)` 重新生成 `rec.adapterToken`（首次派生 = 生成、
  崩溃重启 = 刷新）；
- `stop()` / `reap()` 走 `stopRecord()` 把 token 置空（作废）；
- token 只存内存 + 子进程 env（`DSH_ADAPTER_TOKEN`），不落 `forks.json`/`fang-meta.json`/
  `status()`/`list()`；
- 孤儿恢复：活着的孤儿不接管（token 无法恢复）、死掉的标记 crashed 并释放端口。

因此本版本不是「从零实现」，而是补齐设计稿 `TokenRegistry` 的**公开 API** 并对齐命名。

## 2. 变更

- `forker.getToken(forkId)`：`adapterToken(forkId)` 的别名；
- `forker.onTokenRefresh(handler) → disposer`：每次 `spawn()` 重新生成/刷新 token 时广播
  `(forkId, token)`；首次派生与重启都触发；handler 异常隔离；disposer 幂等；
- 语义明确：该广播表示「当前 token」，**不是**「进程就绪」信号（进程就绪仍以
  `fang/fork-started` 为准；TaskHandle 重连仍轮询 `status()`，连接建立时重读 `adapterToken()`）。
- 文档 `docs/FORKER-TOKEN.md`：现状、公开面、TS 形状映射、边界。

## 3. 门禁结果

| 门禁 | 命令 | 结果 |
|---|---|---|
| 版本一致性 | `node tools/release/preflight.mjs --e2e` | **GREEN 2.7.2** |
| Client 半可解析 | 同上 | `node --check client.js` **green** |
| 单元/集成测试 | 同上（内嵌全量） | **403 pass / 0 fail / 1 skip（404 项，24.1s）** |
| e2e 实机验收 | 同上 | **57/57（15.7s）** |
| allow-list + 秘密/本机路径扫描 | `node tools/release/allowlist.mjs --with-manifest` | **PASS**：36 路由、0 findings、146 文件扫描、包内 69 文件 allow-listed |
| 构建 | `node tools/release/build.mjs` | `dist/dsh-fang-2.7.2.tgz`（**247,349 B，85 entries**）<br>sha256 `558b0cae93dc57fbefd2c750a5c6d779ec32833b13af3afc65ff53514bac30cb` |
| 产物健康检查 | `node tools/release/healthz.mjs` | **HEALTHY** `@twinsearth/dsh-fang@2.7.2`（15 个模块可 import） |

## 4. 新增测试（`test/forker.test.mjs`，26 项）

新增「v3: onTokenRefresh 广播每次 spawn 的 token；getToken 是 adapterToken 的别名；
异常隔离 + disposer」：首次派生广播生成、重启广播刷新且 token 不同、`getToken===adapterToken`、
订阅器抛错不影响其它订阅者与 spawn、disposer 后不再广播。
既有「adapterToken 生命周期」测试保持不变。

测试计数：403（v2.7.1）+ 1 = **404 项**（403 pass / 1 skip），与 preflight 输出一致。

## 5. 与设计稿的差异（诚实记录）

| 设计稿（TS） | 本仓库（`.mjs`） |
|---|---|
| `fork/Forker.ts` 类 | `src/plugins/forker.mjs` 闭包 + `service` 对象 |
| `TokenRegistry` 独立类 | `rec.adapterToken` 内联 + `adapterToken/getToken/onTokenRefresh` |
| `spawnChild(..., token)` 参数注入 | `spawn()` 内部生成 token 并注入 env（调用方不传 token） |
| `ForkMeta.adapterPort`（独立 Adapter 端口） | **不实现**：Adapter 复用 DSH `webServer`，forker 仍只分配一个端口 |
| `TokenRegistry.refresh` 只广播、`create` 不广播 | 仓库 `spawn()` 统一，广播在**每次 spawn** 触发（生成 + 刷新都广播，语义更简单且不误作就绪信号） |

## 6. 边界

- token 是内存 only：母体重启后旧 token 自然失效；活着的孤儿分身无法被新母体接管。
- `onTokenRefresh` 只用于「已知 token」刷新，不能当作重连触发点。
- 若未来要采用设计稿的独立 `adapterPort` 双端口，需同步改 port pool、持久化 schema、
  `buildSpawnArgs` 与 e2e，是独立改动。

## 7. 提交状态

- 分支：`feat/forker-token-registry`（stacked 在 PR #20 的 `feat/archive-ui` 之上）；
- 发布物：`dist/dsh-fang-2.7.2.tgz` + `dist/manifest.json` + `dist/preflight.json` + `dist/allowlist.json`；
- npm/GitHub Release 未执行：等待 PR 合并与维护者确认；
- 未合并 main：本 PR 只推送分支与 PR，合并由维护者手动审核。
