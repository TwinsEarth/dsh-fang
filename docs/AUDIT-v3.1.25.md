# AUDIT v3.1.25

范围：PM 主动开票策略 + 发布流水线 artifact 单点修复。

## 一、PM 主动开票

| 项 | 位置 | 判定 |
|---|---|---|
| 策略常量 | `PM_DECISION_POLICY`（导出，含版本号） | 7 mustAsk / 3 mustNotAsk / 5 rules |
| 模型可见注入 | `PM_PROACTIVE_HINT` 拼进 3 处工具 description（母体 2 + fork 1） | 是 |
| 人读文档 | `docs/PM-DECISION-POLICY.md` | 是 |
| autoDecide 红线 | red / isBlocking 永不自动 | 代码内硬判定 |

## 二、流水线单点

| 项 | 改前 | 改后 |
|---|---|---|
| artifact 上传失败 | 整条发布失败（npm/Release skip） | `continue-on-error`，仅存档 |
| npm 发布路径 | 依赖 artifact | build job 内直发（幂等） |
| GitHub Release | 依赖 artifact | build job 内 `gh release upload --clobber`（幂等） |
| 远端复核 | 依赖 npm/Release job | 依赖 build，不被连锁 skip |

## 证据

```text
v3.1.24 build job 日志：tests { pass: 1044, fail: 0 } e2e { passed: 81, total: 81 } green true
随后失败：Failed to CreateArtifact: Unable to make request: ENOTFOUND
→ 构建绿、传输挂；修复后发布不再依赖该传输
```
