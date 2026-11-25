# dsh-Fang v1.0.0 — 集成契约（唯一事实源）

> 本文件是并行开发的接口契约。**任何跨模块的签名改动必须先改这里**，否则不同人写出的东西拼不起来。
> 仓库：`dsh-fang`；包名 `@local/dsh-fang`；版本 `1.0.0`。

---

## 1. 产品模型（代码中的硬边界）

```
母体 mother（长期运行，profile web/desktop）
  ├── fang-orchestrator   主插件：fork / reap / listForks / promote / 路由 + UI
  ├── fang-forker         2.1 派生器：进程层，spawn/reap 子 dsh-Web
  ├── fang-scorer         2.2 评分：静态 A–E + 动作灯色 + 路由建议
  ├── fang-healer         2.3 修复：自检/证据/G1–G12 门禁/allow-list 补丁建议
  ├── fang-approver       2.4 审批：待批队列 / A-B 双备 / 监控 / 回滚
  ├── fang-hot-reloader   2.5 热更新：swapPlugin + 健康窗（分身内，不升红）
  ├── fang-restart-guard  2.6 红线守卫：**只拦母体重启**，分身重启走 reap
  ├── fang-buffer-keeper  2.7 缓冲：监视 + 三态 + settled 后落盘
  ├── fang-auditor        2.8 审计：哈希链账本 + 启动自检 + 回滚
  └── fang-router         2.9 路由：sandbox | container | deny
```

硬约束（违反即算 bug）：

1. **母体不可变**：所有开发发生在分身。母体只在 `promote()` 时被显式更新，并走 restart-guard 审批。
2. **分身零共享**：每个分身独立 `DSH_HOME`、独立缓冲目录、独立端口（`--port 0`）。
3. **分身内不跑 restart-guard**：分身重启 = `forker.reap()` + 重新 `fork()`，不走审批。
4. **HotReloader 失败不升红**：能回滚就回滚，回滚不了就 `reap` 分身，由编排器重新派生。
5. **Healer 不放行**：只产出证据与补丁建议；放行权在 approver。
6. **Router 不以评分为唯一判据**：来源可信度更强。

---

## 2. 仓库布局与写权

```
dsh-fang\
  package.json            ← Lead 独占（bundle 清单/版本/入口）
  cordis.patch.yml        ← Lead 独占（10 行装载配置）
  client.js               ← Lead 独占（Client 半 UI）
  src/index.mjs           ← Lead 独占（= orchestrator 入口）
  src/compose.mjs         ← Lead 独占（单行回退模式）
  src/kernel/**           ← Lead 独占（共享内核；需要新 API 找 Lead 加）
  src/plugins/orchestrator.mjs ← Lead
  src/plugins/forker.mjs       ← T1
  src/plugins/auditor.mjs      ← T1
  src/plugins/buffer-keeper.mjs← T1
  src/plugins/scorer.mjs       ← T2
  src/plugins/healer.mjs       ← T2
  src/plugins/router.mjs       ← T2
  src/plugins/approver.mjs     ← T3
  src/plugins/hot-reloader.mjs ← T4
  src/plugins/restart-guard.mjs← T4
  test/<plugin>.test.mjs       ← 各 owner 自己的文件名，互不覆盖
  test/helpers.mjs             ← Lead 独占
  tools/fangctl.mjs            ← Lead 独占
  docs/**                      ← 各 owner 可写自己的 docs/<plugin>.md；CONTRACTS/ARCHITECTURE 由 Lead 维护
```

**禁止**：改别人 owner 的文件；改 package.json / cordis.patch.yml / kernel / client.js。发现需要改 → 发消息给 Lead，不要私自动手。

---

## 3. 插件模块契约（Cordis）

每个 `src/plugins/<name>.mjs` 必须是标准 Cordis 插件模块：

```js
import { SERVICE, AUDIT } from '../kernel/index.mjs'
import { z } from '../kernel/index.mjs'          // vendored schemastery

export const name = 'fang-xxx'                     // 行名
export const inject = []                           // 依赖的服务 key（硬依赖才写）
export const Config = z.object({ ... })            // 配置 schema（有默认值）
export function apply(ctx, config) { ... }         // 只注册，不做阻塞 IO
```

