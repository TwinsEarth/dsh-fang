# CommandCache · LRU + 幂等语义（v2.6.3）

> 代码：`src/lib/command-cache.mjs`；单测：`test/command-cache.test.mjs`（16 项）；
> Adapter 接线：`src/plugins/adapter.mjs` 的 `commands()`；协议位置：`docs/PROTOCOL-V3.md §6.2`。
>
> 它解决三件事：同一 `commandId` **至多执行一次**、并发提交**合并为同一个 promise**、
> 容量超限时按 **LRU 只淘汰已完成项**。它在单进程内运行，进程崩溃后缓存与进程同生共死，
> 因此不持久化——它解决的是「短窗口重试不重复执行」，不是「跨重启一致性」。

## 1. 五个设计决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 缓存状态 | `running` / `completed` 两态 | running 用 promise 去重，completed 用结果去重 |
| 并发 | `running` 命中返回**同一个** promise | 避免同一 commandId 并发触发两次副作用 |
| 失败缓存 | 只有 `fn` **正常返回**的结果才缓存；`fn` 抛错则移除并重抛 | 区分「业务失败」（应缓存）与「传输/编程错误，命令可能没执行」（应允许重试） |
| LRU 顺序 | `run()` 命中即 touch；纯 `get()` 不 touch | 「使用」= 有效避免了一次执行；纯查询不改变缓存价值 |
| 淘汰策略 | 只淘汰 `completed`；全是 `running` 时允许临时超限 | in-flight 很快结束，强制淘汰会丢失正在执行的结果 |

## 2. 类型与 API

```js
import { CommandCache } from './command-cache.mjs'

const cache = new CommandCache({
  capacity: 500,                 // >= 1；非法值抛 RangeError
  onEvict: (commandId, entry) => {}, // 仅 completed；异常被隔离
  now: Date.now,                 // 时钟注入（测试用）
})

cache.run(commandId, fn)   // 幂等执行；返回 Promise<Result>
cache.get(commandId)       // completed 结果或 undefined（不 touch）
cache.has(commandId)       // running 或 completed 都为 true
cache.invalidate(id)       // 仅 completed 可失效；返回 boolean
cache.clear()              // 清 completed、保留 running；返回清掉的数量
cache.size()               // 当前项数（可能暂时 > capacity）
cache.stats()              // { total, running, completed, capacity, overCapacity,
                           //   executions, hits, dedupHits, evictions, droppedOnError }
cache.touch(id)            // 显式刷新 LRU 顺序（一般不用手动调用）
```

条目形状（内部）：

```js
{ state: 'running',   promise, startedAt }
{ state: 'completed', result, completedAt }
```

## 3. 并发时序

```
同一 commandId 的两个提交：
  run(id, fn)  ── miss ──▶ entries.set(id, {running, promise})
                                   │  fn 在微任务里开始执行（先登记，后执行）
  run(id, fn)  ── hit  ──▶ 返回同一个 promise（dedupHits += 1）
                                   │
                     fn resolve ──▶ entries.set(id, {completed, result})
                     fn reject  ──▶ entries.delete(id)（不缓存，重试可重新执行）
```

两个关键实现细节：

1. **先登记 running，再执行 fn**：`run()` 同步登记条目，`fn` 放在
   `Promise.resolve().then(...)` 里执行，避免「fn 同步抛错时条目还没登记」的竞态。
2. **只有本次执行仍占着该 commandId 时才覆盖结果**：完成回调里比较条目身份
   （`entries.get(id) === entry`），防御未来「允许 running 失效」等语义变化。

`run()` 不是 `async` 函数：running 命中直接返回**同一个 promise 对象**（可测、可断言），
参数校验错误（空 commandId / fn 非函数）同步抛出。

## 4. LRU 细节

- `Map` 的插入顺序即使用顺序；`touch()` 做 `delete + set` 把项移到末尾；
- 命中 `running` 或 `completed` 都 touch；纯 `get()` 不 touch（语义见决策表）；
- 超容量时从 Map 头部扫描**第一个 completed** 淘汰；遇到 running 跳过；
- 若全部是 running：本轮不淘汰，允许 `size > capacity`；等任一项完成时再次
  `evictIfNeeded()` 自动收敛（此时该 completed 可能就是被淘汰的那个——这是
  「只淘汰已完成项」的直接结果，文档化即可）；
- `onEvict` 只在 completed 淘汰时调用，回调抛错被隔离，不影响收敛。

