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

插件通过 **`dsh plugin`(profile 机制)** 从 GitHub 安装,分三步:安装插件包 → 安装 agent preset → 重启。无需 clone 本仓库,无需改 harness 源码。

### 0. 前置

- 任意方式安装的 `dsh` CLI(npm 全局或源码 checkout 运行均可)
- Node ≥ 20,pnpm(`dsh plugin` 底层转发给 pnpm)
- `dsh` 在 PATH 时命令写作 `dsh ...`;从源码 checkout 运行时写作 `pnpm --dir /path/to/deepseek-harness dsh ...`

### 1. 安装插件包(host 半边 + 面板 + bundle 层)——生产环境主要手段

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

验证(不启动):

```bash
dsh --profile web --dump-config | grep -B2 -A3 'chrome-cdp'
# 应看到 "# == dsh-chrome-cdp" 层与 id: chrome-cdp 的 host 行
```

### 2. 安装 agent preset(工具可见性)

Web 会话只有经 agent preset 才能看到工具;preset 不走 profile/bundle 机制,装到用户 preset root(`~/.dsh/.agent-presets/`)。本仓库已固化模板,两条 curl 即可:

```bash
mkdir -p ~/.dsh/.agent-presets/chrome-cdp-tools
curl -fo ~/.dsh/.agent-presets/chrome-cdp-tools/agent.cordis.yml \
  https://raw.githubusercontent.com/xiaobai2017666/dsh-chrome-cdp/main/presets/chrome-cdp-tools/agent.cordis.yml
curl -fo ~/.dsh/.agent-presets/chrome-cdp-tools/preset.yml \
  https://raw.githubusercontent.com/xiaobai2017666/dsh-chrome-cdp/main/presets/chrome-cdp-tools/preset.yml
```

preset YAML 每次发现都重读,**即时生效、无需重启**。(本地有仓库 clone 时用 `cp` 代替 curl 同样可以。)

> preset 里所有 `@deepseek-ai/*` 包都从 harness 安装侧解析(`~/.dsh/profiles/node_modules` fallback),无需用户安装它们。

### 3. 重启并使用

**必须重启 dsh web**——host 进程在启动时固化模块解析视图,install 后不重启,preset 挂载会报 `Package subpath './bridge' is not defined by "exports"`,GUI 表现为选了 preset 又弹回默认。

新建会话 → preset 选「Chrome CDP 工具」→ 对模型说"列出浏览器目标"。

### 更新与卸载

```bash
dsh plugin --profile web update dsh-chrome-cdp   # 跟进默认分支最新 commit(白名单 key 轮换见步骤 1)
dsh plugin --profile web remove dsh-chrome-cdp   # 卸载:连依赖和 bundle 层一起摘
rm -rf ~/.dsh/.agent-presets/chrome-cdp-tools    # 卸载:摘 preset
```

### 源码开发(维护者)

改 `src/` 后 `npm run build`,**产物(`lib/`、`client/`)会随代码一起提交**——它们就是对外发布形态,确保与 `src/` 同步。开发热重载循环(改完想立刻看效果)仍可走本地 link:在 harness 的 `apps/cli/package.json` 加 `"dsh-chrome-cdp": "link:/path/to/dsh-chrome-cdp"` 后 `pnpm install --filter @deepseek-ai/dsh`;或改完直接推,装好的 profile 用 `dsh plugin --profile web update dsh-chrome-cdp` 跟进。正式安装请用上面的 `dsh plugin` 流程。

---

## Chrome 侧准备

### Windows Chrome(WSL2 环境)

Chrome 136+ 对**默认用户数据目录**忽略 `--remote-debugging-port`(防恶意程序窃取 cookie),必须用隔离 profile:

```bash
/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command "
Stop-Process -Name chrome -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-Process 'C:\Program Files\Google\Chrome\Application\chrome.exe' \
  -ArgumentList '--remote-debugging-port=9222','--user-data-dir=C:\temp\chrome-cdp-profile'
Start-Sleep -Seconds 5
(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:9222/json/version').Content"
```

WSL2 镜像网络下 Windows Chrome 的 `127.0.0.1:9222` 从 WSL 直连可达,面板 host 填 `127.0.0.1`、port `9222` 即可。

> 隔离 profile 不带你的书签/登录态。要调试已登录站点,在该实例里重新登录。

### 不要用新版设置页的 "Remote debugging" 开关

Chrome 新版设置里的远程调试开关(随机端口,如 62530)**不是**传统 CDP 端口:它的 HTTP discovery 端点(`/json/version`、`/json/list` 等)全部 404(WSL 与 Windows 侧皆然),CRI 无法发现 target,本插件用不了。必须走上面的 `--remote-debugging-port` 启动参数。

