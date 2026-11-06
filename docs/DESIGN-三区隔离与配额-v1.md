# 设计：三区隔离与配额（母体 / 原身 / 分身）v1

> 状态：**设计稿**，未写码。本文只定边界、目录、配额、改造点与阶段，不改架构以外的实现。
> 目标一句话：母体只升级、原身可配置、分身只生产；三区文件互不读写，配额在服务端强制。

## 1. 目标与判据

| 目标 | 可验证判据 |
|---|---|
| 三区隔离 | 任一实例只能看见自己的目录；跨区路径访问被服务端拒绝（不是靠约定） |
| 母体唯一 | 只有一个母体；可升级/回退/备份；不可删除 |
| 原身可配置 | 每个原身独立沙箱：装插件、改设置、登录账户、建会话 |
| 分身只生产 | 分身不能装插件/改设置（每次从原身重置）；生产数据独立持久 |
| 配额 | 原身数、子原身数、单原身进行中会话数由服务端强制；归档不计 |
| 单会话/分支 | 一个分身只有一个会话；同一分身+同一会话可派生多个新分支 |

## 2. 现状 vs 目标

| 能力 | 现状 | 差距 |
|---|---|---|
| 三文件夹 | `FANG_HOME` 已有 `mirror/`、`essence/`、`sessions/` 布局；但当前安装仍用旧布局 `~/.dsh/fang/<tag>` | 旧布局迁移策略未定 |
| 母体升级/回退 | `mirror.upgrade/restore/backup` 已有 | 自动**同步**（6/12/24h）未接 |
| 原身沙箱 | 每原身一个目录（overlay/merged/runtime）；运行态隔离 `DSH_HOME` | 原身**会话**仍散落，没有归口到 `sessions/<essenceId>` |
| 分身来源 | 分身从**母体 profile** 派生（`profileTemplate: templateDir()`） | 应从**原身 merged** 派生，且 fork 不能写回原身 |
| 分身权限 | 技术上可装插件/改设置 | 未禁用；无“每次从原身重置”机制 |
| 配额 | 原身/子原身配额已强制；**进行中会话配额函数存在但从未调用** | 会话配额未接；分身数上限只有全局 maxForks=8 |
| 单会话 | 无约束 | 分身可被塞多个会话 |
| 分支 | `BranchStore` 已有（单会话内分支） | 与分身/会话的映射未定 |

## 3. 目录布局与所有权

```
FANG_HOME = D:\ToFuture（新装默认；env FANG_HOME 可覆盖）
├─ mirror/
│   ├─ active/profile/         母体镜像（可升级/回退）
│   ├─ backup/<id>/            自动/手动备份（24h 轮转）
│   └─ restore/<id>/           手动备份（保留）
├─ essence/
│   └─ <essenceId>/            原身沙箱（只放配置：overlay/merged/Backup）
├─ forks/                      分身 home（生产数据，独立于原身）
└─ sessions/
    └─ <essenceId>/home/       原身运行态 DSH_HOME（其 sessions/storages 在这里）
```

> 三区已按此实拆（v3.0.9）：`essenceRoot=<FANG_HOME>/essence`、`forkHomesDir=<FANG_HOME>/forks`、
> `runtimeRoot=<FANG_HOME>/sessions`；旧布局（无 FANG_HOME）保持 `dataDir/essences`、`dataDir/forks`、
> `dataDir/runtime`，并在启动时把旧运行态 home 迁移到新位置。

| 目录 | 写者 | 读者 |
|---|---|---|
| `mirror/` | 只有 mirror manager（升级/备份/回退） | 原身重算、原身运行态 |
| `essence/<id>/` | 该原身实例（overlay/settings/logs） | 该原身实例；母体只读重算 |
| `sessions/<essenceId>/` | 该原身的运行实例 | 该原身；母体目录服务只读 |
| 分身 home（`essence/` 外的 forkHomesDir） | 分身自己 | 母体 adapter/只读索引 |

> 关键改造：`layout.sessionsRoot` 从“建议路径”变成**唯一归口**；原身运行态启动时 `DSH_HOME` 指向 `essence/<id>/runtime/home`，其 `sessions` 软链到 `sessions/<essenceId>`（或直接配置 DSH 会话目录——需确认 DSH 是否支持独立 sessions 根，见 §9 Q1）。

## 4. 会话归口

| 角色 | 会话位置 | 可见性 |
|---|---|---|
| 母体 | `$DSH_HOME/sessions`（宿主所有） | fang 只读索引 |
| 原身 | `sessions/<essenceId>/` | 仅该原身实例可读写 |
| 分身 | 分身自己的 `DSH_HOME/sessions`（生产盘） | 仅该分身；母体只读索引 |

规则：
1. **原身之间不可见**：会话目录按 essenceId 分区，目录服务按 essenceId 参数取根，路径守卫拒绝 `..` 与绝对路径。
2. **分身不写原身**：分身模板从原身 `merged/profile` **复制**一份到分身 home，`node_modules` 用只读 junction；分身运行时不指回原身目录。
3. **原身运行态不写母体**：`DSH_HOME` 隔离 + 母线目录只读挂载（目录服务只读）。

## 5. 配额矩阵

| 维度 | 默认 | VIP10/30/50/100 | 计数口径 | 强制点 |
|---|---|---|---|---|
| 顶层原身 | 5 | 10/30/50/100 | `list().parentId===null` | `create()`（已有） |
| 子原身（每父） | 5 | 同上 | `listChildren(parentId)` | `create()`（已有） |
| 单原身进行中会话 | 10 | 同左 | `sessions/<essenceId>/` 非 archived 目录数 | 原身运行态**启动会话前**（DSH 侧会话创建钩子/目录守卫，见 §6） |
| 归档会话 | 不限 | 不限 | `archived/` 下目录数 | 不做上限 |
| 分身数 | 8（全局） | 可配 | `tasks.size` | createTask（已有） |

