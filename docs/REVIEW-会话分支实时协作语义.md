# 评审：会话/分支实时协作语义（分身 1:1 会话 · 多分支 · 单写者 · 归档保留）

- 评审对象：提案「分身 ↔ 会话严格 1:1；同一会话可派生多分支（git branch 式：共享 base、独立后续）；分支切换；单写者；归档保留；日志 append-only，持久化于 `sessions/<essence>/<session>/branches/<branch>/`」。
- 代码基线：`src/lib/session-format.mjs`（会话格式纯函数层）、`src/plugins/session-catalog.mjs`（母体只读目录）、`src/plugins/orchestrator.mjs`（派生/归档/会话列举）、`src/kernel/{fsx,ledger,paths,role,mutex}.mjs`（原子写、链式账本、布局、角色、锁）；对照 `src/lib/{status-store,upgrade-coordinator,mirror-etag}.mjs` 与 `docs/REVIEW-三区隔离与快照回流.md`（下称「三区评审」）的 §4/§5/§7/§9/§11。
- 结论口径：**模型对，三处前提要改。** 分支 = 「前缀锚定 + 独立段」而不是字节复制；存储位置不能落在母体 `$DSH_HOME/sessions`；单写者不能靠进程内互斥。改掉这三条，剩下的开关（切换、UI、恢复、接口、测试）都有现成机制可挂——不改，第一周就会撞上三个必然事故（半帧 base、Windows 非原子提交、两个进程各写一个分支）。

---

## 0. 评审门槛：动工前必须先钉死的 7 件事

| # | 前提 | 现状（证据） | 不修的后果 |
|---|---|---|---|
| B1 | 分支数据写在哪 | 提案路径 `sessions/<essence>/<session>/branches/<branch>/` 落在 `$DSH_HOME/sessions` 下；而 `resolveSessionsLayout` 明写「母体只读，绝不可写这些路径」（`src/kernel/paths.mjs:111-114`），`sessionCatalog` 自述 `readOnly: true`（`session-catalog.mjs:605-606`），`session-format.mjs` 全模块零 import、只读（`:1-17`） | 一旦实现就打破了这条产品的第一约束；母体与运行时的写者身份在同一目录里重叠，审计与回滚都无法归因 |
| B2 | 「分支」是不是复制 | 提案用「分支复制」描述创建；代码里唯一相近的先例是 `importSessionIntoFork` 的整文件 `copyFileSync`（`orchestrator.mjs:343-345`），且有 `importMaxBytes` 上限（`:339`） | 复制既不是原子的（写者在追加），也不便宜（见 §2）。200 MB 日志 × 8 分支 = 1.6 GB，归档卡的「home 1.2 GB」直接失真 |
| B3 | 能否「切换」 | 会话日志由**分身运行时**持有并追加，fang 只读（`session-catalog.mjs:3-11`）；运行时是否允许按路径打开/换日志，代码库内无任何证据 | 若不能，所谓「切换」只能是「从分支派生一个新分身」——这不是措辞问题，是 P1 的形状问题。必须先做 5 分钟 spike（§3.5） |
| B4 | 单写者的锁在哪 | 仓内唯一互斥是 `KeyedMutex`，进程内 per-key 链（`mutex.mjs:6-25`）；母体与分身是**两个进程**（`orchestrator.mjs:479-491` 传 `DSH_FANG_*` env 后 spawn） | 用 KeyedMutex 保证「单写者」等于没保证；两个母体窗口、双标签页、重启重试都能同时通过 |
| B5 | 提交是否原子 | `writeFileAtomic` 在 `renameSync` 失败时**退化为 `copyFileSync`**（`fsx.mjs:48-63`），注释自陈「Windows 在读者持句柄时会拒绝 rename」 | 任何「原子」结论只要建在这个函数上就不成立。refs 清单必须换双槽提交（§5.4），不能直接复用 |
| B6 | 1:1 今天成立吗 | 不成立：`listForkSessions` 返回一个分身的**会话列表**（`orchestrator.mjs:806-857`）；`importSessionIntoFork` 还会往分身 home 塞进第二个（外来）会话（`:333-375`） | 分支切换器挂在「会话」上，而「哪个会话算这个分身的会话」没有权威答案；切换器会为每个历史会话画一棵分支树 |
| B7 | 日志物理格式 | 现在是多帧 zstd（`session.v4.jsonl.zstd`，帧边界靠 magic 扫描：`session-format.mjs:181-212`），且**截断帧解压返回 0 字节而不抛错**（`:299-304` 注释与实现） | 提案写「append-only JSONL」。数据日志改 JSONL 等于要求上游运行时同时改读法（未知），而 fang 侧段用 JSONL 又让「物化回运行时格式」多一次重编码。这条必须显式二选一（§2.6） |

> 说明：B1/B2/B4 三个是同一个思维惯性的三个面——**把「分支」当成了「一份文件的多个副本」，把「锁」当成了「一个函数调用」**。改成「引用 + 前缀 + 段 + 租约」之后，B3 之外的六条都会塌缩成实现细节。

---

## 1. 语义细化（建议口径）

### 1.1 实体、键与写权

| 层 | 实体 | 键 | 磁盘归属 | 谁写 | 生命周期 |
|---|---|---|---|---|---|
| 镜像 | mirror | 版本号 | `<mirrorRoot>/active` | `MirrorManager` | 长期 |
| 原身 | essence | `essenceId` | `<essencesRoot>/<id>` | `EssenceManager` | 长期 |
| 分身 | fork / task | `taskId` | `<forksRoot>/<taskId>`（自己的 `$DSH_HOME`） | forker | 到删除 |
| 会话 | session | `(workspaceKey, sessionId)` | `<forkHome>/sessions/<workspaceKey>/<sessionId>/` | **分身运行时** | 随 home |
| 分支 | branch | `(taskId, sessionId, branchId)` | 同上目录下的 `branches/<branchId>/` | 运行时（活分支追加）+ fang（元数据/段） | 到删除或 GC |

三条从这张表直接落下来的判定：

1. 分支的键里**必须含 `taskId`**（等价于 home 路径已隔离），因为 `$DSH_HOME` 是每个分身各一份（`paths.mjs:5-7` 的布局注释就是这个意思）。提案里用 `<essence>` 当第一段是**错位的键**：`sessions/` 下的第一段现实是 `workspaceKey`（由工作区绝对路径编码，`session-format.mjs:14`、`:167-172`），不是 `essenceId`。
2. 母体会话**不进分支体系**（或只进「只读切点」）。母体的 `$DSH_HOME` 只读是硬约束，母体运行时也不会把日志交出来。
3. `branchId` 必须与 `sessionId` 同级别的名字校验（`SESSION_ID_RE` 先例 `session-format.mjs:20`；路径防逃逸 `isInside` 先例 `session-catalog.mjs:110-113`）。别用用户输入的分支名做目录名——标题与 id 分离。

