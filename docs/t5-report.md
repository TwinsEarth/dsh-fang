# T5 完成报告 — Adapter 跨进程桥 + Remote 客户端

> 任务：task-5（T5）。写域：`src/plugins/adapter.mjs`、`src/lib/remote.mjs`、
> `test/adapter.test.mjs`、`test/remote.test.mjs`、`docs/t5-report.md`。
> 除以上 5 个文件外**未改动任何文件**（未动 kernel / package.json / cordis.patch.yml /
> 他人的插件与测试；未写 profile；未 spawn 真实 dsh；未引入第三方依赖）。

## 1. 交付文件

| 文件 | 行数 / 大小 | 说明 |
|---|---|---|
| `src/plugins/adapter.mjs` | 693 行 / 27.7 KB | `fang-adapter`：roleGate(cfg 仅 fork) + 5 条 exact HTTP 路由 + 9 条控制命令，HTTP 与 service 共用同一实现 |
| `src/lib/remote.mjs` | 302 行 / 12.9 KB | 纯模块（零 `node:*`，只用 Web 标准），`withToken`/`extractToken`/`createRemote`/`classifyRemoteFailure`，永不抛 |
| `test/adapter.test.mjs` | 699 行 / 33.7 KB | 26 个 test、**220 处 `assert.*`** |
| `test/remote.test.mjs` | 246 行 / 12.0 KB | 12 个 test、**88 处 `assert.*`** |
| `docs/t5-report.md` | 本报告 | — |

模块形状满足 CONTRACTS-V2 §5.1/§5.2：两个模块均可 `node --check`；adapter 导出
`name='fang-adapter'`、`inject=[]`、`Config`（kernel vendored `z`）、`apply(ctx, config)`；
remote 无副作用、可注入 `fetchImpl`。Lead 已把 `./adapter` 加进 `package.json` exports，
并在 `cordis.patch.yml` 增加 `fang-adapter` 行（config 的 4 个键与本模块 `Config` 默认值一致）。

## 2. 契约实现对照

### 2.1 角色门禁（CONTRACTS-V2 §1）

```js
export function apply(ctx, config) {
  const gate = roleGate('adapter', { logger: ctx.logger })   // apply 首行
  if (!gate.active) return
  …
}
```

- 角色来自 `resolveRole()`（env `DSH_FANG_ROLE` > 配置 role > mother），adapter 只在 `fork` 激活；
- mother 角色下 **不注册服务、不注册路由、无定时器**（测试 `roleGate: mother 角色下…` 用
  `webServer` 桩断言 `ws.routes.length === 0` 且 `ctx.get('fangAdapter') === undefined`）；
- `service.role === 'fork'`，`service.taskId` 取 `Config.taskId` → env `DSH_FANG_TASK_ID`
  → `DSH_FANG_FORK_ID`/`DSH_FANG_FORK`/`FANG_TASK_ID` → `''`（forker 已按
  `DSH_FANG_TASK_ID: forkId` 注入，见 `src/plugins/forker.mjs`）。

### 2.2 Adapter（CONTRACTS-V2 §5.1 / PROTOCOL-V2 §3）

**service**（`ctx.effect(() => ctx.provide(SERVICE.adapter, service))`）：

```js
service = {
  role:'fork', taskId, version, routes: string[],
  hello()  -> {ok:true, role, taskId, version, capabilities:[9 个 op]},
  status() -> {ok:true, taskId, role, services:{scorer,router,healer,approver,hotReloader,
               buffer,auditor,adapter}, buffer:{state,pending[],dir}, approvals:{pending:n},
               audit:{records,head}, startedAt, archived},
  approvals()      -> {ok, items[]}                         // 缺 approver → {ok:false,code:'service-unavailable',items:[]}
  audit({limit})   -> {ok, records[]}                       // 缺 auditor → {ok:false,code:'service-unavailable',records:[]}
  async command({op,payload}) -> {ok,op,result} | {ok:false,op,error,code}
}
```

- `services.*` 一律 `ctx.get(SERVICE.x)` 探测（`safeGet` 容错），缺失为 `false`；
- `buffer` 三态透传 BufferKeeper `state()`（`state/pending/dir` 与 v1 `BUFFER_STATE` 名称一致）；
- `audit.records` = 分身本地账本条数，`audit.head` = 最后一条的 `hash`（无 hash 时退 `seq`）；
  缺 auditor 时 `{records:0, head:null, degraded:'service-unavailable'}`，不假装检查过；
- `status().archived` 是本实现附加诊断字段（archive 后为 true），契约未要求但便于幂等断言。

