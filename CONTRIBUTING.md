# Contributing to dsh-Fang

谢谢你有兴趣贡献！本项目采用 **AGPL 核心 + MIT 生态 + 商业闭源** 的分层许可，
贡献前请先读 [CLA.md](CLA.md) —— **没有签署 CLA 的 PR 不会被合并**（双许可证路径的法律前提）。

## 1. 先看边界

| 你想改的地方 | 许可 | 要求 |
|---|---|---|
| `src/`、`probes/`、`client.js`、`test/`（核心层） | AGPL-3.0-or-later | 你的改动同样以 AGPL 发布，并授予维护者再许可权（CLA） |
| `sdk/`、`tools/fangctl.mjs`（生态层） | MIT | 同样需要签署 CLA（用于再许可），但代码以 MIT 分发 |
| `relay-server/`、`enterprise/`（商业层） | 商业闭源 | 不接受外部 PR；如需合作请邮件联系维护者 |
| 第三方 vendored 代码（`src/kernel/vendor/`） | MIT（上游） | 保持上游版权头，不要改成 AGPL |

## 2. 开发循环

```powershell
git clone <repo-url> dsh-fang
cd dsh-fang

# 零第三方依赖，无需 install
node --test --test-concurrency=1 "test/*.test.mjs"      # 全量测试（唯一的验收命令）
node tools/fangctl.mjs doctor                            # 离线自检
node tools/e2e.mjs                                       # 真实母体 + 真分身的端到端验收（需要本机 DSH 安装）
```

- 新增文件必须在文件头加 `SPDX-License-Identifier`（核心层 `AGPL-3.0-or-later`，生态层 `MIT`）；
  `test/licensing.test.mjs` 会检查这一点。
- 提交前跑一次 `node --test --test-concurrency=1 "test/*.test.mjs"`，保持全绿。
- 不要提交 `dist/`、任何 `audit.jsonl`/`forks.json`/`tasks.json` 等运行数据（`.gitignore` 已覆盖）。

## 3. 代码风格

- ESM、零第三方依赖、Node ≥ 22（CI 覆盖 22/24）。
- 磁盘操作统一走 `src/kernel/fsx.mjs`（原子写、junction 安全删除）。
- 跨插件只通过 `ctx.get(SERVICE.*)` 可选服务或公开 HTTP API 交互；缺失服务必须显式降级。
- 每个插件 `apply()` 首行是 `roleGate(...)`（部署矩阵见 `src/kernel/role.mjs`）。

## 4. PR 流程

1. Fork / 分支：`feat/<short-name>` 或 `fix/<short-name>`；
2. 在 PR 描述中写：`I have read the CLA and I sign it.`（附 GitHub 用户名与真实姓名/主体）；
3. 确保 CI 绿（测试 + licensing 检查）；
4. 维护者 review 后合并；提交信息用中文/英文均可，建议 `feat: …` / `fix: …` / `docs: …`。

## 5. 安全问题

请**不要**在公开 issue 里披露漏洞，按 [SECURITY.md](SECURITY.md) 的渠道私信维护者。
