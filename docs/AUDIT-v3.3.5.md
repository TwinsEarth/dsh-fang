# AUDIT v3.3.5

范围：审批/提升/回滚链路。

## 修复前实机

```text
/fang/api/approvals → {"ok":true,"degraded":true,"items":[],"failed":[{"taskId":"...","error":"fetch failed"}]}
```

死分身（failed）被当作远程审批失败，导致整个收件箱 degraded。

## 修复后

- `/approvals` 只对 `status=ready|running` 的分身做 adapter 聚合；
- 离线分身进入 `skipped`，不计入 `degraded`；
- 活跃 adapter 真失败仍进入 `failed`（fail-visible，不掩盖）。

## 审批 drill

临时 dataRoot 内真实执行：

```text
requestPromotion(red) → pending=1
decide(approved)
request outcome=approved
snapshot=ok
修改目标文件 → rollback=ok restored=true
pendingAfter=0
cleanup=true
```

## 风险与边界

- drill 不写入生产 `promoted/`、不修改 profile；
- 生产提升仍需合法分身插件 + Scorer/Router/Approver 全链路；
- 运行宿主需安装 3.3.5 后才有新路由与聚合语义。
