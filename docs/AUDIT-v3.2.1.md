# AUDIT v3.2.1

范围：v3.2.0 四色状态机的并发、容量、取消与旧数据边界。

| 缺口 | 风险 | 修复 |
|---|---|---|
| defer 双定时器 | 重复 rev/审计 | deferredAt 幂等 |
| maxTickets 修剪 pending 黄票 | 人工永远无法补选 | 只修剪已处理历史 |
| abort 黄/蓝被 abandon | 补选/自动执行丢失 | 只有红色取消后 abandoned |
| 旧票 deadline=null | 被误判立即到期 | 必须有 waitDeadlineAt 才进入即时策略 |
| fork 蓝色最终轮询竞态 | 母体已执行但 fork 报超时 | 超时前再取一次最终状态 |

## 验证

```text
decision-policy-hardening   4 例（新增）
decision-level-policy       8 例
decision-center + fork     83 例
真实 DOM                   16 例
真实母体 e2e               92/92
```
