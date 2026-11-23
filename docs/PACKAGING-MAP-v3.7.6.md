# v3.7.6 打包映射与来源证明

> 目的：回答 `polang233/dsh-plugin-index#616` 的复核意见——公开 tag 是**源码布局**，npm 归档是**发布布局**；两者内容差异可以逐文件、逐字节复现，不存在未公开逻辑。

## 1. 固定来源

| 项 | 值 |
|---|---|
| Git tag | `v3.7.6` |
| annotated tag object | `7a7c24d4b70c08f387cb66d5a9977841abc46a21` |
| 指向 commit | `d66da5b113f597accfd9dff394a94e2de203e98e` |
| source tree | `57c078495714b86bb6717e95d958e02eb0d0d97e` |
| 固定源码包 | `dsh-fang-3.7.6-source.tar.gz`（GitHub Release 资产） |
| 源码包 sha256 | `e1a77f6d1140d96bc4d9f645e3fc9ed3274a3654536edd86ac8d3072644b8219` |

## 2. 发布归档

| 项 | 值 |
|---|---|
| npm | `@twinsearth/fang-dsh-plugin@3.7.6` |
| tarball sha256 | `e79014b080c04eb7ca2ee0ae9f2997ee1c225361f42301490ebe4a9f74fdba00` |
| npm shasum | `1be71da91ca5a51c55e9bba451118fbe15832aa8` |
| integrity | `sha512-BpqIcsgBXpaAeTZ30wsSb7adiYtuGs5GwGX3dpRdusgMQ71Yt5HOhKZlJymM4iVwUlyXQLecEZ8a/6nDTkXwIA==` |
| 文件数 | 173 |

## 3. 构建只做两件事（`tools/release/build.mjs`）

### 3.1 文本替换

对 `package.files` 选中的 `.js/.mjs/.json/.yml/.yaml/.md/.txt` 文件：

```js
text = text.split('@local/dsh-fang').join('@twinsearth/fang-dsh-plugin')
```

这把源码里的本地包名 / loader 行名 / client module id 统一成 npm 安装名。**不改任何逻辑、不增删代码。**

### 3.2 重写 package.json 元数据

源码 `package.json` 的包名是本地开发名 `@local/dsh-fang`；发布包是
`@twinsearth/fang-dsh-plugin`。仅以下键变化：

```text
bin, bugs, description, files, homepage, name, private,
publishConfig, repository, scripts
```

`version`、`dsh`（`bundle` + `client`）、`exports`、`license`、`engines`、
`dependencies/optionalDependencies` 均保持源码值（版本同为 `3.7.6`）。

## 4. 逐文件差异（tag vs npm 归档）

以下 10 个文件内容变化，全部满足“源码按 3.1 替换后与 npm 文件逐字节相同”：

| 文件 | 原因 |
|---|---|
| `client.js` | client module id / 自引用包名 |
| `cordis.patch.yml` | 编排入口行名（orchestrator/forker/auditor/…） |
| `src/plugins/orchestrator.mjs` | 自引用包名 |
| `src/plugins/forker.mjs` | 自引用包名 |
| `src/lib/essence.mjs` | 官方/元主包名 |
| `src/lib/accelerated-fork.mjs` | 加速核路径/包名 |
| `src/lib/boot-guard.mjs` | 自引用包名 |
| `tools/fangctl.mjs` | CLI 自引用包名 |
| `README.md` | 安装命令包名 |
| `docs/PACKAGE-RENAME-v3.3.3.md` | 历史重命名说明中的包名 |

第 11 个变化文件是 `package.json`，见 3.2。

逐文件 sha256 清单：`docs/PROVENANCE-v3.7.6.json`。

## 5. 为什么 npm 里少 509 个文件

tag 有 682 个 tracked 文件，npm 只 173 个。因为 `package.json.files` 只选发布所需：

```text
src/**/*.mjs, src/**/*.js, client.js, cordis.patch.yml,
tools/** 必要 CLI, docs 选定文档, locale, icon, licenses, sdk, defaults ...
```

`test/`、`.github/`、`AGENTS.md`、大部分 `docs/`、`docker/`、`probes/` 不进入 npm。
它们是**源码仓库材料**，不是运行时逻辑；tag 中完整保留。

## 6. 复核命令（任何人可重跑）

```powershell
git clone https://github.com/TwinsEarth/dsh-fang.git
cd dsh-fang
git checkout v3.7.6
node tools/release/build.mjs --skip-preflight
# 解包 npm 归档，逐文件按 @local/dsh-fang -> @twinsearth/fang-dsh-plugin 映射后比对
```

`docs/PROVENANCE-v3.7.6.json` 给出每个变化文件的 source/npm sha256；映射后应完全一致。
npm tarball 的字节 sha256 受 tar 时间戳影响，**以文件内容映射为准**；本次发布归档 sha256 为
`e79014b0…`，与 Release 资产一致。

## 7. 结论

- tag `v3.7.6` = 可审源码；
- npm `3.7.6` = 同一份源码按公开规则改名/筛选后的安装包；
- 不存在 tag 之外的运行时逻辑；
- 如仍需“安装包逐字节等于 tag”，只能把构建后的 `dist/npm/package` 再提交为一个 tag（会引入生成物），不建议；本映射 + 源码包已满足同版可追溯。
