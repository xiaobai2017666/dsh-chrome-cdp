/**
 * Locale dictionaries for the Chrome CDP panel.
 *
 * @module dsh-chrome-cdp/client/locales
 */

/** Every key the panel renders, per locale. */
export const CDP_LOCALES = {
  en: {
    'panel.title': 'Chrome CDP',
    'panel.trigger': 'Chrome CDP',
    'panel.loading': 'Loading connection status…',
    'panel.rpcFailed': 'Cannot reach the host: {message}',
    'panel.badPayload': 'Unexpected host reply.',
    'status.disconnected': 'Disconnected',
    'status.connecting': 'Connecting…',
    'status.connected': 'Connected',
    'status.error': 'Error',
    'status.unknown': 'Unknown',
    'info.browser': 'Browser',
    'info.targets': 'Targets',
    'info.wsUrl': 'WebSocket',
    'info.connectedAt': 'Since',
    'info.attempts': 'Attempts',
    'info.host': 'Host',
    'info.port': 'Port',
    'info.autoReconnect': 'Auto-reconnect',
    'info.reconnectDelay': 'Retry delay (s)',
    'error.label': 'Last error: {message}',
    'targets.empty': 'No attachable targets',
    'targets.refresh': 'Refresh targets',
    'form.title': 'Connection parameters',
    'form.host': 'Host',
    'form.port': 'Port',
    'form.autoReconnect': 'Auto-reconnect when the socket drops',
    'form.reconnectDelay': 'Retry delay (seconds)',
    'form.save': 'Save & reconnect',
    'form.saved': 'Saved',
    'action.ensure': 'Ensure Chrome',
    'action.ensureHint': 'Detect a running Chrome and (re)start it with a CDP port. A running Chrome will be closed.',
    'action.ensureConfirm': 'This will close the running Chrome (unsaved page state is lost) and relaunch it with the debugging port. Continue?',
    'action.ensureNone': 'Endpoint already answers; Chrome untouched.',
    'action.ensureStarted': 'Chrome started with the debugging port.',
    'action.ensureRestarted': 'Chrome restarted with the debugging port.',
    'action.ensureFailed': 'Could not bring up a CDP-capable Chrome.',
    'action.connect': 'Connect',
    'action.disconnect': 'Disconnect',
    'action.reconnect': 'Reconnect',
    'action.busy': 'Working…',
    'action.error': 'Action failed: {message}',
    'overlay.label': 'Chrome CDP connection',
  },
  zh: {
    'panel.title': 'Chrome CDP',
    'panel.trigger': 'Chrome CDP',
    'panel.loading': '正在加载连接状态…',
    'panel.rpcFailed': '无法连接宿主: {message}',
    'panel.badPayload': '宿主返回了意外的数据。',
    'status.disconnected': '未连接',
    'status.connecting': '连接中…',
    'status.connected': '已连接',
    'status.error': '错误',
    'status.unknown': '未知',
    'info.browser': '浏览器',
    'info.targets': '目标数',
    'info.wsUrl': 'WebSocket',
    'info.connectedAt': '连接时间',
    'info.attempts': '尝试次数',
    'info.host': '主机',
    'info.port': '端口',
    'info.autoReconnect': '自动重连',
    'info.reconnectDelay': '重试间隔(秒)',
    'error.label': '最后错误: {message}',
    'targets.empty': '没有可附加的目标',
    'targets.refresh': '刷新目标列表',
    'form.title': '连接参数',
    'form.host': '主机',
    'form.port': '端口',
    'form.autoReconnect': 'Socket 断开时自动重连',
    'form.reconnectDelay': '重试间隔(秒)',
    'form.save': '保存并重连',
    'form.saved': '已保存',
    'action.ensure': '检测并启动 Chrome',
    'action.ensureHint': '检测运行中的 Chrome 并(重)启一个带 CDP 端口的实例;正在运行的 Chrome 会被关闭。',
    'action.ensureConfirm': '将关闭正在运行的 Chrome(未保存的页面状态会丢失),并以调试端口重新启动。继续?',
    'action.ensureNone': '端点已可用,Chrome 未做改动。',
    'action.ensureStarted': '已启动带调试端口的 Chrome。',
    'action.ensureRestarted': '已重启 Chrome 并带调试端口。',
    'action.ensureFailed': '无法拉起可 CDP 连接的 Chrome。',
    'action.connect': '连接',
    'action.disconnect': '断开',
    'action.reconnect': '重连',
    'action.busy': '处理中…',
    'action.error': '操作失败: {message}',
    'overlay.label': 'Chrome CDP 连接',
  },
} as const

/** Union of every locale key. */
export type CdpLocaleKey = keyof typeof CDP_LOCALES.en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Chrome CDP panel copy. */
    'chrome-cdp': CdpLocaleKey
  }
}