`apply` 里可用的 `ctx` API（宿主真实形状 + `test/helpers.mjs` 已镜像）：

| API | 语义 |
|---|---|
| `ctx.effect(() => disposer)` | 注册清理；返回 disposer |
| `ctx.provide(key, value)` | 注册服务；返回注销函数（包在 `ctx.effect` 里） |
| `ctx.get(key)` | 读服务，可能 undefined / 抛错 → 一律 `safeGet` |
| `ctx.inject([names], cb)` | 等这些服务就绪后回调（用于 `webServer`） |
| `ctx.plugin(module, config)` | 挂子 fiber（仅 orchestrator/compose 用） |
| `ctx.logger.info/warn/error/debug` | 日志 |
| `bus.on/emit`（kernel 单例） | 跨插件进程内事件，见下 |

服务注册范式（照抄）：

```js
ctx.effect(() => ctx.provide(SERVICE.scorer, service))
```

`ctx.effect` 里禁止长阻塞；定时器必须 `setInterval` + `ctx.effect(() => () => clearInterval(t))`。

---

## 4. 内核 API（`src/kernel/index.mjs`，已实现）

```js
// 路径
resolveFangLayout({dataRoot?,bufferRoot?,forksRoot?,env?,argv?}) -> {dataDir,profileTag,dshHome,
  ledgerFile,stateFile,forksFile,pidFile,bufferDir,snapshotsDir,roundsDir,runDir,forkHomesDir}
resolveDshHome(env?) · resolveProfileDir(profileTag,env?) · detectProfileTag(argv,env)
parseWebUrl(text) -> {url,port}|null            WEB_URL_RE · probeWebUrl(url,opts)

// fsx（所有落盘必须走它）
ensureDir · exists · readJson · readTextSafe · writeFileAtomic · writeJsonAtomic · appendJsonl
sha256 · sha256File · digestTree(dir) · diffDigests(before,after) · copyTree(from,to)
removeTree(p)            // junction-safe：遇到 junction 只 unlink，绝不进入目标！
makeJunction(target,link) · isLink · listFiles · sleep · nowMs · iso

// 审计链（共享模块，已被 274 条真实记录验证）
canonical · hashOf · lastHash · appendChained(file,record,opts) · verifyChain(file)
verifyAndAppendBoot(file, extra) · GENESIS

// 轮次（纯逻辑，fsApi 注入）
createRounds(fsApi) -> {fileDigests,copyTreeInto,beginRound,listRounds,resetRound}

// 其他
newId(prefix) · newUuid · createBus() · bus（进程级单例） · sampleResources() · diffResources(a,b)
totalResources(counts) · EXIT{OK,RESTART:75} · RISK_RANK · riskAtLeast · riskColor
SERVICE · ROW · FORK_STATUS · RISK · GRADE · GRADE_COLOR · ROUTE · GUARD_STATE · BUFFER_STATE · AUDIT · FANG_VERSION
```

导入方式（插件文件在 `src/plugins/` 下）：`import { ... } from '../kernel/index.mjs'`。

---

## 5. 服务契约（**签名不可改**）

所有服务方法**同步优先、耗时动作返回 Promise**，错误不再抛出而是返回 `{ok:false, error}`（除明确写 throw 的）。

### 5.1 `fangForker`（T1）
```js
provision({forkId, taskTitle, homeDir, profileTemplate}) -> {ok, homeDir, profileDir, bufferDir}
   // 建 homeDir/profiles/<profile>（克隆 profileTemplate 的 package.json+cordis*.yml）
   // node_modules 用 makeJunction 指到母版（profileTemplate 所在 profile 的 node_modules）
spawn({forkId, homeDir, profile, cliPath, env?, timeoutMs?}) -> Promise<{ok, pid, port, url}>
   // spawn(cliPath, ['--profile', profile, '--port','0','--no-open'], {env:{DSH_HOME:homeDir,...}})
   // stdout 解析 parseWebUrl（360 行内滚动缓冲），超时 kill + {ok:false,error:'timeout'}
stop(forkId) -> {ok}
reap(forkId) -> {ok, removed}                 // stop + removeTree(homeDir) + 注册表删除
status(forkId) -> {running, pid}
list() -> [{forkId, pid, running, startedAt}]
logs(forkId, tailLines=40) -> string
```
另有纯函数导出：`parseWebUrl`（复用 kernel 的）、`buildSpawnArgs({profile})`、`classifyExit(code)` →
`{kind:'normal'|'restart-request'|'crash', code, restartRequested: code===75}`。

