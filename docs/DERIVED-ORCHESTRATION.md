# 三层编排架构重审（v2）：母体四角色 · 安全盘 · 生产盘

> **评审对象**：dsh-fang 三层模型（母体 / 原身 / 分身）。
> **代码基线**：`package.json` v3.0.4（CHANGELOG 顶格 v3.0.4）。**注意**：v1 本文标题写的是 v3.0.9，但仓库版本是 3.0.4——v3.0.9 是目标态，不是已交付态。下文一切"现状"以代码为准，"目标"以细化后的规则为准，两者不一致处逐条标出。
> **评审材料**：`src/lib/{essence,mirror,fork-supervisor,permissions,session-format}.mjs`、`src/plugins/{forker,orchestrator}.mjs`、`src/kernel/paths.mjs`、`docs/DATA-RELIABILITY.md`（I1–I9）、v1 本文的 D-01…D-16。
> **本文取代 v1 的结论**；v1 的 ADR 编号保留映射见附录 A。只给契约与判据，**不粘贴源码**。

---

## 0 重审结论

细化后的规则改了两件本质的事：**母体从"一个实例"变成"四个角色"**，**分身与会话从"≤N"变成"1:1"**。前者把"双主窗口"从崩溃瞬间扩展成常态；后者把"单会话"从计数约束变成结构约束。按"会不会悄悄坏掉"排序：

| # | 结论 | 一句话后果 | 证据 / 缺口 | 修的成本 |
|---|---|---|---|---|
| **V-1** | 规则与代码的第一处**硬冲突**：会话额度应为恒定 10 | vip30/50/100 用户能开 30/50/100 个活跃会话；`test/essence.test.mjs:185-186` 还把这个错误写成了断言 | `VIP_QUOTAS.maxActiveSessions = 10/10/30/50/100`（`essence.mjs:46-52`） | 低（改表 + 改测试），但**必须最先做**：后面所有准入都建在这个额度上 |
| **V-2** | 1:1 没有任何**绑定字段**，所以"单会话"仍是文案 | 分身里能开出第二个会话；URL 就是绕过口 | 无 `conversationId` 字段；`permissions.mjs` 生产代码零调用点（只有 `test/permissions.test.mjs`）；`derived.openSessions=true` 是"允许"，不是"至多一个" | 中（绑定 + 命令门 + 租约） |
| **V-3** | 母体四角色让 fencing 键从 `epoch` 变成 `(motherId, dataEpoch, epoch)` | 克隆母体被提升后，旧主母体下的分身仍能写 → 两个真相 | `mirror.mjs` 只有单根 `active/ + backup/`，无角色、无主锁、无 `dataEpoch`；`fork-supervisor` 的 reconcile 只 `mark-crashed` | 中高（新模块） |
| **V-4** | "6/12/24h 同步"与现有"6/12/24h 备份"数字相同、语义不同 | 实现者会把备份当同步，做出"备份升级为可写主"的假接管 | `mirror.mjs:296-307` 的 `setBackupInterval` 只接受 6/12/24，但产物是 `backup/<id>` 快照，不是常驻副本 | 中（新增 sync 账本 + 水位） |
| **V-5** | "配置每次从原身重置"仍然**没有代码路径** | 原身装的插件，分身里没有；重启沿用旧配置 | `forker.provision` 的克隆源是 `<home>/templates/<tag>`（`forker.mjs:688-732`）；`restartFork` 直接 `spawn`，不重跑 `provision`（`forker.mjs:1170-1185`） | 中（D-01/D-08，v1 已设计未实现） |
| **V-6** | `reap` 直接删 home，而会话就在 home 里 → **回收 = 删生产数据** | 与"生产数据持久"正面冲突；崩溃后清理现场会删掉唯一证据 | `forker.reap` = stop + `removeTree(homeDir)`（`forker.mjs:1114-1126`）；`DSH_HOME=homeDir`（`forker.mjs:917-926`），会话根 = `$DSH_HOME/sessions`（`paths.mjs:115-126`） | 中（两阶段回收，v1 D-16） |
| **V-7** | 分支切换**不是 O(1)**，v1 的结论要撤回 | 按 O(1) 排期会做出"切换时用户丢一段对话"的实现 | 会话是单文件多帧 zstd（`session-format.mjs:9-16`）；Windows 上子进程持有句柄时无法原子换文件 | 中（切换 = 停进程 + 换文件 + 重启） |
| **V-8** | 配额仍有三处真相；四角色又新增"同步水位"这第四个计数 | 分身=单会话时，"活跃会话数"必然漂移；克隆母体的"跟到哪了"没人记账 | `essence.list().length` 扫描（`essence.mjs:483-497`）、`forker.maxForks` 内存计数（`forker.mjs:811-812`）、`createTask` 再数一遍（`orchestrator.mjs:383-391`） | 中（单账本三视图 + syncCursor） |

**总判断**：分层仍然是对的，且比 v1 时更清楚——母体的四角色其实对应四个**数据可靠性档位**（零丢失 / RPO=间隔 / RPO=滞后 / 无数据），原身的"安全盘"对应"只改配置不跑生产"，分身的"生产盘"对应"只跑不存配置"。但**层间契约依旧为空**：配置源、会话绑定、回收语义三件事一件都没落地，而四角色又在契约之上加了一层"谁有权写"。正确地顺序是：**先把 1:1 与额度对齐（小而硬），再补配置源与两阶段回收（止血），然后才是四角色与同步（放大能力）**。反过来做等于把数据丢失做成高可用。

---

## 1 规则增量与不变量

### 1.1 四条规则变更（相对 v1 的假设）

| 编号 | 细化后的规则 | 相对 v1 的增量 | 直接冲突点 |
|---|---|---|---|
| **R1** | 母体 = 唯一主母体 + 备份母体 + 克隆母体 + 空白母体（6/12/24h 同步） | v1 把母体当单实例，`epoch` 只服务"崩溃重启窗口" | 无任何角色/主锁/同步实现；`epoch` 语义不够 |
| **R2** | 原身 = 安全盘：可插件 / 可设置 / 可账号，**不跑生产** | v1 已假设 `essence.openSessions=false`（与 `permissions.mjs:20-24` 一致） | "账号"落在 `overlay/credentials`，没有任何同步/隔离/短时凭证契约；`materializeMerged` 会把它整目录复制进 `merged`，再复制进分身 |
| **R3** | 子原身 VIP 5/10/30/50/100；**单原身活跃会话 ≤10** | 会话额度与 tier 解耦 | `maxActiveSessions` 随 tier 放大到 30/50/100；测试断言了错误行为 |
| **R4** | 分身 = 生产盘：配置每次从原身重置、生产数据持久、**与单个会话 1:1**、同一分身同一会话可派生多分支 | "≤10"→"1:1"；新增"多分支" | 无绑定字段、无分支模型、`reap` 删数据 |

### 1.2 三个必须先解决的命名冲突

规则用词在仓库里各有既存含义，不先拆开，实现者一定会对错的那个：

1. **"克隆"**：`forker` 的 `cleanTemplate` 就是"克隆模板"（`forker.mjs:680-732`），规则里的"克隆母体"是另一件事。→ 规范名：`cloneTemplate`（分身配置模板）vs `replicaMother`（克隆母体）。
2. **"备份"**：`mirror` 的 `backup/<id>` 是**产物**（快照目录）；规则里的"备份母体"是**角色**（冷备节点）。→ 规范名：`mirrorBackup`（产物）vs `standbyMother`（备份母体）。
3. **"session"**：产品会话、adapter 连接世代、编排器任务三者同名。v1 已提出拆词，**本次升级为强制**：`conversationId`（产品会话）/ `linkEpoch`（adapter 连接）/ `derivedId`（分身）。

### 1.3 不变量（替代 v1 的 J1–J3，扩充到 J1–J6）

| 编号 | 不变量 | 判据 |
|---|---|---|
| **J1** | 写会话必须先持有该 `conversationId` 的租约，且写入方 `(motherId, dataEpoch, epoch)` 等于权威值 | 租约 mismatch → 拒绝并记 `stale-writer`，**不做"最后写入者胜"** |
| **J2** | 1:1 是**结构**约束：一个分身至多绑定一个 `conversationId`，绑定写一次、不可改 | `DERIVED.json` 的 `conversationId` 只允许从 `null` 变成值，永不变更 |
| **J3** | 分身状态由事件流派生，`forks.json` / `tasks.json` 只是缓存 | 冲突时以事件流为准并告警 |
| **J4** | 无 `SEALED` 标记的 seal 目录不存在；无 `forfeit` 记录的未 seal home 不得删除 | 删除前必须存在 seal 或 forfeit |
| **J5** | 配额是**单账本三视图**；分身并发是**另一个资源**，不得与"活跃会话数"共用计数 | 三个投影相加不自洽即为 bug；并发上限变化不得改变会话额度 |
| **J6** | 每个 `dataRoot` 至多一个 `primary`；同步单向（primary → standby/replica）；replica 永不可写 | 主锁 `(motherId, bootId)` + 心跳；发现第二个 primary 即停写并告警 |

