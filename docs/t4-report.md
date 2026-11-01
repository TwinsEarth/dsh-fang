# T4 完成报告 — 热更新引擎与红线守卫

> 任务：task-4（T4 lifecycle）。写域：`src/plugins/hot-reloader.mjs`、`src/plugins/restart-guard.mjs`、
> `test/hot-reloader.test.mjs`、`test/restart-guard.test.mjs`、`test/fixtures/t4/**`、`docs/t4-report.md`。
> 除以上文件外**未改动任何文件**（未写 `dsh-hot-update`、未写 profile、未动 kernel/package.json/cordis.patch.yml/client.js/他人插件与测试）。

## 1. 交付文件

| 文件 | 行数/大小 | 说明 |
|---|---|---|
| `src/plugins/hot-reloader.mjs` | ~330 行 / 12.1 KB | `fangHotReloader`：`?rev=<contentHash>` 真实 ESM 换版 + 临时等待位 + 健康窗 + 回滚 |
| `src/plugins/restart-guard.mjs` | ~430 行 / 15.9 KB | `fangRestart`：决策矩阵 + 单飞状态机 + 审批 fail-closed + 审计/事件，只决策不执行 |
| `test/hot-reloader.test.mjs` | 9 tests / **108 断言** | 真实 ESM 文件换版（非 mock import） |
| `test/restart-guard.test.mjs` | 13 tests / **151 断言** | 决策矩阵/审批/单飞/fail-closed/impact 降级 |
| `test/fixtures/t4/rev1.mjs`、`rev2.mjs`、`bad.mjs`、`leak.mjs` | 4 个真实 ESM fixture | 换版 / 初始化抛错 / 泄漏被引用句柄 |

模块形状符合 CONTRACTS §3：两个插件都导出 `name`、`inject=[]`、`Config`（kernel vendored `z`）、`apply(ctx, config)`，
服务用 `ctx.effect(() => ctx.provide(SERVICE.xxx, service))` 注册；`ctx.effect` 负责清理（restart-guard 的审批 watchdog 定时器、hot-reloader 的已挂 fiber 兜底 dispose）。

## 2. 契约实现对照

### 2.1 `fangHotReloader`（CONTRACTS §5.8）

```js
swap({name, file, config, sessionId?}) -> Promise<
  | {ok:true, phase:'swapped', from, to, url, fiber:{id,name,rev,url,state}, health:{leakedRefed,freed,windowMs,fiberState}, disposedOld}
  | {ok:false, phase:'init-failed', reason:'import-failed'|'mount-failed'|'bad-request', error, from, to, url}
  | {ok:false, phase:'rolled-back', rolledBack:true, reason:'health-window'|'fiber-failed', health:{leakedRefed,freed,windowMs,fiberState}}
>
unload({name}) -> Promise<{ok, phase:'unloaded'|'not-loaded'|'dispose-failed', from}>
health() -> {windowMs, samples, lastDiff, maxNewHandles, swaps, rollbacks, loaded[]}
```

执行次序（**旧 fiber 直到最后一步才被触碰**）：

1. `rev = sha256File(file)`（内容哈希，不是 mtime/时间戳）→ `import(pathToFileURL(file).href + '?rev=' + rev)`。
   同一份字节复用同一 ESM 实例（不涨内存），改一字节即新模块；测试用例 3 用「同一文件连换两次 → 模块只求值一次、apply 执行两次」证明。
2. 在**临时等待位**初始化（`ctx.inject([], child => child)` 子作用域；真宿主拿不到子作用域时退化为同 ctx 挂载并如实返回 `degraded:'no-child-scope'`）。
3. 健康窗：`sleep(healthWindowMs)` 后 `sampleResources()` 与挂载前基线做 `diffResources`；
   `leakedRefed > healthMaxNewHandles` 或 fiber state=FAILED(3) ⇒ dispose 新 fiber + 释放等待位，**旧 fiber 原样保留**，返回 `rolled-back`。
