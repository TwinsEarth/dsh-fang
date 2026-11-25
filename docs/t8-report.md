# T8 报告 — 容器执行器 + 申报写代理

> 仓库：`dsh-fang` ｜ 版本：`@local/dsh-fang` **2.0.0** ｜ owner：`t8-container`
> 契约依据：`docs/CONTRACTS-V2.md` §1（角色门禁）/ §5.6（Container + BufferKeeper 追加）/ §7（测试与验收）/ §8（完成定义）
> 实现环境：Windows 11 + Node **v24.16.0**，ESM，零第三方依赖；真实容器为 AppContainer（`dsh-worker` 持久身份）

---

## 1. 验收命令与真实输出（2026-11-01 本机最后一次运行）

### A) 两个新测试文件（缺省不跑真实容器；live 用例 skip 并打印原因）

```powershell
cd dsh-fang
node --test test/container-proxy.test.mjs test/container-host.test.mjs
```

```
﹣ LIVE container probe (manual): real AppContainer exec when FANG_CONTAINER_LIVE=1 # manual live probe: set FANG_CONTAINER_LIVE=1 to run
ℹ tests 20
ℹ pass 19
ℹ fail 0
ℹ skipped 1
```

### B) v1 既有 buffer-keeper 测试（必须保持绿：实际 10/10）

```powershell
node --test test/buffer-keeper.test.mjs
```

```
ℹ tests 10
ℹ pass 10
ℹ fail 0
```

### C) 真实容器手动探针（`FANG_CONTAINER_LIVE=1`，不是缺省测试）

```powershell
$env:FANG_CONTAINER_LIVE='1'
node --test test/container-host.test.mjs
```

```
✔ LIVE container probe (manual): real AppContainer exec when FANG_CONTAINER_LIVE=1 (1823.0401ms)
ℹ tests 9
ℹ pass 9
ℹ fail 0
ℹ skipped 0
```

真实链路证据（同一 live 用例的手动复跑日志，`pid` 每次不同）：

```
stdout: codeLen=349 codeFile=C:\Users\...\fang-container-XXXX\code.js
        launch=OK pid=13412 exit=0 out=277
res.writes[0] = {op:'write', reqId:'live-w1', path:'plug/live.txt', ok:true, applied:true,
                 target:'...\buffer\plug\live.txt', bytes:14}
res.writes[1] = {reqId:'live-w2', path:'other/evil.txt', ok:false, reason:'not-declared'}
res.writes[2] = {reqId:'live-w3', path:'../escape.txt',  ok:false, reason:'dotdot-segment'}
落盘文件内容: 'from-container'（宿主校验后由宿主写入，容器本身没有 buffer 写权限）
```

即：**真实 AppContainer 内执行 Node 代码 → 代码只能“上报”写请求 → 宿主按申报清单校验 → 宿主原子写入 bufferRoot** 的端到端链路已实测通过；未申报/越界请求被拒绝且未产生文件。

### D) 全量（`node --test --test-concurrency=1 "test/*.test.mjs"`）

本任务交付时为 **205 tests / 196 pass / 3 fail / 6 skipped**；3 个失败全部是外部在途项，与 T8 无关：

| 失败项 | 原因 | 归属 |
|---|---|---|
| `plugin shape + role matrix: adapter` | `src/plugins/adapter.mjs` 尚不存在 | T5 在途 |
| `compose mode mounts every plugin…` | `src/compose.mjs` 静态 import 上述缺失文件 | 等 T5 落地后自动恢复 |
| `package exports + bundle patch reference every row` | `package.json` 的 `exports["./adapter"]` 指向未落地文件 | Lead 收口 |

T8 相关的每个测试文件单独跑均全绿（见 A/B/C）；v1 其余既有测试保持绿。

---

## 2. 交付文件

