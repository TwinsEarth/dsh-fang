# 瓮城入口 → Electron 面板：链路诊断与互联缺口

> 日期：2026-11-06 · 范围：`<repo>\web-entry\client.js`、`<repo>-desktop\main.cjs`、`preload.cjs`
> 原则：本文每条结论都标注证据等级。**[实测]** = 本机跑过并贴了输出；**[代码]** = 静态代码可证；
> **[未验证]** = 没条件验证，只给验证方法，**不宣称通过**。
> 本次**未修改**这三个文件，补丁以片段形式给出，供 review 后应用。

---

## 0. 结论先行

链路**能通一半**：`dsh-fang://open` 的 Windows 注册表与「唤起/聚焦」是好的 [实测]；
断点是四处：**入口与后端分属两个实例（R1）**、**发现逻辑主动跳过真正在用的宿主（R2）**、
**深链不带上下文也没有回执（R3）**、**面板与后端之间根本没有推送通道（R4）**：

| # | 根因 | 等级 | 后果 |
|---|---|---|---|
| R1 | **入口与后端不在同一个 DSH 实例里**。60386（官方桌面宿主，profile `desktop`）装了 `@twinsearth/dsh-fang-web-entry`，但**没装** `@twinsearth/dsh-fang` 后端；3080/3081（`--profile fangweb`）反过来。 | [实测] | Web 侧 `/fang/api/*` 一律 404；面板绑的是另一台 DSH，用户看到的不是当前会话。 |
| R2 | **`discoverUpstream()` 的探测口径把真正在用的宿主判为不可达**：探测 `GET /fang/api/auth-token`，60386 返 404 → 跳过。即使 `DSH_WEB_URL` 正确指向 60386 也一样。 | [实测] | 面板**永远**绑到 3080/3081，不会被“互联”到当前 GUI。 |
| R3 | **深链不带任何上下文，也没有回执**：`dsh-fang://open` 无 query、无 nonce、无回调；Web 端无从得知“是否真的打开了”，面板也无从告知“我连的是谁”。 | [代码] | UI 只能永久显示「正在打开瓮城桌面…」；两侧无法判定对方状态，实时协同无从谈起。 |
| R4 | 面板与后端之间**没有推送通道**：后端有 SSE（`/fang/adapter/events`，带 `since` 游标、410 重同步），但①面板只轮询 `/fang/api/*`（5s）②Electron 代理**只转发 `/fang/api/`**，SSE 路径按代码必然落到 404 分支。 | [代码]（代理未实跑，见 §1.2） | “实时链路”目前实际是 5 秒轮询；presence/光标类需求没有任何承载通道。 |

一句话：**不是“打不开”，是“打开了，但连的是另一台 DSH，而且两边谁也不知道对方是谁”**。

---

## 1. 证据台账（可复现）

### 1.1 已验证

| 证据 | 命令 / 位置 | 结果 |
|---|---|---|
| 协议已注册且指向 Electron | `Get-ItemProperty 'HKCU:\Software\Classes\dsh-fang\shell\open\command'` | `"<user-home>\.dsh\electron\electron.exe" "<repo>-desktop" "%1"` |
| 热启动唤起可用、单实例成立 | `electron.exe "<repo>-desktop" "dsh-fang://open"` | 第二进程 `exit=7`、620ms 退出；主进程仍只有 1 个（PID 1544） |
| 60386 无瓮城后端 | 裸 socket `GET /fang/api/auth-token` | **404** |
| 3080 / 3081 有瓮城后端 | 同上 | **200** `{"ok":true,"token":"…"}`（两端口同一 token） |
| 60386 是 DSH Web（需 URL token） | `GET /` | `401 dsh web authentication required; reopen the URL printed by dsh web` |
| 谁在跑 | `Get-CimInstance Win32_Process` | PID 2280 = 官方桌面宿主（`--profile desktop`）；PID 10112/15440 = `--profile fangweb --port 3080/3081 --no-open`（端口归属取自**命令行声明**，本 shell 监听表被裁剪，未用内核表二次核对） |
| Web 入口插件已启用 | `plugin_manager list_plugins` | `include:fang-web-entry` / `@twinsearth/dsh-fang-web-entry` / `enabled:true` / `fiberPhase:active` |
| 该 profile 无瓮城后端 | 同上前 239 条目录 | 无 `@local/dsh-fang` / `fang-adapter` 行 |
| 探测口径就是 R2 | 用 `vm` 执行 `main.cjs` 第 22 行 + 33–54 行原码 | `DSH_WEB_URL=60386` → 返回 **3080**；无 env → **3080**；`FANG_UPSTREAM=3080` → **3080** |
| 面板是轮询不是推送 | `client.js` | `POLL_MS = 5000`；`EventSource`/`WebSocket` 计数均为 **0**；另有 `setInterval(... , 10000)` 带 `doc.hidden` 判定 |
| 代理白名单 | `main.cjs:169-173` | 仅 `/panel/index.html`、`/dsh-fang/client.js`、`/fang/api/`；其余 404 |
| 后端 SSE 存在 | `src/plugins/adapter.mjs:1229`、`ADAPTER_ROUTE.EVENTS='/adapter/events'`、prefix `/fang` | `GET /fang/adapter/events?since=<cursor>`，409 会话变更 / 410 游标过期 / 心跳帧 |

