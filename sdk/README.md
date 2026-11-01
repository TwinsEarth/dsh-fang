# dsh-Fang 生态层（MIT）

这个目录是 dsh-Fang 的**生态层**，使用 [MIT 许可](../LICENSE-SDK)：
插件 SDK、模板、示例都可以零摩擦复制、修改、二次分发，甚至闭源集成进你的产品。

> 核心层（编排器/派生器/红线守卫/Adapter/容器执行器等）在 `src/` 下，使用 **AGPL-3.0**（见
> `../LICENSE-CORE`）；商业层（Relay/企业功能）在 `../relay-server`、`../enterprise`，闭源。
> 逐目录许可地图见 [`../NOTICE`](../NOTICE)。

---

## 1. 一个 dsh-Fang 插件长什么样

Fang 插件就是一个 DSH bundle：一个 npm 包目录，带

```
my-plugin/
├── package.json          # name + dsh.bundle.patch（+ 可选 dsh.client 声明浏览器半）
├── cordis.patch.yml      # 安装时把本插件的 loader 行 insert 进 profile
├── index.js              # Host 半：export const name/inject/Config/apply
└── client.js             # 可选 Client 半：window.__ModuleLoader__.load({...})
```

安装（不需要发布到 npm）：

```powershell
# 在 DSH 会话里对 Agent 说：
#   plugin_manager install_bundle(target="E:\path\to\my-plugin")
# 或者由你的发布脚本调用 DSH 的 plugin_manager
```

## 2. 模板

- [`templates/plugin/`](templates/plugin/) — 最小可安装插件（Host + 可选 Client + 图标 + locale）
- [`examples/status-badge/`](examples/status-badge/) — 读取瓮城 `/fang/api/status` 并在输入框下方显示徽标
  （演示"第三方插件如何安全调用 Fang 的公开 HTTP 面"）

复制模板：

```powershell
Copy-Item -Recurse sdk\templates\plugin my-plugin
# 改 package.json 里的 name / 行 id / patch 里的 id
```

## 3. 与瓮城核心交互的三种合法方式

| 方式 | 适用 | 协议边界 |
|---|---|---|
| 读 `/fang/api/status`、`/fang/api/tasks`、`/fang/api/sessions` | 面板/徽标/旁路观察 | 只读 HTTP，最安全 |
| `POST /fang/api/derive`、`/tasks/*`、`/promote` | 自动化工作流 | 写入前请遵守核心的配额与审批语义 |
| Adapter 协议（仅分身内，`/fang/adapter/*`） | 分身内插件 | 需要分身 token；不要在母体调用 |

> 插件与核心之间通过**公开 HTTP API** 交互时，你的插件是独立作品，可以自选许可证
> （MIT/Apache/闭源均可）——这正是生态层 MIT 的意义。

## 4. 需要遵守的少量规则

- 不要从其他插件的 DOM / 样式表里"猜"布局；用 slots 与主题 token（`--dsw-alias-*`）。
- Client 半不要 `require` 其他 DSH Client 包；React 来自浏览器模块表。
- 定时器/监听器用 `ctx.effect` 注册清理。
- 不要写 `$DSH_HOME/profiles/**`；通过 bundle/plugin_manager 安装。

## 5. 贡献

生态层（`sdk/`、`tools/fangctl.mjs`）的贡献同样需要签署 [CLA](../CLA.md)（为了让项目能双许可）。