### 5.2 `fangAudit`（T1）
```js
append(kind, data) -> record            // 追加链式记录，自动加 at/seq
read({limit=100}) -> record[]
verify() -> {ok, records, firstBadSeq}
bootCheck() -> {ok, findings:[{id,level:'warn'|'error',message}]}   // unclean-boot / interrupted-in-guard
ledgerFile                              // 属性
```

### 5.3 `fangBuffer`（T1）
```js
start({dir}) -> {dir}        ； stop()
state() -> {state, dir, lastEventAt, pending:[relPath]}
flush({strictMs=750}) -> Promise<{state:'settled'|'pending-high-risk', flushed:[], timedOut}>
scan() -> {digests, changed:[], added:[], removed:[]}     // 与 baseline 比对
baseline() -> {count}
```

### 5.4 `fangScorer`（T2）
```js
scoreSource(source, pkg?) -> {grade, S, color, veto, degraded, signals:[{id,weight}], reasons:[]}
scoreDir(dir, manifest?) -> 同上 + {dir, entry}
scoreIntent(intent) -> {light:'blue'|'yellow'|'red', notes:[]}
```
评分数学复用 `@local/dsh-score-guard` 的实现（D1–D6 权重、family 去重、C3 服务宽限、B 级不得判绿）。

### 5.5 `fangHealer`（T2）
```js
selfCheck(dir) -> {ok, grade, findings:[{id, level:'info'|'warn'|'block', message, evidence}]}
evidence(dir) -> {plugin, entry, files, imports, resources, checks}
gates(dir) -> {pass, gates:[{id:'G1'..'G12', ok, detail}]}
suggestFix(dir) -> {patches:[{target, yaml, why}], before:{grade}, after:{grade}}   // 只建议，不应用
```

### 5.6 `fangRouter`（T2）
```js
decide({assessment, source, needsChildProcess, containerAvailable}) -> {route:'sandbox'|'container'|'deny', reason, needsApproval}
containerAvailable() -> {ok, reason}
```

### 5.7 `fangApprover`（T3）
```js
request({kind, risk:'blue'|'yellow'|'red', title, detail, impact?, ttlMs?}) -> Promise<{id,outcome:'approved'|'denied'|'timeout',by,at}>
pending() -> item[]      decide(id, outcome:'approved'|'denied', {by, note}) -> {ok}
snapshot({tag, dir}) -> {tag, A:{digest,at}, B:null}     // A=当前，B=上一次
rollback({tag, dir}) -> {ok, restored}
monitor({label, value, threshold}) -> {ok, alert:boolean}
status() -> {pending, snapshots, monitors, decisions}
```
红灯不可被「全部自动批准」绕过：`strictRedLine` 时 `risk==='red'` 必须 `decide()` 显式通过。

### 5.8 `fangHotReloader`（T4）
```js
swap({name, file, config, sessionId?}) -> Promise<{ok, phase, fiber?, rolledBack?:boolean, health?:{leakedRefed, windowMs}}>
   // 加载新 fiber → 健康窗 → dispose 旧 fiber；失败不触碰旧 fiber
unload({name}) -> {ok}
health() -> {windowMs, samples, lastDiff}
```
移植自 `dsh-hot-update/packages/restart-guard/index.js` 的 swapPlugin 部分（含 `?rev=N` cache-bust、健康窗、`sampleResources` 差分）。

