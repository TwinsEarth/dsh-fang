# 重启守卫 · Supervisor 契约（v3.1.x）

> 本文是 `fang-restart-guard` 与外部 supervisor 之间的**两阶段契约**。
> 代码：`src/lib/restart-contract.mjs`（纯函数 + 只读磁盘辅助）、`src/plugins/restart-guard.mjs`（写清单）。
> 测试：`test/restart-contract.test.mjs`、`test/restart-guard.test.mjs`、`test/restart-supervisor.test.mjs`、
> `test/restart-watchdog.test.mjs`、`test/restart-status-cli.test.mjs`，
> 以及 `test/orchestrator.test.mjs` / `test/client-http-contract.test.mjs` 的只读 HTTP/UI 用例。

## 0. 当前状态（不要读成「已经能重启」）

| 层 | 状态 | 说明 |
|---|---|---|
| 阶段 1：授权清单 | ✅ 已实现 | 守卫每次 `approved` / `auto-allow` 都原子写一份 durable 清单 |
| 三重门禁中的 armed 校验 | ✅ 已实现 | 清单记录 `guard.mode` / `guard.allowProcessRestart`；未武装（observe 或 allow=false）不放行 |
| 阶段 2：执行回执（构造 + 校验） | ✅ 已实现 | `buildExecutionReceipt` / `verifyExecutionReceipt` 纯函数 |
| 只读验证 API | ✅ 已实现 | `executionContract()` / `approvals()` / `executionStatus()` / `verifyApproval()` |
| supervisor 入口（手动包装） | ✅ 已实现（手动运行） | `tools/restart-supervisor.mjs`；默认 dry-run，不被任何服务/启动项调用 |
| **C 方案：外部看护 watchdog** | ✅ 已实现（手动运行） | `tools/restart-watchdog.mjs`；轮询 `fang.pid`，启动时自动拉起分身，默认 dry-run |
| 宿主 pid 文件 + supervisor 心跳 | ✅ 已实现 | 母体写 `<dataDir>/fang.pid`；watchdog 写 `<stateDir>/supervisor.present` 心跳 |
| 三重门禁交接（guard exit 75） | ✅ 已实现 | enforce + allowProcessRestart + supervisor 在位 ⇒ 批准后 exit(75)；默认三门禁全关 |
| HTTP（只读）/ CLI status / UI 状态展示 | ✅ 已实现（只读） | `GET /fang/api/restart`、`status.restart` 摘要、`fangctl restart-status`；Header 显示 mode 与「红灯自动放行」警告 |
| 重启面板 / 动作按钮 / CLI 动作 | ❌ 未实现 | 没有任何按钮能触发重启；UI 视觉未在真实宿主验证（需重启 Desktop 载入 bundle） |
| 接真实 DSH 启动命令 | ❌ 未实现 | watchdog 需要你提供重启命令（例如 `"E:\\DS\\DeepSeek Harness.exe"`）；没有替你接开机项 |

一句话：**契约、执行入口、C 方案看护都已实现，但默认全部锁死。** 默认 `observe`/`allowProcessRestart=false`，
守卫不写 marker 就不退出；watchdog 不传 `--execute` 就只报告；没有任何进程会自动启动它们。

## 1. 为什么需要契约

只看 bus 事件不行：事件不落盘，进程一重启就没了。
只看退出码 `75` 不行：任何进程都能 `exit(75)`，退出码没有身份。
只看 `pending` 文件也不行：审批文件和执行权没有绑定。

所以把「批准」变成一份 durable 的**授权清单**，把「执行过」变成一份 durable 的**执行回执**：

```
             阶段 1（守卫写）                        阶段 2（supervisor 写）
审批通过 ──▶ approved/<id>.json ──▶ supervisor 校验 ──▶ 执行重启 ──▶ executed/<id>.json
             execution.executed:false                          execution.executed:true
```

两条硬规则：

1. **「已经执行」只认回执里的 `execution.executed === true`。** 清单里的 `executed` 恒为 `false`，因为守卫是决策层、从不执行。