---

## 2 对象模型

### 2.1 实体

| 实体 | 关键字段 | 所有者 | 生命周期 | 真相来源 |
|---|---|---|---|---|
| `MotherNode` | `motherId, role: primary / standby / replica / blank, dataRoot, dataEpoch, configGeneration, state, syncCursor` | 母体层 | 长（角色可变，身份不变） | `<dataRoot>/MOTHER.json` + 主锁 |
| `MirrorGeneration` | `generationId, version, manifestDigest, state` | 母体层 | 不可变，被 supersede | 镜像 state 双槽（DATA-RELIABILITY §3） |
| `SyncRun` | `syncId, fromMotherId, toMotherId, cadence: 6 / 12 / 24, fromCursor, toCursor, manifestDigest, state` | 母体层 | 一次同步 | `sync/index.jsonl`（只追加） |
| `Essence` | `essenceId, kind: root / sub / official, parentId, tier, state, locked, overlayDigest, mergedDigest` | 原身层 | 长 | `ESSENCE.json` |
| `DerivedInstance` | `derivedId, essenceId, configGeneration, configDigest, depsDigest, conversationId?, dataEpoch, epoch, instanceLeaseId, status, port, pid, restartCount` | 母体 supervisor | 分钟~小时（数据不受此限） | 事件流（`forks.json` 缓存） |
| `Conversation` | `conversationId, essenceId, boundDerivedId, activeBranchId, headSeq, state` | 会话层 | 长（跨分身、跨重启） | `SESSIONS.jsonl` 账本 + 绑定字段 |
| `Branch` | `branchId, conversationId, baseSeq, headSeq, state, writerLeaseId, stashPath` | 会话层 | 中 | `branches.json`（分身私有） |
| `SessionLease` | `leaseId, conversationId, derivedId, motherId, dataEpoch, epoch, expiresAt, heartbeatAt` | 母体 | 秒~分 | `quota/leases.jsonl` |
| `InstanceLease` | `leaseId, derivedId, essenceId, port, pid, expiresAt` | 母体 | 秒~分 | `quota/leases.jsonl`（与上者同账本、不同 `kind`） |
| `Seal` | `sealId, derivedId, essenceId, configGeneration, configDigest, conversations[], manifestDigest` | 分身产出 | 长（只读） | 目录 + `SEALED` |
| `Reflow` | `reflowId, sealId, targetEssenceId, mode, state, provenance` | 原身层 | 长 | `imports/<reflowId>/` + 账本行 |

### 2.2 关系

```text
MotherNode(primary) 1 ── 1 dataRoot ──< Essence          # 只有 primary 能写
MotherNode(standby|replica) ──(单向同步)──> 自己的 dataRoot 副本
MirrorGeneration 1 ──< Essence(merged 派生自某代)         # 代际：只读引用
Essence(root) 1 ──< Essence(sub, 至多 1 级, 5/10/30/50/100 个)
Essence 1 ──< DerivedInstance (0..N 并发)                 # 分身不是节点
DerivedInstance 0..1 ── 1 Conversation                    # J2：绑定写一次
Conversation 1 ──< Branch (1..K, K=3)                     # 同时至多 1 个 writer
DerivedInstance 1 ── 0..1 Seal ── 0..1 Reflow ── 1 Essence
```

**两处有意反规范化**：

- `DerivedInstance.configDigest` 冗余保存"当时跑的是哪份配置"——这是**审计锚点**，不是缓存；原身之后改 100 次也必须答得出来。
- `DerivedInstance.dataEpoch` 与 `configGeneration` 分开记：**数据版本与配置版本会分叉**（克隆母体可能"新数据 + 旧配置"），这是第 8 章提升判据的基础。

### 2.3 目录布局（在 DATA-RELIABILITY §3 之上）

```text
<dataRoot>/                             # 一个 MotherNode 一个根，禁止用 junction 把两个根接起来
├── MOTHER.json                          # motherId / role / dataEpoch / configGeneration / createdAt
├── primary.lock                          # 主锁：{motherId, host, bootId, pid, heartbeatAt}，崩溃可破
├── mirror/…                              # 镜像代 + backups（沿用 DATA-RELIABILITY）
├── essences/<essenceId>/…                # 安全盘：overlay / merged / ESSENCE.json
├── sessions/<essenceId>/…                # 会话账本（跨分身长存）
├── quota/{counters.a|b.json, leases.jsonl}
│
├── sync/                                 # 同步（本机若无角色则不存在）
│   ├── index.jsonl                       # SyncRun 只追加账本（seq + crc）
│   └── cursor.json                       # 对端可消费到的水位
│
└── derived/
    ├── requests.jsonl                    # 派生幂等表（requestId → derivedId）
    ├── admission.jsonl                   # 准入决策流水（admit / queue / reject + 原因）
    ├── deps/<depsDigest>/                # 只读依赖树（按 digest 共享）
    └── <derivedId>/
        ├── DERIVED.json                  # 身份 + 绑定 + digest + epoch（含 conversationId）
        ├── profile/                      # 每次 spawn 重建（可再生）
        ├── runtime/                      # DSH 缓存/lock（与 profile 分离，避免污染 digest）
        ├── fang/branches/<conversationId>/<branchId>/   # 分支暂存（DSH 不扫描此路径）
        ├── sessions/                     # 生产数据（唯一不可再生的部分）
        ├── seals/<sealId>/
        └── logs/stdout.log
```

**三条布局铁律**：① `profile/` 与 `sessions/` 必须分离，前者可删后者不可；② 分支暂存放 `fang/branches/`（在 `$DSH_HOME/sessions` 之外），否则 DSH 的 `workspace.json` 会把分支当成第二个会话；③ 两个母体根之间**禁止**软链/硬链/junction，否则 replica 的写会直接落进 primary。

### 2.4 配额归属（谁拥有哪个计数）

| 计数 | 归属 | 上限 | 占位时机 | 释放时机 |
|---|---|---|---|---|
| 顶层原身数 | principal（本地单用户可退化为机器 id） | 5/10/30/50/100（沿用，待确认 Q-1） | `create` reserve | 删除 tombstone |
| 子原身数 | **根原身**（每个根独立） | 5/10/30/50/100 | `create` reserve | 删除 tombstone |
| 活跃会话数 | **原身**（root 与 sub 都算） | **恒定 10** | `bindConversation` 授予租约 | `archive` 改账本状态 |
| 分身并发 | 主机（全局） | `maxForks`（默认 8） | `RESERVED` | `DISPOSED` |
| 同步水位 | 母体对（from → to） | 无（是水位不是额度） | 每次 SyncRun | 不回收 |

**关键判断**：会话额度（≤10/原身）与分身并发（≤8/全局）是**两个资源**，不能互相代替。1:1 之下，"10 个会话额度 + 8 个分身"意味着**最多 2 个会话可以处于 DETACHED（无进程）**。这条必须写进产品文案，否则用户会认为"额度是假的"。

---

## 3 生命周期状态机

### 3.1 母体节点（新增）

```text
BLANK ──provision──> CANDIDATE ──seed/同步完成──> PRIMARY
                        │                            │
                        │                            ├─(失联/故障)─> DEGRADED ──恢复──> PRIMARY
                        │                            └─(被接管)────> DEMOTED（只读）
                        │
                        └──跟随──> REPLICA（热备，只读跟随）──promote──> PRIMARY
STANDBY（冷备，无进程，只有 SEALED 快照）──restore──> PRIMARY（数据回滚）
```

| 转移 | 条件 | 副作用 | 禁止 |
|---|---|---|---|
| `BLANK → CANDIDATE` | 目标 `dataRoot` 为空或已声明为新建 | 写 `MOTHER.json(role=blank)`、生成 `motherId` | 指向非空 `dataRoot`（会变成第二个真相） |
| `CANDIDATE → PRIMARY` | 主锁获取成功（`primary.lock` 心跳） | `dataEpoch+1`、写审计 `mother.promoted` | 未拿锁就写任何东西 |
| `REPLICA → PRIMARY` | 主锁 + 原 primary 心跳超时 ≥2 个周期 + **代际兼容检查**（见 8.5） | `dataEpoch+1`；所有旧分身判 stale | 主还活着就接管（split-brain） |
| `PRIMARY → DEMOTED` | 检测到自己不是锁持有者 | 立即停写、停 spawn、保留 home | 继续派发租约 |
| `STANDBY → PRIMARY` | 显式 rollback 指令 | 恢复到快照代、`dataEpoch+1`、审计 `mother.rollback` | 自动切换（数据回退必须人工确认） |

