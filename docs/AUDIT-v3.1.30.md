# AUDIT v3.1.30

范围：分身 spawn-failed 根因（配置只读阻断 DSH 引导）+ 元主无对话启动 + 派生单会话约束。

## P0：spawn-failed

| 项 | 内容 |
|---|---|
| 现象 | 派生「启动分身失败：spawn-failed」；还原「请求失败：spawn-failed exited」 |
| 审计 | `fork-crashed exited`、`task-restored exited`、`fang-meta.lastError=restart-given-up:never-ready` |
| 原始报错 | `EPERM: operation not permitted, open <profile>\package.json`（dsh-app-boot writeProfileManifest） |
| 触发链 | DSH 0.2.2 启动 → dropRetiredBundles → 重写 package.json → 文件 0444 → EPERM → 子进程退出 |
| 根因 | `setProfileConfigReadonly(true)` 对 `package.json` / `cordis.patch.yml` chmod 0444（自 v3.0.9） |
| 修复 | readonly=true 不再 chmod；readonly=false 解锁并修复历史遗留；行为锁保留 |
| 复验 | 解除只读 → 同一 profile 输出 `dsh web: http://127.0.0.1:18051/?token=…` 正常启动 |

## 需求 1：元主无对话启动

- `openEssence()` 不再调用 `showSessionPicker()`，直接以空会话启动（`startEssenceRuntime(id, [])`）。

## 需求 2：派生只能导入一个会话

| 输入 | 结果 |
|---|---|
| 无 sessionId | `session-required` |
| 多个 sessionIds | `session-multi-not-allowed` |
| 恰好一个 sessionId | 正常派生并导入该会话目录 |

## 回归

```text
test/fork-config-lock.test.mjs      3 例
test/orchestrator.test.mjs         62 例
```
