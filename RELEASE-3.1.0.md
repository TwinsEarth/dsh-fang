# dsh-Fang v3.1.0 发布说明

- 版本：`3.1.0`（上一个发布 `3.0.10`）
- 定位：插件独立可用（`@twinsearth/dsh-fang` 宿主插件 + Web 客户端半），PC 客户端可选
- 规则：不推 `main`、不自动发布；发布动作按渠道执行

## 这一版修什么

### 1. 元主运行态继承本机插件与设置
`startEssenceRuntime` 之前没有传 `cleanTemplate: false`，forker 仍用 clean template（base + web-app + fang），导致官方/用户元主打开后看不到本机插件列表。现在从元主 `merged/profile` 克隆，并显式把母体 `node_modules` 作为 junction 源。

### 2. essence 派生启动失败 `spawn-failed: exited`
元主 merged/profile 的 `cordis.patch.yml` 是 `{ insert: [...] }` JSON；旧逻辑在其后追加 YAML 列表，导致文件非法、分身进程启动即退出。`applyForkConfigLock` 现在结构化合并 JSON / YAML 两种形状。

### 3. 元主行派生不复制会话
`POST /fang/api/tasks/create` 漏传 `importSession`/`seed`；已修复。元主栏「派生」选中的会话会复制进分身 `sessions/`。

### 4. 元主启用插件 `EPERM`
`essence-runtime` 被误设为只读，DSH 启用内置插件时 `rename package.json.<tmp> -> package.json` 失败。现在元主运行态可写；真正的分身仍只读。

### 5. 首次运行预览说明
clean template 与 fork lock 预置 `ui-settings-general.welcomeNoticeVersion`，「继续」可正常保存。

## 升级注意

- **重启 DSH 桌面应用**后新代码生效。
- 官方元主运行态中由旧迁移带入的历史会话已移入：
  `D:\ToFuture\sessions\essence-official-dev\home\quarantine-sessions\`
  数据保留，不再出现在默认运行态；需要时用「启动并导入」显式导入。
- 元主运行态与分身都不会自动选中会话（DSH Web 暂无会话深链），会话在左侧列表。

## 门禁

- `preflight --e2e` GREEN：754 pass / 0 fail / 1 skip；e2e 75/75。
- 构建：`dist/dsh-fang-3.1.0.tgz`（396,470 B，119 entries），sha256 `a78ab4eb443d8d4f9702ea52322fc13605745c8d1f1e3857a1cc90c8e71a5ac7`。
- `package-smoke` PASS；`install-drill` GREEN 7/7；`healthz` HEALTHY。
