# 审计报告 · dsh-Fang v2.7.7（保护伞 TypeScript 参考实现）

> 证据来自本机真实输出（2026-11-01，Windows / Node 24.16.0）。
> 报告不含凭据、不含本机绝对路径（allow-list 同时扫描这两类内容）。
> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 7 个补丁位（`2.7.6` → `2.7.7`）。

## 1. 本次交付

把 v2.7.6 的保护伞（`src/lib/umbrella.mjs` + `src/plugins/umbrella.mjs`）写成**可编译的 TypeScript
参考实现**，并且证明它真的能编译、行为与运行时一致：

| 交付物 | 内容 |
|---|---|
| `types/umbrella/types.ts` | 四色词汇、A–E、两张下限表、证据/策略/评估/决策/审计/缓存统计的全部类型 |
| `types/umbrella/paths.ts` | 纯字符串路径归一化与包含判定（替代 `path.resolve`/`path.relative` 的判定部分） |
| `types/umbrella/cache.ts` | 通用 LRU（命中重插、`peek` 不刷新顺序） |
| `types/umbrella/plugin-scorer.ts` | 插件评分：指纹缓存 + 失败往坏里判（`ScorerPort` 注入） |
| `types/umbrella/action-scorer.ts` | 动作评分：15 条规则 + 下限抬高 + 决策矩阵 + 策略归一化 |
| `types/umbrella/umbrella.ts` | 门面：两个出口合流、决策 + 一条 `umbrella-decision` 审计 |
| `types/umbrella/index.ts` | 公共出口 |
| `types/tsconfig.json` | 严格编译配置（见 §3） |
| `types/README.md` | 编译方法、Node 宿主适配示例、`.mjs ↔ .ts` 映射、8 条差异、边界 |
| `tools/release/typecheck.mjs` | 三态门禁脚本（真编译 / 明确 SKIP / 失败非零） |

## 2. 为什么是「参考实现」而不是运行时

- 仓库运行时是纯 `.mjs`（`src/**/*.mjs`），CI 明确保持零第三方依赖
  （`.github/workflows/ci.yml` 头注释）；引入 TypeScript 依赖会破坏那条约束。
- 因此 `types/` **不进 `package.json files`**：`dist/dsh-fang-2.7.7.tgz` 里没有它，
  安装体积不变、加载路径不变、角色矩阵与 loader 行不变。
- 为了让「可编译」不依赖 `@types/node`，TS 版把副作用全部收进端口：
  `FingerprintPort`（`fileMtime` / `hash`）、`Clock`、`ScorerPort`、`audit` 回调。
  Node 宿主适配代码只出现在 `types/README.md` 的示例里，不参与编译。

## 3. 编译与行为证据

| 项 | 命令 / 方式 | 结果 |
|---|---|---|
| 严格编译 | `DSH_FANG_TSC=<tsc.js> node tools/release/typecheck.mjs`（TypeScript **5.9.2**） | **PASS，0 error** |
| 编译开关 | `types/tsconfig.json` | `strict`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、`noImplicitOverride`、`noFallthroughCasesInSwitch`、`noUnusedLocals`、`noUnusedParameters`、`noImplicitReturns`、`isolatedModules`、`noEmit` |
| 无编译器时的诚实性 | `node tools/release/typecheck.mjs`（干净仓库） | 打印 `SKIP` + 安装方法，退出码 0，**不打印 PASS** |
| 行为等价 | 编译产物（`--outDir` 到临时目录）跑 35 项断言 | **35/35 PASS**：15 条规则逐条、两张下限表、``green + C → blue``、`red + A` 不降级、未评分动作至少红、决策七行、缓存命中不重扫、mtime 失效后重判、LRU 逐出 1、门面用缓存等级、审计恰好 1 条且字段正确 |
| 文件数 | `types/umbrella/*.ts` | 7 个（另有 `tsconfig.json`、`README.md`） |

编译命令（不污染仓库的可选方式）：

```bash
# 1) 临时装一个编译器（不进仓库依赖）
npm i --no-save typescript
npx tsc -p types/tsconfig.json

# 2) 或者直接指定任意 tsc
DSH_FANG_TSC=/abs/path/typescript/lib/tsc.js node tools/release/typecheck.mjs
```

## 4. 与设计稿的差异（与 `types/README.md` 一致）

1. **评分数学不重写**：`PluginScorer` 通过 `ScorerPort` 复用运行时 `fangScorer`（母体 20/40/60/80、
   分身 25/45/65/85），而不是在 TS 里再实现一套 15/40/70 的分档——同一仓库只允许一份评分数学。
2. **缓存键是身份 + 指纹**（入口 `mtimeMs` / inline 源码 hash），不是 `pluginId@version`：
   热更新可以不改版本号，版本键会命中过期等级。
3. **`assessPluginsBatch` 同步**（设计稿是 `Promise.all`）：动作发生前必须拿到等级，
   异步批量会留下「评分未回先放行」的窗口。
4. **规则顺序**：`dsh-lifecycle` 先于 `destructive-command`（宿主动作委托 restart-guard）。
5. **15 条规则**而非 9 条：补 `write-in-buffer`、`exec-read-only`、`exec-side-effect`、
   `write-production`、`network-allowlisted`。
6. **无 Node 内建依赖**：`paths.ts` 用纯字符串实现，`FingerprintPort` 由宿主注入。

## 5. 门禁结果（本版本）

| 门禁 | 结果 |
|---|---|
| `preflight --e2e` | **GREEN 2.7.7**（版本一致性 / CHANGELOG 段 / 许可证 / client 可解析 / 全量测试 / e2e） |
| 测试 | **446 项：445 pass / 0 fail / 1 skip（26.1s）** |
| e2e | **58/58（18.7s）**（真实母体 + 分身，含分身的 `umbrella` 器官检查） |
| allow-list | **36 路由 / 0 findings / 159 文件扫描 / 包内 71 文件**（新增 `types/` 与 `typecheck.mjs` 参与扫描） |
| 构建 | `dist/dsh-fang-2.7.7.tgz`（**261,519 B，87 entries**）<br>sha256 `e085305957d673cce5656ab36d13a263d8f569e76f298af7e67278df5f1e6ac7` |
| 产物健康检查 | **HEALTHY** `@twinsearth/dsh-fang@2.7.7`（16 个模块可 import） |

## 6. 边界

- **类型版本与运行时可能漂移**：这是参考实现的最大风险。缓解：`types/README.md` 写明
  「分歧以 `.mjs` + `docs/UMBRELLA.md` 为准」，且 `typecheck.mjs` 只保证编译，不保证语义一致；
  语义一致性靠人评审 + 本报告 §3 的 35 项行为断言（本地跑，CI 无 TS）。
- **CI 不验证 TS**：零依赖策略下的刻意取舍。`typecheck.mjs` 在干净仓库打印 `SKIP`，
  不会被误当作通过。
- **行为断言脚本不在仓库内**：它是本地临时脚本（编译产物 + 断言），未随包提交；
  若要把语义一致性做成 CI 门禁，需要先决定是否允许在 CI 安装 TypeScript。

## 7. 提交状态

- 分支：`feat/umbrella-types`（stacked 在 PR #25 的 `feat/umbrella-scoring` 之上）；
- 发布物：`dist/dsh-fang-2.7.7.tgz` + `dist/manifest.json` + `dist/preflight.json` + `dist/allowlist.json`；
- npm/GitHub Release 未执行：等待 PR 合并与维护者确认；
- 未合并 main：本 PR 只推送分支与 PR，合并由维护者手动审核。
