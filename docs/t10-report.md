# T10 完成报告 — 母体只读会话目录（`fang-session-catalog`）+ 会话格式库

> 任务：task-10（T10，v2.1.0 新模块）。写域：`src/lib/session-format.mjs`、
> `src/plugins/session-catalog.mjs`、`test/session-format.test.mjs`、
> `test/session-catalog.test.mjs`、`test/fixtures/t10`（未使用：fixture 全部用 mkdtemp 现场生成）、
> `docs/t10-report.md`。除以上文件外**未改动任何文件**（kernel/patch/package/compose/
> orchestrator/client 的接线由 Lead 负责；测试与冒烟均未写真实 `$DSH_HOME`）。

## 1. 交付文件

| 文件 | 行数 | 说明 |
|---|---|---|
| `src/lib/session-format.mjs` | 416 行 | 纯函数库（**零 import**，fs/zstd 全部注入）：id 校验、workspace.json 容错解析、workspaceKey 编码、只 stat 扫描、多帧 zstd 有界头读、脱敏 |
| `src/plugins/session-catalog.mjs` | 603 行 | `fang-session-catalog`：roleGate('sessionCatalog')、只读会话目录服务 + 3 条 exact HTTP 路由 |
| `test/session-format.test.mjs` | 11 test / **92 处 assert** | 纯库分支全覆盖 |
| `test/session-catalog.test.mjs` | 18 test / **177 处 assert** | 服务/路由/角色门禁/只读性/空态回归 |
| `docs/t10-report.md` | 本报告 | — |

Lead 已完成的接线（本任务只读核验）：`MATRIX.sessionCatalog=['mother']`、
`SERVICE.sessionCatalog='fangSessionCatalog'`、`ROW.sessionCatalog='fang-session-catalog'`、
`package.json` 版本 2.1.0 + `./session-catalog` 导出、`cordis.patch.yml` 的
`fang-session-catalog` 行（limit/allowArchived/previewMaxChars 与本模块 `Config` 一致）。

## 2. 实测格式依据（本机 `%USERPROFILE%\.dsh`，只读）

- `storages/workspace.json`：`{unit, global:{archivedSessionIds[], pinnedSessionIds[],
  workspaceIds[], defaultWorkspaceId}, tables:{workspaces:{<id>:{path,title,sessionIds[],
  createdAt,updatedAt}}}}`；
- `sessions/<workspaceKey>/<sessionId>/session.v4.jsonl.zstd`：
  - workspaceKey 由工作区绝对路径编码：`<workspace>` → `--E-GPT--`，
    `C:\Users\a\b` → `--C-Users-a-b--`（非 `[A-Za-z0-9_-]` 连续字符折叠为 `-`，首尾 `--`）；
  - **两种 sessionId 目录并存**：`session-<uuid>`（旧）与裸 `<uuid>`（当前 v4 运行，
    `DSH_SESSION_ID` 即裸 uuid）——两者都必须能列出，故 id 正则宽松为
    `^(?:session-)?[0-9a-f]{8}-...$`；
  - 日志是**多帧 zstd 拼接**（magic `28 B5 2F FD`）：实测 95MB 的会话第一帧仅 162 字节、
    解出 1 行 `session` 头（id/createdAt/cwd/agentPreset/isSeeded/delegationDepth/version），
    后续帧才是事件；
  - 实测 Node v24 `zlib.zstdDecompressSync(整文件)` 只返回第一帧（忽略后续帧），
    且**对截断帧不抛错而是返回 0 字节** —— 头读实现因此额外把「非空输入解出 0 字节」
    判为 `decompress-failed`，不把半截数据当成功。

## 3. 契约实现对照

### 3.1 角色门禁（CONTRACTS-V2 §1）

```js
export function apply(ctx, config) {
  const gate = roleGate('sessionCatalog', { logger: ctx.logger })  // 首行
  if (!gate.active) return
  …
}
```

- 仅 mother：fork 角色下测试断言 `ctx.get(SERVICE.sessionCatalog) === undefined`
  且 `webServer` 桩 `routes.length === 0`；
