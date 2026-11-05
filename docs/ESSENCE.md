# Essence 覆盖层（v2.9.3）

镜像 / 原身 / 分身三层里的中间层。本版本只交付**原身覆盖层的合并库**
（`src/lib/essence.mjs`）+ 单测；HTTP 服务与面板 UI 留给下一期。

## 1. 三层与数据边界

| 层 | 位置 | 可写 | 职责 |
|---|---|---|---|
| 镜像 | `<mirrorRoot>/active/profile` | 否（只由镜像升级/回退改） | DSH 基础版本 + 基础插件集 + 锁定清单 |
| 原身 | `<essencesRoot>/<essenceId>` | 是 | 装插件、改设置、登录账户；profile = 覆盖层 |
| 分身 | 不落盘配置 | 否 | 运行时临时展开原身配置；只持久化会话数据 |

原身目录：

```
<essencesRoot>/<essenceId>/
  overlay/cordis.patch.yml   # 原身插件增删改（按 id）
  overlay/package.json       # 原身依赖（dependencies）
  overlay/settings/*.yaml    # 原身设置（深合并）
  overlay/credentials/       # 原身凭据（镜像不覆盖；镜像里的凭据物化时剔除）
  merged/profile/            # 合并产物（每个原身可作 --profile 使用）
  merged/fingerprint.json    # 镜像版本/指纹/合并时间/冲突数
  meta.json                  # id/name/tier/parentId/status/lastMergedFingerprint
  conflicts.json             # 仅 conflicted 状态时存在（fatal 明细）
```

## 2. 合并语义

- **patch 条目按 id**：镜像条目保序；原身同 id → `config` 深合并、原身优先；`disabled: true` → 移除；新 id → 追加。
- **package.json**：依赖并集；主版本不同 → fatal（保留镜像版本），主版本相同 → 原身 pin 胜。
- **settings**：深合并，原身胜。
- **credentials**：只属于原身；物化时先剔除镜像可能带入的 `credentials/`，再复制原身凭据。
- **锁定项**（`mirror-locked.json` 或构造参数）：禁止禁用/改配置 → fatal，镜像配置保留；与镜像同值的"覆盖"不算冲突。

## 3. 配额（VIP）

| tier | 原身 | 子原身 | 活跃会话 |
|---|---|---|---|
| free | 5 | 5 | 10 |
| vip10 | 10 | 10 | 10 |
| vip30 | 30 | 30 | 30 |
| vip50 | 50 | 50 | 50 |
| vip100 | 100 | 100 | 100 |

归档会话不限。子原身只允许两级；父原身有子原身时不能删除。

## 4. 冲突与状态

- `recompute` 合并失败（fatal 或 patch 解析错误）→ `status: conflicted`，写 `conflicts.json`，
  **不重建 merged/profile**（保留上一次成功物化结果，原身仍可启动）。
- 修复覆盖层后再次 `recompute` → `status: ready`，删除 conflicts.json。
- `recomputeAll` 供镜像升级后批量重算，返回 `{recomputed, conflicted}`。

## 5. 零依赖实现要点

- YAML 复用 `rule-registry` 的 `parseYamlSubset`（支持 patch 的根列表/`insert:`/嵌套 config/flow map）；
- 写出一律 JSON（JSON 是合法 YAML），避免手写 emitter；
- 镜像指纹 = `digestTree(profile)` 的 sha256，用于判断是否需要重算。

## 6. 后续（未交付）

1. orchestrator 服务 `fangEssence` + HTTP `/fang/api/essence/*`（CRUD/冲突/配额）；
2. 面板：原身列表、覆盖层编辑、冲突解决入口；
3. P3：分身派生（配置层临时 + 会话数据持久化）与单会话约束；
4. 与 `mirror-locked.json` 的镜像发布会话联动（升级后自动 `recomputeAll`）。