### 5.9 `fangRestart`（T4）
```js
request({reason, risk, scope, origin, digests?, forcedApproval?, impact?}) -> Promise<{id, outcome:'approved'|'denied'|'timeout'|'auto-allow', decision, risk, execution, authorization}>
decideOnly(req) -> {decision:'auto-allow'|'needs-approval', risk}
state() -> {state:'idle'|'collecting'|'awaiting'|'executing', pending, mode, manifestTtlMs, approvalDir, executionDir, lastManifest, supervisorPresent, executionArmed, execution:{executed:false}}
impact() -> {activeForks:[], pendingPromotes:[], dirtyBuffers:[], activeSessions:0}
policy() -> {mode, authMode, strictRedLine, decisionOnly, manifestTtlMs, supervisorPresent, executionArmed}
executionContract() -> {version, decisionOnly, guardExecuted, supervisorPresent, executionArmed, approval:{kind,dir}, receipt:{kind,dir}, supervisor:{armedWhen,handoffWhen,mayExecuteWhen,receiptRequirements}, rule}
approvals({limit?, now?}) -> {items:[summary], counts:{total,authorized,executed,stale,invalid}}
executionStatus(id, {now?}) -> {found, valid, expired, executed, authorized, stale, receiptState, manifest, receipt, ...}
verifyApproval(id, {now?}) -> {ok, reason, expired, digestValid, authorized, executed, stale, receiptState}
```
只服务母体重启；单飞状态机；决策矩阵照抄 `classifyRisk/decide`（与 approval 的旧实现同构，parity 测试守住）。
每次 `approved` / `auto-allow` 都会原子写一份 durable 授权清单到 `<dataDir>/restart/approved/<id>.json`；
清单里 `execution.executed` 恒为 `false`（守卫从不重启自己）。清单同时记录 `guard.mode` 与
`guard.allowProcessRestart`：只有 `mode==='enforce'` 且 `allowProcessRestart===true` 才算 armed，
未武装的批准照常落盘、可审计，但 supervisor 不得执行。外部 supervisor 执行后写
`<dataDir>/restart/executed/<id>.json`，回执的 `execution.executed === true` 是唯一的执行证明。
两阶段字段、校验规则、信任边界与未完成项见 `docs/RESTART-SUPERVISOR-CONTRACT.md`。

执行侧入口（均默认 dry-run、手动运行、不自动启动、不被插件调用）：

- `tools/restart-supervisor.mjs`：包装并监督一条命令，只有 `--execute` + armed 清单才会重启它；
- `tools/restart-watchdog.mjs`（C 方案外部看护）：轮询 `<dataDir>/fang.pid`，宿主死亡后验证清单再重启；
  它写 `<dataDir>/restart/supervisor.present` 心跳，守卫据此判断 supervisor 在位。
  三重门禁（`mode==='enforce'` ∧ `allowProcessRestart===true` ∧ supervisor 在位）齐了，守卫才会在批准后
  `exit(75)` 交接；默认三门禁全关，进程继续运行。

### 5.10 `fang`（orchestrator，Lead）
```js
fork({taskTitle, basePlugin?}) -> Promise<{forkId, url, port, homeDir, profile}>
reap(forkId) -> Promise<{ok}>
listForks() -> ForkInfo[]
getForkHealth(forkId) -> {ok, url, pid, status, ...}
promote(forkId, pluginId) -> Promise<{ok, outcome}>
autostartForks({taskIds?}) -> {ok, started:[{taskId,pid,port}], failed:[{taskId,error}], skipped:[{taskId,reason}]}
status() -> {role, tasks, forks, restart:{available, state, mode, authMode, strictRedLine, redLineAutoAllowed, ...}}
```
HTTP（`ctx.inject(['webServer'], ...)`）：`GET /fang/panel`、`GET /fang/api/forks`、`POST /fang/api/forks/create`（GET/POST 同路径会被 exact 路由吞掉，故分开）、`POST /fang/api/forks/autostart`（watchdog 启动时恢复分身）、`POST /fang/api/forks/:id/promote`、`GET /fang/api/status`、`GET /fang/api/restart`（只读：重启守卫 + supervisor 契约，不触发重启）。
**webServer API 不确定**：先看 t1 遗留实现（`dsh-hot-update/packages/restart-guard/index.js` 的 `ctx.inject(['webServer']` 段），照它写。

---

## 6. 事件（kernel `bus` 单例）

话题常量放 `types.mjs`，v1.0.0 用到的：

