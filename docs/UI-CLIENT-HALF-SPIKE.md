# UI client half 浏览器映射 · Spike 报告（2026-11-17）

> 阶段：D2 下一阶段的**第 2 项**（UI client half 映射）先做 spike；**不阻塞 v3.5.0 发布**。
> 复现：`node tools/release/ui-client-half-spike.mjs --essence-profile <merged profile> --fang-home <FANG_HOME> --out <dir>`
> 本次证据：真实加速核 + 真实元主 merged profile 生成的 **synced** 加速分身（alias 57 resolved / 8 unsupported）。

## 1. 方法

1. 用生产代码 `writeAcceleratedForkProfile({sourceProfileDir, accelNodeModules})` 生成 synced 加速分身 profile；
2. 真机启动加速核，抓取启动页 `__DSH_BOOT__` 客户端清单（87 个 client 入口）；
3. 逐个抓取第三方 client half 的 bundle（`plugins/??<id>/client.js&rev=…`），静态分析其 `require`/`inject` 说明符；
4. 抓取核心 `@twinsearth/dsh-client-modules/client.js`（client module system）确认解析机制。

## 2. 关键发现

| 发现 | 证据 |
|---|---|
| 第三方 client half **已出现在加速分身启动清单** | `__DSH_BOOT__.entries` 共 87 项；第三方：`dshmarket`、`dsh-context`、`@local/dsh-fang`（w2m 未注册 client 入口） |
| 第三方 client bundle **可被 host 正常提供** | `dshmarket` 200 / 934,465 B；`dsh-context` 200 / 617,290 B；`@local/dsh-fang` 200 / 393,160 B |
| bundle 仍以 **`@deepseek-ai/*` 作用域** require | `dsh-context`、`dshmarket` 均 `require("@deepseek-ai/dsh-client-ui-primitives")`；fang 自己的 client 已用 `@twinsearth/*` |
| manifest `inject` 依赖同样是 `@deepseek-ai/*` id | `dsh-context` 6 个（`@deepseek-ai/dsh-client-connection` 等）；`dshmarket` 3 个 |
| 加速核**没有 browser importmap** | 启动页无 `type="importmap"`；client bundle 已被 host 预转换为 `require()` 形式的 client module system |
| client module system **没有 alias 表** | `@twinsearth/dsh-client-modules/client.js`（46,590 B）中无 `alias/redirect/normalizeSpecifier/moduleMap`；解析按**精确包名**（含 `/client` 后缀归一） |
| 加速核在 **`@twinsearth` 作用域**下**存在 primitives 等目标行** | 核心 client bundle 自身 `require("@twinsearth/dsh-client-ui-primitives")` → 目标实现作为 graph row 存在，可被复用 |

**结论**：第三方 client half 的 bundle 已经能在加速分身加载；缺的不是“加载”，而是 **`@deepseek-ai/*` 作用域的行别名**（manifest inject ids + bundle require 说明符）。加速核里存在对应 `@twinsearth/*` 行，因此**映射可行**。

## 3. 可行实现方案

### 方案 A（推荐）：fork-provision 生成 client alias 行
在 synced 加速分身 profile 的 `node_modules` 生成 `@deepseek-ai/dsh-client-*` **shim 包**（与 host 侧 alias 桩包同构）：
- `package.json`：`dsh.client` 指向 `client.js`（bundle 入口）；
- `client.js`：`export * from '@twinsearth/dsh-client-*'`（由 host client bundler 变换为 graph row）；
- 仅对**存在加速等价行**的 3 个 client 规格生成：`dsh-client-runtime`、`dsh-client-store`、`dsh-client-ui-primitives`；
- 生成结果写入 `task.acceleratedSync.clientAliases`（resolved/unsupported 显式）。

**风险**：host 是否会把 profile 里任意 shim 包当作 client 入口注册（需 1 次原型验证）；shim 的 export 必须与官方 client 包 API 对齐（primitives 可能只导出部分符号）。

### 方案 B：host 侧作用域别名表（更干净）
由 fang 插件在 boot manifest 生成阶段注入 `@deepseek-ai/x → @twinsearth/x` 的行别名（client module system 目前无此能力，需要 host 侧提供扩展点或 fang 侧后处理 manifest）。**代价**：依赖 host 内部 API/版本，升级脆弱。

### 方案 C：浏览器 importmap（不可行）
当前 client bundle 已被 host 预转换为 `require()` 闭环，浏览器无 importmap 阶段 → 不适用。

推荐顺序：**先 A（1 个原型 shim：`@deepseek-ai/dsh-client-ui-primitives`）→ 验证 1 个官方 client half 能渲染 → 再 B 作为长期方案评估**。

## 4. 验收（下一阶段实现时）

- [ ] 至少 **1 个第三方 client half**（首选 `dsh-context` 的会话/上下文面板）在加速分身 UI 中成功渲染；
- [ ] 映射失败/无等价的 client half 列入 `unsupportedClientHalves`，UI **显式提示“仅原版可用”**（不静默隐藏）；
- [ ] 原版分身 UI 无回归（官方 client half 全部正常）；
- [ ] 每个被映射的 client half 做“启动 + 渲染 + 交互冒烟”；
- [ ] 审计/版本：shim 与加速核版本绑定（升级加速核必须重跑 `spike:ui-client`）。

## 5. 边界与注意

- 这是**浏览器模块映射**，与契约委托（无头能力）无关；
- client half 的 API 漂移（0.2.2 → 3.5.0）仍需逐插件冒烟，不能仅凭 bundle 200 宣称可用；
- 当前 spike 只做静态/清单级证据，**尚未做真实浏览器渲染验证**（需要 headless Edge/Chrome + 页面 DOM 断言，列为下一里程碑）；
- 生产加速分身默认仍走“极简插件面/或 synced 面 + 无 UI client half 映射”的现状；`unsupportedClientHalves` 尚未进入任务视图。
