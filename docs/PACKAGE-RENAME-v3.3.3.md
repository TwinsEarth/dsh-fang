# npm 包改名：@twinsearth/fang-dsh-plugin

生效版本：`v3.3.4`（v3.3.3 因 npm 402 未发布）

## 新身份

| 项 | 值 |
|---|---|
| npm 包名 | `@twinsearth/fang-dsh-plugin` |
| 安装 | `dsh plugin --profile desktop add @twinsearth/fang-dsh-plugin@3.3.3` |
| 本地开发 bundle 名 | `@twinsearth/fang-dsh-plugin`（构建时统一改写为新包名） |
| 旧 npm 包名 | `@twinsearth/dsh-fang`（继续兼容，不再作为新发布身份） |

## 为什么保留旧名兼容

- 已安装旧包的 profile 仍能启动、升级；`FANG_PACKAGE_NAMES` / `FORK_BUNDLE_NAMES` 同时接受新旧名和本地 link。
- 新 profile、安装 drill、发布门禁、npm registry 查询全部使用新名。
- 旧包暂不自动 deprecate；如需公告迁移，单独执行 `npm deprecate` 并记录。

## 市场状态（2026-11-14）

当前 DSH `0.2.2-rc.1` 没有「官方插件市场」，文档明确「DSH 不内置任何索引源」。
因此本版**只发布 npm，不提交任何市场收录**；官方市场上线后再按官方流程提交。
社区 Open Plugin Market（dshopen.org）是第三方索引，本版未提交。

## 验证

```text
source / workflows / package / publish gate GREEN
全量测试见构建输出
install drill 使用新包名安装并列出新 client.js
```


## 队列子插件默认关闭（同一版本）

- `dsh-fang-queue-journal` 的 bundle 行默认 `disabled: true`；
- 未启用时 host half 不提供 `fangQueueJournal`，journal/queue 路由返回 503；
- client half 不加载；即使旧缓存残留，也会因能力探测失败而隐藏 UI；
- 启用方式：在 profile 的 `cordis.patch.yml` 覆盖该行 `disabled: false`（或由后续设置界面提供开关）。
