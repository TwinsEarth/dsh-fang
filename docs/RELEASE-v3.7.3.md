# v3.7.3 三方发布记录（2026-11-22）

> 用户确认 3.7.3。基线 v3.7.2。

## 内容

- 分身每次打开主动同步来源元主插件状态（安装/卸载/更新/开启/关闭/配置参数），fingerprint 变化自动重启。
- forker 每次 spawn 前强制 15 个官方实验性 bundle + enabled 行。
- ready 但进程已死可重新启动，不再 `not-archived`。
- P1/P2-A：部署 409、watcher 降级、不可变安装快照、私有 TEMP。

## 门禁

| 门禁 | 结果 |
|---|---|
| 全量 npm test | **1325 pass / 0 fail / 2 skip** |
| preflight --e2e | GREEN |
| 发布 PR CI | 待回填 |
| release-order | 待回填 |

## 发布结果

- tag：待回填
- GitHub Release：待回填
- npm：待回填

## 边界

- 运行中旧分身需重新打开；Job Object/防火墙未实现，非 VM 级。
