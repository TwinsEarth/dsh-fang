# T9 完成报告 — Auditor 汇总 + Approver 双侧语义（v2.0.0）

- 任务：`task-9`（T9：Auditor 汇总 + Approver 双侧语义）
- 状态：**完成**（实现 + v2 测试 + v1 断言保持全绿；全量仅剩与 T9 无关的 adapter 缺失外部失败）
- 契约依据：`docs/CONTRACTS-V2.md` §1 角色门禁、§5.7（Auditor/Approver v2）、§7/§8；v1 契约 `docs/CONTRACTS.md` §5.2/§5.7
- 文件（仅本 owner 写域）：
  - `src/plugins/auditor.mjs`（v2：roleGate/scope/aggregate/bootAudit/cloudSink）
  - `src/plugins/approver.mjs`（v2：roleGate/scope/requestPromotion/requestRestart/summary）
  - `test/auditor.test.mjs`（15 用例 / **120 条 assert 语句**；v1 11 用例全保留 + 新增 4 个 v2 用例）
  - `test/approver.test.mjs`（14 用例 / **191 条 assert 语句**；v1 10 用例全保留 + 新增 4 个 v2 用例）
  - `docs/t9-report.md`（本报告）

## 1. 验收（真实输出）

```powershell
cd dsh-fang
node --test test/auditor.test.mjs        # tests 15  pass 15  fail 0
node --test test/approver.test.mjs       # tests 14  pass 14  fail 0
node --test test/auditor.test.mjs test/approver.test.mjs
# ℹ tests 29  ℹ pass 29  ℹ fail 0  ℹ duration_ms 1351.8
```

全量（`node --test --test-concurrency=1 "test/*.test.mjs"`）最终真实输出：

```text
✔ plugin shape + role matrix: adapter
✔ plugin shape + role matrix: approver
✔ plugin shape + role matrix: auditor
✔ compose mode mounts every plugin of the current role through one row
✔ package exports + bundle patch reference every row (install preflight)
ℹ tests 217  ℹ pass 216  ℹ fail 0  ℹ skipped 1  ℹ duration_ms 12374.0
# 唯一 skip = T8 的 LIVE container probe（需 FANG_CONTAINER_LIVE=1，CONTRACTS-V2 §7 允许）
# 用例总数随并行 owner 增加会变化；最后一次实测为 217 tests / 0 fail。
```

开发过程中曾短暂出现 3 个 `plugins-shape` 失败，经确认全部是并行开发中的
`src/plugins/adapter.mjs` 尚未落地（`compose.mjs`/`package.json`/`plugins-shape.test.mjs`
已先按 v2 引用它），与 T9 改动无关；adapter 落地后全量已转绿（上面的输出）。
交接时基线为 141 tests / 15 fail（Lead 正做 v2 迁移），现在 205 tests / 0 fail。

## 2. 实现摘要

### 2.1 共同：角色门禁（CONTRACTS-V2 §1）

- 两个插件 `apply()` 的**第一行**都是 `roleGate('<key>', { cfgRole: config?.role, logger: ctx.logger })`；
  `if (!gate.active) return null` —— 未部署到该角色时不注册服务/定时器/文件桥（approver）或不跑启动自检（auditor）。
- `service.scope = gate.role`（`'mother'|'fork'`）。
- 角色解析：`DSH_FANG_ROLE` 环境变量优先（forker 已在 `src/plugins/forker.mjs:864` 注入 `fork`），
  其次 `config.role`，缺省 `mother`。两个插件的 `Config` 都新增 `role: z.union([mother, fork])`（默认 mother），
  loader 不传也安全，`plugins-shape` 的 env 驱动矩阵用例可直接覆盖。

### 2.2 Auditor 新增（CONTRACTS-V2 §5.7）

```js
service.scope                                   // 'mother'|'fork'
aggregate({limit=200, sources=[{taskId, records}], })
  -> {ok:true, total, records:[{taskId:null|<id>, ...record}], sources:[taskId], scope}
bootAudit()                                     // bootCheck() 的同一函数（保留 bootCheck）
cloudSink() -> {ok:false, reason:'not-configured'}   // 商用钩子占位
```

- **纯汇总**：只读本机账本（`readAll()`）+ 调用方拉来的分身记录，不写盘、不改链、不 verify 链。
- 本地记录强制 `taskId:null`；每个 source 的记录强制打上该 source 的 `taskId`。
- 排序：**at 优先**（多进程时间线；不同分身的 seq 各自从 0 起，跨源不可比），同一 `at` 或缺 `at` 时退回 **seq**。
- `total` = 合并后总条数（limit 之前）；`records` = 排序后**最新 limit 条**（与 v1 `read()` 的"最新 N"语义一致；limit=0 → `[]`）。
- `sources` = 输入 sources 的 taskId 顺序数组。
- v1 `append/read/verify/bootCheck/ledgerFile/instanceId/lastError/lastBoot` 全部保持不变（append 仍走 kernel `appendChained` 哈希链）。

### 2.3 Approver 新增（CONTRACTS-V2 §5.7）

```js
service.scope                                   // 'mother'|'fork'
requestPromotion({pluginId, taskId, detail, impact}) -> Promise<{id,outcome,by,at}>
     // == request({kind:'promotion', risk:'red'})；risk 由服务强制红灯
requestRestart({reason, title?, detail?, impact?, ttlMs?}) -> Promise<{...}>
     // == request({kind:'restart', risk:'red'})；调用方传 risk:'blue' 也会被强制为 red
summary({remotes=[{taskId, fetchApprovals: async () => ({ok, items})}]})
  -> Promise<{ok:true, scope, local:[...], remote:[{taskId, ok, items, error?}], total, failed, degraded}>
```

