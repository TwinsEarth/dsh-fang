# T7 报告 — fang-forker v2（确定性端口池 + 干净分身模板 + 角色门禁）

> 版本：`@local/dsh-fang` 2.0.0 · T7 owner：`t7-forker`
> 契约依据：`docs/CONTRACTS-V2.md` §1（角色门禁）/ §5.5（Forker v2）/ §7（测试与验收）/ §8（完成定义）
> 实现环境：Windows 11 + Node v24.16.0，仓库 ESM、零第三方依赖；测试只用 `node:test` + `node:assert/strict`，**从不 spawn 真实 dsh**（一律用 `test/fixtures/t1/fake-dsh-cli.mjs`）。
> 结论：T7 全部交付完成 —— `node --test test/forker.test.mjs` **24/24 全绿**；单文件内 forker 24 条测试在全量快照中同样全 ✔；未改任何写域外文件。

---

## 1. 验收命令与真实输出

```powershell
cd dsh-fang
node --check src/plugins/forker.mjs
node --check test/forker.test.mjs
node --test test/forker.test.mjs
```

真实输出（2026-11-01，本机最后一次运行）：

```
✔ module surface + pure helpers (Config defaults / buildSpawnArgs / classifyExit / parseWebUrl)
✔ launch spec: .cmd needs shell:true, .exe spawns directly, .mjs goes through node
✔ fake CLI echoes --port N, reports fork identity env, and stays scan-safe
✔ roleGate: forker is mother-only — no service and no directories in a fork
✔ apply registers fangForker and an empty registry reports clean failures
✔ provision in cleanTemplate mode builds the fork profile from a forker-owned clean template
✔ provision with cleanTemplate=false keeps the v1 clone-from-profileTemplate behaviour
✔ provision failure paths + node_modules degradation in both template modes
✔ ensureTemplate writes the clean profile contract and is idempotent
✔ allocatePort hands out unique in-pool ports, persists the table and releases on demand
✔ allocatePort skips an OS-occupied port and reports port-exhausted
✔ startup reclaims ports held by dead / pid-less entries and keeps live ones
✔ spawn allocates a pool port, passes --port N, validates the URL port and releases on stop
✔ allocatePorts=false keeps the v1 --port 0 behaviour and never touches the pool
✔ spawn honours an explicit port option and reserves it until stop
✔ spawn detects a URL port that contradicts --port and stops the child (port-mismatch)
✔ spawn parses a banner that is split across stdout chunks
✔ spawn timeout kills the child, releases its pool port and returns {ok:false,error:"timeout"}
✔ spawn reports crash / guard-request exits through classifyExit and the event bus
✔ spawn rejects missing CLI/home, duplicate running forks and maxForks overflow
✔ reap stops the child, releases its port, removes the home tree and preserves the mother node_modules
✔ dataRoot persists the registry; a fresh instance sees stopped forks and can reap them
✔ plugin dispose cancels an in-flight spawn, kills its child and releases its port
✔ cross-plugin auditing is tolerant and uses the kernel AUDIT kinds

ℹ tests 24
ℹ suites 0
ℹ pass 24
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3701.1218
```

全量回归（`node --test --test-concurrency=1 "test/*.test.mjs"`，全部 owner 交付后的最终运行）：

```
ℹ tests 205
ℹ suites 0
ℹ pass 204
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 29701.2901
```

- **全量绿：204 pass / 0 fail / 1 skipped（skip 唯一项 = T8 的 `LIVE container probe (manual)`，`FANG_CONTAINER_LIVE=1` 手动开关，契约 §7 允许 skip）。**
- 本次全量日志中 forker 的 24 条测试全部 ✔，`plugin shape + role matrix: forker` ✔。
- 过程记录：并行开发中途曾出现 9 个 fail，全部属于其他 owner 的进行中文件（T5 adapter 未交付 / T3-T4-T8 未加 roleGate / T6 断言更新中 / Lead 的 package/cordis.patch 更新中），**无一条来自 forker.mjs / forker.test.mjs / fixtures/t1**；上述 owner 交付后复跑即全绿（即上表）。

