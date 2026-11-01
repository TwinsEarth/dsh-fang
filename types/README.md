# 保护伞 · TypeScript 参考实现（v2.7.7）

> 运行时权威实现是 **`src/lib/umbrella.mjs` + `src/plugins/umbrella.mjs`**（同目录 `docs/UMBRELLA.md` 是它的契约）。
> 本目录是**可编译镜像**：语义对齐 v2.7.6，用于类型消费、跨语言移植，以及让「评分规则」本身成为可检查的代码。

## 为什么它值得存在，又不随包发布

- 运行时是纯 `.mjs`，仓库 CI **零第三方依赖**（`.github/workflows/ci.yml` 头注释写死了这条）；
  加 TypeScript 依赖会破坏那条约束，所以 `types/` **不进 `package.json files`**（tarball 里没有它）。
- 但它必须能被验证，而不是"看起来能编译"：本目录刻意**不 import 任何 `node:` 内建模块**，
  文件系统 / 时钟 / 审计全部走注入端口，因此任何人都能用一个 `tsc` 编译它。

```bash
# 任选一种编译器来源
npm i -D typescript
npx tsc -p types/tsconfig.json

# 或者不污染仓库（任意路径的 tsc.js）
DSH_FANG_TSC=/abs/path/to/typescript/lib/tsc.js node tools/release/typecheck.mjs
```

`node tools/release/typecheck.mjs` 的行为是**诚实的三态**：找到编译器就真编译（失败非零退出）；
找不到就打印 `SKIP` 与安装方法、退出码 0——它永远不会在没有编译的情况下说 `PASS`。

编译开关（`types/tsconfig.json`）：`strict`、`exactOptionalPropertyTypes`、
`noUncheckedIndexedAccess`、`noImplicitOverride`、`noFallthroughCasesInSwitch`、
`noUnusedLocals`、`noUnusedParameters`、`noImplicitReturns`、`isolatedModules`、`noEmit`。

## 文件

| 文件 | 职责 | 运行时对应 |
|---|---|---|
| `types.ts` | 全部类型、四色词汇、两张下限表 | `src/lib/umbrella.mjs` 的常量与 JSDoc 形状 |
| `paths.ts` | 纯字符串路径归一化 / 包含判定（`isWithin`） | `normalizePolicy` 里的 `path.resolve` 部分 |
| `cache.ts` | 通用 LRU（命中重插、`peek` 不刷新） | `createUmbrella` 里的 `Map` 缓存 |
| `plugin-scorer.ts` | 插件评分：指纹缓存 + 失败往坏里判 | `assessPlugin` / `cacheStats` / `invalidate` |
| `action-scorer.ts` | 动作评分：15 条规则 + 下限抬高 + 决策矩阵 | `baseLight` / `effectiveLight` / `decide` |
| `umbrella.ts` | 门面：两个出口合流、决策 + 一条审计 | `createUmbrella()` |
| `index.ts` | 公共出口 | 服务面 `fangUmbrella` |

## 宿主适配（Node 侧只在这一层碰 IO）

```ts
import type { FingerprintPort, ScorerPort, ActionPolicyInput } from './types/umbrella/index.js'
import { Umbrella } from './types/umbrella/index.js'
import { statSync, } from 'node:fs'
import { createHash } from 'node:crypto'

const fingerprints: FingerprintPort = {
  fileMtime(file) {
    try { return String(statSync(file).mtimeMs) } catch { return null }
  },
  hash(text) { return createHash('sha1').update(text, 'utf8').digest('hex') },
}

// 运行时直接传 fangScorer 服务（方法不依赖 this）
const scorer: ScorerPort = {
  scoreSource: (source, pkg, opts) => fangScorer.scoreSource(source, pkg, opts),
  scoreDir: (dir, manifest, opts) => fangScorer.scoreDir(dir, manifest, opts),
}

const umbrella = new Umbrella({
  scorer,
  fingerprints,
  policy: (): ActionPolicyInput => ({
    bufferRoot: bufferKeeper.dir,           // buffer-keeper 的实时 root
    allowPaths: ['/abs/allow'],
    networkAllowlist: ['api.example.com'],
  }),
  caseInsensitive: process.platform === 'win32',
  audit: (record) => auditor.append('umbrella-decision', record),
})

const decision = umbrella.decideAction(
  { tool: 'write', target: { kind: 'path', value: '/abs/sandbox/a.txt' }, pluginId: 'demo' },
)
// decision.decision: 'allow' | 'mark' | 'ask' | 'delegate' | 'deny'
```

## 与设计稿的差异（都是刻意的）

| 设计稿 | 本实现 | 原因 |
|---|---|---|
| `PluginScorer` 自己实现信号加权（bands 15/40/70） | 通过 `ScorerPort` 复用运行时 `fangScorer`（母体 20/40/60/80、分身 25/45/65/85） | 仓库只允许一份评分数学；抄一份必然漂移 |
| 缓存键 `pluginId@version` | 身份 + 指纹（入口 `mtimeMs` / inline 源码 hash） | 热更新可以不改版本号，版本键会命中过期等级 |
| `fiberHistory` 变化触发重算 | 由 `fingerprints` 端口决定失效（与运行时一致） | 评分上下文不进缓存键，避免同一插件多份缓存 |
| 循环依赖的规则顺序（破坏性优先） | `dsh-lifecycle` 先于 `destructive-command` | 宿主动作要委托 restart-guard，而不是"问用户" |
| 9 条规则 | 15 条（补 `write-in-buffer`、`exec-read-only`、`exec-side-effect`、`write-production`、`network-allowlisted`） | 设计稿没覆盖这些格；落绿/落黄都会误导 |
| `assessPluginsBatch` 用 `Promise.all` | 同步 `map` | 动作发生前必须拿到等级；异步批量会留下"评分未回先放行"的窗口 |
| `ActionScorer.assess` 自己查插件等级 | 由门面把缓存等级作为 `cachedGrade` 传入 | 评分器不持有另一个评分器的状态，依赖方向单一 |
| 直接 `import path` | `paths.ts` 纯字符串实现 | 无 Node 依赖才可被任意宿主编译/复用 |

## 边界（与文档一致，不夸大）

- **不做 realpath**：junction / 符号链接可让字面路径在缓冲区内、真实路径在外；需要时由调用方传入已解析路径。
- **不做 UNC 规范化**：`\\server\share` 按普通字符串处理。
- **无强制拦截**：与运行时一样，这是决策库；`ask`/`delegate` 的落点（approver / restart-guard）由调用方投递。
- **TS 不是运行时**：`.mjs` 才是。若两者出现分歧，以 `.mjs` + `docs/UMBRELLA.md` 为准，并应在本目录同步修正。
