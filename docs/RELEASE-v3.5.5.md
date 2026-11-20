# v3.5.5 三方发布记录（2026-11-21）

> 用户指令：**三方发布，v3.5.5**（v3.5.4 之后的安全与静默错误修复批次）。

## 0. 版本矩阵

| 组件 | 版本 | 说明 |
|---|---|---|
| `@twinsearth/fang-dsh-plugin` | **3.5.5** | 本次三方发布主体 |
| `@twinsearth/dsh-fang-contract` | 1.2.0（已发布） | vendored pin 不变 |
| 加速核 `@twinsearth/dsh` | 3.5.0 | 加速分身依赖；不发布 |

## 1. 内容

- 安全修复 R28（auth-token bootstrap）/ R23（pro 审批参数绑定）；
- 静默错误修复 R13（mirror Promise）/ R14（会话目录脱敏与形状）/ R15（审计失败可见）；
- 继承 v3.5.4 之后主干回收：决策计时器竞态修复 + e2e CLI 新安装根 + CI per-test timeout；
- 新增/更新回归测试；CHANGELOG「v3.5.5」段。

## 2. 门禁

| 门禁 | 结果 | 证据 |
|---|---|---|
| pr-gate（发布 PR #133） | **GREEN** v3.5.5 | 标题/线性历史/scope/license 全 PASS |
| preflight --e2e（提交 b35d5b6） | **GREEN** | tests **1300 pass / 0 fail / 2 skip**（191.3s）；e2e **125/125**（27.5s）；main-city A；allow-list 0（110 路由）；artifact sha256 match |
| PR CI（#133） | **8/8 绿** | `gate (required)=success`；test node22/24、compat、hygiene、license 全 success；`e2e (self-hosted windows)` skipped（runner 离线，与既有版本一致） |
| release-order（main 产物） | **GREEN 10/10** | tag 未打、产物新鲜、sha256 匹配、contract 1.2.0 已发布 |
| 合并 | PR **#133** squash → `20cfe3bcc4` | 线性历史 |

## 3. 发布结果（2026-11-21 已完成三方发布）

### 3.1 git tag（annotated）

- tag：**v3.5.5**（annotated object `392c8470421abc59de81e26dfbdc45fd89327c82` → commit `20cfe3bcc489f92b68cd62b01d8e9f9dd9ab8cce`）
- 状态：已推送远端（refs/tags/v3.5.5）。

### 3.2 GitHub Release

- 地址：https://github.com/TwinsEarth/dsh-fang/releases/tag/v3.5.5（release id `453219880`，非 draft / 非 prerelease）
- 资产（3）：
  - `dsh-fang-3.5.5.tgz` — 689,970 B，sha256 `7a4edc1553058b03f8b074e911bbf6b0e5a17a081040df938ba0a07e44bb64ba`
  - `dsh-fang-3.5.5.tgz.sha256` — 85 B
  - `manifest.json` — 11,391 B

### 3.3 npm

- 包：**@twinsearth/fang-dsh-plugin@3.5.5**（`latest` 已指向 3.5.5）
- 发布方式：npm registry REST（`tools/release/publish-npm.mjs`，主城门禁 publish 级 PASS）
- 校验：registry `dist-tags.latest=3.5.5`，`dist.shasum=62468e93397fbc49b7f6013a5dbb02579ec604e7`（与本地产物 sha1 一致），`dist.integrity=sha512-zrAZs7b+7WR7oiAWl8Vamo/…`
- 页面：https://www.npmjs.com/package/@twinsearth/fang-dsh-plugin/v/3.5.5

### 3.4 内容验收（安全修复）

- 单测：R28（http-auth ×3）、R23（pro-delegation ×3）、R13（mirror ×N）、R14（session-catalog ×3）、R15（auditor ×2）、compose 守护 ×1；
- e2e：新增「签票缺 params 400」「参数不符 params-mismatch」，共 **125/125**；
- 全量 preflight 通过（见 §2）。

## 4. 诚实边界

- **R28 不是进程隔离**：同机同用户进程仍可读 0600 token 文件或伪造请求头；本层只收敛浏览器跨站面；
- **R23 为行为收紧**：`/pro/approval` 必须带 `params`，旧调用方收到 400（有意 fail-closed）；
- R15 strict 仅覆盖 pro 签票；其余 `audit()` 失败可见但不抛；
- 三方发布手动执行（self-hosted runner 离线）；
- 母体正式 profile 的 LSP 仍未安装；fork-local 默认关闭。
