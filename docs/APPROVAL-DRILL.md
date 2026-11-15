# 审批 / 提升 / 回滚 drill

生效版本：`v3.3.5`

## 目的

证明 Approver 不只是“已加载”，而是能真实执行：

```text
requestPromotion(red) → pending → decide(approved) → snapshot → 修改文件 → rollback
```

## 两种执行方式

### 1. 本机隔离 drill（不碰生产）

```bash
node tools/approval-drill.mjs
node tools/approval-drill.mjs --json
```

- 使用临时 `dataRoot`；不写生产 fang 数据目录；
- 真实创建红票、真实 `decide`、真实 A 代快照与 digest 校验回滚；
- 结束清理临时目录，`residue=clean`。

### 2. 运行宿主上的隔离 drill（需 v3.3.5）

```bash
node tools/fangctl.mjs approvals drill --url http://127.0.0.1:<port>
```

调用 `POST /fang/api/approvals/drill`；同样在临时 `dataRoot` 执行，不影响生产审批队列。

## /approvals 修复

- 只聚合 `status=ready|running` 的分身；
- 失败/停止/回收的分身归入 `skipped`，不再把整个收件箱标成 degraded；
- 真正活跃分身 adapter 失败才记 `failed`。

## 边界

drill 证明的是 Approver 的审批/快照/回滚链路；生产“提升插件”仍需真实合法分身插件并走 Scorer/Router。drill 不会写入 `promoted/`，也不会改 profile。