### 3.2 原身（安全盘）

`creating / ready / conflicted / stale / tombstoned`。只新增两条与分身/限额相关的门：

- `conflicted` + `strictConflictMode` → **拒绝派生**；
- 存在 `RESERVED/READY/ACTIVE/CRASHED(未隔离)` 的分身或**未归档的活跃会话** → **拒绝删除原身**（今天 `essence.remove` 只查子原身，`essence.mjs:566-575`）。

### 3.3 分身（生产盘）

```text
REQUESTED → RESERVED → MATERIALIZING → SPAWNING → HANDSHAKING → READY ⇄ ACTIVE
                │            │            │            │           │
                │            │            │            │           ├→ QUIESCING → SEALING → SEALED → REFLOWING → DISPOSED
                │            │            │            │           │                  └→ DISPOSED(forfeit)
                │            │            │            └→ FAILED_SPAWN（不重试）
                │            │            └→ FAILED_MATERIALIZE（原身侧问题）
                │            └→ 租约到期回收（无实体）
                └→ 配额拒绝 / 排队（终态或等待）

READY/ACTIVE ──(容量压力/空闲)──> DETACHED（进程回收，会话与绑定保留）
DETACHED ──(用户继续/准入通过)──> SPAWNING（同一 derivedId、同一 conversationId、epoch+1）
NEW: EVICTED = DETACHED 的一种原因（准入驱逐），不是新状态
```

| 转移 | 条件 | 副作用 | 禁止 |
|---|---|---|---|
| `RESERVED → MATERIALIZING` | 实例租约 + **会话租约**都已授予 | 写 `DERIVED.json` 骨架（`conversationId` 已定） | 未拿会话租约就物化（会白拷贝） |
| `MATERIALIZING → SPAWNING` | `configDigest` 校验通过（源 = `<essence>/merged/profile`） | 原子替换 `profile/` | digest 不符仍启动 |
| `SPAWNING → HANDSHAKING` | 打印 URL 可解析且端口 == 分配端口 | 无 | 端口不匹配仍继续（`forker.mjs:958-962` 已有此判据，须保留） |
| `HANDSHAKING → READY` | adapter `hello` + 租约携带 `(motherId, dataEpoch, epoch)` 校验通过 | 心跳起点 | 握手失败标 ready |
| `READY → ACTIVE` | 发起 turn | 每 turn 一个 span；**同 conversation 串行** | 两个 turn 并发写同一 branch |
| `ACTIVE → QUIESCING` | 归档 / 切换分支 / 回收 | 终止在途 turn、flush、写 `turn.interrupted`（如需要） | 直接 kill（丢最后一段消息） |
| `QUIESCING → SEALING` | flush 完成 | 生成 manifest | 未 flush 就 seal |
| `READY/ACTIVE → DETACHED` | 准入驱逐或空闲超时 | 停进程、**保留** `sessions/` 与绑定、释放实例租约、**不释放**会话租约 | 停进程时顺带删 home |
| `DETACHED → SPAWNING` | 准入通过 | 重物化配置、复用 `conversationId`、`epoch+1` | 换 `derivedId`（会让绑定失效） |
| `CRASHED → RESTARTING` | ready 过 + 未超 max 次数 + 非确定性失败 + 非 strict 漂移 | 重物化 + `epoch+1` | 未 ready 过就重启 |
| `CRASHED → QUARANTINED` | 超限 / 确定性失败 / 配置冲突 | 保留 home 与会话，人等处理 | 静默丢弃 |
| `* → DISPOSED` | seal 或 forfeit 记录存在 | 释放两类租约、端口、删 home | 无 seal 无 forfeit 就删 |

**确定性失败分类**（决定重启还是隔离）：配置解析失败、依赖 digest 不符、端口池耗尽、会话额度拒绝 → **不重启**；进程崩溃、OOM、健康探测超时 → **可重启**。判据 = 退出码 + 末 20 行日志特征 + 启动阶段；`HANDSHAKING` 之前一律不重启（v1 的 `never-ready` 规则，扩展到 `MATERIALIZING/SPAWNING`，`fork-supervisor.mjs:41-57` 已有前半段）。

### 3.4 会话与分支

```text
Conversation: BOUND(derived=A) ⇄ DETACHED（无进程，绑定保留）
                 ├→ ARCHIVED（逻辑归档，释放活跃额度）
                 └→ SEALED（回流完成）

Branch:  OPEN(writer=A) → PARKED(read-only) → OPEN(writer=B)
              ├→ ABANDONED（择一放弃，保留只读与 provenance）
              └→ ADOPTED（成为 canonical 分支）
```

- `DETACHED` 是**正常状态**：它允许"分期分身"（会话额度 10 > 进程上限 8）与"崩溃后继续同一对话"。
- `ARCHIVED` 只改账本，不移动数据；`ARCHIVED` 的会话不占活跃额度，但**仍绑定**原分身（重开时若原分身已归档，则新建分身并继承 `conversationId`，且 `derivedId` 变更必须记审计）。

### 3.5 Seal 与回流（沿用 v1，语义不变）

`SEALED → VERIFYING → QUARANTINED → ADOPTED`，`QUARANTINED` 为强制中间态；`manifestDigest` 为幂等键。回流只上行、只带会话与声明产物，**永不**带配置/凭据/环境快照。

---

## 4 单会话的权威点

### 4.1 先分清两类租约与一个绑定

v1 把"单会话"压在一个"会话租约"上，能表达"谁在写"，但表达不了"至多一个"（计数有 TOCTOU）。细化后的 1:1 让这件事变成**三个不同的东西**：

| 机制 | 回答的问题 | 存哪 | 基数 |
|---|---|---|---|
| **绑定** `conversationId`（写一次） | 这个分身**属于**哪个会话？ | `DERIVED.json` | 恒 1；不可改 |
| **会话租约** `SessionLease` | 现在**谁有权写**？ | `quota/leases.jsonl`（带 TTL） | 每会话 1 个活租约 |
| **实例租约** `InstanceLease` | 这个进程**占着**哪个端口/pid？ | 同一账本，`kind=instance` | 每分身 1 个 |

**权威表述**：*写会话必须持有该 `conversationId` 的活租约；租约的授予点检查"该分身尚无绑定，且该原身活跃会话数 < 10"；绑定写一次后，该分身**不可能**再创建会话，因为它已经不是"能建会话的身份"了。*

**为什么这是结构性而非计数性**：不是"数一数有几个、少于 1 就放行"，而是"身份上只能有一个"。计数会被并发绕过，身份不会。

### 4.2 授予点契约（唯一写入口）

`bindConversation(derivedId, {conversationId, essenceId, workspaceKey})`，锁内顺序：

1. 读 `DERIVED.json`：`conversationId` 非空 → 拒绝 `already-bound`（这是 1:1 的唯一实现点）；
2. 读账本：该 `conversationId` 已有未过期租约 → 拒绝 `conversation-busy`（别的分身正在写）；
3. 读账本：该 `essenceId` 的活跃会话数 ≥10 → 拒绝 `active-limit`（带 remediation：归档一个旧会话）；
4. 写租约（`reserve`），再写 `DERIVED.json.conversationId`，最后 `commit`；
5. 审计 `conversation.bind`。

**先租约后绑定**：反过来（先写绑定再抢租约）会在并发下出现"绑了但拿不到租约"的空绑定，且无法回滚（绑定不可改）。

**崩溃窗口**：绑定与租约必须同源。恢复时按"租约是否 commit"二选一——已 commit → 保留绑定并重建实例；未 commit → 整个 `derivedId` 作废进 `trash/`（绑定随目录一起消失）。不允许出现"有绑定、无租约、无配额"的第三种状态。

### 4.3 强制点清单（L0–L6）

