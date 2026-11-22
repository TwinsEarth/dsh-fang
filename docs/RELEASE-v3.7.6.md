# v3.7.6 三方发布记录（2026-11-22）

> 用户当次指定版本 v3.7.6；基线 v3.7.5。

## 门禁

| 项 | 结果 |
|---|---|
| 全量 npm test | **1330 pass / 0 fail / 2 skip** |
| preflight --e2e | **GREEN（e2e 125/125）** |
| 发布 PR CI | **8/8 绿**（#159） |
| release-order | **10/10 GREEN** |

## 发布结果

- tag：**v3.7.6**（annotated `7a7c24d4…` → `d66da5b1…`）
- GitHub Release：**https://github.com/TwinsEarth/dsh-fang/releases/tag/v3.7.6**（id `454562784`）
- npm（新名）：**@twinsearth/fang-dsh-plugin@3.7.6**（latest，shasum 1be71da9…）
- npm（旧名同步）：**@twinsearth/dsh-fang@3.7.6**（latest，shasum 67b19e90…）
- 市场：awesome-dsh-plugin PR **#17879** 已更新旧页到 v3.7.6（待维护者合并；旧 URL 保留）
- artifact：`dsh-fang-3.7.6.tgz` 721,369 B，sha256 `e79014b0…`

## 边界

- 已有会话日志修复会保留 `.bak-catalogv3-*` 备份；不删除会话。
- 宿主安装仍需完全退出后部署，禁止热替换 profile。
