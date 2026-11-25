# 发布记录索引（版本链）

只列当前发布线附近的记录；更早版本见 `docs/RELEASE-*.md` 与 `docs/AUDIT-*.md`。

> **v3.8.5–v3.8.12 tag 说明**：仓库为 shallow clone，早期无逐版 commit；本次按各版 tarball 重建了独立源码快照 commit（不含 `test/` 与 release tooling），并让它们成为 `main` 的线性祖先。v3.8.13 为完整开发树。每个 tag 对应唯一 commit，详见 [RELEASE-v3.8.13](RELEASE-v3.8.13.md)。

> **发布门禁状态（2026-11-25）**：v3.8.13 及之前的 tarball 均走 `--skip-preflight`；`dist/manifest.json` 的 `preflight` 必须记录 `skipped:true / green:false`，不得被解读为“preflight GREEN / 发布门禁通过”。真实 Windows DSH 宿主的 flush 3s 端到端、`browser-health.jsonl` 真机采样、健康预检/单 app 窗口/崩溃闩锁 E2E 仍待补跑；`native/win32/fang-job-host*.exe` 仍是旧二进制，Job 内存上限需 Windows 重编后才生效。

| 版本 | 主题 | 发布记录 | 审计 |
|---|---|---|---|
| v3.8.13 | 三条宿主红线收口：maxForks 硬拒 >1 / fork 总 Commit 4 GB 余量 / sidecar spawn 当刻 PID；页面文件改为 advisory | [RELEASE-v3.8.13](RELEASE-v3.8.13.md) | [AUDIT-v3.8.13](AUDIT-v3.8.13.md) |
| v3.8.12 | 页面文件缺失时 Safe Mode 解除硬门：服务端下发 canReset / 客户端 fail-closed / 解除前二次探测 | [RELEASE-v3.8.12](RELEASE-v3.8.12.md) | [AUDIT-v3.8.12](AUDIT-v3.8.12.md) |
| v3.8.11 | 状态对账：meta 自动修复 / 旧端口拒绝复用 / 暂停等待停止 / handler-threw 带 route+requestId | [RELEASE-v3.8.11](RELEASE-v3.8.11.md) | [AUDIT-v3.8.11](AUDIT-v3.8.11.md) |
| v3.8.10 | 严禁把宿主搞崩：5s 常驻采样 / 2GB 熔断与准入闸门 / sidecar 卡死判定 / maxForks=1 / 40% commit / flush 去猜测 | [RELEASE-v3.8.10](RELEASE-v3.8.10.md) | [AUDIT-v3.8.10](AUDIT-v3.8.10.md) |
| v3.8.9 | 不惜关闭：托管浏览器八条强制关闭 / 2 GB + 1.5 GB + 200k + 4 GB 硬阈值 / autoClose=true | [RELEASE-v3.8.9](RELEASE-v3.8.9.md) | [AUDIT-v3.8.9](AUDIT-v3.8.9.md) |
| v3.8.8 | 三条红线：browser/fork Job Object / 聚合 commit 30-35-40 分级 / Panic 路由与崩溃循环 JSONL / auth-token 宿主属主准入 | [RELEASE-v3.8.8](RELEASE-v3.8.8.md) | [AUDIT-v3.8.8](AUDIT-v3.8.8.md) |
| v3.8.7 | 防崩溃 P0/P1 收口：健康 20MB/20000 + latency/health 日志 / 无 pagefile 单活跃 / 真实 flush 3s / browser-crashes 退避 / 关闭原因 | [RELEASE-v3.8.7](RELEASE-v3.8.7.md) | [AUDIT-v3.8.7](AUDIT-v3.8.7.md) |
| v3.8.6 | 分身 Web 端防崩溃 8 项：CommitFree 6GB / pagefile 证据 / 健康预检 / 崩溃日志与根因 / 10 分钟闩锁 / 单 app 窗口 / flush / exit code | [RELEASE-v3.8.6](RELEASE-v3.8.6.md) | [AUDIT-v3.8.6](AUDIT-v3.8.6.md) |
| v3.8.5 | 闭环子集：CDP 15s / 懒渲染 / 缓存上限 / 隐藏暂停实验 / Job Object 内存上限 | [RELEASE-v3.8.5](RELEASE-v3.8.5.md) | [AUDIT-v3.8.5](AUDIT-v3.8.5.md) |
| v3.8.4 | 页面文件硬门禁 + 启动前 Safe Mode 预检 + 迁移报告防护 | [RELEASE-v3.8.4](RELEASE-v3.8.4.md) | [AUDIT-v3.8.4](AUDIT-v3.8.4.md) |
| v3.8.3 | P0 加固：Job Object / workspace 映射 / 拒绝浏览器回退（并入 v3.8.4） | [RELEASE-v3.8.3](RELEASE-v3.8.3.md)（未单独发布） | [AUDIT-v3.8.3](AUDIT-v3.8.3.md) |
| v3.8.2 | 数据根隔离：默认 `D:\ToFuture\FangData` | [RELEASE-v3.8.2](RELEASE-v3.8.2.md) | [AUDIT-v3.8.2](AUDIT-v3.8.2.md) |
| v3.8.1 | 修复 sidecar 拉起第二宿主 | [RELEASE-v3.8.1](RELEASE-v3.8.1.md) | [AUDIT-v3.8.1](AUDIT-v3.8.1.md) |
| v3.8.0 | 母体/原身/分身边界 | [RELEASE-v3.8.0](RELEASE-v3.8.0.md) | [AUDIT-v3.8.0](AUDIT-v3.8.0.md) |
| v3.7.8 | 上一稳定线 | [RELEASE-v3.7.8](RELEASE-v3.7.8.md) | [AUDIT-v3.7.8](AUDIT-v3.7.8.md) |
| v3.7.7 | 稳定性修复 | [RELEASE-v3.7.7](RELEASE-v3.7.7.md) | [AUDIT-v3.7.7](AUDIT-v3.7.7.md) |