| topic | payload | 发出者 |
|---|---|---|
| `fang/fork-started` | `{forkId, pid, port}` | forker |
| `fang/fork-crashed` | `{forkId, code}` | forker |
| `fang/fork-reaped` | `{forkId}` | forker |
| `fang/buffer-settled` | `{dir, changed:[]}` | buffer-keeper |
| `fang/restart-requested` | `{id, risk}` | restart-guard |
| `fang/restart-resolved` | `{id, outcome}` | restart-guard |
| `fang/restart-approved` | `{id, outcome, risk, execution:{executed:false,...}, authorization:{manifestId, digest, expiresAt}}` | restart-guard（advisory；durable 依据是 `approved/<id>.json`） |
| `fang/approval-decided` | `{id, outcome}` | approver |

监听方必须容错（没有监听者时 emit 返回 0，不报错）。

---

## 7. 测试约定

```powershell
cd dsh-fang
node --test test/forker.test.mjs                                  # 单文件（在进程内直接跑）
node --test --test-concurrency=1 "test/*.test.mjs"                # 全量（node v24 不接受目录参数）
```

> 注意：node v24 下 `node --test test/` 不可用（目录参数被当成模块名），裸 `node --test` 会
> 把 fixtures 当测试文件而挂起。用上面的 glob 写法；`package.json` 的 `npm test` 已固定该命令。

- 只用 `node:test` + `node:assert/strict`，**零外部依赖**。
- 用 `test/helpers.mjs` 的 `makeCtx()`；临时目录自己 `mkdtemp`，用例结束清理。
- 需要子进程的用例（forker）用 `node -e "console.log('dsh web: http://127.0.0.1:PORT/?token=x')"` 之类的假 CLI，**绝不 spawn 真的 dsh**。
- 每个插件至少覆盖：注册服务 key 存在 / 主路径 happy path / 一条失败路径 / 一条边界。
- 测试文件命名：`test/<pluginkey>.test.mjs`（forker.test.mjs、auditor.test.mjs、buffer-keeper.test.mjs、scorer.test.mjs、healer.test.mjs、router.test.mjs、approver.test.mjs、hot-reloader.test.mjs、restart-guard.test.mjs、orchestrator.test.mjs）。
- 测试 fixture 放 `test/fixtures/<owner>/`，互不覆盖。

---

## 8. 完成定义（每个 owner 自检）

1. `src/plugins/<name>.mjs` 存在，导出 `name/inject/Config/apply`，能 `import` 无语法错误。
2. `node --test test/<name>.test.mjs` 全绿，且断言数 ≥ 8。
3. `apply(makeCtx())` 不抛错；服务 key 可从 ctx.get 读到。
4. 没有向 `dsh-hot-update` 或 profile 目录写任何东西。
5. 汇报：文件、断言数、已知未实现/降级点（明确写 NOT ESTABLISHED 的项）。

---

## 9. 参考实现位置（可以直接搬，但必须留在本仓库自包含）

| 目标 | 参考 |
|---|---|
| scorer | `dsh-hot-update/packages/score-guard/index.js` + `packages/scan/imports.mjs`（已复制到 `src/plugins/imports.mjs`） |
| healer | `packages/ci-gate/index.js`（G1–G12）+ `packages/scan/*` |
| approver | `packages/approval/index.js`（队列/AB/监控/回滚） |
| hot-reloader / restart-guard | `packages/restart-guard/index.js`（1789 行：classifyRisk/decide/swapPlugin/健康窗/buffer/promote） |
| forker | `packages/watchdog.mjs`（splitCommand/relaunchArgv/isAlive/退避）+ `packages/supervisor.mjs` |
| auditor | `packages/shared/ledger.mjs`（已复制到 kernel）+ restart-guard 里的 boot 自检写法 |
| buffer-keeper | restart-guard 的 buffer 扫描段 + `packages/shared/rounds*.mjs` |
| router | `dsh-hot-update/双区模型-瓮城加容器.md` + `packages/probes/*`（容器执行，v1.0.0 只要求 decision 逻辑，container 执行可降级为 `{ok:false, reason:'not-installed'}`） |
