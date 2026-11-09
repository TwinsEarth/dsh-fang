# 瓮城·决策中心（Decision Center）

> 把「人类注意力」作为最稀缺资源调度。只有红色允许阻塞 Agent；黄色、蓝色、绿色进入异步收件箱；灰色由过期/放弃自动归档，原始严重度保留在 `originalLevel`。

## 1. 五色模型

| 等级 | 语义 | Agent 行为 | UI 行为 |
|---|---|---|---|
| `red` | 重要且紧急 | 默认阻塞等待 `resolve` | 置顶、强提醒 |
| `yellow` | 重要不紧急 | 可继续 | 显眼但不阻塞 |
| `blue` | 不重要不紧急 | 按推荐继续 | 后台记录 |
| `green` | 汇报 | 直接继续 | 默认折叠 |
| `gray` | 已过期/已放弃 | 不再处理 | 默认折叠归档 |

## 2. DecisionTicket

```js
{
  id,
  level: 'red'|'yellow'|'blue'|'green'|'gray',
  status: 'pending'|'resolved'|'expired'|'abandoned',
  source: {
    sessionId,
    agentRole: 'pm'|'pjm'|'worker'|'system',
    roleSource: 'host:<path>'|'caller-reported'|'caller-string'|'service'|'default',
    roleTrusted: boolean,        // 只有 host:* 为 true
    reportedRole?,
    derivedId,
    taskName
  },
  title,
  context,
  options: [{ value, label, isRecommended? }],
  createdAt,
  expiresAt,
  resolvedAt,
  resolvedOption,
  outcome: 'resolved'|'expired'|'abandoned'|'acked'|null,
  originalLevel,
  selectedActionId,
  resolvedPayload,
  resolvedBy,
  resolutionNote,
  isBlocking,
  execution: { status:'running'|'done'|'failed', actionId, payload?, result?, error?, startedAt, finishedAt? } | null
}
```

## 3. 生命周期

```text
create()
  ├─ pending
  ├─ 过期（expiresAt）→ expired + level=gray
  ├─ resolve(option) → resolved
  └─ abandon() → abandoned + level=gray
```

进程重启时，持久化的 `pending` 会恢复为 `expired/gray`，因为原 Promise 已不存在；不会假装还能继续等待。

## 4. 服务 API

```js
ctx.get('fangDecisionCenter')
  .submit(input)          // design-style: description/actions/payload/source string
  .create(input)          // native shape: context/options/source object
  .list({ includeArchived })
  .get(id)
  .resolve(id, option, { by, note })
  .resolveAction(id, actionId, payload, { by, note })
  .resolveMany(ids, { option, by, note }) // 批量按推荐处理；无选项的绿色 ticket 记为 acked
  .abandon(id, { by, note })
  .registerActionHandler(actionId, handler) // 特殊动作执行钩子；返回 unregister
  .listActionHandlers()
  .wait(id, signal)       // 返回结构化 ticket，而不是裸字符串
  .expire(id)
  .cleanupExpired()
  .aiStatus()
  .configureAi({ provider, apiKey, model, baseUrl })
  .advise(id)
  .policy()
  .status()
```

`wait()` 返回：

```js
{ id, outcome: 'resolved'|'expired'|'abandoned'|'acked',
  resolvedOption, selectedActionId, resolvedPayload, level, status }
```

控制哨兵不再写进 `resolvedOption`；`__ACK__` 只作为无选项绿色 ticket 的内部确认值。

### 4.1 特殊动作执行钩子

```text
resolveAction(id, 'confirm_restart', payload)
  → 先完成 ticket 状态落库
  → 若该 actionId 已注册 handler：ticket.execution={status:'running',actionId,payload,startedAt}
  → 异步执行 handler({ticket,payload})（不阻塞 resolve 返回）
  → 成功：execution={status:'done',result,finishedAt}；审计 decision-action-executed
  → 失败：execution={status:'failed',error,finishedAt}；审计 decision-action-failed
不注册 handler => 只落库，不执行（显式、安全）。
```

仓内唯一注册：**decision-center 内建注册 `confirm_restart`**（不依赖 orchestrator 是否已加载），调用 `restart-guard.request(...)`；orchestrator 启动时再注册同名 handler 作覆盖（行为一致）。重启仍受 restart-guard 自己的审批/三重门禁约束，决策中心只负责触发，不直接重启。

- `ticket.execution` 通过 API 与收件箱 chip 可见（执行中/已执行/失败）；
- **默认配置下不会真的重启**：restart-guard 默认 `mode=observe`、`allowProcessRestart=false`、无 supervisor；此时点击「立即重启」= ticket resolved + restart 请求被 guard 按策略记录/拒绝，`ticket.execution.result` 如实反映；
- 只有 `mode=enforce ∧ allowProcessRestart=true ∧ supervisor 在位` 才可能 exit(75) 交给外部看护重启；这不是决策中心能绕过的。

### 4.2 API 兼容（设计稿 → 实现）

