# v3.7.3 三方发布记录（2026-11-22）

> 用户确认 3.7.3。基线 v3.7.2（`27cde14`）。

## 内容

- 分身每次打开主动同步来源元主插件状态（安装/卸载/更新/开启/关闭/配置参数），fingerprint 变化自动停止旧进程、按新 merged profile 重建并 spawn。
- forker 每次 spawn 前强制 15 个官方实验性 bundle + enabled patch 行（不再依赖 post-provision 二次步骤）。
- ready 但进程已死可重新启动，不再 `not-archived`。
- 修复 Adapter 404：回退 P2 的 fork 私有 fang 复制（会经 `@local` symlink 误写母体）。
- 修复 Node 26 `globalThis.fetch` accessor 导致 `experimental-inspector` 异常。
- 含 P1/P2-A 隔离加固（部署 409、watcher 降级、安装快照默认关闭）。

## 门禁

| 门禁 | 结果 |
|---|---|
| 全量 npm test | **1325 pass / 0 fail / 2 skip** |
| preflight --e2e | **GREEN；e2e 125/125**；routes 113 / allowlist 0 |
| 发布 PR CI（#155） | **8/8 绿** |
| release-order | **10/10 GREEN** |
| 合并 | PR **#155** squash → `2d719fb56bbedb14a48aa1809d2bc5268f137805` |

## 发布结果

- tag：**v3.7.3**（annotated；远端 tag object `f61e49c44127044fdcf703a5863824117b609569` → `2d719fb5…`）
- GitHub Release：https://github.com/TwinsEarth/dsh-fang/releases/tag/v3.7.3（id `454347925`，4 资产）
  - `dsh-fang-3.7.3.tgz` — 710,323 B，sha256 `010725e0d8751ac1c53e9dd4c788147f1ef11c503c74bc749b154dcb6a897555`
- npm：`@twinsearth/fang-dsh-plugin@3.7.3`（latest 待回填）
- 校验：`verify-release` GREEN；`release-order` 10/10；`healthz` HEALTHY @3.7.3。

## 边界

- 运行中的旧分身需重新打开；Job Object/per-fork 防火墙未实现，非 VM 级。
- 安装快照默认关闭（需 `DSH_FANG_INSTALL_SNAPSHOT=1` 预热）。
