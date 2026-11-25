# 2026-11-22 宿主崩溃故障报告：Web 分身与 DSH 宿主的隔离失效

> 事故对象：DeepSeek Harness Desktop 0.2.2-rc.5（宿主 PID 9168 / host PID 15916）
> 关联版本：瓮城 v3.7.0 → v3.7.1 发布部署
> 结论时间：2026-11-22 13:20（Asia/Shanghai）

## 一、结论先行

1. **这次宿主崩溃不是 Web 分身进程直接导致的，是我（Agent）的部署动作导致的。**
   我在 DSH Desktop 宿主运行期间，直接 `Remove-Item` + `Robocopy` 替换了母体 profile 里的
   `@twinsearth/fang-dsh-plugin` 目录，触发 DSH 宿主 `fs.watch` 的 `EPERM` 未捕获异常，
   宿主以 exit 1 退出，Desktop 弹出「DeepSeek Harness 无法使用」。

2. **但你的质疑成立：当前“瓮城”只隔离了进程/会话/工作区，没有隔离“安装与配置变更加固层”。**
   Web 分身是独立子进程（独立 `DSH_HOME`、profile、端口、会话），分身进程在宿主崩溃后仍然活着；
   但**母体 profile 是宿主和发版流程共用的**，我的部署可以直接改动它，从而杀死宿主。
   这不是真正的“风险隔离”，只是“运行态隔离”。

3. **DSH 自身的 `EPERM watch` 致命退出是一个上游健壮性缺陷**：文件监听失败不应让整个宿主崩溃；
   我们无法修改 `app.asar` 内的 Desktop 核心，只能在瓮城侧建立“绝不热改母体”的部署协议，
   并推动上游把 watcher 错误降级。

## 二、证据链（时间均为本机 Asia/Shanghai）

| 时间 | 事件 | 证据 |
|---|---|---|
| 12:12:08 | 构建 v3.7.0 产物 | `dist/dsh-fang-3.7.0.tgz` mtime |
| 12:20:46 | **宿主崩溃 #1**（host exit 1） | `crash-2026-11-22T04-20-46-235Z-host.log`；报 `cannot resolve profile bundle "@twinsearth/fang-dsh-plugin"` + `EPERM watch` |
| 13:01:52 | 构建 v3.7.1 产物 | `dist/dsh-fang-3.7.1.tgz` mtime |
| **13:06:26** | **宿主崩溃 #2**（host exit 1） | `crash-2026-11-22T05-06-26-412Z-host.log`；报 `fatal uncaught exception: EPERM: operation not permitted, watch` |
| **13:06:26** | 母体 fang 插件目录完成替换 | `%USERPROFILE%\.dsh\profiles\desktop\node_modules\@twinsearth\fang-dsh-plugin` 的 LastWriteTime = 13:06:26，**与崩溃秒级重合** |
| 13:10:49 | 用户重启 Desktop | 新 Desktop main PID 7724 / host PID 10808 |

崩溃日志关键行（05:06:26）：

```text
Error: dsh desktop host exited with 1: ...
dsh: fatal uncaught exception: Error: EPERM: operation not permitted, watch
    at FSWatcher._handle.onchange (node:internal/fs/watchers:269:21) {
  errno: -4048, syscall: 'watch', code: 'EPERM', filename: null
}
```

说明：第二次崩溃日志里**没有** fang bundle 解析失败，只有 watcher EPERM；
第一次崩溃同时出现 fang 解析失败，是因为替换窗口里目录短暂不存在。
两次都发生在部署替换母体 profile 的同一时刻。

## 三、当前架构到底隔离了什么

```text
DSH Desktop (main PID 7724)
└─ Desktop host (profiles\desktop)  ← 监听母体 profile 文件；本次崩溃点
   └─ Fang 插件（瓮城编排器）
      └─ Fork Web 子进程（pid 12236, port 18000）
         DSH_HOME = <fork>\home
         profile  = fang-mwram4u9ylki
         node_modules = fork 自己的 per-entry mirror
```

| 维度 | 是否隔离 | 说明 |
|---|---|---|
| 进程 | ✅ | 分身是独立 `DeepSeek Harness.exe` 子进程；宿主崩溃后分身进程仍存活 |
| DSH_HOME / 会话 / storages | ✅ | 分身在 `forks/<task>/home`，有自己的 sessions/storages |
| profile / cordis patch | ✅（运行态） | 分身有自己的 `profiles/fang-*` |
| 工作区/仓库 | ⚠️ | 同一台机器、同一用户；分身可访问母体可访问的文件系统（除非另行限制） |
| **DSH 安装（app.asar / runtime / CLI）** | ❌ **共享** | 宿主与分身使用同一个 `D:\DSH` 安装 |
| **母体 profile / 插件目录** | ❌ **共享且可被部署改写** | 本次事故的直接通道 |
| **FANG_HOME 控制面数据** | ⚠️ 共享 | `desktop` 下的 tasks/endpoint/audit 等由母体编排器管理 |
| 网络 / OS 账号 | ❌ 共享 | 同用户、同网络、同桌面会话 |