| 层 | 强制点 | 机制 | 绕过路径 | 今天 |
|---|---|---|---|---|
| **L0 准入**（权威） | 派生时 `bindConversation` + 活跃会话额度 | 账本 reserve + 写一次绑定 | 直接对已运行分身 POST 新建会话 | ❌ 无（`createTask` 不 reserve） |
| **L1 运行时**（权威） | adapter 命令门：`conversation.create` **一律拒绝**（已绑定）；`chat-send` 校验 `conversationId`+`epoch`+`leaseId` | 命令门 + 租约校验；比"≥1 就拒"更强 | 直连 HTTP 绕过 UI | ❌ 无（`permissions.mjs` 零调用点；静态表也表达不了基数） |
| **L2 存储** | 周期扫描：`$DSH_HOME/sessions/*/` 下出现第 2 个 `conversationId` → 告警 + 冻结写入 | 5s 扫一次，只 stat | 扫描间隔窗口内 | ❌ 无（且必须同时扫**所有 workspaceKey**，否则漏判） |
| **L3 进程** | 每会话一个 turn 互斥；并发 send 排队（深度 1）或 429 | 会话级 mutex | 无（同进程内可控） | ❌ 无 |
| **L4 打包** | 分身 profile 不含多会话 UI/路由插件 | 静态组合 | 直连 API（L1 兜） | ❌ 无（fork 用全量 web-app） |
| **L5 UI** | 固定会话路由、隐藏"新建" | 服务端拒绝 + 前端隐藏 | 直连 API（L1 兜） | ❌ 无 |
| **L6 审计** | 每次拒绝写 `session.single-violation` | auditor | — | ⚠️ 有 auditor，缺事件类型 |

### 4.4 反模式（写进评审结论，防止实现走偏）

1. **不要用"分身 sessions 根里只有 1 个目录"当门**。`mkdir` 与 `write` 之间有窗口，多进程/多 workspace 下扫描必然滞后；L2 只做检测与告警。
2. **不要用 `permissions.mjs` 的静态表当门**。它能表达"允许/禁止"，表达不了"至多一个"，且今天没有调用点。
3. **不要把命令门做成"前端隐藏"**。分身的 URL 是发给用户的，用户可以在里面做 UI 允许的任何事；门必须落在 adapter 的 `conversation.create` / `chat-send` 上，token 必须携带 `derivedId + conversationId + epoch`（作用域令牌，不可跨分身复用）。
4. **不要在 `DETACHED` 时释放会话租约**。否则另一个分身可以绑定同一会话，产生两个 writer；`DETACHED` 保留绑定与租约，只释放实例租约。

---

## 5 分支模型（同一分身、同一会话）

### 5.1 表示

```text
会话日志 L = e1 … ek … en         （单文件、append-only、多帧 zstd）
分支 b     = (conversationId, baseSeq=k, stash=branch 文件, head=|S_b|)
可见历史(b) = L[1..k] ++ S_b[1..head]
canonical  = ADOPTED 分支，物化在 `$DSH_HOME/sessions/<ws>/<conversationId>/`（DSH 唯一可见）
stash      = 其他分支，放在 `<home>/fang/branches/<conversationId>/<branchId>/`（DSH 不可见）
```

### 5.2 四个操作与契约

| 操作 | 语义 | 成本 | 前置 | 崩溃恢复 |
|---|---|---|---|---|
| **分叉** | 在 `headSeq` 处建元数据分支（`baseSeq=k`，stash 为空） | O(1) | 会话无未 flush 写入（先 QUIESCE） | 无副作用（只写 `branches.json`） |
| **首写物化** | 把 canonical 的 `L[1..k]` 复制成 stash 文件，再追加新消息 | **O(会话体积) 一次** | 持有该分支 writer 租约 | 写 `.new` → fsync → rename；`.new` 残留下次清理 |
| **切换** | QUIESCE → 停进程 → canonical 与目标 stash 交换 → 同 `conversationId` 重启 | **O(体积) + 冷启动（5–20s）** | 目标分支 `PARKED` 且完整 | 交换用 rename；中断则保留两文件、下次启动按 `branches.json` 对账 |
| **择一** | 目标 `ADOPTED`，其余 `ABANDONED` | O(1) | 用户显式操作 | 账本一行；被放弃分支数据保留 |
| **引用** | 把被放弃分支的某段作为引用片段追加（带 `sourceBranchId`） | O(片段) | 显式操作 | 合成消息不可重放 |
| **丢弃** | `ABANDONED` 过 TTL 后物理清理 | — | 摘要与 provenance 保留 | 两阶段（先 tombstone 再删） |

### 5.3 为什么切换不是 O(1)（撤回 v1 的结论）

v1 写"切换 = QUIESCE → PARKED → 激活目标 → 更新 activeBranchId，O(1)"。这在两个事实上不成立：

1. **DSH 按目录解析会话**：`session.v4.jsonl.zstd` 必须在 `sessions/<ws>/<conversationId>/` 那个固定路径上，否则 DSH 看不到。切换必然要改这个路径下的**文件内容**。
2. **Windows 句柄**：子进程持有打开的文件时，替换/重命名会失败或被延迟；用 junction 重指不原子（v1 自己也用这个理由否掉了 profile junction）。

**结论**：保守契约是"停进程 → 原子换文件 → 同 `conversationId` 重启"。代价是一次冷启动（D-11 的 RTO 地板 5–20s），但换来三个确定性质：切换后 DSH 看到的就是选中分支、不产生第二个会话目录、崩溃时要么旧要么新。若未来证明 DSH 每 turn 开关文件，可放宽为"不停进程 + 租约 fence + rename 重试"，但**必须有证据**，不能先按 O(1) 排期。

### 5.4 不合并契约（四条禁止）

1. **不做字段级合并**：对话是全序轨迹，两个分支都"执行了工具"时，合并会产出两次副作用的伪历史；
2. **不做自动合并**：只有"择一 + 引用"，用户不做选择就一直并存；
3. **不跨分身合并**：跨分身就是两个会话，唯一路径是 seal → reflow（`conversationId` 不同）；
4. **不重放被放弃分支的副作用**：`ABANDONED` 只读浏览，任何"继续执行"都会重放工具链。

### 5.5 上限与治理

- 每会话并行分支 ≤3（可配）；超限要求先"择一"或"丢弃"；
- `PARKED` 分支 TTL 7 天，到期提醒，**不自动删**（数据主权在用户）；
- 分支元数据进 `branches.json`，**不进** DSH 会话文件（DSH 零改造）；
- 分支**不占**会话额度（同一 `conversationId` 只计一次），但占磁盘；需按 `derivedId` 记体积并纳入准入预算。

---

## 6 子原身层级与配额归属

### 6.1 层级

```text
principal
└── 顶层原身 ×(5/10/30/50/100)                 # 每个都是"安全盘"
    ├── 子原身 ×(5/10/30/50/100)               # 每个根独立计数，至多一级
    │   └── 会话 ×10（活跃额度）
    └── 会话 ×10（活跃额度）
        └── 分身 0..1（1:1 绑定；全局并发 ≤8，可为 DETACHED）
```

### 6.2 配额表（新规则）

| tier | 顶层原身 | 每根子原身 | 每原身活跃会话 |
|---|---|---|---|
| free | 5 | 5 | **10** |
| vip10 | 10 | 10 | **10** |
| vip30 | 30 | 30 | **10** |
| vip50 | 50 | 50 | **10** |
| vip100 | 100 | 100 | **10** |

**与代码的冲突**（必须逐条改，且改测试）：

| 项 | 代码现状 | 规则 | 动作 |
|---|---|---|---|
| `maxActiveSessions` | 10/10/30/50/100（`essence.mjs:46-52`） | 恒定 10 | 拆成常量 `MAX_ACTIVE_CONVERSATIONS_PER_ESSENCE = 10`；tier 表删掉该列 |
| 测试断言 | vip30 允许 29 个活跃会话（`test/essence.test.mjs:185-186`） | 第 10 个即拒绝 | 改断言并补表驱动用例（5 个 tier × 边界 9/10/11） |
| 子原身计数 | `checkSubEssenceQuota` 按父原身数（`essence.mjs:107-119`） | 与规则一致 | 保留；补"根原身删除时子原身如何迁移"的契约 |
| 顶层原身计数 | `checkEssenceQuota` 数 `parentId === null` | 规则未写明顶层上限 | 待确认 Q-1；默认沿用现值 |

### 6.3 账本与归属

- 唯一真相是 `quota/` 账本；`essence.list()` 扫描只允许用于**校准**（且只向上修正，I4）；
- 三个投影：`essences.used`、`perEssence.subs`、`perEssence.sessions`；三者必须能由账本重算；
- 分身并发**不进**这个账本的三投影，用 `leases.jsonl(kind=instance)` 单列，避免"分身=会话"的隐式耦合；
- 锁键：`quota`（全局）+ `sessions/<essenceId>`（按原身）+ `derived/<derivedId>`（按分身）。三把锁的获取顺序固定，禁止交叉。

### 6.4 官方原身

