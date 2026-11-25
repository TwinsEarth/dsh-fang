# T6 交付报告 — Router 初判/复核 + Scorer 环境阈值（v2.0.0）

- **owner**：T6（router + scorer）
- **契约**：[CONTRACTS-V2.md](CONTRACTS-V2.md) §1 / §5.3 / §5.4 / §7 / §8；v1 契约 [CONTRACTS.md](CONTRACTS.md) §5.4 / §5.6 中未被 v2 覆盖的签名保持不变
- **写域**：`src/plugins/router.mjs`、`src/plugins/scorer.mjs`、`test/router.test.mjs`、`test/scorer.test.mjs`、`test/fixtures/t2/vm-plugin/**`、本文件
- **零第三方依赖、未改动他人文件、未写 profile**

---

## 1. 交付文件

| 文件 | 行数 | 说明 |
|---|---|---|
| `src/plugins/router.mjs` | 712 | v2：roleGate / decide（母体初判）/ confirm（分身复核，只升不降）/ containerAvailable（三态）/ runInContainer（懒加载 T8 容器） |
| `src/plugins/scorer.mjs` | 410 | v2：roleGate / Config.thresholds{mother,fork} / 三个评分方法支持 `opts.environment` + `basis` 注解；评分数学不变 |
| `test/router.test.mjs` | 568 | 23 个测试、198 处静态 `assert` 调用点 |
| `test/scorer.test.mjs` | 448 | 22 个测试、158 处静态 `assert` 调用点 |
| `test/fixtures/t2/vm-plugin/{index.js,package.json}` | — | 阈值分叉样本：单个 `node:vm` import → S=22（落在母体 A 上界 20 与分身 A 上界 25 之间） |

合计 **45 个测试 / 356 处静态断言**（循环内断言实际执行数更高）。

---

## 2. 验收命令与真实输出

```
$ node --test test/router.test.mjs test/scorer.test.mjs
ℹ tests 45  ℹ pass 45  ℹ fail 0  ℹ skipped 0  ℹ duration_ms 244.078
```

```
$ node --test --test-concurrency=1 "test/*.test.mjs"
ℹ tests 205  ℹ pass 204  ℹ fail 0  ℹ skipped 1  ℹ duration_ms 11791.57
﹣ LIVE container probe (manual): real AppContainer exec when FANG_CONTAINER_LIVE=1  # 契约 §7 手动探针，缺省 skip
```

全量套件已全绿（唯一 skip 是 T8 的真实容器手动探针，契约 §7 允许并要求缺省 skip）。此前出现过的 adapter/buffer-keeper 红项在 T5/T8 落地后消失，与本写域无关。

---

## 3. 契约对照

### 3.1 §1 角色门禁
- 两个插件 `apply` 的第一条语句都是 `roleGate(...)`（`router` / `scorer`，`cfgRole: config?.role`，`logger: ctx.logger`），未激活立即 `return`，不注册服务/定时器/路由。
- 矩阵（`rolesOf`）：`router=[mother,fork]`、`scorer=[mother,fork]`；测试覆盖 env `DSH_FANG_ROLE` 优先于 `config.role`、缺省 mother，且 **mother 与 fork 都激活但 `basis.environment` 不同**。
- 测试对两个插件分别断言：mother 实例 / fork 实例都注册服务，`service.role`（router）与 `service.environment`（scorer）随部署角色变化。

### 3.2 §5.3 Router
- `Config = { trustedPlugins, containerAvailable, container:{enabled,powershellPath,timeoutMs} }`（`container.enabled` 默认 false）。
- `decide({plugin, assessment, source})` → `RouteDecision`：静态 quickScan + 来源可信度 + 能力需求。
  - quickScan 证据来自 `assessment.signals`（S1→child-process、S2→network、S3→fs、S4→vm）或调用方直接给的 `code`（现场跑 `imports.mjs` 的 import 层扫描器）；来源 = `source`（可信度权威）+ `plugin`（身份/申报/能力）合并。
  - `basis = {role, environment, grade, source}`，`source` 带 `trusted/name/via/declaredWrites/bareWrites/needsChildProcess`，供分身复核复用。
  - v1 语义原样保留：veto 终局 deny；不可信+需要子进程 → deny；不可信/可信裸写 + 容器可用 → container；可信无裸写 → sandbox；容器不可用 → deny + 原因。评分只作 advisory。