> 复现脚本（不改动应用，纯 `vm` 执行原码）：`<repo>\.tmp\probe-discovery.cjs`，
> 运行 `node <repo>\.tmp\probe-discovery.cjs` 可直接看到三种 env 下 `discoverUpstream()` 都返回 3080。

### 1.2 明确未声明通过

| 项 | 为什么没法断言 | 验证方法 |
|---|---|---|
| 侧边栏图标在**当前** GUI 里真的渲染出来了 | `cordis_inspect_query`（client/Slots）两次 **10s 超时**，拿不到活的槽位树 | 见 E2E-1 |
| 浏览器是否拦截 mount 时的 `dsh-fang://open` | 无法从本会话驱动用户的浏览器 | 见 E2E-2（贴 console 断言） |
| 当前 PID 1544 的面板是否已挂载、绑的是 3080 还是 3081 | 本 shell 的监听表被裁剪（`netstat` 空、`GetActiveTcpListeners()` 只回 9230），拿不到它的随机代理端口 | 见 E2E-5 |
| 5s 轮询在真机上的实际节奏 | 只有静态代码证据 | 见 E2E-6 |

---

## 2. 点击链路状态机

### 2.1 Web 侧（`web-entry/client.js`）

```
                     ┌──────────────────────────────┐
                     │ S0  IDLE                     │  WengchengSidebarEntry 只渲染 <span>
                     │     无 onClick（F2：行点击归外壳）│  图标；点击由外壳 selectPanel(id) 处理
                     └──────────────┬───────────────┘
                                    │ 用户单击侧栏
                                    ▼
                     ┌──────────────────────────────┐
                     │ S1  PANEL_MOUNTED            │  外壳按 main.key === 'fang-sidebar-entry'
                     │     FangLaunchPanel 挂载      │  选面板 → useEffect 立即 openPanel(null)
                     └──────────────┬───────────────┘
                                    │ 无用户激活（跨了一个 task）
                                    ▼
                     ┌──────────────────────────────┐
                     │ S2  LAUNCH_REQUESTED         │  隐藏 iframe.src='dsh-fang://open'
                     │     1500ms 后 remove()        │  ★ 无任何成功/失败观测点
                     └───┬───────────┬───────────┬──┘
                         │           │           │
         OS 调起 Electron  │           │ 浏览器拦截  │ 协议未注册
                         ▼           ▼           ▼
                 ┌──────────────┐ ┌──────────────────────────────┐
                 │ S3 LAUNCHED  │ │ S4 FAILED_SILENT             │
                 │ (不可观测)    │ │ 界面永远停在「正在打开…」      │
                 └──────────────┘ └──────────────┬───────────────┘
                                                 │ 用户点「若未自动打开，点此重试」
                                                 ▼
                                   openPanel(event) → preventDefault()
                                   → 又走 iframe 同一条路（★ 最好的一条路被主动掐掉）
```

