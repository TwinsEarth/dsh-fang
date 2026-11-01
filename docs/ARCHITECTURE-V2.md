# dsh-Fang v2.0.0 — 架构（母体大脑 + 分身器官 + 容器兜底）

> v1.0.0 把分散插件收敛成「1 编排器 + 9 子插件」；v2.0.0 把它们按**三层拓扑**重新部署：
> 哪些插件在母体、哪些在分身、哪些事件必须跨进程、容器兜底在哪里。
> 跨进程细节见 [PROTOCOL-V2.md](PROTOCOL-V2.md)，接口契约见 [CONTRACTS-V2.md](CONTRACTS-V2.md)。

---

## 1. 三层边界（语义必须区分）

| 边界 | 机制 | 挡住什么 | 挡不住什么 |
|---|---|---|---|
| 母体 ↔ 分身 | 独立进程、独立 `$DSH_HOME`、独立端口（端口池 18000–18100） | 分身崩溃、事件循环耗尽、`process.exit()` | 同一用户权限下的读写 |
| 分身 ↔ 容器 | AppContainer LowBox token +（目标）Job Object | 插件进程内裸写（EPERM）、未申报网络、子进程逃逸 | 内核漏洞、容器内 DSH 自身被控 |
| 母体内部 | Cordis fiber + RestartGuard | 插件 fiber 崩溃隔离、未确认重启 | 宿主级崩溃 |

---

## 2. 部署矩阵（同一 bundle，运行时按角色激活）

| 插件 | 母体 | 分身 | 职责 |
|---|---|---|---|
| Orchestrator | ✅ | ❌ | 任务语义：create / status / promote / archive；调用 Forker |
| Forker | ✅ | ❌ | OS 机械层：端口池、spawn/kill、junction、URL 解析 |
| Scorer | ✅（复核/初判） | ✅（主评分） | 规则表共享，**阈值按环境分叉** |
| Router | ✅（初判） | ✅（二次确认） | 初判在派生之前；复核只升不降 |
| Healer | ❌ | ✅ | CI/证据/门禁/修复建议（不放行） |
| Approver | ✅（汇总） | ✅（本地） | 母体只批 promotion/restart；分身批任务内动作 |
| HotReloader | ❌ | ✅ | 真 ESM 换版 + 健康窗；失败回滚或 reap |
| RestartGuard | ✅ | ❌ | 母体重启唯一闸门 |
| BufferKeeper | ❌ | ✅（+容器写代理） | 三态监视 + 申报写代理 |
| Auditor | ✅ | ✅ | 两侧独立哈希链；母体 aggregate 汇总 |
| **Adapter** | ❌ | ✅ | 跨进程桥：HTTP 控制/状态/审计拉取（基础设施行） |

角色来源 `DSH_FANG_ROLE`（forker 注入 `fork`）> config.role > mother；每个插件 apply 首行 `roleGate()`，未部署角色**不注册任何服务**（kernel `role.mjs` 是唯一事实源）。

---

## 3. 任务生命周期（v2 语义）

```
POST /fang/api/tasks/create {title}
  Orchestrator.createTask()
    1. 配额与角色检查
    2. Forker.provision()：干净模板（base+web-app+bundle）→ 克隆 profile → node_modules junction
    3. Forker.spawn()：端口池分配 → --port <p> → env{DASH_FANG_ROLE=fork, DSH_FANG_TASK_ID}
    4. 解析 tokenized URL；probeWebUrl 健康探测
    5. Adapter 握手（轮询 hello，上限 adapterTimeoutMs）
        成功 → TASK_STATUS.READY；超时 → RUNNING（degraded，并在 UI/status 显示 adapter 未就绪）
    6. 审计 fork-created/fork-started/adapter-handshake；bus 'fang/task-created'
  → {taskId, url, port, adapter:{ok,version}}

GET /fang/api/tasks/status?taskId=
  Orchestrator.getTaskStatus() → 本地注册表 + 分身 Adapter.status()（服务表/缓冲/待批/审计头）

POST /fang/api/tasks/promote {taskId, pluginId}
  1. Adapter read-plugin（跨进程取源码，路径逃逸拒绝）
  2. Adapter score-plugin（分身阈值评分，供对照）
  3. 母体 Scorer 用 **mother 阈值**复核（同源不同策略，报告标注 basis）
  4. 母体 Router.decide()：非 sandbox 拒绝（container/deny fail-closed）
  5. 团队权限钩子（无 provider 放行并记录 basis）
  6. Approver.requestPromotion（risk=red，严格红灯）
  7. A/B 快照 → 写母体 staging → 审计 promote-committed（可选云备份钩子）

POST /fang/api/tasks/archive {taskId}
  1. Adapter archive（flush 缓冲 + 落审计）
  2. Forker.reap（kill 进程树 + 安全删除 home：junction 只解链）
  3. 审计 task-archived；bus 'fang/task-archived'
```

