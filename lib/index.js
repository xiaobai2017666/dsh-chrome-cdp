import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import z from "@deepseek-ai/schemastery";
import { Service } from "@deepseek-ai/cordis";
import CDP from "chrome-remote-interface";
import { execFile, spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
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
	/** Read the configured parameters (lazily, from the volatile Config refs). */
	readConfig;
	/** Fields adopted locally whose durable save has not confirmed (degraded mode only). */
	localOverride = {};
	client;
	status;
	connectInFlight;
	reconnectTimer;
	listeners = /* @__PURE__ */ new Set();
	closed = false;
	constructor(ctx, readConfig) {
		super(ctx, "chromeCdp");
		this.readConfig = readConfig;
		const initial = this.params();
		this.status = {
			phase: "disconnected",
			host: initial.host,
			port: initial.port,
			autoReconnect: initial.autoReconnect,
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
	/**
	* Effective parameters right now: the volatile Config references (the
	* loader keeps them current on a settings save) overlaid with any
	* locally adopted fields whose durable save has not confirmed. Resolved
	* and validated on every call, so callers may hold the result across an
	* await and still see one consistent snapshot.
	*/
	params() {
		return resolveParams(this.localOverride, this.readConfig());
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
		return this.params();
	}
	/**
	* The live CRI client for tools dispatch, when connected.
	* Exposed raw: the tools layer owns its own session/event bookkeeping.
	*/
	rawClient() {
		return this.client;
	}
	/**
	* Adopt new parameters (from the settings section or the panel).
	*
	* Saving is local: the live connection is never torn down here — the panel
	* saves the form and connects explicitly, so a save cannot interrupt a
	* working connection. Endpoint params are adopted for the *next* attempt;
	* behavior params (auto-reconnect) apply to the running cycle immediately.
	*
	* @param next - fields to replace; omitted fields keep their value.
	* @returns the accepted params.
	*/
	setParams(next) {
		const resolved = resolveParams(next, this.params());
		this.localOverride = resolved;
		this.publish({
			host: resolved.host,
			port: resolved.port,
			autoReconnect: resolved.autoReconnect
		});
		if (!resolved.autoReconnect) this.cancelReconnect();
		return resolved;
	}
	/**
	* Save-only variant used by the panel's RPC `setParams` endpoint: adopt the
	* values, then persist them into the user settings document when a settings
	* service is mounted. Asynchronous by nature (the document write is awaited)
	* and never reconnects — connecting stays an explicit button.
	*
	* @param next - fields to replace; omitted fields keep their value.
	* @param persist - called to store the resolved params; skipped when absent.
	* @returns accepted params plus whether persistence ran.
	*/
	async setParamsAndPersist(next, persist) {
		const params = this.setParams(next);
		if (persist === void 0) return {
			params,
			persisted: false,
			persistenceNote: "settings service not available"
		};
		try {
			await persist(params);
			this.localOverride = {};
			return {
				params,
				persisted: true
			};
		} catch (error) {
			throw new Error(`params applied but not saved: ${failureMessage(error)}`);
		}
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
		const params = this.params();
		this.publish({
			phase: "connecting",
			attempts: attempt,
			host: params.host,
			port: params.port,
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
			const { host, port } = this.params();
			return (await CDP_API.List({
				host,
				port
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
			const { host, port } = this.params();
			const client = await CDP_API({
				host,
				port
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
			const { host, port } = this.params();
			const version = await CDP_API.Version({
				host,
				port
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
		if (this.closed || !this.params().autoReconnect) return;
		if (this.reconnectTimer !== void 0 || this.connectInFlight !== void 0) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = void 0;
			this.connect();
		}, this.params().reconnectDelaySeconds * 1e3);
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
* Chrome instance detection + launch for CDP, Host half.
*
* One entry point, {@link ensureChromeInstance}: probe the configured CDP
* endpoint first; when it already answers, nothing is touched. Otherwise
* launch one fresh Chrome with `--remote-debugging-port` on an isolated
* user-data-dir — the only invocation shape modern Chrome accepts for CDP
* (Chrome 136+ ignores the flag on the default profile, and the newer
* settings-page "Remote debugging" toggle serves a different,
* discovery-less protocol).
*
* By default a running Chrome is **left untouched**: the isolated
* user-data-dir makes the new instance a fully parallel process, so the
* user's open browser keeps working while the panel gets a clean CDP
* instance. Only when the caller opts into `closeRunning` is the running
* browser terminated first (takeover mode).
*
* Platform notes:
* - WSL2 (`/mnt/c` + `WSL_DISTRO_NAME`): drives the Windows Chrome via the
*   full PowerShell path; mirrored networking makes 127.0.0.1:<port> on the
*   Windows side reachable from inside WSL.
* - Linux: `google-chrome`/`chromium`/`chromium-browser` binaries; killed by
*   `pkill -f` (closeRunning only), started detached.
* - macOS: `/Applications/Google Chrome.app/...`, killed by `pkill -f`
*   (closeRunning only).
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
* Steps: probe endpoint → (answer: done) → find Chrome → launch one with CDP
* flags on an isolated user-data-dir (unless {@link EnsureOptions.closeRunning}
* is set, in which case any running instance is terminated first) → poll
* /json/version until it answers (bounded) → report.
*/
async function ensureChromeInstance(host, port, options = {}) {
	const timeoutMs = options.timeoutMs ?? 3e4;
	const closeRunning = options.closeRunning === true;
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
	let running = false;
	if (closeRunning) {
		running = await detectRunning(chrome);
		steps.push(running ? "a Chrome instance is running — terminating it (closeRunning)" : "no running Chrome instance — starting a fresh one");
		if (running) await chrome.stop();
	} else steps.push("existing Chrome instances (if any) left untouched — launching a separate instance with its own user-data-dir");
	try {
		await chrome.start(port);
	} catch (error) {
		return {
			...base,
			action: closeRunning && running ? "restarted" : "started",
			endpointReady: false,
			...closeRunning ? {} : { existingUntouched: true },
			steps: [...steps, `launch failed: ${messageOf$2(error)}`],
			error: `launch failed: ${messageOf$2(error)}`,
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
				action: closeRunning && running ? "restarted" : "started",
				endpointReady: true,
				...closeRunning ? {} : { existingUntouched: true },
				steps
			};
		}
		await new Promise((resolve) => setTimeout(resolve, 700));
	}
	return {
		...base,
		action: closeRunning && running ? "restarted" : "started",
		endpointReady: false,
		...closeRunning ? {} : { existingUntouched: true },
		steps: [...steps, `endpoint did not answer within ${String(timeoutMs)}ms`],
		error: "Chrome launched but the CDP endpoint never became ready",
		hint: "older Chrome builds ignore --remote-debugging-port on the default profile; the isolated user-data-dir flag is required and was passed — check whether another process races the launch, or that the port is free"
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
function messageOf$2(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
//#region src/preset-provision.ts
/**
* Agent-preset provisioning: make the plugin's `chrome-cdp-tools` agent
* preset appear in the harness-home user preset root
* (`$DSH_HOME/.agent-presets/chrome-cdp-tools`) without a manual copy step.
*
* Why provisioning rewrites one row: the preset composition names the tools
* half by package (`dsh-chrome-cdp/tools`), but a preset row naming a package
* resolves from the INSTALLED HARNESS, not from the profile where this plugin
* is installed (see `@deepseek-ai/dsh-agent-presets/specifier`). The shipped
* composition therefore cannot name the package and stay portable, and a
* hand-copied preset reads as healthy only while the package happens to sit
* inside the harness tree. Provisioning pins the row to a `file:` URL of the
* INSTALLED tools entry instead — a file URL names one file and no base, so
* the preset mounts no matter where the plugin landed, and the next boot
* rewrites the URL if the plugin later moves.
*
* Respect for humans, in three cases:
* - absent directory  → provisioned from the package's `presets/` copy;
* - stamped by us     → refreshed: the tools row URL re-pinned to the
*   current install, `preset.yml` re-synced;
* - unstamped         → left untouched EXCEPT a legacy composition naming the
*   package gets exactly that row rewritten in place (the pre-provisioning
*   manual-copy layout), so user edits to every other line survive.
* Deleting the directory re-provisions on the next boot; that is the upgrade
* path, not a bug.
*
* Provisioning never fails the boot: any error is contained and logged.
* @module dsh-chrome-cdp/preset-provision
*/
/** The user preset root the harness scans (matches `USER_PRESET_DIR`). */
const USER_PRESET_DIR = ".agent-presets";
/**
* The harness home, mirroring `@deepseek-ai/dsh-home-paths`' precedence
* (`$DSH_HOME` over `~/.dsh`) without adding a hard dependency: provisioning
* must write where the roster's user root actually scans.
*/
function dshHome() {
	const fromEnv = process.env.DSH_HOME;
	const selected = fromEnv !== void 0 && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), ".dsh");
	return resolve(selected);
}
/** The preset directory name, which is also the preset id. */
const PRESET_ID = "chrome-cdp-tools";
/** The legacy package row this plugin's compositions have always used. */
const LEGACY_TOOLS_ROW = "name: 'dsh-chrome-cdp/tools'";
/**
* A malformed pin an early provisioner could write (double `name:`); its
* output is repaired on the next boot.
*/
const MALFORMED_PIN_MARKER = "name: 'name: '";
/** Marker file separating our provisioning from a user-authored preset. */
const STAMP_FILENAME = ".dsh-provisioned.json";
/**
* The installed package root: two levels above this module's built file
* (`lib/index.js` → package root; `src/*.ts` under tsx → package root too).
*/
function packageRoot() {
	return dirname(dirname(fileURLToPath(import.meta.url)));
}
/** The YAML row spelling for the pinned tools entry. */
function toolsRow(toolsUrl) {
	return `name: '${toolsUrl}'`;
}
/**
* Provision (or refresh) the agent preset; never throws.
* @param ctx - host context, for diagnostics.
* @param version - the running plugin version, recorded in the stamp.
* @param packageDir - the installed package root (for the tools entry hop).
*/
function provisionAgentPreset(ctx, version, packageDir = packageRoot()) {
	try {
		const targetDir = join(dshHome(), USER_PRESET_DIR, PRESET_ID);
		const sourceDir = join(packageDir, "presets", PRESET_ID);
		const compositionSource = join(sourceDir, "agent.cordis.yml");
		if (!existsSync(compositionSource)) {
			ctx.logger.warn("chrome-cdp: preset provisioning skipped — shipped composition missing at %s", compositionSource);
			return;
		}
		const targetComposition = join(targetDir, "agent.cordis.yml");
		const toolsUrl = pathToFileURL(join(packageDir, "lib", "tools.mjs")).href;
		const row = toolsRow(toolsUrl);
		let changed = false;
		if (!existsSync(targetComposition)) {
			const desired = readFileSync(compositionSource, "utf8").replaceAll(LEGACY_TOOLS_ROW, row);
			mkdirSync(targetDir, { recursive: true });
			writeFileSync(targetComposition, desired);
			copyMetadata(sourceDir, targetDir);
			writeStamp(targetDir, version);
			ctx.logger.warn("chrome-cdp: agent preset provisioned at %s", targetDir);
			return;
		}
		const stamp = readStamp(targetDir);
		const current = readFileSync(targetComposition, "utf8");
		const hasLegacyRow = current.includes(LEGACY_TOOLS_ROW);
		const hasMalformedPin = current.includes(MALFORMED_PIN_MARKER);
		if (stamp === void 0 && !hasLegacyRow && !hasMalformedPin) {
			ctx.logger.warn("chrome-cdp: preset at %s was not provisioned by this plugin; left untouched", targetDir);
			return;
		}
		let desired = current;
		if (hasLegacyRow) desired = desired.replaceAll(LEGACY_TOOLS_ROW, row);
		if (hasMalformedPin) desired = desired.replaceAll(MALFORMED_PIN_MARKER, row);
		if (desired !== current) {
			writeFileSync(targetComposition, desired);
			changed = true;
		}
		if (syncMetadata(sourceDir, targetDir)) changed = true;
		if (stamp?.version !== version) {
			writeStamp(targetDir, version);
			changed = true;
		}
		if (changed) ctx.logger.warn("chrome-cdp: agent preset refreshed at %s", targetDir);
	} catch (error) {
		ctx.logger.warn("chrome-cdp: preset provisioning skipped: %s", messageOf$1(error));
	}
}
/** Copy `preset.yml` from the shipped copy; true when bytes changed. */
function copyMetadata(sourceDir, targetDir) {
	const source = readFileSync(join(sourceDir, "preset.yml"), "utf8");
	const target = join(targetDir, "preset.yml");
	if (existsSync(target) && readFileSync(target, "utf8") === source) return false;
	writeFileSync(target, source);
	return true;
}
/** Alias of {@link copyMetadata} for the refresh path. */
function syncMetadata(sourceDir, targetDir) {
	return copyMetadata(sourceDir, targetDir);
}
function writeStamp(targetDir, version) {
	const stamp = {
		by: "dsh-chrome-cdp",
		version
	};
	writeFileSync(join(targetDir, STAMP_FILENAME), `${JSON.stringify(stamp, void 0, 2)}\n`);
}
function readStamp(targetDir) {
	try {
		const parsed = JSON.parse(readFileSync(join(targetDir, STAMP_FILENAME), "utf8"));
		return parsed?.by === "dsh-chrome-cdp" ? parsed : void 0;
	} catch {
		return;
	}
}
/** Best-effort human message of an unknown thrown value. */
function messageOf$1(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
//#region src/rpc-shim.ts
/**
* Call-site compatibility shim for `connection.rpc.handle()`.
*
* Why this exists: `HostConnectionService.get rpc()` resolves `webServer`
* from a context derived from the **connection service's own** fiber
* (`const owner = this.ctx` in `rpc-host.ts`), not from the calling
* plugin's fiber. cordis refuses to resolve a sibling fiber's service, so
* on a harness build whose `client-connection` predates the upstream
* `['webServer', 'credentials']` inject fix, the first
* `connection.rpc.handle()` call fails synchronously with
* `cannot get property "webServer" without inject` — no caller-side
* `inject` declaration can prevent it.
*
* What this shim does, entirely from the plugin side:
*
* 1. Healthy path first — `ctx.rpc.handle(channel, handler)`, the exact
*    call form the dsh ≥ 0.2.1-rc harness expects, so on a fixed harness
*    registration ownership and disposal semantics are byte-for-byte
*    unchanged.
* 2. Fallback, engaged only when that exact cordis diagnostic surfaces:
*    call the same `register(owner, channel, handler)` prototype method
*    the getter delegates to, passing `owner` = this plugin's context with
*    `webServer` overlaid as an own property. The plugin already declares
*    `webServer` in its `inject`, so the overlay read always succeeds;
*    `owner.effect(...)` and everything else resolve on this plugin's
*    fiber, so route lifetime matches the healthy path's.
*
* The fallback self-disarms on a fixed harness (path 1 simply succeeds)
* and never masks any other error.
*/
/** Symbol cordis uses to expose the value behind traceable proxies. */
const ORIGINAL = Symbol.for("cordis.original");
/** The exact cordis diagnostics the fallback tolerates — nothing else. */
const INJECT_ERRORS = ["cannot get property \"webServer\" without inject", "cannot get required service \"webServer\" in inactive context"];
/**
* Register `channel` on the host Connection registry, tolerating harness
* builds whose `rpc` getter cannot resolve `webServer`.
*
* @param ctx - this plugin's context; must inject `connection` and
*   `webServer` (the overlay in the fallback path reads `webServer` here).
* @param channel - absolute RPC channel to register, e.g. `/cdp`.
* @param handler - endpoint handler for the channel.
* @returns disposer removing the channel, same contract as `rpc.handle()`.
*/
function handleRpcChannel(ctx, channel, handler) {
	try {
		return ctx.connection.rpc.handle(channel, handler);
	} catch (error) {
		if (!isInjectError(error)) throw error;
	}
	const service = peelOriginal(ctx.connection);
	if (!isObject(service) || typeof service.register !== "function") throw new Error(`dsh-chrome-cdp: cannot register ${channel}: connection.rpc is unavailable (${INJECT_ERRORS[0]}) and the connection service exposes no register()`);
	const webServer = ctx.webServer;
	if (webServer === void 0 || webServer === null) throw new Error(`dsh-chrome-cdp: cannot register ${channel}: webServer is not resolvable from this plugin's context (add "webServer" to the plugin's inject)`);
	return service.register(makeOwner(ctx, webServer), channel, handler);
}
/**
* Build the fallback `owner`: this plugin's context with `webServer`
* overlaid as an own property. Reads of `owner.webServer` are served by
* the overlay directly — cordis resolution (which cannot walk sideways
* into the webServer sibling fiber) never runs for that key. Every other
* read (`effect`, `fiber`, `logger`, …) goes through the real context, so
* the route's registration effect — and therefore its disposal lifetime —
* behaves exactly like the healthy path's.
*/
function makeOwner(base, webServer) {
	return new Proxy(Object.create(null), {
		get(_target, prop) {
			if (prop === "webServer") return webServer;
			const value = Reflect.get(base, prop);
			return typeof value === "function" ? value.bind(base) : value;
		},
		has(_target, prop) {
			return prop === "webServer" || Reflect.has(base, prop);
		}
	});
}
/** Match — and only match — the known cordis inject diagnostics. */
function isInjectError(error) {
	return error instanceof Error && INJECT_ERRORS.includes(error.message);
}
/** Peel traceable-proxy layers (bounded) to reach the raw service object. */
function peelOriginal(value) {
	let current = value;
	for (let depth = 0; depth < 4 && isObject(current); depth++) {
		if (!Reflect.has(current, ORIGINAL)) return current;
		const inner = current[ORIGINAL];
		if (inner === void 0 || inner === null) return current;
		current = inner;
	}
	return current;
}
function isObject(value) {
	return (typeof value === "object" || typeof value === "function") && value !== null;
}
//#endregion
//#region src/index.ts
/**
* Chrome CDP connection panel — Host entry.
*
* Wires three concerns together on one fiber:
*
* 1. the {@link ChromeCdpService} owning the chrome-remote-interface client;
* 2. the `/cdp` RPC channel serving the browser panel: `status`, `targets`,
*    `connect`, `disconnect`, `setParams`;
* 3. the volatile `Config` schema whose fields surface in the settings UI;
*    panel saves go through `ctx.settings.update()`, the loader commits the
*    validated values into the running fiber's volatile references, and the
*    service reads its effective parameters through those references — a
*    save never remounts the fiber, so a working connection survives.
*
* The plugin injects `connection`, `webServer`, and `settings`: the RPC
* channel rides on the connection/web-server pair, and panel saves persist
* through the settings forms service.
*
* @module dsh-chrome-cdp
*/
/** Settings namespace owned by this plugin (the loader entry id). */
const CHROME_CDP_SETTINGS_NAMESPACE = "chrome-cdp";
/** Connection params schema; every field is volatile (live-editable). */
const Config = z.object({
	host: z.string().default("127.0.0.1").volatile(),
	port: z.number().min(1).max(65535).step(1).default(9222).volatile(),
	autoReconnect: z.boolean().default(true).volatile(),
	reconnectDelaySeconds: z.number().min(1).max(600).step(1).default(5).volatile()
});
/** Back-compat alias for external consumers of the old name. */
const CdpParamsSchema = Config;
/** Host services this plugin requires: the RPC channel registry, the web
* server, and the settings forms. Registering the `/cdp` channel routes
* HTTP traffic through the web server; the fallback path in `rpc-shim.ts`
* serves the `webServer` read from this plugin's own context; panel saves
* go through `settings.update()`. `settings` rides on the same profile
* availability as the web half (both are disabled outside a profile), so
* requiring it here cannot strand a headless boot. */
const inject = [
	"connection",
	"webServer",
	"settings"
];
/** Plugin entry: starts the service and its RPC/settings faces. */
function apply(ctx, config) {
	const readParams = () => ({
		host: config.host.get(),
		port: config.port.get(),
		autoReconnect: config.autoReconnect.get(),
		reconnectDelaySeconds: config.reconnectDelaySeconds.get()
	});
	const service = new ChromeCdpService(ctx, readParams);
	provisionAgentPreset(ctx, thisPluginVersion());
	/** Persist params into the user settings document (profile patch). */
	const persistParams = async (params) => {
		await ctx.settings.update(CHROME_CDP_SETTINGS_NAMESPACE, {
			host: params.host,
			port: params.port,
			autoReconnect: params.autoReconnect,
			reconnectDelaySeconds: params.reconnectDelaySeconds
		});
	};
	registerHostBridge(createServiceBridge(service, ctx));
	ctx.effect(() => handleRpcChannel(ctx, "/cdp", async (endpoint, payload) => {
		try {
			return await dispatchCdpRpc(service, endpoint, payload, persistParams);
		} catch (error) {
			ctx.logger.warn(`chrome-cdp: rpc ${endpoint} failed: ${messageOf(error)}`);
			return {
				ok: true,
				value: { error: messageOf(error) }
			};
		}
	}), "chrome-cdp: /cdp rpc channel");
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
async function dispatchCdpRpc(service, endpoint, payload, persistParams) {
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
			const closeRunning = readEnsurePayload(payload);
			const result = await ensureChromeInstance(snapshot.host, snapshot.port, { closeRunning });
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
			value: await service.setParamsAndPersist(readParamsPayload(payload), persistParams)
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
/** Narrow an untrusted `ensure` payload into the closeRunning flag. */
function readEnsurePayload(payload) {
	if (typeof payload !== "object" || payload === null) return false;
	return payload.closeRunning === true;
}
/** Best-effort human message of an unknown thrown value. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/** This package's manifest version (resolved from the installed package root). */
function thisPluginVersion() {
	try {
		const root = dirname(fileURLToPath(import.meta.url));
		return JSON.parse(readFileSync(join(root, "..", "package.json"), "utf8"))["version"];
	} catch {
		return "0.0.0";
	}
}
//#endregion
export { CHROME_CDP_SETTINGS_NAMESPACE, CdpParamsSchema, Config, apply, inject };

//# sourceMappingURL=index.js.map