| 设计稿 | 实现 |
|---|---|
| `submit(item)` | ✅ `submit(item)`（`create` 是原生 shape 别名） |
| `resolve(id, actionId, payload)` | ✅ 支持：第三参不是 `{by,note,payload}` 且 actionId 命中时，按 `resolveAction` 处理并保留 payload |
| `resolve(id, optionValue, {by,note})` | ✅ 保留 |
| `actions[].payload` | ✅ `submit` 映射到 option.payload；`resolveAction` 写入 `resolvedPayload` |
| `content` | ✅ `submit` 把 content 映射到 context |
| `source: 'PM'|'PJM'|'System'|'SuperAgent'` | ✅ 映射为小写 `agentRole`；原始字符串保留在 `source.rawSource` 供展示 |
| 批量入口 | ✅ `resolveMany(ids)` + `POST /api/decisions/resolve { ids }`；abandon 同理 |
| 特殊动作 | ✅ `registerActionHandler` + 内建 `confirm_restart` → restart-guard |

## 5. HTTP

```text
GET  /fang/api/decisions?includeArchived=1
POST /fang/api/decisions/resolve   { id, option, by, note }
POST /fang/api/decisions/resolve   { ids: [...], option?, by, note }  // 批量
POST /fang/api/decisions/abandon   { id, by, note }
```

## 6. Agent 工具

```js
request_human_decision
```

支持两种语义：

- 原生：`context` + `options`
- 设计稿：`description` + `actions[].payload`（由 `submit()` 映射）

只有 `red` 允许阻塞；黄/蓝的 `isBlocking` 会被忽略。`red` 默认阻塞，`isBlocking:false` 可显式关掉。

## 7. UI：独立收件箱（独立侧边栏 + 右侧抽屉）

决策中心不再是「瓮城」主面板顶部的一块 notice，而是一个独立收件箱：

| 部位 | 实现 |
|---|---|
| 独立侧边栏入口 | `sidebar.footer.action` seat：收件箱图标 + 未读红点/计数 |
| 右侧抽屉 | 优先 DSH 右侧 pane tab：`sidebarRightTabs.register({id,kind,...})` + `sidebar.right.pane.tab` / `.title`，点击 `ctx.sidebarRight.openTab(kind)` |
| 抽屉回退 | 宿主没有 right pane 服务时，自己渲染固定右侧 drawer + backdrop + Esc 关闭 |
| 主面板兜底入口 | Header「收件箱」按钮；主面板不再渲染决策中心 |
| 主面板清理 | 已删除旧的 `renderDecisionCenter()`；完整决策中心只存在于独立收件箱；右侧工作区顶部的 `renderDecisionMini()` 只是精简提醒，不是完整决策中心 |
| 分组 | 红/黄/蓝/绿/灰（灰=过期/归档），可逐组折叠；绿/灰默认折叠 |
| 未读计数 | pending ticket 数：侧栏 badge + tab title + 收件箱标题 |
| 键盘导航 | ↑↓ / j k 选行；Enter 处理（推荐→首个选项→ACK）；X 勾选；A 全选可推荐；R 刷新；Esc 清空选择/关闭 |
| 批量操作 | 处理选中（`resolveMany` 按推荐）、全选（全部 pending）、全选可推荐、归档选中（`abandonMany`）、清空选择 |
| 批量确认弹窗 | 处理/归档前弹窗：显示数量、红色/阻塞项提醒、前 3 项标题预览；Esc/取消不执行 |
| 批量失败逐条 UI | 服务端 `results[]` 逐条展示失败 ticket 标题 + 原因（如 `explicit-choice-required`），支持「重试失败项」 |
| AI 建议 | 配置表单 + 逐条「AI 建议」迁到抽屉；Key 仍只存宿主内存 |

边界：UI 只是展示/提交入口，权限复用宿主 HTTP 认证；没有「一键重启」之类越过审批的动作。

### 7.1 实时推送、未读与红色强提醒

```text
SSE: GET /fang/api/decisions/events
  - 路由复用 Host/Origin/token 门禁（fetch 流可带 x-fang-auth；EventSource 不行，故客户端用 fetch 流）
  - 首帧 ready { rev, counts }；之后 ticket { type: created|updated, ticket }；每 15s ping
  - 客户端断线 2.5s 重连；SSE 正常时轮询自动停用（掉线时才低频兜底）
```

- **bus 订阅**：orchestrator 在 SSE 流里订阅 `fang/decision-created` / `fang/decision-updated`，客户端断开即退订，最多 20 条并发流；
- **未读计数**：口径 = 全部 pending ticket 数（不含已处理/归档）；侧栏 badge、右侧 tab 标题、收件箱标题三处共用，打开收件箱不会把计数清零；`seenRev` 仍存在 localStorage，仅用于新 ticket 提醒去重（不参与 badge 计数）；
- **红色强提醒**：收到新的 pending red ticket（且收件箱不在可见区）时：
  - 页面顶部红色横幅（标题/上下文/打开收件箱）；
  - 侧栏 badge 脉冲；
  - `document.title` 前缀「● 红色决策」10s；
  - 仅当用户已授权 `Notification` 时发系统通知（权限在点击收件箱时申请）。
- AI 建议通过同一条 SSE 的 `fang/decision-updated` 实时出现，无需等轮询。

## 7.1 AI 顾问

支持的 OpenAI 兼容 provider 预设：

| provider | 默认 Base URL | 默认模型 |
|---|---|---|
| deepseek | `https://api.deepseek.com/v1` | `deepseek-flash` |
| kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| glm | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| doubao | `https://ark.cn-beijing.volces.com/api/v3` | 需填 endpoint id |
| qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| yuanbao | `https://api.hunyuan.cloud.tencent.com/v1` | `hunyuan-turbos-latest` |

