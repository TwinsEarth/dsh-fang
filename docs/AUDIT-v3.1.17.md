# AUDIT v3.1.17

> 版本：3.1.17（2026-11-11）
> 范围：徽标兜底挂载、身份诊断字段、会话映射透传、发版钩子 annotated tag 兼容。

## 1. 变更审计

| 变更 | 风险 | 处理 |
|---|---|---|
| 徽标兜底挂到 `document.body` | 固定角标可能遮挡宿主 UI | `pointer-events:none` + 右上角小尺寸；仅在品牌槽不可用时启用 |
| `/fang/adapter/client-report` 公开 POST | 可被本机任意页面调用 | 只写时间戳（布尔+时间），不含身份/会话/token；loopback-only；无副作用 |
| `identity` 新增 `surface/clientLoaded` | 可能泄露部署信息 | 仅静态字符串与布尔/时间戳；**不含** taskId/sessionId/token（测试断言字段级） |
| `session.list` 新增 `sessionKey/ticketId` | 调用方注入任意字符串 | 仅原样回显、不参与过滤、不落盘；用于对齐展示 |
| 钩子/guard peel annotated tag | 放宽了 tag 校验？ | 只把 tag 对象解析到 commit（`^{commit}`）**再走同一 first-parent 判定**，规则强度不变 |

## 2. 安全边界（未变）
- adapter 仍只在 fork 角色激活；母体不注册该路由；
- 身份/自报不含凭据；契约 HTTP 仍需 Bearer + `x-fang-auth`；
- 会话目录仍只读、受 `previewMaxChars` 限制。

## 3. 验证
- 新增 `test/v3117.test.mjs` 5/5；
- 全量 `npm test` 见发布记录；
- 手工：真实 Host 中 `/fang/adapter/identity` 返回 `clientLoaded`（房主侧 smoke）。
