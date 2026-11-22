# v3.7.2 三方发布记录（2026-11-22）

> 用户确认 3.7.2。基线 v3.7.1。

## 内容

- 官方元宝每次使用前自愈（版本/node_modules/推荐表面），不再让分身静默回退 clean template。
- 官方实验性插件完整 15 bundle 全量启用（Windows 跳过 darwin-only cua）。
- `cordis.patch.yml` 顶层数组格式修复，解决 profile 加载/包不可用。
- runtime capture 捕获插件设置参数、bundles/dependencies、node_modules。

## 门禁

| 门禁 | 结果 |
|---|---|
| 全量 npm test | 1319 pass / 0 fail / 2 skip（1331 tests） |
| preflight --e2e | GREEN |
| 发布 PR CI | 待回填 |
| release-order | 待回填 |

## 发布结果

- tag：待回填
- GitHub Release：待回填
- npm：待回填

## 边界

- 运行中旧分身需重启；未安装推荐包不自动安装。
