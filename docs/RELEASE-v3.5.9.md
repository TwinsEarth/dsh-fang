# v3.5.9 三方发布记录（2026-11-21）

> 用户指令：**三方发布，v3.5.9**（v3.5.8 之后：修复加速分身派生失败 `fork-bundle-unavailable`）。

## 0. 版本矩阵

| 组件 | 版本 | 说明 |
|---|---|---|
| `@twinsearth/fang-dsh-plugin` | **3.5.9** | 本次三方发布主体 |
| `@twinsearth/dsh-fang-contract` | 1.2.0（已发布） | vendored pin 不变（`src/contract/VENDOR.json`） |
| 加速核 `@twinsearth/dsh` | 3.5.0 | 加速分身依赖；不发布 |

## 1. 内容

- **修复加速分身派生失败 `fork-bundle-unavailable`**：加速分身 profile 的 fang bundle junction 原先写死 `node_modules/@local/dsh-fang`，而发布构建会把该常量改名为 npm 包名 `@twinsearth/fang-dsh-plugin`，orchestrator 的 bundle 探测按发布名查找 → 判定缺失并回收任务。
  - junction 与 profile 的 `bundles / dependencies` 改为按 `fangRoot/package.json` 的真实包名生成；
  - 名不同时保留 `@local/dsh-fang` 兼容别名 junction；
  - `isFangBundle` 识别发布名，同步路径不会把本体当第三方插件复制。
- 回归测试：发布名 fixture 下断言 profile 使用真实包名、`node_modules/@twinsearth/fang-dsh-plugin` junction 可解析。
- 本机运行配置（不随包分发）：`fang-forker.acceleratedCliPath` 指向已安装加速核 `D:\ToFuture\accel\cli\node_modules\@twinsearth\dsh\lib\bin.js`（此前“加速核未安装”的修复）。

## 2. 门禁

| 门禁 | 结果 | 证据 |
|---|---|---|
| preflight --e2e（发布提交） | **GREEN 15/15** | tests **1307 pass / 0 fail / 2 skip**；e2e **125/125**；main-city A；allow-list **0**（110 路由）；artifact sha256 match |
| 发布 PR CI（#139） | **8/8 绿** | `gate (required)=success`；test node22/24、compat node22/24、hygiene、license 全 success；`e2e (self-hosted windows)` skipped（runner 离线，与既有版本一致） |
| version-cut --check | **GREEN** | 3.5.8 → 3.5.9 = patch |
| release-order（pre-tag / main 产物） | **10/10 GREEN** | 产物新鲜、sha256 匹配、npm 3.5.9 已发布、tag 已打、Release 资产已上传 |
| 合并 | PR **#139** squash → `85a0525b` | main 线性历史，tag 打在 main 尖端 |

真机核对（修复后探针）：以本机真实插件生成加速 profile，`bundles = [dsh-base, dsh-web-app, @twinsearth/fang-dsh-plugin]`，junction 存在且可解析。

## 3. 发布结果（2026-11-21 已完成三方发布）

### 3.1 git tag（annotated）

- tag：**v3.5.9**（annotated object `ff823436e2d04ea3e0834bcfa190fa9741ca3710` → commit `85a0525bad805bf68a264b510c2aef823d5dd6c5`，即 main 尖端）
- 状态：已推送远端（`refs/tags/v3.5.9`）；`verify-release` 校验 first-parent 通过。

### 3.2 GitHub Release

- 地址：https://github.com/TwinsEarth/dsh-fang/releases/tag/v3.5.9（release id `453845506`，非 draft / 非 prerelease）
- 资产（4，附 GitHub 记录 sha256）：
  - `dsh-fang-3.5.9.tgz` — 693,792 B，sha256 `f204fe377b6b223ab07bd49b6869b160bff31e2ddcf0370bcf94be4371cc4ff8`
  - `dsh-fang-3.5.9.tgz.sha256` — 85 B
  - `manifest.json` — 11,391 B
  - `preflight.json` — 1,872 B（v3.5.9 GREEN 报告）

### 3.3 npm

- 包：**@twinsearth/fang-dsh-plugin@3.5.9**（`dist-tags.latest=3.5.9`）
- 发布方式：npm registry REST（`tools/release/publish-npm.mjs`，主城门禁 publish 级 PASS，一次成功）
- 校验：registry `dist.shasum=b4f557626badffac6c985ead7076bdeab0170887`，
  `dist.integrity=sha512-6BfN1SErMCZN6p+DbobzMzGCqlKwBLHV1AKFHPWTTJv1w81NkY29Gj3S5jmPdM40w77KasPZKZX9adhSxXfQqg==`；
  registry 传播约 2 分钟后 `latest` 可见。
- 页面：https://www.npmjs.com/package/@twinsearth/fang-dsh-plugin/v/3.5.9

### 3.4 发布后校验

- `node tools/git/verify-release.mjs --tag v3.5.9 --remote --json` → **GREEN（16/16）**（tag annotated / 在 main first-parent / 版本一致 / CHANGELOG+AUDIT / preflight GREEN+e2e 真跑 / artifact sha256 match / remote healthz HEALTHY）；报告：`dist/release-verify.json`。
- `node tools/release/release-order.mjs` → **10/10 GREEN**。
- `healthz --remote`：`HEALTHY @twinsearth/fang-dsh-plugin@3.5.9`（npm + GitHub Release 均可取到）。

## 4. 诚实边界

- 三方发布为手工执行：tag push 触发 `release.yml`，其中 guard/test 在 ubuntu 运行，build/npm/GitHub Release 依赖 self-hosted Windows runner（离线），本版仍以本地门禁 + 手工发布为准；
- tarball 以合并后 `main` 重建产物为准（693,792 B / sha256 `f204fe37…`）；
- 加速核版本不变（`@twinsearth/dsh@3.5.0`），母体/元主仍官方 core；
- 本机 `acceleratedCliPath` 属运行配置；新机器需先安装加速核或配置该路径；
- 私有镜像 verify（`sync-private.mjs`）未执行：本机无 MIRROR_TOKEN。
