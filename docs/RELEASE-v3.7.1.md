# v3.7.1 三方发布记录（2026-11-22）

> 用户确认：发布 3.7.1 修复补丁。基线 v3.7.0。

## 内容

- 官方推荐行与镜像同名行去重（`dsh-context` 安装不开启被重新打开）。
- 3.7.0 的元主同步/默认官方元宝/运行态补包/queue-journal 默认关闭不变。

## 门禁

| 门禁 | 结果 |
|---|---|
| 全量 npm test | 1318 pass / 0 fail / 2 skip |
| preflight --e2e | GREEN |
| 发布 PR CI | 待回填 |
| release-order | 待回填 |

## 发布结果

- tag：待回填
- GitHub Release：待回填
- npm：待回填

## 边界

- 推荐清单未安装包仍不自动安装。