- 语义化包装走同一套 v1 队列：TTL fail-closed、`decide()`、bus `fang/approval-decided`、审计全部沿用；
  `pluginId/taskId` 会透传到 `pending()` item、`status().lastDecisions`、`decisions.jsonl` 与两条审计记录。
- **红灯语义**：`requestPromotion/requestRestart` 固定 `risk='red'`；`strictRedLine=true`（默认）下即使
  `authMode='auto'` 也必须显式 `decide()`（测试覆盖：auto 模式下 promotion 仍在队列）。
- `summary`：本地 `pending()` + `Promise.all(remotes.map(...))` **并发**拉取（测试用双 deferred 证明两个
  `fetchApprovals` 在任何 await 前一起启动）；单个 remote 抛错 / 返回 `{ok:false}` / 缺 `fetchApprovals`
  都只降级为 `{ok:false, items:[], error}`，**不阻塞**其它 remote；兼容 `{items}`、`{data:{items}}`、裸数组。
  `total` 只统计"本地 + 成功 remote 的 items"；`ok:true` 表示汇总调用完成，`failed/degraded` 表降级程度。
- v1 行为（queue/decide/TTL fail-closed/strictRedLine/AB snapshot+rollback/monitor/文件桥/dispose 清理）
  一字未动，v1 测试 10 用例全绿（A/B 30 条断言等原样保留）。

## 3. v2 覆盖矩阵

| 文件 | 用例 | assert | 覆盖点 |
|---|---|---|---|
| auditor | v2 role gate | 5 | default mother、config.role=fork、env 优先 config.role、两侧都注册服务 |
| auditor | v2 aggregate 合并 | 12 | 本地 taskId=null、分身记录打 taskId、按 at 跨源升序、sources/total、纯汇总不改链 |
| auditor | v2 aggregate limit/seq | 8 | total=全量、limit 取最新 N、limit=0、缺 at 时按 seq 兜底 |
| auditor | v2 bootAudit/cloudSink | 5 | 别名与 bootCheck 同结论（dirty ledger 的 unclean-boot）、cloudSink 精确占位返回 |
| approver | v2 role gate | 5 | mother/fork 两侧激活、scope、env 优先 config.role |
| approver | v2 promotion/restart | 21 | kind/risk 固定为 promotion/restart + red、pluginId/taskId 透传、decide 结案、审计/决策记录、auto 模式红灯不被绕过 |
| approver | v2 summary 混合/降级 | 25 | 本地 pending、多 remote 并发、成功/抛错/ok:false/缺方法四种降级、total/failed、{data.items} 兼容 |
| approver | v2 summary 并发 | 5 | 两个 fetchApprovals 在 await 前一起启动、聚合总数正确 |

## 4. 降级点 / NOT ESTABLISHED

1. **角色门禁的 inactive 分支对这两个插件不可达**：v2 矩阵里 auditor/approver 在 mother+fork 都激活，
   因此本 owner 测试只能证明"两侧都激活且 scope 正确"；"未激活不注册"由 Lead 的 `plugins-shape`
   角色矩阵用例覆盖（已含我的两个插件，全量中通过）。`apply` 的 inactive 分支逻辑本身已实现（return null）。
2. **aggregate 排序策略**：at 优先、seq 兜底；跨源 seq 不比较（各自从 0 起）。若契约意图是 seq 优先，
   改 `compareRecords` 3 行即可（报告已知会 Lead）。
3. **aggregate records 取最新 limit 条**（与 v1 `read()` 一致），不是最旧 limit 条；`total` 为全量。
4. **summary 的 `ok` 表示"汇总完成"，不是"全部 remote 成功"**：降级信息在 `remote[i].ok`、`failed`、
   `degraded`。若 Lead 要求"任一 remote 失败则 ok=false"，1 行可改。
5. **requestPromotion/requestRestart 不做"仅母体可调用"硬拒绝**：按语义约定（mother 侧使用），
   fork 侧误调用也会正常入队（不破坏通用 request）；未加角色级抛错。
6. **cloudSink 只是占位**：未接 `COMMERCIAL` 的 `backup.upload`（CONTRACTS-V2 §6 本期只要求钩子位）。
7. 其它：aggregate 不校验链（只读汇总）、不跨进程去重；summary 无超时（remote 客户端自带 timeout，见 T5）。

## 5. 集成备注（给 Lead / T4 / T5）

- **Orchestrator 已按预期调用**：`src/plugins/orchestrator.mjs:493` 用
  `approver.requestPromotion({pluginId, taskId, detail, impact})`，`:514` 用 `approver.snapshot({tag,dir})`，
  v1 兼容路径 `:566` 用 `approver.request({kind:'promotion',risk:'red',...})` —— 两种形状均被支持
  （`test/orchestrator.test.mjs:247` 的 fake 也是同一形状）。
- `forker.mjs:864` 已注入 `DSH_FANG_ROLE=fork`；auditor/approver 用 env 优先的 roleGate，无需 loader 改配置。
- `cordis.patch.yml` 无需为 auditor/approver 增加 role 键（缺省 mother；fork 由 env 决定）。
- T5 的 `src/plugins/adapter.mjs` 已落地，全量验收已复跑通过（217 tests / 0 fail / 1 skip）：
  `node --test --test-concurrency=1 "test/*.test.mjs"`。
