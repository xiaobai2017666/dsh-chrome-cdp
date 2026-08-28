# dsh-chrome-cdp 工具层设计文档

> 版本:v1.1(P0-P1 已实施并验证;面板侧另有 Ensure Chrome 按钮:探测端点→检测运行实例→带 CDP 重启,见 README)
> 前置:面板插件已交付并验证(连接管理 + 参数编辑 + 状态轮询)。
> 本文档规划:在既有 CDP 连接之上,为 agent(模型)暴露一套可输入指令操作浏览器的 tools。

---

## 1. 目标与非目标

### 目标

1. **模型可调用的 CDP 工具**:agent 通过工具发出指令,经既有 `/cdp` 通道驱动浏览器(导航/求值/截图/输入/DOM 等)。
2. **指令直通能力**:参考 [chrome-remote-interface protocol.json](https://github.com/cyrus-and/chrome-remote-interface/blob/master/lib/protocol.json)(50 域 / 568 命令 / 1.2MB),提供一个"直接发任意 CDP 呫令"的万能工具,不逐命令建工具。
3. **复用既有基础设施**:连接管理、自动重连、状态快照全部复用 `ChromeCdpService`,工具层只做"指令路由 + 结果整形"。
4. **与面板协同**:面板上能看到工具对浏览器执行的操作(目标切换等)。

### 非目标(明确排除)

1. **不做每个 CDP 命令一个工具**(568 个命令 × schema 会撑爆模型上下文;`Page.navigate` 这类高频命令走万能工具即可)。
2. **不做事件实时推送到模型**(不抢占对话流;console/网络消息走"缓冲 + 游标拉取",见 §3.4)。
3. **不做网络拦截/请求重放**等高级场景(Network 域命令仍可通过万能工具调用,但不提供专门的拦截语义)。
4. **不改变现有面板行为**(工具层是纯增量)。

---

## 2. 现状盘点(已交付资产)

| 资产 | 位置 | 说明 |
|---|---|---|
| `ChromeCdpService` | `src/cdp-connection.ts` | CRI 客户端管理:connect/disconnect/autoReconnect/status snapshot/targets/version |
| `/cdp` RPC 通道 | `src/index.ts` | 5 端点:status/targets/connect/disconnect/setParams,client 侧 store 轮询消费 |
| Settings 命名空间 | `src/index.ts` | `chrome-cdp` namespace,`CdpParamsSchema` |
| 面板 UI | `src/client/` | sidebar footer 弹层 + overlay 状态药丸 |
| 工具注册机制 | DSH `@deepseek-ai/dsh-tools` | `defineTool({name, description, parameters, output, execute, isConcurrencySafe?})` + `ctx.tools.register()` |
| Agent preset | `apps/cli/config/agent-presets/*` | Web 会话工具必须经 preset 挂载(host 层的 `tools` 注册对 web agent 不可见——web bundle 把 `tool-*` 行 disabled,移入 preset) |

**关键约束(调研确认)**:

- `dsh-tools` 已发布于 npm(`@deepseek-ai/dsh-tools@0.1.1-rc.2`),out-of-tree 可用,`defineTool` 导出可用。
- 截图要走 `ctx.attachments.saveImages([{data, mediaType}])` → `ImageAttachmentRef` → `ImageBlock`(assistant 内容),才能被多模态模型消费。
- `ToolDefinition.output.render(args, value) → ContentBlock[]` 负责模型可见输出;canonical value 保持 lossless JSON。
- `isConcurrencySafe`:CDP 命令天然串行化(CRI 客户端单连接),全部工具标记为非并发安全(排他,形成 barrier)。
- 工具需进 agent preset(`~/.dsh/agent-presets` 或 profile 内 overlay)才对 web 会话可见。

---

## 3. 工具集设计

设计原则:**薄常用命令 + 强万能直通**。

### 3.1 工具清单(11 个)

| 工具名 | 入参要点 | 行为 | 输出要点 |
|------|---|---|---|
| `chrome_list_targets` | 无 | 列出 CDP 目标(页面/worker) | `{targets: [{id, type, title, url}]}` |
| `chrome_navigate` | `url`, `targetId?` | 导航;未指定 target 时用当前活跃 page | `{frameId, loaderId, errorText?}` |
| `chrome_evaluate` | `expression`, `awaitPromise?`, `targetId?` | Runtime.evaluate | `{type, value, className?}` — 求值结果序列化 |
| `chrome_screenshot` | `format?`(png/jpeg), `quality?`, `targetId?`, `save?` | Page.captureScreenshot | `{image: ImageBlock}`(save=true 时持久化为附件)或 base64 文本 |
| `chrome_click` | `selector` 或 `backendNodeId`/`x,y`, `targetId?` | DOM.querySelector → DOM.resolveNode → Input.dispatchMouseEvent | `{clicked: bool, tag, id?, class?}` |
| `chrome_type` | `text`, `selector?`, `x,y?`, `targetId?` | focus + Input.dispatchKeyEvent 逐键派发 | `{typed: bool}` |
| `chrome_console` | `targetId?`, `level?`, `text?`, `cursor?`, `limit?` | 拉取环形缓冲的 console 消息(Runtime.consoleAPICalled + Log.entryAdded) | `{entries: [{seq, time, level, text, url?, line?}], nextCursor}` |
| `chrome_network` | `targetId?`, `url?`, `resourceType?`, `minStatus?`, `cursor?`, `limit?` | 拉取环形缓冲的请求生命周期记录(容量 500,合并重定向) | `{requests: [{seq, requestId, url, method, status, size, duration, fromCache}], nextCursor}` |
| `chrome_debug` | `action`(status/pause/resume/step_into/step_over/step_out/eval), `expression?`, `frame?`(帧序号,默认 0), `targetId?` | 调试控制:跟踪 `Debugger.paused` 状态机;eval 走 `evaluateOnCallFrame` | `{paused, reason?, callFrames[], hitBreakpoints[]}` 或帧上求值结果 |
| `chrome_breakpoint` | `action`(list/set/remove/scripts), `url?`, `line?`, `column?`, `condition?`, `id?`, `targetId?` | 断点管理:`setBreakpointByUrl` / `removeBreakpoint`;scripts 列已解析脚本(scriptParsed 登记) | `{breakpoints: [{id, url, line, condition?}]}` 等 |
| `chrome_cdp` | `method`(如 `Page.navigate`), `params?`, `sessionId?`, `targetId?` | **万能直通**:在 browser-level client 上发任意 CDP 命令;带 `sessionId` 时走 flat session | 原样返回 CDP result(去 binary 字段) |

### 3.2 为什么是这 11 个

- `chrome_list_targets` / `chrome_navigate` / `chrome_evaluate` / `chrome_screenshot` 是浏览器自动化四大件,包一层意图级 schema 比让模型拼 `Page.navigate {url}` 更省 token、更稳。
- `chrome_click` / `chrome_type` 是"用 CDP 模拟真实输入"的最小封装(3 个 DOM 命令 + Input 派发的组合),模型直接拼要 5+ 次万能调用,封装成一次。
- `chrome_console` / `chrome_network` 是排查型刚需:环形缓冲 + 游标拉取(§3.4),"列表/过滤"用意图工具,按 id 深取(`Network.getResponseBody` 等)走 `chrome_cdp` 直通。
- `chrome_debug` / `chrome_breakpoint` 是断点调试对:调试**有状态**(paused 事件、调用帧、evaluateOnCallFrame),万能直通表达不了状态跟踪;且一次"命中→查变量→单步"是 5+ 次直通的编排,封装成一对工具。
- `chrome_cdp` 是逃生舱:protocol.json 全集都在身后(Emulation/CSS/Network/Storage/Fetch…),长尾命令一律走它,不必逐个建工具。
- **不建** `chrome_wait_for` / `chrome_scroll` 等衍生:evaluate + 一行 JS 即可表达,避免工具膨胀。

### 3.3 万能直通 `chrome_cdp` 的安全阀

- `method` 校验:`/^(Browser|Page|DOM|Runtime|Input|Network|Emulation|CSS|Target|Overlay|Storage|Debugger|Console|Profiler|HeapProfiler|DOMSnapshot|DOMStorage|Database|HeadlessExperimental|IndexedDB|IO|LayerTree|Log|Performance|Security|ServiceWorker|SystemInfo|Tethering|Tracing|Fetch|Media|Memory|Network|WebAudio|BackgroundService|Cast|DeviceOrientation|EventBreakpoints|FedCm|LargestContentfulPaint|Media>/\.[a-zA-Z]+$/` 即"Domain.method" 形式即放行(CDP 本身的权限模型由 Chrome 端强制)。
- 响应整形:遇 `$ref` 二进制字段(`data` base64 超阈值)截断为 `{"__truncated": true, "bytes": N}`,防 25MB 截图直接打进对话。
- 写操作(Network.enable 等副作用命令)不额外拦截——模型已带审批链,且 CDP 无独立权限概念。

---

### 3.4 事件缓冲(console / network)

**设计原则:高频"列表/过滤"做意图级工具,低频"按 id 深取"走 `chrome_cdp` 万能直通。**

连接建立(adopt)时 enable 对应域,事件落环形缓冲:

- **console**:`Runtime.consoleAPICalled` + `Log.entryAdded` → 容量 300,按 targetId 分桶,seq 单调递增。args(RemoteObject 数组)序列化为文本(`value`/`description`)。
- **network**:`Network.enable` 后的请求生命周期(requestWillBeSent → responseReceived → loadingFinished/Failed),容量 500;同 requestId 合并重定向链(记 redirectCount,保留最终 URL)。

拉取工具带 `cursor`/`nextCursor` 游标增量,不重复不漏。深取响应体/请求体不建工具:

```
chrome_cdp { method: "Network.getResponseBody", params: {requestId}, targetId }
```

**共同决策(评审点)**:
1. 缓冲默认开启(`config.capture = {console: true, network: true}`)——排查场景是"先操作、出问题再看",懒启用会丢启用前的消息;config 可关。
2. 断连不清缓冲:保留旧 generation 消息供回看,标注 generation 边界,重连后 seq 重新计。

### 3.5 断点调试(Debugger 域状态机)

调试与 console/network 的本质差异:**有状态**。断点命中是事件(`Debugger.paused`),不跟踪它 agent 就永远不知道页面停了;暂停时查变量必须走 `Debugger.evaluateOnCallFrame`,普通 `Runtime.evaluate` 会排队挂起。所以不能只靠万能直通,host 侧要加调试状态机(按 targetId 分桶):

- **懒启用**:首次调用 `chrome_debug` / `chrome_breakpoint` 时才 `Debugger.enable`(scriptParsed 事件洪泛,不值得常开);`config.debug = 'lazy'(默认) | 'off'`。
- **scriptParsed 登记**:`scriptId → {url, lineCount}`,供断点定位与 `scripts` 列表。
- **paused 快照**:命中时存 `{reason, callFrames(位置+函数名,精简), hitBreakpoints}`,target 标记 paused;`resumed` 清除。
- **eval 守卫**:target 处于 paused 时,`chrome_evaluate` 直接返回提示 `target paused, use chrome_debug eval`(不挂起)。
- **断点生命周期**:断点存于 Chrome 侧,随 target 销毁消失;重连后 `list` 如实反映,host 不做重放(v2 可选)。

典型工作流:

```
chrome_breakpoint {action:'set', url:'app.js', line:42, condition:'x > 3'}
chrome_navigate   {url:'http://...'}                  # 或等待用户操作触发
chrome_debug      {action:'status'}                   # → paused:true, callFrames, hitBreakpoints
chrome_debug      {action:'eval', expression:'user.name'}   # 在暂停帧上求值
chrome_debug      {action:'step_over'}
chrome_debug      {action:'resume'}
```

脚本源码深取走万能直通:`chrome_cdp {method:'Debugger.getScriptSource', params:{scriptId}, targetId}`;异常断点/事件断点(DOMDebugger)同理走直通。

## 4. Host 半边架构

### 4.1 模块划分

```
src/
├── cdp-connection.ts        # 不变(连接管理)
├── tools/                   # 新增
│   ├── index.ts             # apply 集成点:ctx.tools.register × 11
│   ├── dispatch.ts          # 核心路由:工具调用 → CDP 命令编排
│   ├── targets.ts           # 目标选择/激活/会话管理
│   ├── capture.ts           # console/network 事件环形缓冲
│   ├── debugger.ts          # Debugger 状态机:scriptParsed 登记 / paused 快照 / 断点表
│   ├── serialize.ts         # CDP 结果 → lossless JSON 整形(截断/去 remote object 细节)
│   └── schema.ts            # 11 个工具的 parameter/output schema
├── index.ts                 # apply 里新增 registerTools(ctx, service)
├── types.ts                 # 扩展 wire 类型(工具用)
└── client/                  # 面板增量:显示工具活动(可选,v1 不做)
```

### 4.2 会话与目标管理(核心设计点)

CDP 的命令要走"目标会话"(flat session 模式)。设计:

- **默认目标**:service 维护 `activeTargetId`(面板和工具共用)。工具调用不指定 `targetId` 时,若未设置,自动选择"最后一个新建的 page"或第一个 page。
- **会话缓存**:`targetId → sessionId` 的 Map。`Target.attachToTarget({targetId, flatten: true})` 一次,缓存 sessionId,命令通过 `{sessionId}` 发给该 page 的 session。
- **会话失效**:目标销毁事件(`Target.detachedFromTarget` / `targetDestroyed`)→ 清缓存条目;activeTargetId 指向销毁目标时回退到自动选择。
- **会话复用**:`Runtime.enable` / `Page.enable` 等域使能命令按需幂等执行(每 session 首次使用时 enable,记入 Set)。

### 4.3 连接态检查

所有工具 execute 开头:
```ts
if (service.getSnapshot().phase !== 'connected') {
  return { error: 'not-connected', hint: 'use chrome_cdp or the panel to connect first' }
}
```
返回结构化错误(不 throw),模型可读并自行决定先调 connect(设计上 `connect` 不做成工具——连接管理是面板职责,避免模型误断连;但 `chrome_cdp` 直通 `Target.getTargets` 这类 browser 级命令在未连接时也报同样错)。

### 4.4 截图管道

```
Page.captureScreenshot → {data: base64} (Uint8Array)
  → attachments.saveImages([{data, mediaType: 'image/png'}])   // DSH 附件服务
  → ImageAttachmentRef
  → render: [{type:'image', attachment: ref}, {type:'text', text: meta}]
```
- `attachments` 服务可选注入(`{ optional: 'attachments' }`)——注入不了时(极简 host)退化为 base64 文本输出。
- canonical value 里存 `attachmentId/width/height/mediaType/bytes`,不存 base64(日志与回放不膨胀)。

### 4.5 RPC 与工具的关系

工具 **不新增 RPC 端点**——工具执行在 host 进程内直接调 service(同进程),不经过 `/cdp` HTTP 通道。`/cdp` 通道继续只服务面板。

## 5. Client 半边(面板增量,可选)

v1 不做工具活动的面板展示。预留:`CdpStatus.targets` 已含目标列表,后续可在面板目标列表上显示"当前活跃目标"高亮 + 点击切换(activeTargetId 双向),让"工具正在操作哪个页面"一目了然。

## 6. 配置与挂载

### 6.1 plugin Config 扩展

```ts
Config = Schema.object({
  host: Schema.string().default('127.0.0.1'),
  panel…(原有)
  tools: Schema.object({
    enable: Schema.boolean().default(true),
    prefix: Schema.string().default('chrome_'),   // 工具名前缀,避免命名冲突
    screenshotPersist: Schema.boolean().default(true),  // 是否走附件持久化
  }).default({}),
})
```

### 6.2 agent preset 挂载(用户侧操作)

Web 会话要看到工具,需在 agent preset 中加一行(host 树直接注册对 web agent 不可见):
```yaml
- id: chrome-cdp-tools
  name: 'dsh-chrome-cdp'
  config:
    tools:
      enable: true
```
等等——同一个包不能既在 host 树又在 preset 树注册。正确做法:**插件加载一次,双面行为由 config 分叉**。见 §6.3。

### 6.3 单插件双面行为分叉(关键设计)

DSH 的 preset 是独立 fiber,同一个插件可以在 preset 层再挂一行(不同 config)——但 `ctx.tools.register` 的 scope 是注册处的 fiber。为此:

- 插件 `apply` 检测 `config.tools?.enable`:
  - host 层行(`~/.dsh/profiles/web/cordis.patch.yml` 里的现有行)→ 只做连接管理 + RPC(现状,不注册工具)。
  - preset 层行(preset yml 里的行)→ `ctx.tools.register` × 7。此时插件在 preset fiber 里,**连接服务不存在**(service 在 host fiber)。
- **桥接**:preset 层的 `apply` 不 new service,而是通过 `ctx.get('chromeCdp')` 拿 host 层注册的服务?——不行,cordis service 有 realm 隔离,跨 fiber 拿不到。
- **正确方案**:工具执行走 `/cdp` RPC?——工具在 host 进程,service 也在 host 进程,但分属不同 fiber。**最终选型:工具路由走全局单例模块**。
  - `src/cdp-connection.ts` 的 service 在 host fiber 里,但把"命令直通"能力抽成 **模块级单例导出**:`export function getCdpClient(): CdpClientShape | undefined`(host fiber 协议)。
  - preset fiber 的工具 execute 调这个模块单例(同进程 import,无 realm 隔离)。host fiber 卸载时清空单例。
  - 代价:同一进程多个 web host 不可能(一个 dsh web 一个 port),单例安全。
- 备选(若评审认为单例脏):工具走 HTTP `POST /cdp/command` 新端点(preset fiber 里用 fetch localhost:3080)——但这要求 host 端口可知,且多一跳网络。**倾向单例**。

### 6.4 dev 循环

```bash
cd /home/chesng/code/chrome-cdp
npm run build
touch ~/.dsh/profiles/web/cordis.patch.yml    # host 半边热生效
# 工具 schema 变更需重启会话(agent toolset 在会话启动时装配)
```

## 7. 安全与权限

1. **审批链**:所有工具默认走 DSH 审批(`tool-*` 的既有权限栈),敏感命令(导航到非 localhost)可配 permission preset 细化。
2. **`chrome_cdp` 万能直通**:无白名单——CDP 本身即信任边界(能连上 9222 即能做一切)。但 `Browser.close` / `Target.closeTarget` 一类毁灭性命令在 serialize 层加确认提示文案(render 层面)。
3. **数据外泄面**:截图/求值结果可能含页面敏感信息,与既有 bash 工具同级,不额外加密。
4. **本地回环**:默认连接 127.0.0.1:9604;连接参数由面板管理,模型无权改连接参数(`setParams` 不做成工具)。

## 8. 实施分期

> 排序依据:P0 = 无它干不了活的最小闭环;P1 = 高频刚需增强;P2 = 体验打磨。
> 排查双件(console/network)与三件套同级刚需,提进 P0;截图与输入模拟顺延。

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | `chrome_cdp` 万能直通 + 目标会话管理 + serialize | curl 直调工具注册可见;`Page.navigate` 逐通 |
| P0 | 三件套:`chrome_list_targets` / `chrome_navigate` / `chrome_evaluate` | agent 会话内模型成功调用 |
| P0 | 排查双件:`chrome_console` / `chrome_network` + 事件环形缓冲(§3.4) | 页面报错与请求生命周期可拉取,游标续读正确 |
| P1 | 断点调试对:`chrome_debug` / `chrome_breakpoint` + Debugger 状态机(§3.5) | 断点命中→查变量→单步→恢复全流程 |
| P1 | `chrome_screenshot`(附件管道) | 截图进对话,多模态模型可见 |
| P1 | `chrome_click` / `chrome_type`(Input 模拟) | 真实页面上点/输入 |
| P2 | 面板目标高亮 + 点击切换 activeTarget | 面板交互验证 |
| P2 | permission preset 细化 + 工具描述打磨 | 审批文案合理 |

P0 交付后即可支撑两类完整工作流:
- **验证型**:list_targets → navigate → evaluate(读数据/断言)
- **排查型**:navigate → 操作 → console(error)/ network(过滤 4xx/5xx)→ `chrome_cdp` 直通 getResponseBody 深挖

## 9. 验证计划

- **单元**:dispatch 路由表完备性(50 域抽样);serialize 截断行为(1MB/10MB base64);环形缓冲游标语义(续读不重不漏、容量淘汰最旧);调试状态机(paused/resumed 转移、eval 守卫、断点表生命周期)。
- **集成**:临时 host + Chrome CDP,agent 会话内 11 工具全调用一轮(导航→求值→console→network→断点调试→点击→输入→截图)。
- **回归**:面板原有功能不回归(面板 RPC 不走工具路径)。
- **边界**:CDP 断连时工具返回结构化 `not-connected`;目标销毁后缓存失效;断连重连后缓冲 generation 边界正确。

## 9A. 上下文预算

常驻(每次请求都携带的 11 个工具 schema)≈ **2K tokens**;P0 六件 ≈ 1.1K。参照:DSH 内置工具集 3–6K。

按次注入(serialize 截断约束):navigate ~30;list_targets 100–400;evaluate ≤1K;console/network 拉取(limit 默认 50)0.8–1.2K;debug status 100–300;chrome_cdp 直通受截断阈值约束;**screenshot 是最大头**(每张图模型端折算 0.7–1.5K,仅多模态会话消耗)。

控制手段:
1. **分组开关** `config.tools = {navigation: true, diagnostics: true, debug: false, interaction: false, raw: true}` — 不注册即零 schema 占用;默认全开,按需裁到 P0 六件(常驻 ~1.1K)。
2. **code mode**(DSH 原生)把全部工具折叠成单一 `run_code` + SDK prompt,11 → 1。
3. **拉取默认值**:console/network `limit` 默认 50;结果截断阈值;游标增量保证单次有上界。

---

## 10. 开放问题(供评审)

1. **单例桥接 vs HTTP 自环**:§6.3 的模块单例方案要求工具 fiber 与 host fiber 同进程。若未来 dsh 支持多 host 进程,需改 HTTP 自环。v1 接受单例。
2. **工具命名前缀**:默认 `chrome_`。是否应该随 preset 配置可改?
3. **`chrome_type` 的中文/组合键**:Input.dispatchKeyEvent 只派发 ASCII 坐标键;中文需 `Input.insertText`(v1 先支持 ASCII + 常见控制键,中文用 evaluate 插值)。
4. ~~console 消息缓冲~~ **已定案并提级**(§3.4、§8):`chrome_console` + `chrome_network`,P0 交付。
5. **panel 与 tools 的 activeTarget 同步**:v2 面板显示当前目标;是否需要 RPC 通知面板"工具切换了目标"?

---

设计文档完。等你的实施指令。