- 今天是全局单例 + `skipQuota` + `locked`（`essence.mjs:530-542`，无锁、按 `meta.json` 存在性判幂等）；
- 规则下应改为：**按 principal 归属的额度**，官方原身本身不计入用户的顶层原身额度（或单列"预置"计数，Q-1）；
- `ensureOfficialEssence` 必须加锁 + 幂等（并发 seed 会覆盖 meta）；
- 官方原身是"安全盘"的样板：可插件、可设置，**不可开会话**（`permissions` 已如此定义，但需接线）。

### 6.5 promotion：分身 → 子原身

- 唯一能让"分身长成节点"的路径：`promoteFromSeal(sealId, {parentId})`；
- 只能挂在**根原身**下（两级上限）；消耗该根的子原身额度；
- 复制的方向：从 seal 的**会话与声明产物**建新原身，**不**复制分身的运行时配置（配置方向永不上行）；
- 当天缺失（无 promotion API），必须先有 seal 才能谈。

---

## 7 分身 supervisor 与崩溃恢复

### 7.1 所有权

| 角色 | 拥有 | 不拥有 |
|---|---|---|
| 母体 supervisor（每 `dataRoot` 一个，仅 primary） | 进程、端口、配置物化、两类租约、`epoch`、回收决策 | 会话内容、原身配置 |
| 分身进程 | 自己的会话根、adapter 连接、运行时缓存、分支 stash | 配置（只读）、其他分身、母体任何路径 |
| 会话层（新增） | 会话账本、分支表、绑定、活跃计数 | 进程生命周期 |
| 母体角色层（新增） | 主锁、`dataEpoch`、同步水位、提升/降级 | 分身的运行时 |

### 7.2 fencing 键（v1 的 epoch 不够）

```text
写入方携带：(motherId, dataEpoch, epoch)
权威值 =     (当前 primary 的 motherId, 当前 dataEpoch, 该 derived 的 epoch)
任一不等 → 403 stale-writer + 审计；不"最后写入者胜"
```

- `epoch` 解决"同一个 supervisor 崩溃重启后的双主窗口"；
- `dataEpoch` 解决"克隆母体提升后，旧主母体下的分身继续写"；
- `motherId` 解决"两个 `dataRoot` 都以为自己是 primary"。

### 7.3 崩溃矩阵

**分身层（C1–C12 沿用 v1，补 C13/C14）**

| # | 崩溃位置 | 检测 | 恢复 | 数据风险 |
|---|---|---|---|---|
| C1 | reserve 之后、目录创建前 | 租约 TTL | 回收租约，无残留 | 无 |
| C2 | `DERIVED.json` 写入中 | 启动扫描 `state:creating` | 移入 `trash/`，回收租约 | 无 |
| C3 | 配置物化中 | `profile/.new` 存在 | 删 `.new`，下次重建 | 无（配置可再生） |
| C4 | spawn 中（未打印 URL） | 超时 | kill tree、释放端口、`FAILED_SPAWN` | 无 |
| C5 | 握手时 | 超时 | kill、释放、`FAILED_SPAWN` | 无 |
| C6 | READY 后崩溃 | `exit` | 退避重启（**重物化** + 同 `conversationId`） | 会话完整 |
| C7 | turn 中崩溃 | 心跳 + `exit` | 同 C6；turn 标 `interrupted` | 丢 ≤1 条消息 |
| C8 | 母体崩溃、分身存活 | 启动 reconcile：pid 活但 epoch 旧 | **kill**，保留 home，标 `ORPHANED` | 会话在 home 内，可 resume |
| C9 | 母体与分身同时崩溃 | pid 死 | 标 `CRASHED`，提供"继续" | 无 |
| C10 | seal 中崩溃 | `SEALED` 不存在 | seal 目录视为不存在，可重试 | 无 |
| C11 | reflow 中崩溃 | 账本 `state:inflight` | 重放；半成品清理 | 无（采用是最后一步 rename） |
| C12 | reap 中崩溃 | `trash/` 残留 | 异步清空 | 无 |
| **C13** | 分支首写物化中崩溃 | `.new` + `branches.json` 无 head | 删 `.new`，分支回 `PARKED` | 无（canonical 未动） |
| **C14** | 分支切换中崩溃 | canonical 与 stash 同代际标记不一致 | 按 `branches.json` 重放交换（幂等） | 无（两份都在） |

**母体层（新增 M1–M5）**

| # | 崩溃/故障 | 检测 | 恢复 | 禁止 |
|---|---|---|---|---|
| M1 | primary 崩溃，replica 存活 | 主锁心跳超时 ≥2 周期 | 提升 replica（`dataEpoch+1`）、旧分身判 stale、重建 | 自动提升（需策略：自动 vs 人工，Q-4） |
| M2 | 两个 primary（split-brain） | 两侧都能读到对方心跳/都能拿锁 | **停写**、告警、按 `(dataEpoch, motherId)` 仲裁；败者 DEMOTED | 让两边都继续服务 |
| M3 | 提升时旧 primary 仍活着 | 旧 primary 心跳存在 | 拒绝提升；或先 `kill -9` 全部旧分身再提升 | 只提升不清理旧分身 |
| M4 | 同步中断 | `SyncRun` 无 `SEALED` / cursor 停滞 | 从 `fromCursor` 重放；半成品不可见 | 把半成品当同步完成 |
| M5 | 空白母体被指向非空 `dataRoot` | `MOTHER.json` 缺失但目录非空 | 拒绝启动、要求显式 `--adopt-blank` | 静默接管 |

### 7.4 心跳与存活（四层）

| 层 | 手段 | 间隔 | 判据 | 失败含义 |
|---|---|---|---|---|
| 进程 | `pid` 存活 | 10s | OS | 硬死 |
| 服务 | loopback HTTP | 5s | 有响应 | 进程活、服务挂 |
| 会话 | `turn.heartbeat` 推进 | 30s | 事件流有推进 | 服务活、agent 卡死 → 标 `STALLED`（**不是** `CRASHED`） |
| 同步 | `syncCursor` 前进 | 每档位（6/12/24h） | 水位前进 | 副本滞后 → 禁止提升（见 8.5） |

### 7.5 重启策略与熔断

| 阶段失败 | 重启？ | 理由 |
|---|---|---|
| 物化失败 | ❌ | 同一份坏配置，重试无收益 |
| spawn 失败 | ❌（端口耗尽可排队） | 环境问题 |
| 首次握手失败 | ❌ | 等价 never-ready |
| READY 后崩溃 | ✅ 退避 ≤3 | 有"上次是好的"基线 |
| 重启后 <30s 又崩 | ✅ 但加速耗尽配额 | 崩溃循环 |
| 超限 | ❌ → `QUARANTINED` | 需人工 |

熔断：`CLOSED → OPEN(连续 3 次) → HALF_OPEN(冷却 60s) → CLOSED/OPEN(terminal)`；与 `maxRestarts` 并存不冲突（一个是次数预算，一个是时间窗速率）。

### 7.6 回收两阶段（D-16 的落地）

`reap(derivedId, {mode:'seal'|'forfeit'})`，默认 `seal`；无 `SEALED` 且无 `forfeit` 记录 → **拒绝删除 home**。

- 这与"生产数据持久"是同一条规则的两面：reap 只能回收**实例**，不能回收**数据**；数据的终态是 `ARCHIVED`（逻辑）或 `SEALED`（可回流）；
- `DETACHED` 与 `ARCHIVED` 的区别必须写进 UI：前者还能用同一分身继续，后者需要新分身并继承 `conversationId`。

---

## 8 母体代际：主 / 备份 / 克隆 / 空白

### 8.1 四个角色

| 角色 | 可写 | 可派生 | 数据形态 | RPO | 用途 | 提升路径 |
|---|---|---|---|---|---|---|
| **primary（主母体）** | 全部 | ✅ 唯一 | 全量、实时 | 0 | 生产 | — |
| **standby（备份母体）** | 只写自己的恢复点 | ❌ | `SEALED` 快照目录，无进程 | ≤ 快照间隔（6/12h） | 回滚锚点 | `restore`（数据回滚，非接管） |
| **replica（克隆母体）** | ❌（只读跟随） | ❌（除非已提升） | 常驻 `dsh web` + 增量副本 | ≤ 同步滞后（6h） | 接管候选 | `promote`（接管，`dataEpoch+1`） |
| **blank（空白母体）** | 初始化期可写 | ❌ | 空 | 无 | 新装 / 灾难重建 | 只能 `provision` 成新 primary |

**三个必须点破的差异**：