**HTTP 路由**（`ctx.inject(['webServer'], child => …)` + `webServer.register({kind:'exact', path, handler})`，
路径 = `Config.prefix`（默认 `/fang`）+ `ADAPTER_ROUTE` 常量）：

| 方法 | 路径 | 处理器行为 |
|---|---|---|
| GET | `/fang/adapter/hello` | 200 `service.hello()` |
| GET | `/fang/adapter/status` | 200 `service.status()` |
| GET | `/fang/adapter/approvals` | `service.approvals()`；缺服务 → 409 |
| GET | `/fang/adapter/audit` | 解析 `req.url` 的 `?limit=`，`service.audit()`；缺服务 → 409 |
| POST | `/fang/adapter/command` | 读 JSON body（≤1MB）→ `service.command()`；成功 200，失败按 code 映射 |

- **方法校验**：每个 handler 先比对 `req.method`，不匹配 → `405 {ok:false,code:'method-not-allowed'}`；
- **状态码映射**（契约 §5.1 只列 405/400/409/500，故不使用 503）：
  - 400：`bad-request` / `unknown-op` / `missing-op` / `invalid-json` / `path-escape` /
    `file-too-large` / `total-too-large` / `binary-file` / `body-too-large`；
  - 409：`service-unavailable` / `not-found` / `plugin-not-found` / `not-configured` /
    `conflict` / `timeout` / `not-pending`（依赖缺失也算「冲突/不可用」而非 5xx）；
  - 500：`handler-threw`；
- 所有 handler 外层 `try/catch` → 500，`json()` 写头/写体也不允许把处理器打挂。

**9 条命令**（`{op, payload}`，全部容错；返回值在 service 层是 `{ok, op, result}` / `{ok:false, op, error, code}`）：

| op | payload | result | 缺依赖降级 |
|---|---|---|---|
| `ping` | — | `{pong:true, at, pid, taskId, uptimeMs}` | 无依赖 |
| `status` | — | 同 `status()` | 无依赖 |
| `flush-buffer` | `{strictMs?}` | BufferKeeper `flush()` 结果（`state/flushed/timedOut`） | 缺 buffer → `service-unavailable` |
| `score-plugin` | `{pluginId}` | 分身 Scorer Assessment（fork 阈值）+ `pluginId/dir` | 缺 scorer → `service-unavailable`；缺 id → `bad-request`；逃逸 → `path-escape`；不存在 → `plugin-not-found` |
| `read-plugin` | `{pluginId}` | `{files:{relPath:text}, count, bytes, pluginId}` | 见下 |
| `route-confirm` | `{decision, pluginId?, assessment?}` | `Router.confirm()` 结果（只升不降） | 缺 router → `service-unavailable` |
| `approvals` | — | `{items[]}` | 缺 approver → `service-unavailable` |
| `approval-decide` | `{id, outcome\|decision, by?, note?}` | approver `decide()` 结果（`approved/denied` 归一化） | 缺 approver → `service-unavailable`；坏 outcome/缺 id → `bad-request`；`not-found` → `not-found` |
| `archive` | `{flushOpts?}` | `{archived:true, archivedAt, flushed[]}` | 缺 buffer → `service-unavailable`（flush 是必需步骤） |

- **幂等/超时**：每条命令用 `commandTimeoutMs`（默认 10s）包一层硬超时，悬挂的依赖返回
  `code:'timeout'` 而不是让 HTTP 挂住；`archive` 可重复调用（= 再 flush 一次）；
- **archive 不 kill 自身**（kill 由母体 Forker 做）：flush → append 审计
  `AUDIT.TASK_ARCHIVED`（auditor 缺失静默）→ emit bus `fang/task-archived` → 置 `archivedAt`；
- 每条命令成功/失败都会 emit bus `fang/adapter-command {op, ok, code?, taskId?}`（只通知，不影响返回）。

**read-plugin 安全边界**（`<fork buffer>/<pluginId>`）：

1. 先 `resolveInside(bufferRoot, pluginId)`：拒绝空路径、NUL、盘符（`C:`）、UNC（`\\\\`/`//`）、
   `path.isAbsolute`、任一 `..` 段，并用 `path.relative` 二次确认规范化结果仍在 buffer 内；
2. buffer 根优先取 BufferKeeper 的 `.dir`/`state().dir`，其次 `resolveFangLayout().bufferDir`；
3. 递归读取时**不跟随 symlink/junction**（跳过链接），`withFileTypes` + `statSync` 判型；
4. 单文件 > 1MB → `file-too-large`；累计 > 2MB → `total-too-large`（先看 size 再读，避免读爆内存）；
5. 前 8000 字节含 NUL → `binary-file`；文本按 UTF-8 解码，`relPath` 统一用 `/` 分隔；
6. 任何 fs 异常都折叠为 `read-failed`，不抛。

