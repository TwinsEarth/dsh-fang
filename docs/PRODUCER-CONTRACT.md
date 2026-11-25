# 统一业务生产者契约（v1）

> 目的：HarnessMM / PluginUpdater / SuperAgent / PJM / Worker 本体不在本仓，
> 但它们需要一种**统一、可校验、可幂等**的方式把事件送进决策中心。
> 本契约只定义调用面；**“契约就绪”≠“业务已接”**——外部进程必须实际调用。

## 1. 契约目录

```http
GET /fang/api/decisions/producers
→ { ok, version: 1, producers: [{ producer, kinds, defaultLevel, sourceRole, required, payload }] }
```

代码：`src/lib/producer-contract.mjs`（`PRODUCER_CONTRACTS` / `producerCatalog()`）。

| producer | kind | 默认 level | 默认 actions |
|---|---|---|---|
| HarnessMM | `harnessmm-suggestion` | blue | 采纳 / 忽略 |
| PluginUpdater | `plugin-updater-backup` | green | 无（FYI） |
| SuperAgent | `superagent-completion` | green | 无（FYI） |
| PJM | `pjm-timeout` | yellow + 5min 自动灰 | 重试 / 放弃 |
| PJM | `pjm-fatal` | yellow | 重试 / 放弃 |
| Worker | `worker-deviation` | yellow | 查看 / 忽略 |

## 2. Payload

```ts
{
  producer: 'HarnessMM' | 'PluginUpdater' | 'SuperAgent' | 'PJM' | 'Worker'
  kind?: string
  level?: 'red' | 'yellow' | 'blue' | 'green'   // 省略用默认
  title: string                                   // 必填
  context?: string
  actions?: [{ id, label, type?: 'primary'|'default' }]
  options?: [{ value, label, isRecommended? }]
  timeoutMinutes?: number
  dedupeKey?: string                              // 省略时按 id/backupId/taskId/projectId 派生
  sourceRole?: 'pm'|'pjm'|'worker'|'system'
  sessionId?: string
  metadata?: object
}
```

规则：
- 非 green 必须有 `actions` 或 `options`（未提供时用默认 actions）；
- `PJM + pjm-timeout` 默认 `timeoutMinutes=5`，到点自动 expired/gray；
- `dedupeKey` 跨状态幂等：同 key 的 ticket 已存在（含 resolved）就返回原 ticket。

## 3. 统一调用（推荐）

```js
import { createProducerSubmitter } from 'dsh-fang/src/lib/producer-contract.mjs'
import { createForkIngestClient } from 'dsh-fang/src/lib/decision-ingest-client.mjs'

const client = createForkIngestClient({ dataDir: '<outbox>', motherDataDir: process.env.DSH_FANG_MOTHER })
const submit = createProducerSubmitter({ submit: (payload) => client.submit(payload) })

const result = await submit({
  producer: 'PJM', kind: 'pjm-timeout',
  title: 'PJM 超时：p1', context: 'phase=build', projectId: 'p1',
})
// => { ok, producer, kind, level, ticketId, deduped, queued, outboxId, reason }
```

也有的入口：
- HTTP：`POST /fang/api/decisions/ingest`（payload 同上）；
- CLI：`node tools/decision-ingest.mjs --outbox-dir <dir> --payload '<json>'`；
- fork tool：`report_pjm_timeout` / `report_worker_deviation`；
- fork adapter：`ADAPTER_OP.DECISION_INGEST`。

## 4. Envelope 与错误码

```ts
// 成功
{ ok: true, producer, kind, level, ticketId, deduped, queued, outboxId?, reason? }
// 校验失败
{ ok: false, code, errors? }
```

| code | 含义 |
|---|---|
| `invalid-payload` | 不是对象 |
| `unknown-producer` | 不在五个白名单 |
| `unknown-kind` | producer 不支持的 kind |
| `bad-level` | level 非法（gray 不能新建） |
| `title-required` | 缺标题 |
| `options-or-actions-required` | 非 green 且既无 actions 也无 options |
| `submit-failed` | 底层提交抛错（不吞） |

## 5. 各系统接入点清单

| 系统 | 在何处调用 |
|---|---|
| HarnessMM | 产出优化建议时：`submit({producer:'HarnessMM', title: summary, id})` |
| PluginUpdater | 更新前备份完成后：`submit({producer:'PluginUpdater', title, backupId})` |
| SuperAgent | 任务完成时：`submit({producer:'SuperAgent', title: summary, taskId})` |
| PJM | 超时/致命错误处：`submit({producer:'PJM', kind:'pjm-timeout'|'pjm-fatal', projectId, phase})` |
| Worker | 检测到跑偏时：`submit({producer:'Worker', title, taskId, detail})` |

## 6. 边界

- 本契约不改变外部系统；不调用就仍然是“未接”；
- 角色只做展示/归因，不是权限；
- 红色仍不能由生产者自动选择答案；PJM/Worker 默认 yellow，不阻塞 Agent；
- 运行中宿主仍是旧 bundle，路由/工具要重启 DSH Desktop 后生效。
