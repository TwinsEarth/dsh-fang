# v3.5.3 三方发布记录（2026-11-18）

> 用户指令：**三方发布，v3.5.3**；母体操作面板三块（母体&元主 / 决策中心 / 分身），决策中心与分身分开（左列上/下，滑块可调比例）。

## 0. 版本矩阵

| 组件 | 版本 | 说明 |
|---|---|---|
| `@twinsearth/fang-dsh-plugin` | **3.5.3** | 本次三方发布主体 |
| `@twinsearth/dsh-fang-contract` | 1.2.0（已发布） | vendored pin 不变 |
| 加速核 `@twinsearth/dsh` | 3.5.0 | 加速分身依赖；不发布 |

## 1. 内容

- 母体面板三块布局（左列决策中心/分身 + 水平分隔条；右列母体&元主）；
- 修复 v3.5.2 真机「分身核心加速引擎」无法启动 & 按钮点击无效（4 层根因：forker layout 解析、
  stock CLI 误传、`ELECTRON_RUN_AS_NODE` 丢失、面板 `toast()` 未定义）；
- 修复原身派生加速分身插件面静默退回 minimal（`accelerated-sync-unavailable` 显式失败）；
- 文档/回归测试。

## 2. 门禁

| 门禁 | 结果 | 证据 |
|---|---|---|
| pr-gate（修复 PR） | **GREEN** v3.5.3 | 标题/线性历史/scope/license 全 PASS |
| preflight --e2e（修复提交 ec602a9） | **GREEN** | tests **1282 pass / 0 fail / 2 skip**（196s）；e2e **123/123**；main-city A；allow-list 0；artifact sha256 match |
| PR CI（#127） | **8/8 绿**（重跑后） | `test (node 24)` 首轮 25m 超时（runner 侧），rerun 后 success；`gate (required)=success` |
| release-order（main 产物） | **GREEN 10/10** | tag 未打、产物新鲜、sha256 匹配、contract 1.2.0 已发布 |
| 合并 | PR **#127** squash → `51ef3800ee` | 线性历史 |

## 3. 发布结果（2026-11-18 已完成三方发布）

### 3.1 git tag（annotated）

- tag：**v3.5.3**（annotated object `446df61e9768ad69d695432c52b7da1ebbdd4f18` → commit `51ef3800eefc6fa92137d713797a3683be633358`）
- 状态：已推送远端（refs/tags/v3.5.3）。

### 3.2 GitHub Release

- 地址：https://github.com/TwinsEarth/dsh-fang/releases/tag/v3.5.3（release id `449339210`，非 draft / 非 prerelease）
- 资产（3）：
  - `dsh-fang-3.5.3.tgz` — 682,415 B，sha256 `f64585d7e6f821b46af5ef8c775c84fc8ce39004733de0cf02b58d03b7b839e3`
  - `dsh-fang-3.5.3.tgz.sha256` — 85 B
  - `manifest.json` — 11,391 B

### 3.3 npm

- 包：**@twinsearth/fang-dsh-plugin@3.5.3**（`latest` 已指向 3.5.3）
- 发布方式：npm registry REST（`tools/release/publish-npm.mjs`，主城门禁 publish 级 PASS）
- 校验：registry `dist-tags.latest=3.5.3`，`dist.shasum=8074c14f15c1a94212dfd99f49393624a25a65c4`（与本地产物 sha1 一致），`dist.integrity=sha512-zxu0ZUdHCCVYkmM59XikAz…`
- 页面：https://www.npmjs.com/package/@twinsearth/fang-dsh-plugin/v/3.5.3

### 3.4 真机等价验证（加速核心修复）

隔离母体（stock DSH + fang 3.5.3；`FANG_HOME=D:\ToFuture`；forker 不配置 `acceleratedCliPath`，与生产一致）：

1. `GET /fang/api/fork-core` → `installed=true`（source=`state`）；
2. `POST /fang/api/fork-core {mode:accelerated}` → **200** `changed=true`；
3. `POST /fang/api/tasks/create`（加速核心）→ **200** `status=ready`、`adapter.version=3.5.3`、URL reachable。

> 说明：v3.5.2 上该路径分别在 `installed=false`（按钮只弹未安装）与 `409 accelerated-cli-missing` /
> 子进程 exit 0 无输出处失败；v3.5.3 已修复并回归（`test/forker-accelerated-discovery.test.mjs` 4 项、
> `test/client-fork-core-dom.test.mjs` 2 项）。

## 4. 诚实边界

- GitHub Actions 的 `release` 工作流仍依赖 self-hosted Windows runner（当前离线），本次三方发布按既定流程手动执行（与 v3.5.0/v3.5.2 相同）；
- 「真机」验证为本机隔离母体的生产等价复现，非用户桌面窗口截图；
- 母体正式 profile 的 LSP 仍未安装（`docs/INSTALL-LSP-MOTHER.md`），生产 LSP 委托仍 `contract-unavailable`；
- fork-local（路线 B）安装默认关闭。
