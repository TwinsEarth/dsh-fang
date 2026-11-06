# 设计：母体生成元主（v1，v3.0.9 落地）

> 状态：已实现（`EssenceManager.captureFromProfile` + `POST /fang/api/essence/capture` + 面板「从母体生成元主」）。
> 边界：本流程只做「生成」，不做元主启动、派生分身、子元主。

## 1. 术语与层级（沿用 GLOSSARY）

| 层 | 含义 | 本流程中的角色 |
|---|---|---|
| 母体（mother） | 正在运行的 DSH profile（`DSH_PROFILE_DIR` / `<DSH_HOME>/profiles/<tag>`） | **只读来源** |
| 镜像（mirror） | 只读基础层 `<mirrorRoot>/active/profile`（可升级/回退） | 合并基底 |
| 元主（essence） | 镜像之上的可写覆盖层（装插件、改设置、登录账户；不开会话） | **本次产物** |
| 分身（derived） | 从元主派生的临时实例 | 不在本流程内 |

关键约束：母体只读，流程结束后母体 profile 一个字节都不改。

## 2. 目标 / 非目标

**目标**

1. 用户能在面板上一键把「当前母体的可写配置」沉淀成一个独立元主，后续可配置、可复制、可派生、可回滚。
2. 生成结果可解释：捕获了什么（补丁/依赖/设置/捆绑）、有没有合并冲突、是否成为默认派生基底。
3. 边界清晰：凭据、会话、node_modules 永不进入元主。

**非目标**

- 不复制母体的 sessions / storages / logs / credentials / node_modules。
- 不启动元主的配置态 Web（后续版本）。
- 不自动设默认（除非显式 `setDefault: true`）。
- 不在官方 locked 元主上做任何写操作。

## 3. 流程

```
[面板] 元主区 · 「从母体生成元主」(E-01)
   │  弹窗：名称（默认「<profile> 元主」）
   ▼
[服务端] POST /fang/api/essence/capture
   │  ① 预检：role=mother、母体 profile 可解析（package.json 存在）、
   │           补丁可解析、不是元主自己的目录、配额 checkEssenceQuota
   │  ② 捕获（只读母体）：cordis.patch.yml → overlay.patchEntries
   │                     package.json（name/private/type/dsh/dependencies）→ overlay.packageJson
   │                     settings/*.yaml → overlay.settings
   │  ③ 落盘：create() 生成 essence-<ts>-<hash>，写 overlay，recompute() 合并镜像并物化
   │  ④ 可选：setDefault → essences/default.json
   ▼
[面板] 通知：补丁 N 条 / 依赖 N 个 / 设置 N 组 / 捆绑 N 个；有冲突则标黄
   │  元主列表新增一行（默认 / 冲突 chip）
```

### 3.1 捕获清单

| 母体内容 | 是否复制 | 落到元主哪里 |
|---|---|---|
| `cordis.patch.yml` | ✅ | `overlay/cordis.patch.yml`（patch entries） |
| `package.json`：`name/private/type/dsh/dependencies` | ✅（可用 `includeDependencies:false` 关闭） | `overlay/package.json` |
| `package.json`：`scripts/devDependencies/pnpm` | ❌ | — |
| `settings/*.yaml,*.yml` | ✅（可用 `includeSettings:false` 关闭） | `overlay/settings/<名>.yaml` |
| `credentials/` | ❌ | —（B8 永久边界） |
| `sessions/ storages/ logs/ data/` | ❌ | — |
| `node_modules/` | ❌ | —（依赖声明随 package.json 复制，物化不复制文件） |
| 其他元主目录 | ❌（显式拒绝，避免自我叠加） | — |

### 3.2 预检与失败语义

| 情况 | 行为 |
|---|---|
| 母体 `package.json` 缺失 | 400 `capture-failed`，detail 指明路径 |
| 母体 patch 解析失败 | 400 `capture-failed`，detail 给出解析错误 |
| 目标目录在 `<essencesRoot>` 内 | 400 `refusing to clone from an essence directory` |
| 配额已满（默认 5） | 400 `capture-failed`，detail 为 `essence quota exceeded: n/5` |
| 合并出现 fatal 冲突 | **200 但 `status=conflicted`**：元主保留（可修复），`conflicts[]` 原样返回，面板标黄并提示人工处理 |
| 合并有 warning 冲突 | 200 `status=ready`，`conflicts[]` 一并返回 |

## 4. API 契约

`POST /fang/api/essence/capture`（鉴权沿用 `x-fang-auth`）

请求：

```json
{ "name": "desktop 元主", "tier": "free", "parentId": null,
  "includeDependencies": true, "includeSettings": true, "setDefault": false }
```

响应：

```json
{ "ok": true,
  "meta": { "id": "essence-...", "name": "desktop 元主", "status": "ready", "parentId": null },
  "captured": { "profileDir": "...", "profileName": "desktop",
                "patchEntries": 5, "dependencies": 24, "bundles": 14,
                "settings": 0, "credentialsCopied": false },
  "conflicts": [], "status": "ready",
  "default": null }
```

`name` 省略时用 `<profile 名> 元主` 兜底；`setDefault:true` 时 `default` 返回 `{essenceId,name}`。

## 5. UI 契约

| 元素 | 行为 |
|---|---|
| `E-01`「从母体生成元主」 | 元主区标题右侧；`askPrompt` 输入名称 → 调 API → `refresh()` |
| 成功通知 | 「元主已生成」+ 补丁/依赖/设置/捆绑计数 |
| 冲突通知 | 「元主已生成（有冲突）」+ 冲突条数，详情留待元主详情页 |
| 失败通知 | `failureHint('capture-failed')` + 服务端 detail |
| 元主行 chip | `默认`（= `defaultId`）、`锁定`（官方）、`冲突`（status=conflicted） |
| 空态 | 「还没有自定义元主；点上方…克隆当前母体配置」 |

## 6. 代码索引

| 层 | 位置 |
|---|---|
| 捕获实现 | `src/lib/essence.mjs` → `captureFromProfile()`、`selectProfilePackage()`、`readProfileSettings()` |
| 服务 | `src/plugins/orchestrator.mjs` → `mirrorService.captureEssence()`（母体目录取 `templateDir()`） |
| 路由 | `src/plugins/orchestrator.mjs` → `POST ${prefix}/api/essence/capture` |
| 客户端 | `client.js` → `captureEssence()`、元主区 `E-01` 按钮、`FAILURE_HINTS['capture-failed']` |
| 测试 | `test/essence.test.mjs`（捕获/凭据边界/自我叠加拒绝）、`test/orchestrator.test.mjs`（路由 200/兜底命名） |

## 7. 验收

- [x] 捕获后 `overlay/cordis.patch.yml` 含母体 patch 条目，`overlay/package.json` 只含允许字段；
- [x] `overlay/credentials` 为空，`merged/profile/credentials` 不存在；
- [x] 拒绝从元主目录捕获；
- [x] 路由注册且鉴权失败为 401（共享 gate）；
- [x] 面板按钮可点、三态通知、列表 chip 正确；
- [x] `node --test test/essence.test.mjs test/orchestrator.test.mjs` 全绿；rich UI smoke 21/21。

## 8. 后续（不在 v1）

1. **配置态 Web**：用 `merged/profile` 启动一个可配置实例（拒绝 sessions 根，DECISIONS v3.0.8 #4）。
2. **元主派生**：`actions.derive` 已有语义位，接 forker 的 essence 模板选择。
3. **子元主**：两级限制已在 `create()` 内实现，UI 尚未暴露。
4. **差异视图**：母体 vs 元主 patch/deps 的 diff 预览，生成前可确认。
