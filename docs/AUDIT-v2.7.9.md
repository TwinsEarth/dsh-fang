# 审计报告 · dsh-Fang v2.7.9（shell 重定向解析升级为 AST-lite）

> 证据来自本机真实输出（2026-11-02，Windows / Node 24.16.0）。
> 报告不含凭据、不含本机绝对路径（allow-list 同时扫描这两类内容）。
> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 9 个补丁位（`2.7.8` → `2.7.9`）。

## 1. 本次交付

`parseShellRedirects` 从**正则抓 token** 升级为**词法/语法结构解析（AST-lite）**：先 `tokenizeShell()`
产出 `word / op / redirect{op, fd, target}` 结构，再按语法语义提取写/读目标，并由 `parseFailed` 驱动
规则 fail-closed。

| 交付物 | 内容 |
|---|---|
| `tokenizeShell(commandText)` | 词法器：引号（`'` `"` `$'`）、反斜杠转义、`$VAR`/`$(...)`/`${...}`/反引号/通配、fd 前缀、重定向操作符、命令分隔符、heredoc 正文吞掉 |
| `parseShellRedirects(commandText, policy)` | 在 token 上提目标：返回 `{ writeTargets, readTargets, parseFailed, parseError, heredocs, warnings }`，路径按 `policy.root` 解析 |
| `buildActionContext` | 新增 `parseFailed / parseError / heredocs / warnings`，15 条规则共享 |
| 规则 fail-closed | `exec-read-only` 在 `parseFailed` 时不匹配；有 `>` 且解析失败 → `write-outside-buffer`（`unparsed-redirect-fail-closed`）；否则 `exec-side-effect`（`unparsed-command-fail-closed`） |
| TS 参考实现 | `tokenizeShell` + 新 `parseShellRedirects` + `parseFailed` 透传与规则分支 |

## 2. 语义表（与旧正则版对比）

| 场景 | 旧正则 | AST-lite |
|---|---|---|
| `cmd 2>&1` | ❌ 误判写目标 `&1` | ✅ fd 复制，不提取 |
| `cmd 2> err.txt` | ⚠️ 依赖 token 形状 | ✅ fd=2 + 写目标 `err.txt` |
| `cmd &> f` / `&>> f` | ❌ 不支持 | ✅ 写目标 |
| `cmd >| f` | ❌ 不支持 | ✅ 写目标 |
| `cmd <> f` | ❌ 不支持 | ✅ 读 + 写 |
| `cat <<EOF > out.txt`（正文含 `>`） | ❌ 可能把正文当重定向 | ✅ 正文整段跳过，只认 `out.txt` |
| `cmd <<< "here"` | ❌ 可能当作读文件 | ✅ herestring，不提取 |
| `echo "a > b"` | ❌ 引号内 `>` 被当重定向 | ✅ 不提取 |
| `echo x > 'out file.txt'` | ⚠️ 空格截断 | ✅ 字面量目标含空格 |
| `bash -c 'echo x > out.txt'` | ❌ 引号内误抓 | ✅ 不抓（落 exec 规则判黄，fail-closed） |
| `echo x > $DIR/f` / `"$(mktemp)"` / `*.txt` | ❌ 可能当字面量路径 | ✅ `dynamic`，记 `warnings`，不当作路径 |
| `a; b > f` | ⚠️ 不识别命令边界 | ✅ 重定向只归属自己那段命令 |
| `tee`/`dd if=/of=`/`Set-Content`/`Get-Content` | 正则近似 | ✅ 命令段内按 argv 提取（flags 感知） |
| 未闭合引号 / heredoc | ❌ 静默按字符串处理 | ✅ `parseFailed=true` → 规则判黄（需审批） |

## 3. 为什么不用现成解析器

| 候选 | 结论 |
|---|---|
| `shell-quote` | 只做 tokenize，不认操作符与命令边界：`parse('ls && rm -rf /')` 只是 token 数组，`2>&1` 无法区分 fd 复制与文件 → **排除** |
| `@aliou/sh`（v0.3.4，`MIT AND BSD-3-Clause`，零运行时依赖，unpacked ≈315 KB） | 真 AST、覆盖完整；但**引入第三方运行时依赖会破坏本仓库零依赖约束**（CI 零依赖、profile 安装路径也都依赖这点）→ 不采纳，记录为可评估方案 |
| 手写词法器 | 采纳：只覆盖重定向提取所需的语法子集，零依赖，~300 行，可被 53 条测试逐条断言 |

## 4. 门禁结果

| 门禁 | 结果 |
|---|---|
| `preflight --e2e` | **GREEN 2.7.9** |
| 测试 | **464 项：463 pass / 0 fail / 1 skip（25.5s）**（保护伞 45 → 53 项） |
| e2e | **58/58（18.7s）**（真实母体 + 分身） |
| allow-list | **36 路由 / 0 findings / 161 文件扫描 / 包内 71 文件** |
| 构建 | `dist/dsh-fang-2.7.9.tgz`（**269,416 B，87 entries**）<br>sha256 `78861d52fd794881f9e492877d7d8438957987a1e80fdc0a8c94b7db6115b783` |
| 产物健康检查 | **HEALTHY** `@twinsearth/dsh-fang@2.7.9`（16 个模块可 import） |
| TypeScript 参考 | `tsc 5.9.2` 严格编译 **0 error**；编译产物行为断言 **95/95** |

## 5. 刻意的取舍与边界

1. **只做重定向提取，不做完整 shell 语义**：不展开变量、不展开子命令、不解析别名与 `eval`；这些目标标记为 `dynamic` 并跳过（fail-closed），
   而不是猜成字面量路径。
2. **heredoc 正文不执行语义分析**：正文整段跳过——正文里的 `>`、`$(...)` 都是数据。这是「不能把数据当代码」的必然选择。
3. **解析失败一律判黄**：`parseFailed` 时 `exec-read-only` 不再宣称只读；有 `>` 则直接落 `write-outside-buffer`。
   代价是复杂但无害的命令会多问一次——比静默放行安全。
4. **PowerShell 共用同一个词法器**：`>` 在 PS 里就是 Out-File，基本形态可用；PS 专有语义
   （`-RedirectStandardOutput`、流合并细节、反引号转义差异）**不解析**，文档如实声明，可疑语法由兜底规则判黄。
5. **性能**：词法器单次线性扫描；动作评分延迟用例仍守在 2ms/次预算内（本次实测 ~0.03ms/次）。
6. **未做 realpath**：符号链接仍可能让字面路径与实际路径不一致（既有边界，未变）。

## 6. 提交状态

- 分支：`feat/umbrella-shell-ast`（stacked 在 PR #28 的 `feat/umbrella-rules` 之上）；
- 发布物：`dist/dsh-fang-2.7.9.tgz` + `dist/manifest.json` + `dist/preflight.json` + `dist/allowlist.json`；
- npm/GitHub Release 未执行；未合并 main：本 PR 只推送分支与 PR。
