# Adapter 命令入口与扩展（v2.6.8）

> 代码：`src/plugins/adapter.mjs`（HTTP 路由 + `commands()` + `registerCommand`）、
> `src/lib/adapter-protocol.mjs`（`EventLog` / SSE / `CommandCache` re-export）、
> `src/lib/command-cache.mjs`（幂等）。
> 本文把设计稿（Adapter 侧 CommandHttpHandler / EventLog / CommandHandler / AdapterServer）
> 映射到本仓库已有实现，并记录 v2.6.8 补齐的两处：**外部命令注册** 与 **413 body 上限**。

## 1. 已存在的部分（v2.6.1 / v2.6.3）

| 设计稿组件 | 本仓库实现 |
|---|---|
| `POST /api/adapter/commands` | `POST ${prefix}/adapter/commands`（默认 `/fang/adapter/commands`） |
| Bearer 认证 | `DSH_ADAPTER_TOKEN` env → `Authorization: Bearer`；未注入时 v2 兼容（DSH web token 守卫） |
| `CommandHttpHandler` | `adapter.mjs` 的 `route('POST', COMMANDS, …)` + `readJsonBody()`（1 MB 上限、413） |
| `CommandCache` | `src/lib/command-cache.mjs` 的 `run()`：in-flight 合并、completed 重放、失败契约、LRU |
| `EventLog` | `src/lib/adapter-protocol.mjs` 的 `EventLog`：cursor(uint64 字符串)、ring buffer、`since()`、gap |
| SSE `GET /events` | 同文件路由：回放 → 订阅 → 心跳；session 不匹配 409、cursor 过期 410 |
| `command-done` 推送 | 内置异步路径与外部注册 executor 都通过 `publish({kind:'command-done',…})` |
| Cordis 接线 | `ctx.inject(['webServer'])` → `webServer.register({kind:'exact', path, handler})`；无 webServer 时 service 仍可用 |
| 命令结果形状 | v3 信封：`{ok,op,result,commandId}`；异步 `{ok:true,status:'accepted',trackingId,…}` |

> **为什么没有独立 AdapterServer**：本仓库的 DSH `webServer` 确实支持 `register({path, handler})`，
> Adapter 已复用分身端口（e2e 45/45 验证），不需要 Forker 再分配第二个端口。
> 设计稿的独立端口方案仅作为回退：若 `webServer` 缺失，`service` 仍可进程内调用，
> 但当前不实现额外监听（避免端口池翻倍）。

## 2. v2.6.8 新增：外部命令注册

业务插件（Scorer/Approver/未来 load-plugin 等）可以在 apply 里注册命令：

```js
const adapter = ctx.get(SERVICE.adapter)       // 分身内
const dispose = adapter.registerCommand('demo-load', async (payload, execCtx) => {
  // execCtx: { commandId, trackingId, emit(event), logger }
  if (!execCtx.trackingId) return { status: 'rejected', code: 'bad-tracking-id', message: 'missing' }

  // 异步执行：立刻返回 accepted，完成后推 command-done
  void (async () => {
    try {
      const result = await loadPlugin(payload.pluginId)
      execCtx.emit({
        kind: 'command-done',
        trackingId: execCtx.trackingId,
        result: { status: 'completed', result },
      })
    } catch (e) {
      execCtx.emit({
        kind: 'command-done',
        trackingId: execCtx.trackingId,
        result: { status: 'rejected', code: 'load-failed', message: String(e?.message ?? e) },
      })
      execCtx.emit({ kind: 'error', code: 'load-failed', message: String(e?.message ?? e) })
    }
  })()
  return { status: 'accepted', trackingId: execCtx.trackingId }
})
// dispose() 后该 op 回到 unknown-op
```

约定：

- **executor 自己决定同步/异步**：
  - 返回普通对象 → 200 `{ok:true,op,result}`；
  - 返回 `{status:'completed', result}` → 200 `{ok:true,op,status:'completed',result,commandId}`；
  - 返回 `{status:'rejected', code, message}` → 失败信封（HTTP 状态由 code 映射）；
  - 返回 `{status:'accepted', trackingId}` → **202**，executor 负责异步完成并 `emit` command-done；
- **trackingId 稳定**：未显式提供时使用 `track_<commandId>`（同 commandId 重试得到同一 trackingId）；
- **内置 op 不可覆盖**：`registerCommand` 对 `HANDLERS` 里的 op 抛错，避免协议语义被第三方替换；
- **幂等**：`commands()` 仍用 `CommandCache.run(commandId, …)` 包住整次执行；
  accepted 也进缓存（重放返回同一 trackingId，不会启动第二个异步任务）；
- **command-done 结果形状必须与同步结果同构**（母体 `ForkClient` 的 inflight 会原样交付）；
- **错误隔离**：executor 抛错 → `handler-threw`（fail-closed）；`ctx.emit` 内异常不会打断命令。

## 3. HTTP 语义（现状）

| 情况 | 状态码 | 响应 |
|---|---|---|
| 同步成功 | 200 | `{ok:true, op, result, commandId}` |
| 已完成命令重试 | 200 | 同上 + `deduplicated:true` |
| 异步 accepted | 202 | `{ok:true,status:'accepted',trackingId,commandId}` |
| 异步 accepted 重试 | 202 | 同上 + `deduplicated:true`，trackingId 不变 |
| 非法 JSON / 缺 commandId / 缺 op | 400 | `{ok:false, code:'bad-request'…}` |
| body > 1 MB | **413** | `{ok:false, code:'body-too-large'}` |
| token 错误 | 401 | `{ok:false, code:'unauthorized'}` |
| 未知 op | 400 | `{ok:false, code:'unknown-op'}` |
| 业务失败 | 400/404/409/500/503 | code → `ADAPTER_ERROR_STATUS` |
| 命令硬超时 | 409 | `code:'timeout'` |

## 4. EventLog / SSE 语义（现状）

- cursor 从 1 单调递增，JSON 里是十进制字符串；
- ring buffer 默认 1000（`eventCapacity`），`since` 早于最旧 → 410 `cursor-expired`；
- `session` 与当前 `sessionId` 不同 → 409 `session-changed`（进程重启后 cursor 从 1 重来，
  必须靠 sessionId 判断，不能跨进程比较 cursor）；
- 心跳是注释帧（不占 cursor）；连接建立先回放再订阅；
- 异步命令完成 → `command-done` 进 EventLog → 母体通过 `since` 续传，断线不丢。

## 5. 测试（v2.6.8 新增 4 项，`test/adapter.test.mjs`）

1. registerCommand 同步命令：200 + commandId 幂等 + disposer 后 unknown-op；
2. registerCommand 异步命令：202 + EventLog 中 `command-done` + 重试同 trackingId；
3. registerCommand 拒绝覆盖内置 op；`{status:'rejected'}` 映射为失败信封；
4. 请求体超过 1 MB → 413 `body-too-large`，executor 不被调用。

## 6. 边界

- **没有独立监听端口**：依赖 DSH webServer；若宿主不提供，Adapter service 仍可进程内调用，
  但 HTTP 控制面不可用（README 的兼容说明）。
- **accepted 后进程崩溃**：command-done 永远不会到达；母体 `ForkClient` 的 asyncTimeout 兜底。
  Adapter 侧无法补偿（进程已不存在）。
- **命令结果不写回缓存**：accepted 缓存保留；最终结果只走 EventLog（cursor 补发保证不丢）。
- **body 上限 1 MB**：`readJsonBody` 硬编码；超限直接 413，不进入 executor。
