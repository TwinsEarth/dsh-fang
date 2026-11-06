# dsh-Fang v3.0.10 发布说明

- 版本：`3.0.10`（上一个发布 `3.0.9`）
- 定位：插件独立可用（`@twinsearth/dsh-fang` 宿主插件 + **Web 客户端半**），PC 客户端可选
- 规则：不推 `main`、不自动发布；发布动作按渠道执行

## 为什么发这一版

v3.0.9 的 **npm 发布包在 staging 时删除了 `dsh.client`**，导致：

- npm 安装后 Web 端 **只出现设置页入口**；
- 侧边栏「瓮城」入口与主面板（元主 / 分身 50:50 控制台）**完全不加载**；
- 源码与测试仍要求 client half 开启（`test/plugins-shape.test.mjs`），发包路径与源码不一致。

v3.0.10 只做发布链修复，不改业务行为：

1. `tools/release/build.mjs` 保留 `dsh.client`，缺失时构建失败；
2. `tools/release/package-smoke.mjs` 断言 client half 启用、`client.js` 注册发布包 ID 且包含 `sidebar.panellist` / `main` 槽位；
3. `tools/release/install-drill.mjs` 在干净 profile 真实拉取 Web boot 页，断言 `@twinsearth/dsh-fang/client.js` 在插件清单中；
4. `tools/release/healthz.mjs` 增加 client half 启用检查。

## 安装后验收

```bash
pnpm add @twinsearth/dsh-fang@3.0.10
# 重启 dsh 宿主后刷新 Web 页面
curl -H "x-fang-auth: <token>" http://127.0.0.1:<port>/fang/api/status
```

- `/fang/api/status` 返回 `"version":"3.0.10"`；
- Web 左侧栏出现「瓮城」；
- 页面 boot 的插件清单包含 `@twinsearth/dsh-fang/client.js`。

## 已知边界（继承 v3.0.9）

- 官方源升级适配器（`officialSource`）未接入；
- 物理分支 `sessions.fork` 的真实宿主签名未现场验收；
- 分身硬禁的文件系统级 ACL 需宿主权限位。

## 门禁

- `preflight --e2e` GREEN：751 pass / 0 fail / 1 skip；e2e 75/75。
- 构建：`dist/dsh-fang-3.0.10.tgz`（395,132 B，119 entries），sha256 `6afe97710f54a6dc84cfff1cb7d8d425a73a5c241d3bb6b3f3488964b240bbb0`。
- `package-smoke` PASS；`install-drill` GREEN 7/7；`healthz` HEALTHY。
- 详见 `docs/AUDIT-v3.0.10.md` 与 `dist/preflight.json`。
