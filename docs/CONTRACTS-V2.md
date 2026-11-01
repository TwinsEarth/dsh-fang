# dsh-Fang v2.0.0 — 集成契约（并行开发唯一事实源）

> 仓库 `dsh-fang`，包 `@local/dsh-fang`，版本 **2.0.0**。
> v1.0.0 的契约见 [CONTRACTS.md](CONTRACTS.md)；本文件只写 **v2 增量与变更**，v1 契约中未被覆盖的签名保持不变。
> 三层拓扑：**母体大脑（Orchestrator/Forker/RestartGuard）→ 分身器官（Scorer/Router/Healer/Approver/HotReloader/BufferKeeper/Auditor/Adapter）→ 容器兜底（AppContainer）**。

---

## 1. 部署矩阵（角色门禁）

同一个 bundle 同时装进母体和分身，**哪个插件在哪个角色激活由 kernel 决定**：

```js
import { roleGate } from '../kernel/index.mjs'

export function apply(ctx, config) {
  const gate = roleGate('adapter', { logger: ctx.logger })   // 'orchestrator'|'forker'|…
  if (!gate.active) return                                  // 未部署到该角色：不注册服务/定时器/路由
  …
}
```

`roleGate(key)` 的矩阵（`src/kernel/role.mjs`）：

| key | mother | fork |
|---|---|---|
| orchestrator | ✅ | ❌ |
| forker | ✅ | ❌ |
| restartGuard | ✅ | ❌ |
| healer | ❌ | ✅ |
| hotReloader | ❌ | ✅ |
| adapter | ❌ | ✅ |
| scorer | ✅ | ✅ |
| router | ✅ | ✅ |
| approver | ✅ | ✅ |
| bufferKeeper | ❌ | ✅ |
| auditor | ✅ | ✅ |

角色来源：环境变量 `DSH_FANG_ROLE`（forker 启动分身时注入 `fork`）优先，其次 config.role，缺省 mother。
**每个插件 apply 的第一行必须做 roleGate**，未激活直接 return（不得注册服务/定时器/路由）。

---

## 2. 写域（并行开发互不覆盖）

