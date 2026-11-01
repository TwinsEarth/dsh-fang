# 保护伞系统（Umbrella）· v2.7.6

> 代码：`src/lib/umbrella.mjs`（纯逻辑，35 项测试）+ `src/plugins/umbrella.mjs`（loader 行 `fang-umbrella`）。
> 服务键：`fangUmbrella`；角色矩阵：母体 ✅ / 分身 ✅ / consumer ❌。
> 契约：`docs/CONTRACTS-V2.md §5.9`；静态评分数学沿用 `docs/CONTRACTS-V2.md §5.4`（fang-scorer）。

## 0. 结论先行

保护伞不是「打两个分」，而是**一个证据管道、两个评分出口、一套耦合规则**：

```
证据层  插件源码 ──► fang-scorer 的 import 层扫描（S1–S7 / C2–C5 → D1–D6 → A–E）  ← 只在指纹变化时重算
        动作元数据（tool / args / target / scope / pluginId）
              │
评分层  PluginScorer → A|B|C|D|E（静态）        ActionScorer → green|blue|yellow|red（动态）
              │                                        │
耦合层        └──────────► effectiveLight = max(baseLight, gradeFloor(grade)) ◄──┘
                                   │
决策层                       allow / mark / ask / delegate / deny
```

三条写死的原则（都有测试）：

1. **失败往坏里判**：拿不到 fang-scorer → `E`；认不出的工具 → `yellow`；认不出的灯色 → `yellow`。
2. **等级只能抬高灯色**，永不能降低：A 级插件做红灯动作仍然是红灯；C 级插件的绿动作会被抬成蓝。
3. **动作评分不缓存**：`args` 的语义等价性无法可靠判定（同一条命令的两个写法可能一个是只读、一个有副作用）。

## 1. 插件评分器：A–E（复用既有，不重复造）

保护伞**不扫源码**。静态证据的唯一来源是 `fangScorer` 服务（v2.x 起，import 层手写 tokenizer）：

| 项 | 现状 |
|---|---|
| 信号 | S1–S7（危险能力）、C2–C5（耦合/服务面），族内去重后按维度 D1–D6 加权 |
| 分档 | 母体 `20/40/60/80`；分身更宽 `25/45/65/85`（`scoreDir(dir, manifest, {environment})` 选择） |
| 否决 | `package.json` 的 `dsh.hotReload === false` → 直接 `E`（`S=100`），不可协商 |
| 降级 | 扫描有 tokenizer warning（`degraded`）时 A/B 一律降 C：证据不全不给绿灯 |
| 局限 | **只做 import 层**近似，不做调用层（`exec/spawn` 的实际调用点）；`coverage='import-only'` |

保护伞在这之上加的是**缓存与门面**：

| 缓存项 | 键 | 失效条件 | 容量 |
|---|---|---|---|
| 插件评分 | 插件身份（`pluginId` / `dir` / inline 源码 sha1） | 入口文件 `mtimeMs` 变化，或 inline 源码内容变化 | LRU 200（可配 `cacheSize`） |

**与设计稿的差异（刻意的）**：设计稿的键是 `pluginId@version`。本仓库不用 `version` 做键，因为热更新可以在**不改 `package.json` 版本**的情况下重写入口文件——那会让缓存命中一个已经过期的等级。指纹（入口 mtime / 源码 sha1）能抓到这个场景，`version` 只写进评估结果供审计。代价是每次命中要 `stat` 一个文件（微秒级）。

`assessPlugin()` 的输出：

```js
{
  pluginId, version,
  grade: 'A'|'B'|'C'|'D'|'E',
  score, color, veto, degraded,
  signals: [{ id, weight }], reasons: [...], basis: { environment, thresholds, note },
  entry, dir, cachedAt, fingerprint, durationMs, fromCache,
}
```

找不到 fang-scorer 时不是抛错，而是 `grade:'E', degraded:true, reasons:['scorer-unavailable']`——调用方永远拿到一个可用的保守结论。

## 2. 动作评分器：绿 / 蓝 / 黄 / 红

输入（`ActionEvidence`）：

