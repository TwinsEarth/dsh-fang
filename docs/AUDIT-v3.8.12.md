# v3.8.12 审计：页面文件缺失与 Safe Mode 解除门

- 日期：2026-11-25
- 范围：Safe Mode 解除路径、页面文件探测、客户端阻断、`openMigrationReport` 归属
- 结论：页面文件缺失时，解除操作在 UI 与服务端均被硬拦；启动阶段仍不能由 Fang 事前兜底

## 一、现场事实

只读核对当前机器：

- `Win32_PageFileUsage` 为空；
- `TotalVirtualMemorySize = 33,255,604 KB`（约 31.7 GB）；
- `FreeVirtualMemory = 22,820,836 KB`；
- 页面文件缺失/禁用时，Commit 上限就是物理内存。

崩溃日志 `crash-2026-11-25T05-11-40-094Z-host.log` 从第 13 行开始大量出现：

```text
dsh: disabling profile plugin row "tool-bash": its declared dsh requirements cannot be validated: UNKNOWN: unknown error, read
```

这不是某个插件声明错误，而是 Windows 在 Commit 压力下连 profile 文件都读不出来，DSH 只能逐行禁用核心插件；随后 renderer 崩，Safe Mode 才在后续启动检测到 `commit-free-critical`。

因此：

- Fang 3.8.3 的看门狗不可能阻止这次崩溃：崩溃发生在 DSH 自己加载 profile/插件阶段，Fang 插件还没获得执行机会；
- Safe Mode 是事后检测，不是事前阻止；
- 没有页面文件，Windows 无法换出不活跃内存，任何“内存阈值/杀进程”只能降低概率，不能保证；
- 唯一根治是启用 Windows 页面文件并重启。

## 二、代码审计

### 服务端

`evaluateSafeModeReset(memory, { hostCriticalFreeMB })` 已按以下顺序拒绝：

1. `memory.ok !== true` → `memory-probe-unavailable`；
2. `isPagefileMissing(memory)` → `pagefile-missing`；
3. `commitFreeMB < hostCriticalFreeMB` → `commit-low`。

`POST /fang/api/safe-mode/reset` 在 `service.resetSafeMode()` 返回 `{ok:false}` 时返回 409。

本轮新增：

- `safeModeStatus()` 返回 `reset` 权威门，UI 不再只依赖 `S.status.memory`；
- `resetSafeMode()` 在释放 `safeMode` 前二次 `force` 探测，第二次不通过则 409，审计 `stage:'postcheck'`。

### 客户端

`reviewSafeMode()` 现在：

- 优先读 `S.safeMode.data.reset`；
- `reset.pagefileMissing === true` → `pagefileMissing` 阻断；
- `reset.error === 'commit-low'` → `commitLow` 阻断；
- `reset.error === 'memory-probe-unavailable'` → `memoryUnknown` 阻断；
- 其他 `canReset === false` → `resetBlocked` 阻断；
- 阻断时复选框 disabled、确认按钮 disabled，`confirmSafeModeReset()` 本地也直接拒绝。

审计结论：页面文件缺失时，仅勾选不再可能解除 Safe Mode；即使绕过前端直接 POST，服务端仍 409。

## 三、`openMigrationReport` 归属

- Fang 3.8.2 源码中搜不到 `openMigrationReport`；
- 它来自 DSH 0.2.2-rc.5 的客户端/设置插件组合，不是 Fang 自己定义；
- Fang 侧已有 `typeof app.openMigrationReport !== 'function'` 防御，页面会提示“请单独上报 DSH 客户端 API 问题”；
- 它会让某个页面报错，但不是本次 OOM/Commit 崩溃根因，需与 pagefile 安全门分开处理。

## 四、剩余风险

- DSH 在 Fang 插件加载前崩溃，Fang 无法事前拦截；只能依赖 Safe Mode 事后闩锁与宿主页面文件修复。
- 页面文件可能在两次探测之间被系统策略移除；二次探测缩小窗口，但不能做到绝对原子。
- 非 Windows 平台 `supported === false` 时 `evaluateSafeModeReset()` 返回 `skipped`，这是平台差异，不是绕过。
- 本版未在 TOFUTURE 真机安装验证；当前机器仍是页面文件缺失状态，安装后解除按钮应保持禁用，直到启用页面文件并重启。

## 五、发布门禁

- `dist/manifest.json` 的 `preflight` 仍是旧 3.8.5 红（`pass=-1 fail=-1`，e2e `-1/-1`），本版构建走 `--skip-preflight`。
- 真实 Windows DSH 宿主的 `/fang/adapter/flush-session` 3s 端到端落盘、`browser-health.jsonl` 真机采样尚未执行。
- 因此本版只能算“源码与本地测试完成”，不能宣称发布门禁通过。