### 1.2 分支对象模型：引用 + 前缀 + 段

一个分支不是一份日志，是一条**引用**：

- `branchId`、`parentBranchId`（可空 = 直接挂在会话主干上）、`baseBytes`（父日志的字节前缀长度）、`baseFrames`（帧计数，避免每次读都扫 magic）、`openSeq`（父日志在切点处的最后事件序号）、`createdAt`、`createdBy`、`opId`、`title`。
- 分支自己的增量落在 `segment.v4.jsonl.zstd`（与运行时**同一种物理格式**，理由见 §2.6）。
- 可见日志 = `父分支可见日志[0, baseBytes)` + 本分支段。递归组合，深度上限 32（超过则强制物化一次，把链压平）。

这条定义让「共享 base 历史、独立后续」变成**字面意义**：共享的是字节前缀，不是副本。

### 1.3 目录形状：提案 vs 建议

提案：

```
sessions/<essence>/<session>/branches/<branch>/     ← 三个问题：层级错位、写权越界、扫描器失明
```

建议（纯增量，向后兼容）：

```
<forkHome>/sessions/<workspaceKey>/<sessionId>/
  session.v4.jsonl.zstd          ← 运行时写；这就是「活」分支（main）
  branches/
    refs.a.json / refs.b.json    ← 双槽引用清单（§5.4），唯一真相
    journal.jsonl                ← fang 写：创建/切换/恢复/GC，append-only JSONL
    <branchId>/
      branch.json                ← 元数据（tmp+rename 或双槽）
      segment.v4.jsonl.zstd      ← fang 写的增量段（与运行时同格式）
      index.jsonl                ← (seq, frameBytes, events, at)，用于 O(1) 续读
```

为什么 `branches/` 放在**会话目录内部**是安全的、而 `sessions/<essence>/` 不安全：

- 现有扫描器只看 `<workspaceKey>/<sessionId>/session.v4.jsonl.zstd`，多一层 `branches/` 完全不被读（`session-format.mjs:622-628` 只 stat 这一个文件名）；`branches` 也不匹配 `SESSION_ID_RE`，即便被当成会话目录也会被跳过（`:621`）。
- 反过来，把 `<essence>` 插到 `sessions/` 下会让 `scanSessionDirs` **静默变空**：它会把 `essence` 当成 `workspaceKey`，再往下找不到 `session.v4.jsonl.zstd`，于是 `continue`（`:627-629`）。目录扫描不报错、列表变成 0 条——这是最难查的一类回归。
- 写权也刚好对齐：`orchestrator` 已经在往分身 home 写（`fang-seeds` `:449-453`、导入会话 `:343-345`），**但全部发生在 spawn 之前**（`:446-477` 早于 `:479`）。仓里没有一处向「运行中的分身 home」写文件——分支模块必须继承这个习惯，这就是 §3.5 推荐「重启式切换」的根据。

母体侧的只读索引（可选，只为「从母体会话派生分支」的展示）：`<fangDataDir>/sessions/<sessionId>/refs.json`，只存切点元数据，**不存日志副本**。

### 1.4 三个词必须分开叫

| 概念 | 是什么 | 成本 | 谁写 |
|---|---|---|---|
| **ref（引用）** | 一条 `(parent, baseBytes, …)` 元数据 | O(1)，一次槽提交 | fang |
| **segment（段）** | 该分支独有的后续事件 | O(新增字节) | fang（或运行时，取决于 §3.5 的结论） |
| **checkout（物化）** | 把「父前缀 + 段」拼成一个新的运行时日志 | O(size)，仅切换时 | fang，持租约时 |

把三者混称「复制」正是 B2 的来源。产品文案里也只允许出现「创建分支（0 秒）」「切换到该分支（需要停止并重启会话，3–8 秒）」。

### 1.5 单写者与所有权

| 分支状态 | 谁可写 | 运行时可见 | 允许动作 |
|---|---|---|---|
| `main-live` | 分身运行时（唯一） | 是（就是这份日志） | 读、建分支、归档、**不可切换** |
| `pinned` | 无（只读） | 否 | 读、切换（需停运行时）、建子分支、删除（无子分支时） |
| `checkout-pending` | fang（物化中） | 否 | 取消；其它一律 409 |
| `materialized` | 无 | 否（下次切换才可见） | 读、删除、导出 |
| `archived` | 无 | 否 | 读、导出、还原、删除 |

不变量（建议写进 `docs/CONTRACTS*`）：

- **SB1 前缀不可变**：`baseBytes` 之前的字节永不重写；写者只能追加。
- **SB2 单写者**：任一分支任一时刻至多一个写者；切换必然穿越一次「无写者」状态。
- **SB3 refs 是唯一真相**：目录存在 ≠ 分支存在；孤儿目录可回收，孤儿引用不可存在。
- **SB4 母体只读**：母体 `$DSH_HOME` 只读；分支只挂在分身 home 或 fang dataDir。
- **SB5 切换不改历史**：切换只改 `active` 指针与物化产物，绝不改写既有字节。
- **SB6 归档 ≠ 删除**：冻结保留全部分支可读；删除分身必须显式列出分支数与体积。

### 1.6 切换状态机（5 态）

`idle → requested(opId, generation) → draining(停运行时/等租约) → materializing(字节拼接) → activating(翻 refs + 启动) → done`，任一态失败 → `failed(reverted)`，`active` 指针回到切换前（因为旧引用从未被覆盖，回滚是免费的）。

硬规则：**`draining` 必须真的观察到运行时退出**（复用 `archiveTask` 的停止确认 `orchestrator.mjs:860-923`、`archiveStopTimeoutMs` 3s 的超时语义）。观察不到就 `failed`，不许「大概停了」。

### 1.7 归档保留

| 概念 | 对象 | 保留什么 | 分支行为 |
|---|---|---|---|
| 冻结（车间归档） | 分身 | 整个 home | 分支保留可读；`active` 记录保留 |
| 还原 | 分身 | 重新 spawn | 恢复 `active` 分支；若已被物化则直接用，否则物化一次 |
| 删除 | 分身 | 无 | 连带分支；确认框必须写「含 N 个分支 / X MB」 |
| 导出 | 会话 | zip | 默认导出 active；`?allBranches=1` 导出 refs+journal+全部分支（可复现） |

