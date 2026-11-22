# v3.7.6 审计（2026-11-22）

> 用户指令：**“三方发布，v3.7.6”**。基线 v3.7.5；本版只修加速核会话兼容，不引入新功能。

## 根因

切到加速核后，`team/mode` 事件被加速核拒绝。旧 sanitizer 标记所有 unknown 事件（包括 header 帧的 `session`），验证时 header 帧变化，整次修复被放弃，日志保持未标记。

## 修复

- `src/lib/accelerated-fork.mjs`：只标记 `team/mode`、`team/task`、`team/status`、`deliverables/presented`；header/known 事件不动。
- `sanitizeAcceleratedForkSessions` 输出包含 `markedIgnorable` 文件。
- 测试：known 集合缺少 header 类型时仍成功、只标 1 条 team/mode。
- 当前受损会话已手工修复并保留备份。

## 验证（待回填）

- 全量 tests：
- preflight --e2e：
- 发布 PR CI：
- release-order：

## 边界

- 只修 `team/mode` 这类明确的新事件；加速核以后遇到其他未知事件仍需扩展名单。
- 修复会改写会话日志（帧保留、原文件备份），不会删除会话。