```js
{ tool: 'write'|'bash'|'read'|'web_fetch'|'import'|..., args: {...},
  target?: { kind: 'path'|'url'|'command'|'pid', value }, scope?: 'session'|'system'|'process',
  pluginId?, pluginGrade? }
```

策略（`normalizePolicy`，相对路径按 `root` 解析）：

```js
{ root, bufferRoot, productionRoot, allowPaths[], networkAllowlist[],
  credentialPatterns[], destructivePatterns[], lifecyclePatterns[], lifecycleTools[], readOnlyExecPatterns[] }
```

**显式传空数组 = 一条规则都不要；只有缺省才用内置默认值**（内置凭据/破坏性/生命周期模式见源码常量，均有 ≥10 条）。

规则表（**先命中先返回**，`matchedRule` 供审计追溯）：

| # | 规则 id | 条件 | 灯色 | 备注 |
|---|---|---|---|---|
| 1 | `dsh-lifecycle` | `scope` 为 system/process、工具在 `lifecycleTools`、或命令命中生命周期模式（`dsh … restart/kill`、`taskkill … /im dsh`、`Stop-Process`） | 红 | 决策层**委托** restart-guard，不直接弹窗 |
| 2 | `destructive-command` | 命令命中破坏性模式（`rm -rf`、`Remove-Item -Recurse -Force`、`git push --force`、`reg delete`、`taskkill`、`DROP TABLE`…） | 红 | 不可逆 |
| 3 | `credential-access` | 目标/命令命中凭据模式（`.ssh/`、`id_rsa`、`.aws/credentials`、`.git-credentials`、`config/SAM`、`Login Data`…） | 红 | **唯一硬拒绝** |
| 4 | `network-allowlisted` | 外连且命中 `networkAllowlist`（host / host:port / `*.suffix` / URL 前缀） | 蓝 | 放行 + 标记 |
| 5 | `network-egress` | 外连且未命中允许列表（URL 解析失败也算未命中） | 黄 | 询问 |
| 6 | `dynamic-import` | 工具是 `import`/`require` 形态 | 黄 | 加载未评分模块 |
| 7 | `write-in-buffer` | 写在 `bufferRoot` 内 | 蓝 | 沙箱内副作用 |
| 8 | `write-in-allowlist` | 写在 `allowPaths` 前缀内 | 蓝 | 受控 |
| 9 | `write-production` | 写在 `productionRoot` 内 | 黄 | 单列规则，便于审计统计 |
| 10 | `write-outside-buffer` | 其余写 | 黄 | 越界 |
| 11 | `exec-read-only` | shell 命令命中只读白名单（`dir/ls/cat/Get-Content/git status/node --version`…）且**不含写重定向** | 蓝 | 判定依据是模式匹配，所以是蓝不是绿 |
| 12 | `exec-side-effect` | 其余 shell 命令 | 黄 | 有副作用且未能证明只读 |
| 13 | `read-in-buffer` | 只读且落在 `bufferRoot` 内 | 绿 | 唯一绿灯 |
| 14 | `read-outside-buffer` | 其余只读 | 蓝 | 读没危险但有信息暴露 |
| 15 | `unknown-tool` | 未登记的工具 / 没有目标 | 黄 | 兜底，不判绿 |

**两处与设计稿不同，都是为了诚实**：

- 顺序把 `dsh-lifecycle` 提到 `destructive-command` 之前。设计稿把破坏性放第一；但 `taskkill /im dsh` 这类命令同时命中两条，若先判破坏性，决策会变成「询问用户」而不是「交给 restart-guard」。先判生命周期让宿主动作走专用路径，其余破坏性命令仍走 `ask`。
- 设计稿的规则表里没有「缓冲区内写」和「只读 shell」。前者落黄显然是错的（沙箱内写是正常活动），后者落绿等于相信模式匹配永远不会误判。本仓库补成蓝。
- 未登记工具兜底黄，与设计稿一致：**未知的风险不低于「越界写」**。

## 3. 耦合：等级下限 `gradeFloor` + 取最大

```js
effectiveLight = maxLight(baseLight, gradeFloor(pluginGrade))
```

