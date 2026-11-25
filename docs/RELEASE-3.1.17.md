# dsh-Fang v3.1.17 发布说明

- 版本：`3.1.17`（上一版 3.1.16）
- 主题：身份徽标兜底 + 身份诊断字段 + 会话映射透传 + 发版钩子兼容 annotated tag。

## 变更

### 1. 徽标兜底（B）
`mountWebRoleBadge` 增加兜底路径：

```text
品牌词标右侧（首选）
  ↓ 3 次重试（250ms）仍未找到
document.body 右上角固定角标（兜底，fang-web-role--fallback）
  ↓ 宿主重渲染摘掉
MutationObserver 自动补回（品牌行 / 兜底容器都监听）
```

### 2. 身份诊断字段（C）
`GET /fang/adapter/identity` 现在返回：

```json
{ "ok": true, "role": "fork", "kind": "essence", "version": "3.1.17", "protocol": 3,
  "surface": "web-adapter", "clientLoaded": true, "clientReportedAt": 1794xxxxx }
```

- `clientLoaded=false` + `kind=essence` ⇒ 服务端正常、**客户端 bundle 没加载**（旧运行态/缺 web-entry）；
- 新增 `POST /fang/adapter/client-report`（client 加载时自报，只记时间戳，无凭据）。

### 3. 会话映射透传
`session.list` 接受 `sessionKey` / `ticketId` 并原样带回（顶层与每个 session 项），
供 3_Sessions 与房主 Router 的 Ticket 映射对齐。

### 4. 发版钩子兼容 annotated tag
`.githooks/pre-push` 与 `guard-main.mjs` 先 `^{commit}` peel 再判断 first-parent，
修复 v3.1.16 release 的 `final verify`（annotated tag 被误判）失败。

## 兼容性
- 不改变既有路由语义；`identity` 只**新增**字段；`session.list` 新参数可选；
- 旧 client 不发 client-report 时 `clientLoaded=false`，其余行为不变。

## 验证
- `npm test`：全量通过（含新增 `test/v3117.test.mjs` 5 例）；
- release preflight（含 e2e）见发布记录。

## 升级方式
```bash
dsh plugin --profile <name> add @twinsearth/dsh-fang@3.1.17
```

升级后原身/分身运行态需重启才加载新 client（徽标兜底与新字段生效）。