### 1.8 一致性契约（用户可见，建议原文进 CONTRACTS）

- 切换是「全有或全无」的可见性：切换期间**继续读旧分支（只读）**，不允许半新半旧。
- 分支里的历史 = 切点之前的父分支全部事件 + 切点之后自己的事件；切点以**帧边界**为准，切点前若有撕裂尾部，丢弃半帧并在 journal 记 `base-tail-torn`（用户可见「切点前有 N 字节未落盘」）。
- 归档后分支可读不可写。
- **v1 不做合并**：跨分支只有「从该分支派生新分身」。一旦提出「两个分支要合到一起」，那才是 CRDT/OT 的入口（三区评审 §7.1 的同一结论），而且那时要合并的也不是配置，而是文本——两个问题不要混在一个 P 里。

---

## 2. 评审①：分支复制的原子性与大文件成本

**判定：否决字节复制，采用前缀锚定 + 独立段。**

### 2.1 复制路径今天必然出现的三个事故

| 事故 | 机制 | 证据 |
|---|---|---|
| 半帧 base | 复制进行中运行时还在追加，你拿到的是任意偏移的**前缀**，可能落在 zstd 帧中间；这个 base 从出生起就是坏的 | 写入侧是追加（`fsx.mjs:69-73` 的 append 习惯）；帧边界不在文件系统语义里 |
| 静默短拷贝 | 现有唯一树拷贝 `copyTree` 对每个文件 `catch { /* ignore */ }`，失败变成「少了几个文件但返回成功」 | `fsx.mjs:142-169` |
| 无回滚 | `importSessionIntoFork` 先 `copyFileSync` 再写索引（`orchestrator.mjs:343-345`、`:373`），中途失败留下半个会话目录且没有清理约定 | 同上 |

三个事故叠加后的表现是一致的：**分支能创建、能打开，但历史少了尾巴，而且没有任何地方报错。**

### 2.2 成本模型

| 方案 | 创建成本 | 磁盘 | 切出成本 | 原子性 | 判定 |
|---|---|---|---|---|---|
| 字节复制 | O(size) | ×N | 0 | 差（见 2.1） | 否决 |
| 硬链接 | O(1) | ×1 | 0 | **危险**：两分支同一 inode，追加写穿两个分支 | 否决 |
| reflink/CoW | O(1) | 增量 | 0 | 好，但 NTFS 不提供、ReFS 才有块克隆，不可作为主线依赖 | 否决 |
| **前缀锚定 + 独立段** | **O(1)**（stat + 读尾 64 KiB 校验 + 一次槽写） | 仅增量 | O(size)，仅 checkout，且是**字节拼接不重编码** | 好（单槽翻转） | **推荐** |

预算（目标值，须实测后写死）：

- 创建分支：p95 ≤ 50 ms，读取上限 ≤ 256 KiB（**用 IO 计数断言**，不允许实现里偷偷整文件读一遍）。
- 32 个分支的元数据总量 ≤ 2 MB；分支列表接口 ≤ 20 ms。
- checkout：≈ I/O 上限（本机 NVMe 200 MB 约 0.2–0.6 s；SATA/网络盘数十秒）→ 必须有进度、可取消、失败不留半文件。
- 归档卡上的「home X GB」口径不变（分支几乎不涨体积）——这是相对复制的第二个硬理由，比性能更重要：**产品已经把体积当成了用户可见信息**（三区评审 §3.1、§3.3）。

### 2.3 前缀锚定的正确性条件

1. **追加语义**：运行时只 append、不 rewrite。这一条现在成立，也必须写进契约（若哪天运行时改写历史，前缀锚定整条路作废，要回到「快照 + 迁移」）。
2. **切点必须落在帧边界**：复用现有帧边界扫描（`session-format.mjs:181-212` 的 magic 扫描 + 单帧试解）来确定 `baseBytes`/`baseFrames`，**但校验窗口只能是文件尾部一段**（例如 `size-64 KiB` 起），否则创建又变成 O(size)。
3. **必须处理「截断帧不抛错、返回 0 字节」**（`session-format.mjs:299-304` 的注释与实现）。判定条件只能是「解出非空 **且** 消耗字节数吻合」，不能靠 `try/catch`。这是本设计最容易写错、也最容易在测试里漏掉的一条：写错时的现象是「切点之后的分支看起来是空会话」，而不是抛错。
4. **尾部撕裂回退**：若 `size` 落在半帧上，回退到上一个可解帧；回退不足一帧仍失败 → 记 `base-tail-torn`，允许创建但要在 UI 标注「切点前 N 字节未完成」。

### 2.4 创建分支的提交顺序（崩溃安全的方向）

`mkdir branchId` → 写 `branch.json`（双槽或 tmp+rename）→ **读回校验** → 翻 `refs` 槽 → 追加 journal。

- 任一步崩溃：前面的残留都是**孤儿**（§5.1 P1/P2），refs 未翻 = 分支不存在。方向是对的——**宁可少一个分支，不可多一个坏分支**。
- 顺序不可反：先翻 refs 再建目录，读方会 404，UI 会出现「分支存在但打不开」的幽灵条目。

### 2.5 「复制」唯一被允许的位置

只有 checkout 可以碰 O(size)，而且是**字节拼接**：`父日志[0, baseBytes) + 本段字节`，两段都是同格式的合法 zstd 帧流，拼接结果天然是合法的多帧日志，不需要解压再压缩。这一点成立的前提是 §2.6 的格式决策。

### 2.6 日志格式：数据用 zstd，元数据用 JSONL

提案写「会话日志为 append-only JSONL」。两种读法都能实现，但代价不同：

| 选项 | 好处 | 代价 | 判定 |
|---|---|---|---|
| 数据日志也改纯 JSONL | 可 grep、可 tail、撕裂修复直观 | ① 要求**运行时**也读 JSONL（上游未知，`session-catalog.mjs:3-11` 表明现在读的是 zstd 多帧）；② 磁盘约为 zstd 的 3–8×，直接把 §2.2 的体积收益抵消；③ `readBoundedHead`/`readBoundedEvents` 的整个帧路径作废 | 若坚持，必须先有上游结论 |
| 数据 zstd（不变）+ fang 元数据 JSONL | 与运行时零摩擦；checkout 可字节拼接；元数据小、可读、可 append | 需要 `index.jsonl` 维持 O(1) 续读 | **推荐** |