接口：

```text
GET  /fang/api/decisions/ai
POST /fang/api/decisions/ai/test     { provider, apiKey, model?, baseUrl? }   # 只测试，不保存
POST /fang/api/decisions/ai/config   { provider, apiKey, model?, baseUrl? }   # 保存并启用
POST /fang/api/decisions/ai/advise   { id }
```

### Key 持久化（OS 钥匙串 / DPAPI）

```text
persistAiKey = true（默认）
  win32  -> DPAPI（用户级）：PowerShell ProtectedData.Protect/Unprotect
            <dataDir>/decision-ai-secret.enc   （base64 密文，secret 走 stdin，不进程 argv）
            <dataDir>/decision-ai-secret.json  （backend/provider/model/baseUrl/updatedAt，无 Key）
  linux  -> secret-tool（Secret Service；secret 走 stdin）
  darwin -> 未实现：backend=unavailable，明确退回仅内存
  backend 不可用 -> available=false，绝不写明文文件
```

- 保存/读取失败都不阻塞 AI 使用：内存里的配置继续有效，`aiStatus().persistence` 如实返回 `backend/available/saved/reason`；
- 启动时 env `FANG_AI_API_KEY` 优先；否则从 OS backend 恢复（没有元数据文件不探测 backend，零开销）。

### P0 安全加固（AI endpoint / 响应）

| 风险 | 处理 |
|---|---|
| 非 loopback 使用 `http://` | 拒绝：远程必须 HTTPS；`localhost`/`127.0.0.1`/`[::1]` 例外 |
| URL 带 userinfo（`user:pass@`） | 拒绝（`base-url-userinfo-forbidden`） |
| 重定向到第三方 | `fetch(..., { redirect:'error' })`，不跟随 |
| 响应体过大 | **硬上限 64KB**：Content-Length 超限直接拒绝（不读 body）；无 length 时流式读到 64KB 立即 `reader.cancel()`；只有 `text()` 的旧/测试实现降级截断 |
| Key 泄漏 | Key 不进 URL/状态/日志/审计；请求头 `Authorization: Bearer`；响应截断前不落盘 |

未做（诚实边界）：没有做私网 IP 的 SSRF 允许/拒绝清单（企业内网 HTTPS AI 网关可能 legitimately 用 10.x），也没有做 DNS rebinding 防护；这些需要单独的 allowlist 设计，不属于当前 P0 表。

### AI 信任边界（8 条）

| 风险 | 处理 | 实现/测试 |
|---|---|---|
| Key 出现在 prompt | 发送前对整段 ticket JSON 做 `sk-* / Bearer / AKIA` redact | 用例：raw secret 不出现在 fetch body |
| 错误体回显敏感信息 | 只返回状态码 / 错误类别；**不返回上游响应体** | 用例：500 body 含 key，结果 JSON 不含 |
| AI 推荐任意字符串 | 必须命中 `options[].value` 或 `ack/ignore`，否则 `null` + `invalidRecommendation` | 既有用例 |
| system / umbrella 安全票 | `agentRole==='system'` 或 source 标签含 `umbrella` → `system-ticket-not-advised`，自动建议也跳过 | 新增用例 |
| 连点重复计费 | 同一 ticket 并发 advise **共享同一 Promise**（single-flight），只发一次请求、只计一次费 | 新增用例 |
| 建议写入时票已处理 | 写入前复核 `status==='pending'` 且 `rev===revAtStart`，否则 `ticket-changed` | 新增用例 |
| 不知道 Key 发往哪 | `aiStatus().endpointHost`；UI 状态行显示「发往 host」 | 源码契约 |
| 建议被误当已核实 | `ticket.ai.trust='unverified'`；UI 标签「AI · 未核实」 | 源码契约 |

未做/边界：

- redact 是正则规则（`sk-*`/`Bearer`/`AKIA`），不是通用密钥扫描器；无法保证覆盖所有自定义 token 格式；
- **ticket 存储本身不脱敏**（上下文要给人看）；只保证发往 AI 的 prompt 已 redact；
- 上游非 2xx 响应体被读取用于判定（受 64KB 上限），但**不会**进入返回值/审计/日志。

### AI 禁止清单（硬约束，不做例外）

> AI 顾问只写 `ticket.ai`；它不是审批者，也不是仲裁者。

1. **不替红色决策选答案**：`advise()` 没有任何 `resolve()`/`abandon()` 调用路径；红色 ticket 建议后仍 `pending`、仍 `isBlocking`，必须人类显式 resolve。
2. **不写 `options[].isRecommended`**：AI 输出只进 `ticket.ai`；ticket.options 在建议前后逐字段不变。
3. **不喂 `resolveMany`**：批量处理只由人类在确认弹窗后触发；`resolveMany` 对红色/阻塞票一律 `explicit-choice-required`，与 AI 置信度无关。
4. **不按 confidence 自动放行**：`confidence` 只存展示值；代码里没有 auto-resolve / auto-allow 分支。
5. **不对 umbrella/system 安全票出建议**：`isSecurityTicket()` 在 advise 入口拒绝（`system-ticket-not-advised`），自动建议队列与积压补建议也跳过。
6. **不当多 Agent 仲裁者**：没有投票/仲裁实现（`service.vote` / `service.arbitrate` 不存在），也不计划做。