**S2 的两个实现缺陷 [代码]：**

1. `openPanel()` 第一行就 `event.preventDefault()`（`client.js:11`）。
   重试链接 `href="dsh-fang://open"` 本来是**唯一带真实用户激活的顶层导航**，
   却被 `preventDefault()` 掐掉，改成程序化 iframe 导航 —— 把成功率最高的一条路封了。
2. `openPanel()` 的 `catch` 只在**同步抛错**时兜底；iframe 导航失败不抛错，`onload/onerror` 也不会为自定义
   scheme 触发。所以 `catch` 分支实际上永远不会执行。

### 2.2 Electron 侧（`main.cjs`）

```
E0 BOOT ──► E1 单实例锁 (267) ──► E2 whenReady: 注册 IPC (283-307)
                                      │
                                      ▼
                              E3 createWindow (186)
                                      │
              ┌───────────────────────┼──────────────────────────┐
              ▼                       ▼                          ▼
      E4 discoverUpstream      E5 bootstrapToken          E6 startProxy(0)
      (33-54, 800ms 探测)      GET /fang/api/auth-token   随机端口 + Host/Origin 门禁
              │                       │                          │
      仅认 /fang/api/auth-token      200→TOKEN               panelUrl
              ▼                                                  ▼
      E7 BrowserWindow.loadURL(panelUrl) ──► /panel/index.html ──► /dsh-fang/client.js
                                                                    │
                                                              E8 mountPanel()
                                                                    │
                                                              E9 轮询 /fang/api/* (5s)
```

**深链到达时有两条路径，只有一条被实现 [代码]：**

| 场景 | 代码位置 | 现状 |
|---|---|---|
| 热启动（已有实例） | `app.on('second-instance')` 271-274，扫 `argv` 找 `dsh-fang://` → `focusMain()` | ✅ 已实现，[实测] 有效 |
| 冷启动（首个实例） | 无 | ❌ `process.argv` 里的 URL **从未被读取**；只是因为 `createWindow()` 无条件执行，才“看起来能用”。任何 `?origin=…` 参数都会被丢弃。 |
| macOS `open-url` | 275-280 | 存在但 Windows 不会触发（仅 macOS） |

---

## 3. 失败降级（现状 vs 应有）

现状**没有任何降级状态**：所有失败都塌缩成 S4 的一句「正在打开瓮城桌面…」。

| 失败 | 现状表现 | 应有状态 / 文案 | 可观测信号 |
|---|---|---|---|
| F1 协议未注册（没装桌面端） | 永久「正在打开…」 | `未检测到瓮城桌面端` + 「安装」+「手动打开」 | 1.2s 内页面仍 `visibilityState==='visible'` 且未失焦 → 判 F1（启发式，见 §6 限制） |
| F2 浏览器/壳拦截自定义协议 | 同上 | `浏览器拦截了打开请求` + 「复制链接」+ 逐步指引 | 同上；console 会有 `Not allowed to launch` 类警告（不可编程读取） |
| F3 桌面端启动但上游不可达 | 面板能开，里面 502 JSON | `已打开桌面端，但未连上 DSH` + 显示 `upstream` + HTTP 码 + 「重试/改上游」 | 代理 502 `{error:'upstream-unreachable'}`（已实现，未上 UI） |
| F4 上游 401/无 token | 面板一片空 | `已连上但鉴权失败` + 「在桌面端重新登录」 | 代理透传 401 |
| F5 连错实例（R1/R2） | 数据看着“像那么回事”，但是别的 DSH | 头部常驻 `当前连接：<upstream> · DSH <session>`，可切换 | `fang:desktop-info` 已有 `upstream`，只差渲染 |
| F6 面板已开但被最小化/隐藏 | 无提示 | Web 侧显示 `桌面端已连接`（需回执通道，见 §4） | 需新增 ack |

**降级硬规则（建议写进验收）**

- 任何“正在做”的 UI，**必须有上限时间**（≤5s）和**终态**；禁止无限 spinner。
- 终态必须可操作：至少一个「重试」和一条「为什么失败」。
- 允许“乐观显示已连接”，但 5s 内收不到回执必须回落为“未确认”。

