# 加速分身兼容矩阵（v3.5.0）

> **口径**：加速分身 = 由 forker 派生、运行在 `@twinsearth/dsh`（加速核）上的**分身 Web**。
> 母体/桌面宿主与元主运行态不在本矩阵内（它们永远原厂 core）。
> **版本对**：瓮城 dsh-Fang `3.5.0` ｜ 加速核 `@twinsearth/dsh 3.5.0` ｜ 原厂 DSH `0.2.2-rc.3`
> **证据**：`tools/release/accelerated-fork-smoke.mjs`、`FANG_ACCEL_LIVE=1 npm run test:accel-live`、`--dump-config`、以及 2026-11-17 的“元主同步面”启动实验（本机）。

---

## 1. 核心 Core 引擎

| # | 加速核组件（@twinsearth） | 原厂对应（@deepseek-ai） | 状态 | 证据 |
|---|---|---|---|---|
| 1 | `dsh`（CLI/启动器） | `dsh`（安装目录） | ✅ | 真机打印 `dsh web: http://127.0.0.1:<port>/?token=...`，页面 200 |
| 2 | `dsh-base` | `dsh-base` | ✅ | `--dump-config` 组合成功 |
| 3 | `dsh-web-app` | `dsh-web-app` | ✅ | 页面含 client 清单元数据；`dsh-fang/client.js` 在清单中 |
| 4 | `dsh-session` / `session-persistence-jsonl` / `session-query(-sqlite)` / `session-projection(-cache)` | 同名模块 | ✅（能力存在） | 加速核安装树含 320 个包，模块一一对应；未做逐 API 行为对比 |
| 5 | `dsh-mcp-client` / `mcp-resources` | 同名 | ✅（能力存在） | 同上 |
| 6 | `dsh-tool-*`（fs/pwsh/bash/todo/web/skill/subagent/workflow/…） | 同名 | ✅（能力存在） | 同上 |
| 7 | `dsh-subagent` / `subagent-*-in-process` | 同名 | ⚠️ 部分 pending | 元主同步实验中 `subagent-*-in-process` 报 `pending (waiting for service: subagents)` |
| 8 | `dsh-host-webserver` / `host-directory-picker*` / `host-frontend-static` | 同名 | ✅ | 加速分身启动、页面、目录选择路由可用 |
| 9 | client half 模块（`dsh-client-*`） | `dsh-client-*` | ⚠️ 未验证 | 极简 profile 不加载第三方 client half；官方 client 模块随 web-app 加载 |
| 10 | 模型 provider（home patch） | `@deepseek-ai/*` 行 | ✅ 配置层 | overlay 作用域改写后 `--dump-config`：`name mismatch=0`、`volcengine` 7 处、`ark-code-latest` 3 处 |
| 11 | 真实模型对话 | 生产可用 | ⚠️ 未验证 | 仅验证启动/路由/身份，未发真实模型请求 |

> 交叉验证：加速核是“重命名的 DSH 同构树”（320 包，核心模块 1:1 对应），API 版本差（0.2.2-rc.3 → 3.5.0）需逐项适配。

## 2. 官方 bundle

| # | bundle | 加速分身 | 说明 |
|---|---|---|---|
| 1 | `@deepseek-ai/dsh-base` | ✅ | 映射为 `@twinsearth/dsh-base` |
| 2 | `@deepseek-ai/dsh-web-app` | ✅ | 映射为 `@twinsearth/dsh-web-app` |
| 3 | `dsh-experimental-agent-team-profile` | ❌ | 加速核无对应 bundle |
| 4 | `dsh-experimental-voice-input-bundle` | ❌ | 同上 |
| 5 | `dsh-experimental-plugin-market-bundle` | ❌ | 同上 |
| 6 | `dsh-experimental-auto-review` | ❌ | 同上 |
| 7 | `dsh-experimental-forge-bundle` | ❌ | 同上 |
| 8 | `dsh-experimental-inspector-profile` | ❌ | 同上 |
| 9 | `dsh-personalized-recommendations` | ❌ | 同上 |
| 10 | `dsh-experimental-cot-translation-bundle` | ❌ | 同上 |
| 11 | `dsh-experimental-session-titles-bundle` | ❌ | 同上 |
| 12 | `dsh-experimental-badge-skill-bundle` | ❌ | 同上 |
| 13 | `dsh-deepseek-chat-import` | ❌ | 同上 |
| 14 | `ralph` / `terminal` / `liveshare` / `session-search` | ❌ | 同上（无加速版实现） |

