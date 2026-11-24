# v3.8.1 三方发布记录（2026-11-24）

> 用户当次指定版本 v3.8.1；基线 v3.8.0。紧急修复 sidecar 拉起第二宿主。

## 门禁

| 项 | 结果 |
|---|---|
| 全量 npm test | **1338 pass / 0 fail / 2 skip** |
| preflight --e2e | **GREEN（e2e 125/125）** |
| 发布 PR CI | **#168 8/8 绿** |
| release-order | **10/10** |

## 发布结果

- tag：**v3.8.1**（annotated `e9b89034…` → `12a1e4c8…`）
- GitHub Release：**https://github.com/TwinsEarth/fang-dsh-plugin/releases/tag/v3.8.1**（id `456499683`）
- npm：**@twinsearth/fang-dsh-plugin@3.8.1**（latest，shasum `1d0f2dfc…`）；旧名 `@twinsearth/dsh-fang@3.8.1`（shasum `ce938462…`）
- artifact：737,155 B，sha256 `e223a485…`
- verify-release：**GREEN**；healthz：**HEALTHY**

## 边界

- 母体安装必须完全退出宿主后部署；禁止热替换 profile。
- Job Object、官方 client 会话懒加载留待下一版。