| 文件 | 行数 | 断言/用例 | 性质 |
|---|---:|---|---|
| `src/lib/container/index.mjs` | 804 | 6 个契约导出 + 2 个辅助导出 | 新建 |
| `probes/AppContainerHost.cs` | 508 | — | 复制（ASCII 化注释） |
| `probes/container-exec-pipe.ps1` | 49 | — | 复制（字节一致） |
| `probes/worker-pipe-exec.mjs` | 36 | — | 复制（ASCII 化注释） |
| `probes/duplex-channel-test.ps1` | 36 | — | 复制（字节一致） |
| `src/plugins/buffer-keeper.mjs` | 519 | — | **仅追加** proxy 能力 + roleGate 首行 |
| `test/container-proxy.test.mjs` | 482 | 123 条 `assert.*` / 11 个 test | 新建（硬约束 ≥15 断言） |
| `test/container-host.test.mjs` | 293 | 88 条 `assert.*` / 9 个 test（1 个 live 默认 skip） | 新建 |

`src/lib/container/index.mjs` 导出（严格对齐契约 §5.6）：

```js
createContainerHost({ powershellPath='powershell.exe', probeDir, timeoutMs=30000, execFileImpl })
  -> { state:'disabled'|'unavailable'|'ready', available(), async exec({code,env,declaredWrites,timeoutMs}), dispose() }
validateWriteRequest({ bufferRoot, declared, req, maxBytes? }) -> { ok, target?, path?, reason? }
applyWriteRequest({ bufferRoot, declared, req, fsx?, maxBytes? }) -> { ok, target?, bytes?, reason? }
encodeFrame(obj) -> string
parseFrames(buffer) -> { frames, rest, errors }
WRITE_PROXY_OPS = Object.freeze(['write','ping','stat'])
// 辅助导出（非契约，供 buffer-keeper/测试复用）：
normalizeDeclared(declared) -> [{path, reason}]
DEFAULT_MAX_BYTES = 1048576
```

---

## 3. 覆盖点

### 3.1 写代理安全（对硬要求逐条）

