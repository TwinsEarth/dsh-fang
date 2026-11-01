# T2 完成报告：scorer + healer + router

> 任务：task-2（T2 开发工程师 `t2-risk`）｜仓库：`dsh-fang`｜版本 1.0.0
> 环境：Windows + node v24.16.0，ESM，零外部依赖，测试仅 `node:test` + `node:assert/strict`。

## 1. 结论

三个子插件按 `docs/CONTRACTS.md` §5.4 / §5.5 / §5.6 实现完毕，服务 key 分别用
`SERVICE.scorer / SERVICE.healer / SERVICE.router`，注册范式统一为
`ctx.effect(() => ctx.provide(key, service))`，审计统一
`ctx.get(SERVICE.auditor)?.append(...)` 容错（auditor 未加载不报错）。

```powershell
cd dsh-fang
node --test test/scorer.test.mjs test/healer.test.mjs test/router.test.mjs
# ℹ tests 42  ℹ pass 42  ℹ fail 0  ℹ duration_ms ≈357
```

单文件：scorer 15 tests / healer 15 tests / router 12 tests，全部 0 fail。
断言数（`assert.*` 调用点，脚本计数）：**scorer 85 / healer 110 / router 68**（要求 ≥8）。

## 2. 交付文件

| 文件 | 说明 |
|---|---|
| `src/plugins/scorer.mjs`（9.0 KB） | `fangScorer`：scoreSource / scoreDir / scoreIntent |
| `src/plugins/healer.mjs`（27.0 KB） | `fangHealer`：selfCheck / evidence / gates(G1–G12) / suggestFix |
| `src/plugins/router.mjs`（9.1 KB） | `fangRouter`：decide / containerAvailable |
| `test/scorer.test.mjs`（15 tests / 85 asserts） | 评分数学、分档、veto、degraded、scoreDir 真实临时目录、scoreIntent、审计 |
| `test/healer.test.mjs`（15 tests / 110 asserts） | selfCheck、evidence、G1–G12 pass/fail/unknown、suggestFix 不写盘 |
| `test/router.test.mjs`（12 tests / 68 asserts） | 四种路由 + veto + 来源可信度 + 容器降级 + 审计 |
| `test/fixtures/t2/clean-plugin/**` | 干净中间层插件 fixture（package.json + index.js） |
| `test/fixtures/t2/risky-plugin/**` | 故意违反门禁的 fixture（eval/child_process/裸定时器/硬编码密钥/未申报依赖/build script） |

**未修改**：`src/plugins/imports.mjs` 一行未动（`scanSource` / `importsToSignals` 行为保持原样）；
`src/kernel/**`、`test/helpers.mjs`、`package.json`、`cordis.patch.yml`、`client.js` 均未触碰。

## 3. 实现要点与覆盖点

### 3.1 scorer（评分）

- 数学与参考实现 `dsh-hot-update/packages/score-guard/index.js` **数值同构**：
  `DIM_WEIGHT={D1:28,D2:22,D3:18,D4:14,D5:10,D6:8}`、`SIGNAL_DIM`、`familyOf/dedupeByFamily`、
  C3 服务宽限（<9 个非核心服务权重归零）、`sev=min(5,round(w/30*5))`、`perDim` 取 max、
  分档 **A≤20 / B≤40 / C≤60 / D≤80 / E>80**。
- 颜色：A=green、B=blue、C=yellow、D/E=red（**B 级不得判绿**：child_process 单独 28 分 = B → blue）。
- veto：`pkg.dsh.hotReload === false` → `{grade:'E', S:100, veto:true, color:'red', reasons:['hotReload-false']}`。
- degraded：入口扫描有 tokenizer warning（如动态 import 非字面量）→ `degraded:true`，A/B 强制降 C。
- `scoreDir(dir, manifest?)`：真实目录读 package.json + 入口候选（manifest.entry → `exports["."]`
  → module → main → index.js → lib/index.js → plugin.js）；无入口 → `E/S100/degraded/red/error:'no-entry-file'`
  （fail-closed，非 veto）。返回值附加 `dir/entry/perDim/coverage/imports/warnings`。
