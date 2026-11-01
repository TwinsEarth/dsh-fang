# T1 报告 — fang-forker / fang-auditor / fang-buffer-keeper

> 版本：`@local/dsh-fang` 1.0.0 · T1 owner：`t1-forker-audit`
> 契约依据：`docs/CONTRACTS.md` §5.1 / §5.2 / §5.3 / §6 / §7
> 实现环境：Windows 11 + Node v24.16.0，仓库 ESM、零外部依赖，测试仅 `node:test` + `node:assert/strict`
> 结论：**三个子插件 + 三份测试全部完成并通过验收命令；未改任何 owner 之外的文件。**

---

## 1. 验收命令与真实输出

```powershell
cd dsh-fang
node --test test/forker.test.mjs test/auditor.test.mjs test/buffer-keeper.test.mjs
```

真实输出（2026-11-01，本机最后一次运行）：

```
ℹ tests 36
ℹ pass 36
ℹ fail 0
ℹ duration_ms 6017.8976
```

分文件（同一命令逐文件跑）：

```
test/forker.test.mjs         tests=15 pass=15 fail=0
test/auditor.test.mjs        tests=11 pass=11 fail=0
test/buffer-keeper.test.mjs  tests=10 pass=10 fail=0
```

附加验证：

- `node --test test/plugins-shape.test.mjs` → 12/12 pass（Lead 的装载形状验收，含 forker/auditor/buffer-keeper 三个服务 key）。
- compose 式挂载冒烟：`ctx.plugin(auditor,{dataRoot})` + `ctx.plugin(forker,{})` + `ctx.plugin(bufferKeeper,{})` 一次上下文内三个服务都可 `ctx.get`，`append → bootCheck → start/flush` 全链路通过（临时目录，跑完删除）。
- `apply(makeCtx())` 三个插件均不抛错、不写盘；`ctx.dispose()` 后服务均被注销（plugins-shape 断言）。

---

## 2. 交付文件（路径 · 行数 · 断言数 · 主路径覆盖）

断言数为测试文件中 `assert.*` 语句数（`Select-String 'assert\.'`）；循环内断言的**实际执行次数更多**，远超每文件 ≥8 的硬约束。

| 文件 | 行数 | 断言语句 | 主路径覆盖 |
|---|---:|---:|---|
| `src/plugins/forker.mjs` | 634 | —（实现） | provision / spawn / stop / reap / status / list / logs；`.cmd`-`shell:true` / `.exe` 直启 / `.mjs` 走 node；timeout kill；`classifyExit`；事件；注册表持久化；dispose 清理 |
| `src/plugins/auditor.mjs` | 242 | —（实现） | append（链式 at/seq/inst）/ read / verify / bootCheck（unclean-boot + interrupted-in-guard）/ ledgerFile；失败不抛、坏链拒写 |
| `src/plugins/buffer-keeper.mjs` | 356 | —（实现） | start/stop/state/flush/scan/baseline；watch 与 poll 两模式；settled/writing/pending-high-risk 三态；flush 静默归 Settled、持续写即超时；disposer 收 watcher+定时器 |
| `test/forker.test.mjs` | 629 | **176** | 模块形状；纯函数（buildSpawnArgs/classifyExit/parseWebUrl/isShellLauncher/buildLaunchSpec）；provision 克隆范围+junction+幂等+失败/降级；spawn happy（token URL/env/argv/事件/滚动缓冲/拆包 banner）；timeout；crash/75 退出；already-running/max-forks/spawn-error；reap 的 junction 安全；dataRoot 注册表跨实例恢复；dispose 取消 in-flight spawn 并杀子进程；audit 容错（正常/抛异常）；fixture 扫描安全 |
| `test/auditor.test.mjs` | 316 | **87** | 形状/默认配置；apply 只读；append 链（seq/prevHash/hash/at/inst、data 覆盖、空 kind 拒绝）；read limit/坏行跳过；verify 完好+中段篡改定位 firstBadSeq；坏尾拒写；bootCheck 空账本/自我记录过滤/由 kernel 直写的“上次运行”unclean-boot/干净收尾/restart 未 resolved 两类 findings/跨实例语义；bootSelfCheck:false |
| `test/buffer-keeper.test.mjs` | 385 | **105** | 形状/默认配置；未 start 时全部方法降级；start/stop 幂等与模式；watch 检测+scan 基线 diff；静默→pending-high-risk+高风险文件识别；flush 静默归 settled/事件/审计/修改/删除/空 flush；持续写 flush 超时→pending-high-risk；`watch:false` 轮询降级；disposer 关闭 watcher+冻结状态；audit 缺失/抛异常容错；并发 flush 串行化 |
| `test/fixtures/t1/fake-dsh-cli.mjs` | 56 | — | 假 CLI（**绝不 spawn 真 dsh**）：`ok`/`split`/`silent`/`crash`/`restart`/`exit-clean` 六种模式；无 `--profile` 时立即退出（防 `node --test` 扫描 fixture 挂死） |
| `test/fixtures/t1/mother-profile/{package.json,cordis.patch.yml,README.md,node_modules/mother-dep.txt}` | — | — | provision 的母版 profile 素材：`package.json`+`cordis.patch.yml` 必须被克隆，`README.md` 必须不被克隆，`node_modules` 必须走 junction 且 reap 不碰母版 |