| 硬要求 | 实现 | 测试断言 |
|---|---|---|
| 规范化（`path.resolve`）后必须落在 `bufferRoot` 内 | 先相对路径规范化，再 `path.resolve(rootAbs, rel)`，用 `path.relative` 判定 `isInside`（Windows 大小写不敏感比较） | `applyWriteRequest…` / `declared manifest…` |
| 拒绝 `..` | 在 `path.posix.normalize` **之前**按 `/`、`\` 切段，任何 `..` 段直接 `dotdot-segment`（含 `..\`、`plug/../../x`） | 6 条 |
| 拒绝绝对盘符 | `C:\x`、`C:x`（盘符相对）→ `absolute-path`；POSIX `/etc/passwd` 同拒 | 3 条 |
| 拒绝 UNC / `\\?\` | `\\server\share`、`//server/share`、`\\?\C:\…`、`\\.\pipe\…` → `unc-path` | 4 条 |
| 拒绝 junction/symlink 逃逸 | 校验父链：对 root 之下的每一级已存在目录 `lstat`，`isSymbolicLink()` → `symlink-ancestor`；再 `realpath` 校验仍落在 `realpath(root)` 内 → `realpath-escape`；目标本身是链接 → `symlink-target` | 真实 junction 用例：拒绝且 junction 目标目录**未**被写入/未被改动 |
| 必须命中 declared 申报名单（前缀匹配） | `normalizeDeclared` 规范化（支持 `{path,reason}`/字符串、`\`→`/`、去尾斜杠、丢弃非法项）；边界感知前缀：`plug` 命中 `plug` 与 `plug/x`，**不**命中 `plugin/x` | 9 条（exact/descendant/backslash/single-file/前缀边界/未申报/非法申报丢弃） |
| 单请求 ≤ maxBytes（默认 1MB） | `DEFAULT_MAX_BYTES=1048576`；解码后按**字节数**校验；base64 先按 `2×maxBytes+4` 预检避免大分配，再严格 base64 字符集校验 | 10 条（10B 阈值两侧、1MiB±1、base64、bad-encoding、bad-base64） |
| 真写临时目录 | `applyWriteRequest` 实际写盘：utf8 嵌套目录、base64 二进制逐字节、优先调用注入的 `fsx.writeFileAtomic`（kernel 原子写）、非法请求不产生文件 | 8 条 |
| NDJSON 分帧 | `encodeFrame` 单行 + `\n`；`parseFrames` 支持 string/Buffer、chunk 半帧（返回 `rest`）、CRLF、空行、垃圾行（进 `errors` 不抛）、非对象 JSON | 11 条 |
| buffer-keeper proxyWrite 只写 bufferRoot 内且审计 | `validateWriteRequest`（同一套安全规则）→ `applyWriteRequest`（kernel `writeFileAtomic`）→ 拒绝审计 `AUDIT.ROUTE`、成功审计 `AUDIT.BUFFER_FLUSH`；内存 `proxyLog` 环形 200 条；auditor 抛错不阻塞写 | 24 条 |
| 其它代理约束 | `proxyWrite` 在 `enabled=false` → `proxy-disabled`；无 bufferRoot（未 start 且 cfg.root 空）→ `no-buffer-root`；未 start 时回退 `cfg.root` 模式；`setDeclared` 非数组 → `{ok:false,reason:'bad-declared'}`；dispose 清空申报与日志 | 12 条 |

补充安全细节：相对路径中的 `\0` → `bad-path`；Windows 备用数据流 `file.txt:stream` → `ads-path`；`bufferRoot` 为空 → `no-buffer-root`；目标为已存在目录 → `target-is-directory`。

### 3.2 BufferKeeper v2 追加（契约 §5.6，只追加）

- **`apply` 首行**：`const gate = roleGate('bufferKeeper', { cfgRole: config?.role, logger: ctx?.logger }); if (!gate.active) return undefined`
  （MATRIX 中 bufferKeeper 仅 fork；mother 角色不注册服务/不建 watcher。测试：mother → `ctx.get(fangBuffer)===undefined`；fork → 注册成功）
- `Config` 追加 `proxy: z.object({ enabled: z.boolean().default(false), maxBytes: z.natural().default(1048576) }).default({})`
- `service` 追加（v1 方法原样保留）：
  ```js
  proxyState() -> { enabled, bufferRoot, declaredCount }
  setDeclared(declared) -> { ok, count, reason? }
  proxyWrite(req) -> { ok, target?, bytes?, reason? }
  proxyLog({limit=20}) -> entries[]   // 最新在前
  ```
- `service.config` 仍返回 v1 配置 + `proxy`；`_internals` 追加 `PROXY_DEFAULTS/PROXY_LOG_LIMIT`
- disposer 追加清理 `declaredWrites`/`proxyEntries`（不改变 v1 disposer 语义）

v1 方法（`start/stop/state/flush/scan/baseline`、`dir/mode/config`）签名与行为未改动；`test/buffer-keeper.test.mjs` 10/10 绿。

### 3.3 ContainerHost

- 三态探测：非 Windows → `disabled`；Windows 但 `probes/` 缺文件 → `unavailable`+`probe-missing:<files>`；PowerShell 不在 PATH/指定路径不存在 → `unavailable`+`powershell-not-found:*`；否则 `ready`+`preflight-ok`。**任何探测失败都不抛异常**（含 `options=null`、非法参数）。
- `exec({code, env, declaredWrites, timeoutMs})`：写临时 code 文件 → `execFile(powershellPath, ['-NoProfile','-ExecutionPolicy','Bypass','-File', probeDir/container-exec-pipe.ps1, '-CodeFile', …, '-ResultFile', …, '-TimeoutSec', …])` → 读 ResultFile（缺失则回退 stdout 最后一行 JSON）→ 收集 NDJSON/`result.writes` 帧 → `write` 帧走申报校验（可注入 `writeApplier` 实际落盘）/`ping` 直接回 pong/`stat` 只做安全路径检查 → 返回 `{ok, stdout, stderr, exitCode, writes, result?, error?}`。
- 超时：原生 `timeout`+`killSignal:SIGKILL`，另有 `timeoutMs+250ms` 兜底计时器（注入的 runner 永不回调时也会 kill 并返回 `{ok:false,error:'timeout'}`）；空 code 不 spawn；`dispose()` 幂等且之后 `exec` fail-closed。
- 单测仅覆盖降级/注入路径，**不真进容器**；真实路径只有 `FANG_CONTAINER_LIVE=1` 手动用例。

---

## 4. probes/（仅 4 个文件，全部 ASCII）

| 文件 | 处理 |
|---|---|
| `AppContainerHost.cs` | 复制；**22 处中文注释译为英文 ASCII**，代码体逐字节等价（去除注释后比较 `code-equal=True`） |
| `container-exec-pipe.ps1` | 逐字节一致（原本即 ASCII） |
| `worker-pipe-exec.mjs` | 复制；2 处注释 ASCII 化（含一个 em dash），代码体等价 |
| `duplex-channel-test.ps1` | 逐字节一致（原本即 ASCII） |

验证：4 个文件 `nonAscii=0`；均无 BOM；`$here`/`Join-Path $here` 本就相对脚本目录，新仓库内无需改路径。
说明：`duplex-channel-test.ps1` 引用的 `worker-duplex.js` **不在任务指定的 4 个复制文件内**，故未复制；该脚本仅作手工实验参考（见 §6 NOT ESTABLISHED），v2 实际执行通道是 `container-exec-pipe.ps1` + `worker-pipe-exec.mjs`（两者已复制，live 用例已跑通）。

---

## 5. 与契约的对齐清单

- §1：`bufferKeeper` 严格 roleGate（首行）；`src/lib/container` 无 `DSH_FANG_ROLE` 依赖，由调用方（router/buffer）决定。
- §5.6：6 个导出签名/返回字段按契约；`WRITE_PROXY_OPS` 冻结数组；Config/服务追加字段按契约；v1 方法未动。
- §7：不 spawn 真实 dsh、测试缺省不真进容器；live 开关 `FANG_CONTAINER_LIVE=1`；每个新测试文件断言数远超 ≥8；报告 `docs/t8-report.md`。
- §8：全部文件 `node --check` 通过；不写 profile、不改他人文件、零第三方依赖。

---

## 6. 降级点 / NOT ESTABLISHED（不夸大）

| 项 | 状态 | 说明 |
|---|---|---|
| `state:'ready'` 的语义 | **静态预检**，非容器可用性 | 只证明 `probes/` 三件套存在 + PowerShell 可解析；真实可用性由 `FANG_CONTAINER_LIVE=1` 手动用例证明（本次本机已通过） |
| 环境变量进容器 | NOT ESTABLISHED | `exec` 会把 `env` 合并进 PowerShell 子进程环境，但 C# `CreateProcessW` 是否把它传进 AppContainer worker 未实测；申报清单通过 `result.writes` 协议传递（已实测），不依赖容器内 env |
| 容器内任意 stdout 行 | 部分成立 | `container-exec-pipe.ps1` 只把 stdout **最后一行**写入 ResultFile，中间行丢弃；因此写请求走 `result.writes`（已实测），宿主侧 NDJSON 解析主要用于注入式测试与宿主协议验证 |
| junction/realpath 检查的 TOCTOU | 已知接受 | 校验与写入之间父链可能被换链（单进程宿主、bufferRoot 由宿主创建，风险低）；未做句柄级（`FILE_FLAG_OPEN_REPARSE_POINT`/`O_NOFOLLOW`）写 |
| 不存在的父目录 | 无逃逸可能但未预创建 | 父链检查只覆盖"已存在"的级；写入时由 `ensureDir`/kernel fsx 递归创建（无法用链接预先占据不存在的路径） |
| 声明匹配大小写 | 有意严格 | 前缀匹配大小写敏感（Windows 上偏严不偏松，不会形成绕过） |
| `duplex-channel-test.ps1` | 参考资产，未接线 | 缺 `worker-duplex.js`（不在 4 文件清单内），v2 不依赖 |
| 并发容器执行 | 每次 exec 独立进程 | 无 worker 池/多路复用；单次实测约 0.9–2s（含 PowerShell Add-Type） |
| 出站网络/读隔离 | 沿用旧仓库实测结论 | 本次未重复验证（不在 §5.6 交付范围）；旧资产文档 `读取隔离-已落地实测.md` 记录 EPERM |
| 全量测试 | 3 个外部在途失败 | adapter.mjs 未落地（T5）；与 T8 无关，见 §1.D |