---

## 2. 交付文件（路径 · 行数 · 断言数 · 覆盖点）

断言数为测试文件中 `assert.*` 语句数（`Select-String 'assert\.'`）；循环内断言实际执行次数更多，远超每文件 ≥8 的硬约束。

| 文件 | 行数 | 断言语句 | 主要覆盖 |
|---|---:|---:|---|
| `src/plugins/forker.mjs` | 1126 | —（实现） | roleGate；端口池（probe/persist/reclaim/allocate/release/mismatch/exhausted）；干净模板 ensureTemplate；provision 双模式；spawn（--port N、URL 端口校验、env 注入、超时/崩溃/dispose）；stop/reap 释放端口；注册表 & 端口表跨实例恢复 |
| `test/forker.test.mjs` | 1140 | **323** | 24 条测试，见 §6 清单 |
| `test/fixtures/t1/fake-dsh-cli.mjs` | 71 | — | 假 CLI：`ok`/`split`/`silent`/`crash`/`restart`/`exit-clean` 六模式；**回显 `--port N`**（`FAKE_DSH_PORT` 可覆盖打印端口，用于制造 port-mismatch）；打印 `DSH_HOME`/`DSH_FANG_ROLE`/`DSH_FANG_TASK_ID`/argv；无 `--profile` 时立即退出（防 `node --test` 扫描 fixture 挂死） |
| `test/fixtures/t1/mother-profile/**` | — | — | 未改动；继续作为母版 profile 素材（README 不得克隆、node_modules 走 junction） |
| `docs/t7-report.md` | — | — | 本报告 |

写域自检：只写上述文件；`package.json`、`cordis.patch.yml`、`src/kernel/**`、其他 owner 的插件/测试、`test/helpers.mjs`、`client.js`、`dist/**` 均未改动。

---

## 3. 服务契约实现对照（§5.5）

### 3.1 Config 追加（全部带契约默认值）

```js
portPool:      { start: 18000, end: 18100 }   // 确定性端口池
allocatePorts: true                           // true: --port <pool port>；false: v1 --port 0
cleanTemplate: true                           // true: 内置干净模板；false: 沿用 profileTemplate
bundleName:    '@local/dsh-fang'              // 干净模板 bundles 的第三个 bundle
forkProfileTag:'web-base'                     // 干净模板 profile 标签（模板子目录/缺省 profile 名）
```

### 3.2 service 追加/变更

```js
allocatePort()   -> Promise<{ok, port, reason, forkId}>            // ok:false 时另带 error:'port-exhausted', pool
releasePort(port)-> {ok, port, released}                           // 幂等；released=false 表示本来不持有
ensureTemplate({templateDir, nodeModulesSource})
                 -> {ok, dir, files:[], warnings:[], error?}
provision({...}) -> {ok, ..., template, cloned, node_modules, warnings}   // 新增 template 字段
spawn({forkId, homeDir, profile, cliPath, port?, env?, timeoutMs?})
                 -> Promise<{ok, pid, port, url, token, allocatedPort?}>
                 // 失败：{ok:false, error:'port-mismatch'|'port-exhausted'|...}
stop/reap/status/list/logs  保持 v1 签名；stop/reap 额外负责释放端口
portPool() / ports()         // 只读内省辅助（测试/运维用，契约外增量）
```

- `allocatePort()` 是 **async**（硬要求：“探活异步，失败试下一个”），返回体仍满足契约的 `{ok, port, reason}` 三字段。
- `spawn` 的 `allocatedPort`、`port-mismatch` 结果里的 `expectedPort` 为增量诊断字段；契约要求的 `{ok,pid,port,url,token}` 在成功路径全部存在。

### 3.3 spawn 行为矩阵

