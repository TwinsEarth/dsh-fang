# dsh-Fang v3.1.7 发布说明

- 版本：`3.1.7`（上一个发布 `3.1.6`）
- 定位：插件独立可用（`@twinsearth/dsh-fang` 宿主插件 + Web 客户端半），PC 客户端可选
- 规则：不动 `main`、不自动发布；发布动作按渠道执行

## 这一版修什么

用户现场报告：分身启动成功，但（1）页面看起来像元主、（2）选择工作区失败、（3）下任务/指令失败并报
`Invalid schema for function 'w2m_report'`。

### 1. 分身内模型请求被供应商拒绝（`Invalid schema for function 'w2m_report'`）

**根因（已定位到两条上游机制的交点）**：

- DSH（0.2.2-rc.1）在宿主进程里安装 profile-scope 模块解析器：只有 importer 位于
  profile 树内、或位于 `node_modules` 中**逐条目链接（linked root）**之下时，安装包的
  `@deepseek-ai/*` 才会被解析命中；整个 `node_modules` 是一颗 junction 时，importer 的
  realpath 落在 profile 作用域之外，解析退回 Node 默认规则并失败。
- w2m 插件对 `@deepseek-ai/dsh-tools` 的导入带离线 shim 兜底；shim 为了表达默认参数，
  把 `default` 改写成属性里的 `required: false`。这个注解不是合法 JSON Schema，
  DeepSeek 供应商会拒绝**整次**请求——所以分身里任何会话都发不出消息。

**修复**：

- forker provision/spawn 不再创建“整树 junction”，而是 `mirrorModuleTree()`：`node_modules`
  为真实目录，每个顶层条目一条 junction（目录链接、根文件复制），插件内容不复制；
- 每次 spawn 用 `ensureModuleMirror()` 就地修复历史版本留下的整树 junction（含旧分身）；
- 元主运行态（`essence-runtime`）走同一修复路径，不再用整树 junction 自愈；
- clean template 的 `node_modules` 同样物化为逐条目镜像。

**边界**：镜像条目仍指向母体/元主的真实包目录，不复制包内容、不改变“共享模块树”的设计；
插件升级后分身重启即可看到（与 junction 语义一致）。

### 2. 分身/元主 Web「选择工作区失败」

`dsh.cmd --no-open` 是无 Electron 壳的 headless 主机，但 `dsh-host-directory-picker-auto`
在 win32 + loopback 时固定解析为 `native`（它无法感知宿主是否无头），原生目录对话框无窗口可弹。

**修复**：forker 在 spawn 时写入 `fang-headless.patch.yml` 并通过 `--patch` 传给子进程：
禁用 `directory-picker` 自动行，直接挂载 `dsh-host-directory-picker-browse` +
`dsh-client-ui-directory-picker-browse`。安装里没有 browse 包（未知 DSH 版本）时保持默认，
不盲打补丁；`DSH_FANG_HEADLESS_PICKER_PATCH=0` 可整体关闭。

### 3. 第（1）点“页面像元主”的边界说明

分身是**完整 DSH Web 实例**（独立 `DSH_HOME`、独立端口、独立会话/项目），页面外观与母体一致是
设计；角色区分在瓮城面板内（`role=fork` 只显示“当前页面是分身的 Web UI”说明页）。
本版未新增顶部身份条——如需“一眼识别分身”的常驻标识，作为下一版 UI 需求处理。

## 安装后验收

```bash
pnpm add @twinsearth/dsh-fang@3.1.7
# 重启 dsh 宿主后刷新 Web 页面
curl -H "x-fang-auth: <token>" http://127.0.0.1:<port>/fang/api/status
```

- `/fang/api/status` 返回 `"version":"3.1.7"`；
- 启动一个分身：分身 profile 下出现 `fang-headless.patch.yml`；
- 分身 Web 里「选择工作区」弹出**浏览器目录选择**，不再依赖原生对话框；
- 分身 Web 里发一条指令：不再出现 `Invalid schema for function 'w2m_report'`。

## 门禁

- `preflight --e2e`：GREEN；全量套件 1023 pass / 0 fail / 1 skip；e2e 81/81（真实 dsh mother + fork）；
- 构建：`dist/dsh-fang-3.1.7.tgz`，516,261 B / 135 entries，
  sha256 `79c2d43b3725fd899b823341805c9da137bf20326e31593bef5ecb8bbeb6fb7d`；
- `package-smoke` PASS；`allow-list` routes=104 findings=0；
- `reinstall-drill` GREEN 7/7；`install-drill` 自动化检查 8/8 PASS（交互式弹窗步骤需人工，无人值守时超时）；
- 详见 `docs/AUDIT-v3.1.7.md` 与 `dist/preflight.json`。

## 已知边界（延续）

- 分身仍是生产盘；插件配置请在母体或元主运行态完成；
- PluginUpdater / SuperAgent / HarnessMM / PJM / Worker 本体未接；
- 分身 Web 的常驻身份标识未做（见上）；
- 本版修复对**已存在**的分身 profile 在下次 spawn 时生效；正在运行的分身需重启一次。