> 准确表述：
> - **已执行** = 回执 `execution.executed === true`（严格布尔；`false` / 缺失 / 字符串 `"true"` 都判为未执行）；
> - **可执行** = 清单 `execution.executed === false` ∧ `isArmedManifest()`（`guard.mode === 'enforce'` ∧ `allowProcessRestart === true`）∧ digest/TTL 校验通过 ∧ 没有已存在回执 ∧ supervisor 的 pid 绑定匹配；
> - 两者是不同文件里的不同字段，不能互相替代。
2. **supervisor 动进程前必须校验清单**：digest、有效期、`executed===false`、`decisionOnly===true`、且没有已存在的回执（防重复执行）。

## 2. 文件布局

```
<dataDir>/restart/
├── state.json                 守卫状态机（已有）
├── approved/
│   ├── <requestId>.json       阶段 1：授权清单（每份批准一个文件）
│   └── latest.json            便利指针；不是执行依据，损坏也不影响校验
└── executed/
    └── <requestId>.json       阶段 2：执行回执（没有 supervisor 时目录为空）
```

- `<dataDir>` = `resolveFangLayout({dataRoot}).dataDir`，由插件配置 `dataRoot` 决定。
- `requestId` = `rst_...`；清单里的 `id` 必须与文件名一致（`expectedId` 校验）。
- 清单与回执都是**原子写**目标：清单由守卫用 `writeJsonAtomic` 写；回执由未来的 supervisor 原子写（本版本没有写入者）。
- `<requestId>` 进入路径前必须通过 `isManifestId()`；非法 id 直接返回 `null`，绝不拼路径。

## 3. 阶段 1：授权清单

路径：`approved/<id>.json`。由守卫在 `outcome ∈ {approved, auto-allow}` 时写。

| 字段 | 类型 | 含义 |
|---|---|---|
| `version` | `1` | 契约版本 |
| `kind` | `"fang-restart-approval"` | 固定 |
| `id` | `rst_...` | restart request id |
| `nonce` | 64 位 hex | 32 字节随机数；回执必须回传同一个 nonce |
| `risk` | `blue\|yellow\|red` | 服务端分级后的风险（显式低报不能压低） |
| `outcome` | `approved\|auto-allow` | 人工批准 / 策略放行 |
| `approvalId` | string\|null | 审批工单 id；`auto-allow` 可为 null |
| `approvedBy` | string\|null | 审批人；`auto-allow` 可为 null |
| `reason` / `scope` / `origin` | string | 请求语义（审计用） |
| `digests` | string[] | 请求携带的摘要（证据，不是本契约的签名） |
| `impactSource` | `caller\|service\|null` | 影响面由谁收集 |
| `requestedAt` / `approvedAt` / `expiresAt` | number | 毫秒时间戳；`expiresAt = approvedAt + ttlMs` |
| `guard.mode` | `observe\|enforce` | 守卫层模式；supervisor 只认 `enforce` |
| `guard.authMode` | `manual\|temp\|auto` | 决策矩阵授权模式 |
| `guard.strictRedLine` | boolean | 红灯是否必须人工确认 |
| `guard.allowProcessRestart` | boolean | 第二把钥匙；写清单时记录，supervisor 只认 `true` |
| `guard.decisionOnly` | `true` | 恒 true |
| `guard.pid` | number\|null | 写下清单的宿主进程 pid |
| `guard.instanceId` | string\|null | 本次 apply 的随机实例 id |
| `execution.executed` | `false` | **守卫没有执行**（唯一取值） |
| `execution.decisionOnly` | `true` | 恒 true |
| `execution.plannedExitCode` | `75` | 与 `forker.classifyExit` / supervisor 退出码契约对齐 |
| `execution.executedBy` | `null` | 守卫没执行，所以没有执行者 |
| `digest` | `sha256:...` | 对去掉 `digest` 的 body 做 canonical JSON 后的 sha256 |

TTL：配置 `manifestTtlMs`，默认 **60 000 ms**，夹在 `[1 000, 900 000]`。
验证时同样拒绝 `expiresAt - approvedAt > 900 000` 的清单（防止手写长期授权）。

## 4. 阶段 2：执行回执

路径：`executed/<id>.json`。**只有真的完成了重启的 supervisor 才能写。**

