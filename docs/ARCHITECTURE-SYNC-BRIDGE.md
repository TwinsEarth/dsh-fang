# 同步 / 桥接 / 混合路由（v2.5.0）

## 边界

| 通道 | 单位 | 前提 | 冲突 | 跨机 |
|---|---|---|---|---|
| sync（fang-session-sync） | 会话文件目录 | PC 可离线 | keep-both + `.fork-<ts>`，永不覆盖 | ✅ 文件/bundle |
| bridge（fang-session-bridge） | 运行中会话 | PC 宿主在跑 + desktop-bridge 已启用 | 无并发写（宿主独占） | ❌ 仅 127.0.0.1 |

插件数据（profiles/）按 v2.4 的单向原则只允许 Web→PC；本版两个通道只处理**会话数据**，不改插件目录。

## bridge 契约（来自 @ignotuss/dsh-desktop-bridge@0.1.0 源码验证）

- 描述文件：`<DSH_HOME>/desktop-bridge.json` = `{version:1, address:"127.0.0.1", port, token, pid, startedAt}`，文件 0600；
- 端口/token 每次插件挂载重新生成 → 每次调用重读，不缓存；
- `GET /v1/sessions`、`GET /v1/sessions/{id}/events?limit=1..100`、
  `POST /v1/sessions/{id}/messages {text(1–4096B)}` → `{accepted, requestId}`、`POST /v1/sessions {cwd,title?}`；
- **prompt 不是流式**：只能拿 requestId + 轮询 events（建议 500ms–1s、按 seq 增量）；
- 安全：Host 必须回环、拒绝 Origin；任何能读 descriptor 的进程都能驱动 PC 宿主 → 仅在需要时启用 bridge。

## sync 契约

导出 bundle：`sessions/<workspaceKey>/<sessionId>/session.v4.jsonl.zstd` + `manifest.json`
（version/createdAt/source/sessions[{sessionId,workspaceKey,workspacePath,workspaceTitle,bytes,sha256,mtimeMs}]）。
导入：sha256 校验通过才落盘；目标已有同名会话 → 写 `.fork-<ts>` 并报告 conflict；工作区匹配不上 → `pendingMatch`。

## 路由真值表

```
cross-machine + realtime        -> deny
oneTimeMigration                -> sync
same-machine + host + bridge + realtime -> bridge
default                         -> sync
```
