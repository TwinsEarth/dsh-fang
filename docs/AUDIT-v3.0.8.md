# AUDIT v3.0.8（2026-11-05）

## 结论

**代码与插件门禁 GREEN；GitHub/npm 发布需用户确认后执行。**

## 门禁证据

| 项 | 结果 |
|---|---|
| `node tools/release/preflight.mjs --e2e` | GREEN |
| 路由数 | 67（compat 期望一致；e2e `/compat/check` 实测 67/67） |
| e2e | 73/73 |
| 单测 | 全绿（含 branch-store / paths，718 pass / 0 fail / 1 skip） |
| 安装包 | `DSH-Fang-3.0.8-x64-Setup.exe`（v3.0.8，x64，NSIS） |
| 安装包 sha256 | 见 `release/SHA256SUMS.txt` |
| AGPL | 安装包内含 `source/src`、`licenses/LICENSE-CORE`、`licenses/NOTICE`、`dsh-fang/client.js` |
| 默认安装目录 | `D:\ToFuture`（安装向导可改） |

## 主要变更

- 分支/回流 HTTP 路由（append-after-existing，避免 create 405）。
- MCP registry + stdio server；输出清洗。
- FANG_HOME 数据布局（mirror/essence/sessions），旧布局兼容。
- DSH Web 侧边栏入口 + 主面板唤起 Electron。
- 桌面壳安全修复：绝对 URL、CDP、token 下发、fallback、启动器路径。
- HTTP 契约审计：GET+POST 同路径合并、全插件 Host/Origin/token 门禁、branches taskId 校验、adapter perimeter、代理 JSON 错误与 token 轮换；详见 `AUDIT-v3.0.8-HTTP-CONTRACT.md`。

## 已知限制（未计入 GREEN）

- 桌面 API 套件 87/92：N3 为 E: 盘 Electron 环境限制；A4/B6/E10 等契约已同步，剩余真机 E0/E2 为 SKIP。
- 安装包未在本会话执行静默安装验证（GPW 拒绝启动安装器）。
- `gh` 未登录；`git push` 受网络影响，分支尚未推送。
- npm v3.0.8 未发布（v3.0.7 已发布）。

## 发布前检查

1. 用户确认 v3.0.8 发布范围；
2. `gh auth login` 后推送 `feat/v3.0.8-branch-runtime`；
3. `node tools/release/build.mjs` 产出 npm tarball；
4. npm publish + GitHub Release（等用户确认）。