写域自检：本次只写上述文件 + 本报告；`package.json` / `cordis.patch.yml` / `src/kernel/**` / `src/plugins/{scorer,healer,router,approver,hot-reloader,restart-guard,orchestrator}.mjs` / `test/helpers.mjs` / `client.js` 均未改动。

---

## 3. 服务契约实现对照

### 3.1 `fang-forker`（§5.1）

```js
provision({forkId, taskTitle, homeDir, profile, profileTemplate})
  -> {ok, forkId, homeDir, profileDir, bufferDir, profile, cloned[], node_modules, warnings[]}
spawn({forkId, homeDir, profile, cliPath, env?, timeoutMs?})
  -> Promise<{ok, forkId?, pid?, port?, url?, token?, error?, ...}>
stop(forkId)   -> {ok, forkId, pid, killed, alreadyStopped}
reap(forkId)   -> {ok, removed, homeDir}                 // stop + removeTree(homeDir) + 注册表删除
status(forkId) -> {running, pid, status, url, port, token, exit, ...}
list()         -> [{forkId, pid, running, startedAt, status, homeDir, profile, ...}]
logs(forkId, tailLines=40) -> string                     // stdout+stderr 滚动缓冲（默认 400 行上限）
```

纯函数导出（可直接单测，不落盘不启动进程）：

- `parseWebUrl`：复用 kernel（现为 `{url, port, token}`，无 `?token=` 返回 `null`）。
- `buildSpawnArgs({profile})` → `['--profile', '<profile>', '--port', '0', '--no-open']`。
- `classifyExit(code, signal?)` → `{kind:'normal'|'restart-request'|'crash', code, signal, restartRequested}`（0 normal / 75 restart-request / 其它 crash）。
- `isShellLauncher(cliPath)` / `buildLaunchSpec({cliPath, profile})`（Windows 启动形态，见 §4）。
- 事件（kernel `bus`）：`fang/fork-started {forkId,pid,port}`、`fang/fork-crashed {forkId,code,kind}`、`fang/fork-reaped {forkId}`。
- 跨插件审计：`FORK_CREATED/FORK_STARTED/FORK_CRASHED/FORK_REAPED`，通过本地 `safeGet(ctx,'fangAudit')` + 可选链 + try/catch；auditor 缺失或抛异常都不影响派生生命周期（已测）。
- `config.dataRoot` 非空时注册表持久化到 `<dataRoot>/forks.json`；`apply()` 不读不写（懒加载），进程重启后恢复的行一律 `running:false`（无 child 句柄）。行形状与 `docs/ARCHITECTURE.md` 的 `forks.json` 说明一致（`{forkId,pid,port,url,homeDir,profile,status,createdAt}`，另附 `running/exitedAt/exit` 等运行时字段）。
- 插件 disposer：kill 所有 running child + 取消在途 spawn（promise 以 `{ok:false,error:'disposed'}` 结束），不留孤儿进程（已测）。

### 3.2 `fang-audit`（§5.2）

