# v3.7.5 三方发布记录（2026-11-22）

> 用户当次指定版本 v3.7.5；基线 v3.7.3，跳号豁免见 `docs/RELEASE-WAIVER-v3.7.5.md`。

## 门禁

| 项 | 结果 |
|---|---|
| 全量 npm test | **1330 pass / 0 fail / 2 skip** |
| preflight --e2e | **GREEN（e2e 125/125）** |
| 发布 PR CI | **8/8 绿**（#157） |
| release-order | **10/10 GREEN** |

## 发布结果

- tag：**v3.7.5**（annotated `0fc973dd…` → `d9915b1c…`）
- GitHub Release：**https://github.com/TwinsEarth/dsh-fang/releases/tag/v3.7.5**（id `454503069`，4 资产）
- npm：**@twinsearth/fang-dsh-plugin@3.7.5**（latest，shasum `41fce749…`）
- artifact：`dsh-fang-3.7.5.tgz` 721,333 B，sha256 `eb6e678d7e8ee78eabfa2a458690b3981820ca52e2469bb72f4f4a53f39debe5`

## 边界

- 母体安装必须宿主退出后执行；运行中的 3.7.3 不会热更新。
- 全局红线为插件级写守卫，不是 VM/OS 强隔离。
- Vault 工作区快照默认不导出。
