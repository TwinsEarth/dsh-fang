# 加速分身兼容矩阵（v3.5.0）

> 口径：加速分身 = 由 forker 派生、运行在 `@twinsearth/dsh`（加速核）上的**分身 Web**。
> 母体/桌面宿主与元主运行态不在本矩阵内（它们永远原厂 core）。
> 证据来源：`tools/release/accelerated-fork-smoke.mjs`、`FANG_ACCEL_LIVE=1 node --test test/accelerated-fork-live.test.mjs`、`@twinsearth/dsh 3.5.0` 源码包与 `--dump-config` 实测（2026-11-17，本机）。

## 1. 核心与产品包

| 组件 | 原厂（母体/元主） | 加速分身 | 状态 | 证据 |
|---|---|---|---|---|
| DSH 核心 | `dsh 0.2.2-rc.3`（安装目录） | `@twinsearth/dsh 3.5.0` | ✅ | 真机启动打印 `dsh web: http://127.0.0.1:<port>/?token=...`，页面 200 |
| base bundle | `@deepseek-ai/dsh-base` | `@twinsearth/dsh-base` | ✅ | `--dump-config` 组合成功 |
| Web app bundle | `@deepseek-ai/dsh-web-app` | `@twinsearth/dsh-web-app` | ✅ | 同上；页面含 client 清单元数据 |
| 瓮城插件 | `@local/dsh-fang` 3.5.0 | 同版本（junction 到工作树） | ✅ | `/fang/adapter/identity` → `{role:'fork', version:'3.5.0', protocol:3}`；启动页含 `dsh-fang/client.js` |
| 瓮城子插件 | `web-entry` / `queue-journal` | 同版本 junction；`queue-journal` 默认 disabled | ✅ / 按设计关闭 | 行 active 状态与 P0 测试 |
| 模型 provider（home patch） | `@deepseek-ai/*` 行 | overlay 改写为 `@twinsearth/*` | ✅ 配置层 | `--dump-config`：`name mismatch=0`、`volcengine` 命中 7、`ark-code-latest` 命中 3 |
| 真实对话（模型调用） | 生产可用 | 未做端到端对话验证 | ⚠️ 未验证 | 本轮只验证启动/路由/身份，未发真实模型请求 |
| 旧会话文件（原厂 core 写入） | 生产可用 | 默认不继承（`sessionMode:'new'`） | ⚠️ 未验证兼容 | 见 ACCELERATED-FORK.md §6.3；`inherit` 需自行承担风险 |

## 2. 官方可选 bundle（加速核缺失）

加速核安装只带它自己声明的包；下列官方 bundle 在加速核树中**没有对应实现**，极简 profile 不加载：

| bundle | 加速分身 |
|---|---|
| `dsh-experimental-plugin-market-bundle` | ❌ 不加载 |
| `dsh-experimental-auto-review` | ❌ 不加载 |
| `dsh-personalized-recommendations` | ❌ 不加载 |
| `dsh-experimental-inspector-profile` | ❌ 不加载 |
| `dsh-experimental-forge-bundle` | ❌ 不加载 |
| `dsh-experimental-badge-skill-bundle` | ❌ 不加载 |
| `dsh-experimental-cot-translation-bundle` | ❌ 不加载 |
| `dsh-deepseek-chat-import` | ❌ 不加载 |
| `dsh-experimental-voice-input-bundle` / `ralph` / `terminal` / `liveshare` / `session-search` | ❌ 不加载 |

> 因此加速分身是**极简工作台**：核心对话 + 瓮城 UI + 工具。需要这些 bundle 的场景请用原版分身。

## 3. 第三方插件（桌面 profile 常见）

加速分身不安装任何第三方插件；下列包**不会被带进加速分身**，其兼容性也未验证（其代码面向原厂 0.2.x core）：

| 插件 | 加速分身 |
|---|---|
| `@twinsearth/w2m-dsh-plugin` | ❌ 不带；未验证 |
| `@twinsearth/dsh-2xray` | ❌ 不带；未验证 |
| `@twinsearth/dsh-im2a-plugin` | ❌ 不带；未验证 |
| `dshmarket` / `dsh-context` / `dsh-vault` / `dsh-recovery` / `dsh-backup` / `dsh-ops` / `dsh-better-sidebar` | ❌ 不带；未验证 |
| `@openviking/dsh-memory-plugin` / `@michengai/dsh-agency-agents` / `@nanmicoder/dsh-agent-teams` / `@liustack/modlens,modsearch` / `@perrylink/dsh-plugin-doctor` / `ds-bot` / `dsh-qq-onebot` / `dsh-wechat` | ❌ 不带；未验证 |

> 设计边界（用户确认）：加速分身**默认极简插件面**，不追求第三方插件兼容。

## 4. 复现命令

```powershell
# 1) 真实加速分身 smoke（起真进程、断言身份与 client 半）
$env:DSH_HOME='%DSH_HOME%'
node tools/release/accelerated-fork-smoke.mjs --fang-home <FANG_HOME>

# 2) 经 forker 的 live 测试（provision + spawn）
$env:FANG_ACCEL_LIVE='1'; $env:FANG_HOME='<FANG_HOME>'
npm run test:accel-live

# 3) 组合树核对（模型 overlay）
node -e "import('./src/lib/accelerated-fork.mjs').then(m=>{const fs=require('fs');const out=m.buildModelOverlay({motherHome:'%DSH_HOME%'});console.log(out.ok, /@twinsearth\/dsh-/.test(out.text||''))})"
```

## 5. 维护约定

- 每次升级加速核版本（`@twinsearth/dsh`）后：重跑 §4 三条命令，更新本矩阵的“证据/日期”。
- 新增第三方插件兼容性证据前，不得在本矩阵写“支持”。