---

## 4. 必须补的协议 / IPC / 事件

### 4.1 协议（Web → 桌面，深链）

**现状**：`dsh-fang://open` —— 无参数、无来源、无一次性凭证。
**必须补**：把“打开”升级成“带上下文的认领请求”。

```text
dsh-fang://open
  ?origin=http%3A%2F%2F127.0.0.1%3A60386   # 发起方 DSH Web 源（必须 loopback 白名单校验）
  &upstream=http%3A%2F%2F127.0.0.1%3A60386 # 面板应绑定的宿主（解决 R1/R2）
  &session=<sessionId>                      # 可选：要打开哪个会话
  &nonce=<32B hex>                          # 一次性，60s TTL，用于回执认领
  &v=1
```

规则：

1. `origin` / `upstream` **只接受 `http://127.0.0.1:<port>` 或 `http://[::1]:<port>`**，其余整条丢弃并记日志。
2. `nonce` 由 Web 侧宿主半下发、桌面侧回传认领，**服务端只认自己发过的**（防伪造 ack）。
3. 冷启动也必须解析 `argv`（见 4.2），并且 `setAsDefaultProtocolClient` 的注册命令要能随安装位置变化自愈。

### 4.2 必须补的 IPC（Electron 主 ↔ 面板渲染层）

| 通道 | 方向 | 现状 | 必须补 |
|---|---|---|---|
| `fang:launch-context` | main → renderer | **不存在** | 返回解析后的深链上下文 `{origin, upstream, session, nonce, receivedAt}`；冷启动与 `second-instance` 都要写进 `pendingLaunch` |
| `fang:desktop-info` | invoke | 有（`main.cjs:292`），origin 门禁已有 | 增加 `boundUpstream`、`lastLaunchAt`、`proxyPort` |
| `fang:reveal-token` | invoke | 有（`298`），但面板**用不上**（它自己 `fetch('/fang/api/auth-token')`，`client.js:341`） | 建议删除或改为仅调试构建；DEF-4 的暴露面 |
| `fang:desktop-log` | invoke/stream | **不存在**（REQ-1） | 环形缓冲：`discoverUpstream` 结果、502、token 失败、深链解析结果 |
| `fang:panel-closed` | main → renderer/外部 | **不存在** | 关窗（`hide`）时发事件，用于回执 |
| `fang:open-external` | invoke | 有，白名单 http/https | 保留 |

**preload 漂移必须先修**：`preload.cjs` 暴露 4 个方法，`preload.mjs` 只暴露 2 个（无 `desktopInfo`/`revealToken`）。
`main.cjs:204` 用的是 `.cjs`，一旦有人切到 `.mjs`，面板静默失去 `desktopInfo`。二者应同源生成或删掉一个。

### 4.3 必须补的宿主侧路由/事件（Web ↔ 桌面，真正的“互联”）

**这是当前最大的空洞**：`web-entry/index.js` 的宿主半是 `export function apply() {}` —— 空实现。
所以 Web 侧**没有**任何可供桌面端回调的落点，两边只能靠“打开”这一个单向动作交流。

```text
POST /fang/panel/intent      (同源，DSH 会话鉴权)
  → { nonce, ttlMs: 60000, origin, upstream }        # 客户端拿去拼深链

POST /fang/panel/ack         (桌面端回调，凭 nonce)
  → 200 { ok: true }                                  # 标记 connected，广播事件

POST /fang/panel/closed      (桌面端关窗时回调，凭 nonce)
  → 200 { ok: true }

GET  /fang/panel/state       (SSE，同源)
  event: panel   data: { state: 'idle'|'launching'|'connected'|'closed',
                         upstream, version, lastAckAt, lastError }
```

要点：

