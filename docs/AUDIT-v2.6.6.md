# 审计报告 · dsh-Fang v2.6.6（分身 Web UI 模式）

> 证据来自本机真实探测与门禁输出（2026-11-01，Windows / Node 24.16.0）。
> 报告不含凭据、不含本机绝对路径（allow-list 自检同时扫描这两类内容）。
> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.6 的第 6 个补丁位（`2.6.5` → `2.6.6`）。

## 1. 现象与根因（实机证据）

用户截图：Web 端「瓮城」面板显示
`母体状态不可读 · http-404`、`分身列表不可读 · http-404`、`会话目录不可读 · http-404`。

本机探测：

| 探测 | 结果 |
|---|---|
| 母体 56080 `GET /fang/api/status` | **200** `{"version":"2.6.0","role":"mother",...}` |
| 分身 18001 `GET /fang/api/status` | **404** |
| 分身 18001 `GET /fang/adapter/hello?token=…` | **200**（Adapter 存在） |
| 分身 profile `package.json` bundles | `[dsh-base, dsh-web-app, @local/dsh-fang]` |

结论：截图来自**分身的 Web UI**（不是母体）。分身的 profile 同样加载 `@local/dsh-fang` 的
client 半，所以侧栏出现「瓮城」；但 orchestrator 是 `mother-only`（`roleGate('orchestrator')`），
`/fang/api/*` 在分身宿主里按设计不存在 → 404 被旧 UI 当成「插件不可读」渲染。

## 2. 修复（v2.6.6）

- `client.js` 新增宿主角色探测（模块级 store + `useHostRole`）：
  - `/fang/api/status` 200 → `mother`；
  - 否则 `/fang/adapter/hello` 200/401 → `fork`（401 表示 Adapter 存在但要求 Bearer，v2.6.1+）；
  - 两者都不成立 → `unknown`，沿用旧的错误诊断。
- 分身模式下：
  - 面板只渲染说明卡（「当前页面是分身的 Web UI」「母体 API 在分身里不存在，这是预期行为」），
    **不再发起** `/fang/api/*` 请求；
  - dock 徽标隐藏、不轮询，避免「瓮城离线」假故障；
- 母体模式下：只有探测为 `mother` 后才开始刷新，启动时不再先打一轮 404；
- 文档：`docs/UI-FORK-MODE.md`。

## 3. 门禁结果

| 门禁 | 命令 | 结果 |
|---|---|---|
| 版本一致性 | `node tools/release/preflight.mjs --e2e` | **GREEN 2.6.6** |
| Client 半可解析 | 同上 | `node --check client.js` **green** |
| 单元/集成测试 | 同上（内嵌全量） | **367 pass / 0 fail / 1 skip（368 项，33.2s）** |
| e2e 实机验收 | 同上 | **45/45（45.8s）** |
| allow-list + 秘密/本机路径扫描 | `node tools/release/allowlist.mjs --with-manifest` | **PASS**：34 路由、0 findings、129 文件扫描、包内 68 文件 allow-listed |
| 构建 | `node tools/release/build.mjs` | `dist/dsh-fang-2.6.6.tgz`（**238,071 B，84 entries**）<br>sha256 `8bd5120c38cad764bc936769e2bc56fcdf8f7783997ee13777ecbdcdefe57c26` |
| 产物健康检查 | `node tools/release/healthz.mjs` | **HEALTHY** `@twinsearth/dsh-fang@2.6.6` |

## 4. 未完成 / 需要人工确认

1. **视觉验收待重启**：本机后台宿主（56080）仍加载旧 client 半；未擅自重启。
   重启后进入分身 Web UI，点侧栏「瓮城」应看到说明卡而不是 404 错误块。
2. **新会话 `agent-preset/invalid` 是另一个问题（非 dsh-Fang）**：
   `tool-subagent (@deepseek-ai/dsh-tool-subagent): never started` 来自宿主 loader 的
   `auditRows`（`entry.fiber === undefined`）。桌面 profile 的 bundles 包含
   `@deepseek-ai/dsh-experimental-agent-team-profile`，该 bundle 的 patch **有意禁用**
   `tool-subagent-control / tool-subagent-list-agents / tool-subagent / tool-subagent-fork`
   并替换为 Team 工具；若新建会话所选 agent preset 仍引用这两行，preset 就会被判 invalid。
   可选处理（需用户确认，涉及 profile 配置）：
   - 新建会话时换一个不依赖 subagent 行的 preset（最简单，不改配置）；
   - 从桌面 profile bundles 移除 `dsh-experimental-agent-team-profile`（会失去 Agent Teams）；
   - 或加 profile patch 在 team bundle 之后重新启用 `tool-subagent` / `tool-subagent-fork`
     （可能与 Team 工具并存，需要实测）。
3. 分身侧栏图标仍保留（宿主 slot 无法按角色摘除），点击显示说明卡；如需完全隐藏需要宿主支持过滤。

## 5. 提交状态

- 分支：`feat/fork-ui-mode`（stacked 在 PR #14 的 `feat/sse-fuzz` 之上）；
- 发布物：`dist/dsh-fang-2.6.6.tgz` + `dist/manifest.json` + `dist/preflight.json` + `dist/allowlist.json`；
- npm/GitHub Release 未执行：等待 PR 合并与维护者确认；
- 未合并 main：本 PR 只推送分支与 PR，合并由维护者手动审核。
