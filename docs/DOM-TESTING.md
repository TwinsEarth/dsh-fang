# 客户端 DOM 测试（jsdom）

## 是否存在

存在。不是源码级契约：

```text
test/client-inbox-dom.test.mjs      7 tests
package.json                        devDependencies.jsdom
```

## 运行

```powershell
cd <repo>
npm install          # 首次，安装 jsdom（只在 devDependencies）
npm run test:dom
```

## 覆盖

| 用例 | 覆盖 |
|---|---|
| `inbox groups, collapse, ACK, batch partial failure and SSE merge` | 五色分组、绿/灰默认折叠、`__ACK__`、批量部分失败 UI、SSE 实时合并、红色强提醒 |
| `group header checkbox is tri-state select-all` | 分组头三态全选：未选 → 部分(indeterminate) → 全选 → 清空；点 checkbox 不触发折叠；一键展开/收起全部 |
| `footer seat opens fallback drawer, Esc closes` | 无 right pane 服务时：侧栏入口 → 固定 drawer + backdrop；Esc 关闭 |
| `footer seat prefers host right-pane openTab over local drawer` | 宿主有 `sidebarRight.openTab` 时优先打开右侧 pane，不建本地 drawer |
| `unread count is pending count and stays in sync in all three places` | badge / tab 标题 / 收件箱标题三处都等于 pending 数，打开收件箱不清零 |
| `keyboard navigation selects, resolves, refreshes and clears` | ↑↓/j k、X 勾选、Enter 处理（推荐→首项→ACK）、R 刷新、Esc 清空 |
| `rev/since incremental refresh merges only deltas` | 客户端 `since` 增量合并（断言 URL `since=1`） |
| `blue/green batch resolve sends selected ids` | 蓝/绿批量按钮 |
| `mixed batch success + failure ...` | 成功一条 + 失败一条的逐条失败 UI |
| `batch archive sends selected ids and confirms once` | 批量归档确认 |
| `right-panel decision mini groups red first, folds green/gray, refetches after 409` | 右侧决策中心区域（红置顶、绿灰折叠、409 后重新拉取） |
| `HTTP 409 shows error and does not fake success` | 409「已被处理」，不乐观删除 |

## 实现方式

- jsdom 只做测试环境；`client.js` 仍是零构建、原生 DOM；
- 测试用 15 行 React stub 满足宿主插槽签名（`DomMount` 不执行 React）；
- 通过 `window.__ModuleLoader__` 加载 `client.js`，捕获 factory，用 fake `ctx.slots` 挂载收件箱/右侧区域。

## 边界

- 不是 Electron E2E，也不是真浏览器视觉测试；
- 运行中宿主若是旧 bundle，界面上仍看不到新行为；需要重启 DSH Desktop。
