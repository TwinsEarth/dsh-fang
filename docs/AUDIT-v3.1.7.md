# AUDIT v3.1.7

> 版本：3.1.7（2026-11-10）
> 主题：分身/元主运行态的模块解析与无头 Web 目录选择修复。

## 1. 本版修复

| 问题 | 根因 | 修复 |
|---|---|---|
| 分身内下任务/指令失败：`Invalid schema for function 'w2m_report'` | 分身 profile 的 `node_modules` 是整树 junction，importer realpath 落在 DSH profile 作用域之外；插件对 `@deepseek-ai/dsh-tools` 的懒加载失败，退回 w2m 插件离线 shim，shim 把默认参数写成属性级 `required:false`（非法 JSON Schema），DeepSeek 供应商拒绝整次请求 | `forker` provision/spawn 改用 `mirrorModuleTree()`：真实 `node_modules` 目录 + 每个顶层条目一条 junction；每次 spawn 用 `ensureModuleMirror()` 就地修复历史整树 junction；元主运行态同样处理；clean template 同样物化 |
| 分身/元主 Web「选择工作区失败」 | `dsh.cmd --no-open` 为无 Electron 壳的 headless 主机；`dsh-host-directory-picker-auto` 在 win32 + loopback 固定解析 `native`，原生目录对话框无窗口可弹 | spawn 写入 `profile/fang-headless.patch.yml` 并以 `--patch` 传给子进程：禁用 `directory-picker` 自动行，直接挂载 `dsh-host-directory-picker-browse` + `dsh-client-ui-directory-picker-browse`；安装里没有 browse 包时保持默认；`DSH_FANG_HEADLESS_PICKER_PATCH=0` 可关闭 |
| “页面像元主” | 分身是完整 DSH Web 实例（独立 DSH_HOME/端口/会话），外观与母体一致是设计；角色区分在瓮城面板内 | 本版不改；是否加常驻身份标识留作下一版 UI 需求 |

### 关键设计边界

- 镜像条目仍指向母体/元主真实包目录（不复制包内容），保持“共享模块树”语义；插件升级后分身重启即生效。
- 只对指向“模块树根”的 node_modules junction 做物化；本身是真实目录的 profile 不动。
- overlay 仅在 DSH 安装确有 browse 目录选择包时写入（asar 探测 / 模块解析）；未知版本不盲打补丁。

### 实测证据（本地）

```text
# 受控复现（E:\GPT\.tmp\repro，DSH 0.2.2-rc.1，真实 dsh.cmd 子进程）
A 整树 junction profile      : dsh-tool-subagent 导入失败（ERR_MODULE_NOT_FOUND: @deepseek-ai/cordis）；
                               探针插件 import('@deepseek-ai/dsh-tools') 失败 → PROBE_DID_NOT_RESOLVE
B 逐条目镜像 profile         : 无 stderr 告警；探针 import('@deepseek-ai/dsh-tools') 成功；页面 boot 为
                               directory-picker-browse（native 不在组合中）
# 真实 forker 端到端（REPO 新代码 + 真实 dsh.cmd + 母体插件全集，含 w2m）
provision                    : ok，121 条镜像链接，warnings=[]
spawn                        : ok，port 18050，子进程 banner 正常
log tail                     : 无 ERR_MODULE_NOT_FOUND / 无 entry did not activate / 无离线 shim 告警
overlay                      : profile/fang-headless.patch.yml 已写入（Electron-as-node 宿主探测到 asar 内 browse 包）
```

## 2. 门禁证据

```text
preflight --e2e : GREEN
tests           : 1023 pass / 0 fail / 1 skip（331.4s；preflight 全量套件）
e2e             : 81/81（62.5s，真实 dsh mother + fork，使用本版新代码）
CI build job    : preflight green; tests pass=1007 fail=0 skip=3; e2e 81/81 (53.4s); tarball 516,205 B / 135 entries
package smoke   : PASS
allow-list      : routes=104 findings=0
artifact        : dist/dsh-fang-3.1.7.tgz
size            : 516,205 B / 135 entries（CI 发布物）
sha256          : 2975c6e8e2dbe1a9b71922e37ff4769e222deba0951d3577abb18f62465fbe4f
install drill   : 自动化检查 8/8 PASS（干净 profile 安装、boot、client half、status=3.1.7、19 行 fang-* 组合）；
                  交互式弹窗步骤（请人在新 PowerShell 窗口选 1/2/3）在无人值守运行中超时，未计入通过
reinstall drill : GREEN 7/7（重装+脏数据后启动、status=3.1.7）
```

## 3. 发布

| 方 | 状态 |
|---|---|
| GitHub Release | 已发布：https://github.com/TwinsEarth/dsh-fang/releases/tag/v3.1.7（4 assets） |
| npm | 已发布 `@twinsearth/dsh-fang@3.1.7`（latest） |
| CI | 成功：release run 42748226212（attempt 2）；main ci/compat 成功 |

## 4. 已知边界

- 本版修复在**下次 spawn** 时生效：已在运行的分身需重启一次，母体升级到 3.1.7 后重新启动即可自动物化镜像并追加 overlay。
- 分身仍是生产盘；插件配置请在母体/元主运行态完成。
- 分身 Web 常驻身份标识未做。
- PluginUpdater / SuperAgent / HarnessMM / PJM / Worker 本体未接。