---

## 4. Router 时序（最容易做错的部分）

`decide` 在母体、`confirm` 在分身；**只升不降**：

```
母体 decide → sandbox | container | deny
分身 confirm → max(母体决策, 复核建议)，deny 原样返回
```

- 母体用 `quickScan`（静态、不依赖分身），保证路由在派生之前可判；
- 分身只能升级（sandbox→container→deny），防止"分身被插件影响后放宽路由"；
- `deny` 在母体终止，不浪费一次派生。

---

## 5. 评分的环境分叉

`Scorer` 规则表只有一份，阈值按 `basis.environment` 取：

| 环境 | A | B | C | D | 备注 |
|---|---|---|---|---|---|
| mother | ≤20 | ≤40 | ≤60 | ≤80 | 与 v1 完全一致；用于**提升到生产** |
| fork | ≤25 | ≤45 | ≤65 | ≤85 | 更宽；分身崩溃不危及母体 |

每个 Assessment 带 `basis:{environment, thresholds, note:'本评分基于 <env> 阈值'}`，
杜绝"同一插件两边评分不一致却不解释"。

---

## 6. 容器兜底（P5）

- `Router.runInContainer()` 懒加载 `src/lib/container`；AppContainer 不可用 → `state='unavailable'`，路由 deny + 原因；
- 容器内插件**没有直接写权限**；写请求走 NDJSON 帧 → `BufferKeeper.proxyWrite()`：
  `validateWriteRequest`（bufferRoot 内 + 申报 allowlist 前缀 + ≤maxBytes + 拒绝 `..`/绝对路径/UNC）→ kernel fsx 原子写 → 审计；
- 真实探针用 `FANG_CONTAINER_LIVE=1` 手动跑；默认测试只验证降级路径（诚实标注 NOT ESTABLISHED）。

---

## 7. 商用接入点（本期只有钩子）

| 能力 | 接入点 | 无 provider 时 |
|---|---|---|
| collaboration | `createTask({collaborators})` | 跳过，任务照常 |
| git | BufferKeeper flush settled | 跳过 |
| backup | promote/archive | `{ok:false,error:'not-configured'}`，不阻塞 |
| tokenApi | 独立模块（不在 11 行内） | — |
| teams | promote 前 `teams.check()` | 放行并记录 `basis.commercial:false` |

---

## 8. v2.0.0 交付边界（诚实清单）

已实现：11 行装载与角色矩阵、Adapter+Remote 跨进程协议、任务 create/status/promote/archive、端口池、干净模板、
Router 初判/复核（只升不降）、Scorer 环境阈值与 basis、Auditor 汇总、Approver 双侧语义、
容器执行器与申报写代理（probe 拷贝 + 纯逻辑测试）、商用钩子、e2e 实机脚本。

未实现 / NOT ESTABLISHED：
- AppContainer **真实执行**需 `FANG_CONTAINER_LIVE=1` 手动探针；CI 只覆盖降级路径；
- Job Object 层（`KILL_ON_JOB_CLOSE`）未接入，容器进程仍由 PowerShell 探针单独管理；
- 分身会话迁移/跨宿主接管未做；
- 商用五项只有钩子与配置开关，无 Relay 实现；
- v1 运行中的宿主仍缓存旧模块，v2 生效需母体重启（红线：由用户确认执行）。