- `/intent` 必须走 DSH 自己的 peer 鉴权（`webServer.register` 自带同源准入），**不要**自己造一套。
- `/ack`、`/closed` 只认 `nonce`（一次性、60s、单次消费），**不认 Bearer、不认 IP**——因为桌面端拿不到 DSH 的 URL token。
- `/state` 是 SSE，客户端订阅；**这就是 Web 侧“实时状态”的载体**，取代现在的“永久 loading”。
- 客户端 `FangLaunchPanel` 改为：`POST /intent` → 拼深链 → 导航 → 5s 内等 `/state` 的 `connected`，否则进 F1/F2 终态。

### 4.4 必须补的实时通道（面板 ↔ 后端）

| 缺口 | 现状 | 补法 |
|---|---|---|
| 代理挡掉 SSE | `main.cjs:171` 只放行 `/fang/api/`；SSE 在 `/fang/adapter/events` | 白名单加 `'/fang/adapter/'`（并把 `connection: keep-alive`、禁用缓冲透传） |
| 面板不消费 SSE | 5s 轮询 `POLL_MS = 5000` | 新增 `EventSource('/fang/adapter/events?since=' + cursor)`；`410 cursor-expired` → 全量重拉一次；`409 session-changed` → 重绑会话 |
| 无 presence 通道 | 完全没有 | 与文档流分开的 ephemeral 通道（TTL + 合流），**不要**写进事件流 |
| 顺序/去重 | 轮询快照天然无重复，但也无增量 | SSE 用 `since` 游标续传；事件带 `id`，客户端按 id 幂等 |

---

## 5. 建议的落地补丁（片段，未应用）

### 5.1 重试链接保留原生导航（`web-entry/client.js`）

```js
function openPanel(event, { allowIframe = true } = {}) {
  const url = 'dsh-fang://open'
  // 有真实用户激活时，让浏览器自己做顶层导航——这是成功率最高的一条路。
  if (!event || typeof event.preventDefault !== 'function') {
    if (allowIframe) injectIframe(url)
    return
  }
  // 不 preventDefault：保留 <a href="dsh-fang://open"> 的原生行为
  setTimeout(() => { if (!document.hidden) injectIframe(url) }, 400) // 兜底，仅在页面没失焦时
}
```

### 5.2 冷启动解析深链 + 回执（`main.cjs`）

```js
// 放在 whenReady 之前
let pendingLaunch = null
function parseLaunchUrl(raw) {
  try {
    const u = new URL(raw)
    if (u.protocol !== PROTOCOL + ':') return null
    const origin = u.searchParams.get('origin') || ''
    const upstream = u.searchParams.get('upstream') || ''
    const loopback = (v) => /^http:\/\/(127\.0\.0\.1|\[::1\]):\d+$/.test(v)
    if (origin && !loopback(origin)) return null
    if (upstream && !loopback(upstream)) return null
    return { origin, upstream, session: u.searchParams.get('session') || '', nonce: u.searchParams.get('nonce') || '', at: Date.now() }
  } catch { return null }
}
const launchArg = process.argv.find((a) => String(a).startsWith(PROTOCOL + '://'))
pendingLaunch = launchArg ? parseLaunchUrl(launchArg) : null
if (pendingLaunch?.upstream) UPSTREAM = pendingLaunch.upstream   // 深链优先，压过 discoverUpstream

// second-instance 里同样解析并更新 pendingLaunch，再 focusMain()
// 新增 IPC
ipcMain.handle('fang:launch-context', (e) => guardOrigin(e) ? pendingLaunch : { ok: false, error: 'forbidden' })
```

### 5.3 代理放行 SSE（`main.cjs:169-173`）

```js
if (url.pathname.startsWith('/fang/api/') || url.pathname.startsWith('/fang/adapter/')) return proxy(req, res)
```

### 5.4 宿主半路由（`web-entry/index.js`，当前是空 `apply`）

```js
export function apply(ctx) {
  const intents = new Map()            // nonce -> { createdAt, state }
  ctx.effect(() => ctx.webServer.register({                     // 具体 API 名以宿主 Service 为准
    path: '/fang/panel/intent', method: 'POST',
    handler: async () => {
      const nonce = crypto.randomBytes(16).toString('hex')
      intents.set(nonce, { createdAt: Date.now(), state: 'launching' })
      return Response.json({ nonce, ttlMs: 60000, origin: ctx.webServer.getOrigin() })
    },
  }))
  // /fang/panel/ack、/fang/panel/closed、/fang/panel/state(SSE) 同理
}
```