## 5. 失败契约（重要）

| `fn` 的行为 | 是否缓存 | 语义 |
|---|---|---|
| 返回 `{ status:'completed', ... }` | 缓存 | 成功 |
| 返回 `{ status:'accepted', trackingId }` | 缓存 | 异步命令已接受；重复提交返回同一个 trackingId |
| 返回 `{ status:'rejected', code, message }` | **缓存** | 业务失败（如 plugin 不存在）——重试也不该重复副作用 |
| 抛错（网络断开 / 500 之外的传输错误 / 编程错误） | **不缓存并移除** | 命令很可能没执行到；允许重试重新执行 |

因此 `fn` 的实现者必须把「真正的执行失败」转成结果对象返回；只有「没执行到」才抛错。
Adapter 的 `command()` 本身永不抛错（失败都封装成 `{ok:false, code}`），所以 Adapter 侧的
业务/参数/依赖失败全部缓存；只有 `commands()` 自身抛出（如编程错误）才不缓存。

**超时不在缓存层**：缓存不实现 timeout。超时属于命令层（AbortController / 命令硬超时），
超时后 `fn` 抛错 → 缓存移除 → 重试才会重新执行。若缓存自己超时又移除，会出现
「缓存已移除但 promise 还在执行」，下一次 `run()` 启动第二次执行，反而破坏幂等。

## 6. Adapter 接线

```js
// 同步命令
const envelope = await commandCache.run(commandId, async () => ({
  ...(await command({ op, payload })), commandId,
}))
if (executed) publish({ kind:'command', op, ok, code, commandId })
else return { ...envelope, deduplicated: true }

// 异步命令（202 accepted）
const accepted = await commandCache.run(commandId, async () => ({
  ok: true, status: 'accepted', trackingId: commandId, op, commandId, async: true,
}))
if (executed) void command({op,payload}).then(result => publish({kind:'command-done', ...}))
```

- `executed` 由 fn 内部置位：只有真正执行的第一次调用会发 `command` / `command-done` 事件，
  并发等待者与 completed 重放都不会重复发事件；
- 无 `commandId` 的请求不经过缓存（兼容 v2 用法），直接执行；
- `trackingId` 与 `commandId` 是两个东西：前者追踪异步任务，后者用于去重；同一个
  commandId 重放返回同一个 trackingId，避免启动两次异步任务。

## 7. 测试清单

`test/command-cache.test.mjs` 覆盖：

1. 首次执行一次 + 结果落 completed + stats/get/size；
2. completed 命中重放、不执行；
3. running 命中返回同一个 promise、并发只执行一次；
4. 业务失败（rejected 结果）缓存；
5. fn 抛错不缓存、可重试重新执行（async 与同步抛错两种）；
6. LRU 超容量淘汰最旧 completed；
7. run 命中 touch 保住热点；
8. 纯 get 不 touch（与第 7 条对照）；
9. running 不可淘汰、全是 in-flight 时允许临时超限并在完成后收敛；
10. invalidate 只对 completed 生效；
11. clear 清 completed、保留 running，running 完成后仍落缓存；
12. onEvict 只对 completed 触发、回调异常隔离；
13. 容量边界（0/负数/NaN 抛 RangeError、向下取整）与参数校验；
14. 调用方忽略 promise 仍缓存；错误不产生 unhandled rejection；
15. stats 计数完整。

`test/adapter.test.mjs` 另有一条 HTTP/服务层用例：同一 `commandId` 并发提交 → 底层
`flush` 只执行一次，第二个调用返回 `deduplicated:true`；完成后再提交走 completed 重放。

## 8. 边界与未做

- **单进程**：commandId 唯一性范围是单进程（ForkClient 用 taskId + counter 生成）；
  多进程/多实例不共享缓存，这也是协议把去重放在分身侧的原因；
- **不持久化**：跨重启一致性不保证；重启后同一 commandId 会重新执行一次。缓解方式是让
  命令副作用本身幂等（例如 `load-plugin` 对已加载插件返回 completed）；
- **不实现超时**：见 §5；
- **accepted 的缓存**：异步命令的缓存保留 accepted 信封（不随后台完成更新）；后续同 id
  提交得到同一个 trackingId，结果以 `command-done` 事件为准；
- **容量为 0**：不允许（抛 RangeError）；「禁用缓存」应由调用方不经过 cache 实现。
