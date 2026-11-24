# v3.7.8 三方发布记录（2026-11-24）

> 用户当次指定版本 v3.7.8；基线 v3.7.7。

## 门禁

| 项 | 结果 |
|---|---|
| 全量 npm test | **1334 pass / 0 fail / 2 skip** |
| preflight --e2e | **GREEN（e2e 125/125）** |
| 发布 PR CI | 待回填 |
| release-order | 待回填 |

## 发布结果

- tag：待回填
- GitHub Release：待回填
- npm：待回填
- artifact sha256：待回填

## 边界

- 母体安装必须完全退出宿主后部署；禁止热替换 profile。
- 单活跃分身会暂停其他运行中的分身，但保留 home/会话，可还原。