- `confirm({decision, assessment})` → `RouteDecision & {escalated}`：
  - 先按分身 assessment/容器可用性重算一次建议，再取 `max(rank)`；`rank={sandbox:1, container:2, deny:3}`，**只升不降**；
  - 分身评分是**单向升级信号**：fork grade `E` → deny；fork grade `D` 或比母体 `basis.grade` 更差 → 至少 container；
  - `decision.route==='deny'` → **原样返回** route/reason/needsApproval，`escalated:false`，只把 basis 标注为复核环境；
  - 缺 decision / 非法 route → fail-closed deny（reason `confirm:missing-decision` / `confirm:invalid-decision-route`）。
- `containerAvailable()` → `{ok, state:'disabled'|'unavailable'|'ready', reason}`：默认配置 `{ok:false,state:'disabled',reason:'container-disabled'}`；`container.enabled=true` 时由探测缓存给出 unavailable/ready；v1 操作者断言 `containerAvailable:true` 兼容为 `{ok:true,state:'ready',reason:'configured'}`。
- `runInContainer({code, declaredWrites, env})`：唯一一次 `await import('../lib/container/index.mjs')` 懒加载（进程级模块缓存 + 失败可重试），`createContainerHost({powershellPath,timeoutMs})` → `available()` → `exec({code,env,declaredWrites,timeoutMs})`，返回 `{ok,stdout,stderr,exitCode,writes}`；宿主随插件 fiber dispose。**任何失败路径都不抛出**：
  - `enabled=false` → `{ok:false,state:'disabled',reason:'container-disabled'}`（不 import 模块）；
  - 模块不存在（`ERR_MODULE_NOT_FOUND`）→ `state:'unavailable'`, `reason:'container-module-missing'`；
  - 模块形状非法 → `reason:'container-module-invalid'`；宿主不可用 → 透传宿主 `state/reason`；`exec` 抛错 → `reason:'container-exec-error:<msg>'`。
- 真实 T8 模块手工集成冒烟（不执行容器代码）：`probes/` 已落地 → `probeContainer()` 返回 `{ok:true,state:'ready',reason:'preflight-ok'}`，`runInContainer({code:''})` 在校验阶段返回 `code-required`，未进入真实执行。

### 3.3 §5.4 Scorer
- `Config.thresholds{mother:{a,b,c,d}, fork:{a,b,c,d}}` 默认 **mother=20/40/60/80（= v1 分档）**、**fork=25/45/65/85（更宽）**；部分覆盖只改给定字段（schema 嵌套默认补齐）。
- 三个方法支持 `opts.environment`（缺省 = 本实例部署角色 / `resolveRole`）：`scoreSource(source, pkg?, opts?)`、`scoreDir(dir, manifest?, opts?)`、`scoreIntent(intent, opts?)`。
- 每个返回值（含 `scoreDir` 的 no-entry 错误路径）都带
  `basis:{environment:'mother'|'fork', thresholds:{a,b,c,d}, note:'本评分基于 <environment> 阈值'}`。
- **评分数学零改动**：DIM_WEIGHT、SIGNAL_DIM、family 去重、C3 服务宽限、B 不判绿、degraded 降 C、veto S=100 全部原样；`scoreScan` 缺省分档 = 母体 v1 分档，v1 数值断言原样通过。

### 3.4 §7 / §8
- 不 spawn 真实 dsh、不进真实容器：容器路径全部用注入的假 loader/假 host 覆盖；真实 T8 模块只在手工冒烟里做静态可用性探测（不 `exec` 代码）。
- 每个插件都覆盖角色门禁；`node --check` 全部通过；无第三方依赖；`runInContainer` 降级路径"绝不抛"由 4 个专门用例守住。

---

## 4. 阈值分叉证据（验收核心）

同一套评分数学，只是分档表不同：

| 样本 | S | 母体分档（20/40/60/80） | 分身分档（25/45/65/85） |
|---|---|---|---|
| `test/fixtures/t2/vm-plugin`（单个 `node:vm`） | **22**（20~25 区间） | **B / blue** | **A / green** |
| `scoreScan` 合成信号 `S4-vm(25)+C3-svc(30,核心服务)` | **44**（40~45 区间） | **C**（44>40） | **B**（44≤45） |

对应测试：`threshold fork: the SAME source grades B in mother and A in fork (S=22 between 20 and 25)`、`scoreDir over the static fixture shows the same B/A divergence`、`S=44 sample (40~45 band) flips C(mother) vs B(fork)`；另有 `opts.environment` 双向覆盖（母体实例按分身阈值、分身实例按母体阈值复核，编排器 `promoteTask` 的 `scoreDir(dir,null,{environment:'mother'})` 形态）。

