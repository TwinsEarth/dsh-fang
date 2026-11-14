# RELEASE WAIVER — v3.3.4

## 跳号原因

`v3.3.3` 的代码已合并，但 npm 发布被 registry 拒绝：

```text
HTTP 402 {"error":"You must sign up for private packages"}
```

根因：新建 scoped 包默认按私有处理，而自定义 REST 发布体缺少 `access: "public"`。
`v3.3.3` **没有成功发布到 npm，也没有 GitHub Release**；其 tag 已删除，不复用该版本号。

## 处置

- 修复发布访问：`publish-npm.mjs` 增加 `access: "public"`，staged package 增加
  `publishConfig.access = "public"`；
- 主城门禁增加 `package: publish access public`，防止回归；
- 版本按补丁号前进到 `v3.3.4`，内容 = v3.3.3 的包改名 + 队列子插件默认关闭 + 本修复。

## 影响

- 上一已发布版本：`v3.3.2`；
- 本版：`v3.3.4`；
- 跳过的 `v3.3.3` 从未发布，不作为用户可见版本。

用户确认记录：用户要求 npm 改名为 `@twinsearth/fang-dsh-plugin`，并明确 3.3.3 因发布失败不能复用 tag；本 waiver 仅用于机器门禁的版本阶梯。
