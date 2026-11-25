# 端口生命周期与 Adapter / Forker 协同（v2.7.5）

> 代码：`src/plugins/forker.mjs`（唯一端口分配者）、`src/plugins/adapter.mjs`（复用 DSH webServer）。
> 相关契约：`docs/PROTOCOL-V3.md §1/§3`、`docs/ADAPTER-COMMANDS.md §1`。

## 0. 结论先行

**本仓库没有「第二个 Adapter 端口」。** Adapter 的 HTTP 路由挂在分身自己的 DSH webServer 上
（`ctx.inject(['webServer'])` → `webServer.register({kind:'exact', path, handler})`），
与 DSH 共用同一个端口。因此设计稿里的「Forker 分配两个端口 → 写 meta → env 注入 →
AdapterServer 独立 listen → 双端口 waitReady → 双端口归还」在这个仓库里**不成立也不需要**：
没有第二个监听者，就没有第二份端口生命周期需要协调。

这个决定在 v2.6.8 就写进了 `docs/ADAPTER-COMMANDS.md §1`：
> 本仓库的 DSH `webServer` 确实支持 `register({path, handler})`，Adapter 已复用分身端口
> （e2e 验证），不需要 Forker 再分配第二个端口；独立端口方案仅作为回退。

## 1. 设计稿七个问题 → 仓库现状

| 设计稿关注点 | 仓库现状 |
|---|---|
| ① Forker 分配两个端口 | 只分配**一个** DSH 端口（`pool.acquire()` 一次） |
| ② meta.json 写 `adapterPort` | `forks.json` / `fang-meta.json` 只有 `port`，没有 `adapterPort` |
| ③ env 注入 `DSH_ADAPTER_PORT` | 不注入；只注入 `DSH_ADAPTER_TOKEN`（v3 Bearer） |
| ④ AdapterServer 从 env 读端口 | 无 AdapterServer；Adapter 从未知 env 读端口，直接挂 webServer |
| ⑤ 端口池容量翻倍 | 不需要：每分身 1 个端口，池 18000–18100（101 个），`maxForks` 默认 8 |
| ⑥ 端口被抢窗口 / Adapter listen 失败 | 不存在第二监听者；DSH 端口被抢时 spawn 失败并归还 |
| ⑦ 双端口健康检查 | forker 探 DSH 端口；Adapter 就绪由 Orchestrator 在同端口做 `/fang/adapter/hello` 握手 |
| ⑧ 双端口归还路径 | 单端口归还路径见 §4（fork 失败/exit/timeout/stop/reap/死孤儿） |

## 2. 谁拥有端口

**Forker 是唯一分配者，其余组件是纯消费者。**

```
Forker.spawn()
  ├─ pool.acquire()            → port（18000–18100 中第一个可用）
  ├─ reservePort(port, forkId) → ports.json 记账（pid 写入后用于孤儿判断）
  ├─ rec.port = port
  ├─ env: DSH_HOME / DSH_FANG_ROLE / DSH_FANG_TASK_ID / DSH_ADAPTER_TOKEN
  └─ spawn(cli --profile ... --port <port> --no-open)
```

- 端口池容量：101 个端口 × 1 个/分身 = 101 并发；`maxForks` 默认 8，上限远小于容量。
- `allocatePorts=false` 时退回 v1 `--port 0`（OS 分配，从 banner 解析），仅兼容旧行为。
- Adapter 不感知端口：它拿的是 webServer 已绑定的同一端口。

## 3. 环境变量契约（实际在用）

| 变量 | 注入方 | 消费方 | 用途 |
|---|---|---|---|
| `DSH_HOME` | forker | DSH 自身 | 分身私有 home |
| `DSH_FANG_ROLE=fork` | forker | 内核 roleGate | 禁止分身调用母体服务 |
| `DSH_FANG_TASK_ID` | forker | Adapter/审计 | fork 身份 |
| `DSH_ADAPTER_TOKEN` | forker（每次 spawn 重新生成） | Adapter Bearer 校验；母体 `adapterToken(taskId)` | v3 认证，内存 only、不落盘 |
| ~~`DSH_ADAPTER_PORT`~~ | **不注入** | — | 不存在：Adapter 复用 DSH 端口 |

