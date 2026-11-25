# AUDIT v3.3.7

范围：auto-watchdog 与放开的母体重启门禁。

## 契约

| 项 | 值 |
|---|---|
| 触发 | 二次确认 + 红色审批通过 |
| 启动 | `tools/restart-watchdog.mjs --execute` |
| 前置 | `mode=enforce` + `allowProcessRestart=true` + 无 supervisor |
| 成功 | marker 出现 → guard 重新计算 armed → 写清单 → exit 75 |
| 失败 | 不写清单、不退出，返回 auto-watchdog-* |
| 角色 | 仅 mother 的 restart-guard |

## 验证

```text
restart-guard tests: 33 pass
orchestrator tests: 68 pass
main-city source: GREEN
```