### 2.3 Remote 客户端（CONTRACTS-V2 §5.2 / PROTOCOL-V2 §4）

```js
withToken(url, token)              // token 查询参数幂等拼接/替换，保留 #hash；token 空 → 原样返回
extractToken(url)                  // 取出并 decode；没有 → ''
createRemote({url, token, fetchImpl=globalThis.fetch, timeoutMs=5000, prefix='/fang'})
  -> { url, token, prefix,
       hello(), status(), approvals(), audit({limit}={}), command(op,payload={}), ping() }
classifyRemoteFailure(err)         // -> {kind:'timeout'|'network'|'http'|'json'|'unknown', message}
```

- **统一信封**：成功 `{ok:true, status, data}`；失败 `{ok:false, status, error, kind, data?}`，
  **任何路径都不 reject**（网络异常/同步 throw/超时/非 JSON/循环 payload 全部折叠）；
- `ok` 语义 = **传输层成功**（HTTP 2xx 且 body 可解析）；命令层失败保留在
  `data.ok/data.code`（与 Lead 的 orchestrator 用法一致：`res.ok && res.data.ok !== false`）；
- token：`explicit token` 优先，省略则 `extractToken(url)`；每次请求都从干净 URL 重新拼
  token/limit（不会出现两个 token 参数）；`joinUrl` 丢弃 base 的 query/hash 后拼
  `normalizePrefix(prefix) + ADAPTER_ROUTE.*`；
- 超时：`AbortController` + `setTimeout`，`finally` 清定时器；超时/AbortError → `kind:'timeout', status:0`；
- 响应解析：优先 `res.text()` 后自行 `JSON.parse`（真实 `Response` 只能读一次），退化到
  `res.json()`；2xx 非 JSON → `kind:'json'`；非 2xx → `kind:'http'` 且 `error` 优先取
  body 的 `error`/`code`（如 `method-not-allowed`）；无 `fetchImpl` → `{error:'no-fetch', kind:'network'}`；
- `ping()` = `POST /adapter/command {op:'ping'}`；`audit({limit})` 缺省 `limit=100`，
  显式 `limit=0` 原样发送（由 Adapter 侧解释）。

## 3. 测试与证据

### 3.1 单文件（真实输出摘要）

```
node --test test/adapter.test.mjs test/remote.test.mjs
ℹ tests 38
ℹ pass 38
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 237
```

- `test/adapter.test.mjs`：26 tests / 220 assert，覆盖——
  角色门禁（mother 不注册服务与路由）与 fork 形状、5 条路由与 `ADAPTER_ROUTE`/`Config.prefix`、
  `hello`/`status`/`approvals`/`audit`、HTTP 方法错误 405、非法 JSON/未知 op/缺 op 400、
  依赖缺失 409、9 条命令的成功与全部分支、`service-unavailable`/`not-found`/`handler-threw`/
  `path-escape`/`file-too-large`/`total-too-large`/`binary-file`/`timeout` 降级、
  read-plugin 越界目录/盘符/UNC/`..` 真实拒绝、route-confirm 自动补 assessment、
  archive 的 flush+审计+bus 事件+幂等、命令超时后仍可继续、dispose 释放服务；
- `test/remote.test.mjs`：12 tests / 88 assert，覆盖——
  withToken/extractToken 的拼接/替换/幂等/编码/#hash/空值、hello/status/approvals/audit 的
  路径+方法+limit+token、command/ping 的 POST JSON、token 优先级与自定义 prefix、
  405→`kind:'http'`、非 JSON→`kind:'json'`、仅 `json()` 的响应、超时真的 abort、
  网络错误/无 fetch/同步 throw/循环 payload 永不抛、`classifyRemoteFailure` 五类。

### 3.2 与母体侧的集成证据（非本写域，只读运行）

- `node --test test/orchestrator.test.mjs` → **12/12 pass**。其中
  `adapter handshake makes the task ready`、`getTaskStatus merges the fork-side adapter status`、
  `archiveTask asks the fork to flush, then reaps`、`promoteTask re-scores…` 四条用例会真实启动
  本地 HTTP Adapter 桩并用 **`src/lib/remote.mjs`** 调用（此前因 remote 未交付被 skip，
  现在真实执行通过 → 协议字段 `data.ok/version/role`、`data.result.files`、
  `data.result.grade`、archive 的 `data.ok!==false` 与实现一致）；
