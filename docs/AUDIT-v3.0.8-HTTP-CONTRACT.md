# AUDIT v3.0.8 · fang HTTP API ↔ DSH 宿主 ↔ Electron 代理契约

- **审计对象**：`dsh-fang` HTTP 面（orchestrator + session-catalog/bridge/sync/router + adapter）、DSH `webServer` 路由语义、`dsh-fang-desktop` 本机代理。
- **审计时间**：2026-11-06
- **边界**：只改本地分支；**未 push main、未发布、未构建安装包、未重启用户宿主**。
- **结论**：发现 13 处契约断点，均已修复并落到自动化断言。全量单测 `718 pass / 729 total / 0 fail / 1 skip`，e2e `73/73`，桌面代理套件 `51/51`。

---

## 1. 契约矩阵（单一事实）

### 1.1 跨域不变量

| 维度 | 契约 | 实现位置 |
|---|---|---|
| 监听面 | 只绑定 loopback；代理只监听 `127.0.0.1` | DSH `webServer` + `main.cjs` |
| Host | 必须是 `localhost` / `127.0.0.1` / `[::1]`，可带端口；**不接受前缀伪造**（`[::1]evil`、`127.0.0.1:1@evil`） | `http-auth.isLoopbackHost` |
| Origin | 空 / 任意 loopback origin / `dsh-app://*`；`null`、`https://evil.example` 拒绝 | `http-auth.isAllowedOrigin` |
| CSRF | `Sec-Fetch-Site` ∈ `same-origin` / `same-site` / `none`；`cross-site` 拒绝 | `http-auth.checkRequestAuth` |
| 安装 token | `x-fang-auth: <token>` 或 `Authorization: Bearer <token>`；**永不接受 `?token=`** | `http-auth.checkRequestAuth` |
| 写请求 | 非 `GET/HEAD/OPTIONS` 且带 `content-type` 时必须是 JSON，否则 415 | `http-auth.checkRequestAuth` |
| 判定顺序 | Host/Origin/CSRF → token → content-type → method | 所有路由包装器 |
| 错误体 | `/fang/api/*` 统一 `{ok:false,error:<code>,code:<code>}`；代理层同样 JSON | orchestrator + `main.cjs` |
| 方法错误 | 405 + `Allow`，且**不能先于 401** | 所有 exact 路由 |
| 未知 API | `/fang/api/*` 未命中 → **先鉴权**，再 JSON 404 `not-found` | orchestrator prefix catch-all |
| 绝对 URL | 代理拒绝 absolute-form / `//` / 反斜杠 / 控制字符，400 `invalid-request-target`，不触达上游 | `main.cjs` |
| 路由键 | DSH `webServer` 的 exact 路由**只以 path 为键**；GET+POST 同路径必须合并注册 | `routeMethods()` |

### 1.2 端点矩阵

