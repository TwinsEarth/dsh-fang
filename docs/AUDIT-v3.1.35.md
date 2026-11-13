# AUDIT v3.1.35

范围：分身会话 1..3 约束 + 派生弹窗 5 秒兜底 + POSIX 工作区编码。

## P1 · POSIX 工作区编码（MacMini 分身空列表）

| 项 | 内容 |
|---|---|
| 现象 | 分身里会话文件已导入，但 Web UI 无工作区/无会话、「新建会话」不可用 |
| 直接原因 | 分身 `storages/workspace.json` 为空（workspaceIds: []） |
| 根因 | `encodeWorkspaceKey()` 对 POSIX 绝对路径多编码一个前导 `-` |
| 对照 | DSH: `--Users-fang-Desktop-DS--`；fang: `---Users-fang-Desktop-DS--` |
| 影响 | Windows 盘符路径不受影响，所以长期未暴露 |
| 修复 | 折叠后 strip 首尾 `-`，再包 `--` |
| 复验 | 5 组路径全部与 DSH 一致 |

## 需求 · 分身会话 1..3

| 约束 | 实现 |
|---|---|
| 下限 1 | `ensureForkEmptySession()`：空分身在 spawn 前补一个合法空会话 |
| 上限 3 | `enforceForkSessionCap()`：保留最新 3 个，其余进 quarantine |
| 多分支 | 分支会话在 `keepSessionIds` 中豁免淘汰 |
| 空会话格式 | 5 帧 session v4 + zstd，实测可被 DSH 解压读取 |

## 需求 · 派生弹窗 5 秒兜底

```text
点「派生新分身」→ 弹窗（默认元主 + 进行中会话列表 + 倒计时）
  ├─ 选会话 → 导入该会话
  ├─ 点「新建空会话」→ 立即空会话
  └─ 5 秒到 → 自动空会话
```

## 回归

```text
test/fork-sessions.test.mjs              6 例（新增）
test/workspace-key-posix.test.mjs        5 例（新增）
test/client-derive-picker-timeout.test.mjs  4 例（新增）
test/session-format.test.mjs            14 例（无回归）
```