- `scoreIntent(intent)`：`system|process → red`、`originLight 继承`、`session → yellow`、
  `digests 非空 → blue`、缺省 → yellow；动作灯永不 green。
- 测试实证：`scoreScan` 纯函数分档（D1+D2+D4+D5=74→D）、family 去重、C3 宽限（3 服务→0、
  sessions→22、>8 服务→22）、veto、degraded、真实临时插件目录（写 package.json+index.js）评分 B/28。

### 3.2 healer（修复；只读、不写盘、不放行）

- `selfCheck(dir)`：入口存在 / ctx.effect 包裹 / ctx.provide / 依赖 allow-list（`@deepseek-ai/*` +
  `config.allowlist`）/ inject 最小化 / 无裸定时器；返回 `{ok, grade, dir, findings:[{id,level,message,evidence}]}`，
  `level ∈ info|warn|block`，`ok = 无 block`。grade 复用 scorer 同一套数学。
- `evidence(dir)`：`{plugin, entry{rel,bytes,sha256,mtimeMs}, files[], imports{...}, resources{timers,
  evalSites,secrets,hasEffect,hasProvide,deps,signals}, checks{selfCheck,gates}}` 全结构化 JSON。
- `gates(dir, opts?)`：G1–G12（id 严格 `G1`..`G12`，附 `gate` 名与 `verdict`）：
  G1 manifest 字段、G2 入口存在、G3 无 eval/new Function、G4 无裸 child_process（import 层）、
  G5 依赖 allow-list、G6 资源闭合（裸定时器须与 ctx.effect 同现）、G7 豁免诚实性（acceptRisk 必须带
  `{gate,reason}` 豁免）、G8 构建脚本闭合（dsh.buildApproved）、G9 秘密卫生、G10 bundle patch 存在、
  G11 激活证据、G12 分数可复算。`ok = pass||skip||(unknown && !blockingOnUnknown)`。
  **fail-closed**：G3/G4/G5/G9 等拿不到证据（入口/源码不可读）→ `unknown` 且默认阻断；`Config.blockingOnUnknown`
  沿用 cordis.patch.yml 的 `true`，可在配置里关闭。
  `opts.stage`：`'load'`（默认，静态预检）时 G11/G12 = `skip`（激活/持久化 facts 只能在 load 之后观测，
  ci-gate G7 同构）；`'promote'` 时必须有 host facts，否则 `unknown` 阻断；`opts.facts` 为
  `{application:'applied', observedAt, signals, score}`。这样 `orchestrator.promote()` 里
  `healer.gates(src)`（静态预检）对干净插件能通过，而晋升裁决可显式传 `{stage:'promote', facts}` 强制取证。
- `suggestFix(dir)`：**只读**。产出 `{patches:[{target,yaml,why}], before:{grade,S}, after:{grade}, applied:false}`；
  patch 覆盖 G1/G2/G3/G4/G5/G6/G7/G8/G9/G10 + inject/effect 模块形状；before=当前静态 grade，
  after=按“可静态修复项”投影（如移除 child_process 信号 S1 后重算）。测试用 `digestTree` 前后比对证明目录零写入。

### 3.3 router（路由）

- `decide({assessment, source, needsChildProcess, containerAvailable})` → `{route, reason, needsApproval, ...}`。
  决策树（来源可信度 > 评分，硬约束 6）：
  1. `assessment.veto === true` → `deny`（`veto:hotReload-false`，终局，容器/审批都不能绕过）；
  2. 不可信来源：`needsChildProcess` → `deny:untrusted-needs-child-process`；否则容器可用 → `container:untrusted-source`；
     容器不可用 → `deny:container-unavailable:<reason>`；
  3. 可信来源：有裸写/申报无效残留 → `container:trusted-bare-writes`（容器不可用 → `deny:container-unavailable:*`）；
     已申报写 → `sandbox:trusted-declared-writes`；无写 → `sandbox:trusted-clean`。
  `needsApproval` 选取：sandbox=false、container=true、deny=false（container 代表脱离已申报写边界的执行，需审批）。