> ⚠️ `ctx.webServer` 的确切注册签名请以 `cordis_inspect_query` 的 `Service.listService`（`webServer`）为准；
> 上面只是形状，不是可直接编译的最终代码。

---

## 6. 端到端测试步骤（可直接粘）

> 每条都给了**预期**与**当前实测值**。当前值不为绿的，就是缺口本身，不许改写成通过。

### E2E-1 入口渲染（浏览器）
1. 打开 `http://127.0.0.1:60386`（带 token 的 URL）。
2. 侧边栏找红门图标，`title="瓮城"`；DevTools 里应有 `[data-fang-entry="sidebar"]`。
3. **通过**：一次点击后中列切到 `[data-fang-entry="launch-panel"]`。
4. 当前：**[未验证]**（client inspect 超时，无法远程确认）。

### E2E-2 自动唤起（浏览器 console）
```js
// 在 GUI 页面执行，观察是否出现浏览器拦截
const f = document.createElement('iframe'); f.style.display='none'; f.src='dsh-fang://open';
document.body.appendChild(f); setTimeout(()=>f.remove(),1500)
```
- **通过**：系统弹“是否打开 dsh-fang”或直接聚焦面板，**且** console 无 `Not allowed to launch` 类告警。
- 当前预期：**失败**（无用户激活，子框架发起），且 **Web 端无任何感知** —— 这正是 R3。

### E2E-3 热启动唤起（已通过，可回归）
```powershell
& '<user-home>\.dsh\electron\electron.exe' '<repo>-desktop' 'dsh-fang://open'
$LASTEXITCODE   # 期望 7；主进程数仍为 1
```
- 实测 2026-11-06：`exit=7`，620ms，主进程 1 个 → **PASS**。

### E2E-4 冷启动唤起
```powershell
Stop-Process -Id 1544 -Force           # 先杀面板（会连托盘一起退）
& '<user-home>\.dsh\electron\electron.exe' '<repo>-desktop' 'dsh-fang://open'
# 期望：≤5s 出窗口；进程常驻；托盘可唤回
```
- 当前：窗口会出（因为 `createWindow()` 无条件执行），但 **argv 里的 URL 被丢弃** → 只能算“碰巧通过”，不能算功能通过。

### E2E-5 面板绑定的是哪台宿主（关键）
```powershell
# 端口以面板进程为准
$pid = (Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
        Where-Object { $_.CommandLine -notmatch '--type=' }).ProcessId
Get-NetTCPConnection -OwningProcess $pid -State Listen    # 取 127.0.0.1:<port>
# 然后
curl.exe "http://127.0.0.1:<port>/panel/index.html"       # 期望 200 + 瓮城标题
```
- **通过**：`fang:desktop-info` 返回的 `upstream` **等于**你在浏览器里用的那个源（60386）。
- 当前预期：`upstream = http://127.0.0.1:3080` → **FAIL**。其中“发现函数返回 3080”是**用 `main.cjs` 原码跑的实测结论**；“运行中面板确实绑了 3080”未取到端口核对，见 §1.2。

### E2E-6 实时性（轮询 vs 推送）
```powershell
# 起一个 SSE 客户端打后端；同时看面板是否 5s 才变
curl.exe -N "http://127.0.0.1:3080/fang/adapter/events?since=0"   # 直连：应有 event-stream
curl.exe -N "http://127.0.0.1:<panelPort>/fang/adapter/events?since=0"  # 经代理：当前 404
```
- **通过**：面板侧 <150ms 收到事件，且断线后按 `since` 续传无重复。
- 当前：代理 **404**（白名单），面板 **5s 轮询** → **FAIL**。

### E2E-7 上游不可达的降级
```powershell
Stop-Process -Id 10112 -Force     # 停 3080
# 在面板里点刷新 / 等一轮轮询
```
- **通过**：≤3s 出现人话错误（含 upstream 与 HTTP 码）+ 可重试；进程存活。
- 当前：代理返 502 JSON（`main.cjs:139-147`，**已实现**），但面板 UI 无对应呈现 → **部分 FAIL**（REQ-1）。