| 字段 | 类型 | 含义 |
|---|---|---|
| `version` / `kind` | `1` / `"fang-restart-execution"` | 固定 |
| `id` / `nonce` | 与清单一致 | 把回执绑定到这一次授权 |
| `manifestDigest` | `sha256:...` | 与清单 `digest` 一致 |
| `approvedAt` | number | 清单的批准时间（便于只读核对） |
| `execution.executed` | `true` | **唯一执行证明**；`false` / 缺失 / 字符串 `"true"` 都不算 |
| `execution.executedBy` | 非空 string | 执行者标识（≤128 字符） |
| `execution.supervisorPid` | number\|null | supervisor 进程 pid |
| `execution.at` | number | 实际执行时刻；必须落在 `[approvedAt, expiresAt)` 内 |
| `execution.exitCode` | number | 目标进程退出码（默认 75） |
| `digest` | `sha256:...` | 同清单的 canonical digest |

注意：回执的**有效性按执行时刻判定**。清单后来过期了，回执仍然是有效的执行证明——因为事情已经发生了。

## 5. 校验规则

### 5.1 supervisor 执行前（唯一放行入口）

`verifyRestartAuthorization(manifest, {now, expectedId, receipt, requireArmed = true})`：

| # | 条件 | 失败 reason |
|---|---|---|
| 1 | 清单形状/版本/kind/id/nonce/risk/outcome/approvalId 合法 | `invalid-shape` / `unsupported-version` / `wrong-kind` / `bad-id` / `bad-nonce` / `bad-risk` / `bad-outcome` / `missing-approval-id` |
| 2 | `requestedAt <= approvedAt < expiresAt`，且 TTL ≤ 15 min | `bad-timestamps` / `ttl-too-long` |
| 3 | `execution.executed === false` | `guard-executed` |
| 4 | `execution.decisionOnly === true` | `not-decision-only` |
| 5 | `execution.plannedExitCode === 75` | `bad-exit-code` |
| 6 | digest 重算一致 | `digest-mismatch` |
| 7 | `now < expiresAt` | `expired` |
| 8 | **已武装**：`guard.mode === 'enforce'` ∧ `guard.allowProcessRestart === true` | `guard-not-enforce` / `process-restart-disabled` |
| 9 | 没有回执，或回执不能证明执行 | `already-executed` / `invalid-receipt:<reason>` |

第 8 条就是参考实现三重门禁里可以由清单证明的两把钥匙；第三把 `supervisorPresent` 由「校验者本身就是 supervisor」隐含。
第 9 条是 **fail-closed**：回执文件存在但不可信（损坏、`executed:false`、nonce 不匹配）时，不是「当作没执行」再执行一次，而是**拒绝执行**。

### 5.2 执行后（任何读取方）

`verifyExecutionReceipt(receipt, {manifest})`：

| # | 条件 | 失败 reason |
|---|---|---|
| 1 | 形状/版本/kind/id/nonce | `invalid-shape` / `unsupported-version` / `wrong-kind` / `bad-id` / `bad-nonce` |
| 2 | `execution.executed === true` | `not-executed` |
| 3 | `execution.executedBy` 非空 | `bad-executor` |
| 4 | `execution.at` 是有限数字 | `bad-timestamp` |
| 5 | digest 重算一致 | `digest-mismatch` |
| 6 | id/nonce/manifestDigest 与清单一致 | `manifest-mismatch` |
| 7 | `approvedAt <= execution.at < expiresAt` | `receipt-outside-window` |
| 8 | 清单在 `execution.at` 时刻仍有效 | `manifest-invalid:<reason>` |

## 6. 只读 API（`fangRestart` 服务）

```js
executionContract() -> {
  version, decisionOnly, guardExecuted, plannedExitCode, manifestTtlMs,
  approval: {kind, dir, pattern, latest},
  receipt:  {kind, dir, pattern},
  supervisor: {armedWhen:[...], mayExecuteWhen:[...], mustWriteReceipt, receiptRequirements:[...]},
  rule, note,
}

approvals({limit?, now?}) -> {
  contractVersion,
  items: [{id, found, state, risk, outcome, approvalId, approvedBy, approvedAt, expiresAt,
           digest, expired, executed, authorized, armed, stale, receiptState, blockedReason, reason}],
  counts: {total, authorized, executed, stale, notArmed, invalid},
}
// state: authorized | executed | stale | not-armed | invalid | invalid-receipt | missing
// not-armed = 清单有效但没满足 mode=enforce + allowProcessRestart=true，supervisor 不得执行

executionStatus(id, {now?}) -> {
  id, found, valid, expired, executed, authorized, stale, armed, receiptState, blockedReason,
  manifest, receipt, manifestVerification, receiptVerification,
  reason?,  // bad-id / not-found
}

verifyApproval(id, {now?}) -> {
  id, found, ok, reason, expired, digestValid, armed, authorized, executed, stale, receiptState,
}
// ok === true 仅表示「现在可以交给 supervisor 执行」；
// executed 的授权 ok=false, reason=already-executed；未武装的授权 ok=false, reason=guard-not-enforce|process-restart-disabled
```

