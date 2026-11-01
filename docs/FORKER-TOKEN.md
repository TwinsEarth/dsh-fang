# Forker token 生命周期与 TokenRegistry（v2.7.2）

> 代码：`src/plugins/forker.mjs`；测试：`test/forker.test.mjs`（26 项）。
> 说明：本仓库是纯 `.mjs` + JSDoc，**没有 `fork/Forker.ts`**；设计稿里的 TS 形状
> 在仓库里一一对应，映射见 §3。

## 1. 现状（v2.6.1 起已实现）

设计稿要的 token 生命周期，仓库在 v2.6.1 就已经以「fork record 上的一个字段」实现，
不需要单独的 `TokenRegistry` 类：

| 设计稿 | 仓库已有实现 |
|---|---|
| `TokenRegistry.create`（fork 时生成） | `spawn()` 里 `rec.adapterToken = randomBytes(24).toString('hex')`（每次 spawn 都重新生成） |
| `TokenRegistry.refresh`（restart 时刷新） | `restartFork(rec)` → 再次 `spawn()` → 新 `adapterToken` |
| `TokenRegistry.delete`（kill/recycle 清理） | `stopRecord()` 里 `rec.adapterToken = null`；`reap()` 走 `stop()` |
| `TokenRegistry.get` | `forker.adapterToken(forkId)` |
| token 不落盘 | `publicFork()` 不含 `adapterToken`，`forks.json`/`status()`/`list()`/`fang-meta.json` 都不泄漏 |
| token 注入子进程 | `spawn()` env 里 `DSH_ADAPTER_TOKEN: rec.adapterToken` |
| 孤儿处理 | `recover()` 用 `reconcileOrphans` + `isPidAlive`：活着的孤儿不接管（token 无法恢复）、死掉的标记 crashed 并释放端口 |

测试 `test/forker.test.mjs` 第 1144 行「v3: adapterToken 每次 spawn 重新生成、只存内存、
经 env 注入分身、stop 后作废」已经把上述全部覆盖。

## 2. v2.7.2 新增：显式 TokenRegistry 公开面

为了与设计稿的 `TokenRegistry` 公开 API 对齐，forker 现在额外暴露：

```js
const forker = ctx.get('fangForker')   // 分身内无此 service（mother-only）

forker.getToken(taskId)                // === adapterToken(taskId)，别名
const off = forker.onTokenRefresh((taskId, token) => {
  // 每次 spawn 重新生成/刷新 token 时触发；首次派生（生成）与重启（刷新）都会触发
})
off()                                  // 停止订阅
```

语义要点：

- **每次 `spawn()` 都广播**：首次派生 = token 生成，崩溃重启 = token 刷新；
  订阅者拿到的是「当前 token」，**不是**「进程就绪」信号（进程就绪仍以
  `fang/fork-started` 总线事件为准）。
- **handler 异常隔离**：某个订阅者抛错不影响其它订阅者，也不影响 spawn 流程；
- **disposer**：返回的 `off()` 幂等；
- **不推进状态**：和设计稿 §六.1 一致——token 刷新发生在 spawn 早期，早于进程就绪；
  `TaskHandle` 重连仍轮询 `forker.status()`，token 只在新连接建立时重新读
  `forker.adapterToken(taskId)`。

## 3. TS 形状映射

| 设计稿（TS） | 本仓库（`.mjs`） |
|---|---|
| `fork/Forker.ts` 类 | `src/plugins/forker.mjs` 的 `apply()` 闭包 + `service` 对象 |
| `PortPool` 类 | `allocatePort/releasePort/ownedPorts/ports.json` |
| `ensureJunction` / `copyPatch` | `ensureTemplate`（clean-template 模式）/ `provision` 的 v1 克隆路径 |
| `readMeta/writeMeta` | `writeForkMetaOf(rec)`（`fang-meta.json`）+ `forks.json` 持久化 |
| `computeBackoff` | `planRestart`（`maxRestarts/backoffBaseMs/backoffMaxMs/jitter`） |
| `TokenRegistry` 类 | `rec.adapterToken` + `adapterToken()` / 新增 `getToken()` / `onTokenRefresh()` |
| `ForkMeta.adapterPort`（独立 Adapter 端口） | **不实现**：Adapter 复用 DSH `webServer`（见 `docs/ADAPTER-COMMANDS.md §1`），forker 仍只分配**一个** DSH 端口 |
| `spawnChild(..., token)` | `spawn({ forkId, homeDir, profile, cliPath, env })`，token 由 spawn 内部生成并注入 |

## 4. 边界

- **token 是内存 only**：母体重启后旧 token 自然失效；活着的孤儿分身无法被新母体接管
  （拿不到 token），只能由上层决策 kill 重建。
- **广播 ≠ 就绪**：`onTokenRefresh` 只能用来刷新「已知 token」，不能当作重连触发点。
- **单端口**：仓库不采用设计稿的 `adapterPort` 双端口方案；如需双端口，需同时改
  port pool、`forks.json`/`fang-meta.json` schema、`buildSpawnArgs`、e2e，是一项独立改动。
