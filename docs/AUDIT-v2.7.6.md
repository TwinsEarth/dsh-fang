# 审计报告 · dsh-Fang v2.7.6（保护伞系统）

> 证据来自本机真实门禁输出（2026-11-01，Windows / Node 24.16.0）。
> 报告不含凭据、不含本机绝对路径（allow-list 同时扫描这两类内容）。
> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 6 个补丁位（`2.7.5` → `2.7.6`）。

## 1. 本次交付

新增第 12 个子插件 `fang-umbrella`（loader 行 `fang-umbrella`，服务键 `fangUmbrella`，
母体 + 分身都激活）+ 纯逻辑库 `src/lib/umbrella.mjs`：

- **插件评分 A–E**：不重复扫源码，复用既有 `fang-scorer`（import 层、D1–D6、C3 宽限、
  `hotReload:false` veto、degraded A/B→C）；保护伞只加"证据缓存 + 门面"。
- **动作评分 四色**：15 条规则，按危险度排序，每条带 `matchedRule`；
  `dsh-lifecycle` 先于 `destructive-command`（让宿主动作走 restart-guard 委托路径）。
- **耦合**：`effectiveLight = max(baseLight, gradeFloor(grade))`，只升不降；
  两张下限表 `umbrella`（设计稿原表）与 `strict`（= kernel `GRADE_COLOR`），配置可切。
- **决策矩阵**：`allow / mark / ask / delegate / deny`；凭据访问唯一硬拒绝。
- **审计**：一次 `decideAction` 一条 `umbrella-decision`；插件评分沿用 scorer 的 `score`，不双写。

## 2. 具体改动清单

| 类别 | 文件 | 内容 |
|---|---|---|
| 新代码 | `src/lib/umbrella.mjs`（新增） | 灯色词汇、两张下限表、`baseLight` 15 条规则、决策矩阵、`createUmbrella` 门面（指纹缓存 / LRU / 审计 / 实时策略） |
| 新插件 | `src/plugins/umbrella.mjs`（新增） | `fang-umbrella`：`roleGate`、Config（11 项）、服务面、scorer 缺失时的失败形状 |
| kernel | `src/kernel/types.mjs` | `SERVICE.umbrella`、`ROW.umbrella`、`LIGHT`、`LIGHT_RANK`、`AUDIT.UMBRELLA_DECISION`、`FANG_VERSION=2.7.6` |
| kernel | `src/kernel/role.mjs` | `MATRIX.umbrella = ['mother','fork']` |
| 装载 | `package.json`、`cordis.patch.yml`、`src/compose.mjs` | 新 export `./umbrella`、新 loader 行、compose 嵌套 fiber |
| 集成 | `src/plugins/adapter.mjs` | `/adapter/status.services` 增加 `umbrella`（增量字段，不破坏既有键） |
| 测试 | `test/umbrella.test.mjs`（新增） | 35 项；另有 `test/adapter.test.mjs`、`test/plugins-shape.test.mjs`、`test/role-extensions.test.mjs`、`test/kernel.test.mjs` 同步 |
| e2e | `tools/e2e.mjs` | 新增 `fork has umbrella organ`（真实分身上报 `services.umbrella === true`），版本断言 2.7.6 |
| 文档 | `docs/UMBRELLA.md`（新增）、`docs/CONTRACTS-V2.md §5.9`、`docs/CHANGELOG.md`、`README.md` | 设计映射、差异表、契约、变更记录、部署矩阵 |

## 3. 门禁结果

| 门禁 | 命令 | 结果 |
|---|---|---|
| 版本一致性 | `node tools/release/preflight.mjs --e2e` | **GREEN 2.7.6** |
| Client 半可解析 | 同上 | `node --check client.js` **green** |
| 单元/集成测试 | 同上（内嵌全量） | **445 pass / 0 fail / 1 skip（446 项，25.5s）** |
| e2e 实机验收 | 同上 | **58/58（16.2s）**，含新增的分身 `umbrella` 器官检查 |
| allow-list + 秘密/本机路径扫描 | `node tools/release/allowlist.mjs --with-manifest` | **PASS**：36 路由、0 findings、155 文件扫描、包内 71 文件 allow-listed |
| 构建 | `node tools/release/build.mjs` | `dist/dsh-fang-2.7.6.tgz`（**261,509 B，87 entries**）<br>sha256 `9ea3b6d74a02281b703e935fdbed7ad32dd20ac11eade558a47741d7978c8290` |
| 产物健康检查 | `node tools/release/healthz.mjs` | **HEALTHY** `@twinsearth/dsh-fang@2.7.6`（**16 个模块**可 import） |

测试计数：v2.7.5 为 410 项（409 pass / 1 skip）；本版本 **446 项（445 pass / 1 skip）**，
新增 36 项 = 保护伞 35 项 + 角色矩阵/形态/适配器服务的增量断言。e2e 从 57 → **58** 项。

## 4. 刻意的取舍（都写进了文档，不是遗漏）

1. **默认下限表与 `GRADE_COLOR` 在 B 级上不同**（`umbrella`：B→绿；`GRADE_COLOR`：B→蓝）。
   二者回答不同问题：插件自身颜色 vs 动作灯色下限。要一致的部署用 `strict` 表；
   默认值不改，因为默认值是一份契约（`docs/UMBRELLA.md §3`）。
2. **缓存键是身份 + 指纹**，不是 `pluginId@version`：热更新可能不改 `package.json` 版本，
   用版本做键会命中过期等级；入口 mtime / 源码 sha1 能抓到。代价是命中时要 stat 一次。
3. **规则顺序**：`dsh-lifecycle` 先于 `destructive-command`（设计稿相反）。否则
   `taskkill /im dsh` 会变成 "询问用户" 而不是 "交给 restart-guard"。
4. **补两条设计稿没有的规则**：缓冲区内写 → 蓝（落黄显然错）、只读 shell → 蓝（落绿是过度自信）。
5. **动作评分不缓存**：`args` 语义等价性不可判定（同前缀只读 vs 有副作用）。
6. **没有强制拦截**：本仓库没有工具执行钩子，保护伞是**决策库 + 服务面**；
   `delegate`/`ask` 的落点（restart-guard / approver）需要调用方显式投递。
   这条边界在 `docs/UMBRELLA.md §7`、`docs/CONTRACTS-V2.md §5.9` 都写明了，不假装"已拦截"。

## 5. 边界

- 插件评分继承 `fang-scorer` 的 **import-only** 局限：只看 import 层，不看 `exec/spawn`
  的实际调用点；`coverage='import-only'` 如实上报。
- 动作评分的路径判定依赖 `path.resolve` + 前缀比较（Windows 下大小写不敏感）；
  符号链接/junction 未做 realpath 解析——真实路径可能落在缓冲区外而字面路径在内，
  这是已知缺口，需要时由调用方传入已解析路径。
- `bufferRoot` 未配置且 `buffer-keeper` 未启动时，"沙箱内"判定不可用：写一律黄、读一律蓝
  （失败往坏里判），不会误判成绿。
- 决策审计不带文件内容，只带 `{kind, value}` 目标——审计链不成为数据泄露面。

## 6. 提交状态

- 分支：`feat/umbrella-scoring`（stacked 在 PR #24 的 `docs/port-lifecycle` 之上）；
- 发布物：`dist/dsh-fang-2.7.6.tgz` + `dist/manifest.json` + `dist/preflight.json` + `dist/allowlist.json`；
- npm/GitHub Release 未执行：等待 PR 合并与维护者确认；
- 未合并 main：本 PR 只推送分支与 PR，合并由维护者手动审核。
