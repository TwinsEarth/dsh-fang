# 插件模板（MIT）

最小可安装的 DSH / dsh-Fang 插件，包含 Host 半（`index.js`）与可选的 Client 半（`client.js`）。

## 用法

```powershell
Copy-Item -Recurse sdk\templates\plugin E:\my\my-plugin
cd E:\my\my-plugin
# 1) 改 package.json：name、dsh.client（不需要 UI 就删掉 dsh.client 与 client.js）
# 2) 改 cordis.patch.yml：id 与 name 保持一致
# 3) 在 DSH 会话里安装：
#    plugin_manager install_bundle(target="E:\\my\\my-plugin")
```

## 结构

| 文件 | 作用 |
|---|---|
| `package.json` | `dsh.bundle.patch` 让它成为可安装 bundle；`dsh.client` 声明浏览器半 |
| `cordis.patch.yml` | 安装时把 `my-plugin` 这一行 insert 进 profile 的 loader 树 |
| `index.js` | Host 半：`export const name / inject / apply`；用 `ctx.effect(ctx.provide(...))` 提供能力 |
| `client.js` | Client 半：向 `conversation.composer.dock` 注册一个徽标（可删） |
| `locale/en.json` | 界面上显示给用户的标题与描述（国际化） |
| `icon.svg` | 插件图标；不要用上游/他人的图标 |

## 可配置

模板刻意**不带** `Config`，避免模板依赖 schema 库。需要配置时，把 schemastery（MIT）复制到
`vendor/` 再 `export const Config = z.object({...})`——核心层的做法可直接参考。

## 与瓮城交互

第三方插件调用瓮城只看公开 HTTP 面：`/fang/api/status`、`/fang/api/tasks`、`/fang/api/sessions`、
`POST /fang/api/derive` 等（见 [`../../README.md`](../../README.md)）。用 HTTP 交互时你的插件是独立作品，
可以选择自己的许可证。