| 方法 | 路径 | 鉴权 | 成功 | 失败语义 | owner |
|---|---|---|---|---|---|
| GET | `/fang/api/auth-token` | **public**（仍校验 Host/Origin/CSRF） | 200 `{ok:true,token}` | 403 `bad-host` / `bad-origin` / `cross-site`；405 非 GET | orchestrator |
| GET | `/fang/api/status` | token | 200 状态快照 | 401/403/405 | orchestrator |
| GET | `/fang/api/upgrade/status` | token | 200 `{ok:true,...}` | 401/403/405 | orchestrator |
| GET | `/fang/api/tasks` | token | 200 `{ok:true,tasks[]}` | 401/403/405 | orchestrator |
| POST | `/fang/api/tasks/create` | token | 200 `{ok:true,taskId,...}` | 409 配额；500 `handler-threw` | orchestrator |
| GET | `/fang/api/tasks/status?taskId=` | token | 200 任务 + adapter 状态 | 404 `unknown-task` | orchestrator |
| POST | `/fang/api/tasks/archive` | token | 200 | 409 `task-archived`/`stop-failed` | orchestrator |
| POST | `/fang/api/tasks/restore` | token | 200 | 409 | orchestrator |
| POST | `/fang/api/tasks/archive/delete` | token | 200 | 409 | orchestrator |
| POST | `/fang/api/tasks/rename` | token | 200 | 409 `task-archived` / 400 `invalid-title` | orchestrator |
| POST | `/fang/api/tasks/copy` | token | 200 | 404 `unknown-task` | orchestrator |
| GET | `/fang/api/tasks/download?taskId=` | token | 200 manifest | 404 | orchestrator |
| GET | `/fang/api/tasks/open-url?taskId=` | token | 200 `{ok:true,url}`（内存含 token） | 404 `not-running` | orchestrator |
| GET | `/fang/api/tasks/sessions?taskId=` | token | 200 | 404 | orchestrator |
| GET | `/fang/api/tasks/branches?taskId=` | token | 200 `{ok:true,sessionId,activeBranchId,branches[]}` | 400 `taskId-required`；**404 `unknown-task`**；403/401 | orchestrator（GET+POST 合并注册） |
| POST | `/fang/api/tasks/branches` | token | 200 `{ok:true,branch}` | 400 `invalid-branch-id`；404 `unknown-task`/`parent-missing`；409 `branch-exists` | 同上 |
| POST | `/fang/api/tasks/branches/activate` | token | 200 `{ok:true,branch,activeBranchId}` | 400/404/409 `branch-not-active` | orchestrator |
| POST | `/fang/api/tasks/branches/status` | token | 200 `{ok:true,branch}` | 400 `invalid-status`；404 `branch-missing`；409 `cannot-seal-active` | orchestrator |
| GET | `/fang/api/reflow/policy` | token | 200 策略 | 401/403/405 | orchestrator |
| GET | `/fang/api/sessions` | token | 200 空态或列表 | 401/403/405 | session-catalog |
| GET | `/fang/api/sessions/item?sessionId=` | token | 200 | 400/404 | session-catalog |
| GET | `/fang/api/sessions/head?sessionId=` | token | 200 | 400/404 | session-catalog |
| GET | `/fang/api/bridge/status` | token | 200 fail-closed 描述 | 401/403/405 | session-bridge |
| GET/POST | `/fang/api/bridge/sessions` | token | GET 200 / POST 201 | 400/401/403 | session-bridge（**合并注册**） |
| GET | `/fang/api/bridge/sessions/events?sessionId=` | token | 200 | 404 | session-bridge |
| POST | `/fang/api/bridge/sessions/prompt` | token | 200 | 400 | session-bridge |
| GET | `/fang/api/sync/status` | token | 200 | 401/403/405 | session-sync |
| POST | `/fang/api/sync/export` | token | 200 | 400/413 | session-sync |
| POST | `/fang/api/sync/import` | token | 200 | 400/413 | session-sync |
| GET | `/fang/api/route?realtime=` | token | 200 决策 | 409 `deny` | session-router |
| GET | `/fang/adapter/hello` | **adapter Bearer** + loopback Host + Origin/CSRF | 200 握手 | 401 `unauthorized`；403 `bad-host`/`bad-origin`；405 | adapter（fork-only） |
| GET | `/fang/adapter/{status,version,health,state,approvals,audit}` | adapter Bearer | 200 | 401/403/405 | adapter |
| POST | `/fang/adapter/{command,commands}` | adapter Bearer + JSON | 200/202 | 400/401/403/409/415 | adapter |
| GET | `/fang/adapter/events` | adapter Bearer | SSE 200 | 401/403/409/410 | adapter |
| * | `/fang/api/unknown` | token | — | **404 JSON `not-found`**（无 token 先 401） | orchestrator prefix catch-all |

> 说明：`/fang/adapter/*` 使用 forker 注入的 **adapter Bearer token**（`DSH_ADAPTER_TOKEN`），不是安装 token；两者不混用。`client.js` 对 `/fang/adapter/hello` 的 401 视为「当前是分身」，这是客户端识别协议，不是鉴权绕过。

---

## 2. 断点、最小复现、修复、断言

### B1（P0）GET+POST 同路径被 DSH 路由表吞掉 → POST 405、后续路由未注册

**复现（v3.0.8 修复前）**
```bash
# 真实宿主 18110（e2e）或 3080：
curl -s -X POST http://127.0.0.1:3080/fang/api/tasks/branches \
  -H "x-fang-auth: $TOKEN" -H "content-type: application/json" \
  -d '{"taskId":"<real>","branchId":"b1"}'
# → 405 {"ok":false,"error":"method-not-allowed"}
```
**根因**：DSH `webServer` 的 `exact` 是 `Map<path, route>`，同一路径第二次 `register` 直接抛错。v3.0.8 把 `GET` 与 `POST /tasks/branches`、`/bridge/sessions` 分别注册；第二次注册抛错后，同一次 `ctx.inject` 中后续路由（reflow、catch-all）不再注册。

**修复**：新增 `routeMethods(path, {GET,POST})`，一个 exact 注册内按 `req.method` 分发；orchestrator 分支路由与 session-bridge `/bridge/sessions` 均改用该形式。`webServer` 的 `method` 字段同时写入注册 spec（测试 stub 可精确查找）。