这些方法**只读**：不写 state.json、不写审计、不改内存状态机。测试里有断言。

## 7. Fail-closed 行为表

| 场景 | 行为 |
|---|---|
| 清单写盘失败 | 本次批准降级为 `denied`，`reason:'manifest-write-failed'`；不发 `fang/restart-approved` |
| 清单 digest 不匹配 | `verifyApproval().ok=false`，`executionStatus().authorized=false` |
| 清单过期 | `expired=true` / `stale=true`，不授权 |
| 清单未武装（observe 或 allowProcessRestart=false） | `armed=false`，`ok=false`，state=not-armed；不授权 |
| 清单缺 approvalId 但 outcome=approved | `missing-approval-id` |
| 回执 `executed!==true` | 视为未执行；同时**阻止再次执行**（`invalid-receipt`） |
| 回执 nonce/manifestDigest 不匹配 | `manifest-mismatch`，阻止执行 |
| 回执执行时刻在清单窗口外 | `receipt-outside-window`，阻止认定 |
| 同一请求已有有效回执 | `already-executed`，不重复执行 |

## 8. 信任边界（必须写清楚）

- **digest 只提供完整性，不提供真实性。** 能写 `<dataDir>/restart/approved/` 的人可以写一份 digest 自洽的假清单。
- 当前的信任边界是**本机文件系统 ACL**，不是密码学签名。
- `nonce` 不是秘密；它的作用是绑定回执、防跨授权复用，不防伪造。
- `guard.pid` / `instanceId` 只是线索，supervisor 入口将来应校验「这份清单来自它正在看守的那个子进程」，但本版本没有入口，也没有校验。
- 签名 / HMAC / 进程身份绑定都是后续加固项，**现在没有**。

## 9. 未完成（按顺序）

1. **真实启动命令 + 是否启用**：C 方案 watchdog 已实现，但「用什么命令重启 DSH」仍要用户提供（如 `"E:\\DS\\DeepSeek Harness.exe"`），并且是否真的以 `--execute` 运行仍由用户决定；没有开机项/服务项。
2. **启动对账**：新宿主启动后检查上一实例的清单 + 回执，只把 `execution.executed===true` 记为「已执行」，其余记为 stale/interrupted。
3. **动作按钮 / 重启面板 / CLI 动作**：只读 HTTP 与 Header 状态已做；按钮仍不做——在入口接入真实启动方式之前，按钮只能改状态、不能真重启，会制造「门禁开了、重启没发生」的假象。
4. 退出码 75 与 DSH 自身退出码冲突核对；崩溃循环时间窗；签名/HMAC；旧清单清理（当前不自动 prune）。

## 10. supervisor 入口（`tools/restart-supervisor.mjs`）

定位：**执行侧入口，独立工具，手动运行**。它不改变 DSH 启动方式、不写服务/启动项、不被任何插件调用；
只监督你显式交给它的那条命令。默认 **dry-run**：验证通过也只报告 `would-restart`，不重启。

```powershell
# dry-run（默认）：只跑到子进程退出 75、验证授权，然后停下
node tools/restart-supervisor.mjs --data-root E:\fang-data -- node app.mjs

# 真正允许重启（仍需清单 armed + 未过期 + pid 匹配 + 无回执）
node tools/restart-supervisor.mjs --execute --data-root E:\fang-data -- node app.mjs
```

| 选项 | 默认 | 含义 |
|---|---|---|
| `--execute` | 关 | 真正重启；不传就是 dry-run |
| `--data-root` | `resolveFangLayout()` | 找 `<dataDir>/restart/` 的位置 |
| `--max-restarts` | 5 | 重启次数上限（0..20） |
| `--backoff-ms` / `--backoff-max-ms` | 300 / 30000 | 指数退避基数与上限 |
| `--supervisor-id` | `fang-restart-supervisor` | 写进回执 `executedBy` |
| `--log` | `<dataDir>/restart/supervisor.jsonl` | 监督事件日志 |