| 条件 | argv | 校验 | 失败返回 |
|---|---|---|---|
| `opts.port > 0` | `--port <opts.port>` | URL 端口必须等于它 | 预留被占 → `{ok:false,error:'port-in-use'}`；不一致 → `port-mismatch` |
| `allocatePorts=true`（默认） | `--port <池端口>` | URL 端口必须等于池端口 | 池耗尽 → `{ok:false,error:'port-exhausted'}`；不一致 → `port-mismatch` |
| `allocatePorts=false` | `--port 0`（v1） | 不校验（OS 选端口） | 与 v1 相同 |

- 端口从池分配/显式预留成功后立刻持久化（`pid:null`）；child 起来后回填真实 pid；**成功启动、崩溃、超时、spawn-error、dispose、stop、reap 全部释放**，不留悬挂占用。
- `port-mismatch`：先 `stop`（taskkill /T /F 整棵树）→ 释放预留端口 → `{ok:false,error:'port-mismatch', expectedPort, port:<子进程打印>, url, pid, killed}`；`status().lastError='port-mismatch'`、`running=false`。

### 3.4 roleGate 与 fork 身份注入

- `apply(ctx, config)` **第一句**：`const gate = roleGate('forker', {cfgRole: config?.role, logger: ctx?.logger}); if (!gate.active) return`。
  - fork 角色下：不注册服务、不建目录、不读配置、零 I/O（测试断言 `ctx.get(SERVICE.forker)===undefined` 且 `dataRoot` 目录不存在）。
  - 角色来源优先级按 kernel：env `DSH_FANG_ROLE` > `config.role` > mother（两条路径都有测试）。
- `spawn` 的 env 固定注入 `DSH_HOME=homeDir`、`DSH_FANG_ROLE=fork`、`DSH_FANG_TASK_ID=forkId`（`opts.env` 可覆盖，便于调用方加 `DSH_FANG_MOTHER` 等）；测试用假 CLI 回读 env 断言。

---

## 4. 端口池实现（关键机制）

1. **探活**：`net.createServer().listen({port, host:'127.0.0.1', exclusive:true})` 成功才算可用（异步 Promise；error/超时 5s 均视为不可用，继续下一个候选）。测试用“真实 bind 一个端口 → 单端口池 allocate 必须 `port-exhausted` → 释放后同一端口可分配到”证明探活不是摆设。
2. **持久化**：占用表写 `<dataDir>/ports.json`（`{port:{forkId,pid,at}}`，按端口排序、`writeJsonAtomic` 原子写）。`<dataDir>` = `resolveFangLayout({dataRoot}).dataDir`；`dataRoot` 为空时**只用进程内存**（与 v1 注册表同一策略，见 §8 降级点）。
3. **启动回收**：第一次端口操作时懒加载（apply 零 I/O），逐条判断记录的 pid：`process.kill(pid,0)`（EPERM 视为存活）；**已死 pid 与 pid=null 的残留预约都回收**，存活 pid 的占位保留（跨进程互斥的最低保证）。测试用“死 pid + pid:null + 本进程存活 pid”三条混合记录验证：死/空被回收、低端口被复用、存活条目仍在。
4. **唯一性**：单实例内表内已占端口直接跳过；连续分配 3 个 → 3 个互不相同的池内端口。
5. **耗尽**：整池无候选 → `{ok:false, error:'port-exhausted', port:null, reason:'port-exhausted', pool:{start,end}}`。
6. **释放**：`stop`/`reap`/`dispose`/所有失败路径都调用内部 `releaseOwnedPort(port, forkId)`；`releasePort(port)` 是公开幂等释放。**只释放本实例拥有的端口**（`ownedPorts` Map + 表内 forkId 双重校验），避免多实例共享 dataRoot 时误删他人在用端口。

---

## 5. 干净模板实现（关键机制）

### 5.1 `ensureTemplate({templateDir, nodeModulesSource})`

