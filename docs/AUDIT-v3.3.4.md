# AUDIT v3.3.4

范围：npm 包改名 + queue-journal 默认禁用/能力门控。

## npm 身份

| 项 | 值 |
|---|---|
| 新包名 | `@twinsearth/fang-dsh-plugin` |
| 旧包名 | `@twinsearth/dsh-fang`（兼容，不再作为新发布身份） |
| 本地 bundle | `@local/dsh-fang`（构建时改写） |
| 市场 | 官方市场未上线；本版不提交第三方市场 |

## queue-journal 门控

## npm 公开访问

| 项 | 值 |
|---|---|
| staged package | `publishConfig.access = public` |
| REST payload | `access: "public"` |
| 门禁 | `package: publish access public` |

| 层 | 行为 |
|---|---|
| bundle 行 | `disabled: true` 默认关闭 |
| host half | 0.1.7 提供 `fangQueueJournal` |
| API | 服务缺失时 journal/history/queue 全部 503 `queue-journal-disabled` |
| status | `services.queueJournal` 布尔能力 |
| client | 能力探测失败即不渲染；主面板按 services 隐藏 approver/forker UI |
| boot-guard | disabled 行跳过模块解析/冒烟，不阻塞启动 |

## 验证

```text
queue-journal-gate  3 例
orchestrator queue  2 例（503 / 正常）
boot-guard          既有 + disabled 行
全量测试见构建输出
```