重启判定（缺一不可）：

| 条件 | 结果 |
|---|---|
| 子进程退出码 ≠ 75 | `clean-exit` / `non-gated-exit`，不重启 |
| 退出码 75，但没有可执行授权 | `restart-denied`，不重试 |
| 退出码 75 + 授权通过 + dry-run | `dry-run`，只记录 `would-restart` |
| 退出码 75 + 授权通过 + `--execute` | 退避后 spawn 替换进程，写执行回执 |
| `restarts >= maxRestarts` | `max-restarts`，停止 |
| 替换进程 spawn 失败 | `replacement-spawn-error`，不写回执 |
| 回执写盘失败 | `receipt-write-failed`，立即停止（不留无法核对的执行） |

关键细节：

- **pid 绑定**：清单的 `guard.pid` 必须等于刚退出的子进程 pid；拿别的实例的旧批准不能触发重启。
- **回执只在替换进程 spawn 成功后写**，并记录 `previousPid` / `replacementPid`；写失败即停止。
- 信号转发：SIGINT / SIGTERM 原样转发给当前子进程。
- 命令只接受 argv 数组（`--` 之后），不接受 shell 字符串。

### 10.1 C 方案：外部看护（`tools/restart-watchdog.mjs`）

定位：**不改 DSH 启动方式，只旁路观察宿主**。它不包装命令，只轮询母体写的 `<dataDir>/fang.pid`：

```text
宿主活着   → 继续观察（execute 模式同时续写 <stateDir>/supervisor.present 心跳）
           → 首次确认宿主存活时，调用 POST /fang/api/forks/autostart 拉起已登记但没在跑的分身
宿主死了   → 只读校验 approved/<id>.json（armed/未过期/pid 匹配/无回执）
             没有可执行授权 → 不干预，退出
             有授权 + dry-run（默认） → 只报告 would-relaunch
             有授权 + --execute      → spawn `--` 之后的命令，等新 pid 出现，写执行回执，继续看护
```

```powershell
# dry-run：只观察，不写 marker，不重启（--autostart-forks 可显式要求报告分身自动启动）
node tools/restart-watchdog.mjs --data-root E:\fang-data -- "E:\DS\DeepSeek Harness.exe"

# 真看护：写 supervisor.present → 守卫三重门禁才可能关门；默认同时自动拉起分身
node tools/restart-watchdog.mjs --execute --data-root E:\fang-data -- "E:\DS\DeepSeek Harness.exe"
```

| 选项 | 默认 | 含义 |
|---|---|---|
| `--execute` | 关 | 写 marker + 真正重启；不传就是 dry-run |
| `--data-root` | `resolveFangLayout()` | 找 `fang.pid` 与 `<dataDir>/restart/` |
| `--pid-file` | `<dataDir>/fang.pid` | 宿主 pid 文件（JSON `{pid}` 或纯数字） |
| `--state-dir` | `<dataDir>/restart` | 清单/回执/日志目录 |
| `--poll-ms` | 2000 | 轮询间隔（秒级窗口的来源） |
| `--max-relaunches` | 3 | 重启次数上限 |
| `--startup-timeout-ms` | 60000 | 重启后等新 pid 出现的上限 |
| `--autostart-forks` / `--no-autostart-forks` | 随 `--execute` | 启动时自动拉起分身；dry-run 下只报告 |
| `--mother-url` | `<dataDir>/endpoint.json` | 母体 HTTP 地址 |
| `--token` | env `DSH_FANG_AUTH_TOKEN` / `<dataDir>/fang-auth.json` | 母体鉴权 token |
| `--supervisor-id` | `fang-restart-watchdog` | 写进回执 `executedBy` |

分身自动启动（`POST /fang/api/forks/autostart`）：

- 只拉起「已登记但进程没在跑」的**非归档**任务；归档任务跳过，仍在运行的任务跳过；
- 不创建新任务，失败任务不重试（避免崩溃循环），只写 `failed` 报告；
- watchdog 只在启动后首次确认宿主存活时调用一次；失败重试 3 次后放弃并记日志；
- 调用需要母体 token：watchdog 读 `endpoint.json` + `fang-auth.json`，不猜端口。


三重门禁与交接：