折中做法（推荐落地）：**分支段沿用运行时的多帧 zstd；`journal.jsonl`、`index.jsonl`、`refs.*.json`、`branch.json` 全部 JSONL/JSON，append-only 或双槽。** 于是「append-only JSONL」这条诉求在 fang 真正拥有写权的那一层被完整满足，而在运行时拥有的那一层不被强加。

---

## 3. 评审②：并发写入 / 切换的锁与 fencing

**判定：进程内互斥不够；需要「文件租约 + 双槽 CAS + 检测式 fencing」，并且把切换定义为必须穿越「无写者」。**

### 3.1 临界区与进程边界

| 临界区 | 参与者 | 跨进程？ | 保护手段 |
|---|---|---|---|
| 追加活分支 | 分身运行时 | （相对 fang）是 | 不需要锁：单写者 + 只 append；fang 只读 |
| pin 前缀（建分支） | 母体 fang | 与运行时并发 | 无锁，边界校验 + 最多 3 次重试 |
| refs 读改写 | 母体 fang（可能多窗口/双实例） | 是 | `O_EXCL` 租约 + 双槽 + seq CAS |
| 切换（改 active） | 母体 fang + 运行时生命周期 | 是 | 同一租约 + 必须观察到运行时退出 |
| GC / 物化 / 删除 | 母体 fang | 是 | 同一租约 + pinned 检查 |

### 3.2 为什么 `KeyedMutex` 不能承担这件事

它是进程内的 per-key Promise 链（`mutex.mjs:6-25`）；母体与分身是两个 Node 进程。它能防的只有「同一进程里两个 handler 同时改 refs」，防不了双窗口、双母体实例、重启重试。保留它做进程内串行化是对的，但**任何「单写者」的结论都不能引用它**。

顺带一个现状缺口：布局里定义了 `fang.pid`（`paths.mjs:65`），但全仓检索只有这一处与文档注释（`:43`），**没有写者也没有校验者**。也就是说「同一 `$DSH_HOME` 只跑一个母体」今天没有守卫——而分支的 refs 写权恰恰依赖这个假设。

### 3.3 租约设计（Windows 现实版）

- 原子创建：`openSync(path, 'wx')`（`O_EXCL`）是 Node 在 Windows 上唯一可靠的「原子创建即抢锁」。
- 内容：`{pid, processStartMs, bootId, hostname, kind, opId, epoch, heartbeatAt}`。
- 心跳：2 s 重写一次；TTL 10 s。
- 陈旧判定必须三重：pid 不不存在 → 抢占；pid 在但**进程启动时间不符**或 `bootId` 不同 → 判定 pid 复用，抢占（否则重启后永远抢不到）；`kind/opId` 与 refs 里的在飞操作不一致 → 抢占并记 journal。
- 抢占必须写 journal（谁抢了谁、为什么）；否则「分支莫名变成只读」这类事故事后无法归因。
- 所有临界区带 3 s 超时；超时返回 `branch-busy` + 持锁者信息（`{pid, kind, opId, since}`），UI 直接显示「X 正在切换」。**不要**傻等——面板是 5 s 轮询的，等 3 s 等于把整个快照拖死。
- 不要用 rename 当锁：`fsx.mjs:55-57` 的注释已经写明 Windows 在读者持句柄时会拒绝 rename，拿它做互斥会得到随机失败。

### 3.4 fencing 的诚实结论

- **预防层**：fang 保证「切换前运行时已退出」（重启式切换）。这条能真正防住并发写。前提是 `draining` 真的观察到退出（§1.6）。
- **检测层**：运行时不会校验任何 fang 发的 token（我们改不了 DSH）。所以 fencing 只能是**检测式**：分身侧插件上报 `(branchId, epoch, logSize)`，母体与 refs 比对；不一致 → 标 `fenced`，UI 从「已就绪」降级为「分支被另一写者占用」，并禁止 UI 显示可写。
- 这条要写进产品文案的诚实口径：**我们能保证「不主动制造双写者」，不能保证「上游永远不会」；一旦发生，我们能看见并说出来。**

### 3.5 切换的三种实现与取舍

| 实现 | 前提 | 时延 | 风险 | 建议 |
|---|---|---|---|---|
| A 重启式：停运行时 → 翻 refs → 物化 → 启动 | 现有 `archiveTask`/`restoreTask` 能力足够（`orchestrator.mjs:860-923`、`:926-970`） | 3–8 s（含握手预算 10 s） | 占槽位/端口抖动；必须有 `stopping` 可见态（三区评审 G3） | **P1 首选** |
| B 热切换：运行时按路径打开指定会话 | DSH 支持指定会话文件/恢复参数（**未知，需 spike**） | < 1 s | 句柄切换瞬间的并发写；上游能力变更即失效 | 先 spike 再谈 |
| C 从分支派生新分身 | 只需 seed/import 通路（`orchestrator.mjs:444-477`） | 一次派生预算 20 s | 用户要多理解一个概念 | **P1 兜底，语义最诚实** |

**必须明令禁止的捷径**：切换时不重启、直接把活动日志 rename 成别的名字，让运行时「继续写着原来的句柄」。在 Windows 上 rename 会被打开句柄挡成 EPERM/EBUSY（`fsx.mjs:55-57`），在 POSIX 上则会成功并让两个分支交替写同一个 inode——这是整个设计里唯一能造成**不可恢复的双写**的操作。

### 3.6 分叉检测（divergence detector）

- 指纹：`sha256(最后 4 KiB 字节 ‖ size ‖ branchId ‖ epoch)`，母体每快照周期对 active 分支算一次（只读尾部，8 KiB 预算）。
- 与分身上报值比对；不一致 → 审计 `branch-diverged`，冻结该会话的写动作，UI 给「导出并重建」的出口。
- 这是「同一事实只有一处权威」在分支层的落地：**不靠猜，靠两个独立观察者的哈希对齐**。

---

## 4. 评审③：UI 分支切换器的状态同步

**判定：切换器本身不难，难在它同时是「读的新鲜度」和「写的所有权」两条轴的交叉点。两条轴必须分开建模。**

### 4.1 单一真相：`refsRev` + 每分支 tip

- 服务端每会话维护 `refsRev`（任何 refs 变更 +1），分支快照形状（只列字段）：

```
{ sessionId, taskId, refsRev, activeBranchId, activeTip,
  branches: [{ branchId, title, parentBranchId, baseAt, baseBytes, tipBytes,
               openSeq, events, status, writer, updatedAt }],
  sizeBytes, degraded[] }
```