4. 健康 ⇒ 才 dispose 旧 fiber（成功结果里 `disposedOld:true`）；dispose 旧失败不假装成功，附带 `oldDisposeError`。

`requireApprovalForSwap` 字段为 bundle 配置兼容而保留，**swap 内部不执行审批**（见 §5 降级点 1）。

### 2.2 `fangRestart`（CONTRACTS §5.9）

```js
request({reason, risk, scope, origin, digests?, forcedApproval?, impact?}) -> Promise<
  {id, outcome:'approved'|'denied'|'timeout'|'auto-allow', decision:'auto-allow'|'needs-approval', risk, by, approvalId,
   execution:{executed:false, reason, guardMode, allowProcessRestart, plannedExitCode:75}, requestedAt, ms}
>
decideOnly(input) -> {decision, risk}                    // 纯决策：不进状态机、不审计、不询问 approver
state()  -> {state:'idle'|'collecting'|'awaiting'|'executing', pending, mode, authMode, strictRedLine, allowProcessRestart, restartExitCode}
impact() -> {activeForks, pendingPromotes, dirtyBuffers, activeSessions}   // 严格四字段，缺失降级为空
policy() -> {mode, authMode, strictRedLine, approvalTimeoutMs, allowProcessRestart, restartExitCode}
```

- **决策矩阵**逐行移植参考实现：`classifyRisk`（origin/scope/originLight → raw，再按有无 digests 升一级）、
  `findGrant`（scope/target/maxRisk/digests/expiresAt）、`decide`（forcedApproval 否决 → manual/temp/auto → strictRedLine）。
  三个纯函数 + `classifyRisk` 均作为**命名导出**，便于 Lead 做 parity 测试。
- **risk 取值**：显式 `request.risk`（合法 blue/yellow/red）优先；缺省时走 `classifyRisk`。编排器 `requestMotherRestart` 显式传 `risk:'red'`，因此保持红灯语义。
- **单飞状态机**：`request()` 在首个 await 之前同步认领 `collecting`，并发第二个请求走准入拒绝
  `{id, outcome:'denied', reason:'busy', decision:'needs-approval', risk, activeState}`，不排队、不二次询问 approver。
  `auto-allow` 路径 `collecting → executing → idle`；`needs-approval` 路径 `collecting → awaiting → executing|idle`。
- **审批**：`ctx.get(SERVICE.approver)?.request({kind:'restart', risk, title, detail, impact, ttlMs})`；
  approver 服务不存在 / 无 `request` / 同步抛错 / Promise reject ⇒ **fail-closed** `{outcome:'denied', reason:'approver-unavailable'|'approver-error'}`。
  另有本地 watchdog（`approvalTimeoutMs`，unref 定时器）防止 approver 永不 resolve 卡死状态机 ⇒ `{outcome:'timeout', reason:'approval-timeout'}`。
- **审计**：每个进入状态机的请求 append `AUDIT.RESTART_REQUESTED`（含 id/risk/reason/scope/origin/digests/forcedApproval/mode/authMode/impact）与
  `AUDIT.RESTART_RESOLVED`（outcome/decision/deniedReason/execution/ms）；busy 准入拒绝也留一对（requested 带 `phase:'rejected-busy'` + resolved denied/busy）。
  auditor 缺失或 append 抛错只降级日志，不阻断决策。
- **事件**：`bus.emit('fang/restart-requested', {id, risk})`、`bus.emit('fang/restart-resolved', {id, outcome})`（payload 严格按 CONTRACTS §6）。
- **不执行**：`execution.executed` 恒 `false`；`plannedExitCode = EXIT.RESTART(75)` 只记录（与 forker `classifyExit(75)` 契约对齐），
  即便 `allowProcessRestart:true` 或 `mode:'enforce'` 也不真退出/重启；execute 阶段仅置状态后回 idle。
