# 工作守则（WORK-RULES）

> 适用：工作目录（cwd）位于 `E:\DSH\DS\Fang` 的全部会话（2026-11-21 从 `E:/GPT/dsh-fang` 迁入）。
> 本文件是 `AGENTS.md` 的展开版；两者冲突时以用户当次明确指令为准。

## 1. 唯一根目录（硬性）

- 所有代码、测试、文档、脚本、构建产物、临时文件**只能**写在 `E:\DSH\DS\Fang` 内。
- 禁止写回旧仓库 `E:/GPT/dsh-fang`；禁止写入 `E:\GPT\dsh-master`（已冻结）等其它项目目录；
  禁止写入其它工作区的会话内容（DSH 自身存储中本项目会话除外）。
- 临时文件 → `scratch/`；会话 → `sessions/`；运行数据 → `runtime/`；历史资料 → `archive/`；
  密钥 → `.secrets/`（永不入库）。
- 不整体复制父目录（`E:\DSH\DS` 下还有别项目）；只按白名单复制本项目。

## 2. 发布纪律（硬性）

- **禁止主动/自动发布**：未经用户当次明确指令，不执行 `npm publish`、不创建/修改 GitHub Release、
  不推送 `v*` tag、不触发 release workflow、不上传任何公开产物。
- 发布必须经主城门禁（`node tools/gate/main-city.mjs --target source|package|publish`）与全量测试；
  禁止绕过。
- 版本号以用户当次明确指定为准；不得自行跳号，跨版本需二次确认。
- 准备完成后只汇报「发布准备完毕，可以发布」并给出待执行命令。

## 3. Git 规则

- 允许本地提交；**推送远端、打 tag、改远端配置必须用户明确要求**。
- 不 force push（除用户明确确认）；不删用户分支/tag。
- 提交信息用 `type(scope): 说明`；迁移/杂务用 `chore(migrate)` 等前缀。

## 4. 质量门

发布/交付前必须通过（在 `E:\DSH\DS\Fang` 内执行）：

```powershell
npm test                                   # 全量单测
node tools/release/preflight.mjs --e2e     # 版本/许可/crash-safety/allow-list/main-city source/全量测试/e2e/产物 sha256
npm run release:check                      # 契约版本 + 发布顺序（需要网络）
```

`allow-list` 必须 0 findings（本地目录 `sessions/scratch/runtime/archive/.secrets/contract` 不参与扫描）。

## 5. 范围（沿用 2026-11-12 用户指令）

- 本会话只做**瓮城 dsh-fang**；`dsh-master`（房主）已冻结，涉及它的请求必须停止、提醒用户、
  取得二次确认后才可继续，且仅限确认的那一项。
- 发现用户在其它项目/会话范围上搞错时，先停下来提醒，不要顺手改。

## 6. 迁移后要点

- 仓库根 = `E:\DSH\DS\Fang`；完整历史 73 tag；当前 `main` 与 `origin/main` 同步（v3.6.1 已于 2026-11-22 三方发布）；
- 本地目录通过 `.git/info/exclude` 排除，随文件夹复制带走；
- 会话恢复/官方 ZIP 导入见 [SESSIONS.md](SESSIONS.md)；目录职责见 [PROJECT-LAYOUT.md](PROJECT-LAYOUT.md)；
- 迁移记录见 [MIGRATION-2026-11-21.md](MIGRATION-2026-11-21.md)。