- **ETag 必须包含 `activeBranchId` 与每分支 `(tipBytes, status)`**。沿用 `mirror-etag.mjs:20-43` 的「稳定字段」思路，但要注意反例：如果实现只对「分支列表」求哈希而漏掉 active 指针，**切换是唯一会变的一格，恰好在哈希之外** → 服务端返回 304 → 面板永远停在旧分支，直到别的字段偶然变化。这条要写成断言性测试（§7 T8），不要靠 review。
- 也不能把 `sizeBytes` 这类持续漂移的字段塞进 ETag（`mirror-etag.mjs:41` 已经踩过这个坑）。

### 4.2 缓存键必须含 `branchId`

- 反例在眼前：`titleCache` 以 `sessionId` 为键、以 `(mtimeMs, size)` 判有效（`session-catalog.mjs:245-246`、`:268`）。Windows 的 `CopyFileEx` 保留时间戳，复制/物化后两个分支可能短暂同 `(mtime, size)` → **标题串味**（A 分支的标题显示在 B 分支上）。
- 规则：凡是按会话缓存的东西，键改成 `(sessionId, branchId, tipBytes)`；事件分页游标改成 `(branchId, seq)`。

### 4.3 切换的 UI 状态机（不乐观改标签）

- 点击 → 插 `pendingSwitch {opId, fromBranchId, toBranchId, at, phase}`；**「当前分支」标签仍显示旧值**，旁边加「切换中 → feature-x」。
- 快照 `refsRev` 前进且 `activeBranchId === 目标` → 落定，播一次 200 ms 高亮（用 `branchId` 记「已播放」，避免每次轮询重播）。
- 连续 2 个快照周期未确认 → 变「未确认，请重试」（沿用三区评审 §3.4/§6.4 的 ghost 纪律：**不自动消失、不假装成功**）。
- 失败 → 明确回滚提示（「仍停留在 main」），并保留旧分支高亮。
- 切换窗口内禁用一切写动作（派生/归档/发送/新建分支），不只是禁用切换按钮。

### 4.4 多标签页与跨区一致性

- 双标签页、React 面板 + `/fang/panel` 独立门户同时开：沿用三区评审 §8.3 的建议——`BroadcastChannel` 选主，leader 轮询，其余标签订阅 `refsRev` 广播；切换成功后**立即**广播失效，而不是等下一个周期。
- 陈旧丢弃按 `refsRev` 比对，不要逐字段合并（`rev` 越小整包丢弃）。

### 4.5 分支行的信息与禁用口径

- 每行：短码 + 标题 + 「基于 main · 12 分钟前」+ 「N 条消息 / X KB」+ 状态徽标（活 / 只读 / 归档 / 不可用）。
- 禁用必须给原因（沿用三区评审 §2.3「不要上线死按钮」）：运行中不可切换、非活跃分支不可写、有子分支不可删除。
- **不要每个分支发一个请求**（三区评审 F9 的 N+1 教训：分支列表只在切换器展开时拉，一次拿全）。

### 4.6 与 6 态生命周期的耦合

`starting` / `running` / `stopping` 期间切换按钮禁用（运行时持有日志）；`failed` / `crashed` / `archived` 期间允许切换（本来就没有活的写者，切换成本最低）。这张矩阵直接接到三区评审 §4.1 的状态机，不要另建一套。

### 4.7 协作语义：分支是 durable，人在哪个分支是 ephemeral

- 「谁正在看哪个分支」= presence：TTL 30 s、last-write-wins、掉线即消失，**永不写 journal**（否则审计里全是噪声）。
- 两个人一个看 main 一个看 old-branch 互不阻塞（都在读）；但「切换」是分身级动作 → 同一时刻只允许一个 actor，其他人显示「X 正在切换」。
- 这一条与三区评审 §7.1 的结论同源：**分支不是实时协同编辑**，v1 没有需要 CRDT 的合并。

---

## 5. 评审④：崩溃后恢复与一致性

### 5.1 崩溃点枚举与恢复动作

| # | 崩溃点 | 磁盘残留 | 恢复动作 | 用户可见 |
|---|---|---|---|---|
| P1 | `mkdir` 后 | 空分支目录 | 孤儿 GC（无引用 + 无租约 + 超过 10 分钟） | 无 |
| P2 | `branch.json` 写一半 | 临时文件 / 坏槽 | 丢弃，按孤儿处理 | 无 |
| P3 | refs 槽写一半 | 单槽坏 | 读另一槽，取最高可校验 seq | 无 |
| P4 | refs 翻完、journal 未写 | 分支存在但无审计 | 从 refs diff 补一条 `reconstructed` 记录 | 审计可查 |
| P5 | 切换中（已停、未物化） | refs.active 仍旧 | 启动时按旧 ref 启动，标 `switch-aborted` | 「上次切换未完成」 |
| P6 | 物化写一半 | 临时物化文件 | 删除临时文件；旧日志一字节未动 | 无 |
| P7 | 物化完成、refs 未翻 | 多一份完整日志 | 按 `opId` 识别并 GC | 无 |
| P8 | 段尾撕裂（半帧） | 半帧 | 下次 open-for-append：截断到上一有效边界 + 写 `resume` 事件 | 「已恢复，丢弃 N 字节」 |
| P9 | `forks.json` 与 refs 不一致 | 元数据矛盾 | **拒绝启动该分身**，要求对账或自动选 refs 并记审计 | 「状态不一致，需确认」 |

### 5.2 恢复必须有唯一所有者

建议新组件 `RecoverySupervisor`，boot 时串行执行：refs 槽校验 → 孤儿 GC → 段尾修复 → `forks.json` 对账 → 发布 `recovery` 块（进快照，`rev+1`）。

顺序契约：**它必须早于 `MirrorUpgradeCoordinator` 的 `postUpgradeHook`**（`upgrade-coordinator.mjs:50-57`）。否则重算会在「半恢复」的 refs 上跑，得到一份谁都不信的 fingerprint。这也是 §6.2 C19 的由来。

### 5.3 段尾修复的三条规矩

1. 只在**持有租约**时截断；别人的文件绝不截。
2. 只截到**上一有效边界**（帧级/行级），不「跳过坏帧继续」——`ledger.mjs:43-48` 已经给出先例：尾部不可解析时**拒绝续写**，而不是帮着掩盖。
3. 必须写 `resume` 事件 `{recoveredBytes, droppedBytes, reason, at, epoch}`，并在 UI 上可见一次。静默修复等于把数据丢失变成永久谜团。