1. **备份母体不是进程**：它是一份带 `MANIFEST + SEALED` 的目录；"备份母体在线"这句话本身不成立。把 standby 当热备会做出"备份也能派生"的实现，而那会产出与 primary 分叉的第二个真相。
2. **克隆母体是进程，但只读**：它可以被用户浏览（只读会话、只读配置），可以在 primary 死亡后接管；但它**不能**在自己身上派生、改配置、开会话——否则它就是第二个 primary。
3. **空白母体是"没有历史"的节点**：它只能从零建起；指向非空 `dataRoot` 必须 fail-closed（M5），否则"空白"掩盖的是"未经校验的接管"。

**RTO 预算（必须实测，不能先写进 SLA）**：standby → primary 的恢复 ≤60s（本地复制 + 指针切换）；replica → primary 的接管 ≤5min（主锁 + 提升 + 旧分身清理 + 面板刷新）。两个数都要用演练脚本测出来（DATA-RELIABILITY §4.8 的 restore drill 直接复用）。

### 8.2 同步契约（6/12/24h）

先给一个可实现的默认解释（Q-4 待确认）：

| 档位 | 内容 | 产物 | 幂等键 | 失败影响 |
|---|---|---|---|---|
| **6h 增量** | 只追加账本（`SESSIONS.jsonl`、派生事件流）+ 已 commit 的配额计数器 + tombstone + 已 flush 的会话文件；**不复制在途租约** | `syncCursor` 前进 | `(from,to,6h,fromCursor)` | 水位停滞 → 告警；下次重放 |
| **12h 全量** | 镜像代 + 原身 overlay + 会话 + seal 索引 | `SEALED` + `manifestDigest` | `sha256(manifestDigest)` | 副本不可提升 |
| **24h 校验** | `manifest` 逐文件校验 + 恢复演练 + 报告 | `verifyReport` | 同上 | 提升被禁止（见 8.5） |

**五条铁律**：

1. **单向**：只允许 primary → standby/replica；任何反向写都会产生第二个真相；
2. **快照可见性**：未 `SEALED` 的同步副本不可见、不可提升；
3. **物理隔离**：副本必须落在**另一个 `dataRoot`**；禁止 junction/symlink 连接两个根（否则 replica 的写会落进 primary，且 `forker` 已有 junction 先例，容易被误用）；
4. **凭据同敏**：副本包含 `credentials` 与会话，安全等级等同 primary；"空白母体"是唯一可以低敏部署的形态；
5. **租约不复制**：租约是"进程还活着"的证据，跨母体复制会让副本以为会话被占、并让提升后的旧租约"复活"。同步只带**已 commit 的计数**与 tombstone；租约在提升后按"全部过期"重建。

### 8.3 代际链条

```text
configGeneration:  G-1 ──> G ──> G+1            （镜像升级，单调）
dataEpoch:         1 ──> 2 ──> 3               （同步/提升/回滚，单调）
Derived 钉住：   (configGeneration, dataEpoch, configDigest, depsDigest)

primary(G, e) ──12h 全量──> standby(G, e)      # 回滚锚点
primary(G, e) ──6h 增量──> replica(G, e)       # 接管候选
primary(G+1, e) ──> standby 保持 (G, e)        # 旧版备份母体：回滚用
                      replica 在同步完成后跟到 (G+1, e')  # 若未跟完 = 旧版克隆母体
```

- **旧版备份母体**是一等公民：升级后它必须保留在 `G`（I2：至少一个可回滚对象）；
- **旧版克隆母体**是"配置旧、数据可能新"的混合体 → **不可静默提升**（见 8.5）；
- 分身钉在派生时的 `(configGeneration, dataEpoch)`；升级**不迁移**在途分身（D-14），UI 标"旧代"。

### 8.4 旧代分身的规则

| 规则 | 说明 |
|---|---|
| 可继续运行 | 不因升级被杀；配置不重算 |
| 标 `legacy` | 面板显式"旧代：config G-1"；回答差异时这是第一解释 |
| 不可用于 promotion | 旧代分身回流成子原身会固化旧配置 |
| 不允许新派生 | 新派生一律用当前 `configGeneration` |
| 可 seal / 可归档 | 数据上行不受代际限制 |

### 8.5 提升判据（防"旧配置 + 新数据"）

```text
promote(replica → primary) 必须同时满足：
  1. 已持有目标 dataRoot 的主锁（primary 心跳超时 ≥2 周期）
  2. replica.configGeneration ≥ primary 最后已知 configGeneration - 1（容忍一代，否则先升级）
  3. replica 的 session 账本 headSeq ≥ primary 最后已知 headSeq - L（L = 允许丢失的消息数，必须显式配置）
  4. 24h 校验报告为 pass（或显式 --accept-unverified，且审计）
  5. 提升后 dataEpoch+1，所有旧 (motherId, epoch) 的写入被拒
```

第 2 条是本章的核心：**克隆母体可能"配置旧、数据新"**（升级发生在同步之后）。直接提升会得到"旧配置跑新会话"，而这在用户看来就是"升级被静默回退了"。容忍一代是折中；超过一代必须先走升级同步，或明确告知用户"提升 = 配置回退"。

### 8.6 禁止事项

- ❌ 两个 primary 同时写（split-brain）
- ❌ replica 上派生/改配置/开会话
- ❌ standby 上派生（它连进程都没有）
- ❌ blank 指向非空 `dataRoot`
- ❌ 双向同步（clone 的改动回写 primary）
- ❌ 在途分身热迁移到新代（v1 D-14 保持）
- ❌ 用 junction 连接两个母体根

---

## 9 失败隔离

| # | 失败 | 影响面 | 遏制 | 恢复 | 判据 |
|---|---|---|---|---|---|
| F1 | 原身 conflicted | 该原身新派生 | strict 拒绝派生 + 冲突摘要 | 修 overlay → recompute | 派生 409 + `conflicts[]`，不产生分身 |
| F2 | 配置物化失败 | 单分身 | 不 spawn、不建会话、释放两类租约 | 重试（同 requestId 幂等） | 无残留目录、额度不泄漏 |
| F3 | 依赖 digest 不符 | 单分身 | 拒绝启动 | 重建 deps | 启动前失败，日志含期望/实际 digest |
| F4 | spawn 超时 | 单分身 | kill tree + 释放端口 | 重试或排队 | 端口表无泄漏 |
| F5 | 握手失败 | 单分身 | 不重试（never-ready） | 归因（日志 + 版本） | 不进入 RESTARTING |
| F6 | 运行期崩溃 | 单分身 | 退避重启 ≤3 | 重物化 + 同会话 | 消息不丢；`restartCount` 正确 |
| F7 | 崩溃循环 | 单分身 | 熔断 → QUARANTINED | 人工 | 无第 4 次自动重启 |
| F8 | 母体重启 | 所有在线分身 | epoch+1 → 孤儿 kill | 保留 home，可 resume | 无孤儿占端口 |
| F9 | 会话写入失败 | 单会话 | 标 `interrupted`，保留已写 | 用户重试 | 不产生"半条消息" |
| F10 | 单会话违规 | 单分身 | 拒绝 + 审计 | 引导归档 | 直连 API 也拒 |
| F11 | 回收时 seal 失败 | 单分身 | **不删 home**，标 `SEAL_FAILED` | 重试 seal 或 forfeit | home 仍在，数据可读 |
| F12 | 回流失败 | 单次回流 | seal 保留，分身可安全回收 | 重试（幂等） | 重复回流零副作用 |
| F13 | 磁盘将满 | 所有 | 准入拒绝 + 预警 | 清理 seal/归档 | 预检在写入前 |
| F14 | 镜像升级中 | 所有新派生 | `isRecomputing()` → 排队 | 重算完成放行 | 不用半个 merged 启动 |
| **F15** | 同步失败 | 副本 | cursor 停滞、告警；不影响 primary | 从水位重放 | 半成品不可见 |
| **F16** | 双 primary | 全局 | 一方停写 + 告警 | 按 `(dataEpoch, motherId)` 仲裁 | 写入被拒而非"双方都成功" |
| **F17** | 副本滞后超阈 | 提升路径 | 禁止提升 | 等待同步或显式接受 RPO | 提升接口返回 `replica-lagging` |
| **F18** | blank 指向非空根 | 全局 | fail-closed 拒绝启动 | 显式 `--adopt-blank` | 无静默接管 |
| **F19** | 规则/表不一致（如会话额度被写成 tier 相关） | 全局 | 启动校验直接失败 | 修表 | 启动日志给出表与规则的不符项 |

**四条隔离原则**：失败不跨层（分身失败不写原身；原身失败不阻止已在线分身）、失败不静默（状态 + 可行动原因 + 审计）、失败不泄漏（租约/端口/pid/磁盘四类资源可回收）、失败可回放（日志 + `DERIVED.json` + digest 保留）。

---

## 10 可观测字段

### 10.1 单事件最小字段（v1 基础上补四角色）