| owner | 文件 |
|---|---|
| T5 adapter | `src/plugins/adapter.mjs`、`src/lib/remote.mjs`、`test/adapter.test.mjs`、`test/remote.test.mjs`、`docs/t5-report.md` |
| T6 router+scorer | `src/plugins/router.mjs`、`src/plugins/scorer.mjs`、`test/router.test.mjs`、`test/scorer.test.mjs`、`test/fixtures/t2/**`（可加）、`docs/t6-report.md` |
| T7 forker | `src/plugins/forker.mjs`、`test/forker.test.mjs`、`test/fixtures/t1/**`（可加）、`docs/t7-report.md` |
| T8 container | `src/lib/container/**`、`probes/**`（从旧仓库复制）`、`src/plugins/buffer-keeper.mjs`（仅追加代理能力）、`test/container-*.test.mjs`、`docs/t8-report.md` |
| T9 auditor+approver | `src/plugins/auditor.mjs`、`src/plugins/approver.mjs`、`test/auditor.test.mjs`、`test/approver.test.mjs`、`docs/t9-report.md` |
| Lead | 其余全部：`package.json`、`cordis.patch.yml`、`src/index.mjs`、`src/compose.mjs`、`src/kernel/**`、`src/plugins/orchestrator.mjs`、`client.js`、`tools/**`、`docs/CONTRACTS-V2.md`/`ARCHITECTURE-V2.md`/`CHANGELOG.md`/交付报告 |

**禁止**改别人的文件；需要共享改动 → 消息 Lead。kernel 已由 Lead 加好 `role.mjs` / `extensions.mjs` / v2 词汇，直接用。

---

## 3. 内核 v2 增量（已实现，`src/kernel/index.mjs` 导出）

```js
// role.mjs
ROLE{MOTHER,FORK} · MATRIX · resolveRole({cfgRole,env}) · roleAllows(key,role) · roleGate(key,{cfgRole,env,logger}) · rolesOf(key)

// extensions.mjs（商用接入点，v2 只有钩子）
COMMERCIAL · SERVICE_COMMERCIAL('fangCommercial') · commercialConfigSchemaDefaults()
resolveCommercial({commercialHooks,provider,capability}) · invokeCommercial({...}) // 永不抛出，返回 {ok,value|error}

// types.mjs v2 词汇
FANG_VERSION='2.0.0'
TASK_STATUS{PROVISIONING,READY,RUNNING,ARCHIVED,FAILED}
ADAPTER_OP{PING,STATUS,FLUSH_BUFFER,SCORE_PLUGIN,READ_PLUGIN,ROUTE_CONFIRM,APPROVALS,APPROVAL_DECIDE,ARCHIVE}
ADAPTER_ROUTE{HELLO:'/adapter/hello',STATUS,APPROVALS,AUDIT,COMMAND}
CONTAINER{DISABLED,UNAVAILABLE,READY}
```

---

## 4. 跨进程协议（母体 ↔ 分身）

**不共享进程内 ctx/bus**。控制通道 = 分身自己的 HTTP 服务（`webServer` 路由），鉴权复用分身启动时打印的 token：

```
母体                        分身（adapter）
POST {forkUrl}/fang/adapter/command?token=…  {"op":"flush-buffer","payload":{…}}
GET  {forkUrl}/fang/adapter/status?token=…   → { ok, role:'fork', taskId, services, buffer, approvals, audit }
GET  {forkUrl}/fang/adapter/audit?token=…&limit=100
GET  {forkUrl}/fang/adapter/approvals?token=…
GET  {forkUrl}/fang/adapter/hello?token=…
```

- token 来自 `parseWebUrl()` 解析出的 URL（`?token=…`），remote 客户端负责拼接。
- 命令必须幂等/可超时；母体对每个 fork 维护 `{remote, adapterReady}`。
- 审计流：分身 Auditor 落盘 `<forkHome>/fang/<forkProfile>/audit.jsonl`；母体通过 `audit` 拉取（按需），由母体 Auditor `aggregate()` 汇总。

---

## 5. 新组件契约

### 5.1 Adapter（T5，仅 fork）
`src/plugins/adapter.mjs`：行 `fang-adapter`，服务 `fangAdapter`（`SERVICE.adapter`）。

```js
Config = z.object({
  prefix: z.string().default('/fang'),
  taskId: z.string().default(''),            // 缺省取 env DSH_FANG_TASK_ID / forkId
  auditLimit: z.number().default(500),
  commandTimeoutMs: z.number().default(10000),
})

service = {
  role:'fork', taskId,
  hello() -> { ok:true, role:'fork', taskId, version, capabilities:[...] },
  status() -> { ok, taskId, role, services:{scorer,router,healer,approver,hotReloader,buffer,auditor,adapter}, buffer:{state,pending,dir}, approvals:{pending}, audit:{records,head}, startedAt },
  approvals() -> { ok, items:[...] },
  audit({limit=100}) -> { ok, records:[...] },
  async command({op, payload}) -> { ok, op, result } | { ok:false, op, error, code },
     // ping/status/flush-buffer/score-plugin/read-plugin/route-confirm/approvals/approval-decide/archive
  routes                                        // 已注册路径数组（测试用）
}
```
命令实现必须容错：依赖服务缺失 → `{ok:false,code:'service-unavailable'}`。`read-plugin` 只读 `<fork buffer>/<pluginId>` 下文件并返回 `{files:{relPath:string}}`（文本，最大 2MB，拒绝路径逃逸）。`archive` = flush buffer + 结束（不 kill 自身；kill 由母体 Forker 做）。HTTP 处理器与 service 共用同一实现，方法校验（GET/POST）与错误码：405/400/409/500。

同时 HTTP 路由（`webServer.register({kind:'exact', path})`，前缀来自 Config.prefix）：
`GET /fang/adapter/hello`、`GET /fang/adapter/status`、`GET /fang/adapter/approvals`、`GET /fang/adapter/audit`、`POST /fang/adapter/command`。
路径与 `ADAPTER_ROUTE` 常量保持一致。

### 5.2 Remote 客户端（T5）
`src/lib/remote.mjs`（纯模块，可注入 fetch，零 node 依赖）：

```js
export function withToken(url, token)                     // 幂等拼接/替换 token 查询参数
export function extractToken(url) -> string
export function createRemote({ url, token, fetchImpl=globalThis.fetch, timeoutMs=5000, prefix='/fang' })
  -> {
    url, token,
    hello(), status(), approvals(), audit({limit}={}), command(op, payload={}), ping(),
    // 统一返回 {ok, status, data|error, kind?}；不抛出
  }
export function classifyRemoteFailure(err) -> {kind:'timeout'|'network'|'http'|'json'|'unknown', message}
```
测试用假 fetchImpl 覆盖：成功、超时（AbortSignal）、非 JSON、405、token 拼接。

### 5.3 Router v2（T6）
```js
Config = z.object({
  trustedPlugins: z.array(z.string()).default([]),
  containerAvailable: z.boolean().default(false),
  container: z.object({           // P5 容器分支；enabled 默认 false
    enabled: z.boolean().default(false),
    powershellPath: z.string().default('powershell.exe'),
    timeoutMs: z.number().default(30000),
  }).default({}),
})

service = {
  // 母体：初判（只跑静态 quickScan + 来源可信度 + 能力需求）
  decide({plugin, assessment, source}) -> RouteDecision
  // 分身：复核（只允许升级路由，不能降级；母体 deny 不可推翻）
  confirm({decision, assessment}) -> RouteDecision & { escalated:boolean }
  containerAvailable() -> { ok, state:'disabled'|'unavailable'|'ready', reason }
  async runInContainer({code, declaredWrites, env}) -> { ok, stdout, stderr, exitCode, writes }
}
RouteDecision = { route:'sandbox'|'container'|'deny', reason, needsApproval, basis:{role, environment, grade, source, escalated?} }
```
规则：`rank = {sandbox:1, container:2, deny:3}`；`confirm` 输出 route = max(decision.route, fork 复核建议)，且 `decision.route==='deny'` 原样返回。容器分支通过 `await import('../lib/container/index.mjs')` 懒加载（T8 提供），`enabled=false` 时 `containerAvailable()={ok:false,state:'disabled'}`。

### 5.4 Scorer v2（T6）
```js
Config = z.object({
  allowlist: z.array(z.string()).default([]),
  thresholds: z.object({
    mother: z.object({a:z.number().default(20),b:z.number().default(40),c:z.number().default(60),d:z.number().default(80)}).default({}),
    fork:   z.object({a:z.number().default(25),b:z.number().default(45),c:z.number().default(65),d:z.number().default(85)}).default({}),
  }).default({}),
})
scoreSource(source, pkg?, opts?) -> {
  grade, S, color, veto, degraded, signals, reasons,
  basis: { environment:'mother'|'fork', thresholds:{a,b,c,d}, note:'本评分基于 <environment> 阈值' }
}
scoreDir(dir, manifest?, opts?) -> 同上 + { dir, entry }
scoreIntent(intent, opts?) -> { light, notes, basis }
```
`opts.environment` 缺省按 `resolveRole()` 取。v1 数值行为（母体阈值 = v1 分档）保持不变，分身更宽。

### 5.5 Forker v2（T7）
```js
Config 追加:
  portPool: z.object({ start:z.number().default(18000), end:z.number().default(18100) }).default({}),
  allocatePorts: z.boolean().default(true),      // true：预分配确定性端口；false：退回 --port 0
  cleanTemplate: z.boolean().default(true),      // true：用内置干净模板；false：沿用 profileTemplate
  bundleName: z.string().default('@local/dsh-fang'),
  forkProfileTag: z.string().default('web-base'),

service 追加/变更:
  allocatePort() -> { ok, port, reason }
  releasePort(port) -> { ok }
  ensureTemplate({ templateDir, nodeModulesSource }) -> { ok, dir, files:[], warnings:[] }
     // 生成干净模板：package.json{ dsh.profile.bundles:[dsh-base,dsh-web-app,bundleName] }、
     // cordis.yml '[]'、cordis.patch.yml '[]'、node_modules junction→nodeModulesSource
  spawn({forkId, homeDir, profile, cliPath, port?, env?, timeoutMs?}) -> { ok, pid, port, url, token }
     // 分配/使用端口 → 参数 --port <port> → 校验打印 URL 的端口与预期一致
  status/list 保持；stop/reap 释放端口
```
端口池跨进程持久化在 `dataDir/ports.json`；启动时把已死 pid 的端口回收。`provision` 在 `cleanTemplate=true` 时使用 `ensureTemplate` 结果（同时仍克隆模板的 package.json/cordis*.yml）。不引入对真实 dsh 的测试依赖：单测用假 CLI（fixture 支持 `--port N` 回显）。

### 5.6 Container（T8）
`src/lib/container/index.mjs`（纯导出 + 懒加载探测）：

```js
export function createContainerHost({ powershellPath='powershell.exe', probeDir, timeoutMs=30000, execFileImpl })
  -> { state:'disabled'|'unavailable'|'ready',
       available() -> {ok,state,reason},
       async exec({ code, env={}, declaredWrites=[], timeoutMs }) -> { ok, stdout, stderr, exitCode, writes },
       dispose() }
export function validateWriteRequest({ bufferRoot, declared, req }) -> { ok, target?, reason? }
   // req = {op:'write', path, data(base64|utf8), reqId}
   // 规则：path 规范化后必须落在 bufferRoot 内（拒绝 ..、绝对盘符、UNC、junction 逃逸）；
   //       必须命中 declared（manifest 申报）的 allowlist（前缀匹配）；大小上限 1MB
export function applyWriteRequest({ bufferRoot, declared, req, fsx }) -> { ok, target, bytes }
export function encodeFrame(obj) / parseFrames(buffer) -> {frames:[], rest:string}   // NDJSON 帧
export const WRITE_PROXY_OPS = ['write','ping','stat']
```
`probes/`：从 `dsh-hot-update\packages\probes\` 复制 **AppContainerHost.cs、container-exec-pipe.ps1、worker-pipe-exec.mjs、duplex-channel-test.ps1**（只复制这几个；脚本保持 ASCII）。真实容器测试用 `FANG_CONTAINER_LIVE=1` 开关，缺省 skip 并在测试名/报告里明确 skipped 原因。

BufferKeeper 追加（不得破坏 v1 方法/测试）：
```js
Config 追加 proxy:{ enabled:z.boolean().default(false), maxBytes:z.number().default(1048576) }
service 追加:
  proxyState() -> { enabled, bufferRoot, declaredCount }
  setDeclared(declared) -> { ok, count }          // declared = [{path, reason}]
  proxyWrite(req) -> { ok, target?, bytes?, reason? }   // 走 validateWriteRequest + kernel fsx 原子写 + 审计 AUDIT.ROUTE/BUFFER_FLUSH
  proxyLog({limit=20}) -> entries
```

### 5.7 Auditor / Approver v2（T9）
Auditor 追加（v1 方法保持）：
```js
service 追加:
  scope -> 'mother'|'fork'
  aggregate({ limit=200, sources=[{taskId, records:[...]}] }) -> { ok, total, records:[{taskId|null, ...record}], sources:[taskId] }
     // 纯汇总：母体记录 taskId=null，分身记录打上 taskId；按 seq/at 排序
  bootAudit() -> { ok, findings }      // v1 bootCheck 的别名/等价物（保留 bootCheck）
  cloudSink() -> {ok:false, reason:'not-configured'}   // 商用钩子占位
```
Approver 追加（v1 方法保持）：
```js
service 追加:
  scope -> 'mother'|'fork'
  requestPromotion({pluginId, taskId, detail, impact}) -> Promise<{id,outcome,...}>   // == request({kind:'promotion', risk:'red'})
  requestRestart(req) -> Promise<{...}>                                              // == request({kind:'restart', risk:'red'})
  summary({ remotes=[] }) -> Promise<{ ok, local:[...], remote:[{taskId, items:[...], ok}], total }>
     // remotes = [{taskId, fetchApprovals: async () => ({ok,items})}]
```
两侧语义不同：fork 处理任务内黄/红灯动作；mother 只处理 promotion/restart 且汇总所有分身待办。

### 5.8 Orchestrator（Lead，供上下文）
v2 追加（实现由 Lead 完成，接口供 T5/T9 对齐）：
```js
createTask({title, template?, collaborators?}) -> { taskId, forkId, url, port, homeDir, adapter:{ok, version} }
listTasks() -> TaskSummary[]
getTaskStatus(taskId) -> { taskId, status, fork:{…}, adapter:{ok,status}, audit:{records,head} }
promoteTask(taskId, pluginId) -> { ok, outcome, target, motherAssessment, forkAssessment }
archiveTask(taskId) -> { ok, archived, reaped }
// fork/reap/listForks/getForkHealth 保留
```
事件话题（bus）：`fang/task-created`、`fang/task-ready`、`fang/task-archived`、`fang/task-failed`、`fang/adapter-command`。

### 5.9 Umbrella / 保护伞（v2.7.6）
一个证据管道、两个评分出口：插件等级（静态，来自 5.4 的 scorer）与动作灯色（动态，本插件自算）。
```js
Config = z.object({
  bufferRoot: z.string().default(''),         // 空 = 取 buffer-keeper 的实时 dir
  productionRoot: z.string().default(''),
  allowPaths: z.array(z.string()).default([]),
  networkAllowlist: z.array(z.string()).default([]),
  credentialPatterns: z.array(z.string()).default([]),   // 空 = 内置默认；非空 = 完全替换
  destructivePatterns: z.array(z.string()).default([]),
  lifecyclePatterns: z.array(z.string()).default([]),
  lifecycleTools: z.array(z.string()).default([]),
  gradeFloorTable: z.string().default('umbrella'),       // umbrella | strict
  cacheSize: z.natural().default(200),
  auditDecisions: z.boolean().default(true),
  baselineFile: z.string().default(''),  // v2.8.1：基线（默认随包 defaults/umbrella-rules.yaml；:none: 关闭）
  envRulesFile: z.string().default(''),    // v2.8.1：环境层（空 = 读 UMBRELLA_RULES_PATH）
  rulesFile: z.string().default(''),      // v2.8.0：项目层（空 = 只用基线+内置）
  rulesWatch: z.boolean().default(true),    // 热加载（失败保留上一次有效规则）
  rulesDebounceMs: z.natural().default(200),
})

assessPlugin({pluginId?, dir?, manifest?, source?, pkg?, version?, refresh?}) -> {
  pluginId, version, grade:'A'|'B'|'C'|'D'|'E', score, color, veto, degraded,
  signals, reasons, basis, entry, dir, cachedAt, fingerprint, durationMs, fromCache
}                                              // 无 scorer / 扫描异常 = grade 'E' + degraded
assessAction(evidence, {grade?|assessment?|pluginId?}) -> {
  light, baseLight, gradeFloor, raised, pluginGrade, gradeBasis,
  matchedRule, category, tags, lifecycle, credential, reason, evidence, tool, target, path, durationMs
}
decideAction(evidence, opts?) -> assessAction 结果 + { decision:'allow'|'mark'|'ask'|'delegate'|'deny', severity, decisionRecord }
baseLight(evidence) -> { light, matchedRule, category, tags, lifecycle, credential, target, path, reason, evidence }
explain(evidence)   -> { light, matchedRule, category, tags, reason, evidence, target }
rules / ruleIds() / registerRule(rule, {before|after}) / overrideRule(id, patch) / removeRule(id) / resetRules()
ruleConfigStatus() / reloadRules() / applyRuleConfig(config) / ruleRegistry   // v2.8.0 YAML 叠加层
// v2.8.1: registry.applyLayer(config) 分层（基线→项目→环境）；hard-deny/non-negotiable 不可关闭/降级
gradeFloor(grade) / effectiveLight(base, grade) / cachedGrade(id) / cacheStats() / invalidate(id) / clearCache()
```
不变量（有测试）：`rank(effectiveLight) >= rank(baseLight)` 且 `>= rank(gradeFloor)`；
等级永不降低动作风险；未知等级按 E、未知工具按黄、未知灯色按黄。

**动作规则表（v2.7.8）**：`ActionRule = { id, category, light, reason, tags[], match(ev, ctx), evidence(ev, ctx) }`，
默认 15 条，数组顺序即优先级、**首个命中胜出**；`register` 必须给 `before`/`after`（追加到表尾等于永不命中），
形状不合法在注册时抛错。`evidence` 返回结构化 `{ matchedPattern, ... }` 进审计，回答「为什么是这个灯色」；
上下文由 `buildActionContext()` 一次解析（`mode`/`commandText`/`writeTargets`/`readTargets`/`targetPath`/`url`/`targetPid`），
shell 重定向由 AST-lite 词法器解析（v2.7.9）：操作符语义、fd 复制、heredoc 跳过、引号、命令边界；语法错误 → parseFailed，规则 fail-closed 判黄。

审计：一次 `decideAction` 一条 `AUDIT.UMBRELLA_DECISION`（`kind:'umbrella-decision'`，含 `category` 与 `evidence`）；
插件评分不重复写（沿用 5.4 的 `AUDIT.SCORE`）。
**边界**：本仓库没有工具执行钩子，本服务提供决策而**不强制拦截**；`delegate`/`ask` 的落点
（restart-guard / approver）需要调用方显式投递。详见 `docs/UMBRELLA.md §7`。
---


## 6. 商用接入点（钩子已就绪，实现不在本期）

`kernel/extensions.mjs` 定义 `COMMERCIAL` 能力名与 `invokeCommercial()`。各插件只做“若已配置则调用、失败不阻塞”：

| 能力 | 接入点 | 行为 |
|---|---|---|
| collaboration | Orchestrator.createTask({collaborators}) | 记录 collaborators；`collaboration.publishChange`（无 provider 则跳过） |
| git | BufferKeeper flush settled 后 | `git.snapshot({dir,message})`（无 provider 则跳过） |
| backup | Orchestrator.archiveTask / Auditor | `backup.upload({kind,id,key,body})` |
| tokenApi | 独立模块（不在 10 插件内） | 本期不实现 |
| teams | Orchestrator 权限检查 + Approver 审批人字段 | `teams.check({action,group})`（无 provider 一律放行并记录 `basis.commercial:false`） |

---

## 7. 测试与验收

- 命令：`node --test --test-concurrency=1 "test/*.test.mjs"`（node v24 不接受目录参数）。
- 每个 owner：单文件 `node --test test/<file>.test.mjs` 全绿，新文件 ≥8 断言；报告写 `docs/<owner>-report.md`。
- 不允许真实 spawn dsh / 真实容器（真实探针用 `FANG_CONTAINER_LIVE=1` 手动跑，测试里 skip）。
- 每个插件必须验证：**角色门禁**（fork 角色下 mother-only 插件不注册服务；mother 角色下 fork-only 不注册）。
- v1 既有测试必须继续全绿（除因 v2 行为变化而由对应 owner 更新的断言，需在报告里说明）。

## 8. 完成定义

1. 全部文件可 `node --check`；`node --test --test-concurrency=1 "test/*.test.mjs"` 全绿。
2. 插件 apply 首行有 roleGate，且测试覆盖角色矩阵。
3. 新服务方法签名与本契约一致（名称/参数/返回字段）。
4. 不写 profile、不改别人文件、不引入第三方依赖。
5. 向 Lead 汇报：文件、断言数、真实测试输出、降级点/NOT ESTABLISHED。
