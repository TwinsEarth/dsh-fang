# AUDIT v3.3.6

范围：母体重启的红色风险 UI 与两次确认。

## 契约

| 项 | 值 |
|---|---|
| 影响面 | `GET /fang/api/restart/impact`（只读） |
| 请求 | `POST /fang/api/restart/request` |
| 必填确认 | `confirmation.forkChecked=true` + `confirmation.finalConfirm=true` |
| 缺失确认 | HTTP 428 `restart-confirmation-required` |
| 审计 | `restart-requested` 带 confirmation 字段 |
| 执行 | 只有 executionArmed 才 exit 75；否则 decision-only |

## UI

红色弹窗 → 影响面 → 打开分身检查 → 我已确认 → 二次确认放行。未确认时最终按钮禁用。

## 验证

```text
orchestrator: POST /fang/api/restart/request 缺确认 = 428
orchestrator: requestMotherRestart 缺确认拒绝，确认后才转交
restart-guard: confirmation 进入请求审计
```
