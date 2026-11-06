# 设计：瓮城升级全链路（v1 · 对应 v3.0.9 落地）

> 本文把「官方源/PC 客户端 → 母体 Mirror → 元主 Essence → 插件 Plugin」四段升级流，
> 逐条映射到本仓现有代码，并标注 **已实现 / 缺口 / 需要外部能力**。
> 边界：不推 main、不发版；写操作一律二次确认。

## 1. 四段升级流

```
[PC 客户端 profile] ──2.1 克隆母体──▶ [Mirror active/profile]
        │                                   │
        │ (2.2 一键更新: 需要 officialSource)
        ▼                                   ▼
[Mirror 新版本] ──3 元主重放 overlay──▶ [Essence merged/profile]（用户配置不动）
                                            │
                                            ▼
                                   [4 元主内插件更新 + 回滚]（需要元主运行态）
```

## 2. 现状盘点（本仓真实代码）

| 能力 | 现状 | 位置 |
|---|---|---|
| 镜像备份 / 恢复 / 删除 / 自动备份 | ✅ 已有 | `src/lib/mirror.mjs` `backup/restore/deleteBackup/maybeAutoBackup` |
| 镜像「一键更新」编排（自动备份→下载→门禁→回滚） | ✅ 骨架已有，**但没有 officialSource** | `mirror.upgrade()`；`officialSource` 构造时未注入 → `checkUpdate()` 恒为 `official-source-unavailable` |
| 升级后元主批量重算协调器 | ✅ 已有 | `src/lib/upgrade-coordinator.mjs` |
| 元主 overlay 合并 / 重放 / 物化 | ✅ 已有 | `EssenceManager.recompute/ensureFresh/recomputeAll` |
| 元主「是否落后于母体」判定 | ✅ 本次补上（`stale`） | `listEssences()` 比较 `lastMergedFingerprint` |
| 母体 profile → 镜像克隆 | ✅ 本次实现 | `POST /fang/api/mirror/clone-profile` |
| 元主同步（单个/全部） | ✅ 本次实现 | `POST /fang/api/essence/sync` |
| 系统状态灯（绿/黄/红 + 原因） | ✅ 本次实现 | `buildUpgradeStatus().light` |
| 元主「配置态 Web 实例」（跑起来才能更新插件） | ❌ **未实现** | DECISIONS v3.0.8 #4 只给了边界，没有运行时 |
| 元主内 `pnpm update` + 健康检查 + 自动回滚 | ❌ 依赖上一项 | 无代码 |
| VM 级 `vm_snapshot/vm_exec/vm_restore/vm_audit` | ❌ **本仓没有任何 vm_* 工具** | 全仓 grep 为 0；这是外部 VM provider 能力 |

> 结论：**2.1、3 现在就能用；2.2 差一个「官方源适配器」；4 与 VM 回滚差运行时 + provider。**
> 不能把「VM 快照兜底」写成已具备——本仓没有这些工具，必须先把 provider 接口定义出来。

## 3. 本次已落地（P0，无 VM、无网络下载）

### 3.1 API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/fang/api/mirror/clone-profile` | 从本机母体 profile 克隆 `package.json / cordis.patch.yml / cordis.yml / settings/` 到 `mirror/active/profile`；**先自动备份**；返回 `{version, files, backup}` |
| POST | `/fang/api/essence/sync` | `{essenceId?}`：无 id = 全部（并发 2）；有 id = 单个；返回 `{recomputed, skipped, conflicted, failed}` 或单个 `{recomputed,status}`；locked 元主拒绝 |
| GET | `/fang/api/essence/list` | 每项新增 `stale`，顶层新增 `mirrorFingerprint / staleCount` |
| GET | `/fang/api/upgrade/status` | 新增 `light:{tone,reasons[]}`、`staleCount/conflicted/failedTasks`；镜像字段兼容 `currentVersion/officialLatest` |

### 3.2 UI

