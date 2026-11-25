# 公共仓 / 私有镜像仓 发布管理

> 适用版本：v2.8.4 起。工具：`tools/release/sync-private.mjs`（零第三方依赖，仅 GitHub REST API）。
> 相关文档：`docs/RULES-BASELINE.md`（规则基线）、`docs/CHANGELOG.md`（版本历史）。

## 1. 两个仓的定位

| 仓 | 定位 | 可以写什么 | 版本 / tag / release |
|---|---|---|---|
| `TwinsEarth/dsh-fang`（**公共**） | 唯一事实来源（canonical） | 只有 PR，维护者合并；`main` 受保护 | 版本在 PR 里递增；tag/Release 由维护者或发布流程创建 |
| `TwinsEarth/dsh-fang-private`（**私有**） | 只读镜像（mirror） | 不再手工提交；由同步工具写入 | 镜像 tag 与 Release 资产，内容树必须与公共仓一致 |

私有仓的**内容树**（tree SHA）必须等于公共仓对应 tag 的树；打包字节可以不同（不同 CI 环境构建的
tarball 大小/哈希不同），因此每个仓的 Release 资产按**各自**的 `manifest.json` 校正 `.sha256`。

## 2. 版本流转

```
公共仓 PR（如 #33 v2.8.3）→ 维护者合并 → tag v2.8.3
      → 公共 Release v2.8.3（prerelease：tag 未在 main 时）
      → node tools/release/sync-private.mjs sync --tag v2.8.3
      → 私有 main + tag + Release v2.8.3（prerelease=false）
      → node tools/release/sync-private.mjs verify --tag v2.8.3
```

**tag 落点**：tag 可以指向未合并的 PR head（此时公共 Release 标 `prerelease: true`），
但一旦 `main` 合并，应把 tag 指向 main 的 merge commit 并取消 prerelease；
私有镜像始终跟随公共 tag，不单独决定版本。

## 3. 同步工具

```bash
# 校验（只读；输出两仓 tag→tree 与 Release 资产自洽性；不一致时退出码 1）
node tools/release/sync-private.mjs verify --tag v2.8.3

# 预演（不写任何 ref/Release）
node tools/release/sync-private.mjs sync --tag v2.8.3 --dry-run

# 真正同步（内容树 + annotated tag + Release 资产）
node tools/release/sync-private.mjs sync --tag v2.8.3

# CI 用：JSON 输出
node tools/release/sync-private.mjs verify --tag v2.8.3 --json
```

认证：`--token-file <path>`（默认 `.secrets/github-token.txt`）或环境变量 `GITHUB_TOKEN`（需私有仓 `repo` 权限）。

**同步语义**（`sync`）：
1. 读公共 tag 的 commit/tree（递归、不允许 truncated）；
2. 以私有 `main` 当前树为基线，按内容 SHA 复用未变 blob，只创建变化 blob（内容寻址，天然增量）；
3. 用**完整扁平 tree** 创建私有 commit（等价于公共 tree：脚本会断言 `newTree === publicTree` 才继续）；
4. 私有 `main` 快进到该 commit（父提交=旧 main，fast-forward）；
5. 创建 annotated tag `vX.Y.Z`（已存在则跳过）；
6. 创建/复用私有 Release，从公共 Release 经 API 下载资产并上传。

**为什么不用 git push**：本机只能访问 `api.github.com` / `uploads.github.com`，直连 `github.com:443`
超时（发布脚本同理）。REST 同步不依赖 git 传输，且能对 tree/资产做逐项断言。

## 4. 发布后必须核对的三件事

1. **内容树**：`verify` 输出 `trees.ok=true`（`publicTree === privateTree`）；
2. **资产自洽**：每个仓 `manifest.json` 的 sha256 == 该仓 tarball 实际 sha256 == `.sha256` 资产内容；
3. **Release 说明**：体积/哈希数字与当前资产一致（CI 触发发布流程会重建 tarball，必须按各自 CI 产物校正）。

私有仓自带 `release` workflow：tag 推送会触发它重建 tarball 并上传 Release 资产，
所以 **sync 之后要再跑一次 `verify`**，若资产哈希被 workflow 替换，需按私有 CI 产物更新 `.sha256` 与说明。

## 5. 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| `verify` 报 tree 不一致 | 同步中断 / 私有仓手工提交 | 重跑 `sync`（可先 `--dry-run`） |
| `verify` 报 `.sha256 asset != actual` | 该仓 CI 重建了 tarball | 下载该仓 Release tarball，按实际 sha256 重传 `.sha256` 并改说明 |
| 私有 Release 资产缺失 | 同步时公共 Release 还不存在 | 先完成公共 Release，再 `sync` |
| 资产下载 404 | 私有仓资产需认证 | 一律走 API `Accept: application/octet-stream`（工具已内置），不要用匿名 URL |
| `main` PATCH 被拒 | 私有 main 有分叉 | 工具只做 fast-forward；出现分叉先人工核对，禁止 force push |

## 6. 红线

- 私有仓**不做手工提交**；所有内容来自公共 tag 的同步，避免两份事实。
- 私有仓 Release **不标 prerelease**（私有 main 已含该版本内容）；公共仓在 tag 未落到 main 前标 prerelease。
- 同步工具只做 fast-forward，不 force push；不删除私有仓既有 tag/Release。
- 任何同步后必须 `verify` 通过，并把结果记录到该版本 `docs/AUDIT-vX.Y.Z.md`。