- `policy().mode` 是**守卫执行层 observe|enforce**，决策矩阵的授权模式在 `policy().authMode`（manual|temp|auto）—— 按 Lead 澄清实现，两者不混用。

## 3. 真实测试输出摘要

验收命令：

```powershell
cd dsh-fang
node --test test/hot-reloader.test.mjs test/restart-guard.test.mjs
```

真实输出（2026-11-01，本机 node v24.16.0）：

```
✔ plugin shape: name/inject/Config/apply and SERVICE.hotReloader registration
✔ swap loads real ESM bytes by content hash, then disposes the old fiber only after healthy
✔ ?rev=<contentHash>: identical bytes reuse the same ESM module, apply still reruns per mount
✔ init failure (apply throws) returns init-failed and never touches the previous fiber
✔ import failure (missing file) returns init-failed and keeps the old fiber
✔ health window: leakedRefed > healthMaxNewHandles rolls back the new fiber, old one survives
✔ health() reports loaded snapshots and unload releases them
✔ bad requests fail cleanly instead of throwing
✔ ctx disposal disposes mounted fibers (ctx.effect cleanup)
✔ plugin shape: name/inject/Config/apply, service registration and contract defaults
✔ decision matrix parity: classifyRisk blue/yellow/red and decide() modes
✔ auto-allow blue request: audit + bus events, guard returns to idle
✔ awaiting → approver approves; single-flight rejects the concurrent second request as busy
✔ approver denies / times out: outcome denied|timeout, guard back to idle
✔ approval watchdog: a stuck approver cannot deadlock the guard (fail-closed timeout)   (1006ms)
✔ fail-closed: no approver service => denied, decision-only failure is audited
✔ fail-closed: approver throws (sync or rejected promise) => denied approver-error
✔ impact() collects forker.list()/buffer.state()/approver.pending() and degrades to empty
✔ policy()/state() keep guard mode (observe|enforce) separate from authMode (manual|temp|auto)
✔ strict red line: authMode=auto with strictRedLine=true still requires human approval
✔ decideOnly() is side-effect free (no state machine, no audit, no approver)
✔ auditor missing is tolerated (decision still works), ctx disposal clears in-flight state

ℹ tests 22   ℹ pass 22   ℹ fail 0   ℹ duration_ms ~1350
```

- 断言数：`hot-reloader.test.mjs` = **108**，`restart-guard.test.mjs` = **151**（均远超 ≥8）。
- 稳定性：验收组合连跑 3 次均 `22/22 pass`（健康窗用真实 `process.getActiveResourcesInfo()` 采样；成功路径阈值默认 2，
  回滚用例用 fixture 泄漏 2 个 ref'd interval + 阈值 1，既容噪又确定性触发）。
- 全量（含他人文件）快照：`node --test "test/*.test.mjs"` → **141/141 pass，exit 0**。
- 与 T1/T3 真实插件的集成 smoke（非交付测试，手工执行）：真实 `fangAudit` + `fangApprover` + `fangRestart` 同 ctx 挂载；
  `guard.request({risk:'red', scope:'mother'})` → `state()='awaiting'`，`approver.pending()` 出现 `kind:'restart'` 工单，
  `approver.decide(id,'approved')` 后请求 resolve 为 `{outcome:'approved'}`、状态回 idle；
  真实链式账本 `audit.verify()` → `{ok:true, records:4}`（restart-requested → restart → restart → restart-resolved）。证明审计/审批接缝与 T1/T3 契约一致。

## 4. 覆盖点清单

