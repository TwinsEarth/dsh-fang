# AUDIT v3.0.10

范围：修复 npm 发布包剥离 `dsh.client` 导致 Web「瓮城」主面板不加载；发布门禁补齐 client half 物化断言。

## 根因

| 项 | 事实 |
|---|---|
| 症状 | npm 安装 3.0.9 后 Web 端只有设置页入口，无侧边栏「瓮城」、无主面板 |
| 直接原因 | `tools/release/build.mjs` 在 staging 时 `delete stagedDsh.client` |
| 为什么没被门禁拦住 | `package-smoke.mjs` 断言的是 `dsh.client === undefined`（A2 旧策略残留）；`install-drill.mjs` 同样断言禁用，且其干净 profile 未写 `dependencies`，客户端半本来就不会被分发 |
| 源码意图 | `package.json` 已声明 `dsh.client: { platform: web }`；`test/plugins-shape.test.mjs` 断言必须启用；`tools/e2e.mjs` 同样断言启用 |
| 实测 | 临时 profile 仅加回 `dsh.client` 后，boot 页插件清单出现 `@twinsearth/dsh-fang/client.js` |

## 修复

| 文件 | 变更 |
|---|---|
| `tools/release/build.mjs` | 保留 `dsh.client`；缺失则构建失败 |
| `tools/release/package-smoke.mjs` | 断言 client half 启用；`client.js` 注册发布包 ID、无 `@local/dsh-fang`、含 `sidebar.panellist` + `main` 槽位 |
| `tools/release/install-drill.mjs` | profile 写 `dependencies`；启动后拉取 boot 页（带 cookie jar）断言 `@twinsearth/dsh-fang/client.js`；`taskkill /T` 清理宿主 |
| `tools/release/healthz.mjs` | 增加 `dsh.client.platform === 'web'` |

## 门禁结果

| 门禁 | 结果 |
|---|---|
| `node tools/release/preflight.mjs --e2e` | **GREEN**：751 pass / 0 fail / 1 skip；e2e **75/75**；allow-list routes=84 findings=0 |
| 构建 | `dist/dsh-fang-3.0.10.tgz`（395,132 B，119 entries）sha256 `6afe97710f54a6dc84cfff1cb7d8d425a73a5c241d3bb6b3f3488964b240bbb0` |
| `package-smoke.mjs` | PASS：client half enabled（`platform=web`）、`client.js` 注册 `@twinsearth/dsh-fang`、含 `sidebar.panellist` + `main` 槽位、18 行、插件模块 16 |
| `install-drill.mjs --no-popup` | **GREEN 7/7**：干净 profile 启动 Web，boot 清单出现 `@twinsearth/dsh-fang/client.js`；`/fang/api/status` version=3.0.10；16 fang-* 行（compose 计 18） |
| `healthz.mjs` | **HEALTHY**：`dsh.client enabled`、client.js 随包、16 个插件模块可导入 |
