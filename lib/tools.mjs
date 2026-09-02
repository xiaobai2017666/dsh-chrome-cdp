import { defineTool } from "@deepseek-ai/dsh-tools";
import * as bridgeModule from "dsh-chrome-cdp/bridge";
import { hostBridge, registerHostBridge } from "dsh-chrome-cdp/bridge";
//#region src/tools/schema.ts
/** Render helper: JSON text block. */
function asText(value) {
	return [{
		type: "text",
		text: JSON.stringify(value, null, 2)
	}];
}
function obj(props) {
	return {
		type: "object",
		properties: {
			error: { type: "string" },
			hint: { type: "string" },
			...props
		},
		additionalProperties: false
	};
}
function arr(items) {
	return {
		type: "array",
		items
	};
}
const str = { type: "string" };
const int = { type: "integer" };
const bool = { type: "boolean" };
const nullableStr = { oneOf: [{ type: "string" }, { type: "null" }] };
const nullableNum = { oneOf: [{ type: "number" }, { type: "null" }] };
const looseObj = {
	type: "object",
	additionalProperties: true
};
const TARGET_PARAM = {
	type: "string",
	description: "Target id from chrome_list_targets; defaults to the active page."
};
/** Harness-enforced call budgets: the dispatch layer bounds each CDP wait well below these. */
const QUICK_TIMEOUT_MS = 3e4;
const INTERACT_TIMEOUT_MS = 45e3;
const NAV_TIMEOUT_MS = 9e4;
const RAW_CDP_TIMEOUT_MS = 6e4;
/** The 11 tool specs, grouped. */
const TOOL_SPECS = [
	{
		name: "chrome_list_targets",
		description: "List Chrome targets (tabs/windows/workers) reachable over CDP. Start here to find the targetId of the page you want to operate on; every other tool accepts that targetId.",
		parameters: {},
		group: "navigation",
		timeoutMs: QUICK_TIMEOUT_MS,
		output: {
			schema: obj({ targets: arr(obj({
				id: str,
				type: str,
				title: str,
				url: str,
				isDefault: bool,
				paused: bool
			})) }),
			render: (_a, v) => asText(v)
		}
	},
	{
		name: "chrome_navigate",
		description: "Navigate a Chrome page to a URL. Waits for the frame to commit and the load event to fire (bounded wait). Default target: the active page.",
		parameters: {
			url: {
				type: "string",
				required: true,
				description: "Absolute URL to navigate to."
			},
			waitMs: {
				type: "integer",
				description: "Load-event wait budget in ms (default 10000)."
			},
			...targetParam()
		},
		group: "navigation",
		timeoutMs: NAV_TIMEOUT_MS,
		output: {
			schema: obj({
				frameId: str,
				loaderId: nullableStr,
				errorText: nullableStr,
				loaded: bool
			}),
			render: (_a, v) => asText(v)
		}
	},
	{
		name: "chrome_evaluate",
		description: "Evaluate JavaScript in a Chrome page and return the result. Supports awaited promises. While the target is paused at a breakpoint, this tool is blocked — use chrome_debug eval instead.",
		parameters: {
			expression: {
				type: "string",
				required: true,
				description: "JavaScript expression to evaluate."
			},
			awaitPromise: {
				type: "boolean",
				description: "Await a returned Promise (default true)."
			},
			...targetParam()
		},
		group: "navigation",
		timeoutMs: INTERACT_TIMEOUT_MS,
		output: {
			schema: obj({
				type: str,
				value: { type: "json" },
				className: nullableStr,
				exceptionDetails: nullableStr
			}),
			render: (_a, v) => asText(v)
		}
	},
	{
		name: "chrome_console",
		description: "Read console messages captured from a Chrome page (console.* and browser-level Log entries), newest last, with cursor-based pagination.",
		parameters: {
			level: {
				type: "string",
				enum: [
					"log",
					"info",
					"warning",
					"error",
					"debug"
				],
				description: "Filter by level."
			},
			text: {
				type: "string",
				description: "Filter by substring (case-insensitive)."
			},
			cursor: {
				type: "integer",
				description: "Resume after this seq (from nextCursor of a previous call)."
			},
			limit: {
				type: "integer",
				description: "Max entries (default 50, cap 300)."
			},
			...targetParam()
		},
		group: "diagnostics",
		timeoutMs: QUICK_TIMEOUT_MS,
		output: {
			schema: obj({
				entries: arr(obj({
					seq: int,
					time: str,
					level: str,
					text: str,
					url: nullableStr,
					line: nullableNum,
					targetId: str
				})),
				nextCursor: int
			}),
			render: (_a, v) => asText(v)
		}
	},
	{
		name: "chrome_network",
		description: "Read network requests captured from a Chrome page: lifecycle events merged per request (status, size, duration, redirects, errors), cursor-paginated. Use chrome_cdp with Network.getResponseBody + requestId to fetch a response body.",
		parameters: {
			url: {
				type: "string",
				description: "Filter by URL substring (case-insensitive)."
			},
			resourceType: {
				type: "string",
				description: "Filter by resource type (document, xhr, fetch, script, stylesheet, image, ...)."
			},
			minStatus: {
				type: "integer",
				description: "Filter: status >= this (e.g. 400 for failures)."
			},
			cursor: {
				type: "integer",
				description: "Resume after this seq."
			},
			limit: {
				type: "integer",
				description: "Max records (default 50, cap 500)."
			},
			...targetParam()
		},
		group: "diagnostics",
		timeoutMs: QUICK_TIMEOUT_MS,
		output: {
			schema: obj({
				requests: arr(obj({
					seq: int,
					requestId: str,
					targetId: str,
					url: str,
					method: str,
					resourceType: nullableStr,
					status: nullableNum,
					statusText: nullableStr,
					mimeType: nullableStr,
					size: nullableNum,
					durationMs: nullableNum,
					fromCache: bool,
					redirectCount: int,
					errorText: nullableStr,
					startedAt: str
				})),
				nextCursor: int
			}),
			render: (_a, v) => asText(v)
		}
	},
	{
		name: "chrome_debug",
		description: "Control the Debugger on a Chrome page: pause/resume/step, and evaluate expressions on the paused call frames (inspect locals). While paused, chrome_evaluate is blocked — use this tool's eval action. Resume succeeds even when Chrome's pause flag disagrees with the host view (it applies a pause→resume recovery).",
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: [
					"status",
					"pause",
					"resume",
					"step_into",
					"step_over",
					"step_out",
					"eval"
				],
				description: "Debugger control action."
			},
			expression: {
				type: "string",
				description: "eval action: expression evaluated on the call frame."
			},
			frame: {
				type: "integer",
				description: "eval action: call-frame index (default 0 = topmost)."
			},
			...targetParam()
		},
		group: "debug",
		timeoutMs: QUICK_TIMEOUT_MS,
		output: {
			schema: looseObj,
			render: (_a, v) => asText(v)
		}
	},
	{
		name: "chrome_breakpoint",
		description: "Manage breakpoints on a Chrome page: set by URL+line (optional condition), list, remove (a stale/unknown id still counts as removed), clear all tracked breakpoints, and list parsed scripts to locate lines. IMPORTANT: never park a breakpoint inside a synchronous mouse/key event handler and then drive the page with chrome_click/chrome_type — the page freezes until the pause resumes. Remove the breakpoint before clicking.",
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: [
					"set",
					"list",
					"remove",
					"clear",
					"scripts"
				],
				description: "Breakpoint management action."
			},
			url: {
				type: "string",
				description: "set: script URL or substring to match."
			},
			line: {
				type: "integer",
				description: "set: 0-based line number."
			},
			column: {
				type: "integer",
				description: "set: 0-based column (optional)."
			},
			condition: {
				type: "string",
				description: "set: break only when this expression is truthy."
			},
			id: {
				type: "string",
				description: "remove: breakpointId from list."
			},
			...targetParam()
		},
		group: "debug",
		timeoutMs: QUICK_TIMEOUT_MS,
		output: {
			schema: looseObj,
			render: (_a, v) => asText(v)
		}
	},
	{
		name: "chrome_screenshot",
		description: "Capture a screenshot of a Chrome page. With persist=true the image is stored as a durable attachment visible to multimodal models; otherwise the base64 payload is returned inline (bounded).",
		parameters: {
			format: {
				type: "string",
				enum: ["png", "jpeg"],
				description: "Image format (default png)."
			},
			quality: {
				type: "integer",
				description: "jpeg quality 0-100 (default 80)."
			},
			persist: {
				type: "boolean",
				description: "Store as attachment (default true when the attachments service is available)."
			},
			...targetParam()
		},
		group: "interaction",
		timeoutMs: INTERACT_TIMEOUT_MS,
		output: {
			schema: looseObj,
			render: (_a, v) => asText(v)
		}
	},
	{
		name: "chrome_click",
		description: "Click an element in a Chrome page: by CSS selector, or at viewport coordinates. Uses trusted input dispatch (not synthetic DOM events). Refuses with a hint while the target is paused at a breakpoint (a click would freeze), and bounds the click wait so a mid-call pause surfaces as a recoverable error instead of a hang.",
		parameters: {
			selector: {
				type: "string",
				description: "CSS selector of the element to click."
			},
			x: {
				type: "integer",
				description: "Viewport x coordinate (alternative to selector)."
			},
			y: {
				type: "integer",
				description: "Viewport y coordinate (alternative to selector)."
			},
			...targetParam()
		},
		group: "interaction",
		timeoutMs: INTERACT_TIMEOUT_MS,
		output: {
			schema: looseObj,
			render: (_a, v) => asText(v)
		}
	},
	{
		name: "chrome_type",
		description: "Type text into a focused element in a Chrome page. For non-ASCII text (e.g. Chinese) use chrome_evaluate to set the value instead.",
		parameters: {
			text: {
				type: "string",
				required: true,
				description: "Text to type (ASCII + common control keys)."
			},
			selector: {
				type: "string",
				description: "CSS selector to focus first; skips focus when omitted."
			},
			...targetParam()
		},
		group: "interaction",
		timeoutMs: INTERACT_TIMEOUT_MS,
		output: {
			schema: looseObj,
			render: (_a, v) => asText(v)
		}
	},
	{
		name: "chrome_cdp",
		description: "Send any raw CDP command (Domain.method) over the connection. Escape hatch for everything not wrapped by a dedicated tool: Network.getResponseBody, Debugger.getScriptSource, Emulation, CSS, Fetch, Storage...",
		parameters: {
			method: {
				type: "string",
				required: true,
				description: "CDP method, e.g. \"Network.getResponseBody\"."
			},
			params: {
				type: "json",
				description: "CDP command params object."
			},
			sessionId: {
				type: "string",
				description: "Explicit flat session id (advanced; usually use targetId)."
			},
			...targetParam()
		},
		group: "raw",
		timeoutMs: RAW_CDP_TIMEOUT_MS,
		output: {
			schema: looseObj,
			render: (_a, v) => asText(v)
		}
	}
];
/** Spread helper keeping the targetId param declaration DRY. */
function targetParam() {
	return { targetId: TARGET_PARAM };
}
//#endregion
//#region src/tools/serialize.ts
/** Hard cap on serialized output, in characters (≈ 256 KiB). */
const TOTAL_BUDGET = 262144;
/** Strings longer than this truncate (64 KiB). */
const STRING_LIMIT = 65536;
/** Arrays longer than this truncate per level. */
const ARRAY_LIMIT = 200;
/** Nesting past this flattens to a placeholder. */
const DEPTH_LIMIT = 24;
/** Running budget shared across one serialization pass. */
var Budget = class {
	used = 0;
	/** @returns whether the whole-tree budget is exhausted. */
	exhausted() {
		return this.used >= TOTAL_BUDGET;
	}
	/** Account rough output size (string length heuristic). */
	charge(n) {
		this.used += n;
	}
};
/**
* Shape an unknown CDP payload into bounded, JSON-safe output.
* Total: never throws; unserializable values degrade to markers.
*/
function serializeCdpValue(input) {
	return shape(input, new Budget(), 0);
}
/** Recursive shaping worker. */
function shape(value, budget, depth) {
	if (budget.exhausted()) return {
		__truncated: true,
		reason: "budget"
	};
	if (value === null || value === void 0) return null;
	const type = typeof value;
	if (type === "number") {
		if (!Number.isFinite(value)) return String(value);
		return value;
	}
	if (type === "boolean") return value;
	if (type === "bigint") return `[bigint ${value.toString()}]`;
	if (type === "string") return clipString(value, budget);
	if (type === "function") return "[function]";
	if (type === "symbol") return `[symbol ${value.description ?? ""}]`;
	if (value instanceof Date) return value.toISOString();
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
		const view = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		if (view.byteLength > 1024) return `[${value.constructor.name} ${view.byteLength} bytes]`;
		return Array.from(view, (b) => b);
	}
	if (depth >= DEPTH_LIMIT) return {
		__truncated: true,
		reason: "depth"
	};
	if (Array.isArray(value)) {
		const out = [];
		if (value.length > ARRAY_LIMIT) {
			for (const item of value.slice(0, ARRAY_LIMIT)) out.push(shape(item, budget, depth + 1));
			out.push({
				__truncated: true,
				reason: "items",
				detail: `${value.length - ARRAY_LIMIT} more omitted`
			});
			return out;
		}
		for (const item of value) out.push(shape(item, budget, depth + 1));
		return out;
	}
	if (seen(value)) return { "[cycle]": true };
	mark(value);
	try {
		const out = {};
		for (const [key, val] of Object.entries(value)) {
			if (budget.exhausted()) {
				out[key] = {
					__truncated: true,
					reason: "budget"
				};
				break;
			}
			out[key] = shape(val, budget, depth + 1);
		}
		return out;
	} finally {
		unmark(value);
	}
}
/** Path-scoped cycle detection store (WeakSet per pass). */
const seenThisPass = /* @__PURE__ */ new WeakSet();
function seen(value) {
	return seenThisPass.has(value);
}
function mark(value) {
	seenThisPass.add(value);
}
function unmark(value) {
	seenThisPass.delete(value);
}
/** Clip one string against the shared budget. */
function clipString(value, budget) {
	if (value.length > STRING_LIMIT) {
		const head = value.slice(0, STRING_LIMIT);
		budget.charge(head.length);
		return `${head}…[truncated ${value.length - STRING_LIMIT} chars]`;
	}
	budget.charge(value.length);
	return value;
}
/**
* Serialize a CDP `RemoteObject` (Runtime.evaluate / console args) into a
* compact model-facing value: prefer `.value`, else `.description`, else the
* shaped raw object.
*/
function serializeRemoteObject(remote) {
	if (typeof remote !== "object" || remote === null) return shapePrimitive(remote);
	const record = remote;
	if ("value" in record && record.value !== void 0) return serializeCdpValue(record.value);
	if (typeof record.description === "string") return record.description;
	if (typeof record.className === "string") return `[object ${record.className}]`;
	return serializeCdpValue(record);
}
/** Small scalar passthrough for non-object remotes. */
function shapePrimitive(value) {
	if (typeof value === "bigint") return `[bigint ${value.toString()}]`;
	if (typeof value === "symbol") return String(value);
	return value;
}
//#endregion
//#region src/tools/capture.ts
/** Ring buffer with monotonic seq; oldest entries fall out. */
var Ring = class {
	items = [];
	capacity;
	constructor(capacity) {
		this.capacity = capacity;
	}
	push(item) {
		this.items.push(item);
		if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
	}
	/** Entries after `afterSeq` (exclusive), up to `limit`, optionally filtered. */
	read(afterSeq, limit, filter) {
		const page = this.items.filter((item) => item.seq > afterSeq && (filter === void 0 || filter(item))).slice(0, limit);
		return {
			items: page,
			nextCursor: page.length > 0 ? page[page.length - 1].seq : afterSeq
		};
	}
	size() {
		return this.items.length;
	}
};
/**
* Event capture manager. One instance spans connection generations; buffers
* persist across them.
*/
var CaptureManager = class {
	perTarget = /* @__PURE__ */ new Map();
	seq = 0;
	consoleCapacity;
	networkCapacity;
	consoleEnabled;
	networkEnabled;
	constructor(options = {}) {
		this.consoleCapacity = options.consoleCapacity ?? 300;
		this.networkCapacity = options.networkCapacity ?? 500;
		this.consoleEnabled = options.consoleEnabled !== false;
		this.networkEnabled = options.networkEnabled !== false;
	}
	/** Bind to a live client; routes domain events into buffers. */
	bind(client) {
		const consoleOn = this.consoleEnabled;
		const networkOn = this.networkEnabled;
		if (consoleOn) {
			client.on("Runtime.consoleAPICalled", (params, sessionId) => {
				this.pushConsole(params, sessionId);
			});
			client.on("Log.entryAdded", (params, sessionId) => {
				this.pushLogEntry(params, sessionId);
			});
		}
		if (networkOn) {
			client.on("Network.requestWillBeSent", (params, sessionId) => this.onRequestSent(params, sessionId));
			client.on("Network.responseReceived", (params, sessionId) => this.onResponseReceived(params, sessionId));
			client.on("Network.loadingFinished", (params, sessionId) => this.onLoadingFinished(params, sessionId));
			client.on("Network.loadingFailed", (params, sessionId) => this.onLoadingFailed(params, sessionId));
		}
	}
	/**
	* Ensure capture domains are enabled for a session (lazy per session).
	* Called by dispatch on every pull and before navigations.
	*/
	async ensureEnabled(sessionId, targetId, domains) {
		const state = this.stateOf(targetId);
		for (const domain of domains) {
			if (state.enabled.has(domain)) continue;
			await this.boundSend(sessionId, `${domain}.enable`);
			state.enabled.add(domain);
		}
	}
	/** Read console entries with cursor semantics. */
	readConsole(query) {
		const state = this.stateOf(query.targetId);
		const level = query.level?.toLowerCase();
		const text = query.text?.toLowerCase();
		const read = state.console.read(query.afterSeq, query.limit, (entry) => (level === void 0 || entry.level === level) && (text === void 0 || entry.text.toLowerCase().includes(text)));
		return {
			entries: read.items,
			nextCursor: read.nextCursor
		};
	}
	/** Read network records with cursor semantics. */
	readNetwork(query) {
		const state = this.stateOf(query.targetId);
		const url = query.url?.toLowerCase();
		const rtype = query.resourceType?.toLowerCase();
		const read = state.network.read(query.afterSeq, query.limit, (rec) => (url === void 0 || rec.url.toLowerCase().includes(url)) && (rtype === void 0 || (rec.resourceType ?? "").toLowerCase() === rtype) && (query.minStatus === void 0 || (rec.status ?? 0) >= query.minStatus));
		return {
			requests: read.items,
			nextCursor: read.nextCursor
		};
	}
	/** Buffer occupancy, for diagnostics. */
	stats() {
		let consoleCount = 0;
		let networkCount = 0;
		for (const state of this.perTarget.values()) {
			consoleCount += state.console.size();
			networkCount += state.network.size();
		}
		return {
			targets: this.perTarget.size,
			console: consoleCount,
			network: networkCount
		};
	}
	/** Clear buffers (never called automatically; exposed for future RPC). */
	clear() {
		this.perTarget.clear();
	}
	stateOf(targetId) {
		let state = this.perTarget.get(targetId);
		if (state === void 0) {
			state = {
				console: new Ring(this.consoleCapacity),
				network: new Ring(this.networkCapacity),
				pending: /* @__PURE__ */ new Map(),
				enabled: /* @__PURE__ */ new Set()
			};
			this.perTarget.set(targetId, state);
		}
		return state;
	}
	nextSeq() {
		this.seq += 1;
		return this.seq;
	}
	/** Send on a bound session — set at bind() time via the client. */
	boundClient;
	async boundSend(sessionId, method) {
		if (this.boundClient === void 0) return;
		await this.boundClient.send(method, void 0, sessionId);
	}
	pushConsole(params, sessionId) {
		if (sessionId === void 0) return;
		const targetId = this.targetOf(sessionId);
		if (targetId === void 0) return;
		const p = params;
		const text = (p.args ?? []).map((arg) => typeof arg.description === "string" ? arg.description : typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value) ?? String(arg.value)).join(" ").trim();
		const frame = p.stackTrace?.callFrames?.[0];
		this.stateOf(targetId).console.push({
			seq: this.nextSeq(),
			time: (/* @__PURE__ */ new Date()).toISOString(),
			level: p.type ?? "log",
			text,
			url: frame?.url ?? null,
			line: typeof frame?.lineNumber === "number" ? frame.lineNumber : null,
			targetId
		});
	}
	pushLogEntry(params, sessionId) {
		if (sessionId === void 0) return;
		const targetId = this.targetOf(sessionId);
		if (targetId === void 0) return;
		const entry = params.entry ?? {};
		this.stateOf(targetId).console.push({
			seq: this.nextSeq(),
			time: (/* @__PURE__ */ new Date()).toISOString(),
			level: entry.level ?? "log",
			text: entry.text ?? "",
			url: entry.url ?? null,
			line: typeof entry.lineNumber === "number" ? entry.lineNumber : null,
			targetId
		});
	}
	onRequestSent(params, sessionId) {
		if (sessionId === void 0) return;
		const targetId = this.targetOf(sessionId);
		if (targetId === void 0) return;
		const p = params;
		const state = this.stateOf(targetId);
		const existing = state.pending.get(p.requestId);
		const redirectCount = existing !== void 0 ? existing.redirectCount + 1 : 0;
		state.pending.set(p.requestId, {
			seq: this.nextSeq(),
			requestId: p.requestId,
			targetId,
			url: p.request?.url ?? "",
			method: p.request?.method ?? "GET",
			resourceType: p.type ?? null,
			status: null,
			statusText: null,
			mimeType: null,
			size: null,
			durationMs: null,
			fromCache: false,
			redirectCount,
			errorText: null,
			startedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
	}
	onResponseReceived(params, sessionId) {
		if (sessionId === void 0) return;
		const targetId = this.targetOf(sessionId);
		if (targetId === void 0) return;
		const p = params;
		const state = this.stateOf(targetId);
		const rec = state.pending.get(p.requestId);
		if (rec === void 0) {
			state.network.push({
				seq: this.nextSeq(),
				requestId: p.requestId,
				targetId,
				url: p.response?.url ?? "",
				method: "GET",
				resourceType: p.type ?? null,
				status: p.response?.status ?? null,
				statusText: p.response?.statusText ?? null,
				mimeType: p.response?.mimeType ?? null,
				size: null,
				deep: void 0,
				durationMs: null,
				fromCache: p.response?.fromDiskCache === true || p.response?.fromPrefetchCache === true,
				redirectCount: 0,
				errorText: null,
				startedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
			return;
		}
		rec.status = p.response?.status ?? null;
		rec.statusText = p.response?.statusText ?? null;
		rec.mimeType = p.response?.mimeType ?? null;
		rec.fromCache = p.response?.fromDiskCache === true || p.response?.fromPrefetchCache === true;
		if (rec.resourceType === null) rec.resourceType = p.type ?? null;
	}
	onLoadingFinished(params, sessionId) {
		if (sessionId === void 0) return;
		const targetId = this.targetOf(sessionId);
		if (targetId === void 0) return;
		const p = params;
		const state = this.stateOf(targetId);
		const rec = state.pending.get(p.requestId);
		if (rec === void 0) return;
		rec.size = typeof p.encodedDataLength === "number" ? p.encodedDataLength : rec.size;
		state.network.push(rec);
		state.pending.delete(p.requestId);
	}
	onLoadingFailed(params, sessionId) {
		if (sessionId === void 0);
		const targetId = this.targetOf(sessionId ?? "");
		if (targetId === void 0) return;
		const p = params;
		const state = this.perTarget.get(targetId);
		if (state === void 0) return;
		const rec = state.pending.get(p.requestId);
		if (rec === void 0) return;
		rec.errorText = p.canceled === true ? `canceled: ${p.errorText ?? ""}`.trim() : p.errorText ?? "failed";
		state.network.push(rec);
		state.pending.delete(p.requestId);
	}
	/** sessionId → targetId via the pending/target map; falls back to 'browser'. */
	targetOf(sessionId) {
		return this.sessionTargets.get(sessionId);
	}
	sessionTargets = /* @__PURE__ */ new Map();
	/** Called by dispatch when a session is acquired for a target. */
	associate(sessionId, targetId) {
		this.sessionTargets.set(sessionId, targetId);
	}
};
//#endregion
//#region src/tools/debugger.ts
/**
* Debugger state tracker. One instance spans connection generations (script
* and breakpoint tables reset on socket loss — Chrome forgets them too).
*/
var DebuggerManager = class {
	perTarget = /* @__PURE__ */ new Map();
	/** sessionId → targetId for event routing (mirrors state.session). */
	bySession = /* @__PURE__ */ new Map();
	client;
	listeners = [];
	constructor(client) {
		this.client = client;
		this.listen("Debugger.scriptParsed", (params, sessionId) => {
			const targetId = this.targetOfEvent(sessionId);
			if (targetId === void 0) return;
			const p = params;
			if (typeof p.scriptId !== "string") return;
			this.stateOf(targetId).scripts.set(p.scriptId, {
				scriptId: p.scriptId,
				url: p.url || null,
				lineCount: typeof p.lineCount === "number" ? p.lineCount : null
			});
		});
		this.listen("Debugger.paused", (params, sessionId) => {
			const targetId = this.targetOfEvent(sessionId);
			if (targetId === void 0) return;
			const p = params;
			const frames = (p.callFrames ?? []).slice(0, 10).map((frame) => {
				const location = frame.location ?? {};
				return {
					callFrameId: String(frame.callFrameId ?? ""),
					functionName: String(frame.functionName ?? ""),
					line: typeof location.lineNumber === "number" ? location.lineNumber : 0,
					column: typeof location.columnNumber === "number" ? location.columnNumber : 0,
					scriptId: String(location.scriptId ?? ""),
					scriptUrl: this.scriptUrlOf(targetId, String(location.scriptId ?? ""))
				};
			});
			const state = this.stateOf(targetId);
			state.paused = {
				reason: p.reason ?? "other",
				callFrames: frames,
				hitBreakpoints: [...p.hitBreakpoints ?? []],
				at: (/* @__PURE__ */ new Date()).toISOString()
			};
			state.chromePaused = true;
		});
		this.listen("Debugger.resumed", (_params, sessionId) => {
			const targetId = this.targetOfEvent(sessionId);
			if (targetId === void 0) return;
			const state = this.stateOf(targetId);
			state.paused = null;
			state.chromePaused = false;
		});
	}
	/**
	* Pin the session a target's Debugger domain runs on (idempotent per
	* session; re-pins and clears stale pause state when the session changes).
	* Enables the Debugger domain exactly once per session.
	*/
	async attachSession(sessionId, targetId) {
		const state = this.stateOf(targetId);
		if (state.session === sessionId) return;
		if (state.session !== null) {
			this.bySession.delete(state.session);
			state.paused = null;
			state.chromePaused = false;
			state.scripts.clear();
		}
		state.session = sessionId;
		this.bySession.set(sessionId, targetId);
		await this.client.send("Debugger.enable", void 0, sessionId);
	}
	/** Current paused state of a target (or null). */
	pausedOf(targetId) {
		return this.stateOf(targetId).paused;
	}
	/** The pinned Debugger session of a target (or null before first use). */
	sessionOf(targetId) {
		return this.stateOf(targetId).session;
	}
	/** All tracked scripts of a target. */
	scriptsOf(targetId) {
		return [...this.stateOf(targetId).scripts.values()];
	}
	/** All tracked breakpoints of a target. */
	breakpointsOf(targetId) {
		return [...this.stateOf(targetId).breakpoints.values()];
	}
	/** URL of a script, when known. */
	scriptUrlOf(targetId, scriptId) {
		return this.stateOf(targetId).scripts.get(scriptId)?.url ?? null;
	}
	/** Set a breakpoint by URL substring; tracks it host-side. */
	async setBreakpoint(sessionId, targetId, spec) {
		const params = {
			lineNumber: spec.line,
			urlRegex: escapeRegex(spec.url)
		};
		if (spec.column !== void 0) params.columnNumber = spec.column;
		if (spec.condition !== void 0 && spec.condition !== "") params.condition = spec.condition;
		const result = await this.client.send("Debugger.setBreakpointByUrl", params, sessionId);
		const info = {
			breakpointId: result.breakpointId,
			targetId,
			url: spec.url,
			line: result.locations?.[0]?.lineNumber ?? spec.line,
			column: result.columnNumber ?? null,
			condition: spec.condition ?? null
		};
		this.stateOf(targetId).breakpoints.set(info.breakpointId, info);
		return info;
	}
	/**
	* Remove a breakpoint. Returns true when the breakpoint is gone from
	* Chrome OR the host table — a stale/unknown id is a successful removal,
	* not a failure (the 2026-09 postmortem: `removed:false` made a live
	* breakpoint look undeletable and every later click re-hit it).
	* @throws only when the command failed for a reason other than "already gone".
	*/
	async removeBreakpoint(sessionId, targetId, breakpointId) {
		const state = this.stateOf(targetId);
		try {
			await this.client.send("Debugger.removeBreakpoint", { breakpointId }, sessionId);
		} catch (error) {
			if (!isAlreadyGone(error instanceof Error ? error.message : String(error))) throw error;
		}
		state.breakpoints.delete(breakpointId);
		return true;
	}
	/**
	* Remove every tracked breakpoint of a target. Best effort: stale ids are
	* tolerated (see {@link removeBreakpoint}); returns the ids attempted.
	*/
	async removeAllBreakpoints(sessionId, targetId) {
		const ids = [...this.stateOf(targetId).breakpoints.keys()];
		for (const id of ids) {
			try {
				await this.client.send("Debugger.removeBreakpoint", { breakpointId: id }, sessionId);
			} catch (error) {
				if (!isAlreadyGone(error instanceof Error ? error.message : String(error))) throw error;
			}
			this.stateOf(targetId).breakpoints.delete(id);
		}
		return ids;
	}
	/** Evaluate on the top (or indexed) paused call frame. */
	async evaluateOnFrame(sessionId, targetId, expression, frameIndex = 0) {
		const paused = this.stateOf(targetId).paused;
		if (paused === null) throw new Error("target is not paused; use chrome_debug pause first, or chrome_evaluate");
		const frame = paused.callFrames[frameIndex];
		if (frame === void 0) throw new Error(`no call frame ${frameIndex} (paused with ${paused.callFrames.length} frames)`);
		const result = await this.client.send("Debugger.evaluateOnCallFrame", {
			callFrameId: frame.callFrameId,
			expression,
			returnByValue: true
		}, sessionId);
		if (result.exceptionDetails !== void 0) throw new Error(`evaluation threw: ${result.exceptionDetails.text ?? "unknown error"}`);
		return result.result;
	}
	/** Issue a stepping command on a paused target. */
	async step(sessionId, targetId, kind) {
		this.assertPaused(targetId, "stepping");
		const method = kind === "into" ? "Debugger.stepInto" : kind === "over" ? "Debugger.stepOver" : "Debugger.stepOut";
		await this.client.send(method, void 0, sessionId);
		return { paused: this.stateOf(targetId).paused !== null };
	}
	/** Explicit pause of a running target. */
	async pause(sessionId, targetId) {
		await this.client.send("Debugger.pause", void 0, sessionId);
	}
	/**
	* Resume a paused target.
	*
	* Chrome answers "Can only perform operation while paused" when ITS debugger
	* does not consider the target paused — e.g. host state went stale, or a
	* previous resume was lost. When we have any pause trace for the target,
	* re-sync with the postmortem-proven pause→resume combination instead of
	* failing; without a pause trace the error propagates (the target really
	* is not paused and inventing a pause would freeze it).
	*/
	async resume(sessionId, targetId) {
		const state = this.stateOf(targetId);
		try {
			await this.client.send("Debugger.resume", void 0, sessionId);
			state.paused = null;
			state.chromePaused = false;
			return { resumed: true };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if ((state.paused !== null || state.chromePaused) && isNotPausedMessage(message)) {
				await this.client.send("Debugger.pause", void 0, sessionId);
				await this.client.send("Debugger.resume", void 0, sessionId);
				state.paused = null;
				state.chromePaused = false;
				return {
					resumed: true,
					recovered: true
				};
			}
			if (isNotPausedMessage(message)) throw new Error("target is not paused (resuming); pause or hit a breakpoint first");
			throw error;
		}
	}
	/** Reset all state (socket lost). */
	reset() {
		this.perTarget.clear();
		this.bySession.clear();
		for (const { event, fn } of this.listeners.splice(0)) try {
			this.client.off(event, fn);
		} catch {}
	}
	/** Resolve the target an event belongs to via its carrying session. */
	targetOfEvent(sessionId) {
		if (sessionId === void 0) return void 0;
		return this.bySession.get(sessionId);
	}
	/** Subscribe a routed event listener, tracked for reset(). */
	listen(event, handler) {
		this.client.on(event, handler);
		this.listeners.push({
			event,
			fn: handler
		});
	}
	assertPaused(targetId, doing) {
		if (this.stateOf(targetId).paused === null) throw new Error(`target is not paused (${doing}); pause or hit a breakpoint first`);
	}
	stateOf(targetId) {
		let state = this.perTarget.get(targetId);
		if (state === void 0) {
			state = {
				paused: null,
				scripts: /* @__PURE__ */ new Map(),
				breakpoints: /* @__PURE__ */ new Map(),
				session: null,
				chromePaused: false
			};
			this.perTarget.set(targetId, state);
		}
		return state;
	}
};
/** Messages meaning the breakpoint/pause is already gone Chrome-side. */
function isAlreadyGone(message) {
	return message.includes("Session with given id not found") || message.includes("Session not found") || message.includes("Target closed") || message.includes("Breakpoint at specified location not found") || message.includes("not found");
}
/** Messages meaning Chrome's debugger does not consider the target paused. */
function isNotPausedMessage(message) {
	return message.includes("Can only perform operation while paused") || message.includes("not paused");
}
/** Escape a user URL substring into a safe regex source. */
function escapeRegex(input) {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
//#endregion
//#region src/tools/targets.ts
/**
* Session cache keyed by targetId. Not a cordis Service: the dispatch layer
* owns one instance per connection generation.
*/
var TargetSessionManager = class {
	sessions = /* @__PURE__ */ new Map();
	/** Reverse map: sessionId → targetId, for event routing. */
	bySessionId = /* @__PURE__ */ new Map();
	eventUnsubscribers = [];
	closed = false;
	client;
	events;
	constructor(client, events = {}) {
		this.client = client;
		this.events = events;
	}
	/**
	* Enable auto-attach so new targets get sessions without an explicit attach.
	* Must be called once after the browser-level connection is up.
	*/
	async start() {
		this.listen("Target.attachedToTarget", (params) => {
			const p = params;
			const sessionId = p.sessionId;
			if (typeof sessionId !== "string") return;
			const targetId = p.targetInfo?.targetId ?? this.bySessionId.get(sessionId);
			if (typeof targetId !== "string") return;
			this.remember(targetId, sessionId);
			this.events.onSessionAttached?.(targetId, sessionId);
		});
		this.listen("Target.detachedFromTarget", (params) => {
			const p = params;
			const sessionId = p.sessionId;
			if (typeof sessionId !== "string") return;
			const targetId = p.targetId ?? this.bySessionId.get(sessionId);
			this.forget(sessionId);
			this.events.onSessionDetached?.(targetId, sessionId);
		});
		await this.client.send("Target.setAutoAttach", {
			autoAttach: true,
			waitForDebuggerOnStart: false,
			flatten: true
		});
	}
	/**
	* Get (or create) the session for a target.
	* @returns the flat sessionId and a send helper bound to it.
	*/
	async acquire(targetId) {
		this.assertLive();
		const existing = this.sessions.get(targetId);
		if (existing !== void 0) return this.sessionView(existing);
		const { sessionId } = await this.client.send("Target.attachToTarget", {
			targetId,
			flatten: true
		});
		this.remember(targetId, sessionId);
		return this.sessionView(this.sessions.get(targetId));
	}
	/** Whether a session exists for the target already. */
	has(targetId) {
		return this.sessions.has(targetId);
	}
	/** The cached session id for a target, when one exists. */
	sessionIdOf(targetId) {
		return this.sessions.get(targetId)?.sessionId;
	}
	/** All currently cached sessions. */
	entries() {
		return this.sessions;
	}
	/**
	* Ensure a domain is enabled on a session (idempotent per session).
	* @param domain - e.g. `Runtime`, `Network`, `Page`, `Debugger`.
	*/
	async ensureEnabled(domain, sessionId) {
		for (const entry of this.sessions.values()) {
			if (entry.sessionId !== sessionId) continue;
			if (entry.enabled.has(domain)) return;
			await this.client.send(`${domain}.enable`, void 0, sessionId);
			entry.enabled.add(domain);
			return;
		}
		await this.client.send(`${domain}.enable`, void 0, sessionId);
	}
	/** Mark a domain as already enabled (the manager sent the enable itself). */
	markEnabled(domain, sessionId) {
		for (const entry of this.sessions.values()) {
			if (entry.sessionId !== sessionId) continue;
			entry.enabled.add(domain);
			return;
		}
	}
	/** Drop everything (socket lost / manager disposed). */
	reset() {
		this.closed = true;
		this.sessions.clear();
		this.bySessionId.clear();
		for (const off of this.eventUnsubscribers.splice(0)) try {
			off();
		} catch {}
	}
	/** Forget one session (detached). */
	forget(sessionId) {
		const targetId = this.bySessionId.get(sessionId);
		this.bySessionId.delete(sessionId);
		if (targetId !== void 0) {
			const entry = this.sessions.get(targetId);
			if (entry !== void 0 && entry.sessionId === sessionId) this.sessions.delete(targetId);
		}
	}
	/** Cache a session either way (explicit attach or auto-attach event). */
	remember(targetId, sessionId) {
		const previous = this.sessions.get(targetId);
		if (previous !== void 0 && previous.sessionId !== sessionId) this.bySessionId.delete(previous.sessionId);
		this.sessions.set(targetId, {
			sessionId,
			enabled: /* @__PURE__ */ new Set()
		});
		this.bySessionId.set(sessionId, targetId);
	}
	/** Bound send helper for one session. */
	sessionView(entry) {
		return {
			sessionId: entry.sessionId,
			send: (method, params) => this.client.send(method, params, entry.sessionId),
			ensureEnabled: (domain) => this.ensureEnabled(domain, entry.sessionId)
		};
	}
	/** Subscribe with an unsubscriber that tolerates CRI's on() shape. */
	listen(event, listener) {
		this.client.on(event, listener);
		this.eventUnsubscribers.push(() => {
			try {
				this.client.off(event, listener);
			} catch {}
		});
	}
	assertLive() {
		if (this.closed) throw new Error("target sessions were reset (connection lost)");
	}
};
/** Pick the default page target from a /json/list style array. */
function pickDefaultTarget(targets) {
	const pages = targets.filter((t) => t.type === "page");
	if (pages.length === 0) return void 0;
	return (pages.find((t) => !t.url?.startsWith("devtools://") && t.url !== "about:blank" && t.url !== "") ?? pages[0]).id;
}
//#endregion
//#region src/tools/dispatch.ts
/**
* Per-call CDP wait budgets. Named so tests can shrink them (a real deadlock
* must surface in milliseconds, not after a 30s wall); production uses the
* defaults. Always below the tool-level `timeoutMs` backstop.
*/
const WAIT_BUDGETS = {
	/** Input dispatch (click/type) — the tools that deadlock on a pause. */
	input: 1e4,
	/** Runtime.evaluate — queueable forever on a paused target. */
	evaluate: 15e3,
	/** Page.navigate send (the load wait is separately bounded). */
	navigate: 1e4,
	/** Screenshot capture. */
	screenshot: 1e4,
	/** Debugger/breakpoint commands (fast protocol round-trips). */
	debug: 1e4,
	/** chrome_cdp raw pass-through. */
	raw: 3e4
};
/** Per-connection state, rebuilt on socket loss. */
var ToolDispatcher = class {
	generation;
	defaultTargetId;
	lastTargetUsed;
	bridge;
	constructor(bridge) {
		this.bridge = bridge;
	}
	/** Reset derived state (connection dropped). */
	reset() {
		if (this.generation !== void 0) {
			this.generation.sessions.reset();
			this.generation.debugger.reset();
		}
		this.generation = void 0;
		this.defaultTargetId = void 0;
	}
	/** Entry point for every tool execute(). */
	async dispatch(name, args, options = {}) {
		if (name !== "chrome_list_targets" && !this.connected()) return notConnected();
		try {
			return await this.route(name, args, options.signal);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("not-connected")) return notConnected();
			if (isSocketDeath(message)) this.reset();
			return { error: message };
		}
	}
	async route(name, args, signal) {
		switch (name) {
			case "chrome_list_targets": return this.listTargets();
			case "chrome_navigate": return this.navigate(argsOf(args), signal);
			case "chrome_evaluate": return this.evaluate(argsOf(args), signal);
			case "chrome_console": return this.console(argsOf(args));
			case "chrome_network": return this.network(argsOf(args));
			case "chrome_debug": return this.debug(argsOf(args), signal);
			case "chrome_breakpoint": return this.breakpoint(argsOf(args), signal);
			case "chrome_screenshot": return this.screenshot(argsOf(args), signal);
			case "chrome_click": return this.click(argsOf(args), signal);
			case "chrome_type": return this.type(argsOf(args), signal);
			case "chrome_cdp": return this.rawCdp(argsOf(args), signal);
			default: return { error: `unknown tool ${name}` };
		}
	}
	async listTargets() {
		if (!this.connected()) return notConnected();
		const targets = await this.bridge.listTargets();
		const paused = /* @__PURE__ */ new Set();
		const gen = this.ensureGeneration();
		for (const targetId of gen.sessions.entries().keys()) paused.add(targetId);
		const dbgPaused = /* @__PURE__ */ new Set();
		for (const t of targets) if (gen.debugger.pausedOf(t.id) !== null) dbgPaused.add(t.id);
		const fallback = this.defaultTargetId ?? pickDefaultTarget(targets);
		const defaultId = await this.resolveTargetId(void 0) ?? fallback;
		return { targets: targets.map((t) => ({
			id: t.id,
			type: t.type,
			title: t.title,
			url: t.url,
			isDefault: t.id === defaultId,
			paused: dbgPaused.has(t.id)
		})) };
	}
	async navigate(args, signal) {
		const url = readString(args.url);
		if (url === void 0) return { error: "url is required" };
		const session = await this.sessionFor(args, { wantPage: true });
		await session.ensureEnabled("Page");
		this.ensureGeneration().capture.ensureEnabled(session.sessionId, this.lastTargetUsed ?? "", []).catch(() => {});
		const nav = await waitBounded((signal) => session.send("Page.navigate", { url }), readInt(args.waitMs) ?? WAIT_BUDGETS.navigate, signal, "chrome_navigate");
		let loaded = nav.errorText === void 0;
		if (nav.errorText === void 0) loaded = await waitLoadEvent(session, readInt(args.waitMs) ?? 1e4);
		return {
			frameId: nav.frameId ?? "",
			loaderId: nav.loaderId ?? null,
			errorText: nav.errorText ?? null,
			loaded
		};
	}
	async evaluate(args, signal) {
		const expression = readString(args.expression);
		if (expression === void 0) return { error: "expression is required" };
		const targetId = await this.resolveTargetId(readString(args.targetId));
		if (targetId === void 0) return { error: "no page target available; pass targetId from chrome_list_targets" };
		if (this.ensureGeneration().debugger.pausedOf(targetId) !== null) return {
			error: "target is paused at a breakpoint",
			hint: "use chrome_debug eval instead"
		};
		const session = await this.sessionFor(args, { wantPage: true });
		await session.ensureEnabled("Runtime");
		const result = await waitBounded((signal) => session.send("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: readBool(args.awaitPromise) ?? true
		}), WAIT_BUDGETS.evaluate, signal, "chrome_evaluate");
		if (result.exceptionDetails !== void 0) return {
			type: "error",
			value: null,
			className: null,
			exceptionDetails: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluation threw"
		};
		const remote = result.result ?? {};
		return {
			type: remote.type ?? "undefined",
			value: serializeRemoteObject(remote),
			className: remote.className ?? null,
			exceptionDetails: null
		};
	}
	async console(args) {
		const targetId = await this.resolveTargetId(readString(args.targetId));
		if (targetId === void 0) return { error: "no page target available" };
		const session = await this.sessionFor(args, { wantPage: true });
		const gen = this.ensureGeneration();
		gen.capture.associate(session.sessionId, targetId);
		await gen.capture.ensureEnabled(session.sessionId, targetId, ["Runtime", "Log"]);
		const read = gen.capture.readConsole({
			targetId,
			level: readString(args.level) ?? void 0,
			text: readString(args.text) ?? void 0,
			afterSeq: readInt(args.cursor) ?? 0,
			limit: clampInt(readInt(args.limit), 1, 300, 50)
		});
		return {
			entries: read.entries,
			nextCursor: read.nextCursor
		};
	}
	async network(args) {
		const targetId = await this.resolveTargetId(readString(args.targetId));
		if (targetId === void 0) return { error: "no page target available" };
		const session = await this.sessionFor(args, { wantPage: true });
		const gen = this.ensureGeneration();
		gen.capture.associate(session.sessionId, targetId);
		await gen.capture.ensureEnabled(session.sessionId, targetId, ["Network"]);
		const read = gen.capture.readNetwork({
			targetId,
			url: readString(args.url) ?? void 0,
			resourceType: readString(args.resourceType) ?? void 0,
			minStatus: readInt(args.minStatus) ?? void 0,
			afterSeq: readInt(args.cursor) ?? 0,
			limit: clampInt(readInt(args.limit), 1, 500, 50)
		});
		return {
			requests: read.requests,
			nextCursor: read.nextCursor
		};
	}
	async debug(args, signal) {
		const action = readString(args.action);
		const targetId = await this.resolveTargetId(readString(args.targetId));
		if (targetId === void 0) return { error: "no page target available" };
		const gen = this.ensureGeneration();
		let sessionId = gen.debugger.sessionOf(targetId);
		if (sessionId === null) {
			const session = await this.sessionFor(args, { wantPage: true });
			await gen.debugger.attachSession(session.sessionId, targetId);
			gen.sessions.markEnabled("Debugger", session.sessionId);
			sessionId = session.sessionId;
		}
		switch (action) {
			case "status": {
				const paused = gen.debugger.pausedOf(targetId);
				return paused === null ? {
					paused: false,
					reason: null,
					callFrames: [],
					hitBreakpoints: []
				} : {
					paused: true,
					...paused
				};
			}
			case "pause":
				await waitBounded(() => this.client().send("Debugger.pause", void 0, sessionId), WAIT_BUDGETS.debug, signal, "chrome_debug pause");
				return {
					paused: true,
					hint: "pause requested; poll chrome_debug status until callFrames appear"
				};
			case "resume": {
				const result = await gen.debugger.resume(sessionId, targetId);
				return {
					paused: false,
					resumed: result.resumed,
					recovered: result.recovered ?? false
				};
			}
			case "step_into":
			case "step_over":
			case "step_out": {
				const kind = action === "step_into" ? "into" : action === "step_over" ? "over" : "out";
				await gen.debugger.step(sessionId, targetId, kind);
				return {
					paused: true,
					hint: "step issued; poll chrome_debug status for the new top frame"
				};
			}
			case "eval": {
				const expression = readString(args.expression);
				if (expression === void 0) return { error: "expression is required for eval" };
				const frameIndex = readInt(args.frame) ?? 0;
				return { value: serializeRemoteObject(await gen.debugger.evaluateOnFrame(sessionId, targetId, expression, frameIndex)) };
			}
			default: return { error: `unknown action ${String(action)}` };
		}
	}
	async breakpoint(args, signal) {
		const action = readString(args.action);
		const targetId = await this.resolveTargetId(readString(args.targetId));
		if (targetId === void 0) return { error: "no page target available" };
		const gen = this.ensureGeneration();
		let sessionId = gen.debugger.sessionOf(targetId);
		if (sessionId === null) {
			const session = await this.sessionFor(args, { wantPage: true });
			await gen.debugger.attachSession(session.sessionId, targetId);
			gen.sessions.markEnabled("Debugger", session.sessionId);
			sessionId = session.sessionId;
		}
		const pinned = sessionId;
		switch (action) {
			case "set": {
				const url = readString(args.url);
				const line = readInt(args.line);
				if (url === void 0 || line === void 0) return { error: "url and line are required for set" };
				return { breakpoint: await waitBounded(() => gen.debugger.setBreakpoint(pinned, targetId, {
					url,
					line,
					column: readInt(args.column) ?? void 0,
					condition: readString(args.condition) ?? void 0
				}), WAIT_BUDGETS.debug, signal, "chrome_breakpoint set") };
			}
			case "list": return { breakpoints: gen.debugger.breakpointsOf(targetId) };
			case "remove": {
				const id = readString(args.id);
				if (id === void 0) return { error: "id is required for remove" };
				return { removed: await waitBounded(() => gen.debugger.removeBreakpoint(pinned, targetId, id), WAIT_BUDGETS.debug, signal, "chrome_breakpoint remove") };
			}
			case "clear": try {
				return {
					cleared: true,
					removed: await waitBounded(() => gen.debugger.removeAllBreakpoints(pinned, targetId), WAIT_BUDGETS.debug, signal, "chrome_breakpoint clear")
				};
			} catch (error) {
				return {
					cleared: false,
					error: messageOf(error)
				};
			}
			case "scripts": return { scripts: gen.debugger.scriptsOf(targetId) };
			default: return { error: `unknown action ${String(action)}` };
		}
	}
	async screenshot(args, signal) {
		const format = readString(args.format) === "jpeg" ? "jpeg" : "png";
		const persist = readBool(args.persist) ?? this.bridge.attachmentsAvailable();
		const session = await this.sessionFor(args, { wantPage: true });
		await session.ensureEnabled("Page");
		const params = { format };
		if (format === "jpeg") params.quality = clampInt(readInt(args.quality), 0, 100, 80);
		const shot = await waitBounded(() => session.send("Page.captureScreenshot", params), WAIT_BUDGETS.screenshot, signal, "chrome_screenshot");
		if (typeof shot.data !== "string") return { error: "screenshot returned no data" };
		if (!persist) return {
			format,
			persisted: false,
			base64Bytes: shot.data.length,
			data: clipBase64(shot.data)
		};
		const bytes = Buffer.from(shot.data, "base64");
		const ref = await this.bridge.persistImage(new Uint8Array(bytes), `image/${format}`);
		if (ref === void 0) return {
			format,
			persisted: false,
			base64Bytes: shot.data.length,
			data: clipBase64(shot.data)
		};
		return {
			format,
			persisted: true,
			attachment: {
				attachmentId: ref.attachmentId,
				width: ref.width,
				height: ref.height
			}
		};
	}
	async click(args, signal) {
		const selector = readString(args.selector);
		const x = readInt(args.x);
		const y = readInt(args.y);
		const gen = this.ensureGeneration();
		const targetId = await this.resolveTargetId(readString(args.targetId));
		if (targetId !== void 0 && gen.debugger.pausedOf(targetId) !== null) return {
			error: "target is paused at a breakpoint; a click would hang until the handler resumes",
			hint: "run chrome_debug resume first (or remove the breakpoint), then retry the click"
		};
		const session = await this.sessionFor(args, { wantPage: true });
		await session.ensureEnabled("DOM");
		let point = {
			x: 0,
			y: 0
		};
		let element;
		if (selector !== void 0) {
			const located = await locateSelector(session, selector);
			if (typeof located === "string") return { error: located };
			point = located.point;
			element = located.element;
		} else if (x !== void 0 && y !== void 0) point = {
			x,
			y
		};
		else return { error: "selector or x/y coordinates are required" };
		await dispatchMouseBounded(session, point, signal);
		return {
			clicked: true,
			x: point.x,
			y: point.y,
			tag: element?.tag ?? null,
			id: element?.id ?? null,
			classes: element?.classes ?? null
		};
	}
	async type(args, signal) {
		const text = readString(args.text);
		if (text === void 0) return { error: "text is required" };
		const gen = this.ensureGeneration();
		const targetId = await this.resolveTargetId(readString(args.targetId));
		if (targetId !== void 0 && gen.debugger.pausedOf(targetId) !== null) return {
			error: "target is paused at a breakpoint; typing would hang until the handler resumes",
			hint: "run chrome_debug resume first (or remove the breakpoint), then retry"
		};
		const session = await this.sessionFor(args, { wantPage: true });
		const selector = readString(args.selector);
		if (selector !== void 0) {
			const located = await locateSelector(session, selector);
			if (typeof located === "string") return { error: located };
			await session.send("Input.insertText", { text: "" }).catch(() => {});
			await dispatchMouseBounded(session, located.point, signal);
		}
		await typeText(session, text);
		return {
			typed: true,
			length: text.length
		};
	}
	async rawCdp(args, signal) {
		const method = readString(args.method);
		if (method === void 0) return { error: "method is required" };
		if (!/^[A-Z][A-Za-z]+\.[a-zA-Z][A-Za-z0-9]*$/.test(method)) return { error: `invalid CDP method ${method}; expected Domain.method` };
		const explicitSession = readString(args.sessionId);
		if (explicitSession !== void 0) return { result: serializeCdpValue(await waitBounded(() => this.client().send(method, args.params, explicitSession), WAIT_BUDGETS.raw, signal, `chrome_cdp ${method}`)) };
		if (readString(args.targetId) === void 0) return { result: serializeCdpValue(await waitBounded(() => this.client().send(method, args.params), WAIT_BUDGETS.raw, signal, `chrome_cdp ${method}`)) };
		const session = await this.sessionFor(args, { wantPage: false });
		return { result: serializeCdpValue(await waitBounded(() => session.send(method, args.params), WAIT_BUDGETS.raw, signal, `chrome_cdp ${method}`)) };
	}
	connected() {
		return this.bridge.getClient() !== void 0 && this.bridge.getStatus().phase === "connected";
	}
	client() {
		const client = this.bridge.getClient();
		if (client === void 0) throw new Error("not-connected");
		return client;
	}
	ensureGeneration() {
		if (this.generation !== void 0) return this.generation;
		const client = this.client();
		const capture = new CaptureManager({});
		const sessions = new TargetSessionManager(client, {});
		const debuggerManager = new DebuggerManager(client);
		capture.bind(client);
		sessions.start().catch(() => {});
		this.generation = {
			sessions,
			capture,
			debugger: debuggerManager
		};
		return this.generation;
	}
	/** Resolve (and remember) the target a call operates on. */
	async resolveTargetId(explicit) {
		if (explicit !== void 0) {
			this.lastTargetUsed = explicit;
			return explicit;
		}
		if (this.defaultTargetId !== void 0) return this.defaultTargetId;
		const targets = await this.bridge.listTargets();
		this.defaultTargetId = pickDefaultTarget(targets);
		return this.defaultTargetId ?? this.lastTargetUsed;
	}
	/** Acquire the session for the call's target (or the default). */
	async sessionFor(args, options) {
		let targetId = readString(args.targetId);
		if (targetId === void 0) {
			if (this.defaultTargetId === void 0) {
				const targets = await this.bridge.listTargets();
				this.defaultTargetId = pickDefaultTarget(targets);
			}
			targetId = this.defaultTargetId;
			if (targetId === void 0) throw new Error("no page target available; pass targetId from chrome_list_targets");
		}
		this.lastTargetUsed = targetId;
		const gen = this.ensureGeneration();
		const session = await gen.sessions.acquire(targetId);
		gen.capture.associate(session.sessionId, targetId);
		return session;
	}
};
/** Structured not-connected reply shared by every tool. */
function notConnected() {
	return {
		error: "not-connected",
		hint: "open the Chrome CDP connection from the panel, or ask the user to start Chrome with --remote-debugging-port"
	};
}
/** Detect messages that mean the CDP socket died (or its flat session did). */
function isSocketDeath(message) {
	return message.includes("WebSocket") || message.includes("socket") || message.includes("Session with given id not found") || message.includes("Session not found") || message.includes("Target closed");
}
/** Narrow an unknown arg into a Record (never throws). */
function argsOf(args) {
	return typeof args === "object" && args !== null ? args : {};
}
function readString(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
function readInt(value) {
	return typeof value === "number" && Number.isInteger(value) ? value : void 0;
}
function readBool(value) {
	return typeof value === "boolean" ? value : void 0;
}
function clampInt(value, min, max, fallback) {
	if (value === void 0) return fallback;
	return Math.min(max, Math.max(min, value));
}
/** Wait for the frame's load event (bounded). */
async function waitLoadEvent(session, budgetMs) {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(false);
		}, budgetMs);
		timer.unref?.();
		const poll = setInterval(() => {
			session.send("Runtime.evaluate", {
				expression: "document.readyState",
				returnByValue: true
			}).then((result) => {
				if (result.result?.value === "complete" && !settled) {
					settled = true;
					clearInterval(poll);
					clearTimeout(timer);
					resolve(true);
				}
			}).catch(() => {});
		}, 150);
		poll.unref?.();
	});
}
/** Locate a selector: point + element descriptor, or an error string. */
async function locateSelector(session, selector) {
	const { root } = await session.send("DOM.getDocument", { depth: 0 });
	const nodeId = root?.nodeId;
	if (nodeId === void 0) return "DOM.getDocument returned no root";
	const found = await session.send("DOM.querySelector", {
		nodeId,
		selector
	});
	if (found.nodeId === void 0 || found.nodeId === 0) return `selector matched nothing: ${selector}`;
	const content = (await session.send("DOM.getBoxModel", { nodeId: found.nodeId })).model?.content;
	if (content === void 0 || content.length < 4) return `no box model for selector: ${selector}`;
	const xs = [
		content[0],
		content[2],
		content[4],
		content[6]
	];
	const ys = [
		content[1],
		content[3],
		content[5],
		content[7]
	];
	const point = {
		x: Math.round((Math.min(...xs) + Math.max(...xs)) / 2),
		y: Math.round((Math.min(...ys) + Math.max(...ys)) / 2)
	};
	const node = await session.send("DOM.describeNode", {
		nodeId: found.nodeId,
		depth: 0
	});
	const attributes = node.node?.attributes ?? [];
	const id = readAttribute(attributes, "id");
	const classes = readAttribute(attributes, "class");
	return {
		point,
		element: {
			tag: (node.node?.nodeName ?? "").toLowerCase(),
			id,
			classes
		}
	};
}
/** Read one attr from CDP's flat [name, value, ...] attribute array. */
function readAttribute(attributes, name) {
	for (let i = 0; i + 1 < attributes.length; i += 2) if (attributes[i] === name) return attributes[i + 1];
	return null;
}
/**
* Dispatch a trusted mouse click under a hard time budget.
*
* The press/release pair rides the page's event loop: a Debugger breakpoint
* parked inside a synchronous mouse handler suspends that loop and the CDP
* reply never arrives (the 2026-09 hang). Bounding the wait turns that freeze
* into a structured error with the recovery path, instead of a tool call that
* hangs until the harness aborts it.
*/
async function dispatchMouseBounded(session, point, signal, budgetMs = WAIT_BUDGETS.input) {
	const params = {
		x: point.x,
		y: point.y,
		button: "none",
		clickCount: 1
	};
	await waitBounded(() => session.send("Input.dispatchMouseEvent", {
		type: "mousePressed",
		...params,
		button: "left"
	}), budgetMs, signal, "mouse press");
	await waitBounded(() => session.send("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		...params,
		button: "left"
	}), budgetMs, signal, "mouse release");
}
/**
* Run one CDP send under a hard time budget, mapping a budget expiry onto a
* descriptive error (and honoring the caller's abort signal, which wins even
* if the send later settles). The underlying promise is NOT abortable at the
* protocol layer — this only stops *waiting* on it, which is exactly the
* deadlock the interaction tools must escape.
*/
async function waitBounded(send, budgetMs, signal, what) {
	if (signal?.aborted) throw new AbortedError(what);
	let timer;
	let onAbort;
	const budget = new Promise((_, reject) => {
		timer = setTimeout(() => {
			reject(new TimeoutError(what, budgetMs));
		}, budgetMs);
		timer.unref?.();
		if (signal !== void 0) {
			onAbort = () => {
				reject(new AbortedError(what));
			};
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
	try {
		return await Promise.race([send(signal), budget]);
	} finally {
		clearTimeout(timer);
		if (signal !== void 0 && onAbort !== void 0) signal.removeEventListener("abort", onAbort);
	}
}
/** Error when the per-call wait budget expired (the page stopped answering). */
var TimeoutError = class extends Error {
	constructor(what, budgetMs) {
		super(`${what} did not complete within ${budgetMs}ms — the page's main loop is likely suspended (breakpoint pause). Run chrome_debug resume, then retry.`);
		this.name = "ChromeCdpTimeout";
	}
};
/** Error when the harness cancelled the tool call while waiting. */
var AbortedError = class extends Error {
	constructor(what) {
		super(`${what} aborted: the tool call was cancelled while waiting for Chrome`);
		this.name = "ChromeCdpAborted";
	}
};
/** Best-effort human message of an unknown thrown value. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/** Type text through key events; falls back to insertText for non-ASCII. */
async function typeText(session, text) {
	if (!/^[\x20-\x7E]*$/.test(text)) {
		await session.send("Input.insertText", { text });
		return;
	}
	for (const char of text) {
		const keyCode = char.charCodeAt(0);
		const definition = keyDefinitions[char];
		await session.send("Input.dispatchKeyEvent", {
			type: "keyDown",
			key: char,
			text: char,
			nativeVirtualKeyCode: keyCode,
			windowsVirtualKeyCode: keyCode,
			...definition
		});
		await session.send("Input.dispatchKeyEvent", {
			type: "keyUp",
			key: char,
			nativeVirtualKeyCode: keyCode,
			windowsVirtualKeyCode: keyCode,
			...definition
		});
	}
}
/** Minimal key definitions for special characters typing needs. */
const keyDefinitions = {
	"\n": {
		key: "Enter",
		code: "Enter",
		windowsVirtualKeyCode: 13
	},
	"	": {
		key: "Tab",
		code: "Tab",
		windowsVirtualKeyCode: 9
	}
};
/** Clip a base64 payload for inline (non-persisted) screenshot results. */
function clipBase64(data, limit = 65536) {
	if (data.length <= limit) return data;
	return `${data.slice(0, limit)}…[truncated ${data.length - limit} chars]`;
}
//#endregion
//#region src/tools/index.ts
/** Services the tools fiber requires. */
const inject = ["tools"];
/** Convert one ParamSpec tree into the dsh-tools value-schema DSL object. */
function specToParameters(specs) {
	return specs;
}
/** Build the ToolDefinition for one spec. */
function buildTool(spec) {
	return defineTool({
		name: spec.name,
		description: spec.description,
		parameters: specToParameters(spec.parameters),
		timeoutMs: spec.timeoutMs,
		output: {
			schema: spec.output.schema,
			render: (args, value) => spec.output.render(args, value)
		},
		execute: async (args, exec) => {
			const bridge = bridgeModule.hostBridge.current;
			if (bridge === void 0) return {
				error: "chrome-cdp host half not loaded",
				hint: "ensure the dsh-chrome-cdp row is enabled in the host tree"
			};
			return await ensureDispatcher(bridge).dispatch(spec.name, args, exec?.signal === void 0 ? {} : { signal: exec.signal });
		}
	});
}
/** One dispatcher per bridge identity; rebuilt when the host re-registers. */
let dispatcherFor;
function ensureDispatcher(bridge) {
	if (dispatcherFor !== void 0 && dispatcherFor.bridge === bridge) return dispatcherFor.dispatcher;
	const dispatcher = new ToolDispatcher(bridge);
	dispatcherFor = {
		bridge,
		dispatcher
	};
	return dispatcher;
}
/** Tools plugin entry: register every non-gated tool on this fiber. */
function apply(ctx, config = {}) {
	const groups = config.groups ?? {};
	const gate = (group) => groups[group] !== false;
	for (const spec of TOOL_SPECS) {
		if (!gate(spec.group)) continue;
		ctx.effect(() => {
			const dispose = ctx.tools.register(buildTool(spec));
			return () => {
				dispose();
			};
		}, `chrome-cdp tools: ${spec.name}`);
	}
}
//#endregion
export { ToolDispatcher, apply, hostBridge, inject, registerHostBridge };

//# sourceMappingURL=tools.mjs.map