测试锁：`decision center: AI advice never resolves, never writes isRecommended, never auto-allows by confidence`。

### 测试连接（保存前真实调用）

```text
POST /fang/api/decisions/ai/test -> { ok, provider, model, endpointHost, latencyMs }
  或 { ok:false, reason, status?, retryAfterMs? }
```

- 只验证候选配置，**不保存、不改变当前配置、不占日配额**；
- UI「测试连接」只测试；「测试并保存启用」会先测试，失败不启用；
- 保留服务端 `configureAi`（env/程序化/HTTP）但不再有「保存即启用但从未调用」的默认路径。

### 日配额 / 熔断 / 429 退避

```text
aiDailyQuota        = 200   （0 = 不限；按本地日期计数，落决定中心 usage 文件）
aiFailureThreshold  = 5     （连续失败 N 次打开熔断）
aiCircuitCooldownMs = 60000 （熔断冷却；429 优先用 Retry-After）
```

- 超配额 / 熔断打开时在发请求前直接返回 `ai-daily-quota-exceeded` / `ai-circuit-open`，不耗网络；
- 429 → `ai-rate-limited` + `retryAfterMs`；HTTP 路由返回 429 并带 `Retry-After`；
- 成功清零连续失败；`aiStatus().quota / circuit / lastError` 可观测。

### 建议 schema v2

AI 输出（模型返回 JSON）：

```json
{
  "summary": "一句话摘要",
  "recommendation": "选项 value 或 ack/ignore",
  "rationale": "理由",
  "confidence": 0.0,
  "optionRisks": [{ "value": "选项 value", "risk": "low|medium|high", "reason": "风险理由" }],
  "missingInfo": ["缺失信息"]
}
```

- `optionRisks` 只保留 ticket 里真实存在的 option value；risk 白名单 `low|medium|high`，越界项丢弃；
- `missingInfo` 最多 10 条、每条 300 字符；
- `ticket.ai.schemaVersion=2`，并保存 `optionRisks / missingInfo`；旧模型只给 summary/recommendation 也能兼容（两个数组为空）；
- 仍然 `trust:'unverified'`，不改变 ticket 状态。

### token / cost 审计

```text
每次 advise 记录 ticket.ai.usage = { promptTokens, completionTokens, totalTokens }
日累计：decision-ai-usage.json 的 promptTokens/completionTokens/costMicros
成本：仅当配置 aiCostInputPerMillion / aiCostOutputPerMillion 时计算 costMicros
      未配置 => costMicros=null（不假装知道价格）
审计：decision-ai-advice 带 promptTokens/completionTokens/costMicros
状态：aiStatus().usage 暴露今日 token/成本
```

### 采纳审计

```text
ticket.aiOutcome = { adopted, recommendation, resolvedOption, outcome, at }
审计事件：decision-ai-adoption
```

- `adopted:true`：人类最终选项 == AI recommendation（`ack` 对 `acked` 也算）；
- `adopted:false`：采纳了别的选项，或把票 abandon 掉；
- `adopted:null`：AI 没给 recommendation（不能算采纳率）；
- 只记录，不改变处理结果；采纳率可在 ticket 明细/审计里查。

### 严格 schema 校验

- 根必须是 JSON object，`summary` 必须是非空字符串；
- `recommendation`/`rationale` 必须是字符串（或 null），`confidence` 必须是 0..1 的数字；
- `optionRisks`/`missingInfo` 必须是数组；
- 任一不满足 → `ai-schema-invalid` + `schemaErrors[]`，**不写 ticket.ai**（该次调用仍计 token/配额，不触发熔断）。

### provider 预设与账号差异

- `doubao`：`model` 必须填你账号的 **endpoint id**（预设留空，缺失会 `model-required`）；
- `yuanbao`：预设只是腾讯混元常见地址/模型，实际可能随账号/区域变化；
- 两者都建议先用「测试连接」；UI「测试并保存启用」会在真实调用失败时拒绝保存，避免把错配置当成功。

### 自动建议范围（autoAdvise=true，且已配置 AI）

- 新 ticket 创建 → 入队；
- 配置 AI 后 → 给积压 pending（无建议、非 system/umbrella）最多 25 条补建议；
- system / umbrella 安全票 → 跳过；AI 未配置 → 完全无动作；
- 并发 2 / 队列 50；建议只写 `ticket.ai`。

### AI 流式输出

```text
POST /fang/api/decisions/ai/advise/stream   { id }
  → text/event-stream
     event: start  { id }
     event: delta  { delta, text }        # 逐 token 增量
     event: done   { advice, ticket }     # 与一次性建议相同的 schema/校验/落库
     event: error  { ok:false, reason }
```

- 服务端 `callAiChatStream()` 解析 provider SSE，把 delta 实时回调；结束后拼回一次性响应形状，复用同一套 schema 校验、配额/熔断、ticket.ai 落库；
- 客户端收件箱「AI 流式」按钮用 fetch 流消费（EventSource 不能带鉴权头），实时显示 `state.aiStream.text`；流式失败自动回落一次性 `/ai/advise`；
- 契约不变：AI 只建议、不改变 ticket 状态；红色仍人类决定。

