# dsh-chrome-cdp

Chrome DevTools Protocol 插件 for [DeepSeek Harness](../deepseek-harness)(DSH)。通过 [chrome-remote-interface](https://github.com/cyrus-and/chrome-remote-interface)(CRI)以 CDP 连接并操控 Chrome,提供两半能力:

- **连接面板**(Web GUI):显示连接状态、编辑连接参数(host/port/自动重连)、连接/断开/重连 socket、浏览 target 列表;
- **Agent 工具**(11 个 `chrome_*` 工具):模型在会话里直接导航、求值、抓控制台/网络、打断点调试、截图、点击、输入,以及一个发任意 CDP 命令的万能直通。

```
┌──────────────── DSH Host 进程 ────────────────┐
│  host 树 fiber                                 │
│   └─ dsh-chrome-cdp (lib/index.js)            │
│       ├─ ChromeCdpService ── CRI ──► Chrome   │
│       └─ /cdp/* RPC ◄─ Web 面板               │
│                                                │
│  preset 树 fiber (会话组合)                    │
│   └─ dsh-chrome-cdp/tools (lib/tools.mjs)     │
│       └─ 11 个 chrome_* 工具                  │
│                                                │
│  两半通过包根 bridge.mjs 单例共享连接          │
└────────────────────────────────────────────────┘
```

## 目录

- [工具一览](#工具一览)
- [安装到 DSH](#安装到-dsh)
- [Chrome 侧准备](#chrome-侧准备)
- [面板使用](#面板使用)
- [验证与排查](#验证与排查)

---

## 工具一览

11 个工具按 5 组注册,preset 配置里 `groups.<name>: false` 可整组关闭(不注册、零 schema 占用)。全部开启时约占 2K tokens 常驻上下文。

| 工具 | 组 | 说明 |
|---|---|---|
| `chrome_list_targets` | navigation | 列出 CDP 可达的 target(标签页/窗口/worker),获取 targetId;排查起点 |
| `chrome_navigate` | navigation | 导航到 URL,等待 commit + load(有界等待);默认目标或指定 targetId |
| `chrome_evaluate` | navigation | 在页面里求值 JS,支持 await Promise;**paused 时自动改走 Debugger.evaluateOnCallFrame**(同 session 的 Runtime.evaluate 在断点挂起时会永久排队) |
| `chrome_console` | diagnostics | 读取页面 console.* 与浏览器级 Log 条目(环形缓冲 300 条),游标增量拉取 |
| `chrome_network` | diagnostics | 读取网络请求生命周期(状态/大小/耗时/重定向合并,环形缓冲 500 条),游标增量拉取 |
| `chrome_debug` | debug | Debugger 控制:pause/resume/单步,在暂停的调用帧上求值(看局部变量) |
| `chrome_breakpoint` | debug | 断点管理:按 URL+行号设置(可带条件)、列出、删除;列出已解析脚本定位行号 |
| `chrome_screenshot` | interaction | 页面截图;`persist: true` 时存为 attachment 供多模态查看,否则返回截断的 base64 文本 |
| `chrome_click` | interaction | 按 CSS 选择器或视口坐标点击;trusted input dispatch(非合成 DOM 事件) |
| `chrome_type` | interaction | 向聚焦元素输入文本;ASCII 走按键事件,非 ASCII(中文等)走 `Input.insertText` |
| `chrome_cdp` | raw | 万能直通:发任意 `Domain.method` CDP 命令。逃生舱,覆盖 50 域 568 命令的长尾 |

工具输出 schema 一律声明可选 `error`/`hint` 字段:错误分支返回结构化 `{error, hint}`,不会被 `additionalProperties: false` 拒成 "invalid output"。

会话里可以这样用:
- "列出浏览器目标"
- "打开 example.com 并截图"
- "看当前页面控制台有没有 error"
- "刷新页面,列出失败的网络请求"
- "在 app.js 第 42 行下断点,点按钮,然后看暂停处的变量"

---

## 安装到 DSH

### 前置

- 任意方式安装的 `dsh` CLI(npm 全局或源码 checkout 运行均可)
- Node ≥ 20,pnpm(`dsh plugin` 底层转发给 pnpm)

### 安装插件包(host 半边 + 面板 + bundle 层)——生产环境主要手段

```bash
dsh plugin --profile web add github:xiaobai2017666/dsh-chrome-cdp
```

这是**生产环境安装的主要手段**:不写 `#` ref 时 pnpm 跟踪仓库默认分支(本仓库为 `master`)的最新提交。`lib/`、`client/` 等构建产物**随 git 提交发布**(不经 npm 发布、不挂 Release),包内没有任何 prepare/build 脚本,所以 pnpm 安装时**不执行任何构建、不触发 allowBuilds 门禁**——一条命令直接装完。`dsh plugin` 检测到包声明 `dsh.bundle`,自动把 `dsh-chrome-cdp` 追加进 `dsh.profile.bundles`;下次启动时 bundle patch 自动插入 host 行(`chrome-cdp`),面板经 `dsh.client` 声明自动挂进 Web GUI——**不需要手写任何 profile patch**。

**默认分支前进后更新**(无 pin 跟踪分支的唯一维护动作):

```bash
dsh plugin --profile web update dsh-chrome-cdp
```

因为包内没有构建脚本,更新也**不涉及 allowBuilds 轮换**——`update` 重新解析默认分支,直接跳到新 commit。

> 需要可复现/受控升级时,可以退回 pin 形式 `#<commit-sha>` 或 `#v0.1.1`(tag):spec 固定不变,更新完全受控;代价是失去"update 即跟进分支"的便利。两种形态随时可用 add 互换,lockfile 会随 add 重写。本仓库按 [Keep a Changelog](../../CHANGELOG.md) 记录每次发版变更,跟随 master 即可获得累积更新。

### 更新与卸载

```bash
dsh plugin --profile web update dsh-chrome-cdp   # 跟进默认分支最新 commit(白名单 key 轮换见步骤 1)
dsh plugin --profile web remove dsh-chrome-cdp   # 卸载:连依赖和 bundle 层一起摘
rm -rf ~/.dsh/.agent-presets/chrome-cdp-tools    # 卸载:摘 preset
```

### 开发循环

```bash
# 改 src/ 后:
npm run build                          # 三个产物
touch ~/.dsh/profiles/web/cordis.patch.yml   # host 半边热重载(~6-8s)
# preset YAML 改动即时生效;client 产物需浏览器刷新
```

- 诊断脚本:`scripts/tools-probe.mjs`(11 工具 25 用例,含断点真实命中)、`cdp-probe.mjs`/`cdp-console.mjs`(裸 CRI 驱动)
- 设计文档:[DESIGN.tools.md](DESIGN.tools.md)

## License

MIT