| 元素 | 行为 |
|---|---|
| 状态灯（标题行） | 绿=正常；黄=母体有更新 或 有元主待同步；红=有元主冲突 |
| `M-07`「克隆母体」 | 强提示确认 → 克隆 → 通知版本/文件数/备份 id |
| `E-02`「全部同步」 | 仅在有 `staleCount` 时出现；批量重放，通知 重算/跳过/冲突/失败 |
| `E-03`「同步」（单卡） | 元主行出现 `🔼 待同步` 时的单卡操作；官方 locked 元主只显示角标不显示按钮 |

### 3.3 安全边界

- 克隆只取配置四件套，**不复制** `node_modules/sessions/storages/logs/credentials`；
- 源目录若在镜像内部直接拒绝（防止自我覆盖）；
- 克隆前自动 `mirror.backup()`，失败也能从备份恢复；
- 同步只重算 `merged/`，**不动** `overlay/`（用户插件清单、设置、API Key 声明）；
- 所有写路由沿用 `x-fang-auth` + loopback/Origin 校验。

## 4. 下一阶段（按依赖排序）

### P1 · 2.2 一键更新（不依赖 VM）

1. 定义 `officialSource` 接口：`{ getLatestVersion(), download(targetDir) }`；
2. 先实现 **local-folder 适配器**（把「PC 客户端安装目录 / 另一个 profile」当官方源），
   配置项 `mirror.source={{kind:'profile'|'npm'|'github', path|registry|repo}}`；
3. 复用现成 `mirror.upgrade()`：自动备份 → swap → compat 门禁 → 失败自动 `restore`；
4. npm/GitHub 适配器最后做（涉及网络与版本兼容，必须默认关闭、显式开启）。

### P2 · 元主运行态（步骤 4 的前提）

1. `essence.start()`：用 `merged/profile` 起一个**配置态 Web 实例**，端口从池里分配，禁止 sessions 根；
2. 插件更新：`pnpm update`（或 `dsh plugin update --all`）在该实例的 profile 目录执行；
3. 健康检查：实例 `/api/status` + `/fang/api/compat/check` + 进程存活 ≥ N 秒；
4. 失败回滚：**目录级快照**（复制 `merged/profile` + `overlay` 到 `essences/<id>/snapshots/<ts>`，失败回填）。
   这是 VM 快照的降级替代，先保证有兜底。

### P3 · VM 快照回滚（需要 provider）

1. 定义 `snapshotProvider`：`snapshot(machine,name) / restore(machine,snapshot) / exec(machine,cmd) / job(machine,cmd)`；
2. 通过 fang 的 `commercial` 钩子（`ctx.get('fangCommercial')`）注入真实 provider（w2m 或其他）；
3. 没有 provider 时，UI 必须显式显示「目录级回滚」而不是「VM 快照」；
4. 审计：复用 `AUDIT` + `auditor`，记录 `action/snapshot/reason`。

## 5. 验收（P0）

- [x] 克隆后 `mirror/active/profile` 有 `package.json/cordis.patch.yml`，版本取 package.json；
- [x] 克隆前自动生成备份（返回 backup id）；
- [x] 镜像变化后所有元主 `stale=true`，`upgrade/status.light.tone='yellow'`；
- [x] `POST /essence/sync` 后 `staleCount=0`，用户 overlay 不变；
- [x] 元主冲突时 `light.tone='red'`；
- [x] `node --test test/orchestrator.test.mjs test/upgrade-status.test.mjs` 全绿；rich UI smoke 21/21；
- [x] `POST /mirror/clone-profile` 源在镜像内被拒绝。

## 6. 风险

| 风险 | 处理 |
|---|---|
| 克隆到一半失败 → 镜像半成品 | 先备份；克隆先删后建，失败时用备份 restore |
| 元主同步产生 fatal 冲突 | `recompute` 保留上次物化并标 `conflicted`，状态灯红灯，不覆盖 |
| 把 VM 能力当成已有 | 文档与 UI 文案区分「目录快照」与「VM 快照」，未接 provider 不宣称 |
| 一键更新拉到不兼容版本 | compat 门禁 + 自动回滚；默认关闭网络源 |
