# v3.7.5 三方发布记录（2026-11-22）

> 用户当次指定版本 v3.7.5；基线 v3.7.3，跳号豁免见 `docs/RELEASE-WAIVER-v3.7.5.md`。

## 门禁

| 项 | 结果 |
|---|---|
| 全量 npm test | **1330 pass / 0 fail / 2 skip** |
| preflight --e2e | **GREEN（e2e 125/125）** |
| 发布 PR CI | 待回填 |
| release-order | 待回填 |

## 发布结果

- tag：待回填
- GitHub Release：待回填
- npm：待回填
- artifact sha256：待回填

## 边界

- 母体安装必须宿主退出后执行；运行中的 3.7.3 不会热更新。
- 全局红线为插件级写守卫，不是 VM/OS 强隔离。
- Vault 工作区快照默认不导出。
