# 审计报告 · dsh-Fang v2.9.2（顶栏「母体打开」按钮）

> 证据来自本机真实输出（2026-11-02，Windows / Node 24.16.0）。
> 版本策略：`x.y.z`；这是 v2.9 的第二个补丁位（v2.9.1 见 `AUDIT-v2.9.1.md`）。

## 1. 交付内容

| 位置 | 改动 |
|---|---|
| `client.js` `IconGlobe` | 新增蓝色（INFO token）地球图标，10–20px 自适应 |
| `client.js` 顶栏 | 在「母体连接」与「派生新分身」之间新增「母体打开」按钮（quiet） |
| `client.js` `openMotherPortal` | 新窗口打开母体瓮城独立门户 `/fang/panel`：桌面端用 `resolveMotherOrigin()` 拼绝对 HTTP 地址（如 `http://127.0.0.1:52648/fang/panel`），普通 Web 回退相对路径；`window.open` 被拦截时回退同标签页跳转 |

服务端无改动（复用 v2.9.0 的 `/fang/panel` 门户与 v2.9.1 的 origin 解析）。

## 2. 门禁结果（v2.9.2）

| 门禁 | 结果 |
|---|---|
| `preflight --e2e` | **GREEN 2.9.2** |
| 测试 | **513 pass / 0 fail / 1 skip** |
| e2e | **58/58** |
| allow-list | **38 路由 / 0 findings**（175 文件扫描；74 包文件） |
| 构建 | `dist/dsh-fang-2.9.2.tgz`（291,455 B / 91 entries / sha256 `9383a5a5de57feeba2c5c5907917ae41ed64f38c82739880d37b648d5ca52f6d`） |
| 产物健康检查 | **HEALTHY** `@twinsearth/dsh-fang@2.9.2`（16 模块） |

## 3. 生效方式

desktop profile 通过 `link:E:/GPT/dsh-fang` 直接加载仓库的 `client.js`：
**刷新页面**即可看到新按钮；宿主缓存模块时重启桌面应用。

## 4. 边界

- 按钮只负责打开母体门户，不改变任何连接状态；探测仍走「母体连接」卡片。
- 桌面壳里若 `__DSH_TRANSPORT__.streamBaseUrl` 不可用，回退相对 `/fang/panel`（由壳路由拦截），
  两条路径都不会拼出 `dsh-app://` 绝对地址。
- 同标签页回退仅在弹窗被拦截时发生；正常情况不打断当前面板。

## 5. 提交状态

- 分支：`feat/mother-link-fix`（stacked 在 `feat/mother-link` / v2.9.0 之上；含 v2.9.1 + v2.9.2 两个提交）
- 发布物：`dist/dsh-fang-2.9.2.tgz` + manifest/preflight/allowlist
- 未合并 main；Release/tag 与私有镜像同步在 PR 合并后执行
