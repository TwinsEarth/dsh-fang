# AUDIT v3.1.14

> 版本：3.1.14（2026-11-11）
> 范围：修复元主/分身 Web 不显示身份徽标；徽标红/蓝/绿三色。

## 1. 现场证据

- 母体 Web：红标「母体」正常（走 `/fang/api/status`，200，role=mother）。
- 元主 Web（127.0.0.1:18000）/ 分身 Web（127.0.0.1:18001）：无徽标。
- 实测运行中的分身 adapter：
  `GET /fang/adapter/hello`（无 token）→ **401** `{"ok":false,"error":"unauthorized",...}`；
  客户端 `detectWebRole()` 需要 200，因此返回空 → 徽标隐藏。
- `/fang/api/status` 在 fork 实例不存在（母体专属路由），也拿不到身份。

## 2. 根因

adapter 的 hello 属于 Bearer 鉴权路由（`checkRequestAuth` + `authorized`），
token 由母体 spawn 注入到 fork 进程环境，浏览器端没有该 token。
v3.1.13 的徽标识别依赖 hello 200 拿 `kind`，导致 fork 系（元主/分身）识别失败。

## 3. 修复

| 层 | 改动 |
|---|---|
| 协议 | `ADAPTER_ROUTE.IDENTITY = '/adapter/identity'` |
| adapter | 新增公开只读路由 `GET /fang/adapter/identity`，仅返回 `{role,kind,version,protocol}`；新增导出纯函数 `identityKind({role,taskId,essence})` |
| 识别 | `identityKind`：`role=mother` → mother；`DSH_FANG_ESSENCE=1` 或 `taskId` 以 `rt-` 开头 → essence；否则 fork |
| 客户端 | `detectWebRole()`：status（母体）→ identity（元主/分身）→ 旧 hello 兜底；失败隐藏 |
| 样式 | `.fang-web-role--mother` 红 `#C8102E`；`--essence` 蓝 `#0A6BE0`；`--fork` 绿 `#17803D` |

公开路由的安全边界：只监听 loopback、只返回非敏感身份字段；不返回 taskId/sessionId/token，
也不能执行命令。

## 4. 测试

```text
test/client-role-badge-dom.test.mjs  6/6
  - 母体：status 200 → 红「母体」
  - 元主：identity kind=essence → 蓝「元主」
  - 旧宿主：identity 404 + hello taskId=rt- → 蓝「元主」
  - 分身：identity kind=fork → 绿「分身」
  - CSS 三色契约 + 追加插入/重渲染补回/dispose 清理
  - 接线：identityKind / ADAPTER_ROUTE.IDENTITY / client identity 调用
test/adapter-identity.test.mjs       1/1（mother/essence/fork/env 优先级）
```

## 5. 生效条件

代码需升级到 3.1.14 并重启对应宿主：母体重启 DSH；元主重新打开元宝；
已运行分身重启（或由看护重启）。旧实例不会热更新。

## 6. 边界

- identity 路由公开只读；不改变 adapter Bearer 鉴权、命令/事件路由的安全模型。
- 徽标识别失败仍隐藏，避免显示错误身份。
- 分身/元主的颜色依赖最新客户端；旧实例保持旧行为。
