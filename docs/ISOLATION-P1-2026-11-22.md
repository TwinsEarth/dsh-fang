# P1 隔离加固记录（2026-11-22）

> 对应事故：[INCIDENT-2026-11-22-FORK-HOST-CRASH.md](INCIDENT-2026-11-22-FORK-HOST-CRASH.md)
> 目标：发版/插件更新不再热改宿主；watcher 错误不再杀死 DSH host。

## 1. 已完成

| 项 | 实现 | 验证 |
|---|---|---|
| 宿主存活时拒绝部署 | `tools/release/deploy-profile.mjs` 探测 `endpoint.json` + HTTP；运行中 `exit 2` | 本机 host RUNNING → FAIL exit 2 |
| 原子部署 + 回滚 | staging → rename 旧目录 → rename 新目录；失败恢复；旧版本备份 + `deploy.json` | 代码审查/工具路径 |
| FANG 部署 API 409 | `POST /fang/api/deploy`、`GET /fang/api/deploy/guard` 固定返回 409 `host-running` | orchestrator 单测 409 |
| watcher 错误降级 | `src/lib/watch-guard.mjs` 包装 `fs.watch`，为 watcher 挂 `error` 监听并记录 warning，避免 `EPERM` uncaughtException | watch-guard 单测 emit EPERM 不抛 |
| fork 安装视图 | 暂保持 per-entry mirror（不复制 fang，避免 @local symlink 被误写）；安装快照需显式启用 | 2026-11-22 e2e 回归后移除复制 |
| 发版不写 live profile | `build/preflight/publish/upload/verify` 只写 `dist/`、registry、GitHub；部署是显式独立步骤 | release-order 10/10 |

## 2. 边界（不能宣称完成的部分）

1. **不能在文件系统层把母体 profile 设成只读**：DSH 启动必须写 `package.json`/`cordis.patch.yml`（v3.1.30 实测 chmod 只读会导致 EPERM 启动失败）。因此“母体 profile 只读”落实为**部署策略/进程边界**：宿主运行中任何部署工具/API 都拒绝；只有 host 停止后由显式 operator 命令切换。
2. **watcher 上游缺陷仍在**：本层的 `fs.watch` 降级只能覆盖插件加载之后创建的 watcher；DSH app-boot 在加载插件前创建的 profile watcher 仍由上游代码负责。需要向 DSH 提交 issue：`FSWatcher` 的 `error` 必须被捕获为 warning 并重建 watcher，而不是 `uncaughtException`。
3. **fork 仍使用 per-entry mirror，不是全量私有安装**；复制 fang 会经 `@local` symlink 误写母体，已回退。真正的 per-fork 全量私有安装需要复制/容器化整个 DSH 安装（P2）。

## 3. 验收命令

```powershell
# 宿主运行中：必须拒绝
node tools/release/deploy-profile.mjs --check
# → FAIL 宿主仍在运行..., exit 2

# host 停止后：原子部署
node tools/release/deploy-profile.mjs --source dist/npm/package --profile %USERPROFILE%\.dsh\profiles\desktop
# → PASS deployed ...; 必须重启 DSH Desktop
```

## 4. 下一步（P2）

- 每个 fork 独立 DSH 安装副本（app.asar/runtime 只读 bind 或复制）；
- Windows Sandbox / Hyper-V / WSL2 容器 + 独立 OS 账号；
- 网络/端口/临时目录隔离；
- 推动 DSH 上游 watcher error 降级。