因此：**“两套系统”只在进程和运行数据层面成立；安装与配置变更加固层仍是同一套。**
瓮城当前是“进程级沙箱 + 目录级数据隔离”，不是“VM 级隔离”。

## 四、根因链

1. 发布流程为了把 3.7.0/3.7.1 装进本机，直接对**正在运行的母体 profile**做：
   `Remove-Item <profile>\node_modules\@twinsearth\fang-dsh-plugin -Recurse` → `Robocopy`。
2. DSH Desktop 宿主对 profile 有 `fs.watch`；目录被删除/替换时 Windows 返回 `EPERM`。
3. DSH Desktop 宿主未捕获 `FSWatcher` 的 `error` 事件，`uncaughtException` 直接 exit 1。
4. Desktop 主进程检测到 host exit 1，弹出「无法使用」对话框。
5. 分身 Web 进程仍在 18000 端口运行，加深了“分身把宿主带崩”的错觉；
   实际崩溃时刻与我的 profile 替换完全重合。

**责任归属：Agent 的部署方式（主因） + DSH Desktop watcher 未降级（次因/上游缺陷）。**
Web 分身代码不是本次宿主崩溃的触发者。

## 五、解决方案（必须做到“部署/更新不越过宿主边界”）

### P0（立即，今天生效）

1. **禁止热改母体 profile**：新增部署工具 `tools/release/deploy-profile.mjs`：
   - 检测 DSH Desktop host / 母体 endpoint 是否在运行；运行中直接拒绝部署；
   - 先在临时目录完整落盘 → 校验版本/hash → 目录**原子 rename** 切换；
   - 保留上一版备份，失败自动回滚；
   - 不再使用 `Remove-Item` + `Robocopy` 直接覆盖活目录。
2. **安装/更新只在“宿主已退出”时进行**：用户关闭 DSH Desktop（或确认 host 已停止）后再部署；
   部署完成后重新启动 Desktop。
3. **发布记录与操作审计**：每次部署写入 `archive/deploy/<ts>/deploy.json`，记录旧版本/新版本/hash/宿主 PID。

### P1（本版本内，隔离加固）

4. **母体 profile 只读挂载给发布流程**：发布流程不得直接写 `profiles/desktop`；
   只允许写 per-essence / per-fork 的副本。
5. **分身使用私有安装视图**：为 fork 提供 per-fork 的 `node_modules` 与 profile（已有），
   插件升级只更新“下一个分身模板”，不更新正在运行的母体/官方元主。
6. **FANG 部署 API 增加宿主存活检查**：`/fang/api/deploy` 在 host 存活时返回 409，不做文件替换。
7. **watcher 错误降级**：向 DSH 上游提交 issue（Desktop watcher `error` 未捕获导致 host exit），
   推动将 `fs.watch` 错误记录为 warning 并重建 watcher。

### P2（真正 VM 级隔离）

8. **每个分身独立 DSH 安装副本**（复制 `app.asar`/runtime 或用只读 bind），
   或使用 Windows Sandbox / Hyper-V / WSL2 容器；分身只能看到自己的安装与工作区。
9. **独立 OS 账号 + AppContainer/Job Object**：限制文件系统、网络、进程树；
   母体崩溃/重启不影响分身，反之亦然。
10. **资源与网络隔离**：独立端口段、独立临时目录、可选无网络模式。

## 六、验收标准（可执行）

- [ ] 宿主运行中执行部署工具 → **拒绝**，宿主 PID/端口不变，无 crash 日志。
- [ ] 宿主停止后部署 → 原子切换成功，版本/hash 正确，回滚可用。
- [ ] 在分身内删除/替换其 `node_modules`、kill 分身进程 → 母体 host PID/端口不变。
- [ ] 替换母体 profile 包（模拟事故）→ 部署工具拒绝；即使强制，watcher 不致命（上游修复后）。
- [ ] 分身崩溃只影响自身 Web 页面，Desktop 不弹「无法使用」。

## 七、立即恢复步骤

1. 本机 profile 已切到 **v3.7.1**（13:06 部署；13:10 Desktop 已重启）。
2. 确认 `@twinsearth/fang-dsh-plugin` 目录完整、版本 3.7.1；queue-journal 0.1.8。
3. 重启后打开母体 Web，确认 `/fang/api/status` 为 3.7.1；再开分身验证插件同步。
4. 后续部署必须走 `deploy-profile.mjs`，**不得在 Desktop 运行时替换 profile**。