### AI 多模型 / 多 provider 路由（按 level）

```js
// 同 provider 多模型
service.configureAi({ provider: 'deepseek', apiKey, model: 'base-model',
  modelByLevel: { red: 'reasoner-x', yellow: 'fast-y' } })

// 多 provider / 多 Key
service.configureAi({
  profiles: [
    { id: 'fast', provider: 'deepseek', apiKey, model: 'fast-model' },
    { id: 'strong', provider: 'custom', apiKey, baseUrl: 'https://strong.example.com/v1', model: 'strong-model' },
  ],
  routes: { red: 'strong', yellow: 'fast' },
})
```

- 路由优先级：`routes[level] → profile` > `modelByLevel[level]` > 默认 profile；
- 选择结果写入 `ticket.ai.model`；`aiStatus()` 暴露 `routes`/`profiles`（**不含 apiKey**）；
- 持久化时 profiles/routes 一并加密进 OS 钥匙串（`persistAiKey`）；
- 校验：profile id `[A-Za-z0-9_-]{1,32}`、唯一、最多 8 个；routes 引用不存在的 profile → `unknown-profile`；
- 自动建议/流式/一次性建议共用同一路由函数。
- **私网 http 端点**：默认只允许 loopback http；公网必须 https。需要内网 AI 网关时用 `aiPrivateHosts` 显式列精确 hostname/IP（通配/URL/端口会被过滤），见 [AI-PRIVATE-ALLOWLIST.md](AI-PRIVATE-ALLOWLIST.md)，`aiStatus().privateHosts` 可查生效值。
- **SSRF 防护**：私网/元数据字面量地址拒绝；metadata（169.254.169.254 等）**永远拒绝**（allowlist 也不能放行）；请求前对 hostname 做 DNS 预检，解析到私网/元数据即拒绝。DNS rebinding 的 TOCTOU 窗口见文档。

### 多 Agent（明确状态）

- **WebSocket：不做**（单向推送 SSE 足够）。
- **多 Agent 投票/仲裁：不做**（成本、延迟、责任归属；用户也不建议做）。

### 自动接线（auto-wire）

```text
autoAdvise = true（默认；AI 未配置时完全无副作用）
  新 ticket 创建成功 → 入队 → 并发 2 / 队列上限 50 → 写 ticket.ai（不改变 ticket 状态）
  配置 AI 成功后 → 当前积压 pending（无 AI 建议、非 system）最多 25 条补建议
  建议失败 → 审计 decision-ai-advice-failed（auto:true），不阻塞 ticket
```

环境变量自动接入（只存内存，不落盘、不进状态接口）：

```text
FANG_AI_API_KEY      必需；存在才启用
FANG_AI_PROVIDER     默认 deepseek
FANG_AI_MODEL        可省略
FANG_AI_BASE_URL     可省略（自定义 OpenAI 兼容端点；远程必须 https）
```

`aiStatus()` 额外返回 `autoAdvise / queue / active / persistence / quota / circuit / lastError`；`policy()` 返回 `autoAdvise / persistAiKey / aiDailyQuota / aiFailureThreshold`。

边界：

- Advice 只是建议：不改变 ticket 状态，不替人选择；红色仍要人类显式 resolve；
- Key 优先存 OS 钥匙串/DPAPI；backend 不可用时仅内存（明确如实返回，不落明文）；
- 不会自动替红色决策选答案；
- 建议写入 `ticket.ai`，`trust:'unverified'`；
- 调用失败/限流/熔断以值返回，不影响决策中心主流程。


## 8. 存储

```text
<dataDir>/decision-center.json
```

原子写入；最多保留 `maxTickets`（默认 500）；过期扫描默认每 5s 一次。

### 8.0.1 持久化/审计健康与 eviction 审计

```text
写盘失败（decision-center.json 写不进去）
  create() => { ok:false, reason:'store-unavailable' }，ticket 从内存回滚，不假装成功
  status().health.store = { ok:false, failures, lastError, at }
审计服务失败
  audit 本身 fail-open（不能让记录失败拖垮决策），但 status().health.audit 记录 failures/lastError
maxTickets 驱逐
  每次驱逐审计 decision-ticket-evicted {id, level, status, reason:'max-tickets', at}
  status().evictions = { count, last[] }（仍然保护 pending red / live waiter）
```

- 持久化是 **fail-closed**（创建时写不进去就不创建）；审计是 **fail-open + 可观测**（记录健康状态，不静默）；
- 驱逐不是静默删除：有审计事件 + 状态计数。

### 8.1 注意力配额

```text
maxPendingRed         = 30   全库 pending red 硬上限（超限降 yellow，budgetDemoted）
maxTicketsPerSessionPerDay = 50  单会话每日创建上限（0=不限；超限直接拒绝）
attentionBudget       = 120  全库 pending 注意力点数预算（0=不限）
attentionSourceBudget = 40   单来源（source.sessionId）pending 注意力点数预算（0=不限）

权重：red=5 / yellow=3 / blue=1 / green=0 / gray=0
降级：red→yellow→blue→green（每次超限只降一级）
```

