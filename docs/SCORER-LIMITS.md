# fang-scorer 已知局限与加固记录

## 1. C3 服务宽限

规则（`scoreScan`）：

```text
C3 信号携带 services 列表：
  services.length <= 8 且不含 sessions/registry/loader
    → C3 权重归零（service-grace）
  否则
    → 保留权重（service-risk）
```

为什么这样设计：少量 DSH 服务是正常插件形态，直接计风险会造成大量误报；`sessions/registry/loader` 以及服务数量膨胀才暴露更大的能力面。

已知绕过：插件可以通过注册 >8 个无意义服务，或加入一个 `sessions/registry/loader` 名称，让权重恢复。这是当前规则的边界，不是完整的安全裁决。

结果现在显式带：

```js
c3: { count, core, graced, applied }
```

并在 `reasons` 中区分：

```text
C3-...:C3-service-grace
C3-...:C3-service-risk(count=N,core=false)
```

调用方/审计不能只看 grade，应同时看 `c3`。

## 2. hot path 不审计

`scoreSource` 默认不写审计，因为 umbrella 的插件评分缓存是热路径，每次命中都写账本会放大 I/O。

审计落点：

- `scoreDir`：一次目录评分一条 `AUDIT.SCORE`；
- `scoreIntent`：动作意图一条；
- umbrella 的 `onPluginScored`：插件评分（缓存 miss）一条。

需要审计 hot path 的调用方可显式：

```js
service.scoreSource(src, pkg, { audit: true })
```

`opts.audit` 默认 false；开启后写 `scope:'source'` 的 `AUDIT.SCORE`。

## 3. 分词器不是 AST

`src/plugins/imports.mjs` 是零依赖手写 tokenizer：

- 跳过注释和字符串；
- 识别模板串及 `${}`；
- 提取 import/export-from/require/dynamic-import。

局限：

- 正则字面量不是独立 token，可能影响上下文判断；
- 特殊语法/宏/生成代码可能误判；
- `import` 出现在非导入上下文可能产生 warning 或漏判；
- 无法做作用域/调用图分析。

处理方式：保留 `warnings`，在评分上通过 `__parseErrors` 进入 `degraded`，A/B 降 C；不把 warning 静默当作安全。

## 4. 只扫 import 层、只扫入口文件

- 不扫描 `exec/spawn` 的实际调用点，因此变量/反射/间接 re-export 可能漏；
- 只扫入口文件，不扫传递依赖、native addon、运行时加载代码；
- 结果 `coverage:'import-only'`，这是明确声明，不是完整安全扫描。

加固方向（尚未实现）：

```text
fast: 入口 + import（当前）
deep: 入口 + 目录内全部 .js/.mjs/.cjs + 调用层 + native .node 标记
```

deep 用于 promote/审批等低频关键路径，必须输出 `scannedFiles/skippedFiles/truncated/degradedReasons`。

## 5. hotReload:false 是声明式 veto

唯一硬 veto 是：

```js
pkg.dsh.hotReload === false
```

不声明就不会触发。恶意包可省略或声明 true；因此：

- 热更新路径应要求显式 `dsh.hotReload === true`；
- 缺失声明拒绝热更新（而不是只在 false 时拦）；
- router 对 false 继续 deny。

## 6. allowlist 不参与评分

`allowlist` 只写入 `policy`：

```js
policy.allowlist
policy.allowlistUsedForScoring = false
```

它不降低静态风险分；healer 的 G5 依赖门禁读取同一配置。不要用 allowlist 洗白风险分。

## 7. 临时 thresholds 只能收紧

服务层现在接受 `opts.thresholds`，但与配置取 `min`：

```js
a = min(configured.a, requested.a)
...
```

调用方只能收紧、不能放宽；`basis.thresholds` 反映实际生效分档。

## 8. 入口路径 containment（已修）

`resolvePluginFile(root, candidate)`：

- 拒绝绝对路径；
- 拒绝 `..` 逃逸；
- `realpath` 后必须仍在 root 内；
- 必须是普通文件。

`scoreDir` 与 `healer.readModel` 都使用它；恶意 `main: "../../secret.js"` 返回 `no-entry-file / E`，G2 fail。符号链接指向目录外同样被拒绝。

## 9. 结论

当前评分是**静态风险提示 + 证据**，不是唯一门禁。要提升安全强度，优先做：

1. `deep` 全文件 + 调用层扫描；
2. 未声明 `hotReload` 拒绝热更新；
3. 动态 import 非字面量升级为信号；
4. 在 promote/approval 路径强制 deep。

## 10. 三个不可妥协的契约

### 10.1 S 是数学，grade 是阈值

`scoreScan` 先算 S，再用传入的 bands 映射 grade：

```js
S = 加权维度和
grade = gradeOf(S, bands)
```

母体默认 `20/40/60/80`，分身更宽 `25/45/65/85`。同一份源码 S=22：

```text
mother: 22 > 20 → B
fork:   22 ≤ 25 → A
```

测试：`test/scorer.test.mjs` 的 threshold fork / per-call environment 用例。

### 10.2 import 层不是完整安全审计

`importsToSignals` 明确返回：

```js
coverage: 'import-only'
```

`scoreSource`/`scoreDir`/`evidence` 都保留该字段。这是诚实声明，不是“扫了 import 就安全”。

测试：`test/scorer.test.mjs`、`test/healer.test.mjs` 的 coverage 断言。

### 10.3 母体晋升必须用 mother 阈值重算

`orchestrator.promoteTask`：

```js
const forkAssessment = ... // 分身评分：仅参考
const motherAssessment = scorer.scoreDir(workDir, null, { environment: 'mother' })
if (motherAssessment.grade === 'D' || motherAssessment.grade === 'E') reject
```

- 分身自己的评分不能作为最终生产判据；
- router 只接收 motherAssessment；
- forkAssessment 只进结果/审批 impact，不参与放行。

测试：`test/orchestrator.test.mjs` 的
`promoteTask re-scores with MOTHER thresholds and copies to staging`。