```text
守卫侧：mode==='enforce' ∧ allowProcessRestart===true ∧ supervisor 在位
        ⇒ 写清单 + 审计 + approved 事件，然后 exit(75)
看护侧：见宿主 pid 死亡 + 清单可执行 ⇒ spawn 重启命令
        ⇒ 等新 pid 写回 fang.pid ⇒ 写 executed/<id>.json（execution.executed=true）
```

- `supervisor.present` 只在 `--execute` 时写，每轮刷新 `at`；守卫要求 `execute===true`、60s 内、写入进程仍存活，幽灵 marker（watchdog 崩溃）不会放行。
- 未确认到新 pid 时仍写回执（执行确实发生），但 `replacementPid=null` 并停止继续看护，不猜进程。
- 回执写失败 => 立即停止（fail-closed），不继续制造无法核对的执行。
- 看护进程退出/abort 时删除自己的 marker；不改变 DSH 启动方式，不写服务/启动项。

## 11. 只读 HTTP 与界面展示

HTTP（都需要宿主现有的 Host/Origin/token 门禁）：

| 路由 | 内容 |
|---|---|
| `GET /fang/api/restart` | `{ ok, available, state, policy, contract, approvals, decisionOnly, executed:false }`；无守卫时 `available:false` |
| `GET /fang/api/status` | 新增 `restart` 摘要：`state / pending / mode / authMode / strictRedLine / redLineAutoAllowed / allowProcessRestart / tempEffectiveManual / contractVersion / manifestTtlMs / approvals.counts` |

CLI（只读，不触发执行；与上面同一投影 `readRestartStatus`）：

```powershell
# offline：直接读 <dataDir>/restart
node tools/fangctl.mjs restart-status --data-root <dir>
node tools/fangctl.mjs restart-status 20 --data-root <dir> --json

# 运行中的宿主：验证是否已载入新 bundle（旧 bundle 会 404 并明确提示）
node tools/fangctl.mjs restart-status --url http://127.0.0.1:<port> --token <token>
node tools/fangctl.mjs restart-status --url http://127.0.0.1:<port> --token <token> --json
```

offline 输出：状态机 state / pending / lastInterrupted、清单计数（authorized/executed/stale/notArmed/invalid）、
清单表（id/risk/outcome/state/approvalId/expiresAt）。remote 输出：state/mode/authMode/strictRedLine/armed/计数。
两种模式都固定打印 `decision-only; no execution`；状态文件缺失时输出 `unknown`，不伪造 `idle`。

界面（Client Header，展示层，无动作）：

- Stats 增加「重启守卫」：显示 `mode`（observe/enforce）；`strictRedLine=false` 时标红。
- `strictRedLine=false` 时 Header 显示 warn chip「红灯自动放行」；tooltip 明确：这只到决策层，
  `execution.executed` 恒为 false，真正重启仍由外部 supervisor 的 armed 清单决定。
- 不提供任何重启/执行按钮，也没有「一键放行」；所有写操作仍只走审批 + 外部 supervisor。

测试：

- `test/orchestrator.test.mjs`：`status().restart` 摘要、`GET /fang/api/restart` 只读返回；
- `test/client-http-contract.test.mjs`：源码级锁定 restart 摘要与「红灯自动放行」警告必须存在；
- `test/restart-status-cli.test.mjs`：`readRestartStatus` 投影（unknown/计数/limit/只读）、`fangctl restart-status` 的 JSON 与人读输出、`--url` remote 模式与旧 bundle 404 提示。

未验证：真实浏览器视觉。新 bundle/客户端改动要重启 DSH Desktop 后才会载入，本会话无法代替人工查看。

## 12. 测试

```powershell
cd dsh-fang
node --test --test-concurrency=1 test/restart-contract.test.mjs   # 契约纯函数/磁盘辅助 10 项
node --test --test-concurrency=1 test/restart-guard.test.mjs      # 守卫 + 清单 + 三重门禁交接 30 项
node --test --test-concurrency=1 test/restart-supervisor.test.mjs # 执行侧入口 11 项
node --test --test-concurrency=1 test/restart-watchdog.test.mjs   # C 方案外部看护 9 项
node --test --test-concurrency=1 test/restart-status-cli.test.mjs # HTTP/CLI 只读投影 7 项
```

覆盖点：