**断言**
- `test/orchestrator.test.mjs`：`branchRoutes.length === 1`、`method === 'GET,POST'`。
- `test/http-contract.test.mjs`：`/bridge/sessions` 只有一条注册。
- `tools/e2e.mjs`：`POST /fang/api/tasks/branches` 200、duplicate 409、activate 200、status 200；`POST /fang/api/compat/check` → `routeCount=67/expected=67`。

---

### B2（P0）`/sessions*`、`/bridge/*`、`/sync/*`、`/route` 完全绕过 Host/Origin/token

**复现**
```bash
curl -s http://127.0.0.1:3080/fang/api/sessions \
  -H 'Host: evil.example' -H 'Origin: https://attacker.example' -H 'Sec-Fetch-Site: cross-site'
# 修复前 → 200 + 真实会话列表
curl -s 'http://127.0.0.1:3080/fang/api/sessions/item?sessionId=<real>' ...
curl -s http://127.0.0.1:3080/fang/api/route ...
```
**根因**：这些插件各自 `webServer.register`，只有 orchestrator 调用了 `checkRequestAuth`。

**修复**：`http-auth.createHttpGuard({dataDir,token,enabled})` 统一加载安装 token；四个插件在包装器中先 `guard.check(req)`，失败返回 JSON 401/403。Host/Origin/CSRF 即使 `authEnabled:false` 也仍生效。

**断言**
- `test/session-catalog.test.mjs`：无 token 401、坏 Host 403、跨站 Origin 403、POST 无 token 401。
- `test/http-contract.test.mjs`：三个插件逐项覆盖 200/401/403/405+Allow。

---

### B3（P1）鉴权晚于 method 判定 → 无 token 也能拿到 405

**复现**
```bash
curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3080/fang/api/status
# 修复前 405；契约要求 401
```
**修复**：所有路由包装器把 `checkRequestAuth` 放在 method 判定之前；405 增加 `Allow`。

**断言**：orchestrator / session-catalog / adapter / http-contract 均有「POST 无 token → 401，带 token → 405 + Allow」。

---

### B4（P1）Host 前缀伪造可绕过 DNS rebinding 防护

**复现**
```bash
curl -s http://127.0.0.1:3080/fang/api/status -H 'Host: [::1]evil.example'
# 修复前：isLoopbackHost 截到 ']' 后放行；修复后 403 bad-host
```
**根因**：旧实现 `raw.startsWith('[') ? raw.slice(0, raw.indexOf(']')+1) : ...` 丢弃 `]` 之后的尾巴。

**修复**：严格正则解析 bracket / host:port，校验端口范围与精确 loopback 名。

**断言**：`test/http-auth.test.mjs` 覆盖 `[::1]evil.example`、`[::1]:3080evil`、`[::1]:99999`、`127.0.0.1:1@evil`、`localhost.evil.example` 等 7 例。

---

### B5（P1）未知 `/fang/api/*` 返回宿主空 404，且不鉴权

**复现**
```bash
curl -s -i http://127.0.0.1:3080/fang/api/does-not-exist
# 修复前：404、空 body、无鉴权；不符合「/fang/api/* 统一 JSON 错误」契约
```
**修复**：orchestrator 注册 `prefix /fang/api` catch-all：先 Host/Origin/token，再 404 `{ok:false,error:'not-found',code:'not-found'}`。exact 路由优先命中，不受影响。

**断言**：`test/orchestrator.test.mjs`：prefix 路由存在、带 token 404 JSON、无 token 401；e2e 的 compat 门禁仍为 67 条。

---

### B6（P1）branches 对未知 taskId 返回 200 空分支；taskId 可路径穿越

**复现**
```bash
curl -s 'http://127.0.0.1:3080/fang/api/tasks/branches?taskId=missing' -H "x-fang-auth: $TOKEN"
# 修复前 200 {branches:[main]}；修复后 404 unknown-task
curl -s 'http://127.0.0.1:3080/fang/api/tasks/branches?taskId=../../escape' ...
# 修复前 BranchStore.file() 会拼出 dataDir 外路径；修复后 404
```
**修复**：
1. `requireTask()`：taskId 必须匹配安全段且存在于 registry，否则 400/404。
2. `BranchStore.file()` 拒绝 `../`、分隔符、非法 taskId；`branch.mjs` 对 branchId/sessionId 做严格段校验。
3. 分支错误映射：`invalid-*` 400、`*-missing` 404、`branch-exists`/`branch-not-active`/`cannot-seal-active` 409。

**断言**：e2e 覆盖 unknown/traversal/200/duplicate 409/invalid 400/activate/seal/unknown POST；`test/orchestrator.test.mjs` 覆盖同一组。