- 每会话每日配额：按 `source.sessionId` 计数，跨重启持久化（`decision-session-usage.json`），本地日期滚动；
  超限策略 `sessionQuotaPolicy`：
  - `reject`（默认）：返回 `{ok:false, reason:'session-daily-quota-exceeded', sessionId, used, limit}`；
  - `demote`：降一级并打标 `sessionQuotaDemoted:true` + `sessionQuota:{scope:'session-daily',used,limit,policy}`；green 无法再降时仍拒绝；
  - `merge`：并入该会话最新 pending ticket，返回 `{ok:true, merged:true, reason:'session-daily-quota-merged', ticket}`，不新建；
- 幂等重试（同 `dedupeKey`）不重复计数；
- 统计：`GET /fang/api/decisions/quota` / `service.quotaStatus()` 返回当日按会话、按角色的创建数 + pending 总数/红色数/注意力点数 + 当前限额；
- 跨 fork 聚合：`GET /fang/api/decisions/forks` / `service.forkAggregation()` 按 `ticket.external.originForkId` 分组（母体单独一组），返回每 fork 的 total/pending/resolved、各色计数，以及 **advised / aiAdopted / aiRejected**（母体 AI 建议及其采纳情况）；
- 超全库预算 → 标记 `attentionDemoted:true`、`attentionQuota={scope:'global',used,limit,points}`；
- 超来源预算 → `scope:'source'`，防单 Agent 刷屏；
- 配额不足时**降一级而不是丢弃/拒绝**，原等级保存在 `originalLevel`；
- green 不占预算，也不允许再降；
- red 硬上限与注意力配额可叠加（red 先降 yellow，再可能降 blue）；
- **只有红色可以阻塞**：非红 ticket 传 `isBlocking:true` 会被忽略；`isBlocking` 不能由调用方绕过；
- 过期/放弃会把 `level` 置 `gray`，但保留 `originalLevel`（原始严重度不丢）；
- `__ACK__` 是保留控制哨兵，不能作为业务 option value（`reserved-option-value`）；
- UI 显示「注意力降级」chip，tooltip 给出 scope/used/limit；
- `policy()` 暴露 `attentionBudget / attentionSourceBudget / attentionWeights`。

### 8.2 生产者接线矩阵（谁会把 ticket 送进来）

| 来源 | 状态 | 实现 |
|---|---|---|
| `MirrorUpgrade` | ✅ 仓内接线 + 测试 | 失败/compat/抛错 → ticket；**升级成功 → 红色 restart ticket**（confirm_restart）；`officialSourceUrl` manifest adapter 已接；测试覆盖 fake source、真实 manifest upgrade、compat 失败 |
| `EssenceManager` | ✅ 仓内接线 + 测试 | 测试用**真实 EssenceManager**：镜像锁定 plugin + overlay 禁用 → fatal conflict；overlay 路径损坏 → failed；两者 → red ticket |
| `PM ask_user_choice` | ✅ 工具接线 | 同名工具：**固定转红**（即使调用方传黄/蓝也忽略）、阻塞等待选择，返回 `selectedValue` |
| `HarnessMM` | 🟡 仅桥 | 本仓没有该上层系统；通过 `POST /fang/api/decisions/ingest` 接入 |
| `PluginUpdater` | 🟡 仅桥 | 本仓尚未实现；实现后调 ingest 或复用 `raiseDecisionTicket` |
| `SuperAgent` | 🟡 仅桥 | 本仓没有该上层系统；通过 ingest 接入 |
| `PJM 超时` | 🟡 仅桥 | PJM 是独立进程；超时时调 ingest（建议带 `dedupeKey`） |
| `Worker 跑偏` | 🟡 仅桥 | Worker 是独立进程；跑偏时调 ingest（建议带 `dedupeKey`） |

### 8.2.1 MirrorUpgrade 的状态/重启边界（回答三个问题）

- **升级状态事件**：`MirrorManager.upgrade({onProgress})` 已有 `UPGRADE_STAGE`：`checking / backing-up / downloading / swapping / finalizing / done / failed`；orchestrator 现在把它转发成 `fang/mirror-upgrade-stage` 并审计 `mirror-upgrade-stage`；
- **是否重启**：不重启。升级只做 swap + compat 门禁 + postUpgradeHook（元主重算），**不会 exit 宿主，也不会调用 restart-guard**；
- **是否已有 restart-guard 决策**：没有。镜像升级不创建 restart 决策清单；重启仍走独立的 `restart-guard` 三重门禁 + 外部 supervisor。两者不要混用；
- **真实升级缺口（已补）**：官方源 adapter 已实现（manifest 协议，`docs/MIRROR-OFFICIAL-SOURCE.md`），配置 `officialSourceUrl/officialSourceToken` 即生效；升级成功会自动产生红色 restart ticket。生产真正升级仍需一个可访问的 manifest 源（或适配官方商店协议）。

### 8.2.2 业务生产者命名适配层（P4 契约）

> 生产者状态的单一事实来源：[docs/PRODUCER-STATUS.md](PRODUCER-STATUS.md)（✅/🟡/❌ 判定条件写死，避免反复审计）。

完整契约见 [docs/PRODUCER-CONTRACT.md](PRODUCER-CONTRACT.md)（v1）：
`normalizeProducerPayload()` / `createProducerSubmitter()` / `producerCatalog()`，
目录路由 `GET /fang/api/decisions/producers`。

`src/lib/business-producers.mjs` 给外部系统一个稳定调用面（不是“本体已接”）：

