# SPIKE v3.0.8 · 分支运行时

状态：已跑通（2026-11-04）。脚本：`tools/spikes/branch-spike.mjs`。

## 目标

验证“一个分身 = 一个 sessionId；同进程内多 branchId、多日志；单写者；切换不重启进程”是否可行。

## 方法

1. 临时目录创建 `session_spike/branches/{main,branch-a,branch-b}`；
2. 每个 branch 写独立 `log.jsonl`；
3. 用 `wx` 独占锁模拟单写者：第二次打开锁必须失败；
4. 切换 active branch 仅移动指针，不重启进程；
5. 清理临时目录并输出 GREEN/RED。

## 结果

```
PASS  branches have independent logs
PASS  second writer on same branch is rejected
PASS  branch lock is per branch, not global
PASS  active branch switch is a pointer move
GREEN branch spike 4/4
```

## 结论

**可行**：分支不需要独立进程；同进程多线程/多日志、按分支单写者、指针切换均成立。

## 限制

- 锁为文件级 `wx`，进程崩溃后需清理陈锁（后续加 pid/时间戳与回收）；
- 未验证跨进程多写（当前模型同进程单写者，足够）；
- Windows 下 junction/symlink 不作为分支路径；
- 分支**不可合并**，`sealed/archived` 只读；
- 本 spike 不涉及 DSH 宿主 API，仅模型验证。

## 后续

1. `src/lib/branch.mjs`：`createBranch / activateBranch / sealBranch / archiveBranch / acquireWriter`；
2. `test/branch.test.mjs`：独立日志、单写者、封存只读、不可合并、切换状态；
3. 接入 orchestrator 时仍以 `sessionId + branchId` 为键，不新建进程。