- `node --test test/plugins-shape.test.mjs test/kernel.test.mjs` → 22/22 pass：
  Lead 更新的 `plugin shape + role matrix: adapter` 与 `compose mode mounts every plugin of
  the current role` 均通过（mother 下 adapter 不注册，fork 下注册）。

### 3.3 全量回归

```
node --test --test-concurrency=1 "test/*.test.mjs"
ℹ tests 243
ℹ pass 242
ℹ fail 0
ℹ skipped 1        # T8 容器真实探针（FANG_CONTAINER_LIVE 开关，非 T5）
exit code 0
```

v1 既有测试全部保持绿；无因本任务新增的红。

## 4. 降级点 / NOT ESTABLISHED（如实声明）

1. **HTTP 鉴权不在 Adapter 内重复做**：契约要求复用分身 `?token=`，实际鉴权由宿主 DSH
   webServer 完成（裸 URL 401）。Adapter handler 只消费 `?limit=` 等参数、不校验 token；
   单测用处理器直调，因此「真实宿主 401 → Remote 收到 http 错误」这条链路只由
   orchestrator 集成测试的桩近似覆盖，**未在单测里还原宿主鉴权中间件**。
2. **409 用于「依赖服务缺失」**：契约 §5.1 把错误码收在 405/400/409/500，故
   `service-unavailable` 映射 409 而不是语义更贴切的 503；这是显式取舍，已写进测试断言。
3. **`status().buffer.pending` 透传 BufferKeeper 的数组**（不是计数）：契约字段名一致；
   Lead 的 orchestrator 桩里该字段是数字，但双方都只做展示/长度读取，未做严格形状校验。
4. **`read-plugin` 防逃逸是「词法 + symlink 跳过」**：不做 `realpath` 规范化，也不检测
   NTFS hardlink（同目录内硬链接无法从路径层面区分）；junction/symlink 一律不跟随，
   因此「链接指向 buffer 外」不会泄密。
5. **二进制判定是启发式**（前 8000 字节含 NUL）：不含 NUL 的非 UTF-8 字节会被 UTF-8
   解码成替换字符返回，而不是报 `binary-file`；上限内的文本插件源码不受影响。
6. **每命令审计**：Adapter 只为 `archive` 追加 `AUDIT.TASK_ARCHIVED`，其余命令不额外落
   审计行（scorer/router/buffer 自身已落审计），控制面只 emit `fang/adapter-command` 事件；
   若需要「每条跨进程命令都有审计行」，需要 Lead 在 kernel `AUDIT` 增加词汇后再补。
7. **archive 不做进程退出**（契约明确 kill 由母体 Forker 执行）；`status().archived` 是
   契约外附加诊断字段。
8. **route-confirm 的 assessment 是 best-effort 补齐**：payload 只带 `{decision, pluginId}`
   时用分身 Scorer 现算；若 scorer 缺失则原样转发，由 Router.confirm 自行 fail-closed。
9. **Remote 无重试/退避/流式**：单次请求 + 单次超时（默认 5s；orchestrator 传 8000ms）；
   重试策略由调用方（orchestrator 的 handshake 轮询）负责。
10. **真实跨进程 E2E 不在本单测内**：adapter 单测是处理器级（`webServer.find(...).handler`），
    remote 单测是注入假 fetch；真实 dsh 分身 + token + 端口链路由 Lead 的 `tools/e2e.mjs`
    与 T7 fork 验收覆盖，本报告不声称已验证真实分身进程。
11. `ROW.adapter` 在 `src/kernel/types.mjs` 中尚无键（Lead 的 patch 直接写行 id
    `fang-adapter`），不影响本任务；`SERVICE.adapter='fangAdapter'` 已存在且被使用。
12. **未写 profile、未改他人文件**：本任务只产出上表 5 个文件；`package.json`/`cordis.patch.yml`/
    `src/compose.mjs`/kernel 中 adapter 的挂载与导出均为 Lead 完成，已另行核验（patch config
    与本模块 `Config` 的 4 个键/默认值一致）。

## 5. 完成定义对照（CONTRACTS-V2 §8）

1. 全部文件 `node --check` 通过；全量 `node --test --test-concurrency=1 "test/*.test.mjs"`
   242 pass / 0 fail / 1 skip（T8 容器 live）。
2. adapter `apply` 首行 roleGate，测试覆盖 mother/fork 两侧矩阵结果。
3. service 方法签名与契约一致（名称/参数/返回字段，见 §2.2）。
4. 零第三方依赖；未写 profile；未改他人文件。
5. 本报告 + `send_message` 向 Lead 汇报（文件、断言数、真实测试输出、降级点）。
