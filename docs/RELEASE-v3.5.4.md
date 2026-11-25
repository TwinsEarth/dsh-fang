# v3.5.4 三方发布记录（2026-11-18）

> 用户指令：**三方发布，v3.5.4：UI 调整**（母体&元主与决策中心&分身左右对调；分身在上、决策中心在下）。

## 0. 版本矩阵

| 组件 | 版本 | 说明 |
|---|---|---|
| `@twinsearth/fang-dsh-plugin` | **3.5.4** | 本次三方发布主体 |
| `@twinsearth/dsh-fang-contract` | 1.2.0（已发布） | vendored pin 不变 |
| 加速核 `@twinsearth/dsh` | 3.5.0 | 加速分身依赖；不发布 |

## 1. 内容

- 左列 = 母体&元主；右列 = 分身（上）/ 决策中心（下）；
- 垂直分隔条反向映射（决策中心在下方），比例偏好 key 与语义保持向后兼容；
- 布局回归测试更新。

## 2. 门禁

| 门禁 | 结果 | 证据 |
|---|---|---|
| pr-gate（发布 PR #129） | **GREEN** v3.5.4 | 标题/线性历史/scope/license 全 PASS |
| preflight --e2e（提交 3be1876） | **GREEN** | tests **1282 pass / 0 fail / 2 skip**（228.8s）；e2e **123/123**（50.0s）；main-city A；allow-list 0；artifact sha256 match |
| PR CI（#129） | **8/8 绿** | `gate (required)=success`；test node22/24、compat、hygiene、license 全 success；`e2e (self-hosted windows)` skipped（runner 离线，与既有版本一致） |
| release-order（main 产物） | **GREEN 10/10** | tag 未打、产物新鲜、sha256 匹配、contract 1.2.0 已发布 |
| 合并 | PR **#129** squash → `4b2b3c8cd8` | 线性历史 |

## 3. 发布结果（2026-11-18 已完成三方发布）

### 3.1 git tag（annotated）

- tag：**v3.5.4**（annotated object `c20264de631b92c6d05adb40ce9e7a54673aa0be` → commit `4b2b3c8cd8f215f026730fdd6fd325d72c770358`）
- 状态：已推送远端（refs/tags/v3.5.4）。

### 3.2 GitHub Release

- 地址：https://github.com/TwinsEarth/dsh-fang/releases/tag/v3.5.4（release id `449686227`，非 draft / 非 prerelease）
- 资产（3）：
  - `dsh-fang-3.5.4.tgz` — 682,558 B，sha256 `4ae5b1d9eb2c869b197751e1b4366846dcefe8018c35b19f36816ea7e0ddc684`
  - `dsh-fang-3.5.4.tgz.sha256` — 85 B
  - `manifest.json` — 11,391 B

### 3.3 npm

- 包：**@twinsearth/fang-dsh-plugin@3.5.4**（`latest` 已指向 3.5.4）
- 发布方式：npm registry REST（`tools/release/publish-npm.mjs`，主城门禁 publish 级 PASS）
- 校验：registry `dist-tags.latest=3.5.4`，`dist.shasum=f2576023653ff8ed47c262b1acc8ae6f8db5c5ef`（与本地产物 sha1 一致），`dist.integrity=sha512-aKzBnSbPYeVu…`
- 页面：https://www.npmjs.com/package/@twinsearth/fang-dsh-plugin/v/3.5.4

### 3.4 布局验收

- `test/client-layout-dom.test.mjs`（jsdom，母体面板真实 DOM）：
  - 母体&元主为 body 左列第一个 panel；右列 `.fang-col--right` 内**分身在上、决策中心在下**（DOM 顺序断言）；
  - 双分隔条：列（vertical）+ 行（horizontal），双击 50:50、ArrowDown 放大下方决策中心、`localStorage` 持久化；
- 全量测试与 e2e 见 §2。

## 4. 诚实边界

- GitHub Actions 的 `release` 工作流仍依赖 self-hosted Windows runner（当前离线），本次三方发布按既定流程手动执行（与 v3.5.0/3.5.2/3.5.3 相同）；
- 布局为 jsdom 结构级验证 + 现有 headless 冒烟，未做真实桌面窗口截图回归；
- 母体正式 profile 的 LSP 仍未安装（`docs/INSTALL-LSP-MOTHER.md`），生产 LSP 委托仍 `contract-unavailable`；
- fork-local（路线 B）安装默认关闭。