| 表 | A | B | C | D | E | 说明 |
|---|---|---|---|---|---|---|
| `umbrella`（默认，= 设计稿 §3.3） | 绿 | 绿 | 蓝 | 黄 | 红 | 下限只按「等级暴露面」设 |
| `strict` | 绿 | 蓝 | 黄 | 红 | 红 | 与 kernel `GRADE_COLOR` 完全一致（插件自身颜色） |

配置项 `gradeFloorTable` 选择，未知值回退 `umbrella` 并把 `floorDegraded: true` 暴露给调用方（不抛错、不静默改语义）。

**为什么两张表**：`GRADE_COLOR`（A 绿 / B 蓝 / C 黄 / D、E 红）回答「这个插件在面板上该显示什么颜色」；`gradeFloor` 回答「这个等级的插件跑动作时，灯色下限是多少」。二者在 B 级上必然不同——B 级插件（单一危险能力，如只有 `child_process`，28 分）自身的颜色已经是蓝，但它被允许在沙箱里自由行动，绿动作不该被无理由抬高。这个张力写在这里而不是藏进代码；要一致的部署用 `strict`。

性质（有属性测试覆盖 4 灯 × 6 等级全组合）：

- `rank(effective) ≥ rank(base)`：等级永不降低动作风险；
- `rank(effective) ≥ rank(floor)`：下限永远成立；
- `raised` 精确表示「这次是否被等级抬高」，供审计区分「动作本身危险」与「插件整体可疑」。

## 4. 决策矩阵

| 灯色 | 动作类别 | 决策 | 消费者 |
|---|---|---|---|
| 绿 | 任意 | `allow` | 工具执行器直接执行 |
| 蓝 | 任意 | `mark` | 执行，但审计标 `elevated: true` |
| 黄 | 非生命周期 | `ask` | 审批队列（approver），用户批准/拒绝 |
| 黄 | DSH 生命周期 | `delegate` | 转交 restart-guard，带 `originLight: 'yellow'` |
| 红 | 非生命周期、非凭据 | `ask` + `severity: 'critical'` | 审批队列，红色警告 |
| 红 | DSH 生命周期 | `delegate` | 转交 restart-guard，带 `originLight: 'red'` |
| 红 | 凭据访问 | `deny` | 直接拒绝，**不允许单次批准** |

凭据访问是唯一硬拒绝：`~/.ssh`、`~/.aws` 这类路径没有「批准一次」的合理场景——插件真需要凭据应走 DSH 的凭据服务。凭据 + 生命周期同时命中时硬拒绝优先。

**词汇映射**：kernel 的 `RISK` 只有三档（蓝/黄/红，重启审批用），四色灯多了「绿」——它表示「不需要产生任何审批请求」，所以在 restart-guard 里没有对应值。`delegate` 携带的 `originLight` 正是 restart-guard `classifyRisk` 已经接受的输入（`red` → 红、`yellow` → 黄）。

## 5. 门面 API（`fangUmbrella` 服务）

```js
const umb = ctx.get('fangUmbrella')

umb.environment      // 'mother' | 'fork'（插件评分按它选阈值）
umb.policy           // 归一化后的策略（只读快照；bufferRoot 跟随 buffer-keeper 的实时 dir）
umb.floorTable       // 'umbrella' | 'strict' | 'custom'
umb.floors           // 当前生效的下限表

umb.assessPlugin({ pluginId?, dir?, manifest?, source?, pkg?, version?, refresh? })
umb.assessAction(evidence, { grade? | assessment? | pluginId? })
umb.decideAction(evidence, { grade? | assessment? | pluginId? })   // = assessAction + decide + 审计
umb.baseLight(evidence)            // 只算基础灯色，忽略插件等级
umb.gradeFloor(grade)              // 等级 → 下限灯色
umb.effectiveLight(base, grade)    // { light, baseLight, gradeFloor, pluginGrade, raised }
umb.cachedGrade(pluginId)          // 缓存里的等级（未评分为 null）
umb.cacheStats()                   // { hits, misses, evictions, invalidations, pluginScans, size, capacity }
umb.invalidate(pluginId) / umb.clearCache()
```