> 结论：官方**核心** bundle 可映射；官方**实验** bundle 无加速版，需从官方源码移植（涉及许可证与 API 适配）。

## 3. 第三方插件

策略基线：加速分身**默认不携带**第三方插件；是否兼容取决于“是否 API 兼容”。

| # | 插件 | 加速分身状态 | 证据/说明 |
|---|---|---|---|
| 1 | `@twinsearth/w2m-dsh-plugin` | ❌ 不带 | 未做激活实验 |
| 2 | `@twinsearth/dsh-2xray` | ❌ 不带 | 未做激活实验 |
| 3 | `@twinsearth/dsh-im2a-plugin` | ❌ 不带 | 未做激活实验 |
| 4 | `dsh-context` | ❌ 导入失败 | 元主同步实验：`Cannot find package '@deepseek-ai/dsh-session'` |
| 5 | `@openviking/dsh-memory-plugin` | ❌ 导入失败 | 元主同步实验：`Cannot find package '@deepseek-ai/dsh-mcp-client'` |
| 6 | `dshmarket` / `dsh-vault` / `dsh-recovery` / `dsh-backup` / `dsh-ops` / `dsh-better-sidebar` | ⚠️ 未验证 | 未做激活实验 |
| 7 | `@michengai/dsh-agency-agents` / `@nanmicoder/dsh-agent-teams` / `@liustack/modlens,modsearch` / `@perrylink/dsh-plugin-doctor` / `ds-bot` / `dsh-qq-onebot` / `dsh-wechat` | ⚠️ 未验证 | 未做激活实验 |

### 3.1 “与元主同步”实验（2026-11-17）

把元主 merged profile 加速化（bundle 映射 base/web-app、保留第三方依赖、patch 作用域改写并转数组）后启动加速核：

| 结果 | 详情 |
|---|---|
| 启动 | ✅ 成功打印 `dsh web: ...`（可提供页面服务） |
| 丢弃项 | ❌ 10 个官方实验 bundle 无加速版 |
| 第三方激活 | ❌ `dsh-context`、`@openviking/dsh-memory-plugin` 导入即失败（缺 `@deepseek-ai/*` 包） |
| 其他 | ⚠️ `subagent-*-in-process` pending（服务缺失） |

> 因此“与元主插件面 100% 同步”当前不可达；差异必须显式列出，不能静默宣称一致。

### 3.2 alias 桩包 spike（2026-11-17，可复现）

脚本：`tools/release/accel-alias-spike.mjs`（启动两次加速核：baseline vs `@deepseek-ai/*` → `@twinsearth/*` 桩包）。

```powershell
node tools/release/accel-alias-spike.mjs --accel-nm <accel>/node_modules --essence-profile <merged profile>
```

| 指标 | baseline（无桩） | 桩包后 |
|---|---|---|
| 加速核启动 | ✅ UP | ✅ UP |
| 载入的第三方 bundle | dsh-context / openviking-memory / dshmarket / w2m | 同左 |
| 第三方插件扫描到的 `@deepseek-ai/*` 规格 | 66 | 66 |
| 可解析为加速等价实现 | 0 | **58 / 66** |
| 无加速等价实现 | — | 8：`dsh-client-runtime` / `dsh-client-store` / `dsh-client-ui-primitives` / `dsh-code-runtime` / `dsh-desktop` / `dsh-desktop-runtime` / `dsh-invariants` / `dsh-tool-lsp` |
| `entries did not activate` | **4**（2 导入失败 + 2 subagent pending） | **2**（仅 subagent pending，与第三方无关） |
| 导入失败 | 2（`dsh-context`、`openviking-memory-runtime`） | **0** |
| 结果 | dsh-context / openviking ❌ | **4/4 目标第三方插件全部激活** ✅ |

