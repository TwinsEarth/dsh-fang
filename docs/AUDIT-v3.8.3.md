# v3.8.3 审计（2026-11-25）

> 本版审计只覆盖 P0 三项与 P1/P2 接线；不做发布签署。

## 结论

- P0-1 Job Object：**Windows 真机通过**（helper 被杀 → fork 子/孙进程死亡）。
- P0-2 workspace 映射：**Windows 真机单测通过**（6/6）；真实 fork home 迁移待宿主在线。
- P0-3 拒绝外部回退：**源码/单测通过**；真实浏览器成功态待宿主在线，失败态在 HSD 为 503 fail-closed。
- P1：flush、idle-close、sidecar/log/Safe Mode UX 已有测试；发布记录补齐到“准备中”。
- P2：代码与定向测试存在；真实宿主长稳未跑。

## 红线检查

- 未删除/移动用户 workspace 原文件；映射只改 Fang metadata 与 session 副本，含备份/清单。
- 未自动 commit/push/tag/publish。
- 未绕过登录、验证码、权限校验。
- `window.open` 已从 `client.js` 清除，无静默外部浏览器回退。
