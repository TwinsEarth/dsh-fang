# 三层数据可靠性模型（设计 + 现状评审）

> 对象：dsh-Fang v3.0.4（零依赖 .mjs / node:test）
> 范围：母体镜像（文件夹 1）· 原身（文件夹 2）· 会话（文件夹 3）
> 参考实现：[mirror.mjs](../src/lib/mirror.mjs)、[essence.mjs](../src/lib/essence.mjs)、[compat.mjs](../src/lib/compat.mjs)、[fsx.mjs](../src/kernel/fsx.mjs)、[upgrade-coordinator.mjs](../src/lib/upgrade-coordinator.mjs)
> 本文只给设计与伪代码，不粘贴源码。

---

## 0 结论摘要

现有实现**结构对了，提交语义没到**。三层目录划分、备份/恢复/升级/回退的 API 形状、VIP 配额表、两级原身、凭据隔离都已经立住；但真正决定"会不会丢数据"的那一层——**提交点、fsync 边界、完整性证明、崩溃后自愈**——目前是空的。

按危害排序的 5 个 P0：

| # | 结论 | 一句话后果 |
|---|---|---|
| R-01 | `swapActive` 是"先删旧、再改名"，不是原子替换 | 删除与改名之间崩溃 → 母体镜像**不存在**，且 Windows 上旧目录被运行中进程占用时会静默留下半新半旧树 |
| R-02 | 备份没有任何完整性证明（无 manifest、无 seal、无校验） | `copyTree` 内部逐文件 `catch{}` 吞错 → **备份缺文件却记成功**；这是"以为有备份"的源头 |
| R-03 | 全链路零 fsync | 断电后 rename 可见、内容为空 → `meta.json`/`backups.json` 损坏 → `readJson` 静默返回默认值 → **备份全部"消失"** |
| R-04 | 索引与配额都是"读-改-写 + 目录扫描"，且无锁 | 并发 backup/delete 丢条目；并发 create 原身**超卖**（99% 的"崩溃后超卖"都是这一类） |
| R-05 | 升级在"备份未校验"时就执行了破坏性替换；无意图日志 | 替换中途崩溃 = 无回滚锚点可用；"已备份再替换"只满足了字面顺序，没满足**可恢复性** |

结论：先补**提交协议**（意图日志 + 不可变代 + 指针提交 + 双槽状态），再补**完整性证明**（MANIFEST + SEALED + 定时恢复演练），最后才是配额账本与路径加固。顺序不能反——在没有校验的情况下加自动清理，会把"备份堆积"变成"备份被删光"。

---

## 1 目标：RPO / RTO 与不变量

### 1.1 业务目标（建议值，需产品确认）

| 对象 | RPO（可丢多少） | RTO（多久可用） | 决定设计 |
|---|---|---|---|
| 母体镜像当前代 | 0（升级前旧代必须仍在） | ≤ 5s（指针切换，非复制） | 保留 N=2 代 + 指针提交 |
| 母体镜像备份 | ≤ 备份间隔（6/12/24h）+ 手动点 | ≤ 60s（本地还原） | 间隔档位 + 手动点 + SEALED |
| 原身 overlay | 0（原子写） | 秒级 | 原子写 + fsync |
| 原身 merged/profile | 可再生，无 RPO 要求 | ≤ 单原身重算时间（并行，60s 超时） | 指纹 + stale 标记 |
| 会话数据 | ≤ flush 周期（建议 ≤ 2s 或每条消息末） | 秒级（直接可读） | jsonl 追加 + 尾行截断 |
| 配额计数 | 0（不允许超卖） | 启动自愈 | 账本 + 租约 + fail-closed |

### 1.2 不变量（Invariants）

任何时刻——**包括任意一点被 SIGKILL 之后**——下列命题必须成立。它们是后面所有算法与测试的判据。

- **I1** 指针（`state`）指向的 generation 一定存在且 MANIFEST 校验通过；否则必须 fail-closed 拒绝启动，绝不以半棵树对外服务。
- **I2** 任何时刻至少存在一个可回滚对象：上一代 generation，或一个 SEALED 备份。二者不可同时为零。
- **I3** 提交点之前产生的目录**永不**被当作当前代；提交点之后的 generation 必定存在（不存在 = 提交被回滚，不得出现第三种状态）。
- **I4** 配额：锁内恒有 `used + reserved ≤ limit`；且 `used ≥ 物理合法实体数`（计数只许偏高、不许偏低）。
- **I5** 每个原身活跃会话数 ≤ 上限；归档会话不受限且不占活跃额度。
- **I6** 会话数据永不位于原身目录内；删除原身不隐含删除会话。
- **I7** 跨目录移动要么同卷 `rename`（原子），要么 copy → seal → 指针（可恢复）；删除一律经 `trash/` 两阶段。
- **I8** 任何用户可控字符串进入路径前必须过 `safeSegment`，解析后必须做 realpath 包含性校验。
- **I9** 每个破坏性操作（替换/删除/剪枝/回滚）先写意图日志并 fsync，再执行，最后写完成记录。

---

## 2 现状评审：风险清单

### 2.1 P0 — 会丢数据，或让母体起不来