**延迟预算**：`assessAction` 是纯字符串/正则匹配 + 一次 Map 查询，不涉及文件 IO、不做 AST 遍历。测试用 1000 次调用度量，断言平均 < 2ms/次（实测 ~0.02ms/次，量级余量留给慢 CI）。
`assessPlugin` 在缓存命中时只多一次 `stat`；未命中时才调用 fang-scorer 读入口文件并扫描。

## 6. 动作评分为什么不缓存

设计稿的判断是对的，这里记录理由：`args` 的语义等价性不可判定——`git status` 与 `git status > log.txt` 是同一前缀但后者有副作用；`rm -rf a` 与 `rm -rf ./a` 等价而 `rm -rf "a b"` 不同。用字符串做键要么缓存不足（命中率低），要么缓存错误（安全缺陷）。收益不值得复杂度，所以不缓存。

## 7. 与现有组件的接线（诚实清单）

| 组件 | 现状 |
|---|---|
| `fang-scorer` | ✅ 唯一静态证据源；保护伞通过服务调用它，不重复扫描 |
| `fang-umbrella` | ✅ 本版本新增（母体 + 分身） |
| `fang-restart-guard` | ✅ `classifyRisk` 已接受 `originLight: 'red'|'yellow'`，与 `delegate` 的载荷对齐；⚠️ **决策流未自动接线**：保护伞只返回 `delegate`，把决定权留给调用方 |
| `fang-approver` | ✅ 待批队列与 `APPROVAL_REQUESTED` 审计已存在；⚠️ 同样未自动接线：`ask` 由调用方投递 |
| `fang-router` | ✅ 用 `grade` 做插件级路由（sandbox/container/deny + 只升不降），与动作级 `light` 是两个层次，不冲突 |
| `fang-hot-reloader` | ⚠️ 保持现状：swap 前用健康窗与 `requireApprovalForSwap`，不调用保护伞（改了会动既有审批语义，超出本版本范围） |
| DSH 工具执行器 | ❌ **本仓库没有工具拦截钩子**。保护伞是**决策库 + 服务面**，不是强制闸门：未经接线的调用方不会经过它。这是本版本最大的边界，写在 `docs/CONTRACTS-V2.md §5.9` 与审计报告里，不假装「已拦截」 |

## 8. 审计形态

一次 `decideAction` = 一条 `AUDIT.UMBRELLA_DECISION`（`kind: 'umbrella-decision'`）：

| 字段 | 含义 |
|---|---|
| `at` / `durationMs` | 时间戳与本次决策耗时 |
| `tool` / `target` | 动作与目标（路径只记 `{kind, value}`，不复制文件内容） |
| `pluginId` / `pluginGrade` / `gradeBasis` | 等级及其来源（`explicit-grade` / `assessment` / `evidence` / `cached-plugin-grade` / `unscored-fail-closed`） |
| `baseLight` / `light` / `matchedRule` | **为什么**是这个灯色（例：`baseLight: 'red'`, `matchedRule: 'credential-access'`） |
| `decision` / `severity` | 五选一的决策与严重度 |

「为什么这个动作被放行/被拦截」的完整答案就是 `matchedRule + baseLight + light + pluginGrade` 四个字段。插件评分本身不在这里重复写：`scoreDir()` 已经各自落 `AUDIT.SCORE`，保护伞再写一遍会造成双计。`auditDecisions: false` 可关掉决策审计（缓存与判断不受影响）。

## 9. 校准三问（设计稿提出，记录现状）

1. **`S3-fs-write` 的 +15 是否过高**：属于 fang-scorer 的权重表，本版本未改。要校准就在 `DIM_WEIGHT`/信号权重上做，并跑真实插件集统计分布（目标：B 级约 60%、C 级约 30%），不要靠直觉调。
2. **`gradeFloor('C') = 'blue'` 是否过严**：确实会让大量 C 级插件的绿动作变成蓝。本版本的答案是「给开关而不是改默认」：`strict` 表把下限对齐 `GRADE_COLOR`（C→黄，更严），`umbrella` 表保持设计稿。若要放松，应新增第三张表（如 `C→green`），而不是偷偷改默认——默认值是一份契约。
3. **`max` 还是 `base + offset`**：采 `max`。偏移方案会让 `red + 1` 溢出到不存在的灯色，还要额外定义「红+1 是什么」；`max` 单调、可解释、无溢出，且审计里能直接看到 `raised` 布尔。除非实测证明它过度保守，否则不换。