- `source` 归一化（因契约签名固定，写证据由来源描述携带）：字符串 `'trusted'|'first-party'|'local'|'official'`
  或对象 `{trusted:true, name?, declaredWrites?, bareWrites?}`；`config.trustedPlugins` 命中即可信；
  缺省/不认识 → 不可信（fail-closed）。申报诚实性：`declaredWrites` 里 `path` 有值且 `reason` 非空才算申报，
  空 reason 视为未申报残留 → container。
- `containerAvailable()`：v1.0.0 无真实探针，本机（Windows 未装 dsh-worker）如实返回
  `{ok:false, reason:'not-installed'}`；非 Windows → `{ok:false, reason:'not-win32'}`；
  操作者 `Config.containerAvailable:true` → `{ok:true, reason:'configured'}`；单次 `decide` 输入
  （boolean 或 `{ok,reason}`）优先级最高，供上层/测试注入。
- 测试实证四种路由：sandbox（可信+已申报写）、container（可信+裸写残留）、container（不可信，A 级也不改判）、
  deny（不可信+needsChildProcess）、deny（容器不可用+原因）、veto 终局 deny。

## 4. 真实测试输出摘要

```
$ node --test test/scorer.test.mjs test/healer.test.mjs test/router.test.mjs
✔ registers fangScorer service; module shape and pure exports are stable
✔ clean source scores A/green with no signals
✔ child_process import scores 28 = B, and B is never green
✔ grade bands + dimension aggregation (pure scoreScan)
✔ C3 service grace: few non-core services weigh nothing; core or >8 services count
✔ dsh.hotReload === false is an E veto (S=100, red, reason recorded)
✔ degraded parse warnings force A/B down to C
✔ scoreDir scores a real temp plugin directory (package.json + index.js)
✔ scoreDir honours manifest.entry and veto from package.json
✔ scoreDir without an entry fails closed (E/degraded/red, no veto)
...（healer）✔ gates(clean): 12 gates, static pass; host-fact gates deferred at load stage
✔ gates(clean, {stage:"promote"}) fails closed on missing host facts
✔ gates(clean, {stage:"promote", facts}) passes once host evidence is supplied
✔ gates(risky) fails G3/G4/G5/G6/G8/G9 with evidence
✔ evidence(clean) is structured JSON with contract sections
✔ suggestFix(risky) returns patches and writes nothing to disk
...（router）✔ route 1 — trusted + declared writes → sandbox, no approval
✔ route 2 — trusted + bare write residue → container (needs approval)
✔ route 3 — untrusted source → container even when the static grade is A
✔ route 4 — untrusted + needsChildProcess → deny
✔ deny + reason when the container is unavailable (fail-closed)
✔ veto (dsh.hotReload===false) is terminal: deny even for trusted + container
ℹ tests 42  ℹ pass 42  ℹ fail 0  ℹ duration_ms 356.8274
```

另做了模块冒烟：`apply(makeCtx())`（不传 config，契约 §8.3）三个插件均不抛错且服务可 `ctx.get` 到；
`ctx.dispose()` 后服务注销；同 ctx 重复 `apply` 按 Cordis 语义抛 `registered`。

## 5. 降级点 / 未实现项 / 需 Lead 知悉

1. **评分只覆盖 import 层（如实声明）**：`coverage:'import-only'`。不做调用层（exec/spawn 实际调用点）分析；
   G3 eval/new Function 与 G6 定时器为文本扫描（近似，非 AST）。这是 v1.0.0 的已知边界。
2. **import 信号可达上限是 D，E 只能来自 veto 或“无法评估”**：D1+D2+D4+D5 全满 = 74（D）；
   D3/D6 无信号映射，>80 的 E 档在 import 层不可达。E 的实际来源：`dsh.hotReload===false`（veto，S=100）
   或 scoreDir 找不到入口（fail-closed E）。测试已按此断言，未伪造可达性。
