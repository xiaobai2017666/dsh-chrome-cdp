# Changelog

本项目的显著变更记录。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
版本号遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。

## [0.2.1] — 2026-09-01

### Added
- **Agent preset 安装即自动配置**:插件 host 行启动时把自带的 `chrome-cdp-tools` agent preset 自动写入 `$DSH_HOME/.agent-presets/chrome-cdp-tools`(`src/preset-provision.ts`)——无需再手动 `cp`。行为:
  - 目录不存在 → 整目录 provision(组合 + `preset.yml` + `.dsh-provisioned.json` 戳);
  - 已有本插件 provision 的目录 → 刷新:工具行重新钉到当前安装位置,`preset.yml` 重同步;
  - 旧版手工拷贝的布局(组合里 `name: 'dsh-chrome-cdp/tools'`)→ 仅原位改写这一行为 `file:` 钉住,其余行一字不动;
  - 用户自建的 preset(无戳、无包名行)→ 完全不碰;用户对 provision 出的组合做的手改(除工具行外)原样保留;
  - 删掉目录后下次启动自动重建;provisioning 任何错误只记日志,绝不阻断启动。
  - 工具行钉为已安装包 `lib/tools.mjs` 的 `file:` URL:preset 组合里包名行从**安装 harness**解析而非 profile(`dsh-agent-presets/specifier`),自装插件用包名行在本部署挂不上;`file:` URL 只指文件、无 base,装到哪都能挂。版本号运行时读 manifest,戳随版本自动更新。

### Changed
- **适配 DSH 0.1.2-alpha.3**:deepseek-harness 更新到 0.1.2-alpha.3 后,插件在启动时因 `installSettingsSection` 导入失败而无法加载。本次将所有跨包调用迁移到新 API:
  - settings:`installSettingsSection()` / `settingsNamespace()` 自 dsh-settings 移除,改用 `SettingsProvider.installSection(owner, ns, schema, entry, hooks)`(命名空间为普通字符串);写路径仍是 `provider.update(ns, patch)`。
  - 客户端:`@deepseek-ai/dsh-client-runtime` 包已删除,`createSnapshotStore`/`SnapshotStore` 改从 `@deepseek-ai/dsh-client-store` 导入,`ClientContext` 直接用 `Context`(@deepseek-ai/cordis);`ctx.slots` 类型合并现在位于 `dsh-client-ui-renderer/client`,通过 type-only 导入拉取。
  - 构建:client bundle externals 基线同步为 `dsh-client-store`(镜像 shell 的 `PLATFORM_MODULES`);`dsh.client.inject` 移除已不存在的 `dsh-client-runtime`。
  - 依赖:peer/dev/optional 依赖对齐 0.1.2-alpha.3,cordis 对齐 4.0.2。

## [0.1.2]

### Changed
- **「保存」只保存,不再重连**:面板参数表单的提交按钮从「保存并重连」改为「保存」——`setParams` RPC 现在只采纳参数并异步写入用户设置文档(`provider.update()`,真正落盘的 await),**不再因端点变化触发断开/重连**;需要应用新端点时由用户显式点 Connect/Reconnect。`CdpSetParamsResult` 的 `reconnected` 字段移除,新增 `persisted`/`persistenceNote`(设置服务未挂载时保存仅作用于本次会话并在结果中说明);`CdpDisconnectReason` 移除 `params-changed`。
- **保存/连接过程有可见的进行中状态**:保存进行中按钮显示「保存中…/Saving…」+ 行内旋转指示并禁用;Connect/Reconnect 为异步操作,进行中显示「连接中…/重连中…」+ 旋转指示,完成后立即刷新状态(不再等 2s 轮询)。
- **构建产物随 git 提交发布**:`lib/`、`client/` 不再被 `.gitignore` 忽略,随源码一同推送;移除 `prepare` 钩子。`dsh plugin add github:xiaobai2017666/dsh-chrome-cdp` 安装时包内无任何构建脚本 → **不触发 pnpm allowBuilds 门禁、零 prebuild**,更新亦无白名单 key 轮换。
- **Ensure Chrome 默认不再关闭已打开的 Chrome**:端点不通时直接另起一个带调试端口的独立实例(隔离 user-data-dir,与现有 Chrome 并行);面板新增「启动前先关闭正在运行的 Chrome」勾选项,勾选后才走接管式流程(检测 → 关闭 → 重启,含确认弹窗)。`ensure` RPC 接受 `{ closeRunning: true }` 显式请求接管,结果新增 `existingUntouched` 标记。

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
