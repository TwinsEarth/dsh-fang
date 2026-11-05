# MCP 接口（v3.0.8）

状态：**实现中**（server/tool registry 已落地，未安装、未发布）。进程外运行，不新增任何 `/fang` HTTP 路由。

## 传输

`tools/mcp/server.mjs`：stdio 上的 JSON-RPC 2.0。

支持方法：

- `initialize` → `protocolVersion=2024-11-05`、`serverInfo.name=dsh-fang`；
- `ping`；
- `tools/list`；
- `tools/call`。

## 默认工具（8）

| 工具 | 类型 | 说明 |
|---|---|---|
| `status` | sync | 母体/宿主状态 |
| `tasks` | sync | 分身任务列表 |
| `task_status` | sync | 单任务状态（`taskId`） |
| `derive` | op | 派生新分身 |
| `archive` | op | 归档分身 |
| `essence_list` | sync | 元主/原身列表 |
| `upgrade_status` | sync | 只读升级状态 |
| `compat` | sync | compat 门禁状态 |

## 辅助工具（2，元工具）

- `get_op({ opId })`：轮询长任务；
- `abandon_op({ opId })`：**只标记放弃轮询，不宣称已停止服务端任务**。

## 不暴露

- `promote`、`delete`、`restart`、`mirror_upgrade` 默认不可见；
- `adapter`、`session-bridge` 不暴露；
- 不新增 `/fang` 路由；
- 所有调用只走现有 B1 API（`x-fang-auth`）。

## 长任务语义

- `tools/call` 对 `derive`/`archive` 返回 `{ opId }`；
- 客户端用 `get_op` 轮询；
- 运行超时 → `state=timeout`；
- 无假取消；`abandon_op` 仅停止轮询。

## 安全

- token 只来自环境变量 `FANG_TOKEN` 或 `DSH_FANG_AUTH_TOKEN`，不写入工具参数/日志；
- 工具输出不回传 token/路径/凭据；
- 高风险工具不可通过参数“解锁”，只能改注册表（代码）后重启。

## 测试

- `test/mcp-tools.test.mjs`：8+4 工具可见性、幂等、超时、不假取消；
- `test/mcp-server.test.mjs`：initialize、tools/list、tools/call、get_op、未知方法；
- 当前 10/10 PASS；
- `preflight --e2e` GREEN。