### Linux/macOS Chrome

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-cdp-profile
```

---

## 面板使用

DSH Web GUI 侧栏的 Chrome CDP 面板:

- **状态卡**:连接相位(disconnected/connecting/connected/failed)、Chrome 版本、target 数、断开原因
- **参数编辑**:host / port / autoReconnect / reconnectDelaySeconds;保存后 live 参数变化会自动重连
- **操作**:Connect / Disconnect / Reconnect / **Ensure Chrome(检测并启动)**;socket 意外掉线按配置自动重试

**Ensure Chrome 按钮**(未连接时可用):探测当前 host:port 是否已有可 CDP 连接的 Chrome——已通则不动浏览器;否则**直接另起一个**带 `--remote-debugging-port` 的独立实例(隔离 user-data-dir,与已打开的 Chrome 互不干扰,**默认不关闭你正在用的 Chrome**)。面板上有一个「启动前先关闭正在运行的 Chrome」勾选项:勾上并点击时才走接管式流程(检测 → 关闭 → 用隔离 profile 重启,点击时有确认弹窗,未保存的页面状态会丢失)。端点就绪后自动连接。
- **target 列表**:当前可达的页面/worker

参数持久化在用户设置文档(`chrome-cdp` namespace),重启后保留。

---

## 验证与排查

### 快速自检

```bash
# 插件产物可加载、bridge 单例共享
cd /home/chensg/code/dsh-chrome-cdp && node -e "
Promise.all([import('dsh-chrome-cdp/bridge'), import('./lib/tools.mjs')]).then(([b, t]) => {
  b.registerHostBridge({ mark: 42 })
  console.log('bridge shared:', t.hostBridge.current?.mark === 42)
})"

# 端点可达
curl --noproxy '*' -s http://127.0.0.1:9222/json/version

# 面板通道(host 起着时)
curl --noproxy '*' -s -X POST http://127.0.0.1:3080/cdp/status \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"s","method":"status","payload":null}'

# 11 工具全链路(独立于 DSH;需要 Chrome 端点已开)
node scripts/tools-probe.mjs     # 期望 25/25 passed
```

### 常见故障

| 症状 | 根因 | 处置 |
|---|---|---|
| 新建会话选 preset 后 **GUI 卡死**(CPU 飙满) | preset 里 group id 与子 entry id **同名**,loader parent 链成环 → 同步死循环冻结事件循环 | 组 id 用 `chrome-cdp-group`,子 entry 用 `chrome-cdp-tools`,必须不同名 |
| 选了 preset **弹回默认**(标准模式) | host 进程启动早于插件 install,`./bridge` export 不在其解析视图里;select 挂载失败被拒 | 重启 `pnpm dsh web` |
| 工具报 `chrome-cdp host half not loaded` | host 行没挂(profile patch 缺失/被禁)或 bridge 单例被劈开 | 确认 cordis.patch.yml 有 host 行;两产物必须以 `dsh-chrome-cdp/bridge` 自引用共享单例 |
| 工具结果报 `invalid output: value.error is not a declared property` | strict schema 未声明错误分支的 `error`/`hint` 字段 | 保持 `obj()` 里合并可选 `error`/`hint` 的实现 |
| `/json/version` 404 / 连不上 62530 | 用了新版设置开关(非 CDP 端口) | 改 `--remote-debugging-port=9222` + 隔离 user-data-dir 启动 |
| 9222 没监听但 Chrome 带了参数 | Chrome 136+ 默认 profile 忽略调试端口 | 加 `--user-data-dir=C:\temp\chrome-cdp-profile` |
| `chrome_evaluate` 在断点处挂死 | paused 时同 session 的 Runtime.evaluate 永久排队 | 已内置守卫自动改走 evaluateOnCallFrame;别绕过工具直发 Runtime 命令 |

### 开发循环

```bash
# 改 src/ 后:
npm run build                          # 三个产物
touch ~/.dsh/profiles/web/cordis.patch.yml   # host 半边热重载(~6-8s)
# preset YAML 改动即时生效;client 产物需浏览器刷新
```

- 诊断脚本:`scripts/tools-probe.mjs`(11 工具 25 用例,含断点真实命中)、`cdp-probe.mjs`/`cdp-console.mjs`(裸 CRI 驱动)
- 设计文档:[DESIGN.tools.md](DESIGN.tools.md)

## 仓库结构

```
src/index.ts          host 入口:服务 + /cdp RPC + 设置
src/cdp-connection.ts CRI 连接管理(重连/参数/target 轮询)
src/chrome-launcher.ts Chrome 实例检测 + CDP 重启(面板 Ensure 按钮的宿主实现)
src/tools/            工具半边
  schema.ts           11 个 ToolSpec(纯数据)
  dispatch.ts         路由分发 + paused 守卫 + 选择器定位
  targets.ts          flat session 管理(targetId→sessionId)
  capture.ts          console/网络环形缓冲 + 游标
  debugger.ts         Debugger 域状态机(断点/步进/帧求值)
  serialize.ts        RemoteObject 序列化(预算截断)
  index.ts            preset 入口(defineTool 注册)
src/client/           Web 面板(React,CSS Modules)
bridge.mjs            包根单例(两产物共享,勿打包)
cordis.patch.yml      host 行插入声明(bundle patch)
lib/、client/         构建产物,随 git 提交发布(安装零构建)
presets/chrome-cdp-tools/  agent preset 模板(装到 ~/.dsh/.agent-presets/)
scripts/              探针与诊断脚本
DESIGN.tools.md       工具层设计文档
```

## License

MIT