```js
append(kind, data) -> record|null     // 自动 at/pid/seq/prevHash/hash/inst；kind 空或账本不可信 → null
read({limit=100})  -> record[]        // 坏行跳过，不抛
verify()           -> {ok, records, firstBadSeq, badIndex, reason, expected, actual}
bootCheck()        -> {ok, findings:[{id,level,message,detail}], records, previous, pid}
ledgerFile         -> 属性（默认 <dataDir>/audit.jsonl；可用 cfg.ledgerFile 覆盖）
```

- 哈希链完全走 kernel `appendChained` / `verifyChain` / `GENESIS`，本插件不自造链格式。
- `bootCheck` 两类 findings：`unclean-boot`（上次运行最后一条不是 `shutdown-graceful`）、`interrupted-in-guard`（restart requested/committed 之后没有 `restart-resolved`），`level` 均为 `'warn'`。
- 「上次运行」判定用实例标记 `inst`：本次实例写下的记录带本实例 id，bootCheck 一律排除；因此不需要时间戳窗口启发式（同毫秒两次启动也不会误判）。其余带可解析 `at` 的历史记录全部参与判定（kernel 的 `boot-verify` 无 `at`，与原 restart-guard 一样跳过）。
- 失败策略（fail-closed）：`verify()` / `bootCheck()` 一旦发现链损坏，本实例后续 `append()` 一律返回 `null` 且不落盘（kernel `appendChained` 只拒绝“尾部不可解析”，中段篡改要靠 verify/bootCheck 先发现——建议 orchestrator 在启动早期调用 `bootCheck()`）。
- 事件：无（审计是同步落盘事实，不额外发事件）。
- `bootSelfCheck:true` 时 `apply()` 只做**只读**自检并把结果放在 `service.lastBoot`；不写盘、不追加 boot 记录（boot 记录应由 orchestrator 显式 `append(AUDIT.BOOT, ...)`）。

### 3.3 `fang-buffer`（§5.3）

```js
start({dir})          -> {ok, dir, mode:'watch'|'poll', already?}   // dir 空 → {ok:false,error:'no-dir'}
stop()                -> {ok, dir}
state()               -> {state:'settled'|'writing'|'pending-high-risk', dir, lastEventAt, pending[], highRisk[], mode, ...}
flush({strictMs})     -> Promise<{state, dir, flushed[], timedOut, pending?, hardMs?}>
scan()                -> {dir, digests, changed[], added[], removed[], same, count, baselineCount}   // 与 baseline() 比对
baseline()            -> {ok, dir, count, at}
```

三态语义（实现自定，已用测试钉死）：

- `settled`：自上次 flush 以来 `settledDigests` 无差异；
- `writing`：有差异且距最后一次变更事件 < `settleMs`（写入方仍在活动）；
- `pending-high-risk`：有差异且已静默 ≥ `settleMs`（改动已落盘但尚未 flush），或 flush 在持续写入下超时放弃（`forcedHighRisk`）。`highRisk` 子集额外标出 `package.json` / `cordis*.ya?ml` / `.env*`。
- `flush` 在“静默 ≥ strictMs（缺省 = settleMs）”后把 `settledDigests` 推进到当前树，返回 `flushed` 并 emit `fang/buffer-settled {dir, changed}` + 审计 `AUDIT.BUFFER_FLUSH`；持续写入时在硬上限（`cfg.flushTimeoutMs`，0 表示自动 `max(4×strictMs, 250ms)`）后返回 `{state:'pending-high-risk', timedOut:true}`。并发 flush 串行化。
- 监视模式：`fs.watch(dir,{recursive:true})`；构造失败或 `error` 事件 → 自动退化 `pollMs` 轮询 `digestTree`（`watch:false` 可强制轮询，供测试/平台降级用）。
- 所有 watcher/定时器都在 `ctx.effect` disposer 里关闭（monkeypatch `fs.watch` 断言 `close` 恰好一次；轮询 timer 也随 dispose 清掉）。
- `apply()` 不自动开始监视（契约要求显式 `start({dir})`）；未 start 时全部方法安全降级。
- 跨插件审计同样经本地 `safeGet` 容错（缺失/抛异常不影响 flush，已测）。

---

