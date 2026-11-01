# T3 完成报告 — 审批子插件 `fang-approver`（2.4）

- 任务：`task-3`（T3：approver 子插件 —— 队列 / A-B 双备 / 监控 / 回滚 / 文件桥）
- 状态：**完成**（实现 + 测试全绿 + 文件桥保留 + 审计/事件接线）
- 契约依据：`docs/CONTRACTS.md` §3 模块契约、§5.7 `fangApprover`、§6 事件 `fang/approval-decided`
- 参考实现：`dsh-hot-update\packages\approval\index.js`（队列/AB/监控/回滚/文件桥）

## 1. 交付文件（仅本 owner 写域）

| 文件 | 说明 |
|---|---|
| `src/plugins/approver.mjs` | 子插件实现（~700 行含注释；导出 `name/inject/Config/apply` + 只读 `_internals`） |
| `test/approver.test.mjs` | 10 个用例 / **131 条断言**，`node:test` + `node:assert/strict`，零外部依赖 |
| `test/fixtures/t3/tree/{a.txt,sub/b.txt}` | A/B 快照测试的目录 fixture |
| `docs/t3-report.md` | 本报告 |

未触碰 `package.json` / `cordis.patch.yml` / `src/kernel/**` / `client.js` / 其他 owner 文件。

## 2. 验收（真实执行）

```powershell
cd dsh-fang
node --test test/approver.test.mjs
```

```text
✔ 模块形状与 fangApprover 服务注册（契约 §3/§5.7） (11.3ms)
✔ request → decide approved：pending 列表 / Promise 结果 / 审计 / bus 事件 (56.9ms)
✔ request → decide denied：拒绝路径 (21.7ms)
✔ TTL 到期 fail-closed：outcome=timeout（短 TTL，不等待） (72.2ms)
✔ strictRedLine：红灯不被 authMode=auto 绕过；非红自动放行 (87.3ms)
✔ A/B 双备：snapshot 落盘 / 轮换保留上一代 / rollback 恢复内容并校验 digest (108.9ms)
✔ monitor：采样、阈值报警（数字 / {op,value}）与状态统计 (28.1ms)
✔ decide 边界：未知 id / 非法结论 / 重复决策 (25.4ms)
✔ 文件桥：command / pending / status / answer json 供 CLI 驱动 (78.9ms)
✔ dispose：未决请求按 timeout 结算、定时器清理、dispose 后请求 fail-closed (24.6ms)

ℹ tests 10   ℹ pass 10   ℹ fail 0   ℹ duration_ms 717.7
```

（同一命令连跑 3 次均全绿；进程正常退出，无悬挂定时器。）

## 3. 契约 5.7 对照

| 契约 | 实现 | 备注 |
|---|---|---|
| `request({kind,risk,title,detail,impact?,ttlMs?})` → `Promise<{id,outcome,by,at}>` | ✅ | `id` = `apr_*`；`outcome ∈ approved/denied/timeout`；`at` = ISO 字符串 |
| `pending() -> item[]` | ✅ | 仅 `state==='pending'`；含 `id/kind/risk/title/detail/impact/createdAt/deadlineAt/reminded` |
| `decide(id,'approved'\|'denied',{by,note}) -> {ok}` | ✅ | 未知 id→`not-found`；非法结论→`bad-outcome`；已结案→`not-pending`（不可覆盖首结论） |
| `snapshot({tag,dir}) -> {tag, A:{digest,at}, B:null\|{digest,at}}` | ✅ | A=本次快照、B=上一次；首次 `B:null`（与契约示例逐字一致） |
| `rollback({tag,dir}) -> {ok,restored}` | ✅ | 默认从 A 恢复，另支持可选 `to:'B'`；恢复后重算 digest 校验 `matches` |
| `monitor({label,value,threshold}) -> {ok,alert:boolean}` | ✅ | threshold 支持数字（默认 `>`）或 `{op:'>'\|'>='\|'<'\|'<=', value}` |
| `status() -> {pending,snapshots,monitors,decisions}` | ✅ | 四项均为计数；另附 `pendingItems/snapshotsList/monitorsList/lastDecisions/policy/dataDir` 明细兄弟字段 |
| `strictRedLine`：红必须显式 decide | ✅ | `authMode=auto` 下 `risk==='red' && strictRedLine` **永远进队列**；TTL 到期 = `timeout`（fail-closed） |