hot-reloader（9 tests / 108 断言）：
1. 模块形状 + Config 默认值（300ms / 2）+ `ctx.get(SERVICE.hotReloader)` + 直接 `apply()` 也校验 config；
2. **真实 ESM 换版**：rev1 → rev2 的 `to` 等于各自文件 sha256、`?rev=` 出现在 import URL、`from` 衔接；
3. **真实 fiber 生命周期**：只有健康窗通过才 dispose 旧 fiber（trace 证明 `apply(rev2)` 在 `disposed(rev1)` 之前）；首载 `disposedOld:null`；
4. **内容哈希 cache-bust**：同一文件连换两次复用同一模块实例（evaluate 不增）、apply 每次执行；
5. **初始化失败（apply 抛错）**：`init-failed/mount-failed`，旧 fiber 未被 dispose，之后 unload 仍能释放旧 fiber；
6. **import 失败（文件不存在）**：`init-failed/import-failed`，旧 fiber 未动；
7. **健康窗泄漏回滚**：真实 `setInterval` 使 `leakedRefed>=2`，新 fiber 被 dispose 且泄漏定时器被回收，旧 fiber 存活、可再次 unload；
8. `health()` 快照 / `unload()` 幂等；
9. bad request 不抛异常；`ctx.dispose()` 会释放已挂 fiber（`ctx.effect` 清理）。

restart-guard（13 tests / 151 断言）：
1. 模块形状 + 默认 config（observe/manual/strictRedLine/300000/false/24）+ 非法 config 抛错；
2. **决策矩阵**：`classifyRisk` 12 组（supervisor/cron/cli:kill/red-light/system/process/session/cli/yellow-light/blue/无 digests 升级）、
   `decide` manual/temp/auto/strictRedLine/forcedApproval、`findGrant` 匹配/过期/maxRisk 不足/digest 不匹配；
3. blue auto-allow：审计两条 + bus 两事件 + `execution.executed=false & plannedExitCode=75` + 回 idle；
4. **awaiting → 审批通过**：请求后同步可见 `state='awaiting'`、pending、approver 收到的 `{kind,risk,ttlMs,impact}`；
   **并发单飞**：第二个请求 `{outcome:'denied',reason:'busy'}`、approver 只被调 1 次、不覆盖 in-flight；
5. approver 拒绝 / 超时（由 approver 返回）→ denied/timeout 且回 idle；
6. **watchdog 实测**：approver 永不 resolve，`approvalTimeoutMs:1000` 下约 1.0s 后 fail-closed timeout，状态回 idle（防止状态机死锁）；
7. **无 approver fail-closed**：denied/approver-unavailable + 审计 resolved 带 deniedReason；
8. **approver 抛错**（同步 throw / reject）→ denied/approver-error；
9. **impact()**：forker.list/buffer.state/approver.pending 三源收集；三个服务全抛错时降级为空且不抛；
10. `policy()/state()` 的 mode(observe|enforce) 与 authMode(manual|temp|auto) 分离；auto+strictRedLine=false 时红灯 auto-allow 且仍不执行；
11. strictRedLine=true 时 auto 模式红灯仍必须人工审批；
12. `decideOnly` 无副作用（不审计/不询问/不动状态机）；
13. auditor 缺失时决策仍工作；in-flight 时 `ctx.dispose()` 清理 watchdog 并复位状态机。

## 5. 降级点 / NOT ESTABLISHED（如实声明）

### hot-reloader
1. **`requireApprovalForSwap` 不在 swap 内执行**：CONTRACTS §5.8 的 `swap()` 没有审批入参，Fang 的审批面在
   restart-guard/approver（编排器 `promote()` 先经 approver 才写 staging，母体更新另走 restart-guard）。
   字段保留仅为 `cordis.patch.yml` 配置兼容，swap 本身不再二次等待审批。**NOT ENFORCED（刻意）**。
2. **真宿主（Cordis）挂载语义未实测**：本仓库测试用 `test/helpers.mjs` 的镜像 ctx（无真实 Fiber 对象）。
   `mountIn()` 已按参考实现处理 `fiber.dispose()/fiber.await()`、`fiber.state===3(FAILED)`，但**没有真实 fiber 可验证**；
   若宿主状态枚举不同，健康判定退化为仅 `leakedRefed`（该判据本身有真实资源采样测试）。
