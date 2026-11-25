# AUDIT v3.1.0

范围：元主运行态继承本机插件/设置；essence 派生 JSON 补丁 `spawn-failed`；元主行派生会话复制；元主设置 `EPERM`；迁移遗留会话隔离。

## 根因

| 症状 | 根因 | 证据 |
|---|---|---|
| 默认/官方元主打开后没有本机插件列表 | `startEssenceRuntime` 未传 `cleanTemplate:false`，forker 使用 clean template | 运行态 profile `package.json` 只有 `dsh-base + dsh-web-app + dsh-fang` |
| 从元主 Fang 派生 `spawn-failed: exited` | essence merged patch 是 `{insert:[...]}` JSON，`applyForkConfigLock` 在其后追加 `- id:` YAML | 派生 profile patch 出现 `}` 后接 `- id: tool-plugin-manager` |
| 元主行派生出的分身 `会话 0 个` | `/fang/api/tasks/create` 漏传 `importSession` | 路由只传 title/template/collaborators/essenceId |
| 启用内置插件 `EPERM rename package.json.tmp` | `essence-runtime` 被 `setProfileConfigReadonly` 设为只读 | 运行态 `package.json` 属性 `-ar---` |
| 官方元主运行态出现本机历史会话 | 旧运行态 home 迁移带入 3 个会话，另有 1 个手动导入 | 会话目录创建时间 `2026-11-06 23:38:10` 与迁移时间一致 |

## 变更

| 文件 | 变更 |
|---|---|
| `src/plugins/orchestrator.mjs` | `startEssenceRuntime` 传 `cleanTemplate:false` + `nodeModulesSource`；`/tasks/create` 透传 `importSession`/`seed` |
| `src/lib/fork-config-lock.mjs` | JSON `/` YAML patch 结构化合并；`essence-runtime` 跳过只读；预置欢迎说明 |
| `src/plugins/forker.mjs` | clean template 的 `cordis.patch.yml` 预置 `ui-settings-general` |
| `test/fork-config-lock.test.mjs` | JSON patch 合并、essence-runtime 可写测试 |
| `test/orchestrator.test.mjs` | 运行态 provision 必须 `cleanTemplate=false` + `nodeModulesSource` |

## 现场清理

- 官方元主运行态已停止；
- 4 个历史会话与 `storages/workspace.json` 移入：
  `D:\ToFuture\sessions\essence-official-dev\home\quarantine-sessions\20261107-070609\`
- `sessions` / `storages/workspace.json` 不再存在于运行态根。

## 门禁结果

- `preflight --e2e` GREEN：754 pass / 0 fail / 1 skip；e2e 75/75；route count 84。
- `dist/dsh-fang-3.1.0.tgz` sha256 `a78ab4eb443d8d4f9702ea52322fc13605745c8d1f1e3857a1cc90c8e71a5ac7`。
- `package-smoke` PASS（client half enabled、18 行、模块导入）。
- `install-drill` GREEN 7/7（干净 profile boot 含 fang client half；`/fang/api/status` version=3.1.0）。
- `healthz` HEALTHY（16 个插件模块可导入）。