> 结论：**C（alias 桩包）在 Host 侧可行且收益最大**；剩余 gap 集中在 client/desktop/lsp/invariants 这类“无加速对应”的模块，需要 A（移植）或 B（契约委托）补齐。
> 推荐 D2 形态：**C 为主（自动桩包 + 不支持清单）+ A 补核心 + B 兜底**。

## 4. 三条适配路线（可行性结论）

| 路线 | 可行性 | 边界 | 建议 |
|---|---|---|---|
| **A. 移植（源码/包改名）** | 核心插件：可行；官方实验 bundle：无加速版，需源码移植 | API 漂移（0.2.2-rc.3 → 3.5.0）与许可证 | 只对**核心**插件做自动映射；实验 bundle 单独立项 |
| **B. 契约委托（调母体）** | 无头能力：可行（`src/contract` + `/fang/api/contract` + adapter 命令）；UI：不可行 | 母体须在线；延迟/一致性/鉴权 | 用于“无法移植的重量级插件”的能力调用，不用于界面 |
| **C. alias 桩包（伪装适配）** | Host 侧：**已验证**（66 个导入规格中 58 个可映射；4/4 目标第三方插件激活）；Web client half：未验证 | 仅覆盖 API 兼容子集；必须逐插件激活冒烟 | **优先做**：先给 `dsh-session`/`dsh-mcp-client`/常用 `dsh-tool-*` 建桩，量化可激活率 |

**推荐 D2 形态**：`C（alias 层）为主 + A（核心映射）自动完成 + B（契约委托）兜底 + 不支持清单显式展示`。

## 5. 复现命令（升级加速核后必须重跑这三条）

```powershell
# 1) 真实加速分身 smoke（起真进程；断言身份 + client 半 + core 版本）
$env:DSH_HOME='%DSH_HOME%'
node tools/release/accelerated-fork-smoke.mjs --fang-home <FANG_HOME>

# 2) 经 forker 的 live 测试（provision + spawn + adapter identity）
$env:FANG_ACCEL_LIVE='1'; $env:FANG_HOME='<FANG_HOME>'
npm run test:accel-live

# 3) 组合树核对（模型 overlay 作用域改写是否仍匹配）
node -e "import('./src/lib/accelerated-fork.mjs').then(m=>{const fs=require('fs');const out=m.buildModelOverlay({motherHome:'%DSH_HOME%'});console.log(out.ok, /@twinsearth\/dsh-/.test(out.text||''))})"
```

附加实验（选做，D2 决策时用）：
- 元主同步面启动实验（把元主 profile 翻译到加速核，记录 dropped bundle 与激活失败插件）；
- alias 桩包实验（`@deepseek-ai/dsh-session` / `dsh-mcp-client` → `@twinsearth/*`，逐插件冒烟）。

## 6. 维护约定

1. **版本对三件套**必须同时更新：瓮城版本 / 加速核版本 / 原厂 DSH 版本；
2. 每次升级 `@twinsearth/dsh`：重跑 §5 三条命令，更新本矩阵的“状态/证据/日期”；
3. **无证据不得写 ✅**：新增第三方插件兼容性必须附“启动 + 激活 + 冒烟”证据；
4. 任何“与元主同步”的宣称，必须附差异清单（dropped bundles / failed plugins）；
5. 兼容矩阵与 `docs/ACCELERATED-FORK.md` 的边界描述必须一致。