产物（`templateDir` 由调用方给定、自动创建、可重复调用）：

```jsonc
// package.json
{ "name": "dsh-fang-fork-<forkProfileTag>", "version": "1.0.0", "private": true,
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "<bundleName>"
  ] } } }
// cordis.yml / cordis.patch.yml 内容均为 "[]\n"
// node_modules → junction 到 nodeModulesSource（存在时）；不存在 → warnings:['node-modules-source-missing']，仍 ok:true
```

- 返回 `{ok, dir, files, warnings}`；`files` 为实际确保的相对条目（`package.json`,`cordis.yml`,`cordis.patch.yml`,以及成功时的 `node_modules`）。
- 幂等：重复调用重写同样的三个文件、已有 junction 不重复创建、不抛错。
- 缺 `templateDir` → `{ok:false,error:'no-template-dir'}`；写盘异常 → `{ok:false,error:'template-write-failed'}`（不抛出）。
- `bundleName` / `forkProfileTag` 来自 Config（测试用自定义 `@local/custom-bundle`、`alt-tag` 验证）。

### 5.2 provision 双模式

- `cleanTemplate=true`（v2 默认）：
  1. 依赖 `profileTemplate` 目录仅作为 **node_modules 源**（不存在仍按 v1 报 `profile-template-missing`，保持 v1 错误语义）；
  2. 在 `<homeDir>/templates/<forkProfileTag>` 调 `ensureTemplate` 生成 forker 自有干净模板（**绝不写母体 profile 目录**，母体不可变）；
  3. 从干净模板克隆 `package.json` + `cordis*.yml` 到 `<homeDir>/profiles/<profile>`；
  4. `<profileDir>/node_modules` junction → 母版 `node_modules`；
  5. 返回 `template:<干净模板目录>`；母体脏 profile 的 `dependencies` / 自定义 bundle patch **不会**出现在分身 profile 里（测试显式断言 `pkg.dependencies===undefined`、母体 package.json 未被改写）。
- `cleanTemplate=false`：v1 行为原样保留（直接从 `profileTemplate` 克隆 package.json + cordis*.yml，`template` 返回该目录）。
- 缺 node_modules 源：clean 模式 → `warnings:['node-modules-source-missing']`（契约原文）；legacy 模式 → `warnings:['node-modules-missing']`（v1 既有语义保留）。两者都 **ok:true 但降级**。
- 重复 provision 同一 forkId → 幂等（不新增注册表行、不抛错）。

---

## 6. 测试覆盖清单（24 条 / 323 断言语句）

