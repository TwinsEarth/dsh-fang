# v3.9.5 发布说明

日期：2026-11-26
类型：热修（hotfix）
基线：v3.9.4

## 修什么

v3.9.4 在真实宿主上出现 `Safe Mode · 自动恢复已禁止 / crash-loop-10m`，启动分身返回 `host-admission-closed`，瓮城无法使用。根因是 `crash-loop-*` 被 Safe Mode 自动解除逻辑硬排除，而两次普通 unclean-shutdown 就会被计成崩溃循环，即使 Commit 仍有 25 GB。

v3.9.5 做了四件事：

1. `crash-loop-*` 在 Commit 余量 ≥2345 MB 时自动解除，不再永久封门。
2. 只有携带真实资源压力的崩溃样本（低 Commit / heap critical / session emergency）才允许触发 crash-loop 封门。
3. 自动解除后清零 `host-crashes.json` 的窗口计数，JSONL 审计保留，避免下次正常重启复发。
4. 新建/还原/打开/启动浏览器前先尝试自动恢复准入；宿主压力横幅补全单文件阈值 16/32/64 MB。

## 行为边界

- `manual-panic` 仍需人工确认或 `force:true`。
- 自动解除只重开准入，不会自动拉起任何分身。
- Commit <999 MB 时仍由 `memoryGate` 硬拒绝派生/启动。
- 61 MB 单会话仍显示 critical，但未到 64 MB emergency，不会封住新任务。

## 验证

见 `docs/AUDIT-v3.9.5.md`。定向回归 119/119 PASS（12 + 70 + 37）。
