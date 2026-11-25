# AUDIT v3.1.26

范围：发布流水线去单点（不依赖 artifact、不依赖 gh CLI、不依赖工作区干净）。

| 单点 | 现象 | 修复 |
|---|---|---|
| artifact 上传 | v3.1.24：Failed to CreateArtifact: ENOTFOUND | continue-on-error，仅存档 |
| npm 发布路径 | 依赖 artifact | build job 内直发（幂等） |
| Release 上传 | 依赖 artifact + gh CLI | 	ools/release/upload-release-assets.mjs（REST，幂等） |
| 工作区复用 | Cannot create .githooks\.githooks | 解包前清空工作区，残留则 fail-closed |
| 下游连锁 skip | healthz/mirror/verify 依赖 npm/Release | 改依赖 build |

## 兜底证据（v3.1.25 手工补齐，验证资产选择正确）

`	ext
node tools/release/upload-release-assets.mjs --tag v3.1.25 --dry-run
  → 只选 dsh-fang-3.1.25.tgz / .sha256 / manifest.json / preflight.json（4 个）
  → 不会误传 dist 里遗留的 3.1.23 / 3.1.24
`
