# dsh-Fang v2.0.0 — 跨进程协议（母体 ↔ 分身 ↔ 容器）

> 适用：母体与每个分身是两个独立 DSH 进程，**不能共享 Cordis ctx / bus**。
> 控制面 = 分身自己的 HTTP 服务（复用启动时打印的 token），数据面 = 文件 + 按需拉取。

---

## 1. 拓扑与角色

```
母体 DSH（role=mother，DSH_FANG_ROLE 未设置）
   Orchestrator ── Forker ── RestartGuard ── Auditor(母) ── Scorer(母,复核) ── Approver(母,汇总) ── Router(母,初判)
        │ spawn（DSH_HOME 独立、端口池 18000–18100、node_modules junction）
        ▼
分身 DSH-Web（role=fork，DSH_FANG_ROLE=fork，DSH_FANG_TASK_ID=<taskId>）
   Adapter ── Scorer(主) ── Router(复核) ── Healer ── Approver(本地) ── HotReloader ── BufferKeeper ── Auditor(分身)
        │ 不可信插件 → container 路由（AppContainer + 写代理）
        ▼
容器 AppContainer（LowBox token；裸写 EPERM；申报写经 BufferKeeper 代理回宿主）
```

角色矩阵见 `docs/CONTRACTS-V2.md §1`；每个插件 apply 首行 `roleGate()`，未部署的角色不注册任何服务。

---

## 2. 握手

母体 `Orchestrator.createTask()` 在 `Forker.spawn()` 成功后：

```
轮询（adapterPollMs，上限 adapterTimeoutMs）：
  GET  {forkUrl}/fang/adapter/hello?token=…      ← forkUrl 带 token（parseWebUrl 解析自 spawn stdout）
  200 { ok:true, role:'fork', taskId, version, capabilities }
  → 任务状态 READY；超时 → RUNNING（degraded，不假装就绪）
```

失败语义：`adapter.ok=false` 且保留 `error`；后续 `promoteTask` 直接 fail-closed。

---

## 3. 端点（分身 Adapter 提供，母体 Remote 客户端调用）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/fang/adapter/hello` | 握手：role/taskId/version/capabilities |
| GET | `/fang/adapter/status` | 分身内服务表、buffer 三态、待审批数、审计头 |
| GET | `/fang/adapter/approvals` | 分身本地待审批项 |
| GET | `/fang/adapter/audit?limit=n` | 分身审计尾部（母体 aggregate 用） |
| POST | `/fang/adapter/command` | 控制命令（见下表） |

命令（`ADAPTER_OP`）：

| op | payload | 返回结果 |
|---|---|---|
| `ping` | — | `{ pong:true, at }` |
| `status` | — | 同 GET status |
| `flush-buffer` | `{strictMs?}` | `{ state:'settled'|'pending-high-risk', flushed:[] }` |
| `score-plugin` | `{pluginId}` | 分身 Scorer 的 Assessment（fork 阈值） |
| `read-plugin` | `{pluginId}` | `{ files:{relPath:text} }`（≤1MB/文件、≤2MB/总量、拒绝路径逃逸） |
| `route-confirm` | `{decision, pluginId?}` | Router.confirm（只升不降） |
| `approvals` | — | 待审批列表 |
| `approval-decide` | `{id,outcome,by?,note?}` | 决策结果 |
| `archive` | — | flush + 归档标记（进程 kill 由母体 Forker 执行） |

鉴权：复用 DSH 的 `?token=`（裸 URL 401）。Remote 客户端负责 `withToken()`；超时 5–8s；所有失败返回 `{ok:false, kind:'timeout'|'network'|'http'|'json', error}`，**不抛**。

---

## 4. 母体侧 Remote 客户端（`src/lib/remote.mjs`）

```js
const remote = createRemote({ url, token, timeoutMs: 8000 })
await remote.hello()            // {ok, data}
await remote.status()
await remote.audit({ limit: 200 })
await remote.command('read-plugin', { pluginId: 'plug' })
```

`createRemote` 是纯模块（可注入 `fetchImpl`），供编排器与未来商用模块复用。

---

## 5. 审计流

- 分身 Auditor 落盘 `<forkHome>/fang/<forkProfile>/audit.jsonl`（独立哈希链）；
- 母体通过 `audit` 命令按需拉取；
- 母体 Auditor `aggregate({limit, sources})` 汇总：本地记录 `taskId=null`，分身记录打 `taskId`，按 `at/seq` 排序；
- 任何审计写入失败不得阻塞任务生命周期（记录并继续）。

---

## 6. Router 时序（母体初判 → 分身复核，只升不降）

```
插件加载/提升请求
   │
   ▼ 母体
Router.decide({plugin, assessment: Scorer(母, quickScan + 母阈值)})
   ├─ deny      → 终止（不派生分身）
   ├─ container → 派生时标记容器路由
   └─ sandbox   → 派生时标记瓮城路由
   │
   ▼ 分身启动后
Router.confirm({decision, assessment: Scorer(分身, 完整评分)})
   route = max(母体决策, 分身复核)          # sandbox < container < deny
   deny 原样返回；分身永远不能降级路由
```

---

## 7. 容器通道（P5）

- 执行：`Router.runInContainer({code, declaredWrites})` → `src/lib/container/index.mjs` 的 `createContainerHost().exec()`；
- 写：容器内插件没有直接写权限；写请求 = NDJSON 帧 `{op:'write', path, data, reqId}`；
- 宿主 `BufferKeeper.proxyWrite(req)`：`validateWriteRequest()`（必须落在 bufferRoot 内 + 命中申报名单 + ≤maxBytes）→ kernel fsx 原子写 → 审计；
- 容器不可用（非 Windows / 无 PowerShell / 探测失败）→ `containerAvailable()={ok:false,state:'unavailable'|'disabled'}`，Router 对需要容器的插件返回 deny + 原因（fail-closed）。

---

## 8. 商用接入（v2 仅钩子）

`kernel/extensions.mjs`：`COMMERCIAL` 五项能力 + `invokeCommercial()`（永不抛）。
配置 `commercial.{collaboration,git,backup,tokenApi,teams}` 默认全 false；provider 服务 `fangCommercial` 缺失时一律 `{ok:false,error:'not-configured'}`，**核心闭环不依赖任何付费能力**。

---

## 9. v2.1.0 新增：会话目录与派生入口（母体侧）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/fang/api/sessions` | 母体已有会话（只读元数据：sessionId、workspace、updatedAt、bytes、archived/pinned、title） |
| GET | `/fang/api/sessions/item?sessionId=` | 单会话详情 |
| GET | `/fang/api/sessions/head?sessionId=` | 有界头读（≤256KiB 压缩 / ≤50 行 / ≤64KiB 文本，服务端脱敏） |
| POST | `/fang/api/derive` `{title?, sessionId?}` | 派生任务；带 sessionId → catalog.digest（≤32KiB markdown）→ 写入分身 `<forkHome>/fang-seeds/<seedId>.md` → createTask |

约束：
- 客户端只传不透明 `sessionId`，**永不传路径**；服务端自行索引（workspace.json + sessions 目录）。
- 会话目录只读；母体会话文件永不被写、不被挂载进分身（母体不可变）。
- seed 缺失/超限 → `derive` fail-closed（`session-catalog-unavailable` / `session-seed-failed`），不静默降级。
- 分身读取种子只读自己的 `<forkHome>/fang-seeds/`，与母体 `$DSH_HOME/sessions` 无关。