| 字段 | 例 | 为什么必须有 |
|---|---|---|
| `traceId` | `derivedId` 或 `syncId` | 一次全生命周期一条链 |
| **`motherId` + `motherRole`** | `m-01` / `primary` | 四角色下"谁在写"是第一归因问题 |
| **`dataEpoch`** | `3` | 判定是否旧主 |
| `epoch` + `leaseId` + `leaseKind` | `7` / `l-…` / `session` | 判定是否旧写者；两类租约分开 |
| `essenceId` + `tier` | `essence-official-dev` / `vip30` | 归因配置与额度 |
| `configGeneration` + `configDigest` + `depsDigest` | `G-3` / `sha256:…` | **"部署 SHA"**；没有它，回答变化无法解释 |
| `conversationId` + `branchId` + `baseSeq` + `turnId` | | 定位轨迹 |
| `status` + `errorCode` | `sealed` / `F11` | 机器可聚合 |
| `latencyMs` / `rssMb` / `diskBytes` | | 资源 |
| `restartCount` / `drift` / `legacy` | | 稳定性与代际 |
| **`syncCursor` / `syncLagSec`** | `c-00123` / `7200` | 副本可用性的唯一判据 |
| `admissionDecision` | `admit` / `queue(3)` / `reject(active-limit)` | 容量问题不伪装成故障 |
| `gate` | `conversation.create → denied` | 单会话门是否真的在拦 |

### 10.2 面板（一屏四区）

| 区 | 必显 |
|---|---|
| 母体 | 角色（主/备/克隆/空白）、`dataEpoch`、`configGeneration`、主锁心跳、同步水位与滞后、最后校验结论 |
| 原身 | 状态、`mergedDigest`、活跃会话 `n/10`、子原身 `n/上限`、在途分身数、冲突数 |
| 分身 | 阶段、绑定 `conversationId`、分支数、端口/pid、`restartCount`、`drift`/`legacy`、租约到期、seal 状态 |
| 会话 | 活跃 `n/10`、`DETACHED` 数、`PARKED` 分支数、违规拒绝数 |

### 10.3 告警

| 告警 | 阈值 | 为什么 |
|---|---|---|
| 崩溃率 | >2 次/小时/分身 | 崩溃循环前兆 |
| spawn p95 | >30s | 体验崩塌，且掩盖真正的慢 |
| 配额拒绝率 | >20% | 容量问题伪装成产品问题 |
| 孤儿数 | >0 持续 5 分钟 | fencing 失效 |
| 未 seal 的 home | 增长 | 磁盘炸弹 |
| sealed 未 adopt | >24h | 用户不知道数据在哪 |
| 单会话违规 | >0 | 约束失效 |
| `configDrift` 重启 | >0 | 配置漂移被静默接受 |
| **同步滞后** | >1.5× 档位 | 副本不可用却以为可用 |
| **双 primary** | ≥1 | 最高优先级 |
| **旧代分身被用于 promotion** | ≥1 | 代际污染 |

### 10.4 五分钟取证

给定一个错误回答，必须 5 分钟内回答：

1. 哪个母体、哪个 `dataEpoch` 在写？（`motherId` + `dataEpoch` + `epoch`）
2. 跑的是哪份配置？（`configGeneration` + `configDigest`）
3. 属于哪个会话的哪个分支？（`conversationId` + `branchId` + `baseSeq`）
4. 那个 turn 调了哪些工具？（`turnId` → 工具 span）
5. 期间有没有重启/漂移/降级/切换分支？（`restartCount` + `drift` + `legacy` + `gate`）
6. 上游原身当时是什么状态？副本是否滞后？（`essence status` + `syncLagSec`）

答不出第 1、2 条的系统不具备上线资格：四角色 + 多分支下，"配置变了""母体换了""模型变笨了"三者外观完全相同。

---

## 11 落地顺序与验收

| 阶段 | 内容 | 为什么是现在 | 不做会怎样 |
|---|---|---|---|
| **P0-a** | 额度对齐（会话恒定 10 + 改测试）+ 表驱动校验（F19） | 后面所有准入都建在这个额度上 | 准入永远算错；测试保护错误行为 |
| **P0-b** | 两阶段回收（D-16）+ 会话绑定字段（`conversationId` 写一次） | 先止血 | 每次归档都在删数据；1:1 无从谈起 |
| **P0-c** | 配置源切 `merged/profile` + digest + restart 也物化 | 三层模型才有意义 | 原身装的插件分身永远看不到 |
| **P0-d** | 单会话门 L0+L1（绑定 + 命令门 + 租约）+ `permissions` 接线 | 需求核心 | "单会话"是文案 |
| **P0-e** | 准入单点 + 双配额分离（会话额度 / 进程并发） | 与 P0-d 同源 | 并发下超卖；10 个额度只能开 8 个还没解释 |
| **P1-a** | fencing `(motherId, dataEpoch, epoch)` + 孤儿 kill + 熔断 | 崩溃恢复前提 | 重启后僵尸占资源；提升后双写 |
| **P1-b** | seal → reflow 最小闭环 | P0-b 的解封条件 | 回收只能"删"或"永不删" |
| **P1-c** | 分支模型（分叉/首写/切换/不合并） | 依赖会话账本 | 用户只能线性对话 |
| **P2-a** | 母体四角色 + 6/12/24h 同步 + 提升判据 | 需要 P1-a 的 fencing | 四角色只能靠人工脚本拼 |
| **P2-b** | 依赖只读（`depsDigest`）+ 环境变量白名单 | 安全 | 分身可写穿母体插件树、读到凭据 |
| **P2-c** | 观察面 + 快速派生（幂等 + 排队） | 让前面可运维 | 出事无法归因 |

**验收门槛（在 v1 的 8 条之上）**：

1. **1:1 对抗**：50 次直连 adapter 建会话 + 第二个 URL + 并发 send → 100% 拒绝且全部审计；无一条产生第二个 `conversationId`。
2. **额度**：5 个 tier × 边界 9/10/11；`物理数 == 账本数 == 成功数 ≤ 10`；分身并发变化**不改变**会话额度。
3. **配置重置**：原身换插件 → 下一次派生必然带上；旧分身保持旧配置并标 `drift`；restart 也重物化。
4. **回收**：无 seal 无 forfeit 的 home 不可删；`DETACHED` 后会话仍可 resume。
5. **同步**：同 `syncId` 重放零副作用；半成品不可见；滞后超阈禁止提升。
6. **提升**：kill primary 后 replica 提升，`dataEpoch+1`，旧分身全部 `stale-writer`；"旧配置 + 新数据"被拒绝或显式确认。
7. **分支**：分叉/首写/切换/择一各 3 次 SIGKILL，0 次会话内容丢失、0 次出现第二个会话目录。
8. **崩溃矩阵**：C1–C14 + M1–M5 各 3 次 SIGKILL，0 次孤儿不回收、0 次半截配置启动。
9. **取证**：任取一个错误回答，5 分钟内定位到 母体/代际/分支/turn。

---

## 12 明确不做与待确认

**不做**：分身间 mesh 同步；会话 CRDT/字段级合并；在途分身热迁移；多 primary 并发写；双向同步；自动合并分支；分身内装插件；跨分身分支。

**待产品确认**（决定实现形状，不阻塞 P0）：

| # | 问题 | 建议 |
|---|---|---|
| Q-1 | 顶层原身是否也 5/10/30/50/100？官方原身是否占用户额度？ | 沿用现表；官方单列"预置"，不计入用户额度 |
| Q-2 | 6/12/24h 是"三档可选"还是"三层节奏同时生效"？ | 三层同时生效（增量/全量/校验），与现有备份间隔同数不同物 |
| Q-3 | 会话额度 10 > 进程并发 8 时，`DETACHED` 由谁决定？ | 准入 LRU 驱逐空闲分身，绝不驱逐 ACTIVE；驱逐要可见 |
| Q-4 | 副本提升是自动还是人工？ | 默认人工（数据回退/接管都改变真相），自动仅限"primary 确认死亡 + 校验 pass" |
| Q-5 | 分支切换接受 5–20s 冷启动吗？ | 接受；若要更快，先在上游证明 DSH 不长期持有会话文件句柄 |
| Q-6 | 删原身时它的会话怎么办？ | 默认拒绝；提供"归档到 `sessions/_orphaned/` 并删除"一键操作（v1 §10 建议） |

---

## 13 模块落位（`src/lib`）

四角色 + 双租约 + 分支会让 `forker` 继续膨胀。**拆分而不是叠加**，否则第三层会重演"三处配额真相"：

