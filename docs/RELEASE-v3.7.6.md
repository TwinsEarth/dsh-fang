# v3.7.6 三方发布记录（2026-11-22）

> 用户当次指定版本 v3.7.6；基线 v3.7.5。

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

- 已有会话日志修复会保留 `.bak-catalogv3-*` 备份；不删除会话。
- 宿主安装仍需完全退出后部署，禁止热替换 profile。
