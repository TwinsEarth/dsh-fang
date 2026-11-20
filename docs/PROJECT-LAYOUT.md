# 项目目录指南（PROJECT-LAYOUT）

> 唯一根目录：`E:\DSH\DS\Fang`。**所有新建的代码、文档、脚本、构建产物、临时文件都必须在根内。**
> 禁止写回旧仓库 `E:/GPT/dsh-fang`，禁止写入其它项目/会话目录（DSH 自身存储除外）。
> 2026-11-21 从 `E:/GPT/dsh-fang` 整体迁入；记录见 [MIGRATION-2026-11-21.md](MIGRATION-2026-11-21.md)。

## 1. 目录职责

| 目录 | 职责 | 入库 |
|---|---|---|
| `src/` `test/` `tools/` `types/` `locale/` `defaults/` `sdk/` `queue-journal/` `relay-server/` `enterprise/` `docker/` `lsp-provider*/` `web-entry/` `probes/` | 源码、测试、脚本、子包 | ✅ |
| `docs/` | 设计、发布记录、审计、迁移与会话指南 | ✅ |
| `dist/` | 构建产物（npm tarball / manifest / preflight 报告，git 忽略） | ❌（.gitignore） |
| `node_modules/` | 依赖（迁移时保留，保证离线可跑；换机可 `npm ci`） | ❌（.gitignore） |
| `sessions/` | 会话快照、官方格式 ZIP、Fang 历史转录 | ❌ 本地 |
| `scratch/` | **唯一临时目录**；一次性脚本/日志，收尾清空 | ❌ 本地 |
| `runtime/` | 本机运行数据（预留；当前运行数据仍在 `D:\ToFuture`） | ❌ 本地 |
| `archive/` | 历史发布物、报告、恢复工具 | ❌ 本地 |
| `.secrets/` | 令牌/密钥（永不入库；`tools/release/lib.mjs` 会读这里） | ❌ 本地 |
| `tools/session/` | 会话恢复 / 官方 ZIP 导入（SESSION-MIGRATION-KIT，零依赖） | ❌ 本地 |
| `contract/` | 契约子仓库 `@twinsearth/dsh-fang-contract`（独立 `.git`，版本 1.2.0） | ❌ 本地 |

`.git/info/exclude` 已排除上述本地目录（不改 `.gitignore`，避免污染仓库历史）。

## 2. 写文件规则

1. 只写 `E:\DSH\DS\Fang` 内；一次性验证脚本放 `scratch/`，完成后删除。
2. 不把临时文件、缓存、备份快照留在仓库根；`dist/` 由构建脚本生成。
3. 不整体复制父目录（`E:\DSH\DS` 下还有 2Xray / IM2A / Master / W2M 等项目）；只按白名单复制本项目。
4. 会话恢复/导入只操作 `sessions/` 与本项目对应的 DSH 存储；**不改其它项目的会话**。

## 3. 换机继续开发

```powershell
# 1) 复制整个 E:\DSH\DS\Fang（含 .git 与本地目录）
# 2) 校验（tree 应与来源一致）
cd E:\DSH\DS\Fang
git fsck --no-progress --no-dangling
git status --short --branch
git rev-parse HEAD
git rev-parse 'HEAD^{tree}'

# 3) 依赖（Node >= 22；会话工具需 >= 22.15 zstd，建议 24 LTS）
npm ci
npm test                 # node --test --test-concurrency=1 "test/*.test.mjs"
node tools/release/preflight.mjs --e2e   # 发布门禁（含全量测试 + e2e）
```

构建：`npm run build`（产出 `dist/dsh-fang-<version>.tgz` + `dist/manifest.json`）。
发布：默认只准备；未经明确指令不 tag / Release / npm publish。

## 4. 运行数据（FANG_HOME）

- 本机运行数据仍在 `D:\ToFuture`（`forks/ essence/ accel/ sessions/ mirror/`，约 3.5 GB），**未随项目迁移**；
- 插件默认数据根由 `FANG_HOME`（或 `%DSH_HOME%/fang/<profile>/fang-home.txt`）决定，迁移不改动它；
- 若要归口到本项目，用 `tools/migrate-to-fang-home.mjs`/`npm run install:accel`，并逐项确认（涉及运行中的母体/分身，不能顺手做）。

## 5. 相关文档

- [MIGRATION-2026-11-21.md](MIGRATION-2026-11-21.md)：迁移来源/去向、排除项、校验、会话恢复
- [SESSIONS.md](SESSIONS.md)：DSH 会话存储、恢复、官方 ZIP 导入
- [WORK-RULES.md](WORK-RULES.md)：完整工作守则（唯一目录、发布禁令、Git、质量门）
- `AGENTS.md`：会话守则（每个 agent 接手前必读）
