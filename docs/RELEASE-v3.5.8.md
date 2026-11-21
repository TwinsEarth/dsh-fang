# v3.5.8 三方发布记录（2026-11-21）

> 用户指令：**三方发布，v3.5.8**（v3.5.7 之后：会话目录与 DSH 宿主侧栏对齐 + 三分组/归档分组）。

## 0. 版本矩阵

| 组件 | 版本 | 说明 |
|---|---|---|
| `@twinsearth/fang-dsh-plugin` | **3.5.8** | 本次三方发布主体 |
| `@twinsearth/dsh-fang-contract` | 1.2.0（已发布） | vendored pin 不变（`src/contract/VENDOR.json`） |
| 加速核 `@twinsearth/dsh` | 3.5.0 | 加速分身依赖；不发布 |

## 1. 内容

- `session-catalog` 与 DSH 宿主侧栏对齐：只列工作区注册表（`workspace.json`）里的根会话，排除子代理会话（裸 UUID 目录）与未登记目录；标题优先读 DSH 投影缓存（宿主侧栏同源），日志有界读取仅兜底；空会话按 `sessionListMetadata.blank` 标记；
- 会话三分组：活跃中（7 天内）/ 已归档 / 旧会话（>7 天），组内按最后活跃时间从新到旧（母体面板分组小标题 + 派生弹窗）；
- `cordis.patch.yml` 的 `fang-session-catalog.allowArchived` 由 `false` 改为 `true`，归档分组可见（灰色只读，仍不能作为派生导入源）；
- 空会话（宿主侧栏不显示）不再进入派生列表。

## 2. 门禁

| 门禁 | 结果 | 证据 |
|---|---|---|
| preflight --e2e（发布提交） | **GREEN 15/15** | tests **1306 pass / 0 fail / 2 skip**；e2e **125/125**；main-city A；allow-list **0**（110 路由）；artifact sha256 match |
| 发布 PR CI（#137） | **8/8 绿** | `gate (required)=success`；test node22/24、compat node22/24、hygiene、license 全 success；`e2e (self-hosted windows)` skipped（runner 离线，与既有版本一致） |
| version-cut --check | **GREEN** | 3.5.7 → 3.5.8 = patch |
| release-order（pre-tag / main 产物） | **10/10 GREEN** | 产物新鲜、sha256 匹配、contract 1.2.0 已发布、tag 未打 |
| 合并 | PR **#137** squash → `9ba79cac9c` | main 线性历史，tag 打在 main 尖端 |

真机只读核对（修复后、宿主重启）：默认列表 **6 条活跃会话**（5 条可见 + 1 条空会话被隐藏），标题与宿主侧栏逐字一致；`includeArchived=1` 注册表侧 **12 条**（5 活跃 + 6 归档 + 1 空，含 Master 工作区 1 条）；子代理会话 0 条。

## 3. 发布结果（2026-11-21 已完成三方发布）

### 3.1 git tag（annotated）

- tag：**v3.5.8**（annotated object `a5ef90b0dd68f52e068a48c0075d5c0ff0b6d093` → commit `9ba79cac9c1dd1cec6696e62b49578784fb55825`，即 main 尖端）
- 状态：已推送远端（`refs/tags/v3.5.8`）；`verify-release` 校验 first-parent 通过。

### 3.2 GitHub Release

- 地址：https://github.com/TwinsEarth/dsh-fang/releases/tag/v3.5.8（release id `453692848`，非 draft / 非 prerelease）
- 资产（4，附 GitHub 记录 sha256）：
  - `dsh-fang-3.5.8.tgz` — 693,155 B，sha256 `f66624527906014489d2867db5f30f90089558d4bb7d673004ed2bb70e4bba64`
  - `dsh-fang-3.5.8.tgz.sha256` — 85 B
  - `manifest.json` — 11,391 B
  - `preflight.json` — 1,872 B（v3.5.8 GREEN 报告）

### 3.3 npm

- 包：**@twinsearth/fang-dsh-plugin@3.5.8**（`dist-tags.latest=3.5.8`）
- 发布方式：npm registry REST（`tools/release/publish-npm.mjs`，主城门禁 publish 级 PASS，一次成功）
- 校验：registry `dist.shasum=f53e35ff2b48f49a3d44bd2efe9ea37c078f308c`（与本地产物 sha1 一致），
  `dist.integrity=sha512-mluaQ9FBVGqfjxVFdrK4Arkar8qdKTPoZgiVKXaUU/PaOPEKJKACcDcqbeEEWPSTUG7D723NuEcRBj8sv52FJA==`；
  registry 传播约 4–5 分钟后 `latest` 可见（与既有版本一致）。
- 页面：https://www.npmjs.com/package/@twinsearth/fang-dsh-plugin/v/3.5.8

### 3.4 发布后校验

- `node tools/git/verify-release.mjs --tag v3.5.8 --remote --json` → **GREEN**（tag annotated / 在 main first-parent /
  版本一致 / CHANGELOG+AUDIT / preflight GREEN+e2e 真跑 / artifact sha256 match / remote healthz HEALTHY）；报告：`dist/release-verify.json`。
- `node tools/release/release-order.mjs --json` → **10/10 GREEN，warnings=0**。
- `healthz --remote`：`HEALTHY @twinsearth/fang-dsh-plugin@3.5.8`（npm + GitHub Release 均可取到）。

## 4. 诚实边界

- 三方发布为手工执行：tag push 触发 `release.yml`，其中 guard/test 在 ubuntu 运行，build/npm/GitHub Release 依赖 self-hosted Windows runner（离线），本版未把该自动链路作为发布通道；
- 归档会话只展示/分组，仍不能作为派生导入源；
- 标题来自 DSH 投影缓存（派生数据），缓存缺失时回退日志有界读取并标注来源；
- 私有镜像 verify（`sync-private.mjs`）未执行：本机无 MIRROR_TOKEN。
