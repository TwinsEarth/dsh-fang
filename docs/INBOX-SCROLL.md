# 收件箱滚动修复

生效版本：`v3.3.10`

## 现象

- 鼠标滚轮无法滚动收件箱；
- 没有可拖动的滚动条。

## 原因

`.fang-inbox` 是 flex column，但 `.fang-inbox-body` 只写了 `flex:1 1 auto; overflow:auto`。
在 Electron/宿主 body 被 `overflow:hidden` 锁定时，body 的高度约束和滚轮落点都不稳定；
同时旧 CSS 没有显式滚动条样式。

## 修复

```css
.fang-inbox-drawer { height:100vh; height:100dvh; overflow:hidden }
.fang-inbox-body { flex:1 1 0; height:0; min-height:0;
  overflow-y:scroll; overflow-x:hidden; overscroll-behavior:contain;
  scrollbar-gutter:stable; scrollbar-width:thin }
.fang-inbox-body::-webkit-scrollbar { width:12px }
.fang-inbox-body::-webkit-scrollbar-thumb { ... }
```

另加 wheel 兜底：滚轮事件显式转给 `.fang-inbox-body`，避免宿主 body 抢走；
AI 区限制 `max-height:32vh; overflow:auto`，不再把列表挤成 0 高。

## 验证

- `client-inbox-dom` 20 pass；
- 源码测试断言 body 滚动容器/滚动条/ wheel 兜底存在。
