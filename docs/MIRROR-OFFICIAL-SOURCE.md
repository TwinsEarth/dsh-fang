# MirrorUpgrade 官方源 adapter（manifest v1）

## 目的

`MirrorManager` 之前 `officialSource === null`，升级永远返回 `official-source-unavailable`。
现在接入一个最小可用的 manifest 协议 adapter，可配置真实源。

## 协议

```http
GET <baseUrl>/manifest.json      （远程必须 https；loopback 允许 http）
Authorization: Bearer <officialSourceToken>   （可选）
→ {
    "version": "3.2.0",
    "files": {
      "package.json": "{\"name\":\"profile\"}",
      "cordis.patch.yml": "insert: []\n"
    }
  }
```

- `getLatestVersion()` 返回 manifest.version；
- `download(version, staging)`：
  - 校验 manifest.version 与请求版本一致；
  - `files` 的每个相对路径都做安全校验（拒绝绝对路径、`..`、UNC、NUL）；
  - 写到 staging，再由 MirrorManager 原子 swap。

## 配置

```yaml
- id: fang-orchestrator
  config:
    officialSourceUrl: 'https://mirror.example.com/fang'
    officialSourceToken: ''        # 可选，不写日志/状态
```

- 留空 = 无官方源（保持显式降级，不假装成功）；
- 测试/嵌入仍可用 `apply(ctx, { officialSource })` 注入对象。

## 升级成功后的红色 restart ticket

升级成功（`ok:true`、无 compat 失败、版本变化）后自动产生：

```text
red ticket：镜像升级完成，需重启宿主
actions: confirm_restart / later
```

`confirm_restart` 会走 decision-center 内建执行器 → restart-guard.request（仍受三重门禁约束）。

## 测试

- `test/mirror-official-source.test.mjs`：URL/路径安全、manifest 解析、版本不匹配、路径逃逸；
- `test/orchestrator.test.mjs`：
  - `officialSourceUrl manifest adapter performs a real upgrade`（真实下载→swap→compat ok→红 restart ticket）；
  - `fake officialSource + failing compat gate yields a compat decision ticket`。

## 边界

- 这是 **manifest 协议**，不是某个官方商店的协议；接真实官方源需要对方提供 manifest（或写一个 adapter 生成它）；
- 不负责签名/校验和；tarball/zip 源需要另写 adapter（zip-slip 防护已有 `safeRelativePath` 可复用）；
- 运行中宿主仍是旧 bundle。
