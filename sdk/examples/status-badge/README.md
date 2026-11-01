# status-badge（MIT 示例插件）

演示第三方插件如何**只通过公开 HTTP 面**与瓮城交互：

- `index.js`：Host 半，提供一个只读服务（证明插件已加载）；
- `client.js`：Client 半，每 10s 拉一次 `GET /fang/api/status`，在输入框下方显示「瓮城 N/M」。
- 不 import 任何瓮城内部模块 → 它是独立作品，可自由选许可证（本示例为 MIT）。

安装：

```powershell
# DSH 会话里：
#   plugin_manager install_bundle(target="<repo>\\sdk\\examples\\status-badge")
```

失败态：拉不到 `/fang/api/status` 时显示「瓮城离线」，不假装有数据。
