# UI client half 映射 · 实现与支持清单（2026-11-17）

> 阶段：D2 下一阶段的第 2 项，**非 spike**：在 synced 加速分身里把第三方 client half 的浏览器模块
> `@deepseek-ai/*` 作用域重写到加速核的 `@twinsearth/*` 作用域（含 `dsh-client-ui-primitives`
> 静态 seed 的 shim），并用 headless 浏览器验证至少 1 个第三方 client half 的启动路径。
> 关联：`docs/UI-CLIENT-HALF-SPIKE.md`（spike 证据）、`src/lib/accelerated-fork.mjs`。

## 1. 实现

### 1.1 浏览器作用域重写（client half shim）

`writeAcceleratedForkProfile({sourceProfileDir, accelNodeModules})` 在复制第三方插件包之后，对
**fork 私有副本**做浏览器侧重写（宿主侧 Node 导入仍走原有 `@deepseek-ai/*` alias 桩包）：

| 项 | 规则 |
|---|---|
| 重写对象 | 插件 `package.json` 的 `dsh.client.inject` / `dsh.client.external` 数组；客户端入口文件（`exports['./client']` 与 `lib/client.js`） |
| 目标判定 | `@deepseek-ai/<name>` → `@twinsearth/<name>`，**仅当**加速核存在对应 client half（`@twinsearth/<name>` 包的 `dsh.client` / `exports['./client']` / `lib/client.js`）**或**属于静态 seed 表 |
| 静态 seed 表 | `@twinsearth/dsh-client-ui-primitives`（`dsh-client-ui-primitives` shim 的核心）、`dsh-client-store`、`dsh-client-ui-slots`、`dsh-client-ui-dockkit`（web shell 的 `staticModules` 表，非 package 行） |
| 未映射项 | **原样保留**并写入 `sync.unsupportedClientHalves`（显式清单，不静默丢弃、不改写成错误目标） |
| 复制顺序 | 先复制包，再重写（只动 fork 私有副本，源 profile 不变） |

### 1.2 必需 client 行纠正（web 组合）

源 profile（官方 Desktop）把 `ui-theme` 行标记为 `disabled: true`（桌面 shell 自带主题），
加速 **web** 组合需要该 client half 提供 `theme` 服务，否则 32 个 client 行 pending、页面停在
“Failed to load plugins”。实现采用**具名 override**（`CLIENT_ROW_ENABLE_OVERRIDES`）：

- 仅 `ui-theme`（理由：desktop shell supplies theme; accelerated web composition provides it）；
- 只翻转该行的 `disabled`，其余 disabled 行（如 `dsh-desktop`、开发工具）保持禁用；
- 应用结果写入 `sync.rowOverrides`，审计可查。

## 2. 支持清单（实测，2026-11-17）

以元主 `essence-official-dev` merged profile 为源、加速核 3.5.0 为宿主的 synced 分身：

| 插件 | client half | 映射结果 | 备注 |
|---|---|---|---|
| `dsh-context` | ✅ | ✅ 全部映射 | inject 6 项全部 → `@twinsearth/*`；bundle `@deepseek-ai/dsh-client-ui-primitives` → 静态 seed |
| `dshmarket` | ✅ | ✅ 全部映射 | inject 3 项 + primitives |
| `@openviking/dsh-memory-plugin` | ❌（无 `dsh.client`） | — | 仅宿主侧插件 |
| `@twinsearth/w2m-dsh-plugin` | ✅（自身已是加速作用域） | — | 无需重写 |
| `@local/dsh-fang` | ✅ | — | fang 自身 client half（浏览器面板） |

`sync.unsupportedClientHalves` 当前为空（上述全部可映射）。未映射时该插件会出现在清单中，
UI 应显式提示“该插件仅原版可用”（后续 UI 提示项）。

## 3. 验证（headless 浏览器）

工具：`npm run smoke:ui-client-render`（`tools/release/ui-client-render-smoke.mjs`）

流程：真实元主 profile → `writeAcceleratedForkProfile` synced 构建 → 真机启动加速核 → Edge/Chrome
headless（CDP）加载启动页 → 断言：

| 检查 | 结果（2026-11-17 实测） |
|---|---|
| synced profile 构建 | ✅（dsh-context / @openviking/dsh-memory-plugin / dshmarket） |
| dsh-context 无 unsupported client spec | ✅ |
| 启动页 graph 含第三方 client half | ✅ entries=88，`dsh-context` 在列 |
| dsh-context inject 全为 `@twinsearth/*` | ✅（6/6） |
| headless 页面渲染 + app shell 挂载（无 plugin-failure 屏） | ✅ |
| 无 client module 解析错误（`missed the module table` / `failed to import` / `client-modules:`） | ✅ clean |

**诚实边界**：headless 落在 **welcome / 工作区选择屏**（fork 临时 home 无已打开会话），dsh-context 的
「上下文」侧栏入口需要 `layout + sidebarRight + uiConversation` 服务，只有打开工作区/会话后挂载。
因此本阶段验收的是**客户端模块层的真实渲染路径**（boot graph + 模块系统加载 + 应用 shell 正常挂载 +
零模块解析错误），**不是**“「上下文」标签可见”的最终视觉验收。后者作为下一步：在 headless 中注入
带会话的 home / 通过 host API 打开工作区后再断言 tab 文本。

## 4. 风险与限制

1. **版本绑定**：重写目标按加速核 client 行判定；升级加速核必须重跑 `smoke:ui-client-render`；
2. **API 漂移**：client half 的 React/服务契约以 `@twinsearth` 行为准，0.2.2-rc.3 与 3.5.0 的 UI 服务
   名称/签名可能不一致；未映射项已显式列出，但“可映射”不等于“已逐插件功能回归”；
3. **静态 seed 表**是加速 web shell 的内部事实（非公开 API），升级时需重新核对（可用 headless 工具回归）；
4. 未覆盖：需要会话/工作区才挂载的 client half（dsh-context 侧栏、dshmarket 设置页）的最终视觉验证。

## 5. 下一步

1. headless 会话注入：用 host API（typert）打开一个工作区/会话后，断言 dsh-context 的「上下文」tab；
2. 支持清单进入 UI：`task.acceleratedSync.unsupportedClientHalves` 在任务视图/分身卡片显式提示；
3. 逐插件功能冒烟（按支持清单），再考虑把 synced client half 默认开启。
