# 安装 / 升级向导（v3.8.2 数据根迁移）

> 适用于从旧 Fang 布局升级到 v3.8.2+ 的 Windows 安装。迁移工具只复制、不删除源数据。
>
> v3.8.4 的页面文件硬门禁（Safe Mode 必须实际读到 `Win32_PageFileUsage`，启动前预检缺失直接进入 Safe Mode）见
> [RELEASE-v3.8.4.md](RELEASE-v3.8.4.md)；v3.8.3 的 P0 加固（Job Object / 旧 workspace 映射 / 无托管浏览器拒绝回退）见
> [P0-HARDENING.md](P0-HARDENING.md)；升级本身仍按本文的数据根迁移步骤。
> 本向导按**仓库源码 / 完整分发**编写；如果只拿到 npm 包，`deploy-profile` 不随包提供，按 DSH 插件安装流程装包即可。
> 硬规则：**宿主运行中禁止执行迁移或替换 profile**（会触发 fs.watch EPERM，见 `docs/ERROR-BOOK.md` EB-03/EB-15）。

## 1. 先停宿主

完全退出 DeepSeek Harness，而不是只关窗口。确认进程已退出：

```powershell
Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue
```

有输出就继续退出，不要写 profile，也不要执行迁移。

## 2. 迁移旧数据到规范根

v3.8.2 的规范数据根是 `D:\ToFuture\FangData`。先 dry-run 看来源：

```powershell
node tools/migrate-fang-home.mjs
```

确认后执行（只复制、不删除、不覆盖）：

```powershell
node tools/migrate-fang-home.mjs --apply
```

- 目标已有 `tasks.json` 时工具默认拒绝；先读冲突报告，人工确认后再考虑 `--force`。
- 报告写到 `D:\ToFuture\FangData\_migration\migration-<stamp>.json`。
- 旧目录保留；指针写到 `%USERPROFILE%\.dsh\fang\fang-home.txt`。

## 3. 核对迁移报告

```powershell
Get-ChildItem D:\ToFuture\FangData\_migration\migration-*.json |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
```

启动 v3.8.2 后，瓮城面板会显示「数据迁移报告」横幅，可查看复制/跳过/冲突数量、来源根、目标 `tasks.json` 和冲突文件。若面板没有显示：确认宿主已重启，并检查上述报告目录。

## 4. 部署 / 升级插件

宿主仍必须停止。先做只读检查：

```powershell
node tools/release/deploy-profile.mjs --check
```

检查通过后部署候选包（按实际 profile 路径调整 `--profile`）：

```powershell
node tools/release/deploy-profile.mjs --source dist/npm/package --profile C:\Users\<你>\.dsh\profiles\desktop
```

工具会先 staging、校验、原子 rename；宿主存活时返回 409，不会热替换 profile。

## 5. 启动后验收

1. 从**正式开始菜单入口**启动，不用临时测试实例代替。
2. 打开瓮城面板，确认版本和 `layout.migrationReport` 可见。
3. 抽查 `D:\ToFuture\FangData\mirror\<profile>\tasks.json`、`forks\`、`sessions\` 是否落在规范根。
4. 若启动失败：先保留现场，不要删除 `.dsh`、AppData 或 updater；按 `docs/CRASH-SAFETY.md` 的 Safe Mode 流程处理。

## 6. 回滚

- 迁移只复制，旧源目录仍在；迁移前数据未删除。
- 插件部署工具会保留上一版备份；按部署输出中的备份路径回滚。
- 数据指针 `fang-home.txt` 可改回旧根，但改前先确认旧目录仍完整。

## 相关文档

- [CHANGELOG v3.8.2](CHANGELOG.md)
- [v3.8.2 发布记录](RELEASE-v3.8.2.md)
- [v3.8.2 审计](AUDIT-v3.8.2.md)
- [v3.8.3 P0 加固与真机证据](P0-HARDENING.md)
- [版本链索引](RELEASES.md)
- [崩溃安全与升级规程](CRASH-SAFETY.md)
- [UI / 发版流程](WORKFLOW-UI.md)
- [错误本](ERROR-BOOK.md)
