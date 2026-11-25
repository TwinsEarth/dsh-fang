# v3.8.12 发布记录：Safe Mode 解除的页面文件硬门

- 日期：2026-11-25
- 基线：v3.8.11
- 主题：页面文件缺失时，Safe Mode 不能被前端勾选绕过；解除前后各校验一次

## 问题

真机 `Win32_PageFileUsage` 为空，`TotalVirtualMemorySize` 约 31.7 GB，页面文件缺失/被禁用。崩溃日志显示 DSH 启动加载 profile/插件阶段大量 `dsh: disabling profile plugin row ... UNKNOWN: unknown error, read`，随后 renderer 崩，Safe Mode 才在后续启动检测到 `commit-free-critical`。

这不是 Fang 3.8.3 看门狗能拦住的场景：崩溃发生在 DSH 自己加载 profile/插件阶段，Fang 插件尚未获得执行机会。没有页面文件，Windows 无法换出不活跃内存，任何内存阈值/杀进程只能降低概率，不能保证。

截图暴露的客户端问题：

- 页面文件仍缺失/被禁用；
- “页面文件 / Commit 余量已恢复”复选框仍可被勾选；
- “确认已检查，解除 Safe Mode”按钮仍可点。

服务端 `evaluateSafeModeReset()` 已拒绝 `pagefile-missing`，但 `safeModeStatus()` 没有把校验结果下发给 UI，客户端仍在用可能过期的 status 内存快照自行判断；内存探测失败时，客户端也会把“未知”当成“正常”。

## 修复

1. **服务端下发权威解除门**：`safeModeStatus()` 返回 `reset`：
   - `canReset`
   - `error` / `detail`
   - `memoryKnown`
   - `pagefileMissing` / `pageFileMB` / `commitFreeMB` / `minFreeMB`
   - `checkedAt`
2. **客户端按服务端结果 fail-closed**：`reviewSafeMode()` 优先读取 `S.safeMode.data.reset`；页面文件缺失、Commit 低于 `hostCriticalFreeMB`、内存探测不可用、其他 blocker 任一命中时：
   - 显示红色阻断说明；
   - 页面文件复选框 disabled；
   - “确认已检查，解除 Safe Mode”按钮 disabled；
   - 即使被强行调用 `confirmSafeModeReset()`，也在本地直接拒绝。
3. **解除前二次探测**：`resetSafeMode()` 第一次探测通过后，在释放闩锁前再 `force` 探测一次；第二次仍必须页面文件存在且 Commit ≥ `hostCriticalFreeMB`，否则 409，审计 `stage:'postcheck'`，不解除。
4. **不把 `openMigrationReport` 混入本次根因**：该调用来自 DSH 0.2.2-rc.5 客户端/设置插件组合，不是 Fang 定义；Fang 侧已有 `typeof app.openMigrationReport !== 'function'` 防御。它是独立客户端 API 不匹配问题，不是本次 OOM/Commit 崩溃根因。

## 行为变化

- 页面文件缺失时，Safe Mode 解除按钮不可点；点击也不会通过服务端。
- 内存探测失败时不再默认放行，而是显示“无法读取系统内存状态”，要求重新检测。
- 解除前后各探测一次，缩小“页面文件在解除瞬间消失”的竞态窗口。
- 本版不改变启动阶段：DSH 自身在 Fang 插件加载前崩溃时，Fang 仍无法事前阻止；根治仍是启用 Windows 页面文件并重启。

## 测试

- 新增客户端/服务端静态门禁断言：`reset` 权威字段、`memoryUnknown`、`resetBlocked`、`postcheck`。
- 页面文件/客户端 Safe Mode 定向 12/12 通过。
- 全量：1572 tests / 1549 pass / 0 fail / 13 skipped / 10 todo。

## 发布门禁（未通过）

- `dist/manifest.json` 的 `preflight` 仍是旧 **3.8.5** 红色结果：`green=false`、`tests.pass=-1` / `tests.fail=-1`、`e2e.passed=-1` / `e2e.total=-1`。
- 本版 tarball 走 `--skip-preflight` 构建；package smoke / crash-safety / allow-list / main-city package gate 只是构建后检查，不等于完整 preflight。
- 真实 Windows DSH 宿主的 `/fang/adapter/flush-session` 3s 端到端落盘、`browser-health.jsonl` 真机采样仍未在 Windows 自托管环境执行。
- 因此本版 **不得** 宣称“preflight GREEN / 发布门禁通过”。

## 产物

- `dist/dsh-fang-3.8.12.tgz`：939,140 bytes，229 entries
- SHA-256：`cde835fbe1ef92eb58872063c971a7940e95b008e9a7deca743ab784c04cf6ab`
- 未 push、未 tag、未 GitHub Release、未 npm publish。