> 会话配额的难点：会话由 DSH 宿主创建，fang 只能读 `sessions/`。两个可选强制点：
> **A. 目录守卫**：原身运行态的 `sessions` 根设置为只读+预创建配额占位（计数超限则拒绝新建）——需要 DSH 支持。
> **B. 轮询式**：fang 定期扫描 `sessions/<essenceId>`，超限时把该原身标记 `quota-exceeded` 并在面板提示；**软限制**，不阻断。
> 建议先做 B（可落地、不依赖 DSH 改造），A 作为后续。

## 6. 分身模板来源改造（核心）

现状：`createTask` → `forker.provision({ profileTemplate: templateDir() })`（母体 profile）。

目标：任务若带 `essenceId`，模板来自该原身的 `merged/profile`：

```
createTask({ essenceId })
  → essenceManager.ensureFresh(essenceId)          // 先把 overlay 重放到最新母体
  → profileTemplate = essenceManager.mergedProfileDir(essenceId)
  → forker.provision(...)                            // 复制配置到分身 home
  → 分身 node_modules junction → 母体模块树（只读）
  → 分身 spawn（DSH_FANG_ROLE=fork）
```

`forker.provision` 已经支持任意 `profileTemplate`，改造量小；需要补：
1. `createTask` 接受 `essenceId` 并落到 task 记录；
2. 分身 home 里记录 `sourceEssenceId` + `sourceFingerprint`（与原身重算指纹），面板显示“来自哪个原身/是否落后”；
3. 分身启动后**禁用插件管理/设置写入**（宿主侧策略，见 §9 Q2）。

## 7. 分身权限：只生产

| 能力 | 分身 | 实现 |
|---|---|---|
| 装插件/改设置 | ❌ | 分身 profile 每次派生从原身复制；运行态里改也会在下次派生时被覆盖；面板提供「重置为原身配置」 |
| 聊天/开发 | ✅ | 正常 DSH 会话 |
| 生产数据 | ✅ 持久 | 分身 home 独立，关闭不丢 |
| 会话数 | 1 | 见 §8 |

## 8. 单会话与分支

- 派生时只允许指定**一个**会话（或空）；任务记录 `sessionId`，状态接口返回该分身唯一会话。
- 分支：`BranchStore` 已有“同会话内多分支”的存储；把 `branchId` 绑定到 `(forkId, sessionId)`，一个分身一个会话、多个分支合法。
- “同一会话派生新分支” = 在分身内 fork session（DSH `sessions.fork`），fang 只记录映射，不复制日志。

## 9. 待决策问题（需要你确认）

| # | 问题 | 选项 |
|---|---|---|
| Q1 | 原身运行态的会话目录：DSH 是否支持独立 sessions 根？ | 软链 `runtime/home/sessions → sessions/<essenceId>`（A） / patch DSH 配置（B） / 只能软限制（C） |
| Q2 | 分身禁止装插件/改设置：在 fang 侧显示禁用，还是硬改宿主策略？ | UI 禁用（A，轻） / 宿主权限位（B，重） |
| Q3 | 旧布局迁移（`~/.dsh/fang/<tag>` → `D:\ToFuture`） | 自动迁移（A） / 仅新装（B，当前行为） / 用户点击迁移（C） |
| Q4 | 会话配额软限制还是硬限制 | 轮询软限制（A，先做） / 目录守卫硬限制（B，需 DSH 支持） |
| Q5 | 子原身默认 5 与 VIP 档位：是否按当前 `VIP_QUOTAS` 直接生效？ | 是（A） / 另做等级配置（B） |

## 10. 阶段与验收

### P1 隔离布局（1–2 轮）

- [ ] `sessions/<essenceId>/` 归口：目录服务按 essenceId 分区 + 路径守卫；
- [ ] 原身运行态 `DSH_HOME` 指向 `runtime/home`，会话软链/配置指向归口；
- [ ] 跨区访问测试：A 原身读不到 B 原身会话；原身读不到母体会话；分身读不到原身文件。

### P2 配额（1 轮）

- [ ] 会话配额按 Q4 方案接入，超限状态进 `essence/list`（`quota: {sessions:{used,limit,over}}`）；
- [ ] 归档目录 `archived/` 不计入；
- [ ] 测试：10 个进行中 → 第 11 个被拒/告警；归档后可继续。

### P3 分身来源改造（1–2 轮）

- [ ] `createTask({essenceId})` → `profileTemplate = mergedProfileDir`；
- [ ] 任务记录 `sourceEssenceId/sourceFingerprint`，状态接口暴露；
- [ ] 分身派生后原身目录零写入（文件 mtime 断言）；
- [ ] 分身单会话约束 + 分支映射。

### P4 母体自动同步（0.5 轮）

- [ ] 复用 `backupIntervalHours` 模式加 `syncIntervalHours`（6/12/24）；
- [ ] 定时 `mirror.clone-profile` + 触发元主 stale；
- [ ] 面板显示下次同步时间。

## 11. 风险

| 风险 | 缓解 |
|---|---|
| 软链会话根在 Windows 权限/Junction 上不稳 | 优先配置 DSH 独立 sessions 根；不成立则用软限制 |
| 分身模板从原身复制导致磁盘膨胀 | 只复制配置（package.json/patch/settings），会话按需导入 |
| 配额硬限制误伤现有用户 | 先软限制 + 面板提示，再升级硬限制 |
| 迁移旧布局丢数据 | 迁移前强制备份；提供回滚路径 |