### 5.4 refs 的双槽提交（避开 Windows rename）

`refs.a.json` / `refs.b.json`，各自 `{seq, bodySha256, body}`；写时交替覆盖**较小 seq 的槽**，写完 `fsync`，读回校验 sha；读时两槽都解析、取**可校验且 seq 最大**者。

- 撕裂只会坏一个槽，另一个仍可用——**不需要 rename 就拿到了原子性**，正好绕开 `fsx.mjs:48-63` 的退化路径。
- 若两槽都不可校验 → `refs-corrupt`，**拒绝写、拒绝自动重建**，把「分支列表消失」变成一个显式状态。自动重建会静默丢掉全部分支元数据，那是最差的失败方式。

### 5.5 与归档/删除的交互

- 删除父日志前必须检查 pinned：有子分支引用 `[0, baseBytes)` → 拒绝（`branch-pinned` + 子分支清单），不许「先删再说」。
- 删除分身：确认框列出分支数与体积；`removeTree` 已是 junction-safe（`fsx.mjs:192-206`），沿用，不要新写删树逻辑。
- 归档后还原：若 active 已被物化则直接用；否则物化一次（此时正好没有写者，是最安全的窗口）。

### 5.6 可断言不变量（测试与运行时采样共用）

- INV1：任一分支 `baseBytes ≤ 父日志当时 size`。
- INV2：分支可见事件序列 == 父序列前缀 + 段序列（纯函数，可穷举验证）。
- INV3：refs 中每个分支目录都存在；反向不要求（孤儿允许存在但不可见）。
- INV4：任一分支同时至多一个活跃租约。
- 采样：每 30 s 对 active 算一次指纹（§3.6），与分身上报比对，进审计而非日志。

---

## 6. 评审⑤：与 `status-store` / `upgrade-coordinator` 的接口

### 6.1 `MirrorStatusStore`：新增 4 个冲突点（接三区评审 C1–C8）

| # | 冲突点 | 现状 | 影响 | 建议 |
|---|---|---|---|---|
| C15 | 单资源模型装不下「N 会话 × M 分支」 | 快照是 `{status, loading, error, lastUpdatedAt}` 一个资源（`status-store.mjs:18-20`） | 一个会话切换失败会污染整个面板的 error | 按会话/按分支视图各一实例 + 纯 selector 组合；**不要**把它改成多资源 store（会破坏既有测试与 idle-audit 契约，C1 同因） |
| C16 | 没有「变更中」通道 | store 只有读快照，没有 mutation 概念 | 切换从请求到落定这几秒里，UI 只能靠猜或干脆乐观改 | 新增独立 `pendingMutations` store（`opId → {kind, target, phase, at}`），由 selector 与快照合并；**不要塞进 `snapshot.status`** |
| C17 | 304 只更新 `lastUpdatedAt` | `status-store.mjs:168-171` | ETag 若漏掉 `activeBranchId`，切换后永远 304、永远旧分支（§4.1） | ETag 必须含 refs 关键字段；并为「切换后必变」写断言测试 |
| C18 | `acquireActive` 没有命名空间 | 引用计数 + 单一 idle 计时器（`status-store.mjs:76-113`） | 切换窗口需要的 500 ms 高频档会把整个面板提速 10× | `acquireActive('branchSwitch')` 命名空间，内部取最高档；**失败/超时也必须 release**，否则面板永不回到 idle，审计统计跟着失真 |

补充两条既有结论在分支场景的复现：C3（`inFlight` 实例级单飞，`status-store.mjs:158`）在多会话组合后会串行化 → 必须按 key 单飞；C5（局部高频档）就是 C18 的前身。

### 6.2 `MirrorUpgradeCoordinator`：4 个冲突点

| # | 冲突点 | 现状 | 影响 | 建议 |
|---|---|---|---|---|
| C19 | 启动顺序无契约 | `onUpgradeSuccess` 直接起批（`upgrade-coordinator.mjs:50-57`） | 恢复未完成就开始重算 → fingerprint 建立在半恢复状态上 | 把「恢复完成」做成前置条件；`RecoverySupervisor` 先于 hook，失败则不触发重算并置 `lastError` |
| C20 | `task.seed` 只有 `sessionId` | `orchestrator.mjs:454-460` | 「从分支派生」的分身无法归因到具体分支与切点，事后审计断链 | `seed` 增补 `branchId / baseBytes / refsRev`（与三区评审 G5 的 `essenceId/baseFingerprint` 同类遗漏） |
| C10' | 单飞无 rerun | 已有批次时直接复用 `currentRun`（`upgrade-coordinator.mjs:50-57`） | 分支操作触发的重算（如切点索引重建）被静默丢弃 | 加 `rerunRequested` 循环（C10 的具体落地场景） |
| C9' | 状态快照每次新对象 | `getRecomputeStatus()` 深一层的浅拷贝（`upgrade-coordinator.mjs:32-44`） | 分支 chip 若订阅它 → 无限重渲染 | 保持分支 UI **不订阅** recompute 状态；需要时经 store 缓存并只在真变化时 `rev+1` |

### 6.3 目标契约（只列形状，不写代码）

- `GET /fang/api/sessions/branches?taskId=&sessionId=` → §4.1 的形状；支持 `If-None-Match`。
- `POST /fang/api/sessions/branches/create {sessionId, fromBranchId, opId, title}` → 201 `{branchId, baseBytes, baseFrames, refsRev}`；同 `opId` 重放返回同一分支（幂等，沿用三区评审 §7.5 的 `flowbackId` 思路）。
- `POST /fang/api/sessions/branches/switch {sessionId, branchId, opId}` → **202** `{opId, phase:'draining', generation}`；冲突 → 409 `branch-busy {holder}`；运行中热切换 → 409 `writer-alive`。
- `POST /fang/api/sessions/branches/delete {sessionId, branchId, opId}` → 409 `branch-pinned {children[]}` 或 200。
- `GET /fang/api/sessions/branches/read?taskId=&sessionId=&branchId=&after=&limit=` → 事件（脱敏，沿用 `redact`）。
- 审计事件名：`branch-created / branch-switch-requested / branch-switched / branch-switch-failed / branch-gc / branch-tail-repaired / branch-fenced / branch-diverged`。
- 快照增补一块：`{ sessions: [{ sessionId, taskId, refsRev, activeBranchId, branchCount, pendingSwitch }] }`，**分支明细不进快照**（单包 ≤256 KiB 的预算，三区评审 §8.1）。