事件/审计：每个结论（含 timeout）都 `bus.emit('fang/approval-decided', {id, outcome})`；
`approval-requested` / `approval-decided` / `snapshot-created` / `rollback` 均经
`ctx.get(SERVICE.auditor)?.append(kind,data)` 写审计，auditor 未装载或抛错时静默容错（safeGet）。

## 4. 关键实现要点

1. **队列**：`request()` 建 `item` 并存 `Map`，返回 Promise；只有 `settle()` 一条结案路径
   （改状态→记录→resolve→emit→审计→落盘），保证不会出现“事件发了但 Promise 没结”或反之。
2. **TTL fail-closed**：每项一个 `setTimeout(ttl)` → `outcome:'timeout', by:'ttl'`；`remindAt`
   比例的提醒只标记 `reminded` 并刷新状态文件，**绝不自动放行**。定时器全部登记在 `timers` Set
   与 item 内，`ctx.effect(() => () => …)` 卸载时清理；未决请求按 `timeout / by:'unload'` 结算。
3. **auto 模式边界**：`authMode='auto'` 时非红（或 `strictRedLine=false`）立即 `approved/by:'auto'`；
   红灯在 `strictRedLine=true` 下强制排队等 `decide()`。未知 risk 值一律按 `'red'` 处理（fail-closed）。
4. **A/B 双备**：落盘 `<dataDir>/snapshots/<tag>/{A,B}`；每次 snapshot 把旧 A 滚成 B（只留一代），
   新内容写入 A，并对**复制出来的内容**做内容寻址 sha256（排序后的 `rel\0内容哈希` 串再 sha256，跨平台稳定）。
   `rollback` 删除目标目录内容后用快照槽覆盖，重算 digest 与槽 digest 比对，不一致 → `ok:false, reason:'digest-mismatch'`。
5. **文件桥（保留 CLI 驱动能力）**：`dataDir` 下沿用参考实现的命名
   `dsh-approval-command.json` / `dsh-approval-answer.json` / `dsh-approval-pending.json` / `dsh-approval-status.json`，
   由 `ctx.effect` 注册的 interval 轮询（默认 300ms，可配 `fileBridgePollMs`）。
   command 支持 `request/decide/answer/snapshot/rollback/monitor/status`；answer 兼容老写法 `{id, decision:'approve'|'deny'}`。
   轮询间隔与定时器均可注入缩短，测试用 20ms 跑通端到端。
6. **落盘合规**：插件内**不 import `node:fs`**，全部经 kernel `fsx`（`writeJsonAtomic` / `appendJsonl` /
   `copyTree` / `removeTree` / `ensureDir` / `digestTree` / `sha256` / `readTextSafe`）。
   另有“`touched` 门闩”：只 `apply()` 不产生任何业务动作时**不写盘**，`apply(makeCtx())` 不会污染 profile。
   测试全部用 `mkdtemp` 的 `dataRoot`；已验证 `%USERPROFILE%\.dsh\fang` 不存在（无 profile 写入）。
7. **数据根**：`resolveFangLayout({dataRoot: cfg.dataRoot}).dataDir`；`backupRoot` 留空时快照根 =
   `layout.snapshotsDir`（即 `<dataDir>/snapshots`）。

## 5. 测试覆盖矩阵（131 断言 / 10 用例）

| 用例 | 断言 | 覆盖点 |
|---|---|---|
| 模块形状与注册 | 17 | `name/inject/Config/apply`；Config 默认值与枚举校验；`ctx.get('fangApprover')`；7 个方法存在；`paths` 文件桥路径；apply 不落盘 |
| request→decide approved | 23 | Promise 返回；pending 列表字段；`status().pending`；decide→Promise resolve（outcome/by/at）；审计两条；bus 事件；lastDecisions；重复 decide 不覆盖 |
| request→decide denied | 6 | 拒绝路径、note 落历史、pending 清空 |
| TTL fail-closed | 7 | 60ms TTL 到期 `timeout/by:'ttl'`；耗时区间；pending 清空；审计历史；bus 事件 |
| strictRedLine | 10 | auto 模式蓝灯自动放行；**红灯不被 auto 绕过**（40ms 后仍在队列）；显式 decide 后 resolve；`strictRedLine=false` 的红灯 auto 边界 |
| A/B 快照/回滚 | 30 | 首次 `B:null`+digest 64hex+落盘；第二次快照 A→B 轮换且 `B.digest===旧A.digest`；rollback A 恢复内容+digest 校验；rollback B 恢复上一代；失败路径（dir 不存在/no-snapshot/no-target-dir）；审计 |
| monitor | 14 | 数字阈值报警/不报警；`{op,value}` 阈值；无阈值 alert=false；status 的 min/max/last/samples/alerts；非法 value |
| decide 边界 | 7 | 未知 id、非法 outcome、非法结论不结单、重复决策 `not-pending`、首结论不被覆盖 |
| 文件桥 | 11 | command 文件被消费并建请求；pending/status json 内容；answer 文件消费后批准并删除；`by:'cli'` |
| dispose | 6 | 未决请求 dispose 时 `timeout/by:'unload'`；定时器清理；dispose 后 request fail-closed |