### E2E-8 401 / token 失效
```powershell
$env:FANG_UPSTREAM='http://127.0.0.1:60386'; & $exe '<repo>-desktop'
```
- **通过**：面板明确显示“鉴权失败”，不是空白。
- 当前预期：`bootstrapToken()` 拿到空串（60386 无该路由）→ 后续全部 401，UI 空白。

### E2E-9 连错实例的可见性
- **通过**：面板头部常驻 `当前连接：<upstream>`。
- 当前：`fang:desktop-info` 已有该字段，但**没有任何 UI 渲染它** → FAIL。

### E2E-10 回执闭环（补齐 §4.3 后）
1. 点入口 → `POST /fang/panel/intent` 拿 nonce。
2. 深链带 nonce 打开面板 → 面板 `POST /fang/panel/ack`。
3. Web 侧 `/fang/panel/state` 在 2s 内收到 `connected`。
- 当前：协议里没有 nonce，也没有 `/ack`、`/state` → **NOT IMPLEMENTED**。

### E2E-11 卸载/未安装
```powershell
Remove-Item 'HKCU:\Software\Classes\dsh-fang' -Recurse
# 点入口
```
- **通过**：1.2s 内出现“未检测到桌面端”终态 + 安装指引。
- 当前：永久 loading → FAIL。**测完请恢复注册表**（或重跑一次桌面端让它自注册）。

### E2E-12 双实例/重复点击
- 连点 5 次入口。
- **通过**：面板只有 1 个窗口、1 个代理端口、无进程泄漏。
- 当前：单实例锁 [实测] 有效；但每次挂载都会重发一次 iframe，属噪声。

---

## 7. 修复顺序（按“能立刻验证”的价值排）

1. **R2（一行级）**：`discoverUpstream` 增加“发起方给的 upstream”优先级；深链带 `upstream` 时直接采用并跳过探测。
2. **R1（部署级）**：明确单一宿主策略 —— 要么给 `desktop` profile 装 `@twinsearth/dsh-fang`，要么规定“瓮城面板只服务 fangweb，Web 也用 3080”。**两边各装一半 = 永久分裂**。
3. **R3（设计级）**：宿主半路由 `/intent` `/ack` `/state` + 深链 nonce。这是“互联”的最小闭环。
4. **R4（性能级）**：代理放行 `/fang/adapter/`，面板接 SSE + 游标，删掉 5s 轮询。
5. **降级 UI**：F1/F2/F3/F5 四态先于任何新功能。
6. **安全收尾**：删 `fang:reveal-token`（面板不需要）、统一两个 preload、给窗口加 `will-navigate`/`setWindowOpenHandler` 拒绝（DEF-4 里那条仍未做）。

---

## 8. 给接手人的三条硬约束

1. **不要把“窗口出现了”当成“链路通了”。** 现在的冷启动通过是副作用，不是实现。
2. **不要把 5s 轮询改个名字叫实时。** 后端明明有带游标的 SSE，代理却把它 404 了 —— 先把白名单修了再谈实时。
3. **不要在两个 profile 里各装一半。** 入口在 `desktop`、后端在 `fangweb`，这个配置会稳定地产生“面板显示的不是当前会话”这类最难排查的故障。

---

### 附：本次诊断触及的文件

- `<repo>\web-entry\client.js`（97 行，入口渲染与深链发起）
- `<repo>\web-entry\index.js`（3 行，宿主半空实现 ← 互联缺口的物理位置）
- `<repo>-desktop\main.cjs`（315 行，协议注册/发现/代理/IPC）
- `<repo>-desktop\preload.cjs`（7 行）与 `preload.mjs`（7 行，缺两个 API）
- `<repo>\src\plugins\adapter.mjs`（SSE 路由 `1229`）
- `<repo>-desktop\panel\index.html`（56 行，开发期挂载 shim，依赖 `mountPanel`）