- 清单形状、TTL 夹取、canonical digest 确定性；
- 每个校验失败 reason（含 `guard-executed`、`ttl-too-long`、`digest-mismatch`、`expired`、`guard-not-enforce`、`process-restart-disabled`）；
- 回执只认 `executed===true`（`false` / 缺失 / 字符串 `"true"` 都拒绝）；
- `already-executed` / `invalid-receipt` 的 fail-closed；
- 路径穿越、损坏 JSON、`latest.json` 不参与枚举；
- 守卫落盘清单、`approvals/executionStatus/verifyApproval` 只读（state 文件与审计均不变）；
- 未武装的批准照常落盘但永不授权；
- 清单写不进去时 `denied manifest-write-failed` 且不发 approved 事件；
- pid 文件生命周期（apply 写、dispose 删）；supervisor marker 校验（dead pid / stale / execute:false 一律不算）；
- 三重门禁：enforce + allowProcessRestart + marker 才 `executionArmed`；子进程集成测试验证 armed 时 exit 75、disarmed 时 exit 0；
- supervisor：argv 解析、pid 绑定、dry-run 不重启、denied 不重试、非 75 不重启、max-restarts、spawn 失败、回执写盘；
- supervisor 端到端：真实子进程写出自己的 pid，测试为该 pid 写清单，执行后回执里 `previousPid`/`replacementPid` 正确；
- watchdog：dry-run 只报告、无授权不干预、max-relaunches、execute 重启后等新 pid 并写回执（previousPid/replacementPid）、marker 生命周期；
- watchdog 分身自动启动：`endpoint.json`/`fang-auth.json` 发现、POST `/fang/api/forks/autostart` 只调一次、dry-run 不发请求；
- orchestrator：`autostartForks` 拉起 stopped 任务、跳过 archived/already-running、HTTP 路由可用。

## 13. 加固：HMAC 签名 / 启动对账 / 旧清单 prune

### 13.1 清单签名（HMAC-SHA256）

```text
key 来源优先级：
  1) env FANG_RESTART_HMAC_SECRET（>= 32 字符）
  2) <stateDir>/restart-hmac.key（0600；守卫首次启动自动生成）
  3) 都没有 => digest-only（兼容旧部署，但会 warn；supervisor 不强制签名）

清单：signature = HMAC-SHA256(canonical(body 去掉 digest/signature))
      digest    = sha256(canonical(body + signature))
校验顺序：形状/门禁 → HMAC（若本机有 key）→ digest → TTL
```

- supervisor / watchdog 只要本地存在 key（env 或文件）就 `requireSignature=true`：无签名或签名错一律拒绝，reason=`missing-signature` / `signature-mismatch`；
- 本机没有 key 时保持 digest-only 兼容，不假装验签；
- digest 仍只提供完整性；HMAC key 的信任边界是文件 ACL/env，不是本仓能解决的。

### 13.2 启动对账

守卫 apply 时调用 `reconcileRestartState(stateDir)`（只读）并审计 `restart-reconcile`：

```text
armed / not-armed / executed / invalid-receipt / stale / invalid
```

- 有回执且 `execution.executed===true` => executed；
- 过期且无回执 => stale；
- 签名/摘要/形状错误 => invalid；
- 只写审计，不删除、不授权、不执行。

### 13.3 旧清单 prune

守卫 apply 时调用 `pruneRestartState(stateDir, { retentionMs=7d, keep=20 })`：

- 删除 `stale / invalid / invalid-receipt / executed` 且超过 retention 的清单与回执；
- 始终保护最新 `keep` 份 + `latest.json` 指针；指针指向被删项时改指剩余最新，没有则删指针；
- 移除项审计 `restart-manifest-pruned`；失败只 warn，不阻塞 host。

### 13.4 真实启动方式接入（未完成）

- C 方案 watchdog 需要**宿主启动时由桌面壳/快捷方式拉起**（例如 `--execute --data-root <dir> -- "…Harness.exe"`）；
- 本仓只提供 `tools/restart-watchdog.mjs` 与契约，**没有修改 DSH Desktop 启动入口**，也没有在真实桌面壳里验证；
- UI 视觉/人工验证同样未完成：需要重启 DSH Desktop 加载新 bundle 后人工确认。

### 13.5 测试

```powershell
node --test --test-concurrency=1 test/restart-contract-hmac.test.mjs  # HMAC/对账/prune 5 项
```

