# v3.6.1 三方发布记录（2026-11-22）

> 用户指令：**三方发布，v3.6.1**。基线 v3.6.0；本版 = 加速分身会话兼容 shim + 还原强制 reprovision + 「启动」按钮修正。

## 0. 版本矩阵

| 组件 | 版本 | 说明 |
|---|---|---|
| `@twinsearth/fang-dsh-plugin` | **3.6.1** | 本次三方发布主体 |
| `@twinsearth/dsh-fang-contract` | 1.2.0（已发布） | vendored pin 不变 |
| 加速核 `@twinsearth/dsh` | 3.5.0 | 加速分身依赖；不发布 |

## 1. 内容

- 加速分身无法打开 stock 会话：catalog v3→v1、删除 v1 禁用的 `name`、加速核不认识的 stock 新事件（如 `team/mode`）标 `ignorable`；在加速 spawn/provision/import 自动执行（帧保留 + 备份）。
- 还原 timeout：`resetForkConfig` 后强制 reprovision，避免 stock 配置 + 加速 CLI 混搭。
- 母体面板「启动」按钮不再复用「还原存档」确认：非归档分身直接启动，仅 archived 才走还原确认。
- 只改分身会话副本，母体会话不动。

## 2. 门禁

| 门禁 | 结果 | 证据 |
|---|---|---|
| preflight --e2e（发布提交） | **GREEN 15/15** | tests **1314 pass / 0 fail / 2 skip**；e2e **125/125**；allow-list **0**（111 路由）；artifact sha256 match |
| 发布 PR CI（#143） | **8/8 绿** | gate required / test node22+24 / compat node22+24 / hygiene / license；e2e self-hosted skipped |
| version-cut --check | **GREEN** | 3.6.0 → 3.6.1 = patch |
| release-order | **10/10 GREEN，warnings=0** | pre-tag / post-publish 均通过 |
| 合并 | PR **#143** squash → `61a257b3e9` | main 线性历史，tag 打在 main 尖端 |

## 3. 发布结果（2026-11-22 已完成三方发布）

### 3.1 git tag（annotated）

- tag：**v3.6.1**（annotated object `4a5ed079dd0d069cd1b8f9fad7354d5a19e8c313` → commit `61a257b3e91d3343a7a0d0997bdd15b55db8a56f`，即 main 尖端）
- 状态：远端 tag 已存在；`verify-release` 校验 annotated / first-parent 通过。

### 3.2 GitHub Release

- 地址：https://github.com/TwinsEarth/dsh-fang/releases/tag/v3.6.1（release id `454023796`，名称 **v3.6.1**，非 draft / 非 prerelease）
- 资产（4）：
  - `dsh-fang-3.6.1.tgz` — 700,186 B，sha256 `081347474de06013f2bf5aac15537a5962d7968b565794e0d05f8916880c3f73`
  - `dsh-fang-3.6.1.tgz.sha256` — 85 B
  - `manifest.json` — 11,391 B
  - `preflight.json` — 1,872 B（v3.6.1 GREEN 报告）

### 3.3 npm

- 包：**@twinsearth/fang-dsh-plugin@3.6.1**（`dist-tags.latest=3.6.1`）
- 校验：registry `dist.shasum=0a230f0344d8b61579d742602232f87fd89abcfc`（= 本地产物 sha1），
  `dist.integrity=sha512-01TRsH49NF6Vt/tmX2wukjxlGjENlsJVV/57C3ozWJlVYbAciGT7tC20MI+YRfCCGwuT2nc3Wr43NfFB9X+Kw==`
- 页面：https://www.npmjs.com/package/@twinsearth/fang-dsh-plugin/v/3.6.1

### 3.4 发布后校验

- `verify-release --remote` → **GREEN 16/16**；`release-order` → **10/10 GREEN，warnings=0**；`healthz --remote` → **HEALTHY @3.6.1**。
- 真机核对：`task_mwqedbzich9m` 会话副本经兼容后，用加速核 `validateStoredEvents` 校验通过（34,029 事件）；分身可加速档启动。

## 4. 诚实边界

- 兼容垫片只保证加速核可读；未知事件在加速视图被跳过（team 等不渲染），根治需升级加速核（npm 最新 3.5.0）。
- 三方发布为手工执行（self-hosted Windows runner 离线）。
- 私有镜像 verify 未执行（无 MIRROR_TOKEN）。