`confirm` 升级方向对应测试：
- mother sandbox + fork 评估更糟（C/D）→ **container**（`escalated:true`, `needsApproval:true`）；
- mother container + fork 复核干净 → **仍是 container**（不降为 sandbox）；
- mother deny + 任意 fork 评估 → **仍 deny**（原样返回、`escalated:false`）；
- fork veto / fork grade E 可把 sandbox 抬到 **deny**。

---

## 5. v1 既有测试/行为变更说明（§7 要求）

v1 的**数值断言全部原样保留**（`scoreScan` 分档/维度、C3 宽限、28=B、74=D、veto E、degraded 降 C、`scoreDir` 各项、颜色映射）。仅以下断言因 v2 契约新增字段而更新：

1. `scoreIntent` 返回值新增 `basis`（契约 §5.4 明确要求）→ v1 的整对象 `deepEqual` 改为分别断言 `light`/`notes`，另加 `basis` 断言。
2. `containerAvailable()` 返回值新增 `state`（契约 §5.3 明确要求 `{ok,state,reason}`）→ v1 的 `{ok,reason}` 断言更新为三态断言；默认配置下 `reason` 由 v1 的 `not-installed`/`not-win32` 变为 `container-disabled`（v2 容器默认由 Config 关闭，语义更诚实），对应 deny 原因由 `container-unavailable:not-installed` 变为 `container-unavailable:container-disabled`。
3. `router.service.policy` 增加 `role/environment/container` 字段（只增不改，v1 的 `containerAvailable`/`trustedPlugins` 保留）。

---

## 6. 降级点 / NOT ESTABLISHED

1. **`containerAvailable()` 是同步方法**（契约签名），而 ESM 懒加载只能是异步的：探测结果缓存在 `probeCache`，`container.enabled=true` 时 `apply` 异步预热；在预热完成前返回 `state:'unavailable', reason:'not-probed'`（fail-closed，不假装 ready）。需要确定性可用状态的调用方可 `await service.probeContainer()`（本插件补充的异步方法，不改契约方法）。
2. **v1 `containerAvailable:true` 只是路由断言**：`containerAvailable()` 报告 `ready/configured`，但 `runInContainer()` 仍必须懒加载到真实 `../lib/container/index.mjs`，模块缺失时如实返回 unavailable（不因断言而假装可执行）。
3. **真实 AppContainer 执行未做端到端验证**（契约 §7 禁止测试内进真实容器；`FANG_CONTAINER_LIVE=1` 手工探针归 T8）。router 侧只验证到"懒加载 + 宿主 available() + exec 调用契约 + dispose"（假宿主），以及真实模块的静态可用性探测冒烟。
4. **`confirm` 不能重新判定来源可信度**：分身复核复用母体 `decision.basis.source` 的证据（name/trusted/declaredWrites/bareWrites/needsChildProcess），只允许用分身的 assessment（分档阈值）与分身的容器可用性**单向升级**；没有来源证据时按 fail-closed 视作不可信。
5. **评分仍是 import 层近似**（v1 局限不变）：`coverage:'import-only'`，不做调用层 exec/spawn 分析；`quickScan` 同样只做 import 层静态扫描。
6. 全量套件最终复跑全绿（205 tests / 204 pass / 1 skip = T8 的 `FANG_CONTAINER_LIVE=1` 手动探针）；本任务两文件单独运行 45/45 全绿。

---

## 7. 给集成方的对接要点

- **Orchestrator**：`scorer.scoreDir(dir, null, { environment: 'mother' })` 已按契约工作（返回 `basis` 与母体阈值判定）；`router.decide({plugin:{name}, assessment, source:'mother'})` 返回 `sandbox/container/deny`，可信来源（`source:'mother'` 是 trust token）无裸写 → sandbox。
- **Adapter（T5）`route-confirm`**：`confirm({decision, assessment})` 的返回值是纯 JSON 可序列化对象（`route/reason/needsApproval/escalated/grade/basis`），可直接作为命令结果回传；`decision` 走 HTTP 时会保留 `basis.source` 证据。
- **Approver/Auditor**：router 每条 `decide`/`confirm` 都向 `AUDIT.ROUTE` 追加 `{component:'fang-router', phase:'decide'|'confirm', route, reason, escalated, role, environment, ...}`；auditor 缺失时静默容错。
- **BufferKeeper 容器分支（T8）**：router 只消费 `createContainerHost/available/exec/dispose` 四个入口，`available()` 必须是同步、`exec()` 必须是 Promise，失败不得抛出（宿主内部归类）。