| # | 测试 | 覆盖点 |
|---:|---|---|
| 1 | module surface + pure helpers | 名称/inject/Config 默认值（5 个 v2 字段）、resolvePortPool 合法/非法、buildTemplatePackageJson 三 bundle、buildSpawnArgs `--port 0` 与 `--port 18042`、classifyExit(0/75/3/null)、parseWebUrl 有 token/无 token |
| 2 | launch spec | `.cmd`→shell、`.exe` 直启、`.mjs`→node，端口透传到 argv |
| 3 | fake CLI echo | 无 `--profile` 扫描安全；`--port 18042` 回显到 banner；env 回读 role/task |
| 4 | roleGate | fork 角色（env / config.role 两条）不注册服务、不建 dataRoot 目录；mother 注册；`service.role='mother'` |
| 5 | apply 注册 | 全部 10 个方法存在；空注册表语义；apply 不写 forks.json/ports.json |
| 6 | provision clean | 模板目录产物、三 bundle、private、cordis.yml/patch 为 `[]`、junction、只克隆三文件、README 不克隆、母体未写、幂等、`template` 字段、审计 |
| 7 | provision legacy | 从 profileTemplate 克隆、`template` 指向 profileTemplate、幂等 |
| 8 | provision 失败/降级 | no-home-dir / no-profile-template / profile-template-missing；legacy 缺模块 `node-modules-missing`；clean 缺源 `node-modules-source-missing` 且仍成功 |
| 9 | ensureTemplate | 产物字段/内容、junction 目标、幂等、缺源 warning、无 templateDir 错误、bundleName/forkProfileTag 定制 |
| 10 | allocatePort 唯一/持久化/释放 | 3 个唯一池内端口、ports.json 三行 `{pid:null,at,forkId}`、release 幂等、释放后可再分配、非法端口 ok:false |
| 11 | allocatePort 占用/耗尽 | **真 bind 占用端口 → port-exhausted**；释放后可分配；单端口池第二次 allocate 直接耗尽 |
| 12 | 启动回收 | 死 pid / pid:null 回收、存活 pid 保留、最低回收端口被复用 |
| 13 | spawn 池分配 happy path | 池内端口、`allocatedPort`、URL 端口一致、argv 含 `--port <p>`、env role/task、home、ports.json pid/forkId、fork-started 事件、stop 释放、子进程真退出 |
| 14 | `allocatePorts=false` | 保持 `--port 0`、不写 ports.json、无 `allocatedPort` |
| 15 | 显式 `opts.port` | 使用显式端口、预留持久化、stop 释放 |
| 16 | **port-mismatch** | 子进程打印端口 ≠ `--port` → ok:false + expectedPort + 子进程被杀 + 状态 STOPPED/lastError + 端口释放 |
| 17 | split banner | 跨 chunk 的 URL 仍能解析（v1 回归） |
| 18 | timeout | `{ok:false,error:'timeout'}`、真等待、状态、**端口释放**、子进程被杀 |
| 19 | crash/restart | 退出码 3 崩溃、75 restart-request、事件总线顺序 |
| 20 | 参数/上限/坏 CLI | no-cli-path / no-home-dir / already-running / max-forks / spawn-error，失败路径不泄漏端口 |
| 21 | reap | 杀进程、释放端口、删除 home（含 templates）、**不跟随 junction 进母体**、注册表清空 |
| 22 | dataRoot 持久化 | forks.json 跨实例恢复（running=false、历史 port 保留）、跨实例 reap |
| 23 | dispose | 取消 in-flight spawn、杀子进程、**释放池端口（无泄漏）** |
| 24 | 审计容错 | FORK_CREATED/STARTED/REAPED、STARTED.port 与真实一致、审计器抛异常不影响生命周期 |

---

## 7. 与 v1 既有断言的差异（合理更新说明）

| v1 断言 | v2 处理 | 原因 |
|---|---|---|
| spawn happy path `res.port===54321`、argv `--port 0` | 改为断言 **池内动态端口**、`allocatedPort`、argv `--port <res.port>`、ports.json 归宿 | v2 默认 `allocatePorts=true`，端口不再由 OS 随机 |
| split 用例的 `FAKE_DSH_PORT=54322` | 该用例显式配 `allocatePorts:false`，保留 `--port 0` 路径 | 专测“拆包 banner”，不重复测池 |
| “provision clones mother package.json” | clean 用例改为断言 **干净 package.json**（三 bundle/无母体 dependencies）；原断言移入 `cleanTemplate:false` 用例 | v2 默认不再继承母体脏 profile，v1 行为保留在显式配置下 |
| 缺 node_modules 的 warning `node-modules-missing` | clean 模式断言 `node-modules-source-missing`（契约原文），legacy 模式保留旧 warning | 契约 §5.5 明确新 warning 名 |
| `apply(...)` 无 roleGate 断言 | 新增 roleGate 用例（fork 下不注册/不建目录）；原注册用例增加 `role:'mother'`、新增方法、不写 ports.json 断言 | §1/§8 硬要求 |
| buildSpawnArgs 默认 | 保持 `--port 0` 断言不变，新增 `--port 18042` 断言 | v1 兼容 |
| 其余 spawn timeout/crash/limit/reap/persist/dispose/audit 断言 | **原样保留**（补充少量端口释放断言） | v1 行为未变 |

