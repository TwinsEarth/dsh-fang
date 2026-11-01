# 审计报告 · dsh-Fang v2.6.3（CommandCache LRU + 幂等语义）

> 证据全部来自本机真实门禁输出（2026-11-01，Windows / Node 24.16.0）。
> 报告不含凭据、不含本机绝对路径（allow-list 自检同时扫描这两类内容）。
> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.6 的第 3 个补丁位（`2.6.2` → `2.6.3`）。

## 1. 范围

把命令幂等缓存从「get/set + LRU」升级为类级别的 `CommandCache.run()`：

1. **两态**：`running`（value 是同一个 promise）/ `completed`（value 是结果）；
2. **并发合并**：同一 `commandId` 并发提交，第二次等待同一个 promise，不重复执行副作用；
3. **失败契约**：业务失败（`fn` 返回 `status:'rejected'`）与 async accepted 都缓存；
   `fn` 抛错（传输/编程错误，命令可能没执行）不缓存并移除，允许重试重新执行；
4. **LRU**：`run()` 命中 touch、纯 `get()` 不 touch；只淘汰 completed，跳过 running；
   全是 running 时允许临时超限，in-flight 完成后自动收敛；
5. **配套 API**：`invalidate`（仅 completed）、`clear`（保留 running）、`stats`（容量/命中/去重/淘汰/丢弃）、
   `onEvict` 回调隔离、容量 ≥1 校验、时钟注入；
6. **Adapter 接线**：`commands()` 改为 `commandCache.run()`；并发同 commandId 只执行一次；
   只有真实执行的那一次发事件；无 commandId 仍不缓存（v2 兼容）。

文档：`docs/COMMAND-CACHE.md`；协议更新：`docs/PROTOCOL-V3.md §6.2/§12`。

## 2. 门禁结果

| 门禁 | 命令 | 结果 |
|---|---|---|
| 版本一致性 | `node tools/release/preflight.mjs --e2e` | **GREEN 2.6.3** |
| Client 半可解析 | 同上（v2.6.2 起的检查） | `node --check client.js` **green** |
| 单元/集成测试 | 同上（内嵌全量） | **347 pass / 0 fail / 1 skip（348 项，14.7s）** |
| e2e 实机验收 | 同上（内嵌 `tools/e2e.mjs`） | **45/45（11.3s）** |
| 路由 allow-list + 秘密/本机路径扫描 | `node tools/release/allowlist.mjs --with-manifest` | **PASS**：34 路由、0 findings、117 文件扫描、包内 66 文件 allow-listed |
| 构建 | `node tools/release/build.mjs` | `dist/dsh-fang-2.6.3.tgz`（**231,696 B，82 entries**）<br>sha256 `787fe370ceb834437c4cc96d4a8317712b7065fbcfdb3927a0efcc18e1cddb07` |
| 产物健康检查 | `node tools/release/healthz.mjs` | **HEALTHY** `@twinsearth/dsh-fang@2.6.3`（15 个模块可 import） |

## 3. 新增测试（17 项）

| 文件 | 数量 | 覆盖 |
|---|---|---|
| `test/command-cache.test.mjs` | 16 | 首次执行/完成重放；running 命中同一 promise 且只执行一次；业务失败缓存 vs 抛错不缓存（async / 同步抛错）；LRU 淘汰与 touch；纯 get 不 touch；running 不可淘汰 / 超限收敛；invalidate 仅 completed；clear 保留 running；onEvict 隔离；容量与参数边界；忽略 promise 仍缓存 + 无 unhandled；stats 计数 |
| `test/adapter.test.mjs` | +1 | 同一 commandId 并发提交 → 底层 `flush` 只执行一次，第二个返回 `deduplicated:true`；完成后再提交走 completed 重放 |

测试计数：331（v2.6.1）+ 16 + 1 = **348 项**（347 pass / 1 skip），与 preflight 输出一致。

## 4. 关键取舍（与需求稿一致）

- **契约**：`fn` 必须把「真正的执行失败」转成结果对象返回；只有「命令没执行到」的传输/编程错误才抛错。
  这条契约决定了「重试是否应该重新执行」，也避免了「缓存里存业务失败 vs 传输失败」的歧义。
- **先登记 running 再执行 fn**：`run()` 同步登记条目，`fn` 在微任务里执行，消除「fn 同步抛错时条目尚未登记」的竞态。
- **`run()` 不是 async 函数**：running 命中直接返回同一个 promise 对象（可断言、可复用）；
  参数校验错误同步抛出（TypeError / RangeError）。
- **缓存不实现超时**：超时属于命令层；缓存自己超时会出现「缓存已移除但 promise 还在执行」，
  下一次 run 会启动第二次执行，反而破坏幂等。
- **accepted 缓存**：异步命令的 accepted 信封进缓存（同一个 trackingId 重放），不随后台完成更新；
  结果以 `command-done` 事件为准。

## 5. 风险

1. **行为变化**：Adapter 的并发重复 commandId 从「两次执行」变为「一次执行 + 第二个 deduplicated」。
   这是本次目标，但客户端若依赖「每次 POST 都真正执行」会感知变化；协议文档已同步。
2. **淘汰偏好**：容量满且只有 newly-completed 时，会淘汰该 completed（LRU 语义的直接结果，
   见 `docs/COMMAND-CACHE.md §4`）；不要误以为「刚完成的永远保留」。
3. **单进程/不持久化**：跨重启不保证幂等；缓解方式是让命令副作用本身幂等（协议 §12 决策 2）。
4. **`clear()` 保留 running**：running 完成后仍会落缓存（它确实执行过）；如果需要「忘掉一切」，
   需要停止进程或扩展 generation 语义，当前刻意不做。

## 6. 提交状态

- 分支：`feat/command-cache`（stacked 在 PR #11 的 `feat/panel-fold-groups` 之上）；
- 发布物：`dist/dsh-fang-2.6.3.tgz` + `dist/manifest.json` + `dist/preflight.json` + `dist/allowlist.json`；
- npm/GitHub Release 未执行：等待 PR 合并与维护者确认；
- 未合并 main：本 PR 只推送分支与 PR，合并由维护者手动审核。
