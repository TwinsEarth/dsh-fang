# v3.7.8 审计（2026-11-24）

> 用户指令：**“修改并三方发布，v3.7.8”**。基线 v3.7.7。

## 范围

1. Windows CommitFree 启动护栏：创建/打开/还原/启动元主运行态前检查，低于阈值拒绝。
2. 单活跃分身：启动新分身时暂停其他运行中的分身，保留 home 与会话，不自动归档。
3. PID 树内存看门狗：30s 采样 Working Set/Commit，异常增长只杀该 fork。
4. 孤儿清理：按 taskId/profile 命令行双重校验后杀残留进程。

## 验证（待回填）

- 全量 tests：
- preflight --e2e：
- 发布 PR CI：
- release-order：

## 边界

- 单活跃分身默认开启；如确需并发，可显式把 `singleActiveFork` 设为 false。
- 内存看门狗只处理 Windows；Linux/macOS 返回 unsupported，不影响测试。
- 被暂停的分身状态为 failed/等待启动，可还原，不会删会话。