---

## 8. 降级点 / NOT ESTABLISHED

1. **`dataRoot` 为空时 ports.json 不落盘**（端口表仅进程内存，注册表同 v1 策略）。生产要跨进程持久化，需要 loader 行给 forker 配 `dataRoot`（或由 Lead 决定 forker 复用 `layout.dataDir` 的默认路径）。当前实现**不**自动写 `$DSH_HOME`：避免测试/多实例污染真实 profile。这是有意的降级，已在报告显式标注。
2. **探活—预留不是原子跨进程锁**：两个母体实例共享同一 dataRoot 同时分配同一端口时存在 TOCTOU 窗口（`listen` 检测 → 写表之间）。单实例内无此问题（内存表即锁）；跨进程靠“启动回收 + 存活 pid 占位”收敛，未做文件锁（零依赖约束下未引入）。契约未要求多母体并发，标为 NOT ESTABLISHED。
3. **显式 `opts.port` 只查占用表、不做 OS bind 探测**：调用方给了端口即视为“我要用它”；真实是否被系统占用由子进程启动失败/URL 端口校验兜底。契约只要求池分配端口做 bind 测试。
4. **port-mismatch 是硬失败、不自动换端口重试**：契约要求 stop + 错误返回；重试策略留给上层 Orchestrator（其 `createTask` 会把任务记 FAILED）。
5. **干净模板按“每个 fork home 一份”生成**（`<homeDir>/templates/<forkProfileTag>`），不做全局缓存。好处：reap 时随 home 一起安全删除、零跨任务耦合；代价：每次 provision 多写 3 个小文件 + 1 个 junction（成本可忽略）。未在真实 dsh 上验证该 profile 能启动（契约禁止测试 spawn 真实 dsh）。
6. **`process.kill(pid,0)` 的 Windows 语义**：pid 复用理论上会让“已死 malloc”看起来存活（回收被推迟到 pid 再次消失）。启动回收只在首次端口操作时做一次，不是常驻巡检。
7. **`stop()` 释放端口但保留 record.port 历史值**（诊断用）；恢复后的 stopped 记录不再持有端口表条目（表由 pid 存活性兜底）。
8. **forker 与 orchestrator 都写 `<dataRoot>/forks.json` 的潜在双写**（Lead/orchestrator v2 集成问题，非 T7 写域）：forker 的注册表格式是 `{at, forks:[…]}`，orchestrator 写 `{version:2, at, forks:[…]}`，同 dataRoot 同时启用时后者会覆盖前者。v1 既有行为，未在本任务改动；建议 Lead 在集成时决定：forker 不配 dataRoot（由 orchestrator 独占注册表），或两边拆文件名。已同步 Lead。

---

## 9. 给 Lead 的集成建议（只建议，未越界修改）

1. `cordis.patch.yml` 的 `fang-forker` 行建议显式补上 v2 字段（默认值即可省略，但显式更可读）：
   `portPool:{start:18000,end:18100}`、`allocatePorts:true`、`cleanTemplate:true`、`bundleName:'@local/dsh-fang'`、`forkProfileTag:'web-base'`；若要让 `ports.json`/`forks.json` 跨进程持久化，再补 `dataRoot`（见 §8.1/§8.8 的双写风险）。
2. compose 模式（Lead 的 `src/compose.mjs`）无需改动：`forker` 子配置原样透传，新增字段自动生效。
3. 编排器 `createTask` 传的 `env` 里已有 `DSH_FANG_ROLE/DSH_FANG_TASK_ID`，与 forker 注入值一致（forker 先注入、调用方后覆盖，语义不变）。
4. 若 Lead 的全量集成测试对 forker 的 `allocatePort()` 按同步返回值使用，需要 `await`（本任务硬要求为异步探活）；契约 §5.5 的 `-> {}` 展示为返回形状，不代表同步。