- 服务用 `ctx.effect(() => ctx.provide(SERVICE.sessionCatalog, service))` 注册，dispose 释放。

### 3.2 纯库 `session-format.mjs`（前端 id 安全边界）

| 导出 | 行为 |
|---|---|
| `SESSION_ID_RE` / `isValidSessionId` | `session-<uuid>` 与裸 `<uuid>` 均接受；拒绝 `/`、`\`、`..`、盘符、UNC、NUL、超长、非字符串 |
| `parseWorkspaceIndex(raw)` | 字符串/对象均可；坏 JSON、空、缺表、BOM、重复 path、无 path 全部容错并带 `degraded`；全局归档/置顶集合去重 + id 过滤 |
| `encodeWorkspaceKey(path)` | 仅显示/定位用，**不可反解**；实测编码见 §2 |
| `scanSessionDirs({sessionsDir, workspaceIds, archivedSessionIds, pinnedSessionIds, fsApi})` | **只 stat**（`statSync` 日志文件取 bytes/mtime），不解压不写；跳过非法目录名、缺日志目录；输出 `{sessionId, workspaceId(=workspaceKey), updatedAt, bytes, archived, pinned, relPath}`，按 updatedAt 倒序 |
| `readBoundedHead({file, maxCompressedBytes=262144, maxLines=50, maxChars=65536, fsApi, zstdDecompressSync})` | 只读前 N 压缩字节；按 magic 找帧边界、**只解第一帧**（候选边界逐个试解，防压缩数据里的伪 magic）；返回 `{lines, degraded, bytesRead}`；`degraded` 词汇：`compressed-limit` / `first-frame-only` / `decompress-failed` / `line-limit` / `char-limit` / `short-read` / `empty` / `not-zstd` / `no-fs-api` / `no-zstd` / `read-failed` / `no-file` |
| `redact(text)` | 返回 `{text, redactions}`：Bearer、token/access_token/refresh_token/api_key/secret/password 值、`sk-` 键、邮箱、手机号（+86/国际）、Windows/UNC/POSIX 绝对路径 → 占位符，计数为替换次数 |

安全规则：**前端只提供 sessionId**；插件从不接受/拼接任意路径，实际文件路径由扫描结果
（readdir 名 + 正则校验后的 sessionId）推出，并再做一次 `path.relative` 包含性校验
（`isInside`，防御纵深）。

### 3.3 插件服务与路由（契约 §5.1 同类实现风格）

`Config = {dataRoot(保留), sessionsRoot, storagesRoot, prefix='/fang', limit=50,
maxFileBytes=262144, previewMaxChars=2048, allowArchived=true}`；根目录缺省为
`<DSH_HOME>/sessions`、`<DSH_HOME>/storages`（`resolveDshHome()` 读 `DSH_HOME`）。

```
status()            -> {ok:true, role:'mother', version, readOnly:true, readable:boolean,
                        sessionsRoot, storagesRoot, workspaceIndex, workspaceIndexOk, limit,
                        maxFileBytes, previewMaxChars, allowArchived,
                        counts:{sessions,archived,pinned,workspaces,workspaceDirs}, degraded[]}
listSessions({limit, includeArchived, workspaceId})
                    -> {ok:true, readable, sessions:[{sessionId, workspaceId, workspaceKey,
                        workspacePath, workspaceTitle, workspaceKnown, updatedAt, updatedAtIso,
                        bytes, archived, pinned}], total, returned, limit, includeArchived,
                        degraded[]}                       // sessions 根缺失 = 空列表 + degraded
