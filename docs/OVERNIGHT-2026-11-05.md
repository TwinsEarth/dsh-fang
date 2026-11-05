# 通宵开发检查点（2026-11-05）

状态：**未提交、未推送、未推 main、未发布**。所有产出等待用户决策后归档。

## 已完成（工作区，已验证）

| 模块 | 文件 | 测试 |
|---|---|---|
| 分支模型 | `src/lib/branch.mjs` | 5/5 |
| 回流状态机 | `src/lib/reflow.mjs` | 4/4 |
| 三根访问矩阵 | `src/lib/roots.mjs` | 5/5 |
| broker + fs-guard | `src/lib/broker.mjs` / `fs-guard.mjs` | 5/5 + 3/3 |
| 只读 broker adapter + 401/403 | `src/lib/broker-adapter.mjs` | 6/6 |
| upgrade/status 只读路由 | `src/plugins/orchestrator.mjs`（62 路由） | e2e 200/401 |
| MCP registry | `tools/mcp/tools.mjs` | 5/5 |
| MCP server | `tools/mcp/server.mjs` | 5/5 |
| MCP stdio 端到端 | `test/mcp-stdio.test.mjs` | 1/1 |
| Web 入口 bundle | `web-entry/` | 3/3 |
| Electron 协议 | `<desktop>\main.cjs` | 手工实测 |
| 发布工作流/工具 | `tools/git/*`、`.githooks/`、workflows | 12/12 |

## 全量门禁

```
preflight --e2e GREEN
- tests 705 pass / 0 fail / 1 skip
- e2e 63/63
- routes 62
- artifact sha256 match
```

## 真实验证

- `dsh-fang://open` 注册表正确，`Start-Process` 可聚焦「瓮城 · dsh-Fang」；
- `web-entry` 已安装到 desktop profile，Client Slots 中 `plugins.bundle.config` 出现
  `key=@twinsearth/dsh-fang, id=fang-web-entry, active=true`。

## 未完成 / 阻塞

- 6 项决策未回复：版本序列、main 回收、VM 快照、原身 Web、tools/git、实时派发参数；
- v3.0.8 分支 HTTP 面、reflow HTTP 面未接；
- npm `3.0.7` 未发布（release workflow 网络失败）；
- 所有改动未提交（工作区含专家产出与并行工作流文件）。

## 建议下一步

1. 用户回复 6 项决策；
2. 按版本归档当前产出（MCP/web-entry/docs 单独提交）；
3. 创建 v3.0.8 分支，继续 branch/reflow 的 HTTP 接入；
4. 修复 npm 发布链（runner 网络/代理）后再发布。
