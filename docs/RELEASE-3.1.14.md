# dsh-Fang v3.1.14 发布说明

- 版本：`3.1.14`（上一个发布 `3.1.13`）
- 主题：修复元主/分身 Web 不显示身份徽标；徽标改为 **红/蓝/绿** 三色。

## 问题

v3.1.13 中：
- DSH 宿主端（母体）能看到红标「母体」；
- 元主 Web、分身 Web 看不到任何徽标。

根因：徽标识别调用 `/fang/adapter/hello`，该路由需要 `Authorization: Bearer <adapterToken>`；
浏览器拿不到 adapter token，fork 实例返回 401 → 识别失败 → 徽标隐藏。
母体走 `/fang/api/status`，所以不受影响。

## 修复

1. 新增公开只读路由 `GET /fang/adapter/identity`：
   - 只返回 `{ role, kind, version, protocol }`，不含 taskId/sessionId/token；
   - 服务端仍只监听 loopback；
   - `kind` 由 `identityKind({role, taskId, essence})` 计算：`mother` / `essence` / `fork`
     （元宝运行态由 `DSH_FANG_ESSENCE=1` 或 `rt-` forkId 识别）。
2. 客户端识别顺序：`/fang/api/status`（母体）→ `/fang/adapter/identity`（元主/分身）→
   旧宿主 `hello` 兜底；失败隐藏而非显示错误身份。
3. 颜色：
   - 母体 **红** `#C8102E`
   - 元主 **蓝** `#0A6BE0`
   - 分身 **绿** `#17803D`

## 验证

```text
test/client-role-badge-dom.test.mjs   6/6
test/adapter-identity.test.mjs        1/1
版本/角色/插件形状套件                 通过
preflight --e2e                       GREEN（含 crash-safety + 打包后门禁）
```

## 升级与生效

- 升级到 3.1.14 后需**重启对应 Web 宿主**才会加载新的 identity 路由与客户端：
  - 母体：重启 DSH；
  - 元主运行态：重新打开元宝；
  - 已运行的分身：重启该分身（或由看护重启）。
- 旧运行实例不会热更新，仍显示旧行为。
