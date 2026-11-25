# v3.8.0 三方发布记录（2026-11-24）

> 用户当次指定版本 v3.8.0；基线 v3.7.8。

## 门禁

| 项 | 结果 |
|---|---|
| 全量 npm test | **1337 pass / 0 fail / 2 skip** |
| preflight --e2e | **GREEN（e2e 125/125）** |
| 发布 PR CI | **#166 8/8 绿** |
| release-order | **10/10** |

## 发布结果

- tag：**v3.8.0**（annotated `7fa22e6b…` → `96b88a7f…`；本地 tag object `b751ad27…`）
- GitHub Release：**https://github.com/TwinsEarth/fang-dsh-plugin/releases/tag/v3.8.0**（id `456342403`）
- npm：**@twinsearth/fang-dsh-plugin@3.8.0**（latest，shasum `907902b8…`）；旧名 `@twinsearth/dsh-fang@3.8.0` 同步发布（shasum `0bdde52e…`）
- artifact：734,458 B，sha256 `044fa2fd…`
- verify-release：**GREEN**；healthz：**HEALTHY**

## 边界

- 母体安装必须完全退出宿主后部署；禁止热替换 profile。
- 托管浏览器独立 profile；会话事件分页与 Job Object 留待下一版。