**R-01 替换不是原子替换（伪原子）**
证据：[mirror.mjs#L458-L468](../src/lib/mirror.mjs#L458-L468) — `swapActive` 的顺序是：拷到 `.swap-*` → `removeTree(active)` → `renameSync(stagingCopy, active)`。
- 崩溃窗口：`removeTree` 与 `rename` 之间进程死亡 → **`active/` 不存在**，母体无镜像可启动。
- Windows 特有：母体进程正从 `active/profile` 加载模块，句柄未释放 → `removeTree` 内部 `rmdir` 失败被 `catch{}` 吞掉 → 旧树**部分残留**，然后 `rename` 失败 → 留下"新旧混合"的 active。
- 副产物：`removeTree` 失败被吞，函数仍返回成功，调用方无从得知。
修复：不可变代 + 指针提交（§4.4），`active/` 退化为派生的兼容 junction；`removeTree` 改严格模式（失败必须抛）。

**R-02 备份没有完整性证明**
证据：[mirror.mjs#L213-L243](../src/lib/mirror.mjs#L213-L243)（copy → 算大小 → 写索引）、[fsx.mjs#L142-L169](../src/kernel/fsx.mjs#L142-L169)（`copyTree` 每文件 `try{copyFileSync}catch{}`）。
- 单文件复制失败被吞 → 备份**静默缺内容**，索引仍写 `sizeBytes`，`backup()` 返回成功。
- 没有 manifest，因此"这个备份是否包含完整的一代"无法事后回答；`restore` 直接拿它去替换 `active`（[mirror.mjs#L260-L284](../src/lib/mirror.mjs#L260-L284)），把缺文件的备份**扶正**。
- 备份目录与"备份存在"之间没有提交标记，半成品目录与成品目录在磁盘上不可区分。
修复：MANIFEST（逐文件 sha256+size）+ 全部文件 fsync 后才写 `SEALED`；只有 SEALED 才进索引、才可被 restore/剪枝（§4.3）。

**R-03 零 fsync，断电即"备份消失"**
证据：[fsx.mjs#L48-L63](../src/kernel/fsx.mjs#L48-L63) 只做 tmp + rename，无 `fsync(file)`、无 `fsync(dir)`；[fsx.mjs#L26-L32](../src/kernel/fsx.mjs#L26-L32) 读失败静默返回 fallback。
- 断电后典型结局：目录项已落盘、文件数据为空 → `backups.json` 是 0 字节 → `readJson` 返回 `[]` → **界面显示 0 个备份，磁盘上躺着全部备份**。用户很可能据此重新备份、甚至手动清理，把真实备份删掉。
- `meta.json` 同样，且 [mirror.mjs#L164-L168](../src/lib/mirror.mjs#L164-L168) 的版本判定依赖它 → 版本 `unknown`，升级判断失真。
修复：写入顺序 = 写 tmp → `fsync(file)` → `rename` → `fsync(dir)`；对 `state` 用 A/B 双槽 + seq + 校验和（Windows 上目录 fsync 不可用，双槽是唯一可靠兜底）；索引改 append-only jsonl（尾行撕裂可截断，见 R-08）。

**R-04 读-改-写无锁：索引丢条目、配额超卖**
证据：[mirror.mjs#L233-L235](../src/lib/mirror.mjs#L233-L235)（`listBackups()` → `unshift` → 整文件覆盖写）、[mirror.mjs#L287-L294](../src/lib/mirror.mjs#L287-L294)（先删目录后写索引）、[essence.mjs#L492-L497](../src/lib/essence.mjs#L492-L497)（先 `list()` 计数再 `create`）。
- 两个并发 `backup()`：A 读索引 → B 读索引 → A 写 → B 写，**A 的条目丢失**（目录还在，索引没了 = 备份不可见 = 不可恢复）。
- `deleteBackup` 先删目录后写索引：索引写失败 → 索引指向已删内容 → `restore` 返回 `backup-content-missing`。
- 原身：两个并发 `create()` 都读到 9 < 10 → 都创建 → **11 个**。这正是"崩溃后超卖"的同源问题：计数来自**扫描**而不是**账本**。
修复：跨进程锁 + 只追加账本 + reserve/commit 两阶段（§4.1、§4.6）。

**R-05 升级顺序不满足"可恢复"，且状态不一致**
证据：[mirror.mjs#L346-L432](../src/lib/mirror.mjs#L346-L432)。
- 顺序是 备份 → 下载 → 替换 → 写 `meta` → 写 `active/version.json`。备份在替换前，**但从未被校验**——备份是"替换的许可证"，一张没验证的许可证等于没有。
- 写 `meta` 失败（或崩溃在 `swapActive` 之后、`writeMeta` 之前）→ `active` 是新版、`meta.version` 是旧版，`detectActiveVersion()` 又优先读 `active/version.json`（[mirror.mjs#L164-L168](../src/lib/mirror.mjs#L164-L168)）→ 版本出现**三个真相**。
- 无意图日志：重启后无从判断"上次替换到哪一步了"。
- compat 门禁失败时返回 `{ok: true, reason: 'compat-gate-failed'}`（[mirror.mjs#L396-L405](../src/lib/mirror.mjs#L396-L405)）→ 对外是"升级成功但子插件关闭"，没有显式的"已安装待验证"状态，也没有一键回滚入口。
- 门禁在**主进程内** `import()` 新版本模块（[compat.mjs#L84-L97](../src/lib/compat.mjs#L84-L97)），模块顶层副作用/崩溃会污染正在服务的进程。
修复：意图日志 + 唯一提交点 + 显式 `verification` 状态 + 回滚=指针切换 + 门禁放子进程（§4.4）。

### 2.2 P1 — 会放大故障、拖垮磁盘或让运维失去判断力

| # | 问题 | 证据 | 影响 | 修复 |
|---|---|---|---|---|
| R-06 | 自动备份失败不推进 `nextBackupAt` | [mirror.mjs#L309-L326](../src/lib/mirror.mjs#L309-L326) | 每 60s 重试一次全量拷贝 → **重试风暴**，IO 打满、日志刷屏 | 失败也推进（指数退避），并记 `lastBackupError` |
| R-07 | 无保留/剪枝策略 | CHANGELOG v3.0.2 明示"自动备份清理仍待实现" | 备份只增不减 → 磁盘耗尽 → 前一个备份失败 → 恶性循环 | GFS 保留 + 三重保护（§4.8） |
| R-08 | 索引是"整文件覆盖写"，非追加 | [mirror.mjs#L235](../src/lib/mirror.mjs#L235)、[#L292](../src/lib/mirror.mjs#L292) | 任何一次写失败/撕裂 = **全量索引**丢失 | append-only jsonl（seq+crc），可从目录重建 |
| R-09 | 备份版本标签取自 `meta.version`，不是内容 | [mirror.mjs#L229](../src/lib/mirror.mjs#L229) | 版本漂移时恢复点**标签错误** → 恢复到错误版本 | manifest 记录真实 `VERSION.json` 内容 + digest |
| R-10 | `deleteBackup` 允许删掉最后一个恢复点 | [mirror.mjs#L287-L294](../src/lib/mirror.mjs#L287-L294) | "母体不可删"被绕过：**唯一回滚锚点可被删** | I2 保护：最后 SEALED / 当前锚点 / pin / baseline 不可删 |
| R-11 | `getStatus` 每次全树扫描 | [mirror.mjs#L174-L193](../src/lib/mirror.mjs#L174-L193)，`dirSize` 上限 200000 静默截断 | UI 8s 轮询 × 大目录 → IO 放大；超限后**大小静默失真** | 大小随 generation 记账，缓存；超限要报错不要截断 |
| R-12 | 无磁盘预检 | 全链路 | 拷贝到 99% 时 ENOSPC → 半成品目录 | 预检 `free ≥ 2.5 × activeSize`；ENOSPC 时清理并按序失败 |
| R-13 | `readMeta` 把"文件缺失"与"内容损坏"都返回 `{}` | [essence.mjs#L743-L745](../src/lib/essence.mjs#L743-L745) | 半创建目录 → `parentId` 为 `undefined` 而非 `null` → **不计入任何配额**、不出现在列表、永远不被回收 | 三态：missing / corrupt / ok；corrupt 必须告警 |
| R-14 | `recompute` 先删 `merged/` 再重建 | [essence.mjs#L778-L801](../src/lib/essence.mjs#L778-L801) | 崩溃在中间 → merged 为半成品，而 `meta.status` 仍是 `ready` + 旧指纹 → 被当作新鲜 | 先置 `stale`，物化到 `.new` 后原子替换，最后写指纹 |
| R-15 | `saveOverlay` 非原子写 patch 文件 | [essence.mjs#L763-L773](../src/lib/essence.mjs#L763-L773) | 撕裂写 → overlay 损坏 → 该原身永久 conflicted | 走 `writeFileAtomic` + fsync |
| R-16 | 备份/升级/恢复无审计事件 | 全链路 | 出事无法归因（谁在何时替换了镜像） | 落 audit ledger：`mirror.backup/restore/upgrade/rollback/prune` |

### 2.3 P2 — 一致性细节

- **R-17** `restore` 覆盖 `installedAt`，且不记录 `restoredFrom`（[mirror.mjs#L272](../src/lib/mirror.mjs#L272)）→ 丢失安装时间语义，审计链断。
- **R-18** `getStatus()` 在 GET 路径上写盘（[mirror.mjs#L196-L206](../src/lib/mirror.mjs#L196-L206) 补目录/补 meta）→ GET 产生写竞争；并发 GET 可能互相覆盖 meta。
- **R-19** `usageProvider` 里 `activeEssenceCount` 硬编码 0（[orchestrator.mjs#L1121-L1126](../src/plugins/orchestrator.mjs#L1121-L1126)）→ 状态面板说谎。
- **R-20** 索引无去重（[mirror.mjs#L144-L161](../src/lib/mirror.mjs#L144-L161)）→ 重试写入的重复条目会让 UI 与磁盘占用双计。

### 2.4 需求与实现的对齐差异（需要产品决策）

| 需求 | 现实现 | 差异 |
|---|---|---|
| 每原身活跃会话 ≤ 10 | `VIP_QUOTAS.maxActiveSessions` = 10/10/30/50/100（[essence.mjs#L46-L52](../src/lib/essence.mjs#L46-L52)） | 高 tier 放宽到 30–100，与"每原身 ≤10"不一致。**建议**：会话额度恒定 10（归档不限），tier 只决定原身/子原身数量；若要保留 tier 弹性，需产品确认并写进测试表驱动 |
| 原身配额 5/10/30/50/100 | `maxEssences` 与 `maxSubEssences` 同值 | 若"子原身"应有独立额度，需拆表 |
| 仅母体可升级/回退 | 无"删除镜像" API ✅，但 `swapActive` 存在事实上的删除路径 ❌、最后备份可删 ❌ | 需要 I1/I2 的机制性保证，不能只靠"没有这个 API" |
| 会话数据独立于原身目录 | 会话在 `$DSH_HOME/sessions/<workspaceKey>/<sessionId>/`，**按 workspace 分层**，无 essenceId 维度 | 缺"每原身一个会话文件夹"的键；且删除原身与删除会话之间没有隔离契约 |

---

## 3 推荐目录 schema

### 3.1 全景

```text
<dataRoot>/
├── mirror/                                  # 文件夹 1：唯一可升级/回退，不可删除
│   ├── LAYOUT.json                          # schema 版本 + 生成规则标识（写入即 fsync）
│   ├── state.a.json / state.b.json           # 指针双槽：{seq, generation, version, digest, committedAt}
│   ├── journal/                              # 意图日志（append-only，每段 fsync）
│   │   └── 000123-<txn>.jsonl
│   ├── generations/                          # 不可变代（新增即封存，永不原地修改）
│   │   └── gen-0007-3.0.4/
│   │       ├── profile/ …                    # 镜像内容（= 今天的 active/）
│   │       ├── VERSION.json                  # version / build / installedAt / source / digest
│   │       └── MANIFEST.json                 # 每文件 sha256 + size；封存时生成
│   ├── backups/
│   │   ├── auto/20261102T211500Z-gen0007/    # 自动备份（6/12/24h 滚动）
│   │   ├── manual/20261102T220000Z-gen0007/  # 手动恢复点
│   │   └── …（每份含 MANIFEST.json + SEALED；SEALED 才是"备份存在"的定义）
│   ├── index/backups.jsonl                   # 只追加索引（seq + crc32）；可从目录重建
│   ├── locks/mirror.lock                     # 跨进程互斥（pid/host/bootId/heartbeat）
│   ├── trash/                                # 待删（先 rename 进来，再异步删除）
│   └── active → generations/gen-0007-3.0.4   # 派生 junction（兼容层，启动时按 state 重建）
│
├── essences/                                 # 文件夹 2：每原身独立文件夹
│   └── <essenceId>/
│       ├── ESSENCE.json                      # 身份/状态/parentId/配额槽位（原子写 + fsync）
│       ├── overlay/{cordis.patch.yml, package.json, settings/*.yaml, credentials/}
│       ├── merged/{profile/, fingerprint.json}   # 可再生：物化到 .new 后原子替换
│       ├── conflicts.json                    # 仅 conflicted 时存在
│       └── tombstone.json                    # 删除中（崩溃恢复用）
│
├── sessions/                                 # 文件夹 3：独立于原身目录，绝不随原身删除
│   └── <essenceId>/
│       ├── SESSIONS.jsonl                    # 会话账本（create/close/archive/unarchive/delete）
│       ├── <workspaceKey>/<sessionId>/       # 与 scanSessionDirs 现有布局兼容
│       │   └── session.v4.jsonl.zstd
│       └── cold/<sessionId>/                 # 可选：物理冷归档（异步、两阶段）
│
└── quota/                                    # 全局配额账（原子计数，防超卖）
    ├── counters.a.json / counters.b.json     # 双槽：{seq, essences:{used}, perEssence:{subs,sessions}}
    └── leases.jsonl                          # 在途分配租约（TTL），崩溃后可回收
```

### 3.2 设计要点

1. **世代（generation）不可变**：升级 = 新增一代 + 改指针，**永不**删除正在运行的代。"不可删除"从"没有这个 API"升级成"结构上没有这条路径"。
2. **两层提交**：物理提交（`rename` 到 `generations/`）与逻辑提交（`state` 双槽 seq+1）。只有逻辑提交才是"生效"，之前的任何状态都可丢弃。
3. **`active/` 是派生视图**：兼容现有代码的读取路径，启动时按 `state` 重建 junction。指针切换不依赖 junction 切换（Windows 上 junction 重指不原子），因此崩溃安全。
4. **SEALED 语义**：备份目录只有在全文件 fsync 完成、MANIFEST 写完后才出现 `SEALED`；无 SEALED = 半成品 = 不索引、不可恢复、可被清理。
5. **会话按 essence 分文件夹、内部沿用 workspace 布局**：`scanSessionDirs({sessionsDir: <sessionsRoot>/<essenceId>})` 现成可用，零改动复用解析器。
6. **归档用逻辑标记而非移动**：`SESSIONS.jsonl` 记 `archived: true`，活跃计数 = 非归档数。理由见 §4.7——用"移动数据"来执行配额，是最贵也最脆弱的做法。

### 3.3 迁移（从今天的三盘布局）

| 阶段 | 动作 | 兼容性 |
|---|---|---|
| M1 | 新建 `generations/gen-0001-<当前版本>/`，把现有 `active/` 复制並生成 MANIFEST + `state.a.json` | `active/` 保留为 junction，旧代码零改动 |
| M2 | 现有 `backup/<id>/`、`restore/<id>/` 原样迁入 `backups/auto|manual/`，标 `legacy: true`、**不封 SEALED** | legacy 备份需显式 `verify` 通过后才可 restore，且不参与自动剪枝 |
| M3 | `backups.json` 转写为 `backups.jsonl`（一次性），原件留 `.legacy` 备份 | 读路径优先 jsonl，缺失时回退 json |
| M4 | 原身：`meta.json` → `ESSENCE.json`（字段增补 `slot`/`state`），旧名保留一版读取 | 双向可读一个版本周期 |
| M5 | 会话：在 `sessions/<essenceId>/` 下建立目录，把现有 `sessions/<workspaceKey>/…` 归到"母体默认原身"名下 | `scanSessionDirs` 不变 |

---

## 4 关键算法（伪代码）

> 约定：`fsyncFile(f)`、`fsyncDir(d)` 为内核新增原语；`save2Slot(name, obj)` 写 `name.a/b` 中 seq 较大且校验通过者；`lock(key)` 为跨进程锁。

### 4.1 跨进程锁（互斥 + 崩溃可破）

```text
acquire(key, ttlMs):
  loop until deadline:
    try atomic create  <locks>/<key>.lock  (O_EXCL, 内容 = {pid, host, bootId, at, ttl})
      fsyncFile(lock); return handle
    except EEXIST:
      owner = read(<locks>/<key>.lock)
      if owner.bootId != currentBootId or now - owner.at > owner.ttl:
         moveTo(<locks>/<key>.lock, <trash>/stale-<ts>.lock)   # 破锁只在"确定过期"时发生
         continue
      sleep(jitter(50..250ms))
  throw Busy(key)          # 上层返回 {ok:false, reason:'busy'}，绝不排队堆积

release(handle): unlink(lock); fsyncDir(locks)
```

要点：**破锁必须能证明持有者已死**（bootId 变化或 TTL 超时），且破锁动作本身落审计——否则破锁就是下一次丢数据的入口。

### 4.2 备份：copy → seal → 可见

```text
createBackup(kind):            # kind ∈ {auto, manual}
  lock(mirror); try:
    free = statfs(mirrorRoot).free
    need = 1.2 * sizeOf(currentGeneration)
    if free < need + reserveFloor: throw NotEnoughSpace(free, need)   # 预检，不是失败后补救

    txn  = newTxn()
    tmp  = <backups>/<kind>/.partial-<txn>          # 半成品留在 .partial 命名空间
    copyStrict(currentGeneration.profile → tmp/profile)   # 任何单文件失败 → 抛错，不吞
    manifest = { files: [{path, size, sha256}], version: currentGeneration.version, digest, createdAt }
    writeJson(tmp/MANIFEST.json); fsyncTree(tmp)          # 所有文件 + manifest 落盘
    writeFile(tmp/SEALED, txn); fsyncFile; fsyncDir(tmp)  # ← 提交标记
    rename(tmp → <backups>/<kind>/<backupId>)             # 同一卷；此时才"存在"
    fsyncDir(<backups>/<kind>)
    append(index/backups.jsonl, {seq, backupId, kind, digest, bytes, version, at, crc})
    advance(nextBackupAt)                                 # 成功/失败都要推进（R-06）
    audit('mirror.backup', …)
  finally: unlock()
```

失败路径：`.partial-*` 目录移入 `trash/` 后异步删除；索引不写；调用方拿到结构化错误。**任何时刻"可见的备份"都等于"校验过的备份"。**

### 4.3 升级：备份 → 校验 → 意图 → 换代 → 提交 → 验证 → 清理

这是"已备份再替换"的完整形式。括号内是崩溃后的恢复动作。

```text
upgrade():
  lock(mirror); txn = newTxn()
 1 CHECK       latest = source.getLatestVersion(); reject if ≤ current（除非 --force）
 2 STAGE       stage = <mirror>/.staging-<txn>
               source.download(latest → stage)
               validate(stage): 无绝对路径 / 无 '..' / 无 reparse point / 文件数≤N / 总大小≤M
                                / VERSION.json 存在 / digest 与官方发布元数据一致
               buildManifest(stage); fsyncTree(stage); write(stage/SEALED)      # 候选已封存
 3 BACKUP      backupId = createBackup(auto)                                     # 回滚锚点
               verifyBackup(backupId)                                             # ← 校验锚点，失败即中止
 4 INTENT      writeFile(journal/<txn>.jsonl, {step:'intent', from, to, backupId, stage, crc})
               fsyncFile; fsyncDir(journal)                                       # 破坏性动作的许可证
 5 PROMOTE     rename(stage → generations/gen-<n>-<latest>); fsyncDir(generations)  # 物理提交（原子）
 6 COMMIT      save2Slot(state, {seq+1, generation: gen-<n>, version: latest, digest, prev})  # ← 唯一提交点
 7 INDEX/AUDIT append(journal/..., {step:'committed', seq}); audit('mirror.upgrade', …)
 8 VERIFY      verification = runCompatGateInChildProcess()          # 子进程 + 超时；不污染主进程
               write(state.verification = ok|failed|timeout)
 9 PRUNE       keep ≥2 代 + 保留策略；旧代 → trash/ 异步删                              # 可中断、可重入
```

失败退出表（这是评审时最该逐行确认的表）：

| 失败点 | 磁盘现状 | 指针 | 恢复动作 | 用户可见 |
|---|---|---|---|---|
| 2 下载/校验 | 候选在 `.staging` | 未动 | 删候选 | 升级失败，版本不变 |
| 3 备份失败 | 可能 `.partial` | 未动 | 删半成品 | 升级中止（**不替换**） |
| 4 意图写失败 | 候选已封存 | 未动 | 删候选 | 升级中止 |
| 5 前崩溃 | 有 INTENT 无新代 | 未动 | 按意图回滚：删候选 | 版本不变 |
| 5 后 6 前 | 新代已存在 | **未动** | 删除新代（未提交 = 未生效） | 版本不变 |
| 6 后 | 新代 + 指针 | 已提交 | 保持新代；7–9 幂等重放 | 升级成功 |
| 8 失败 | 新代 + 指针 | 已提交 | **回滚 = 指针切回上一代**（秒级，不复制） | "已安装待验证/已回滚" |

关键收益：**回滚从"从备份恢复（分钟级、且依赖备份可信）"变成"指针切换（秒级）"**；备份退回它应有的角色——只对付磁盘损坏和误删。

### 4.4 启动恢复（boot recover / fsck）

```text
bootRecover():
  lock(mirror)
  # 1 意图重放
  for txn in journal where !has('committed') and has('intent'):
      if not exists(intent.generationDir): discardStage(intent.stage); mark(txn,'aborted')
      else if state.generation != intent.to: mark(txn,'needs-review')     # 不擅自改指针，报人工
  # 2 选指针：双槽取 seq 最大且 self-digest 通过者
  st = read2Slot(state)
  if st == null: → 尝试从 generations/ 里 latest 有 SEALED+MANIFEST 的代重建；仍失败则 fail-closed
  # 3 校验当前代
  if not verifyManifest(st.generation): 
      log FATAL; st = fallbackTo(st.prevGeneration) ?? fallbackTo(latestSealedBackup)
      if still null: return REFUSE_START   # 宁可不启动，也不以半棵树服务
  # 4 派生视图修复
  ensureJunction(active → generations/<st.generation>)
  # 5 索引重建
  if indexCorrupted(): quarantine(index); rebuildFromDirs(backups/**/SEALED)
  # 6 半成品清理
  moveToTrash(<backups>/**/.partial-*, .staging-*, .swap-*)
  # 7 配额对账
  quota.reconcile(physicalScan)        # 见 4.6：只许向上修正
  unlock(); return st
```

`fsck` 与 `bootRecover` 共用同一套校验函数（不重复实现），并且 `fsck --deep` 做全量 sha256、`--fast` 只比 size+mtime。

### 4.5 配额：reserve → commit → tombstone（不超卖）

核心思路是把"数一数现有几个"换成"先占坑、再落盘、最后提交"。数据库里这叫两阶段占用，这里用文件系统实现。

```text
reserve(kind, essenceId):          # kind ∈ {essence, subEssence, session}
  lock(quota); try:
    purgeExpiredLeases()                        # TTL 到期 = 持有者已死
    c = readCounters()                          # 双槽
    phys = physicalCount(kind, essenceId)       # 目录扫描（昂贵，低频）
    c.used = max(c.used, phys)                  # I4：只许向上修正，防"误删后低估"
    if c.used + activeLeases(kind) >= limit(kind, essenceId, c.tier):
        return {ok:false, reason:'quota-exceeded', used:c.used, limit}
    lease = {leaseId, kind, essenceId, expiresAt: now+30s}
    append(leases.jsonl, lease + crc); fsyncFile
    return {ok:true, leaseId}
  finally: unlock()

commit(leaseId):                   # 实体已落盘（ESSENCE.json 已原子写）后调用
  lock(quota); try:
    c = readCounters(); c.used += 1; c.seq += 1
    save2Slot(counters, c)                      # 双槽提交
    append(leases.jsonl, {leaseId, state:'committed'}); fsyncFile
  finally: unlock()

create(kind, essenceId):
  r = reserve(kind, essenceId); if !r.ok: return r
  dir = <essences>/<newId>
  mkdir(dir); writeJsonAtomic(dir/ESSENCE.json, {…, state:'creating', leaseId})   # 已 fsync
  recompute(newId)                                                               # 可失败，不阻塞提交
  commit(r.leaseId)                                                              # 计数与实体同源
  return ok

# 崩溃矩阵
崩溃在 reserve 之后、commit 之前 → 租约过期被回收；目录带 state:'creating'
                                  → 启动时 moveToTrash（不占额度、不计入列表）
崩溃在 ESSENCE.json 写之前       → 空目录 → 启动清扫
崩溃在 commit 之后               → 计数已含；实体存在；一致
```

删除（二阶段，保证"不会减两次"）：

```text
remove(essenceId):
  lock(quota); write(tombstone.json, {phase:'tombstoned', leaseId: -1}); fsync; unlock()
  rename(<essences>/<id> → <trash>/<id>); fsyncDir                      # 原子"消失"
  lock(quota); c.used -= 1; save2Slot(counters); unlock()               # 幂等：tombstone 里有 applied 标记
  removeTree(<trash>/<id>)                                              # 物理删除可延后、可失败、可重试
```

**为什么这就不会超卖**：准入判断在锁内读"账本 + 在途租约"，账本只由 commit 增长、只由 tombstone 幂等减少；崩溃留下的任何中间态要么被租约回收，要么被物理扫描**向上**修正。没有任何路径会读到偏低的计数。

### 4.6 会话：活跃计数与归档

```text
createSession(essenceId, title):
  r = reserve('session', essenceId); if !r.ok: return {ok:false, reason:'active-limit', …}
  sid = newSessionId()
  mkdir(sessions/<essenceId>/<workspaceKey>/<sid>)
  append(sessions/<essenceId>/SESSIONS.jsonl, {seq, sid, state:'active', at, crc}); fsyncFile
  commit(r.leaseId)

archiveSession(essenceId, sid):          # 逻辑归档：只改账本，不移动数据
  lock(sessions/<essenceId>)
  append(ledger, {seq, sid, state:'archived', at, crc}); fsyncFile
  # 活跃计数 = count(state == 'active')，归档后自然释放额度
  audit('session.archive', …)

coldArchive(essenceId, sid):             # 可选：物理冷归档，异步、两阶段
  append(ledger, {sid, state:'archiving'}); fsync
  rename(<ws>/<sid> → cold/<sid>); fsyncDir          # 同卷原子
  append(ledger, {sid, state:'cold'}); fsync
```

为什么归档用标记不用移动：移动要跨目录、要处理 `session.v4.jsonl.zstd` 正在被追加写的窗口、还要让 `scanSessionDirs` 同时扫两处。**用一个 append-only 账本表达状态，代价是一行 jsonl；用移动表达状态，代价是一次崩溃一致性问题。**

### 4.7 保留与剪枝（三重保护）

```text
prune():
  protected = { state.generation.prevGeneration,        # 当前回滚锚点
                latestSealed(each bucket),              # 每桶最新
                all pinned,                             # 用户 pin
                baselineGeneration,                     # 初始安装（永久）
                all where now - createdAt < minRetentionDays }
  for b in sealedBackups oldest→newest:
     if b in protected: continue
     if withinGFS(b, keep={daily:7, weekly:4, monthly:6}) or !exceedsBudget(): continue
     append(index, {op:'tombstone', backupId}); fsync
     rename(b → trash/); fsyncDir
     async removeTree(trash/…)
```

预算两条线：条数（GFS）与字节（`backupBudgetBytes`）。**先保字节预算**——磁盘满导致备份失败，比备份多留几份危险得多。

### 4.8 恢复演练（restore drill，定时、只读生产）

```text
drill():                                  # 由 orchestrator 定时（建议每日一次，低峰）
  pick = latestSealedBackup()
  if pick == null: return {ok:false, reason:'no-recovery-point'}       # 不是 ok:true
  t0 = now
  tmp = <verify>/<ts>
  restoreSealedTo(pick, tmp)              # 只读生产目录，写入独立临时区
  assert verifyManifest(tmp)              # 逐文件 sha256
  assert smoke(tmp): VERSION.json 可解析 / cordis.patch.yml 可解析 / 内核入口可导入
  rto = now - t0
  record({backupId, ok, rtoMs, at})
  if !ok or rto > rtoBudget: alert('restore-drill-failed', rto)
  removeTree(tmp)
```

这条是整篇文章的重点：**没跑过恢复的备份不叫备份**。drill 的产物（最近一次成功时间 + 实测 RTO）必须出现在 `getStatus()` 里，和 `lastBackupAt` 并列——否则运维只会看"上次备份时间"，永远不会看"上次恢复成功时间"。

---

## 5 fsync 与崩溃一致性边界

| 操作 | fsync 点 | 断电后的可见性 | Windows 备注 |
|---|---|---|---|
| 写 `state` / `counters` | 写 tmp → `fsync(file)` → rename → `fsync(dir)` | 要么旧值要么新值 | 用 A/B 双槽 + seq + 自校验兜底 |
| 追加 jsonl 账本 | `append` 后 `fsync(file)` | 尾部可能撕裂（正常） | 读取时截断到最后一条 crc 通过的行 |
| 备份文件 | 每个文件 `fsync` 后才写 `SEALED` | 无 SEALED = 不存在 | 必须显式 `fsync`，NTFS 不保证 lazy write 顺序 |
| `mkdir` / `rename` / `rmdir` | `fsync(parent dir)` | 目录项可能丢失 | Node 无法 fsync 目录 → 靠"重建 + 校验"而非"假设" |
| overlay / settings 写入 | `writeFileAtomic` + `fsync` | 旧值可用 | 同上 |
| 会话 jsonl 追加 | 每条消息后 `fsync`（或 2s 组提交） | 丢最后 ≤1 条 | 组提交可显著降 IO |

**内核侧需要新增的原语**（当前 [fsx.mjs](../src/kernel/fsx.mjs) 没有）：`fsyncFile`、`fsyncDir`、`copyTreeStrict`（失败必抛）、`removeTreeStrict`、`swapDirAtomic`（带意图日志）、`save2Slot`/`read2Slot`、`appendJsonlSealed`（带 seq+crc、读时截断）、`verifyManifest`。这些是零依赖可实现的（crc32 用 256 项查表，约 20 行）。

---

## 6 路径安全规则集

```text
safeSegment(s, {maxLen=64}):
  reject if s == '' or s.length > maxLen
  reject if s ∈ {'.', '..'}
  reject if /[\/\\:*?"<>|\x00-\x1f]/     # 分隔符、盘符、通配、控制字符
  reject if /[. ]$/                       # Windows 尾点/尾空格
  reject if base(s).upper ∈ RESERVED      # CON PRN AUX NUL COM1..9 LPT1..9
  reject if s !== s.trim()

resolveInside(root, segments):
  for s in segments: safeSegment(s)
  abs = path.resolve(root, ...segments)
  if !startswith(abs, realpath(root) + sep): reject      # 包含性
  for each existing ancestor between root and abs:
     if isReparsePoint(ancestor): reject                 # 不允许穿越链接逃逸
  if win32 and abs.length > 240: reject 'path-too-long'  # 明确报错，别等 ENOENT
```

配套三条：

1. **大小写折叠**：Windows/macOS 上 `Foo` 与 `foo` 是同一实体 → 建目录前按 `toLowerCase()` 查重，否则配额与列表都会重复计数。
2. **备份不得携带外部链接**：[fsx.mjs#L157-L162](../src/kernel/fsx.mjs#L157-L162) 把 symlink 原样重建为 junction，若镜像目录里有指向 `C:\` 的链接，备份会**忠实复制这个逃逸点**，restore 后仍在。→ 备份时把 reparse point 记为 manifest 的 `link` 条目（含目标），restore/verify 时要求目标必须落在代内，否则拒绝。
3. **下载内容特殊对待**：`officialSource.download()` 写入 staging 的可能是压缩包解出的树 → 必须做 zip-slip 校验（§4.3 步骤 2），这是唯一由外部数据决定路径的地方。

---

## 7 可落地测试清单

前置改造（否则测不了）：`MirrorManager` / `EssenceManager` 接受注入的 `fsApi` 与 `clock`（[session-format.mjs](../src/lib/session-format.mjs) 已是这个模式），并提供 `fault(point)` 钩子，使"在某个具名步骤抛 EIO"可编程。**没有可注入的故障点，崩溃一致性就只能靠人肉猜测。**

### A. `test/mirror-atomic.test.mjs` — 替换与指针（6）

| # | 用例 | 注入 | 断言（不变量） |
|---|---|---|---|
| A1 | 删除旧代与改名之间被杀 | 真子进程 SIGKILL | 重启后 `active` 可用，版本 ∈ {旧, 新}（I1） |
| A2 | 目标目录被占用导致 rename 失败 | fsApi 抛 EBUSY | 返回结构化错误；`active` 仍是旧代完整树；无混合树 |
| A3 | 并发两次 upgrade | 同时调用 | 第二个返回 `busy`/`already-latest`；只产生一代新目录 |
| A4 | 备份与升级并发 | 同时调用 | 备份 digest ∈ {旧代, 新代}，绝无"半替换"快照 |
| A5 | 写 `state.a` 后崩溃 | fault('after-state-a') | 读到 `state.b`（旧 seq），行为等价于未提交 |
| A6 | 两槽都损坏 | 破坏两个文件 | 明确 `REFUSE_START` + fsck 指引，**不静默降级** |

### B. `test/backup-seal.test.mjs` — 完整性（10）

| # | 用例 | 断言 |
|---|---|---|
| B1 | 拷贝中途 EIO | 无 `SEALED`、索引无条目、`.partial` 进 trash |
| B2 | 单文件截断 1 字节 | `verifyManifest` FAIL；不可 restore；不参与剪枝 |
| B3 | manifest 多/少/改一文件 | 与 B2 同族，错误信息指明文件 |
| B4 | 正常备份 | SEALED 存在；restore 后逐文件 digest 相同 |
| B5 | 索引尾部半行 | 读时截断到最后有效记录，其余备份仍可见 |
| B6 | 索引整体损坏 | 从 `backups/**/SEALED` 重建；原件进 quarantine |
| B7 | ENOSPC | 预检拒绝，不产生 `.partial`；已有备份不受影响 |
| B8 | 剪枝保护 | 最后 SEALED / 当前锚点 / pinned / baseline 一个都不删 |
| B9 | 删除后崩溃在 trash 前 | 重启续做，索引与磁盘一致（无悬空条目） |
| B10 | `backupId` 路径穿越 / 保留名 | 全部拒绝；`../`、绝对路径、`CON` 三类各一例 |

### C. `test/upgrade-order.test.mjs` — 顺序与回滚（9）

| # | 用例 | 断言 |
|---|---|---|
| C1 | 备份失败 | 未下载、未替换（断言调用序列） |
| C2 | 备份校验失败 | 同上——**校验**是替换的前置条件，不只是"备份目录存在" |
| C3 | staging 含 `../` 或绝对路径 | 拒绝；指针未动 |
| C4 | 物理提交后、逻辑提交前崩溃 | 重启：旧代生效；新代被清理（I3） |
| C5 | 逻辑提交后崩溃 | 重启：新代生效；旧代仍在（I2） |
| C6 | compat 门禁失败 | `state.verification='failed'`；不返回"成功"；可直接回滚 |
| C7 | 门禁超时/子进程崩溃 | 主进程仍服务；状态可查询 |
| C8 | 回滚耗时 | < 1s，无复制；generation 未被删除 |
| C9 | A→B→C 连续升级后回滚到 B | B 可启动；C 仍在磁盘待清理 |

### D. `test/quota-ledger.test.mjs` — 不超卖（10）

| # | 用例 | 断言 |
|---|---|---|
| D1 | 并发 100 次 create（free/5） | 恰好 5 成功、95 拒绝；`counters.used == 5` |
| D2 | reserve 后崩溃 | 租约过期回收；计数不变 |
| D3 | 目录已建、未 commit 崩溃 | 启动清扫进 trash；不计入列表；不占额度 |
| D4 | 删除后崩溃（各阶段） | 计数只减一次（幂等）；重放安全 |
| D5 | 物理数 > 账本（人为多建） | 准入按物理数（fail-closed）；触发 reconcile 告警 |
| D6 | 物理数 < 账本（误删） | 保持账本值 + 告警；不擅自下调（防超卖） |
| D7 | 子原身配额 | 表驱动 5/10/30/50/100，逐父独立计数 |
| D8 | 降级 tier 后 used > limit | 拒绝新建、保留存量、返回明确原因；不删数据 |
| D9 | 两个 node 进程并发 create | 文件锁串行；仍不超卖（跨进程，不只是同进程） |
| D10 | counters 损坏 | 从目录重建并取 max；绝不静默归零 |

### E. `test/session-quota.test.mjs` — 会话层（6）

| # | 用例 | 断言 |
|---|---|---|
| E1 | 第 11 个活跃会话 | 拒绝；归档一个后放行；归档数不计入 |
| E2 | 归档后重启 | 计数正确（账本重放）；`scanSessionDirs` 结果与账本一致 |
| E3 | 冷归档崩溃 | 目录要么在 `<ws>/` 要么在 `cold/`，不会两处都在 |
| E4 | 删除原身 | 会话仍在 `sessions/<id>/`；显式回收 API 才能删 |
| E5 | 镜像升级/回滚 | 会话目录 digest 前后一致（I6） |
| E6 | 账本尾行撕裂 | 截断后可读，计数正确 |

### F. `test/path-safety.test.mjs` — 隔离（6）

| # | 用例 | 断言 |
|---|---|---|
| F1 | `safeSegment` 黑名单 | `..`、`a/b`、`a\b`、`C:`、NUL、尾点、CON/NUL/COM1、空串、65 字符 |
| F2 | 大小写冲突 | `Foo`/`foo` 视为同一实体，拒绝第二个 |
| F3 | 链接逃逸 | 原身目录内 junction 指向 root 外 → 拒绝；restore 的 manifest 含外部链接 → 拒绝 |
| F4 | `..` 穿越 | `<root>/a/../../x` 解析后越界 → 拒绝 |
| F5 | 长路径 | 超 240 报 `path-too-long`，不是 ENOENT |
| F6 | essences 目录中的怪异名 | 不进入 `list()`、不影响计数（配合 R-13 三态读取） |

### G. `test/recovery-boot.test.mjs` — 自愈（5）

| # | 用例 | 断言 |
|---|---|---|
| G1 | 半创建原身（无 ESSENCE.json） | 进 trash；不出现在列表；不占额度 |
| G2 | merged 半物化 | `status=stale` + 重算；不把半成品当 ready（R-14） |
| G3 | 物化中途崩溃 | 旧 `merged/` 仍可启动（先写 `.new` 再换） |
| G4 | overlay 撕裂写 | 旧值可用（原子写 + fsync） |
| G5 | 多个 `.partial-*` / `.staging-*` / `.swap-*` | 启动全部进 trash；不残留 |

### H. `test/restore-drill.test.mjs` — 演练（5）

| # | 用例 | 断言 |
|---|---|---|
| H1 | 正常演练 | manifest 校验 + 冒烟通过；记录 rtoMs |
| H2 | 人为破坏一字节 | 演练失败并告警；生产目录未被触碰 |
| H3 | 无任何 SEALED | 返回 `no-recovery-point`（不是 ok） |
| H4 | RTO 超预算 | 记录 `rtoExceeded=true` 并告警 |
| H5 | 连续 10 次演练 | 无临时目录泄漏、无 fd 泄漏 |

**合计 57 条**（A6+B10+C9+D10+E6+F6+G5+H5）。现有 `test/mirror.test.mjs` 16 条与 `test/essence.test.mjs` 23 条以功能与边界为主（配额上限、fatal 冲突、不存在的备份等负例都已覆盖），但**无一覆盖崩溃注入、并发竞争、完整性校验失败**——这是"看起来有测试"和"有可靠性保障"的差别。

---

## 8 验收门槛（Definition of Done）

1. **崩溃矩阵**：19 个提交点前后 × 各 3 次 SIGKILL，**0 次**出现"active 不可用"或"混合树"。
2. **不超卖**：1000 次并发 create（含跨进程）后 `物理数 == 账本数 == 成功数`，且 ≤ limit。
3. **备份可信**：随机损坏 20 个备份中的 1 个文件，`fsck` 全部识别，且损坏备份 100% 拒绝 restore。
4. **恢复演练**：连续 7 天每日演练通过；实测 RTO p95 ≤ 60s；状态面板同时展示 `lastBackupAt` 与 `lastSuccessfulRestoreAt`。
5. **回滚**：升级后回滚 < 1s，且不依赖备份目录可用。
6. **路径安全**：F1–F6 全绿；含一次真实 junction 逃逸尝试被拒。
7. **可观测**：`mirror.backup/restore/upgrade/rollback/prune`、`quota.reserve/commit/reclaim`、`session.archive` 全部落审计。

---

## 9 与现有代码的差量

| 模块 | 改动 | 规模 |
|---|---|---|
| `src/kernel/fsx.mjs` | 新增 `fsyncFile/fsyncDir/copyTreeStrict/removeTreeStrict/save2Slot/appendJsonlSealed/verifyManifest`；`copyTree` 改可选严格模式（默认保持宽松以免破坏现有调用方） | M |
| `src/lib/mirror.mjs` | 重写提交路径：generation + state 双槽 + journal + MANIFEST/SEALED + 锁 + 保留 + 从 `active/` 读改为 `state→generation`（`active/` 作兼容视图） | L |
| `src/lib/essence.mjs` | 配额改 reserve/commit；`readMeta` 三态；`remove` 加 tombstone；`recompute` 先置 stale、物化到 `.new`；`saveOverlay` 原子写 | M |
| `src/lib/compat.mjs` | 门禁移入子进程（`child_process` + 超时），结果写入 `state.verification` | S |
| `src/lib/quota.mjs`（新） | 账本 + 租约 + reconcile，供 essence 与会话共用 | M |
| `src/lib/sessions.mjs`（新） | 账本 + 活跃计数 + 归档标记 + 冷归档 | M |
| `src/plugins/orchestrator.mjs` | 接线新服务；`getStatus` 加 `lastSuccessfulRestoreAt`/`verification`；定时 drill | S |
| `docs/MIRROR.md` / `docs/ESSENCE.md` | 更新布局与语义（本文可作 v4 设计依据） | S |

建议节奏：**先 fsx 原语 + R-01/R-02/R-03（提交与校验）→ 再 R-04/R-05（锁与顺序）→ 再配额账本 → 最后路径加固与 drill**。前两步不做，后面每一步都在沙上盖楼；而 R-07（保留策略）必须排在 R-03 之后——**在索引可能静默归零的时候加自动清理，等于给数据加了一个定时删除器**。
