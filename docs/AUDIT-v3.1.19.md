# AUDIT v3.1.19

范围：品牌文案（并入原 3.1.18）+ 分身 Web 界面收敛 + 关闭二次确认。

## 变更清单

| 项 | 位置 | 判定 |
|---|---|---|
| 插件主名称 | `locale/zh.json` `meta.title` | 瓮城：DSH的第一台虚拟机！ |
| 插件简介 | `locale/zh.json` `meta.description` | 三类用户定位文案（中文 298 字） |
| 英文文案 | `locale/en.json` | Fangcheng: DSH’s First Virtual Machine! |
| 分身隐藏「插件」入口 | `client.js` `mountForkUiLocks()` | hidden + `display:none !important` + MutationObserver |
| 分身「启动」无操作 | 同上 capture 阶段 | `stopImmediatePropagation` + 错误气泡隐藏 |
| 元主/分身关闭确认 | `client.js` `mountCloseConfirm()` | `beforeunload` + `returnValue` |
| 母体不受影响 | 两个 mount 均按 `detectWebRole()` 分支 | mother 不隐藏、不拦截 |

## 验证证据

```text
npm test  : 1083 tests / 1072 pass / 0 fail / 11 skip
jsdom     : client-fork-locks(3) + client-close-confirm(2) 全绿
real fork : 侧栏「插件」display:none / hidden=true；徽标 分身·fork
```

## 兼容性

仅前端呈现层与文案；路由、契约、协议与 3.1.17 完全兼容。
