# 分身 Web UI 模式（v2.6.6）

> 问题：在分身（dsh-Fang fork）自己的 Web UI 里打开「瓮城」面板，会看到
> 「母体状态不可读 · http-404」「分身列表不可读 · http-404」「会话目录不可读 · http-404」。
> 这不是插件坏了：**母体 API（`/fang/api/*`）在分身宿主里按设计不存在**。
> 本文记录 v2.6.6 的识别与降级行为。

## 1. 为什么会 404

| 宿主 | role | 存在的 dsh-Fang 路由 |
|---|---|---|
| 母体 dsh-Desktop | `mother` | `/fang/api/*`（orchestrator 任务/面板/会话目录）+ `/fang/adapter/*`（仅分身体内） |
| 分身 dsh-Web（fork） | `fork` | 只有 `/fang/adapter/*`（Adapter 自己的路由） |

分身的 profile bundle 同样包含 `@local/dsh-fang`，所以 **client 半**（`client.js`）也会加载，
侧栏仍会出现「瓮城」入口；但 host 半的 orchestrator 在 `roleGate('orchestrator')` 处不激活，
于是面板里的 `/fang/api/status`、`/tasks`、`/sessions` 全部 404。

## 2. 探测规则

```
GET /fang/api/status
  ├─ 200 且 body.ok !== false  → host = mother
  └─ 其它（通常 404）
       └─ GET /fang/adapter/hello
            ├─ 200 → host = fork（旧分身，无 Bearer）
            ├─ 401 → host = fork（v2.6.1+ 分身，Adapter 要求 Bearer）
            └─ 其它 → host = unknown（母体 dsh-Fang 未加载 / 宿主异常）
```

探测结果缓存在模块级 store（`hostRoleStore`），面板与输入框徽标共享；
一次页面生命周期只探测一次（同一次刷新内）。

## 3. 分身模式下的 UI 行为

- **面板**：不再渲染母体任务/会话两栏，也不再发 `/fang/api/*` 请求；
  只渲染一张说明卡：
  「当前页面是分身的 Web UI … 母体接口 /fang/api/* 在分身里不存在，这是预期行为，不是插件故障 …
  要派生、归档或管理分身，请回到母体窗口的「瓮城」面板」。
- **输入框 dock 徽标**：隐藏（分身里没有母体状态可显示，也不该报「瓮城离线」）。
- **侧栏图标**：保留（注册项无法按角色摘除）；点击打开同一张说明卡。
- **母体模式**：行为完全不变（探测成功后才会开始刷新 `/fang/api/*`，避免先打一轮 404）。

## 4. 为什么不用「隐身」而用说明卡

分身 Web UI 里用户仍可能点击侧栏「瓮城」，如果什么都不显示会像插件失灵；
说明卡同时告诉用户「这是分身、母体面板在另一个窗口」，减少误报。

## 5. 验证

1. 在母体面板派生一个分身，点「打开」进入分身 Web UI；
2. 点侧栏「瓮城」→ 应看到分身说明卡，**没有** 404 错误块；
3. 输入框 dock 不出现「瓮城离线」徽标；
4. 回到母体窗口 → 面板恢复两栏、状态数据正常（探测为 mother 后才刷新）；
5. 母体未加载 dsh-Fang 的场景：面板仍显示「母体状态不可读」，诊断里 probe 会给出
   `status 404 · adapter 404`。

## 6. 限制

- 分身侧栏图标无法由 client 半摘除；如需完全隐藏，需要宿主支持按 client 插件/角色过滤 slot。
- 分身 Adapter 在 v2.6.1+ 需要 Bearer，浏览器拿不到 token，因此面板只做角色判定，
  不展示 Adapter 详情（避免把 401 当成「适配器故障」）。
- 旧版分身（v2.6.0 之前）没有 `/fang/adapter/hello` 的 401 语义，但 200 仍可识别。