getSession(sessionId) -> {ok, session:{…上述元数据 + createdAt/createdAtIso, cwd, agentPreset,
                        isSeeded, delegationDepth, sessionVersion, header, logFile, head:{}}
readHead(sessionId, {maxLines,maxChars,maxCompressedBytes})
                    -> {ok, sessionId, workspaceId, lines(已脱敏), redactions, bytesRead, degraded[]}
digest(sessionId)   -> {ok, sessionId, markdown, digest(同 markdown 的等价别名), bytes,
                        limit:32768, redactions, degraded[]}
                     | {ok:false, code:'digest-too-large', bytes, limit, degraded}
```

- 列表/状态**只 stat**；`getSession/readHead/digest` 才做有界头读；
- **空态语义（e2e 验收回归）**：`$DSH_HOME/sessions` 不存在 = 全新环境「还没有会话」，
  是正常空态：`status()` 仍 `ok:true` 且 `readable:false`、`listSessions()` 仍 `ok:true` +
  `sessions:[]` + `degraded:['sessions-root-missing']`（HTTP **200**）；只有**显式非法
  sessionId → 400**、**单个会话不存在 → 404**，不把「空目录」当错误；
- **digest ≤32KiB**：超限返回 `digest-too-large` 而不是静默截断（`previewMaxChars` 可收紧）；
  成功结果同时给 `markdown` 与 `digest`（orchestrator.derive() 读 `digest.markdown`）；
- 依赖缺失/数据不可读一律显式降级：`workspace.json` 缺失 → 仍列出（`workspaceKnown:false`）
  + `degraded:['index-not-found']`；会话根缺失 → 空列表 + `degraded:['sessions-root-missing']`；
- 审计：`ctx.get(SERVICE.auditor)?.append(...)` 容错，kind 用字符串
  `session-listed` / `session-read`（含 op:'get'|'head'|'digest'），auditor 缺失静默继续；
- **不写盘**：模块内无任何写 API（测试静态断言源码不含 writeFileSync/mkdirSync/ensureDir/…）；
- **不 import forker/approver**（测试静态断言）。

**HTTP 路由**（`ctx.inject(['webServer'])` + `webServer.register({kind:'exact'})`，prefix 默认 `/fang`）：

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/fang/api/sessions` | `?limit= &includeArchived= &workspaceId=`（workspaceId 接受 workspace uuid / workspaceKey / 路径三种）；根缺失 → **200 空态 + degraded** |
| GET | `/fang/api/sessions/item` | `?sessionId=`；缺失/非法 → 400；不存在 → 404 |
| GET | `/fang/api/sessions/head` | `?sessionId=&lines=&maxChars=&maxCompressedBytes=`；行文本已脱敏；数据损坏 → 200 + degraded |

状态码：405 方法错误、400 `invalid-session-id`、404 `not-found`、409 头读/digest 数据不可读
（`index-read-failed`/`digest-too-large`/`path-escape` 等）、500 handler 抛错；
**sessions 根缺失不是错误**（200 + 空列表 + degraded）。

## 4. 测试与证据

### 4.1 单文件真实输出

```
node --test test/session-format.test.mjs test/session-catalog.test.mjs
ℹ tests 29
ℹ pass 29
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 505
```

- `session-format`（11 test / **92 assert**）：id 校验接受/拒绝矩阵、真实 workspace.json shape、
  容错解析（空/坏 JSON/缺表/BOM/重复 path/数组）、三种 workspaceKey 实测编码、
  只 stat 扫描（归档/置顶/更新时间排序/非法名跳过/缺日志跳过/指定 workspace 过滤/无 fsApi）、
  多帧头读只解第一帧 + `first-frame-only`、maxLines/maxChars/maxCompressedBytes 三种预算降级、
  空/缺文件/非 zstd/无 fsApi/无 zstd 降级、脱敏逐类 14 例 + 混合计数 + 原始秘密不残留；
- `session-catalog`（18 test / **177 assert**）：fork 不注册服务/路由 vs mother 注册、
  模块形状/Config 默认、不 import forker/approver、status 计数与根路径、listSessions
  默认隐藏归档/倒序/元数据/limit 夹紧/allowArchived=false 政策/workspaceId 三态过滤、
  **根缺失 = 200 空态 + degraded（service 与 HTTP 各一条回归用例）**、getSession header
  （只解第一帧）、路径元字符 7 组拒绝 + 未知 id not-found、readHead 逐行脱敏
  （token/邮箱/路径不泄漏）+ `first-frame-only`、digest 内容/脱敏/≤32KiB + `markdown` 别名、
  digest 超限 halt 不返回截断内容、3 条 exact 路由 + 自定义 prefix、HTTP 200/405/400/404、
  **只读性：apply+全部读取前后 `digestTree($DSH_HOME)` 深比较不变**、审计 kind 顺序与缺失容错、
  无 webServer 时 service 可用、workspace.json 缺失时仍列出。

### 4.2 真机只读冒烟（`%USERPROFILE%\.dsh`，仅读）

```
apply ms 4  routes ["/fang/api/sessions","/fang/api/sessions/item","/fang/api/sessions/head"]
status ms 17 {"ok":true,"counts":{"sessions":283,"archived":16,"pinned":1,
              "workspaces":1,"workspaceDirs":3},"degraded":[]}
list ms 12  total 283（首条 a6cf435d-… 2026-11-01T06:00:52Z / 1.0MB / ws=GPT）
getSession ms 15 {"ok":true,"createdAt":"2026-11-01T05:29:06.898Z","agentPreset":"cordis",
                  "degraded":["compressed-limit","first-frame-only"]}
readHead ms 11 {"ok":true,"lines":1,"redactions":1,"bytesRead":262144,
                "degraded":["compressed-limit","first-frame-only"]}
digest ms 21 {"ok":true,"bytes":703,"degraded":["compressed-limit","first-frame-only"]}
```

说明：真机第一帧通常只有 1 行 session 头，`readHead` 如实返回 1 行并标记
`first-frame-only`（这是「只解第一帧」契约的直接结果，不是 bug）；头行里的 `cwd` 在
readHead 输出中已被脱敏为 `<path>`。

### 4.3 全量回归（Lead 的基线 243 tests）

```
node --test --test-concurrency=1 "test/*.test.mjs"
ℹ tests 276
ℹ pass 275
ℹ fail 0
ℹ skipped 1        # T8 容器真实探针（FANG_CONTAINER_LIVE 开关，非 T10）
exit code 0
```

新增 29 个 test（T10）+ Lead 并行的 plugins-shape/v2.1/e2e 相关用例；v1/v2.0 既有测试保持全绿。

### 4.4 Lead e2e 验收回归（v2.1.0 空态语义修复）

Lead 用 `node tools/e2e.mjs`（真实 dsh 母体 + 真分身）验收时发现唯一失败项：
全新临时 `$DSH_HOME` 没有 `sessions` 目录时 `GET /fang/api/sessions` 返回 **409**
（`{ok:false, code:'sessions-root-missing'}`），但「还没有会话」是新装环境常态，不应是错误。

修复（仅本任务写域内两处语义，见 `src/plugins/session-catalog.mjs`）：
- `listSessions()` 根缺失 → **`ok:true` + `readable:false` + `sessions:[]` +
  `degraded:['sessions-root-missing']`**（HTTP **200**，面板照常渲染空态）；
- `status()` 同步改为 `ok:true, readable:false`；`getSession` 在根缺失时按「会话不存在」
  返回 `not-found`（HTTP 404），只有显式非法 sessionId 才是 400；
- 补回归测试：service 级 + HTTP 级各一条（见 §4.1 的「根缺失 = 200 空态」用例）；
- 顺手对齐 Lead 的 `orchestrator.derive()`：它读 `digest.markdown`，故 `digest()` 成功结果
  现在同时返回 `markdown`（主字段）与 `digest`（等价别名，保持既有调用方兼容）。

修复后本机重跑真实 e2e（真实母体 v2.1.0 + 真分身派生/握手/归档/审计链）：

```
PASS  GET /fang/api/sessions 200
      status=200 sessions=0 body={"ok":true,"readable":false,"sessions":[],"total":0,
      "returned":0,"limit":50,"includeArchived":false,
      "degraded":["sessions-root-missing"], ...}
…
33/33 checks passed in 30.8s
```

（此前 32/33：唯一 FAIL 即该项；其余派生→ready→归档、审计链校验、fork 回收全部 PASS。）

## 5. 降级点 / NOT ESTABLISHED（如实声明）

1. **只解第一帧 ⇒ 真机预览只有 session 头**：实测 95MB 会话首帧仅 162B/1 行。`readHead`
   与 `digest` 如实标记 `first-frame-only` + `compressed-limit`，但「继续开发」若要看到最近
   对话内容，需要后续协议扩展（按帧继续解/尾部窗口）；本任务按契约**不整文件解压**，
   NOT ESTABLISHED：跨帧历史预览。
2. **脱敏范围 deliberately 分层**：HTTP 返回的 `readHead.lines` 逐行脱敏；`getSession`/
   `digest` 的元数据（`cwd`、`workspacePath`）保留原值——继续开发需要 cwd，且这是本机
   token 鉴权的门户。若上层判定元数据也敏感，需要 Lead 明确后统一口径。
3. **脱敏是启发式**：邮箱段限长（1–64/0–253）以避免超长字符串上的 O(n²) 回溯（实测未限长时
   50KB 无 @ 行需 4.4s，限长后 24ms）；仍可能有边界误报/漏报（例如无 `@` 的密钥、非中/国际
   号码格式）。`redactions` 计数是替换次数（同一秘密多次出现多次计）。
4. **workspaceKey 编码来自实测反推**：仅用于显示/定位，不可反解；若 DSH 改命名规则，
   未登记工作区仍能列出（`workspaceKnown:false`、`workspaceId:null`），但不再能映射到
   workspace uuid/title。
5. **多 profile / 多 DSH_HOME 未支持**：只读当前进程 `DSH_HOME`；`DSH_PROFILE` 下不同
   profile 的 `fan` 数据不涉及（sessions 本身就是全局的），但若用户有多套 `DSH_HOME` 需
   切换进程，本插件不做跨根聚合。
6. **归档/置顶是只读镜像**：只读 `workspace.json` 的 `global.archivedSessionIds/
   pinnedSessionIds`，不写（写由 DSH 本体负责）；列表默认隐藏归档（`allowArchived=false`
   配置时即使请求也不列）。
7. **不暴露 HTTP `digest` 路由**：按 task-10 只实现 3 条路由；`digest` 为 service 方法，
   供母体进程内（orchestrator seed）调用。若 client 半需要在浏览器里取 digest，需要 Lead
   追加路由（本任务未擅自扩路径）。
8. **二进制/非 UTF-8 头**：头读用 UTF-8 解码（替换字符不抛），header JSON 解析失败 →
   `degraded:['header-unparsable']`，不崩溃也不伪造元数据。
9. **只读性的验证边界**：fixture 上用 `kernel digestTree` 前后深比较 + 源码静态断言无写
   API；真机未做全量 digest（会读大量文件且 95MB 会话耗时），未在真机上做写入审计
   （代码路径上不存在写调用），NOT ESTABLISHED：进程级文件访问审计 hook。
10. **大文件成本**：列表只 stat（真机 283 会话 ~12–17ms）；`readHead` 对每个会话只读
    256KiB 上限，但 `digest` 会重复一次 getSession+readHead（两次头读），当前可接受；
    若会话量级增长到数万需加索引缓存（本任务未做缓存，NOT ESTABLISHED）。

## 6. 完成定义对照（CONTRACTS-V2 §7/§8）

1. 四个交付文件 `node --check` 通过；全量 **276 tests / 275 pass / 0 fail / 1 skip**（T8 非 T10）；
   Lead 的真实 e2e **33/33 PASS**（含本次修复的 `GET /fang/api/sessions 200` 空态）。
2. `apply` 首行 roleGate('sessionCatalog')，测试覆盖 mother/fork 矩阵结果。
3. service/HTTP 方法签名与 task-10 一致（见 §3.3）；`digest()` 的 `markdown` 字段与
   orchestrator.derive() 对齐。
4. 零第三方依赖；未写 profile、未写真实 `$DSH_HOME`、未改他人文件（修复只动本写域 3 个文件：
   `session-catalog.mjs` + 本测试文件 + 本报告）。
5. 本报告 + `send_message` 向 Lead 汇报（文件、断言数、真实输出、降级点）。