```js
const producers = createBusinessProducers({ submit: (payload) => center.ingest(payload) })
await producers.mirrorUpgradeRestartRequired({ from, to }) // red + actions[confirm_restart]
await producers.mirrorUpgradeFailed({ from, to, reason })  // yellow
await producers.essenceConflict({ essenceId, conflicts, severity }) // warning=yellow / fatal=red
await producers.harnessmmSuggestion({ id, summary })       // blue
await producers.pluginUpdaterBackup({ pluginId, backupId }) // green
await producers.superagentCompletion({ taskId, summary })  // green
await producers.pjmTimeout({ projectId, phase })            // yellow + 5min auto-gray
await producers.pjmFatal({ projectId, error })               // yellow
await producers.workerDeviation({ workerId, taskId, detail }) // yellow
```

- orchestrator 的 MirrorUpgrade 失败/异常、EssenceManager 冲突已改走这层；
- **本体不在本仓**：HarnessMM/PluginUpdater/SuperAgent/PJM/Worker 仍需各自进程调用（或等价 ingest payload）；
- `mirrorUpgradeRestartRequired()` 的红色 restart ticket 已在**真实 manifest upgrade 成功路径**触发并有测试；`confirm_restart` 仍受 restart-guard 门禁。

外部生产者桥：

```text
POST /fang/api/decisions/ingest          （与其它 /fang/api 一样走 Host/Origin/token 门禁）
{
  producer: 'HarnessMM'|'PluginUpdater'|'SuperAgent'|'PJM'|'Worker'|...,
  kind?: 'gdr-conflict'|'timeout'|'deviation'|...,
  level: 'red'|'yellow'|'blue'|'green',
  title, context,
  options?: [{ value, label, isRecommended? }],
  dedupeKey?: 'external-unique-id',      // 同 key 跨状态幂等：已存在的 ticket（含已 resolved）原样返回
  sourceRole?: 'pm'|'pjm'|'worker'|'system',
  sessionId?, timeoutMinutes?
}
→ { ok, ticket, deduped? }
```

- 外部 ticket 的 `source.roleSource='external:<producer>'`、`roleTrusted:false`（角色只是展示，不是权限）；
- `dedupeKey` 幂等：同 key 的 ticket 已存在时返回 `deduped:true` + 原 ticket；**跨状态生效**（即使原 ticket 已 resolved/abandoned，也不会重放再开新票）；
- `kind` 默认等级（调用方显式传 `level` 时以调用方为准）：
  - `harnessmm-suggestion` → blue
  - `plugin-updater-backup` → green
  - `superagent-completion` → green
  - `pjm-timeout` → yellow + 默认 5 分钟后自动转灰（expired）
  - `worker-deviation` → yellow
  - `mirror-upgrade` / `essence-conflict` → yellow
- **只提供桥不代表已接入**：PJM/Worker/HarnessMM/PluginUpdater/SuperAgent 必须在各自进程里实际调用 ingest，才算接线完成。

### 8.3 角色归属

优先级（已按此实现）：

```text
宿主绑定的 agent-preset/selected
> sourceRole 自报（仅降级展示）
> worker
```

实现（`request_human_decision` 工具）：

- **宿主绑定**从 `exec` 读取，探测 `agent.role` / `agent.agentRole` / `agent.preset.role` /
  `agent.preset` / `agent.profile.role` / `exec.role` / `session.role`，只接受
  `pm|pjm|worker|system`；命中记 `roleSource='host:<path>'`、`roleTrusted=true`。
- 宿主没绑定时才降级使用模型参数 `sourceRole`，记 `roleSource='caller-reported'`、`roleTrusted=false`。
- 两者都没有 → `worker`，`roleSource='default'`。
- 模型伪造 `args.source.agentRole` 一律忽略；自报值只写入 `source.reportedRole` 作展示标签。
- 角色**不是权限依据**：放行必须依赖宿主绑定/审批结果，不能只看 `ticket.source.agentRole`。


## 9. 边界

- 决策中心不是审批系统：审批由 `fang-approver` 负责；
- 红色阻塞的是 Agent 工具调用，不是整个宿主；
- 过期只改灰，不自动选择默认选项；
- 重启后 pending 变 gray，不恢复旧 Promise；
- 权限复用母体 HTTP 认证；工具身份来自调用 Agent 的 sessionId；
- PM/PJM/Worker 是独立进程时，跨 fork ingest 是必需项，不能延后。

### 9.1 P4 fork 提交路径（已接线）

### 9.1.1 独立进程客户端（PJM/Worker 等直接可用）

```js
import { createForkIngestClient } from 'dsh-fang/src/lib/decision-ingest-client.mjs'
const client = createForkIngestClient({
  dataDir: '<本地 outbox 目录>',          // 必填，失败时落盘重放
  motherDataDir: process.env.DSH_FANG_MOTHER, // 母体 endpoint.json + fang-auth.json
})
await client.submit({ producer: 'PJM', kind: 'pjm-timeout', title, context, timeoutMinutes: 5, dedupeKey })
await client.flush()   // 重放失败项
client.pending()
```

CLI（无需写代码）：

