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

2026-11-17 复核（本机 `D:\ToFuture\accel\cli\node_modules\@twinsearth` 实测）：加速核**同时提供官方实验 bundle 的加速版**（`dsh-experimental-agent-team-profile`、`voice-input`、`plugin-market`、`auto-review`、`forge`、`inspector`、`personalized-recommendations`、`cot-translation`、`session-titles`、`badge-skill`、`ralph`、`terminal`、`session-search`、`liveshare` 等均在树内）。因此官方 bundle 列表**可以整体映射**（`translateBundles` 实测 unsupported=0）。

| 官方 bundle | 加速分身 | 说明 |
|---|---|---|
| `@deepseek-ai/dsh-base` / `dsh-web-app` | ✅ | 映射为 `@twinsearth/*` 同名包 |
| 官方实验 bundle（agent-team-profile / voice-input / plugin-market / auto-review / forge / inspector / personalized-recommendations / cot-translation / session-titles / badge-skill） | ✅（映射） | `@twinsearth/dsh-experimental-*` 存在；真机 boot 无 import 失败 |
| `ralph` / `terminal` / `liveshare` / `session-search` | ✅（映射） | `@twinsearth/dsh-experimental-*` / `dsh-tool-*` 存在 |
| `dsh-deepseek-chat-import` | ⚠️ | 未在加速树中发现同名 bundle；需要时按“移植/委托”处理 |

> 复核结论：官方 bundle 映射在 `translateBundles()` 中**按包存在性判定**，不存在对应包时进入 `unsupportedBundles` 清单（不静默丢弃）。

## 3. 第三方插件

策略基线：加速分身**默认不携带**第三方插件；是否兼容取决于“是否 API 兼容”。

| # | 插件 | 加速分身状态 | 证据/说明 |
|---|---|---|---|
| 1 | `@twinsearth/w2m-dsh-plugin` | ❌ 不带 | 未做激活实验 |
| 2 | `@twinsearth/dsh-2xray` | ❌ 不带 | 未做激活实验 |
| 3 | `@twinsearth/dsh-im2a-plugin` | ❌ 不带 | 未做激活实验 |
| 4 | `dsh-context` | ✅ 已实现（alias 桩包） | baseline 缺 `@deepseek-ai/dsh-session` → 加桩后导入成功、激活 ✅ |
| 5 | `@openviking/dsh-memory-plugin` | ✅ 已实现（alias 桩包） | baseline 缺 `@deepseek-ai/dsh-mcp-client` → 加桩后导入成功、激活 ✅ |
| 6 | `dshmarket` / `dsh-vault` / `dsh-recovery` / `dsh-backup` / `dsh-ops` / `dsh-better-sidebar` | ⚠️ 未验证 | dshmarket 在 spike 中可激活；其余未做激活实验 |
| 7 | `@michengai/dsh-agency-agents` / `@nanmicoder/dsh-agent-teams` / `@liustack/modlens,modsearch` / `@perrylink/dsh-plugin-doctor` / `ds-bot` / `dsh-qq-onebot` / `dsh-wechat` | ⚠️ 未验证 | 未做激活实验 |

> **生产集成**：加速分身 provision 现在支持 `sourceProfileDir`（原身 merged profile）→ 自动完成「官方 bundle 映射 + 第三方插件复制 + `@deepseek-ai/*` 桩包」，并把 `mapped / unsupportedBundles / copiedPlugins / alias.resolved / alias.unsupported` 写入 `task.acceleratedSync` 显式展示。**无证据前仍不得在矩阵写“支持”**。

### 3.1 “与元主同步”早期实验（2026-11-17，已被 3.2/3.3 取代）

早期手工翻译元主 profile（bundle 只映射 base/web-app）后启动加速核：启动 ✅，但 `dsh-context`、`@openviking/dsh-memory-plugin` 因缺 `@deepseek-ai/*` 包导入失败。该实验暴露了 alias 缺口，**不是最终结论**。

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

### 3.3 生产代码集成验证（2026-11-17）

用真实元主 merged profile + 真实加速核，调用生产函数 `writeAcceleratedForkProfile({sourceProfileDir, accelNodeModules})` 生成 profile 并真机启动：

