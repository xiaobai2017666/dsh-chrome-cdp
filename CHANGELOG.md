# Changelog

本项目的显著变更记录。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
版本号遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。

## [0.1.1] — 2026-08-28

### Added
- **连接面板**(Web GUI 侧栏):状态卡(相位/Chrome 版本/target 数/断开原因)、连接参数编辑(host/port/autoReconnect/reconnectDelaySeconds,保存后自动重连)、Connect/Disconnect/Reconnect、target 列表;参数持久化于用户设置文档(`chrome-cdp` namespace)。
- **「检测并启动 Chrome」(Ensure Chrome)面板按钮**(未连接时可用):探测当前 host:port 是否已有可 CDP 连接的 Chrome;否则检测运行中的 Chrome 实例(WSL 下检测 Windows 侧 chrome.exe),经确认弹窗后关闭它并以 `--remote-debugging-port` + 隔离 user-data-dir 重启,端点就绪后自动连接。幂等:端点已通则不触动浏览器。
- `src/chrome-launcher.ts`:Chrome 实例检测/终止/重启引擎,覆盖 WSL2(经 PowerShell 驱动 Windows Chrome,镜像网络直连)、原生 Linux(chromium 系)、macOS。
- **Agent 工具 11 个**(`chrome_*`,5 组:navigation/diagnostics/debug/interaction/raw,preset 配置 `groups.<name>: false` 可整组关闭,零 schema 占用):
  - `chrome_list_targets` / `chrome_navigate` / `chrome_evaluate`(断点挂起时自动引导走 chrome_debug eval)
  - `chrome_console` / `chrome_network`(环形缓冲 300/500 条,游标增量拉取,重定向合并)
  - `chrome_debug` / `chrome_breakpoint`(Debugger 状态机、断点管理、调用帧求值)
  - `chrome_screenshot`(attachments 可用时持久化为多模态附件)
  - `chrome_click` / `chrome_type`(trusted input dispatch;非 ASCII 走 insertText)
  - `chrome_cdp`(任意 `Domain.method` 直通,长尾逃生舱)
- **双半架构**:host 树 fiber(连接服务 + `/cdp` RPC + 设置)与 preset 树 fiber(工具注册)经包根 bridge 单例(`bridge.mjs`)共享连接;flat session 管理(targetId→sessionId 缓存、域幂等 enable)、连接代际重置(socket 死亡即清缓存)。
- **RemoteObject 序列化**:总预算 262144 字符、深度 24、环检测、`__truncated` 标记。
- `/cdp` RPC 通道 `ensure` 端点、`CdpEnsureResult` 线类型、面板中英文案(按钮/确认弹窗/结果提示)。
- `bridge.d.mts`:bridge 单例的环境模块类型声明。
- `scripts/tools-probe.mjs`:25 用例集成探针(独立于 DSH,直连 Chrome 端点),含断点真实命中流程。
- `README.md`(安装到 DSH 四步流程、工具一览、故障对照表)与 `ai_history/DESIGN.tools.md` 设计文档。

### Fixed
- **面板操作报 zod `invalid_union` 错误树**:`/cdp` 通道的失败响应曾以 `ok:false + 自定义错误码` 返回,而客户端响应信封 schema 对错误码白名单校验,两分支均不匹配即抛错。现通道**永不返回 `ok:false`**——所有失败(含未知端点、处理器异常)编码进 `ok:true` 的 `value: { error }`,客户端 `runAction` 统一识别。
- **preset 挂载卡死(GUI 冻结,CPU 飙满)**:preset 组合里 `cordis:group` 的 id 与其子 entry 的 id 同名时,loader 的 entry parent 链成环 → 同步死循环冻结事件循环。组合已改名避让(group `chrome-cdp-group` / 子 entry `chrome-cdp-tools`),README 记录该约束。
- **GUI 选了 preset 又弹回默认**:host 进程早于插件 link 安装启动时,其 ESM 模块缓存缺 `./bridge` export,preset 挂载报 `Package subpath './bridge' is not defined` → select 被拒。安装/升级插件后需重启 `pnpm dsh web`。
- **bridge 单例被构建劈裂**:tsdown 两个产物(`lib/index.js`、`lib/tools.mjs`)各自内联了一份 hostBridge 单例,host fiber 与 preset fiber 各持一份、互不可见,工具报 `chrome-cdp host half not loaded`。双构建以 bare self-reference `dsh-chrome-cdp/bridge` external 共享(package.json exports 增 `./bridge`),进程内唯一。
- **工具错误输出被 schema 拒绝**:错误分支返回 `{ error, hint }` 被 `additionalProperties: false` 判为 invalid output,模型只能看到 "returned invalid output" 而非错误内容。所有 strict 输出 schema 现声明可选 `error`/`hint`。

### Known Issues
- `chrome_evaluate` 对断点挂起的 target 有守卫(同 session 的 Runtime.evaluate 会永久排队),已自动改道提示。
- 探针在端点不可达时会静默挂起(CRI 对死端口不 reject),先确保 9222 可达再跑。
- host 半边(`lib/index.js`)改动需重启 `pnpm dsh web` 生效(ESM 模块缓存);preset 组合与 client 产物分别即时生效/需页面刷新。