## 4. 关键实现决策（Lead 关注的 Windows 点）

1. **`.cmd` 启动器**：Windows 上 `spawn('...dsh.cmd')` 直接 EINVAL/ENOENT，因此
   - `isShellLauncher(path)`：`.cmd`/`.bat` → true；
   - `buildLaunchSpec({cliPath, profile})` 返回 `{command, args, shell, windowsHide, nodeScript}`：
     - `.cmd`/`.bat` → `shell:true, windowsHide:true`（argv 仍是 `buildSpawnArgs` 的结果，交给 cmd 解析）；
     - `.mjs`/`.cjs`/`.js` → `command: process.execPath, args:[cliPath, ...buildSpawnArgs]`；
     - `.exe` 及其它 → 直接 spawn。
   - 测试覆盖三种形态的 argv/shell 形态（`.cmd` **只做纯函数断言、绝不真跑**，符合“测试不 spawn 真 dsh”的硬约束）；真实 `.cmd` 的端到端启动未在本仓库验证（见 §6）。
2. **kill 进程树**：`stop`/`timeout`/`dispose` 统一走 `taskkill /PID <pid> /T /F`（Windows），失败回退 `child.kill('SIGTERM')`；`stop` 返回 `{ok,pid,killed,alreadyStopped}`。测试用“进程是否真的消失”轮询断言。
3. **junction 安全**：`node_modules` 用 kernel `makeJunction` 指回母版；`reap` 用 kernel `removeTree`（reparse point 只 unlink 不进入），测试断言 reap 后母版 `node_modules/mother-dep.txt` 仍在。
4. **滚动缓冲**：`maxLogLines`（默认 400，契约写 360，按 task-1 的 400 行上限）行环形行缓冲 + 64KB 文本窗口；`parseWebUrl` 对“banner 被拆到多个 chunk”的 case 有专测；stdout+stderr 都扫描（banner 平台差异兜底）。
5. **fixture 扫描安全（踩坑后加固）**：裸 `node --test` 会把 `test/**`（含 fixtures）都当测试文件执行；假 CLI 原本常驻会挂死全量扫描。现在无 `--profile` argv 时立即 `exit 0`，并加了回归测试守住这一点。

---

## 5. 给 Lead / 其他 owner 的集成注意

1. **orchestrator 调用顺序**：`provision({forkId, taskTitle, homeDir, profile, profileTemplate})` → `await spawn({forkId, homeDir, profile, cliPath, env})` → UI 用返回的 `url`（已带 token，另有 `token` 字段）→ 结束 `reap(forkId)`。`bufferDir` 直接用 provision 返回值（规则 = `homeDir/fang/<profile>/buffer`），不要自行推导。
2. **parseWebUrl 已由 Lead 演进**为 `{url, port, token}` 且无 token 返回 `null`；forker 已适配，测试覆盖 token 形态。
3. **注册表落盘需要 config.dataRoot**：`cordis.patch.yml` 的 `fang-forker` 行目前没有 `dataRoot`，生产默认是“仅进程内注册表”（`forks.json` 不落盘）。若 orchestrator 需要跨进程恢复，请在 forker 行加 `dataRoot`（Lead 拥有该文件）或由 orchestrator 自己维护 forks 清单。
4. **bootCheck 建议早调**：auditor 行是 patch 第一行，orchestrator 在 `apply` 里尽早 `ctx.get(SERVICE.auditor)?.bootCheck()` 并把 findings 落 `AUDIT.BOOT` / UI 告警；晚于其他插件写审计记录也没问题（实例标记会排除本次运行记录）。
5. **buffer 需要显式 start**：建议 orchestrator/restart-guard 用 `SERVICE.buffer` 的 `start({dir})`/`flush()`/`state()`；不 start 时 `state()` 报 settled/空。
6. **kernel 缺 `safeGet`**：契约散文提到 `safeGet`，但 `src/kernel/index.mjs` 未导出；三个插件各自实现本地容错版（T2/T3/T4 同理）。若要统一，请 Lead 在 kernel 加 `safeGet(ctx,key)`（改动由 Lead 拥有）。
7. **`test/helpers.mjs` 的 `tmpDir()` 有 bug**：ESM 文件里用了 `require(...)`，调用会抛 `require is not defined`。T1 测试改用 `fs.mkdtempSync(os.tmpdir())`，未改 helpers；建议 Lead 修（改成顶部 import）。
8. **事件主题**：按 CONTRACTS §6 用字面量 `'fang/fork-started' / 'fang/fork-crashed' / 'fang/fork-reaped' / 'fang/buffer-settled'`（kernel `types.mjs` 目前无事件常量表；若后续加，改 import 即可）。