| 指标 | 结果 |
|---|---|
| 生成 | ✅ `/profiles/web-accel`；bundle 列表 = 官方 bundle 全部映射 + dsh-context / openviking / w2m / fang / dshmarket |
| 官方 bundle 映射 | ✅ `unsupportedBundles = 0` |
| 第三方插件复制 | dsh-context、@openviking/dsh-memory-plugin、dshmarket（w2m 以 junction 方式复用源模块树） |
| alias 桩包 | ✅ resolved 57；unsupported 8（client/desktop/lsp/invariants 类） |
| 真机启动 | ✅ `dsh web: http://127.0.0.1:18093/...` |
| 导入失败 | **0** |
| `entries did not activate` | 5，全部是 `pending (waiting for service: subagents/agentTeams)`，**无 import 失败** |

> 结论：**混合方案已落地到生产 provision 路径并在真机验证**；剩余 gap（8 个无加速等价模块）走 A（移植）/B（契约委托），UI client half 另行验证。

### 3.4 逐插件功能冒烟（2026-11-17，可复现）

脚本：`npm run smoke:accel-plugins -- --accel-nm <accel>/node_modules --essence-profile <merged profile>`
（内部：真实 `writeAcceleratedForkProfile({sourceProfileDir, accelNodeModules})` → 真机启动 → 逐插件分类 + host/fang 功能探针）

| 指标 | 结果 |
|---|---|
| 目标第三方插件 | `dsh-context` ✅ activated / `@openviking/dsh-memory-plugin` ✅ activated / `dshmarket` ✅ activated |
| 激活率 | **3/3**（无 import 失败） |
| alias | resolved 57 / unsupported 8（同上） |
| host 功能探针 | Web 页面 ✅（303，manual redirect = 可服务） |
| 瓮城功能探针 | `/fang/adapter/identity` ✅ `{role:'fork', version:'3.5.0'}` |
| 结论 | 导入/激活/宿主可用已自动化验证；**插件内部 API 行为**（工具调用、MCP 往返等）仍需各插件自己的功能用例，本工具不越权宣称 |

## 4. 三条适配路线（可行性结论）

| 路线 | 可行性 | 边界 | 建议 |
|---|---|---|---|
| **A. 移植（源码/包改名）** | 官方 bundle：加速核已有同名加速版（映射即可，实测 unsupported=0）；个别包（chat-import 等）需移植/委托 | API 漂移（0.2.2-rc.3 → 3.5.0）与许可证 | 映射自动完成；个例单独立项 |
| **B. 契约委托（调母体）** | 无头能力：可行（`src/contract` + `/fang/api/contract` + adapter 命令）；UI：不可行 | 母体须在线；延迟/一致性/鉴权 | 用于“无法移植的重量级插件”的能力调用，不用于界面 |
| **C. alias 桩包（伪装适配）** | Host 侧：**已验证**（66 个导入规格中 58 个可映射；4/4 目标第三方插件激活）；Web client half：未验证 | 仅覆盖 API 兼容子集；必须逐插件激活冒烟 | **优先做**：先给 `dsh-session`/`dsh-mcp-client`/常用 `dsh-tool-*` 建桩，量化可激活率 |

**推荐 D2 形态**：`C（alias 层）为主 + A（核心映射）自动完成 + B（契约委托）兜底 + 不支持清单显式展示`。

> **B 与 UI client half 已列为下一阶段**：范围/设计/验收/风险见 [`docs/D2-NEXT-PHASE.md`](D2-NEXT-PHASE.md)；v3.5.0 发布不依赖它们。

## 5. 复现命令（升级加速核后必须重跑这三条 + 插件面冒烟）

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

第 4 条（插件面冒烟，D2 后必跑）：
```powershell
npm run smoke:accel-plugins -- --accel-nm <accel>/node_modules --essence-profile <merged profile>
```
输出逐插件 `PASS/WARN/FAIL`（activated / pending-service / failed-import）+ host 页面与 fang identity 探针；结果写入 `<out>/result.json`。

## 6. 维护约定

1. **版本对三件套**必须同时更新：瓮城版本 / 加速核版本 / 原厂 DSH 版本；
2. 每次升级 `@twinsearth/dsh`：重跑 §5 三条命令 + **第 4 条插件面冒烟** `npm run smoke:accel-plugins -- --accel-nm <accel>/node_modules --essence-profile <merged profile>`，更新本矩阵的“状态/证据/日期”；
3. **无证据不得写 ✅**：新增第三方插件兼容性必须附“启动 + 激活 + 冒烟”证据；
4. 任何“与元主同步”的宣称，必须附差异清单（dropped bundles / failed plugins）；
5. 兼容矩阵与 `docs/ACCELERATED-FORK.md` 的边界描述必须一致。