## 10. 设计稿 → 本仓库：差异表

| 设计稿 | 本仓库 | 原因 |
|---|---|---|
| `AdapterPlugin` 里读 `DSH_ADAPTER_PORT` 风格 | 无端口概念：保护伞是进程内服务 | 动作评分不落网络 |
| 缓存键 `pluginId@version` | 身份 + 指纹（mtime / sha1） | 热更新可能不改版本号 |
| 破坏性规则先于生命周期 | 生命周期先于破坏性 | 让宿主动作走 restart-guard 委托路径 |
| 规则表无「缓冲区内写」「只读 shell」 | 补为目标蓝 | 前者落黄明显错，后者落绿是过度自信 |
| `isWriteOutsideBuffer` 单一黄灯 | 拆 `write-production` / `write-outside-buffer` 两条 | 审计可分别统计 |
| `effectiveLight` 调制 D/E | 一致：D→黄、E→红 | — |
| `assessAction` 延迟 < 5ms | 实测 ~0.02ms，测试守 2ms | 余量给慢 CI |
| 「工具执行器直接执行」 | **没有执行器钩子**，决策由调用方执行 | 见 §7 边界 |
| 审计 `ScoringAuditEvent` 两种 kind | 插件评分沿用 `score`，动作决策用 `umbrella-decision` | 避免同一事实双写 |

## 11. 测试与验收

`test/umbrella.test.mjs`（35 项，全部通过）：

- 灯色词汇与归一化、`maxLight`/`lightAtLeast`；
- 两张下限表逐级断言、未知等级/未知表名的失败往坏里判、4×6 全组合单调性属性；
- 15 条基础规则逐条命中（含优先级、相对路径解析、显式空数组接管）；
- 决策矩阵七行全覆盖（含凭据优先于生命周期）；
- 缓存：命中不重扫、mtime 失效后重扫并换等级、LRU 逐出、`invalidate`、`refresh`；
- 失败往坏里判：无 scorer → E + degraded + 未评分动作至少红；
- 等级耦合：A/C/D 三档对同一绿动作的三种结果、证据等级与缓存等级两条来源；
- 审计：一条决策一条记录、字段完整、审计回调抛错不影响决策；
- policy 函数实时生效（buffer root 变化）；
- 延迟预算；
- 插件形态：角色矩阵（母体/分身/consumer）、服务面、配置项（strict 表、buffer 实时 dir）、无 scorer 时仍可回答、未知 `gradeFloorTable` 降级。

门禁：`node tools/release/preflight.mjs --e2e`（含全量测试 + 真实母体/分身 e2e）、`build.mjs`、`allowlist.mjs --with-manifest`、`healthz.mjs`。

## 12. TypeScript 参考实现（v2.7.7）

运行时是纯 `.mjs`；`types/umbrella/` 是同一语义的**可编译镜像**（`types.ts` / `paths.ts` / `cache.ts` /
`plugin-scorer.ts` / `action-scorer.ts` / `umbrella.ts` / `index.ts`），供类型消费与跨语言移植：

- 不 import `node:` 内建模块——文件系统（mtime / hash）、时钟、评分服务、审计全部是注入端口
  （`FingerprintPort` / `Clock` / `ScorerPort` / `audit`），因此任意宿主一个 `tsc` 就能编译；
- 编译开关：`strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` + `noUnused*` + `noImplicitReturns`；
- `node tools/release/typecheck.mjs`（或 `npm run typecheck`）：有编译器就真编译、没有就打印 `SKIP`，绝不假装 PASS；
- 不随包发布：`types/` 不在 `package.json files` 内，CI 不加 TypeScript 依赖（保持零依赖）；
- 语义分歧时以 `.mjs` + 本文件为准，并同步修正 `types/`。差异清单见 `types/README.md`。