## 4. 端口归还路径（单端口）

| 路径 | 触发点 | 归还动作 |
|---|---|---|
| spawn 失败 | `spawn()` catch / 端口预留失败 / `port-mismatch` | `releaseReserved()` |
| spawn 被 dispose 取消 | `cleanup()` | `releaseReserved()` |
| spawn 超时 | `timer` → `stopRecord(rec)` | `stopRecord` 内 `releaseOwnedPort(rec.port)` |
| 子进程退出（崩溃/正常） | `child.once('exit')` | `releaseReserved()` |
| `stop()` | `stopRecord(rec)` | `releaseOwnedPort(rec.port)` |
| `reap()` | `stop()` + 删 home + 删记录 | 同上 |
| `recover()` 死孤儿 | `reconcileOrphans` → mark-crashed | `releaseOwnedPort(rec.port)` |
| `recover()` 活孤儿 | 进程仍在监听 | **不归还**（记录日志，由上层决策） |

活孤儿不归还是刻意的：新 Forker 实例没有该分身的 Adapter token（内存 only），即使接管也无法通信；
如果池分配恰好选中该端口，`isPortAvailable` 预检会跳过它（不会重复分配）。

## 5. 就绪判定（为什么不需要双端口 waitReady）

1. **Forker 层**：`spawn()` 等到子进程 stdout 出现带 token 的 URL、解析端口并与 `--port N` 比对
   （不一致 = `port-mismatch`），再探 HTTP 存活；超时/退出即失败并归还端口。
2. **Orchestrator 层**：`createTask()` spawn 成功后调用 `handshake(task)`——在同端口上
   `GET ${prefix}/adapter/hello`（带 Bearer）+ `GET ${prefix}/adapter/version` 协商协议，
   成功则 READY，超时则 RUNNING（adapter 未就绪，降级但不放弃）。
3. Adapter 的 `/fang/adapter/health`、`/state`、`/events`、`/commands` 全在同一端口，
   由 DSH webServer 承载；e2e 用真实 mother+fork 验证了这条链路。

因此「Adapter 起没起来」的判据是**握手**，不是第二个端口探活；把 Adapter 探活塞进 forker 的
`waitReady` 会让 forker 耦合 Adapter 协议，层次更差。

## 6. 如果未来真的要独立 Adapter 端口（回退方案清单）

必须同时改（缺一不可）：

1. `ForkMeta`/`forks.json`/`fang-meta.json` 增加 `adapterPort`，并保证 spawn 前写入；
2. `spawn()` 连续 `pool.acquire()` 两次，`ports[]` 累积，失败统一 release；
3. env 注入 `DSH_ADAPTER_PORT`；Adapter 侧解析并 `listen`，`EADDRINUSE` 打印
   `ADAPTER_LISTEN_FAILED` 标记；
4. `waitReady` 并行探两个端口（DSH + Adapter health 带 Bearer）；
5. 归还路径 ×2：spawn 失败/超时/exit/stop/reap/死孤儿；
6. `portPool` 容量按 `maxForks × 2` 重新规划（18000–18100 → 最多 50 分身）；
7. e2e 增加「Adapter 端口被抢 → spawn 失败 → 两端口都归还」用例。

当前不做的理由：DSH `webServer.register` 已可用（e2e 验证）；独立端口会引入
「acquire 后到 listen 前的被抢窗口」「第二个 listen 失败模式」「双份归还路径」三类新风险，
收益为零。

## 7. 边界

- **acquire 与 bind 之间的窗口**：端口预检（bind probe）通过后仍可能被系统进程抢走；
  此时 DSH 启动失败（无 banner/端口不一致），spawn 失败并归还端口。预检把概率降到很低，
  但不能为零；这是所有端口池方案的共性边界。
- **活孤儿端口**：不归还，靠 `isPortAvailable` 预检跳过；上层可 `kill` 后回收。
- **`--port 0` 兼容模式**：不写 ports.json，不归池；仅 v1 行为。
- 本仓库的 Adapter 端口从来不是「第二个端口」，所以设计稿的 `adapterPort` 字段在
  状态/文档中都不存在；新增该字段会被视为协议变更，需走 PROTOCOL 版本流程。