```powershell
node tools/decision-ingest.mjs --outbox-dir <dir> --payload '{"producer":"Worker","kind":"worker-deviation","title":"drift","context":"task=t1","options":[{"value":"a","label":"A"}]}'
node tools/decision-ingest.mjs --outbox-dir <dir> --flush
```

- 直连 `POST /fang/api/decisions/ingest`；失败落 outbox，指数退避重放；
- token 只从 `fang-auth.json`/配置读取，不写进 payload；
- 这仍是「客户端就绪」：PJM/Worker 进程要在超时/跑偏事件处调用。

```text
role.mjs: decisionCenter: ['mother','fork']
fork 角色 apply → applyForkDecisionCenter()
  service.submit/ingest → decision-outbox.submit()
    · 母体可用：POST /fang/api/decisions/ingest（originForkId/taskId）
    · 母体不可达：落 <forkDataDir>/decision-outbox/，5s 定时 flush + 指数退避
  service.wait(id) → 轮询母体 GET /fang/api/decisions/item?id=...
  tool request_human_decision（fork 版）：
    · yellow/blue/green：提交后立即返回 ticketId
    · red：轮询母体直到 resolved/abandoned/expired；超时回落报错
```

fork 侧还注册两个专用工具（PJM/Worker Agent 可直接调用，无需手写 payload）：

```text
report_pjm_timeout({ projectId?, phase?, error?, timeoutMinutes?, context? })
  → producer=PJM, kind=pjm-timeout（error 时 pjm-fatal）, level=yellow, 默认 5min 自动转灰

report_worker_deviation({ workerId?, taskId?, detail?, context? })
  → producer=Worker, kind=worker-deviation, level=yellow
```

集成测试：`test/umbrella-fork-outbox.test.mjs`
- 母体在线：**先替换 fork 代理 service.submit 为 spy**，断言 umbrella 确实调用代理；再断言代理 → `POST /fang/api/decisions/ingest`（payload 带 producer=fork/originForkId）；
- 母体离线：断言 `<forkDataDir>/decision-outbox/` 磁盘上确有完整 payload（title/level/actions），`pending=1`；母体恢复后 `flush()` 送达并清空 outbox、`attempts=0`。

- **母体路由新增 `GET /fang/api/decisions/item?id=`（fork 轮询单票用）**；
- fork 侧 adapter 新增命令 op `decision-ingest`：fork 内组件通过 adapter 控制通道提交，adapter 转发给 fork 的 decision-center 代理（再走 outbox → 母体 ingest）；
- 母体 ingest 的 `ticket.external` 记录 `originForkId/taskId`，`GET /fang/api/decisions/forks` 按 fork 聚合；
- 幂等：母体 `dedupeKey` 跨状态去重；同一 fork 重放不会重复开票，跨 fork 同 key 也会合并；
- umbrella ASK 在 fork 里走 fork 代理 → outbox 双写（非阻塞，不改变原决策）；返回异步 `decisionTicketPromise`，await 后可拿到母体 ticket id 并回填 `decisionRecord.decisionTicketId`（失败解析为 null，不产生 unhandled rejection）。
- **AI 建议**：fork 提交的 ticket 落到母体后由母体 AI 顾问给建议；`forkAggregation()` 可看到每个 fork 的 advised/aiAdopted/aiRejected。**没有**“fork 侧 AI 建议聚合”独立通道，也**没有跨进程 AI 建议缓存/共享**（建议只存在母体 ticket.ai 里，fork 通过 `GET /api/decisions/item` 能看到该 ticket 的 ai 字段）；
- **自动替红色决策选答案：永远不做**（测试锁：AI advice never resolves / never writes isRecommended / never auto-allows）；
- **仍未接**：PluginUpdater/SuperAgent（本仓无实现）、PJM/Worker 进程本体（需要它们调用 fork tool / adapter decision-ingest / HTTP ingest）。

### 9.2.1 右侧工作区「决策中心」区域（client.js）

在分身工作区右侧面板顶部内嵌一个独立决策区域（无需 React；复用现有 notice/inbox 按钮样式）：

```text
红色·阻塞 置顶
黄色 / 蓝色 分组
绿色默认折叠
灰色归档默认折叠
每项：来源（rawSource/agentRole/taskName/sessionId）、上下文、剩余时间
每项：选项按钮（最多 4 个）+ 放弃/忽略
操作后：无论成功/失败都重新 GET /fang/api/decisions?includeArchived=1（不乐观删除）
409：显示「该票已被处理…已刷新」
5 秒兜底刷新（与 SSE 收件箱独立）
```

DOM 测试：`test/client-inbox-dom.test.mjs`（分组顺序、绿/灰折叠、选项点击、409、重新拉取）。

### 9.2 客户端 DOM 测试（jsdom）

```text
test/client-inbox-dom.test.mjs（jsdom 仅 devDependency，不进运行时）
  - 分组渲染 / 黄色分组折叠后再展开
  - 绿色无选项 ACK → POST resolve {option:'__ACK__'}
  - HTTP 409 → 错误显示，不伪造成功
  - 批量部分失败 → 确认弹窗 → 逐条失败 UI（reason 可见）
  - SSE ticket 帧实时合并 + 红色强提醒 DOM
  - 刷新走 rev/since 增量（断言 URL 带 since=）
```

测试需要 `npm install` 安装 devDependency `jsdom`；这是本仓第一个 DOM 测试依赖。