| 新模块 | 职责 | 对外契约（只列形状） | 依赖 | 今天 |
|---|---|---|---|---|
| `quota.mjs` | 单账本、双槽、两类租约、reserve/commit/tombstone | `reserve(kind, owner)` / `commit(leaseId)` / `release(leaseId)` / `snapshot()` | 无（纯文件 + 锁） | 无；计数散在三处 |
| `conversations.mjs` | 绑定（写一次）、会话账本、分支表、活跃计数 | `bind(derivedId, conversationId)` / `archive(id)` / `branch(op)` / `writerOf(branchId)` | `quota.mjs` | 无 |
| `admission.mjs` | 单点准入：会话占位 + 进程占位 + 端口 + 磁盘 | `admit(request) → admit / queue(pos, eta) / reject(reason, remediation)` | `quota.mjs`、端口池 | 无；`maxForks` 与 `createTask` 各自判 |
| `derived-supervisor.mjs` | 物化、spawn、`epoch`、fencing、两阶段回收 | `derive()` / `restart()` / `detach()` / `reap(mode)` / `fenceCheck(motherId, dataEpoch, epoch)` | `quota.mjs`、`admission.mjs`、`forker` 进程原语 | 无；逻辑混在 `forker` |
| `mother-roles.mjs` | 主锁、角色状态机、`dataEpoch`、提升判据 | `claimPrimary()` / `heartbeat()` / `planPromotion()` / `applyPromotion()` | `quota.mjs` | 无 |
| `sync-replica.mjs` | 6/12/24 同步、`syncCursor`、`SEALED` 可见性 | `planSync(cadence)` / `runSync(syncId)` / `resume(cursor)` / `lag()` | `mother-roles.mjs` | 无（只有 `mirror` 备份产物） |
| `seal-reflow.mjs` | seal / verify / quarantine / adopt | `seal(derivedId)` / `verify(sealId)` / `adopt(reflowId)` | `quota.mjs`、`sessions` | 无 |
| `forker`（收缩） | **只保留进程原语**：spawn / stop / killTree / ports / health / meta | 不再拥有配额、配置语义、回收决策 | — | 现状全部揉在一起 |

**两个必须同时做的收敛**：

1. `forker.provision` 里的"clean template 克隆"降级为 `derived-supervisor` 的一个实现细节；配置源唯一化到 `<essence>/merged/profile`。
2. `mirror` 的 `backup/restore` 保持为"镜像产物"；不要把 `mother-roles` 的同步塞进 `mirror`，否则"备份"会重新变成两个意思（V-4）。

文档同步：`docs/MIRROR.md`（补角色边界）、`docs/ESSENCE.md`（补 1:1 与额度表）、`docs/DATA-RELIABILITY.md`（I6 扩为"会话不随**分身**删除"）。

## 附录 A 与 v1 ADR 的映射

| v1 | 状态 | v2 处理 |
|---|---|---|
| D-01 配置物化 | 保留 | 源明确为 `<essence>/merged/profile`；`materializeMerged` 会 `removeTree(merged)`（`essence.mjs:778-783`），派生必须"先读 digest 再拷贝，不符重试一次" |
| D-02 依赖只读 | 保留 | `depsDigest` 共享；现状是 junction 到**可写**母体树（`forker.mjs:734-741`） |
| D-03 会话归原身 | **修订** | 1:1 后改为"会话归原身、**绑定归分身**、租约归母体" |
| D-04 单会话门 = 租约 | **修订** | 升级为"绑定（基数）+ 租约（权威）+ 命令门（执行）"三件套（§4.1） |
| D-05 分支 = 元数据分叉 + 首写物化 | 保留 | 撤回"切换 O(1)"，改为 O(体积)+冷启动（§5.3） |
| D-06 回流四态 | 保留 | 不变 |
| D-07 母体唯一 supervisor + epoch | **修订** | fencing 键扩为 `(motherId, dataEpoch, epoch)`（§7.2） |
| D-08 崩溃重启重物化 + 同会话 | 保留 | 与 `DETACHED` 复用同一路径 |
| D-09 配额单账本三视图 | 保留 | 三视图 = 原身/子原身/会话；分身并发单列（§2.4） |
| D-10 官方原身按 principal | 保留 | 需加锁 + 幂等 |
| D-11 快速派生 | 保留 | 分支切换的冷启动与之共用 RTO 地板 |
| D-12 准入单点 | 保留 | 输入扩为"双资源"（会话占位 / 进程占位） |
| D-13 代际 | 保留 | 补 `dataEpoch` 与 `configGeneration` 双计数（§8.3） |
| D-14 升级不迁移在途分身 | 保留 | 补"旧代分身禁止 promotion"（§8.4） |
| D-15 信任方向单向 | 保留 | 同敏：副本含凭据，安全等级等同 primary |
| D-16 回收两阶段 | 保留 | 默认 seal；`forfeit` 必须显式 |
| **D-17**（新） | 母体四角色 + 单写者（仅 primary） | §8.1 |
| **D-18**（新） | 同步单向快照 + 6/12/24 三层节奏 | §8.2 |
| **D-19**（新） | 会话额度恒定 10；tier 只管原身/子原身 | §6.2 |
| **D-20**（新） | 1:1 是写一次的绑定，不是计数器 | §4.1 |
| **D-21**（新） | 会话占位与进程占用分离（`DETACHED`） | §2.4 / §3.3 |
| **D-22**（新） | 分支切换 = 停进程 + 原子换文件 + 同会话重启 | §5.3 |
| **D-23**（新） | 副本提升需代际兼容 + 校验 + `dataEpoch+1` | §8.5 |
| **D-24**（新） | 旧代分身标 `legacy`，禁止派生与 promotion | §8.4 |
| **D-25**（新） | 同步水位 `syncCursor` 进账本，滞后是告警与提升门槛 | §8.2 / §10.3 |
| **D-26**（新） | 启动校验"规则 vs 配额表"不一致即 fail-closed（F19） | §9 |

## 附录 B 证据索引（代码基线 v3.0.4）

| 结论 | 位置 |
|---|---|
| 配置源是 clean template，不是 `merged/profile` | `src/plugins/forker.mjs:688-732` |
| 环境变量全量继承 + `DSH_HOME=homeDir` | `src/plugins/forker.mjs:917-926` |
| `node_modules` junction 到母体可写模块树 | `src/plugins/forker.mjs:734-741` |
| `reap` = stop + `removeTree(homeDir)` | `src/plugins/forker.mjs:1114-1126` |
| restart 直接 spawn、不重物化 | `src/plugins/forker.mjs:1170-1185` |
| `maxForks` 内存计数 | `src/plugins/forker.mjs:811-812` |
| 端口不匹配即停（应保留的资产） | `src/plugins/forker.mjs:958-962` |
| never-ready 不重启（应保留的资产） | `src/lib/fork-supervisor.mjs:41-57` |
| 孤儿只 mark、不 kill（C8 缺口） | `src/lib/fork-supervisor.mjs:60-74` |
| 原子写 meta 0600（应保留的资产） | `src/lib/fork-supervisor.mjs:81-95` |
| 权限规则存在、生产零调用点 | `src/lib/permissions.mjs:20-24`；仅 `test/permissions.test.mjs` |
| 会话额度随 tier 放大（与规则冲突） | `src/lib/essence.mjs:46-52`；`test/essence.test.mjs:185-186` |
| 活跃会话检查是纯函数、无人调用 | `src/lib/essence.mjs:127-138` |
| 原身创建靠扫描计数 | `src/lib/essence.mjs:483-497` |
| 官方原身无锁 seed | `src/lib/essence.mjs:530-542` |
| 删除原身不查在途分身/会话 | `src/lib/essence.mjs:566-575` |
| `recompute` 先删 `merged` 再重建 | `src/lib/essence.mjs:778-783` |
| 镜像只有 backup/restore，无角色/主锁 | `src/lib/mirror.mjs:209-243`、`:250-284`、`:305-326` |
| `swapActive` 伪原子（伪指针） | `src/lib/mirror.mjs:458-468`（详见 DATA-RELIABILITY R-01） |
| `createTask` 不 reserve 会话、只用 template | `src/plugins/orchestrator.mjs:383-391`、`:415-422` |
| 归档保留 home、reap 删 home | `src/plugins/orchestrator.mjs:859-923`、`:1002-1010` |
| 会话根 = `$DSH_HOME/sessions` | `src/kernel/paths.mjs:115-126` |
| 会话是单文件多帧 zstd | `src/lib/session-format.mjs:9-16` |
| 备份间隔仅 6/12/24 | `src/lib/mirror.mjs:296-307` |
| 版本真相：`meta.version` vs `active/version.json` | `src/lib/mirror.mjs:164-168`（DATA-RELIABILITY R-05） |