---

### B7（P1）adapter 路由缺少 Host/Origin、415、鉴权顺序

**复现**
```bash
curl -s http://127.0.0.1:18000/fang/adapter/state -H 'Host: evil.example' \
  -H 'Authorization: Bearer <adapter-token>'
# 修复前 200；修复后 403 bad-host
curl -s -X POST http://127.0.0.1:18000/fang/adapter/commands \
  -H 'Authorization: Bearer <adapter-token>' -H 'content-type: text/plain' -d '{}'
# 修复前可能进入 handler；修复后 415
```
**修复**：adapter 包装器先跑 `checkRequestAuth`（Host/Origin/CSRF + adapter Bearer），再显式校验写请求 JSON，最后 method。保留 v2 `allowLegacyNoToken` 的显式兼容路径（仍校验 Host/Origin）。

**断言**：`test/adapter.test.mjs` 新增 bad-host 403、bad-origin 403、POST 无 token 401、405 + Allow、text/plain 415。

---

### B8（P0）Electron 代理绝对 URL 防护不完整（`file://` 落到 404；`//`/反斜杠不统一）

**复现**
```http
GET file:///C:/Windows/win.ini HTTP/1.1
Host: 127.0.0.1:<proxyPort>
```
修复前：`new URL(req.url, base)` 解析为 `file:`，最终 404；`/\\evil...` 也可能绕过。修复后：startProxy 在解析前拒绝 absolute-form / `//` / `\` / 控制字符，返回 400 JSON；proxy 内再用 `new URL(requestPath, base)` + `origin` + `/fang/api/` 三重校验。

**断言**：`01-proxy-api` A28–A32（4 种危险 target 均 400、上游 0 次请求）；`04-resilience` D12（进程存活 + 400）。

---

### B9（P1）代理层 403/404/502 用 `text/plain`，与 API JSON 错误契约不一致

**复现**
```bash
curl -s -i http://127.0.0.1:<proxyPort>/fang/api/status -H 'Host: evil.example'
# 修复前：403 text/plain "forbidden host"；修复后：403 JSON bad-host
```
**修复**：`sendApiError()` 统一 `{ok:false,error,code,detail}`；仅非 API 静态资源保留 text/plain。上游掉线 502、超时 504 也走同一 JSON 形状。

**断言**：A20/A21 JSON 契约；D10 502 `upstream-unreachable`；A31 400 JSON。

---

### B10（P1）宿主轮换 token 后代理永久 401

**复现**：启动面板 → 修改/重建宿主 `fang-auth.json` → 面板下一次 `/fang/api/status` 修复前一直 401，直到重启面板。

**修复**：代理单飞 `refreshToken()`；GET/HEAD 收到 401 时 bootstrap 新 token 并**重试一次**（只缓冲 401 小 body）；非 GET 只刷新 token 供下次使用。`client.js` 也增加 401 → 清缓存 → 重新 bootstrap → 重试一次。

**断言**：`01-proxy-api` A33（轮换后 200 + 上游收到新 token）、A34（`revealToken` 同步新值）。

---

### B11（P1）上游发现误判 / 回退到非 fang 的 DSH 宿主

**复现**：让 `DSH_WEB_URL` 指向一个“未知路径返回 200 HTML”的宿主；修复前 `probeUpstream` 只看 200，选中它后所有 API 变成 HTML/404；全部候选不可达时又回退到 `DSH_WEB_URL`。

**修复**：探测要求 `200 + application/json + {ok:true}`；全部不可达时回退到显式 `FANG_UPSTREAM` 或 `http://127.0.0.1:3080`，不再回退到 `DSH_WEB_URL`。

**断言**：D1/D6/D7 保持通过；D6b 证明不可达候选不收到业务请求。补充建议测试模式：`mode: 'spa-200'`（见 §5 未覆盖项）。

---

### B12（P1）`client.js` 的 `headers` 覆盖鉴权头 → `/mirror/status` 401

**复现**：面板打开「母体」时 `loadMirror()` 调用
```js
api('/fang/api/mirror/status', { headers })
```
旧 `api()` 把 `options` 展开在默认 headers 之后，`headers` 整体替换默认头，`x-fang-auth` 丢失 → 401，镜像卡片空态。

**修复**：先展开调用方 headers，再强制写入 `content-type`/`accept`/`x-fang-auth`；`api()` 同时拒绝绝对/协议相对路径，避免 token 被 `fetch` 带到外部 origin；`openMotherPortal()` 在 Electron 下优先使用 `desktopInfo().upstream`，不再打开只服务 `/fang/api/*` 的代理 origin。

