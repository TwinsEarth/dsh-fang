# 审计报告 · dsh-Fang v3.0.2（升级后重算协调 / 偏好 schema / 空闲审计）

> 本机真实输出（2026-11-02）。版本线：v2.9.2 → v2.9.3 → v2.9.9 → v3.0.0 → v3.0.1 → v3.0.2。

## 1. 交付范围

| 交付物 | 内容 |
|---|---|
| `src/lib/semaphore.mjs` | 计数信号量（并发上限、排队唤醒、stats） |
| `EssenceManager.recomputeAll` | 异步批量：ensureFresh（fingerprint 匹配 → skipped）、concurrency（默认 4）、perEssenceTimeoutMs（默认 60s）、AbortSignal、onProgress；返回 recomputed/skipped/conflicted/failed/aborted/durationMs |
| `MirrorManager.postUpgradeHook` | 升级成功 fire-and-forget；`postUpgradeTriggered`；失败/回滚不触发；钩子异常只 warn |
| `src/lib/upgrade-coordinator.mjs` | `onUpgradeSuccess` 去重并发批次、`getRecomputeStatus`、`waitForRecompute` |
| `src/lib/preferences.mjs` | schema 驱动（6 字段）；normalize 纯函数；未知字段丢弃；损坏文件不覆盖；step 对齐；`GET/POST /fang/api/mirror/preferences[/set]` |
| `src/lib/status-store.mjs` | 外部 store：不可变快照、304 只更新 lastUpdatedAt、订阅计数、acquireActive 引用计数 + pokeActive + 30s 空闲降级、setActiveIdleTimeout、onIdleDowngraded 事件 |
| `src/lib/idle-audit.mjs` | 单条审计 + 周期 summary、byTimeout 统计、rapidAway/fullTimeout、样本足够生成建议；滚动窗口 getRecommendations 输出结构化建议 |
| `src/lib/interaction-poke.mjs` | 交互节流 poke（框架无关） |

## 2. 门禁（v3.0.2）

| 门禁 | 结果 |
|---|---|
| preflight --e2e | **GREEN 3.0.2** |
| tests | **602 pass / 0 fail / 1 skip** |
| e2e | **58/58** |
| allow-list | **46 路由 / 0 findings** |
| 构建/健康检查 | 见 dist 产物与 healthz 输出 |

## 3. 语义不变量（有测试）

- recomputeAll 单原身失败/超时进 failed，不中断整批；abort 后不再处理；
- coordinator 并发触发合并为一次；recompute 抛错写 lastError 且 running=false；
- 升级成功才触发 hook，失败/回滚不触发；
- preferences 旧文件缺新字段补齐并写回；损坏 JSON 不覆盖；非法值 400；
- status-store 304 不替换 status；空闲降级由 poke/acquire/release 精确控制；
- 建议只在样本 ≥10 时产出；快照清空不影响滚动窗口建议。

## 4. 未交付（后续版本）

- 官方更新源接入（Release/自建镜像 + 校验 + 回滚 + compat 门禁）→ v3.0.3；
- client-half React 包、dismissals 7 天冷却、UI 部分接线；
- 严格发布序列 v3.0.0/v3.0.1 尚未 tag（网络恢复后按序补发）。

## 5. 提交状态

分支 `feat/upgrade-coordinator`（stacked 在 v3.0.1 `a04c6be` 之上）；未合并 main。
