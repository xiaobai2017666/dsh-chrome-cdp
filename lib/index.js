import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
import { Service } from "@deepseek-ai/cordis";
import CDP from "chrome-remote-interface";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { registerHostBridge } from "dsh-chrome-cdp/bridge";
//#region src/cdp-connection.ts
/**
* Chrome CDP connection manager, Host half.
*
* Owns one chrome-remote-interface client at a time. All state transitions
* publish through a JSON-safe {@link CdpStatus} snapshot; the `/cdp` RPC
* channel serves it to the browser half, and a settings section
* (`chrome-cdp` namespace) persists the connection parameters.
*
* Failure posture: a lost CDP socket never throws into the host tree. It
* flips the published phase and, when `autoReconnect` is on, schedules the
* next attempt through a timer that plugin teardown cancels.
*
* @module dsh-chrome-cdp/cdp-connection
*/
/** The CRI module value narrowed to the surface this service uses. */
const CDP_API = CDP;
const DEFAULT_PARAMS = {
	host: "127.0.0.1",
	port: 9222,
	autoReconnect: true,
	reconnectDelaySeconds: 5
};
/** Reject impossible parameters before any socket is opened. */
function resolveParams(input, base) {
	const host = typeof input?.host === "string" && input.host.trim() !== "" ? input.host.trim() : base.host;
	const portRaw = typeof input?.port === "number" ? input.port : base.port;
	if (!Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535) throw new Error("port must be an integer between 1 and 65535");
	const delayRaw = typeof input?.reconnectDelaySeconds === "number" ? input.reconnectDelaySeconds : base.reconnectDelaySeconds;
	if (!Number.isInteger(delayRaw) || delayRaw < 1 || delayRaw > 600) throw new Error("reconnectDelaySeconds must be an integer between 1 and 600");
	return {
		host,
		port: portRaw,
		autoReconnect: typeof input?.autoReconnect === "boolean" ? input.autoReconnect : base.autoReconnect,
		reconnectDelaySeconds: delayRaw
	};
}
/** Map an unknown failure onto a short message safe for the wire. */
function failureMessage(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}
/**
* The `chromeCdp` service: one managed CDP connection plus its RPC face.
*/
var ChromeCdpService = class extends Service {
	/** The RPC channel service is required; settings wiring stays optional. */
	static inject = ["connection"];
	params;
	client;
	status;
	connectInFlight;
	reconnectTimer;
	listeners = /* @__PURE__ */ new Set();
	closed = false;
	constructor(ctx, entryConfig = {}) {
		super(ctx, "chromeCdp");
		this.params = resolveParams(entryConfig, DEFAULT_PARAMS);
		this.status = {
			phase: "disconnected",
			host: this.params.host,
			port: this.params.port,
			autoReconnect: this.params.autoReconnect,
			error: null,
			lastDisconnect: null,
			webSocketDebuggerUrl: null,
			browserVersion: null,
			targets: [],
			connectedAt: null,
			attempts: 0
		};
		ctx.effect(() => () => {
			this.shutdown("shutdown");
		}, "chrome-cdp: connection teardown");
	}
	/** @returns the current JSON-safe status snapshot. */
	getSnapshot() {
		return this.status;
	}
	/** Observe status replacements. @returns the unsubscriber. */
	subscribe(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	/** @returns the connection parameters currently in force. */
	currentParams() {
		return this.params;
	}
	/**
	* The live CRI client for tools dispatch, when connected.
	* Exposed raw: the tools layer owns its own session/event bookkeeping.
	*/
	rawClient() {
		return this.client;
	}
	/**
	* Adopt new parameters (from the settings section or the panel), optionally
	* reconnecting when the live endpoint changed.
	* @param next - fields to replace; omitted fields keep their value.
	* @param reconnect - close and reopen when endpoint params changed.
	* @returns accepted params and whether a reconnect was started.
	*/
	setParams(next, reconnect) {
		const resolved = resolveParams(next, this.params);
		const endpointChanged = resolved.host !== this.params.host || resolved.port !== this.params.port;
		const behaviorChanged = resolved.autoReconnect !== this.params.autoReconnect || resolved.reconnectDelaySeconds !== this.params.reconnectDelaySeconds;
		this.params = resolved;
		this.publish({
			host: resolved.host,
			port: resolved.port,
			autoReconnect: resolved.autoReconnect
		});
		if (behaviorChanged && !resolved.autoReconnect) this.cancelReconnect();
		if (endpointChanged && reconnect && this.status.phase !== "connecting") {
			if (this.status.phase === "connected") this.disconnect("params-changed");
			this.connect();
			return {
				params: resolved,
				reconnected: true
			};
		}
		return {
			params: resolved,
			reconnected: false
		};
	}
	/**
	* Open (or replace) the CDP connection.
	* @returns whether the connection is up when the attempt settles.
	*/
	async connect() {
		if (this.closed) return false;
		if (this.connectInFlight !== void 0) return this.connectInFlight;
		this.cancelReconnect();
		const attempt = this.status.attempts + 1;
		this.publish({
			phase: "connecting",
			attempts: attempt,
			host: this.params.host,
			port: this.params.port,
			error: null
		});
		this.connectInFlight = this.attempt().then((up) => {
			this.connectInFlight = void 0;
			if (!up) this.scheduleReconnect();
			return up;
		});
		return this.connectInFlight;
	}
	/**
	* Close the connection (or cancel a pending attempt) on purpose.
	* @param reason - who asked for the close.
	*/
	disconnect(reason = "user") {
		this.cancelReconnect();
		const had = this.client !== void 0 || this.status.phase === "connecting";
		const settling = this.client;
		this.client = void 0;
		this.publish({
			phase: "disconnected",
			error: null,
			lastDisconnect: had ? reason : this.status.lastDisconnect,
			webSocketDebuggerUrl: null,
			browserVersion: null,
			targets: [],
			connectedAt: null
		});
		if (settling !== void 0) try {
			settling.close();
		} catch {}
	}
	/** @returns attachable targets as the endpoint currently reports them. */
	async targets() {
		try {
			return (await CDP_API.List({
				host: this.params.host,
				port: this.params.port
			}) ?? []).filter((entry) => typeof entry.webSocketDebuggerUrl === "string").map((entry) => ({
				id: entry.id ?? "",
				type: entry.type ?? "page",
				title: entry.title ?? "",
				url: entry.url ?? "",
				attachable: true
			}));
		} catch {
			return [];
		}
	}
	/** Refresh and publish the target list; a dead endpoint reports empty. */
	async refreshTargets() {
		this.publish({ targets: await this.targets() });
	}
	/** One connect attempt; never throws — failures publish as `error`. */
	async attempt() {
		try {
			const client = await CDP_API({
				host: this.params.host,
				port: this.params.port
			});
			if (this.closed) {
				try {
					client.close();
				} catch {}
				return false;
			}
			this.adopt(client);
			return true;
		} catch (error) {
			this.publish({
				phase: "error",
				error: failureMessage(error)
			});
			return false;
		}
	}
	/** Start managing a freshly connected client. */
	adopt(client) {
		const previous = this.client;
		this.client = client;
		client.on("disconnect", () => {
			this.onSocketClosed();
		});
		this.publish({
			phase: "connected",
			error: null,
			lastDisconnect: null,
			webSocketDebuggerUrl: client.webSocketUrl ?? null,
			targets: [],
			connectedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
		if (previous !== void 0 && previous !== client) try {
			previous.close();
		} catch {}
		this.refreshTargets();
		this.readBrowserVersion();
	}
	/** Read `/json/version` and publish the browser product string. */
	async readBrowserVersion() {
		try {
			const version = await CDP_API.Version({
				host: this.params.host,
				port: this.params.port
			});
			if (this.client !== void 0 && typeof version.Browser === "string") this.publish({ browserVersion: version.Browser });
		} catch {}
	}
	/** Socket-level drop: flip to error and maybe retry. */
	onSocketClosed() {
		if (this.client === void 0) return;
		this.client = void 0;
		this.publish({
			phase: "error",
			error: "connection lost",
			lastDisconnect: "socket",
			webSocketDebuggerUrl: null,
			browserVersion: null,
			targets: [],
			connectedAt: null
		});
		this.scheduleReconnect();
	}
	/** Queue the next automatic attempt when retries are enabled. */
	scheduleReconnect() {
		if (this.closed || !this.params.autoReconnect) return;
		if (this.reconnectTimer !== void 0 || this.connectInFlight !== void 0) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = void 0;
			this.connect();
		}, this.params.reconnectDelaySeconds * 1e3);
		this.reconnectTimer.unref?.();
	}
	/** Drop any queued automatic attempt. */
	cancelReconnect() {
		if (this.reconnectTimer === void 0) return;
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = void 0;
	}
	/** Final teardown used by plugin unload. */
	shutdown(reason) {
		this.closed = true;
		this.cancelReconnect();
		this.disconnect(reason);
	}
	/** Merge a patch into the published status and notify observers. */
	publish(patch) {
		this.status = {
			...this.status,
			...patch
		};
		for (const listener of [...this.listeners]) listener();
	}
};
//#endregion
//#region src/chrome-launcher.ts
/**
* Chrome instance detection + relaunch for CDP, Host half.
*
* One entry point, {@link ensureChromeInstance}: probe the configured CDP
* endpoint first; when it already answers, nothing is touched. Otherwise
* scan for a running Chrome, terminate it, and (re)start one Chrome with
* `--remote-debugging-port` on an isolated user-data-dir — the only
* invocation shape modern Chrome accepts for CDP (Chrome 136+ ignores the
* flag on the default profile, and the newer settings-page "Remote
* debugging" toggle serves a different, discovery-less protocol).
*
* Platform notes:
* - WSL2 (`/mnt/c` + `WSL_DISTRO_NAME`): drives the Windows Chrome via the
*   full PowerShell path; mirrored networking makes 127.0.0.1:<port> on the
*   Windows side reachable from inside WSL.
* - Linux: `google-chrome`/`chromium`/`chromium-browser` binaries; killed by
*   `pkill -f` on the binary name, started detached.
* - macOS: `/Applications/Google Chrome.app/...`, killed by `pkill -f`.
*
* Never throws — every failure lands in the structured result.
*
* @module dsh-chrome-cdp/chrome-launcher
*/
/** Spawn fully detached so the Chrome outlives the host process. */
const run = promisify(execFile);
/** Probe the HTTP discovery endpoint once; true = CDP-capable Chrome there. */
async function endpointAnswers(host, port, timeoutMs = 1500) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return (await fetch(`http://${host}:${port}/json/version`, { signal: controller.signal })).ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}
/** True when running inside WSL (any version) with a Windows side present. */
function isWsl() {
	if (process.platform !== "linux") return false;
	if (process.env.WSL_DISTRO_NAME !== void 0) return true;
	return existsSync("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
}
/** PowerShell entry point reachable from WSL. */
const POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
/** Windows Chrome candidate locations, most likely first. */
const WINDOWS_CHROME_PATHS = [
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
	String.raw`C:\Users\Default\AppData\Local\Google\Chrome\Application\chrome.exe`
];
/** Linux/macOS candidate binaries/classes, most likely first. */
const UNIX_CHROME_CANDIDATES = [
	"google-chrome",
	"chromium",
	"chromium-browser"
];
/** Wildcards for pgrep -f when hunting a running instance on unix. */
const UNIX_PGREP_PATTERNS = [
	"Google Chrome",
	"google-chrome",
	"chromium"
];
/** Detect the platform's Chrome installation; undefined = not found. */
async function findChrome() {
	if (isWsl()) {
		for (const exe of WINDOWS_CHROME_PATHS) {
			const windowsPath = exe.startsWith(String.raw`C:\Users\Default`) ? exe : exe;
			if (await run(POWERSHELL, [
				"-NoProfile",
				"-Command",
				`if (Test-Path '${windowsPath.replace(/\\/g, "\\\\")}') { 'yes' } else { 'no' }`
			]).then((r) => r.stdout.trim() === "yes").catch(() => false)) return windowsInstallation(windowsPath);
		}
		return;
	}
	if (process.platform === "win32") {
		for (const exe of WINDOWS_CHROME_PATHS) if (existsSync(exe)) return windowsInstallation(exe);
		return;
	}
	const macPath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	if (process.platform === "darwin" && existsSync(macPath)) return unixInstallation("Google Chrome (macOS)", macPath, ["Google Chrome"]);
	for (const bin of UNIX_CHROME_CANDIDATES) {
		const hit = await run("sh", ["-c", `command -v ${bin}`]).then((r) => r.stdout.trim()).catch(() => "");
		if (hit !== "") return unixInstallation(bin, hit, UNIX_PGREP_PATTERNS);
	}
}
/** Windows/WSL installation: lifecycle through PowerShell. */
function windowsInstallation(executable) {
	return {
		label: `Windows Chrome (${executable})`,
		executable,
		stop: async () => {
			await run(POWERSHELL, [
				"-NoProfile",
				"-Command",
				"Stop-Process -Name chrome -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2"
			]).catch(() => {});
		},
		start: async (port) => {
			await run(POWERSHELL, [
				"-NoProfile",
				"-Command",
				`Start-Process '${executable}' -ArgumentList '--remote-debugging-port=${String(port)}', '--user-data-dir=C:\\temp\\chrome-cdp-profile', '--no-first-run', '--no-default-browser-check'`
			]);
		}
	};
}
/** Unix installation: lifecycle through pkill and a detached spawn. */
function unixInstallation(label, executable, patterns) {
	return {
		label,
		executable,
		stop: async () => {
			for (const pattern of patterns) await run("pkill", ["-f", pattern]).catch(() => {});
			await new Promise((resolve) => setTimeout(resolve, 1500));
		},
		start: async (port) => {
			const profile = join(tmpdir(), "chrome-cdp-profile");
			spawnDetached(executable, [
				`--remote-debugging-port=${String(port)}`,
				`--user-data-dir=${profile}`,
				"--no-first-run",
				"--no-default-browser-check",
				"--headless=new"
			]).on("error", () => {});
		}
	};
}
function spawnDetached(command, args) {
	const child = spawn(command, args, {
		detached: true,
		stdio: "ignore"
	});
	child.unref();
	return child;
}
/**
* Guarantee a CDP-reachable Chrome at host:port.
*
* Steps: probe endpoint → (answer: done) → find Chrome → stop any running
* instance → start one with CDP flags → poll /json/version until it answers
* (bounded) → report.
*/
async function ensureChromeInstance(host, port, options = {}) {
	const timeoutMs = options.timeoutMs ?? 3e4;
	const steps = [];
	const base = {
		host,
		port,
		checkedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	if (await endpointAnswers(host, port)) return {
		...base,
		action: "none",
		endpointReady: true,
		steps: [`endpoint http://${host}:${port}/json/version already answers; Chrome untouched`]
	};
	steps.push(`endpoint http://${host}:${port}/json/version not answering`);
	const chrome = await findChrome();
	if (chrome === void 0) return {
		...base,
		action: "none",
		endpointReady: false,
		steps: [...steps, "no Chrome installation found on this platform"],
		error: "no Chrome installation found",
		hint: "install Google Chrome (or Chromium) and retry, or start one manually with --remote-debugging-port"
	};
	steps.push(`found ${chrome.label}`);
	const running = await detectRunning(chrome);
	steps.push(running ? "a Chrome instance is running — terminating it" : "no running Chrome instance — starting a fresh one");
	if (running) await chrome.stop();
	try {
		await chrome.start(port);
	} catch (error) {
		return {
			...base,
			action: running ? "restarted" : "started",
			endpointReady: false,
			steps: [...steps, `launch failed: ${messageOf$1(error)}`],
			error: `launch failed: ${messageOf$1(error)}`,
			hint: "check the Chrome executable path and try launching it manually"
		};
	}
	steps.push(`launched with --remote-debugging-port=${String(port)} (isolated user-data-dir)`);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await endpointAnswers(host, port, 1e3)) {
			steps.push(`endpoint ready after ${String(timeoutMs - (deadline - Date.now()))}ms`);
			return {
				...base,
				action: running ? "restarted" : "started",
				endpointReady: true,
				steps
			};
		}
		await new Promise((resolve) => setTimeout(resolve, 700));
	}
	return {
		...base,
		action: running ? "restarted" : "started",
		endpointReady: false,
		steps: [...steps, `endpoint did not answer within ${String(timeoutMs)}ms`],
		error: "Chrome launched but the CDP endpoint never became ready",
		hint: "older Chrome builds ignore --remote-debugging-port on the default profile; the isolated user-data-dir flag is required and was passed — check whether another Chrome process raced the launch"
	};
}
/** Whether any instance of this installation appears to be running. */
async function detectRunning(chrome) {
	if (isWsl() || process.platform === "win32") return await run(POWERSHELL, [
		"-NoProfile",
		"-Command",
		"@(Get-Process -Name chrome -ErrorAction SilentlyContinue).Count"
	]).then((r) => Number.parseInt(r.stdout.trim(), 10)).catch(() => 0) > 0;
	for (const pattern of UNIX_PGREP_PATTERNS) if (await run("pgrep", ["-f", pattern]).then(() => true).catch(() => false)) return true;
	return false;
}
/** Best-effort message of an unknown thrown value. */
function messageOf$1(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
//#region src/index.ts
/** Settings namespace owned by this plugin. */
const CHROME_CDP_SETTINGS_NAMESPACE = settingsNamespace("chrome-cdp");
/** Connection params schema, used both as plugin Config and settings section. */
const CdpParamsSchema = z.object({
	host: z.string().default("127.0.0.1"),
	port: z.number().min(1).max(65535).step(1).default(9222),
	autoReconnect: z.boolean().default(true),
	reconnectDelaySeconds: z.number().min(1).max(600).step(1).default(5)
});
/** Host services this plugin requires (the RPC channel registry). */
const inject = ["connection"];
/** Plugin entry: starts the service and its RPC/settings faces. */
function apply(ctx, config) {
	const service = new ChromeCdpService(ctx, config);
	installSettingsSection(ctx, CHROME_CDP_SETTINGS_NAMESPACE, CdpParamsSchema, config, {
		setSource: (current) => {
			service.setParams(current(), false);
		},
		onChange: () => {}
	});
	registerHostBridge(createServiceBridge(service, ctx));
	ctx.effect(() => ctx.connection.rpc.handle("/cdp", async (endpoint, payload) => {
		try {
			return await dispatchCdpRpc(service, endpoint, payload);
		} catch (error) {
			ctx.logger.warn(`chrome-cdp: rpc ${endpoint} failed: ${messageOf(error)}`);
			return {
				ok: true,
				value: { error: messageOf(error) }
			};
		}
	}, { authority: "trusted-host" }), "chrome-cdp: /cdp rpc channel");
}
/** Bridge the service + attachments service into the tools dispatcher. */
function createServiceBridge(service, ctx) {
	return {
		getStatus: () => service.getSnapshot(),
		getClient: () => {
			if (service.getSnapshot().phase !== "connected") return void 0;
			return service.rawClient();
		},
		listTargets: () => service.targets(),
		attachmentsAvailable: () => ctx.attachments !== void 0,
		persistImage: async (data, mediaType) => {
			const attachments = ctx.attachments;
			if (attachments === void 0) return void 0;
			const [ref] = await attachments.saveImages([{
				data,
				mediaType
			}]);
			return ref === void 0 ? void 0 : {
				attachmentId: ref.attachmentId,
				width: ref.width,
				height: ref.height
			};
		}
	};
}
/** Route one RPC endpoint invocation onto the service. */
async function dispatchCdpRpc(service, endpoint, payload) {
	switch (endpoint) {
		case "status": return {
			ok: true,
			value: service.getSnapshot()
		};
		case "targets": return {
			ok: true,
			value: await service.targets()
		};
		case "connect": return {
			ok: true,
			value: await service.connect()
		};
		case "ensure": {
			const snapshot = service.getSnapshot();
			const result = await ensureChromeInstance(snapshot.host, snapshot.port);
			if (result.endpointReady) await service.connect();
			return {
				ok: true,
				value: result
			};
		}
		case "disconnect":
			service.disconnect("user");
			return {
				ok: true,
				value: service.getSnapshot()
			};
		case "setParams": return {
			ok: true,
			value: service.setParams(readParamsPayload(payload), true)
		};
		default: return {
			ok: true,
			value: { error: `unknown endpoint ${endpoint}` }
		};
	}
}
/** Narrow an untrusted payload into params fields without throwing. */
function readParamsPayload(payload) {
	if (typeof payload !== "object" || payload === null) return {};
	const raw = payload;
	const out = {};
	if (typeof raw.host === "string") out.host = raw.host;
	if (typeof raw.port === "number") out.port = raw.port;
	if (typeof raw.autoReconnect === "boolean") out.autoReconnect = raw.autoReconnect;
	if (typeof raw.reconnectDelaySeconds === "number") out.reconnectDelaySeconds = raw.reconnectDelaySeconds;
	return out;
}
/** Best-effort human message of an unknown thrown value. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
export { CHROME_CDP_SETTINGS_NAMESPACE, CdpParamsSchema, ChromeCdpService, apply, inject };

//# sourceMappingURL=index.js.map