硬约束遵守：T 单 TTL 全部用 60ms（50–100ms 区间）；无长等待（整个套件 <1s）；临时目录 mkdtemp + 用例结束 `removeTree` 清理。

## 6. 降级点 / NOT ESTABLISHED（如实声明）

1. **`authMode='timed'` 的限时授权（grants / 临时 24h 授权）未实现**：按 `manual` 处理（fail-closed）。
   参考实现的 `findGrant/grants` 未搬入；v1.0.0 契约 5.7 未要求，若 T4 restart-guard 需要“限时授权”，
   应走 restart-guard 自己的 policy，不依赖 approver。
2. **快照只保留一代 B**（A=最新 / B=上一次），不做多代历史/轮换链；空目录不进入 digest（`digestTree` 只记录文件与链接），
   因此“恢复后目录里存在空目录”这一形态不会被还原。
3. **快照不跟随 junction**：`kernel.copyTree` 对符号链接只重建链接、不进入目标目录（安全优先）。
4. **monitor 是单点采样**，没有内部定时 getter 轮询（参考实现有 `watch`）；采样节奏由调用方/CLI 决定。
   未实现连续越阈值告警的自动回滚联动（回滚权仍在调用方显式调用 `rollback`）。
5. **未桥接宿主内置 `ctx.approval` / UI 面板**（参考实现也没有；超出 T3 契约范围）。
   审批交互当前只走服务 API + 文件桥。
6. **`status()` 四项为计数**（`pending/snapshots/monitors/decisions`）；契约未展开字段类型，
   明细放在 `pendingItems/snapshotsList/monitorsList/lastDecisions`（避免歧义时可直接取数组）。
7. **契约 5.7 与任务书一句话的取舍（需要 Lead 知悉）**：任务书写“snapshot 把 dir 内容复制到
   `<dataDir>/snapshots/<tag>/B`”，而 CONTRACTS 5.7 明确 `A:{digest,at}`（当前）`B:null`（上一次），
   参考实现也是“新内容写 A、旧 A 滚 B”。本实现按 **CONTRACTS + 参考实现**：内容总是先写 A，
   第二次快照时上一代滚入 B，故 `B/` 保存的是“上一次 dir 内容”，`rollback` 默认从 A 恢复、可 `to:'B'`。
   若 Lead 要求“快照内容固定写 B 槽、A 只存 digest”，改存储策略约 10 行、契约签名不变，收到指令即改。

## 7. 给 Lead 的集成备注

- **CLI 对齐**：`ctx.get('fangApprover').paths` 直接给出
  `{command,answer,pending,status,decisions,dataDir,snapshotsRoot}`，`tools/fangctl.mjs` 不必自己拼路径。
- **跨插件等审批结果**：订阅 kernel `bus` 的 `fang/approval-decided`（payload `{id, outcome}`，
  outcome 含 `timeout`）；或用 `request()` 返回的 Promise。restart-guard（T4）可直接
  `ctx.get(SERVICE.approver)?.request(...)`，无 auditor 时也安全。
- **装载**：`cordis.patch.yml` 里 `fang-approver` 的 5 个 config 键（defaultTtlMs/remindAt/authMode/
  strictRedLine/backupRoot）与 `Config` 完全对应，**无需改 patch**；缺省的 `dataRoot`/`fileBridgePollMs`
  由默认值补齐。`compose.mjs` 的 `ctx.plugin(approver, cfg.approver ?? {})` 也能直接挂载。
- **发现一个 Lead 独占文件的 bug（未擅改）**：`test/helpers.mjs` 的 `tmpDir()` 在 ESM 里用了
  `require(...)`，调用必抛 `ReferenceError: require is not defined`。我在测试里自建 `mkdtemp` 绕过；
  建议 Lead 修成 `import fs/os/path from 'node:...'`（或直接删掉该 helper）。
- **无 profile / 参考仓库写入**：测试只写 `%TEMP%` 下的临时 `dataRoot`；`apply(makeCtx())` 零写入；
  `dsh-hot-update` 只读参考，未写入。