**断言**：桌面套件 A7/A8 证明 client.js 物化一致；A33/A34 证明 token 轮换；建议 UI 冒烟新增 `/mirror/status` 带 token 断言（见 §5）。

---

### B13（P2）测试 fixture 接受 `?token=`，掩盖真实宿主拒收 query token

**复现**：`fixture-mother.mjs` 旧逻辑 `given = header || bearer || searchParams.get('token')`；真实 `checkRequestAuth` 只认 header/Bearer。任何“把 token 拼进 URL”的回归都会在 fixture 下假绿。

**修复**：fixture 删除 query token 分支，与真实契约一致；`client.js` 继续用 header。

**断言**：桌面 A7/A8/A33（header 路径）；e2e 的 `?token=` 只作为 DSH 自身 URL token，不参与 fang 鉴权。

---

## 3. 自动化断言清单

| 命令 | 覆盖 | 本次结果 |
|---|---|---|
| `cd dsh-fang && npm test` | 全量单测（含 http-auth / orchestrator / adapter / session-catalog / http-contract） | **718 pass / 0 fail / 1 skip** |
| `cd dsh-fang && node tools/e2e.mjs` | 真实 DSH 宿主：路由、鉴权、branches、adapter、compat 门禁 | **73/73** |
| `cd dsh-fang-desktop && node test/run.mjs 01 04` | 代理契约、Host/Origin、绝对 URL、token 轮换、上游掉线 | **51/51** |
| `node --check` | `client.js`、`main.cjs`、`orchestrator.mjs`、`session-bridge.mjs` | PASS |

关键断言 ID：

- `http-auth`：`Host 解析不接受带尾随垃圾...`、`createHttpGuard 统一 token/env/dataDir...`
- `orchestrator`：`branch/task-id 404 contract, traversal guard, and /fang/api catch-all`
- `http-contract`：`session-bridge/session-sync/session-router: HTTP route uses the shared Host/Origin/token gate`
- `adapter`：`v3: Bearer 认证...` 内的 perimeter 断言
- e2e：`compat gate passes (route count + required paths)`、`POST /fang/api/tasks/branches 200 + b1`、`POST duplicate branch → 409`
- 桌面：`A20/A21/A28–A32/A33/A34`、`D10/D12`

---

## 4. 未覆盖 / 保留风险

1. **adapter 未知子路径**仍落到 DSH 默认空 404（未加 prefix catch-all），因为 adapter 的 10 条 exact 路由与测试对 `service.routes` 顺序有强断言；若要求 `/fang/adapter/*` 也统一 JSON 404，需要同步改 `adapter.test.mjs` 与 allowlist。
2. **SSE `eventsUrl`** 仍以 `?token=` 携带 DSH web token（EventSource 无法设 header），这是 v3.0.5 已知例外；adapter Bearer 已独立走 header。
3. **`auth-token` 是公开 bootstrap**：本机任意进程可读取 token；当前依赖 loopback Host + Origin/CSRF 防浏览器跨站，不防本机进程。若威胁模型包含本机恶意进程，需要改为父子进程握手/命名管道。
4. **Origin 允许任意 loopback 端口**：同机另一个本地 Web 应用可发起请求（浏览器仍受同源策略限制，读不到响应）；若要更严，可收紧为同端口或 `dsh-app://`。
5. **代理对 POST 的 401 不自动重试**（避免重复写），只刷新 token 供下次调用；这是有意的幂等/安全取舍。
6. **未在本机执行**：`gh` 推送、npm 发布、安装包构建、真机 3080/3081 重启。本次仅本地分支 + 测试。
7. **`tools/release/allowlist.mjs` 仍 RED**：唯一失败项是审计前已存在的未跟踪文件 `docs/WEB-ENTRY-INTEROP-DIAGNOSIS.md` 含本机绝对路径（`C:\Users\fangw`、`E:\GPT\dsh-fang`）。本次新增/修改文件均通过 secret/local-path 扫描；路由 allow-list 已覆盖 `routeMethods()`（65 条）。

---

## 5. 建议的后续断言（未实现）

- fixture `mode: 'spa-200'`：未知路径返回 200 HTML，断言 `discoverUpstream()` 跳过它。
- UI smoke 增加：点击「母体」→ `/fang/api/mirror/status` 请求头必须含 `x-fang-auth`（覆盖 B12）。
- adapter prefix catch-all：`/fang/adapter/unknown` → 401/404 JSON，并更新 `service.routes` 断言。
- 引入 `x-fang-request-id` 并在所有 4xx/5xx 回显，便于支持定位（当前错误体只有 code/detail）。
