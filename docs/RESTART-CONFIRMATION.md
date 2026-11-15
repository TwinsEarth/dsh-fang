# 母体重启：红色风险 + 分身预确认 + 二次点击

生效版本：`v3.3.6`

## 入口

- 瓮城控制台面板头：`重启母体`（仅 restart-guard 可用时显示）；
- `GET /fang/api/restart/impact`：只读影响面（活跃分身、待批提升、脏缓冲、武装状态）；
- `POST /fang/api/restart/request`：必须带 `confirmation.forkChecked=true` 与 `confirmation.finalConfirm=true`。

## 两次确认

1. 打开弹窗，阅读红色风险与影响面；
2. 点击「我已在分身确认」（建议先点「打开分身检查」），按钮才启用；
3. 点击「二次确认：放行重启」→ 才提交 guard 请求。

缺失任一确认：HTTP 428 `restart-confirmation-required`，不创建重启请求。

## 执行边界（重要）

- `executionArmed=true`（enforce + allowProcessRestart + supervisor 在位）：守卫写授权清单并 exit 75，由外部 supervisor 拉起新宿主；
- `executionArmed=false`：只记录红色审批与拒绝原因，**不会自动退出/重启**；UI 明确显示“未武装”。
- 这是为了防止无 supervisor 时把宿主杀死后无法自动恢复；不把“审批”伪装成“已执行”。

## 测试

- restart-guard 确认字段进入请求与审计；
- orchestrator：缺确认 428；带确认但 guard 不可用 409；
- `requestMotherRestart` 未确认拒绝，确认后才转交 guard。