---

## 6. 降级点与 NOT ESTABLISHED（如实声明）

**降级（已实现，行为可接受但非理想）：**

1. `provision` 的 `profile` 名：优先用入参 `profile`（Lead 的 orchestrator 会传），未传时用 `basename(profileTemplate)`。`provision` 契约签名本身不带 `profile`，这是额外兼容字段。
2. 母版 profile 若没有 `node_modules`：provision 仍成功，`node_modules:null` + `warnings:['node-modules-missing']`（不替母版创建目录，保持母体只读）。
3. 无 `dataRoot` 时注册表仅进程内存（见 §5.3）；持久化恢复的行 `running:false`、`pid` 仅作展示（无法接管宿主重启前的子进程）。
4. `flush` 硬上限（`max(4×strictMs, 250ms)` 或 `cfg.flushTimeoutMs`）是契约未规定的实现自定语义，已文档化并用测试钉死。
5. `bootCheck` 跳过“无 `at` 的记录”（如 kernel `verifyAndAppendBoot` 写的 `boot-verify`），纯此类记录的账本不会产生 unclean 判定——与参考实现 `restart-guard` 的过滤规则一致。
6. `auditor.append` 的拒写只在“尾部不可解析”或“本实例已通过 verify/bootCheck 发现链损坏”时生效；中段篡改若从未调用 verify/bootCheck，单次 append 仍可续写（kernel `appendChained` 语义）。
7. 跨插件审计调用不做重试：auditor 抛异常时该条审计直接丢弃（不允许审计故障阻塞派生/缓冲）。
8. 所有安全兜底（safeGet、try/catch）在本层实现，不依赖宿主保证。

**NOT ESTABLISHED（未验证，需 Lead/现场验收）：**

1. **真实 `dsh web` 端到端**：全程只用假 CLI（硬约束）。真实 `<DSH_INSTALL>\resources\runtime\cli\bin\dsh.cmd` 经 `shell:true` 启动、`taskkill /T /F` 杀 electron 子进程、真实 token banner 的行形态，均未在本仓库实测。
2. `.cmd` 的 `shell:true` 分支只有纯函数断言，没有真正触发 cmd.exe（避免在测试环境启动真实 dsh）。
3. 跨宿主进程的 fork 接管/恢复：只验证了注册表 JSON 能读回，未验证宿主重启后对残留子进程的处理策略（当前按 `running:false` 保守处理）。
4. `fs.watch(recursive:true)` 在非 Windows 平台（Linux/macOS 网络盘、无 recursive 支持的 FS）的自动退化只通过 `watch:false` 强制轮询路径覆盖，未在真实降级触发场景验证。
5. boot 自检与真实宿主启动流程的接线（谁在何时调用 `bootCheck`、findings 如何进 UI/审批）属于 orchestrator，未在本层验证。
6. `buffer-keeper` 与 restart-guard/approver 的联动（“dirty buffer 影响重启审批/impact”）只有服务接口，无跨插件联调测试（T4/T3 owner 负责接线）。
7. `fangForker.provision` 对超长路径/只读母版/ACL 拒绝等 Windows 边角失败只返回 `{ok:false,error}`，未做专门故障注入测试。

---

## 7. 复现清单

```powershell
cd dsh-fang
node --test test/forker.test.mjs test/auditor.test.mjs test/buffer-keeper.test.mjs   # 36/36 全绿
node --test test/plugins-shape.test.mjs                                               # 12/12 全绿（Lead 验收）
```

测试全程：临时目录 `fs.mkdtempSync(os.tmpdir())`，结束用 kernel `removeTree` 清理；forker 子进程全部由插件 disposer/显式 stop 杀掉；无外部依赖、不写真实 profile/母版目录。