3. **容器只有决策、没有执行体**：`containerAvailable()` 无真实探针（本机 `{ok:false,reason:'not-installed'}`）；
   容器执行在 v1.0.0 范围外（CONTRACTS §9 允许降级）。`decide` 的 container 路线目前只产决策。
4. **healer 的 G11/G12 依赖 host facts，而 v1.0.0 没有 facts 采集管线**：默认 `stage:'load'` 下判
   deferred/SKIP；`stage:'promote'` 无 facts 则 UNKNOWN 阻断（fail-closed）。`orchestrator.promote()` 目前调用
   `healer.gates(src)` → 走 load 语义，干净插件可通过；若希望晋升阶段强制激活证据，需在调用处传
   `{stage:'promote', facts}` 或由 restart/approver 侧补 facts 管线。
5. **suggestFix 不写盘、不自动应用**：`{patches:[...], applied:false}`；代码类问题（eval/child_process/定时器/密钥）
   的 patch 是注释式 YAML 建议（人工改码），配置类问题（allowlist/buildApproved/exempted/exports）给出可粘贴的
   YAML/JSON 片段。after grade 是静态投影，不是实际执行结果。
6. **审计 kind 复用现有词汇**：scorer → `AUDIT.SCORE`；healer → `AUDIT.SCORE` 且 payload 带
   `component:'fang-healer', check:'self-check'|'gates'|'suggest-fix'`（**没有新增** AUDIT kind，避免改共享契约）；
   router → `AUDIT.ROUTE`。隐藏风险：UI/fangctl 若按 kind 精确路由，需要看 `component` 区分来源。
7. **router 的 `needsApproval` 语义是本实现的约定**：container→true（脱离已申报写边界）、sandbox/deny→false。
   若 orchestrator 期望 deny 也可审批覆盖，需要契约层再对齐（当前 deny 是终局，符合“deny 并给原因”）。
8. **`decide` 的“已申报写/裸写残留”由 `source` 描述携带**（契约签名固定为四个入参），已支持
   `{trusted, declaredWrites:[{path,reason}], bareWrites}` 与字符串 token；上层若无写信息默认不可信 → container。
9. **集成注意事项（Lead/T1 侧）**：
   - `orchestrator.promote()` 里 `path.join(bufferDir, pluginId)` 若指向**文件**而非插件目录，
     `scoreDir` 会 fail-closed 成 E → `grade-too-low`。缓冲区需保证“一个插件一个目录（package.json+入口）”。
   - `test/helpers.mjs` 的 `tmpDir()` 在 ESM 里用 `require('node:fs')`，调用会 ReferenceError；
     T2 测试自带 mkdtemp helper，未使用它（文件属 Lead，未改）。
   - `node --test test/` 在 node v24.16.0 上会报 `Cannot find module ...\test`（目录参数不再是发现目录）；
     本机可用 `node --test "test/*.test.mjs"` 或显式列文件。CONTRACTS §7 的命令建议 Lead 更新。
   - 全量跑测时（13:16 观测）`node --test "test/*.test.mjs"` 为 98 tests / 93 pass / 5 fail 并有测试挂住
     未退出（非 T2 三文件；T2 单跑与组合跑均 0 fail、~0.36s 结束），疑似其他 owner 的未收尾资源，
     请 Lead 在收口时复查。

## 6. 自检对照（CONTRACTS §8）

1. ✅ 三个 `src/plugins/<name>.mjs` 存在，导出 `name/inject/Config/apply`，可 import 无语法错误。
2. ✅ `node --test test/scorer.test.mjs test/healer.test.mjs test/router.test.mjs` 全绿，每文件断言数 85/110/68（≥8）。
3. ✅ `apply(makeCtx())` 不抛错；`SERVICE.scorer/healer/router` 可从 `ctx.get` 读到；dispose 后注销。
4. ✅ 未向 `dsh-hot-update` 或 profile 目录写任何东西；未改他人 owner 文件。
5. ✅ 文件/断言数/降级点已列于本报告。
