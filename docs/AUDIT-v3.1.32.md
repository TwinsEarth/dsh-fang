# AUDIT v3.1.32

范围：绿色「派生新分身」接线修复（默认元主 + 单会话选择）。

| 项 | 内容 |
|---|---|
| 现象 | 点「派生新分身」→ 红色「派生失败 · session-required」 |
| 根因 | 按钮执行 deriveTask 无 sessionId；v3.1.30 服务端已强制要求一个会话 |
| 次因 | 未关联 defaultId（开发者推荐/官方默认元主） |
| 修复 | 新增 deriveQuick()：默认元主 → showDerivePicker 单选 → tasks/create |
| 实测 | essence-official-dev 命中，tasks/create 200，status=ready，会话已导入，profile 非只读 |
| 残留 | reap removed=true，fork home 已删除 |

## 回归

```text
test/client-derive-quick.test.mjs   4 例（新增）
```