3. **临时等待位隔离性在真宿主可能降一档**：真宿主 `ctx.inject` 可能返回 disposable 而非子 ctx，此时退化为同 ctx 挂载，
   结果里返回 `degraded:'no-child-scope'`；新旧并存期间若服务重名会 init-failed 回滚（旧 fiber 仍安全）。**NOT ESTABLISHED**。
4. 健康窗只覆盖「窗口内新增被引用句柄数」；窗口之后才失败的异步插件、内存增长、unref'd handle 不在判据内。
   回滚不了的场景按 CONTRACTS §1.4 交给编排器 reap 分身，本插件不调用 forker。
5. 测试 fixture 的 `ctx.effect` 清理依赖镜像 ctx 的 dispose；helpers 的 child dispose 非幂等（同一 child 被父 ctx.dispose 再回收一次），
   本插件把临时等待位的回收留给父作用域 owner，避免二次 dispose（生产宿主 fiber dispose 幂等，不受影响）。

### restart-guard
1. **不执行退出/重启**（v1.0.0 硬边界）：`execution.executed` 恒 false，`plannedExitCode:75` 仅记录；
   `allowProcessRestart:true` / `mode:'enforce'` 也不退出。**NOT ESTABLISHED**：外部 supervisor 真拉起、退出码真正生效的链路。
2. `executing` 是瞬态：审批/自动放行后同步经过 executing 再回 idle，外部轮询几乎观察不到（状态机语义保留，未加人为延迟）。
3. **temp 授权模式无签发面**：`findGrant` 已实现/导出/测试，但本插件没有 grant 签发与持久化，`policy.grants` 恒 `[]`
   ⇒ `authMode:'temp'` 对非蓝等价 manual。**NOT ESTABLISHED**：临时授权生命周期（签发/吊销/跨进程）。
4. **`impact().activeSessions` 恒 0**：没有可读的会话服务（v1.0.0 契约未提供）；`pendingPromotes` 仅当 approver 提供 `pending()` 时收集，
   缺失为空。`impact()` 严格返回契约四字段，不夹带降级标记（降级以空数组表达）。
5. 单飞 busy 拒绝**不发 bus 事件**（只留审计对），避免 UI 把未进入状态机的尝试当成一次重启请求；如需事件化可后续加 `fang/restart-rejected`。
6. 显式 `risk` 优先于 `classifyRisk` 是相对参考实现的**刻意差异**（编排器传 red；参考实现全量重分类会把 mother scope 降成 yellow）。无显式 risk 时矩阵行为与参考逐行一致。

### 环境/协作提示（非 T4 写域，供 Lead 处理）
1. **Node v24.16.0 下 `node --test test/` 不可用**：`--test` 的位置参数不再接受目录，实测报
   `Error: Cannot find module 'dsh-fang\test'`（exit 1）；`node --test`（无参数）在本工作区挂起无输出（>45s，已 kill）。
   可用写法：`node --test "test/*.test.mjs"`（实测 141/141 pass，exit 0）。建议把 `package.json` 的 `test` script 与 `docs/CONTRACTS.md §7` 改为 glob 形式（均 Lead-owned）。
2. kernel barrel 的 `sleep` 双 star-export 歧义（core/fsx 各导出）已由 Lead 修复；本报告测试均在新 kernel 上跑出。
3. 与 T3 approver / T1 auditor 的接缝已按契约 §5.2/§5.7 实测（见 §3 集成 smoke）；与编排器 `requestMotherRestart()` 的期望
   `ok = decision.outcome==='approved'` 兼容（红灯默认 manual+strictRedLine ⇒ 必进审批，批准后 outcome 恰为 'approved'）。

## 6. 复现命令

```powershell
cd dsh-fang
node --test test/hot-reloader.test.mjs test/restart-guard.test.mjs   # 验收：22/22 pass
node --test "test/*.test.mjs"                                        # 全量快照：141/141 pass
```
