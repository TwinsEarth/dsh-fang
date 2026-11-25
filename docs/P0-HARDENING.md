# v3.8.3 P0 加固：Job Object、旧 workspace 映射、托管浏览器拒绝回退

> 本文只记录可复现的实现与证据。未在真实 DSH 宿主上跑过的项目会明确写“待真机”；
> 不把单机/synthetic 测试冒充宿主级验证。

## P0-1 Windows Job Object：宿主冻结也杀整棵子树

**问题**：旧实现只按 PID 树 / `taskkill /T` 回收。宿主进程被冻结或 `TerminateProcess`
时，母体线程不再执行清理，fork 的子进程和孙进程能继续存活。

**实现**：

- 新增 `native/win32/fang-job-host.c`，产出 `fang-job-host.exe`（x64）与
  `fang-job-host-arm64.exe`。无第三方运行时依赖。
- helper 创建 Job Object，设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`；
  `CreateProcessW(..., CREATE_SUSPENDED)` 启动 fork host，
  `AssignProcessToJobObject` 后才 `ResumeThread`。子进程在创建任何后代之前已入 Job。
- helper 持有唯一 job handle。helper 退出/被强杀 → handle 关闭 → 内核杀整棵 Job。
- helper 同时监控宿主进程 handle 与心跳文件；宿主退出或心跳过期 → `TerminateJobObject`。
- `src/lib/job-object.mjs`：架构精确 helper 解析、argv、ready 文件解析。
- `src/plugins/forker.mjs`：win32 启用 Job；helper 缺失时返回
  `job-object-unavailable` 的 fail-closed，不退化裸 `spawn`；ready 后把 UI/watchdog
  的 PID 从 wrapper 改成真实 fork host PID。
  helper 已启动但 `CreateProcessW`/Assign/Resume 失败时，按 ready 文件的
  `create-process-failed` 等错误返回 `spawn-error`，不再误报普通 `exited`。
- `src/plugins/orchestrator.mjs`: 每 15s 写 `watchdog-<pid>.heartbeat`；
  watchdog JSON 记录 `heartbeatFile`。

**证据（Windows 真机 HSD，DSH 自带 Node 24）**：

- 真实 forker + helper + fake fork host（含孙进程）：
  `test/job-object-integration.test.mjs` → **1/1 pass**。
  只 `process.kill(helperPid)`，不执行 `taskkill /T`，2s 后 fork child 与 grandchild
  都为 dead，证明 `KILL_ON_JOB_CLOSE` 生效。
- `test/forker.test.mjs` 在 Windows + `DSH_FANG_JOB_OBJECT=1` → **29/29 pass**。
- 最终 v3.8.3 代码的 Windows P0 组合（job/集成/workspace/browser-refusal/browser-guard/forker）→ **53/53 pass**；VM 同组合 52 pass / 1 skip（非 Windows 跳过集成）。
- 单 helper 测试（TOFUTURE）：helper PID 6748 / child 12804；只杀 helper 后 child 消失。
- Linux 下 helper 不参与，集成测试按平台 skip；不把 skip 当通过。

## P0-2 旧 workspace 映射到各 fork home

**问题**：v3.8.2 只让新数据写新根；旧 fork home 的 `storages/workspace.json` 和
session header 仍指向 `E:\DSH\DS`，打开旧 fork 会继续混用共享目录。

**实现**：

- `src/lib/workspace-mapping.mjs`：
  - 精确 Windows 分段匹配 `E:\DSH\DS`、`E:\DSH`、`E:\DS`、`D:\DSH\DS` 等；
  - 映射目标 `<fork home>\workspace\legacy\drive-E\DSH\DS`；
  - 写 `.fang-workspace-map.json`（`mode=redirect-only`），不复制、不删除旧 workspace；
  - `migrateForkWorkspace(homeDir)` 改写 `workspace.json`、移动 Fang 自有 session 目录、
    只重写多帧 zstd 的第一帧 header cwd，事件帧字节不动；写 `_workspace-map/mappings.json`
    和 workspace.json 备份；可回滚、幂等；
  - `prepareImportedSession` 用于新导入：先映射路径，再改写复制过来的 session header。
- `src/plugins/orchestrator.mjs`：
  - 新导入 / create / restore 都执行迁移；
  - **启动时扫描** `layout.forkHomesDir` 下已有 fork home，执行一次迁移并审计
    `fork-workspace-migrated-startup`，不再只覆盖“以后新建的 fork”；
  - `task.workspaceMapping` / `taskView.workspaceMap` 暴露结果。
- 只改 Fang 自有 metadata 和 session 目录；`E:\DSH\DS` 原目录保持只读，不搬用户文件。

**证据**：

- `test/workspace-mapping.test.mjs`：Linux **6/6**，Windows 真机 **6/6**（含真实多帧
  zstd header 改写、事件帧保留、幂等、损坏输入 fail-closed、启动扫描接线）。
- 待：在已有真实 fork home（TOFUTURE）上跑一次启动迁移，记录 `mappings.json`
  与迁移前后 `workspace.json` 差异。

## P0-3 无托管浏览器时拒绝打开，禁止静默回退

**问题**：`POST /fang/api/tasks/open` 在托管浏览器不可用时仍返回 200 +
`managed:false`；客户端随即 `window.open` 用系统默认浏览器打开。元主 Web、
派生结果和母体 portal 也有同样的回退点。

**实现**：

- 服务端 `launchTaskBrowser`：`managedBrowser !== true` 返回
  `{ok:false,error:'managed-browser-disabled'}`，不再返回成功。
- `POST /fang/api/tasks/open`：浏览器失败返回 **HTTP 503**，错误
  `managed-browser-disabled` / `browser-unavailable` / `browser-cdp-timeout` /
  `browser-open-failed` / `fork-url-missing`，并写 audit
  `fork-browser-open-refused`。URL 留在服务端，供后续重试。
- 客户端：`openTask` 只有 `managed===true` 才提示成功；失败显示
  “托管浏览器不可用，已拒绝用外部浏览器打开”。`not-running` 重试重新进入
  `openTask`，不再 `window.open` 原始 URL；`runDerive` 也走同一门禁。
- 元主 Web（essence runtime，不是 task）：新增 `runtimeBrowsers` 托管目标，
  `openRuntimeManagedBrowser` / `closeRuntimeManagedBrowser`；`GET /api/essence/runtime/open`
  改为 async 且返回 503，失败写 `essence-runtime-browser-refused`。runtime browser
  进入 watchdog targets、panic 清理和内存总账。
- 母体 portal：Web 端不再拼 token 调 `window.open`，只 dispatch
  `fang:mother-portal`；Electron 壳仍优先 `focusMother`。
- `findBrowserPath`：显式配置的 `browserPath` 失效时返回空（fail-closed），
  不再静默改用 Edge/Chrome。
- **结果**：`client.js` 已无任何实际 `window.open(` 调用（只剩注释）。
  没有托管浏览器时，打开动作被拒绝，不会落到系统浏览器。

**证据**：

- `test/browser-open-refusal.test.mjs` **3/3**（服务端 503、客户端无回退、
  runtime 托管目标）。
- Windows 真机：`findBrowserPath` 对有效 Edge 返回路径，对显式不存在路径返回空；
  `launchManagedBrowser` 在 HSD 上被 Edge 策略挡住 CDP，返回 `browser-cdp-timeout`
  （此时调用方 503 拒绝，不外部打开）。TOFUTURE 的正式 CDP 打开仍待宿主在线复测。
- 待：真实 DSH 宿主上点“打开分身”验证 503/成功两条路径。
