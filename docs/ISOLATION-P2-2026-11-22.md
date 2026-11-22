# P2 隔离加固记录（2026-11-22）

> 用户选择路线 A：**每版本安装快照 + per-fork 视图 + 进程/临时目录隔离**（非 VM）。
> 目标平台：Windows 11 家庭版（无 Windows Sandbox/Hyper-V，WSL2 未安装）。

## 1. 已实现

| 项 | 实现 | 验证 |
|---|---|---|
| 每版本不可变 DSH 安装快照 | `src/lib/install-snapshot.mjs`：在安装卷 `.fang-installs/dsh-<version>-<hash>/` 对 `DeepSeek Harness.exe`/`resources` 做 hardlink（同卷零拷贝）；安装升级替换文件后旧快照仍是旧 inode | `install-snapshot.test.mjs` 模拟源文件替换，快照仍读 v1 |
| fork 使用自己的安装视图 | orchestrator `forkCliPath()` 为 stock 分身返回快照内 `resources/runtime/cli/bin/dsh.cmd`；create/restore/repair 三条 spawn 路径都使用它 | 代码路径 + 单测 |
| fork 安装视图 | 保持 per-entry mirror；复制 fang 会经 @local symlink 误写母体，已回退 | e2e 125/125 |
| 独立 TEMP/TMP | 每个 fork spawn 注入 `<fork>/tmp`，不再共用用户临时目录 | 代码路径 |
| 部署边界 | `deploy-profile.mjs` 宿主存活拒绝；FANG deploy API 409；watcher 降级 | P1 记录 |
| 安装快照失败回退 | 快照创建失败时显式 audit `fork-install-snapshot-failed` 并回退共享 CLI，不静默假成功 | 代码 |

## 2. 未完成（本机条件下需额外系统能力）

1. **Windows Job Object**：需要原生 P/Invoke 或常驻 supervisor 给子进程创建/保持 Job（KILL_ON_JOB_CLOSE），当前 Node 纯 JS 无法可靠实现；现有 `killTree` 仍能在 stop 时清理进程树。列为下一项原生 helper。
2. **Windows 防火墙 per-fork 出站规则**：按程序路径建规则需要管理员权限，且所有 fork 共用同一快照 exe 路径，无法区分到单个 fork；真正按 fork 的网络隔离需要独立安装副本路径或 WFP 驱动，属 VM/容器级。
3. **真正 VM 级隔离**：Windows 11 家庭版无 Sandbox/Hyper-V；WSL2 未安装且 DSH Desktop 是 Windows GUI，不能直接复用安装。若必须 VM，需要升级 Pro + Sandbox/Hyper-V 或安装第三方虚拟机（需用户授权/重启）。

## 3. 验收

```powershell
node --test test/install-snapshot.test.mjs test/watch-guard.test.mjs
# 应从 snapshot 路径启动 stock 分身；母体安装升级后旧分身继续用旧快照
```

## 4. 结论

P2-A 已完成 **安装副本/私有 fang/临时目录/部署边界**；Job Object 与防火墙规则未实现，因此当前是“强进程/文件隔离 + 不可变安装视图”，**不是 VM 级隔离**。不能对外宣称 VM 级。