### 6.4 角色矩阵变更

`MATRIX` 加 `sessionBranch: ['mother', 'fork']`（`role.mjs:15-32`）：母体是 refs 权威，分身是 tip 上报者。`sessionCatalog` 保持 `['mother']` 且 `readOnly: true` 不动——**分支功能不许给只读目录开后门**。

---

## 7. 评审⑥：测试矩阵（含崩溃注入）

### 7.1 注入机制：三层，成本递增

1. **纯函数层**：分支解析/组合/边界校验全部走注入的 `fsApi`（先例：`session-catalog.mjs:140-146` 构造只读 fs 视图；`session-format.mjs` 干脆零 import）。测试用假 fs + **步骤计数器** `crashAt(stepName, N)`，在 `mkdir / writeSlot / rename / fsync / readback / append` 每个边界抛一次——**每个崩溃点都能在毫秒级单测里覆盖**，不需要真杀进程。
2. **进程层**：真的 `child_process` + `taskkill /F`（Windows），在随机时刻杀掉正在创建/切换的子进程；先例是 `forker.test.mjs`（50 KB，真实进程）。
3. **文件层**：fixture 里预置半帧 zstd、坏槽、孤儿目录、pid 复用租约。**半帧 fixture 必须由真实截断生成**，不要手写字节——它要复现的是「解压返回 0 字节不抛错」这个陷阱（`session-format.mjs:299-304`）。

### 7.2 矩阵（T1–T30）

| # | 层 | 场景 | 注入/手段 | 期望 |
|---|---|---|---|---|
| T1 | 纯函数 | 切点落在帧边界（含压缩数据里的伪 magic） | 构造含伪 magic 的多帧日志 | `baseBytes` 落在真帧边界，组合读出的父事件数正确 |
| T2 | 纯函数 | 截断帧 | 真实截断 fixture | 识别为 torn（**不是**空会话）；回退一帧后成功 |
| T3 | 纯函数 | 32 层祖先链 | 深链 fixture | 组合正确；33 层触发强制物化或明确拒绝 |
| T4 | 纯函数 | 半帧回退 | 尾部撕裂 | 记 `base-tail-torn`，分支仍可创建，事件数 = 完整帧数 |
| T5 | 纯函数 | refs 双槽 | 坏 A / 坏 A+B | A 坏取 B；双坏 → `refs-corrupt`，**不自动重建** |
| T6 | 纯函数 | 分支 id 校验 | `../`、`C:`、超长、保留名 | 全部 400，绝不进路径 |
| T7 | 纯函数 | 孤儿 GC | 无引用目录 + 有引用目录 + 活租约目录 | 只删第一种 |
| T8 | 纯函数 | refs ETag | 仅 `activeBranchId` 变化 | ETag 必变（防 304 卡死） |
| T9 | 并发 | 300 次「边写边 pin」 | 追加线程 + 创建线程 | 每次 create 成功或明确失败；基事件数单调不倒退 |
| T10 | 并发 | 两进程并发 create | 两个 node 子进程 | 两个不同 branchId，或一个 `branch-busy`；绝不出现同 id 双分支 |
| T11 | 并发 | 两进程并发 switch | 同上 | 恰好一个成功；另一个 409 且带 holder |
| T12 | 并发 | 陈旧租约（pid 复用） | 写入活着的无关进程 pid | 依据 `processStartMs/bootId` 判定陈旧并抢占 |
| T13 | 并发 | 持锁进程 `kill -9` | 真杀 | TTL 后（≤10 s）可抢占，journal 有记录 |
| T14 | 并发 | 运行中切换 | 运行时活着时 POST switch | 409 `writer-alive`，日志零字节改动 |
| T15 | 崩溃 | P1 mkdir 后崩 | `crashAt(mkdir)` | GC 后 refs 不变 |
| T16 | 崩溃 | P3 槽写一半 | `crashAt(writeSlot)` | 旧槽可读，seq 不倒退 |
| T17 | 崩溃 | P5 停后未物化 | 杀进程 | 重启回旧分支 + `switch-aborted` |
| T18 | 崩溃 | P7 物化完成未翻 ref | 杀进程 | 临时文件被 GC，无「半个分支」 |
| T19 | 崩溃 | P8 段尾撕裂 | 杀进程 + 重启 | 首读识别；open-for-append 截断 + `resume` 事件 |
| T20 | 崩溃 | 物化中 ENOSPC | 假 fs 抛 ENOSPC | 不翻 refs，不覆盖旧日志 |
| T21 | 崩溃 | Windows 拒绝 rename | 另一进程持有句柄 | 双槽路径仍成功；或明确失败，无空 manifest |
| T22 | 生命周期 | 归档 → 重启 → 读分支 | 真进程 | 分支可读、状态 `archived`、体积口径正确 |
| T23 | 性能 | 200 MB base 创建分支 | IO 计数 | p95 ≤ 50 ms，读取 ≤256 KiB |
| T24 | 性能 | 32 分支列表 | — | ≤20 ms，元数据总量 ≤2 MB |
| T25 | 性能 | checkout 200 MB | — | 预算内完成；可取消；失败无半文件 |
| T26 | UI 逻辑 | A→B→A 切换 | 假快照序列 | 标题/事件/active 标签零串味 |
| T27 | UI 逻辑 | 切换中双标签页 | BroadcastChannel 桩 | 另一个标签立即失效，不显示新分支旧数据 |
| T28 | UI 逻辑 | 运行中/满员/归档态点击 | 状态矩阵 | 禁用且给原因，不发请求 |
| T29 | 检测 | epoch 上报旧值 | 改 fixture | 标 `fenced`，写动作冻结 |
| T30 | 检测 | 段内伪造事件 | 改字节 | 指纹不一致 → `diverged`，冻结写 |

### 7.3 随机序列与不变量检查器

一个 fuzz 用例（`test/*.test.mjs` 风格，固定种子可复现）：随机执行 `create / switch / archive / restore / kill -9 / gc / delete`，每步后跑 INV1–INV4（§5.6）与「refs 重算 == 内存状态」，跑 5000 步。这类检查器比 30 条用例更能抓住真 bug——三区评审 §4.4 的 `rev` 单飞与这里是同一个思路：**用不变量代替逐字节期望**。

### 7.4 CI 门槛（建议阻塞合并）

- T1/T2/T4/T5/T8（纯函数崩溃与边界）；T9/T11/T14（并发与写者）；T15–T21（崩溃注入）；T23（性能预算）。
- 真进程用例（T10/T13/T22）允许 `--test-only` 标记、在 Windows CI 上必跑，因为 **EPERM/句柄语义只有真机才能复现**。

