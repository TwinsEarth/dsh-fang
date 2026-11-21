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
| preflight --e2e（发布提交） | **TBD** | tests pass=? / fail=0 / skip=?；e2e ?/?；allow-list ?；artifact sha256 match |
| 发布 PR CI（#?） | **TBD** | gate/test/compat/hygiene/license |
| version-cut --check | **GREEN** | 3.5.8 → 3.5.9 = patch |
| release-order（pre-tag / main 产物） | **TBD** | |
| 合并 | PR **#?** squash → `TBD` | main 线性历史，tag 打在 main 尖端 |

真机核对（修复后探针）：以本机真实插件生成加速 profile，`bundles = [dsh-base, dsh-web-app, @twinsearth/fang-dsh-plugin]`，junction 存在且可解析。

## 3. 发布结果（待填）

### 3.1 git tag（annotated）
- TBD

### 3.2 GitHub Release
- TBD

### 3.3 npm
- TBD

### 3.4 发布后校验
- TBD

## 4. 诚实边界

- 三方发布为手工执行：tag push 触发 `release.yml`，build/npm/GitHub Release 依赖 self-hosted Windows runner（离线），本版仍以本地门禁 + 手工发布为准；
- 加速核版本不变（`@twinsearth/dsh@3.5.0`），母体/元主仍官方 core；
- 本机 `acceleratedCliPath` 属运行配置；新机器需先安装加速核或配置该路径；
- 私有镜像 verify（`sync-private.mjs`）未执行：本机无 MIRROR_TOKEN。