---

## 8. 实现优先级

| 阶段 | 内容 | 工作量 | 验收 |
|---|---|---|---|
| **P0 契约 + spike** | 定存储位置与写权（B1）；帧格式兼容 spike（fang 写帧、DSH 继续追加，三次运行）；切换能力 spike（A/B/C 三选一）；refs 双槽 + 租约 + journal 纯函数层（可单测）；1:1 归属规则与 API 字段（B6） | 1.5 人日 | 三个问题有书面结论；纯函数层 T1–T8 全绿；`session-format` 一行未改 |
| **P1 只读分支视图** | create + 列表 + `branches/read` + 切换器 UI（除切换按钮）+ ETag/refsRev + 缓存键修正 | 2.5 人日 | 建分支 ≤50 ms；列表 ≤20 ms；A→B→A 无串味；运行中按钮禁用且给原因 |
| **P2 切换与恢复** | 重启式 switch + 物化（字节拼接）+ `RecoverySupervisor` + 归档/删除/导出 + `pendingSwitch` | 3 人日 | 切换 3–8 s 内落定或明确失败；P1–P9 崩溃点全部可恢复；删除有子分支被拒 |
| **P3 可观测与协作** | 分身侧 tip 上报（`sessionBranch` 双角色）+ 指纹采样 + `BroadcastChannel` 选主 + 分支 presence + 多标签 | 2 人日 | `fenced`/`diverged` 可见；双标签只产生一条轮询流；presence 掉线 30 s 内消失 |
| **明确不做** | 分支合并（CRDT/OT）、硬链接分支、运行中热切换、「分支 = 目录复制」、母体会话的分支写 | — | 写进 CONTRACTS 的「不做」清单 |

---

## 9. 待产品确认（6 条，决定 P1/P2 形状）

1. **分支能否挂在母体会话上？** 建议：只给「只读切点 + 从切点派生」，不做写。否则 B1 直接被推翻。
2. **切换不可用时的兜底叫什么？** 建议显式提供「从该分支派生新分身」，并且它就是 C 方案——用户理解成本低于「热切换失败」。
3. **「分身 ↔ 会话 1:1」怎么处罚例外？** 现有 `importSession` 会引入第二个会话（`orchestrator.mjs:333-375`）。建议定义为「归属会话」+「非归属会话（隐藏、只可导出）」，并在分身上显示 `orphanSessionCount`。
4. **分支上限与保留**：建议 32/会话、归档分支不自动清理、删除时按体积二次确认。要写进上限表（三区评审 §8.1）。
5. **同一分身是否允许第二个人连（只读）？** 这决定 presence 是否要进 P1，也决定「切换」是不是必须独占（我建议独占）。
6. **日志物理格式是否坚持 JSONL？** 若坚持，需要上游 DSH 同步改读法，属于跨仓依赖；否则按 §2.6 的「数据 zstd + 元数据 JSONL」。

---

## 附：证据索引

| 结论 | 位置 |
|---|---|
| 母体会话目录只读是硬约束 | `src/kernel/paths.mjs:111-114`；`src/plugins/session-catalog.mjs:605-606`；`src/lib/session-format.mjs:1-17` |
| 会话布局第一段是 workspaceKey（非 essence） | `src/lib/session-format.mjs:14`、`:167-172`、`:622-623` |
| 扫描器只认 `session.v4.jsonl.zstd`，新层级会静默变空 | `src/lib/session-format.mjs:621-629`；`src/plugins/session-catalog.mjs:190-196` |
| 多帧 zstd + 帧边界扫描 | `src/lib/session-format.mjs:181-212`、`:410-427` |
| 截断帧解压返回 0 字节而不抛错 | `src/lib/session-format.mjs:299-304` |
| 原子写在 Windows 上退化为 copy | `src/kernel/fsx.mjs:48-63`（注释 `:55-57`） |
| 追加无 fsync、读 JSONL 静默跳过坏行 | `src/kernel/fsx.mjs:69-73`、`:75-86` |
| 树拷贝吞错 | `src/kernel/fsx.mjs:142-169` |
| junction-safe 删除（分支目录也必须走它） | `src/kernel/fsx.mjs:192-206` |
| 链式账本「尾部不可解析则拒绝续写」 | `src/kernel/ledger.mjs:43-55`、`:61-80` |
| 唯一互斥是进程内 KeyedMutex | `src/lib/mutex.mjs:6-25` |
| 母体与分身是不同进程（env 传递） | `src/plugins/orchestrator.mjs:479-491` |
| `fang.pid` 定义了但无写者/校验者 | `src/kernel/paths.mjs:43`、`:65`（全仓无其它引用） |
| 分身 home 的写操作全在 spawn 之前 | `src/plugins/orchestrator.mjs:446-477`（早于 `:479`） |
| 会话导入存在整文件复制 + 大小门 | `src/plugins/orchestrator.mjs:333-375`（`importMaxBytes` `:339`） |
| 分身会话是**列表**，1:1 不成立 | `src/plugins/orchestrator.mjs:806-857` |
| `task.seed` 只有 sessionId | `src/plugins/orchestrator.mjs:454-460` |
| 归档/还原/删除的停止确认语义 | `src/plugins/orchestrator.mjs:860-923`、`:926-970`、`:971+` |
| 标题缓存键只含 sessionId + mtime/size | `src/plugins/session-catalog.mjs:245-246`、`:268` |
| 路径防逃逸校验先例 | `src/plugins/session-catalog.mjs:110-113` |
| 角色矩阵是唯一的部署开关 | `src/kernel/role.mjs:15-32` |
| ETag 只哈希稳定字段（漂移字段排除） | `src/lib/mirror-etag.mjs:20-43`（`:41`） |
| 单一资源 store 与 304 语义 | `src/lib/status-store.mjs:18-20`、`:157-182`、`:168-171` |
| 引用计数式高频档无命名空间 | `src/lib/status-store.mjs:76-113` |
| coordinator 单飞无 rerun、快照每次新对象 | `src/lib/upgrade-coordinator.mjs:32-44`、`:50-57` |
| 只读桥接是「live 通道不复制文件」的先例 | `src/plugins/session-bridge.mjs:3-4`、`:46-66` |
| 三区评审既有结论（C1–C14、G1–G6、测试 22 条） | `docs/REVIEW-三区隔离与快照回流.md` §0/§9/§11 |
