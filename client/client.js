window.__ModuleLoader__.load({
	id: "dsh-chrome-cdp",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_runtime_client = require("@deepseek-ai/dsh-client-runtime/client");
		//#region \0dsh-css:/home/chensg/code/dsh-chrome-cdp/src/client/CdpPanel.module.css.mjs
		const css = ".iCytDq_layer{flex:none;align-items:center;width:100%;height:42px;margin:8px 0 0;display:flex;position:relative}.iCytDq_footerButtons{align-items:center;width:100%;display:flex}.iCytDq_badge{width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;margin:0 -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;display:inline-flex;overflow:hidden}.iCytDq_badge:hover,.iCytDq_badge[data-active]{background:var(--dsw-alias-interactive-bg-hover)}.iCytDq_badgeLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.iCytDq_badgeCount{color:var(--dsw-alias-label-tertiary);flex:none;margin-left:auto;font-size:12px;line-height:16px}.iCytDq_layer.iCytDq_rail{width:36px;height:36px;margin:0}.iCytDq_rail .iCytDq_badge{justify-content:center;gap:0;width:36px;height:36px;margin:0;padding:0}.iCytDq_triggerDot{flex:none;justify-content:center;align-items:center;display:inline-flex}.iCytDq_panel{z-index:30;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);width:420px;max-width:calc(100vw - 24px);max-height:60vh;box-shadow:var(--dsw-shadow-lv3);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:12px;flex-direction:column;display:flex;position:fixed;overflow:hidden}.iCytDq_header{box-sizing:border-box;flex:none;justify-content:space-between;align-items:center;gap:8px;min-height:44px;padding:10px 12px;display:flex}.iCytDq_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:20px}.iCytDq_statusChip{background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);border-radius:999px;align-items:center;gap:6px;padding:2px 8px;font-size:12px;line-height:18px;display:inline-flex}.iCytDq_statusChip[data-phase=connected]{color:var(--dsw-alias-state-success)}.iCytDq_statusChip[data-phase=error]{color:var(--dsw-alias-state-error-primary)}.iCytDq_statusChip[data-phase=connecting]{color:var(--dsw-alias-label-secondary)}.iCytDq_body{flex-direction:column;flex:1;gap:10px;min-height:0;padding:0 12px 12px;display:flex;overflow-y:auto}.iCytDq_note{color:var(--dsw-alias-label-tertiary);margin:4px 0;font-size:12px;line-height:18px}.iCytDq_error{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-inverted);overflow-wrap:anywhere;border-radius:8px;margin:0;padding:6px 8px;font-size:12px;line-height:18px}.iCytDq_facts{grid-template-columns:1fr 1fr;gap:4px 12px;margin:0;display:grid}.iCytDq_facts>div{align-items:baseline;gap:6px;min-width:0;display:flex}.iCytDq_facts dt{color:var(--dsw-alias-label-tertiary);flex:none;font-size:12px}.iCytDq_facts dd{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-primary);margin:0;font-size:12px;overflow:hidden}.iCytDq_targets{border-top:1px solid var(--dsw-alias-border-l2);padding-top:8px}.iCytDq_targetsHead{justify-content:space-between;align-items:center;display:flex}.iCytDq_targetsHead h3{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;font-weight:500}.iCytDq_targets ul{flex-direction:column;gap:4px;margin:6px 0 0;padding:0;list-style:none;display:flex}.iCytDq_target{align-items:center;gap:8px;min-width:0;display:flex}.iCytDq_targetType{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);border-radius:6px;flex:none;padding:0 6px;font-size:11px;line-height:18px}.iCytDq_targetTitle{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden}.iCytDq_linkButton{color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px}.iCytDq_linkButton:hover:not(:disabled){color:var(--dsw-alias-label-primary)}.iCytDq_linkButton:disabled{opacity:.5;cursor:default}.iCytDq_form{border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:8px;padding-top:10px;display:flex}.iCytDq_formTitle{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;font-weight:500}.iCytDq_field{align-items:center;gap:8px;display:flex}.iCytDq_field span{width:96px;color:var(--dsw-alias-label-tertiary);flex:none;font-size:12px}.iCytDq_field input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);min-width:0;height:28px;color:var(--dsw-alias-label-primary);border-radius:8px;flex:1;padding:0 8px;font-family:inherit;font-size:12px}.iCytDq_field input:focus-visible{border-color:var(--dsw-alias-state-focus);outline:none}.iCytDq_check{color:var(--dsw-alias-label-secondary);cursor:pointer;align-items:center;gap:8px;font-size:12px;display:flex}.iCytDq_formActions{justify-content:flex-end;display:flex}.iCytDq_fieldError{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px}.iCytDq_actions{gap:8px;display:flex}.iCytDq_ensureClose{color:var(--dsw-alias-label-tertiary);cursor:pointer;align-items:center;gap:8px;font-size:12px;display:flex}.iCytDq_primary,.iCytDq_secondary{cursor:pointer;border-radius:8px;flex:1;height:30px;font-family:inherit;font-size:12px}.iCytDq_primary{background:var(--dsw-alias-state-focus);color:var(--dsw-alias-label-inverted);border:none}.iCytDq_primary:disabled{opacity:.5;cursor:default}.iCytDq_secondary{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}.iCytDq_secondary:disabled{opacity:.5;cursor:default}.iCytDq_primary:hover:not(:disabled),.iCytDq_secondary:hover:not(:disabled){filter:brightness(1.1)}.iCytDq_overlay{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);border-radius:999px;align-items:center;gap:6px;padding:4px 10px;font-size:12px;line-height:16px;display:inline-flex;position:relative}.iCytDq_overlayLabel{white-space:nowrap}";
		const tagId = "dsh-chrome-cdp/CdpPanel.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-chrome-cdp";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var CdpPanel_module_css_default = {
			"field": "iCytDq_field",
			"rail": "iCytDq_rail",
			"overlay": "iCytDq_overlay",
			"panel": "iCytDq_panel",
			"layer": "iCytDq_layer",
			"targets": "iCytDq_targets",
			"header": "iCytDq_header",
			"targetsHead": "iCytDq_targetsHead",
			"linkButton": "iCytDq_linkButton",
			"check": "iCytDq_check",
			"ensureClose": "iCytDq_ensureClose",
			"body": "iCytDq_body",
			"form": "iCytDq_form",
			"statusChip": "iCytDq_statusChip",
			"triggerDot": "iCytDq_triggerDot",
			"primary": "iCytDq_primary",
			"actions": "iCytDq_actions",
			"targetType": "iCytDq_targetType",
			"overlayLabel": "iCytDq_overlayLabel",
			"fieldError": "iCytDq_fieldError",
			"formActions": "iCytDq_formActions",
			"secondary": "iCytDq_secondary",
			"badgeLabel": "iCytDq_badgeLabel",
			"title": "iCytDq_title",
			"facts": "iCytDq_facts",
			"error": "iCytDq_error",
			"note": "iCytDq_note",
			"targetTitle": "iCytDq_targetTitle",
			"target": "iCytDq_target",
			"footerButtons": "iCytDq_footerButtons",
			"formTitle": "iCytDq_formTitle",
			"badge": "iCytDq_badge",
			"badgeCount": "iCytDq_badgeCount"
		};
		//#endregion
		//#region src/client/CdpPanel.tsx
		/**
		* Chrome CDP panel: sidebar footer trigger + anchored popover surface.
		*
		* The trigger lives in `sidebar.footer.action` and opens a fixed-position
		* popover (the sidebar clips overflow, so the surface is anchored by measured
		* offset, the same approach as the in-repo Cordis panel). It shows connection
		* status, connection parameters form, targets list, and connect/disconnect/
		* reconnect actions. All data flows through the injected face's hooks; the
		* component never touches the client context directly.
		*
		* @module dsh-chrome-cdp/client/CdpPanel
		*/
		/** Map the wire phase onto the StateDot four-color semantic. */
		function dotStateOf(status, rpcError) {
			if (rpcError !== void 0) return "error";
			switch (status?.phase) {
				case "connected": return "done";
				case "connecting": return "ongoing";
				case "error": return "error";
				case "disconnected": return "warning";
				default: return "warning";
			}
		}
		/** Locale key for the current phase. */
		function statusKeyOf(status) {
			switch (status?.phase) {
				case "connected": return "status.connected";
				case "connecting": return "status.connecting";
				case "error": return "status.error";
				case "disconnected": return "status.disconnected";
				default: return "status.unknown";
			}
		}
		function formOf(status, params) {
			const host = status?.host ?? params?.host ?? "127.0.0.1";
			const port = status?.port ?? params?.port ?? 9222;
			const autoReconnect = status?.autoReconnect ?? params?.autoReconnect ?? true;
			const delay = params?.reconnectDelaySeconds ?? 5;
			return {
				host,
				port: String(port),
				autoReconnect,
				reconnectDelaySeconds: String(delay)
			};
		}
		/** Parse the form into params; undefined when a numeric field is invalid. */
		function parseForm(form) {
			const port = Number.parseInt(form.port, 10);
			const delay = Number.parseInt(form.reconnectDelaySeconds, 10);
			if (!Number.isInteger(port) || port < 1 || port > 65535) return void 0;
			if (!Number.isInteger(delay) || delay < 1 || delay > 600) return void 0;
			if (form.host.trim() === "") return void 0;
			return {
				host: form.host.trim(),
				port,
				autoReconnect: form.autoReconnect,
				reconnectDelaySeconds: delay
			};
		}
		/** Render the panel and its sidebar footer trigger. */
		function CdpPanel({ wide, useStatus, onConnect, onDisconnect, onReconnect, onEnsureChrome, onSetParams, onRefreshTargets, t }) {
			const state = useStatus((snapshot) => snapshot);
			const status = state.status;
			const [open, setOpen] = (0, react.useState)(false);
			const [busy, setBusy] = (0, react.useState)(void 0);
			const [actionError, setActionError] = (0, react.useState)(void 0);
			const [saved, setSaved] = (0, react.useState)(false);
			const [closeRunning, setCloseRunning] = (0, react.useState)(false);
			const [form, setForm] = (0, react.useState)(() => formOf(void 0, void 0));
			const rootRef = (0, react.useRef)(null);
			const [anchor, setAnchor] = (0, react.useState)();
			const seeded = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				if (status === void 0 || seeded.current) return;
				seeded.current = true;
				setForm(formOf(status, void 0));
			}, [status]);
			(0, react.useLayoutEffect)(() => {
				if (!open) return;
				const place = () => {
					const rect = rootRef.current?.getBoundingClientRect();
					if (rect !== void 0) setAnchor({
						left: rect.left,
						bottom: window.innerHeight - rect.top + 8
					});
				};
				place();
				window.addEventListener("resize", place);
				return () => {
					window.removeEventListener("resize", place);
				};
			}, [open]);
			(0, _deepseek_ai_dsh_client_ui_primitives.useDismissOnOutsidePointer)(rootRef, open, setOpen);
			const dot = dotStateOf(status, state.rpcError);
			const statusLabel = state.rpcError !== void 0 ? t("status.error") : t(statusKeyOf(status));
			const runAction = async (id, action) => {
				if (busy !== void 0) return;
				setBusy(id);
				setActionError(void 0);
				try {
					const result = await action();
					if (!result.ok) setActionError(result.message ?? "operation failed");
				} catch (error) {
					setActionError(error instanceof Error ? error.message : String(error));
				} finally {
					setBusy(void 0);
				}
			};
			const parsed = parseForm(form);
			status !== void 0 && (form.host.trim() !== status.host || Number.parseInt(form.port, 10) !== status.port || (form.autoReconnect, status.autoReconnect));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: rootRef,
				className: wide ? CdpPanel_module_css_default.layer : `${CdpPanel_module_css_default.layer} ${CdpPanel_module_css_default.rail}`,
				children: [open && anchor !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
					className: CdpPanel_module_css_default.panel,
					style: anchor,
					"data-cdp-panel": true,
					"aria-label": t("panel.title"),
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: CdpPanel_module_css_default.header,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: CdpPanel_module_css_default.title,
							children: t("panel.title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: CdpPanel_module_css_default.statusChip,
							"data-phase": status?.phase ?? "unknown",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: dot }), statusLabel]
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: CdpPanel_module_css_default.body,
						children: [
							state.rpcError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: CdpPanel_module_css_default.note,
								role: "alert",
								children: t("panel.rpcFailed", { message: state.rpcError })
							}),
							state.rpcError === void 0 && status === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: CdpPanel_module_css_default.note,
								children: t("panel.loading")
							}),
							status !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", {
									className: CdpPanel_module_css_default.facts,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("info.browser") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: status.browserVersion ?? "—" })] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("info.targets") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: String(status.targets.length) })] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("info.attempts") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: String(status.attempts) })] }),
										status.connectedAt !== void 0 && status.connectedAt !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("info.connectedAt") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: new Date(status.connectedAt).toLocaleTimeString() })] })
									]
								}),
								status.error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: CdpPanel_module_css_default.error,
									role: "alert",
									children: t("error.label", { message: status.error })
								}),
								status.targets.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
									className: CdpPanel_module_css_default.targets,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: CdpPanel_module_css_default.targetsHead,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t("info.targets") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: CdpPanel_module_css_default.linkButton,
											disabled: busy !== void 0,
											onClick: () => {
												runAction("targets", onRefreshTargets);
											},
											children: t("targets.refresh")
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", { children: status.targets.slice(0, 8).map((target) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
										className: CdpPanel_module_css_default.target,
										title: target.url,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: CdpPanel_module_css_default.targetType,
											children: target.type
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: CdpPanel_module_css_default.targetTitle,
											children: target.title || target.url
										})]
									}, target.id)) })]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
									className: CdpPanel_module_css_default.form,
									onSubmit: (event) => {
										event.preventDefault();
										if (parsed === void 0) return;
										runAction("save", async () => {
											const result = await onSetParams(parsed);
											if (result.ok) {
												setSaved(true);
												window.setTimeout(() => {
													setSaved(false);
												}, 2e3);
											}
											return result;
										});
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
											className: CdpPanel_module_css_default.formTitle,
											children: t("form.title")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											className: CdpPanel_module_css_default.field,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("form.host") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												value: form.host,
												spellCheck: false,
												onChange: (event) => {
													setForm({
														...form,
														host: event.target.value
													});
												}
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											className: CdpPanel_module_css_default.field,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("form.port") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												value: form.port,
												inputMode: "numeric",
												onChange: (event) => {
													setForm({
														...form,
														port: event.target.value
													});
												}
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											className: CdpPanel_module_css_default.field,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("form.reconnectDelay") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												value: form.reconnectDelaySeconds,
												inputMode: "numeric",
												onChange: (event) => {
													setForm({
														...form,
														reconnectDelaySeconds: event.target.value
													});
												}
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											className: CdpPanel_module_css_default.check,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "checkbox",
												checked: form.autoReconnect,
												onChange: (event) => {
													setForm({
														...form,
														autoReconnect: event.target.checked
													});
												}
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("form.autoReconnect") })]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: CdpPanel_module_css_default.formActions,
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "submit",
												className: CdpPanel_module_css_default.primary,
												disabled: parsed === void 0 || busy !== void 0,
												children: saved ? t("form.saved") : t("form.save")
											})
										}),
										parsed === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: CdpPanel_module_css_default.fieldError,
											role: "alert",
											children: t("panel.badPayload")
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: CdpPanel_module_css_default.actions,
									children: [
										status.phase === "connected" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: CdpPanel_module_css_default.primary,
											disabled: busy !== void 0,
											onClick: () => {
												runAction("reconnect", onReconnect);
											},
											children: t("action.reconnect")
										}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: CdpPanel_module_css_default.primary,
											disabled: busy !== void 0 || status.phase === "connecting",
											onClick: () => {
												runAction("connect", onConnect);
											},
											children: t("action.connect")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: CdpPanel_module_css_default.secondary,
											disabled: busy !== void 0 || status.phase === "disconnected",
											onClick: () => {
												runAction("disconnect", onDisconnect);
											},
											children: t("action.disconnect")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: CdpPanel_module_css_default.secondary,
											disabled: busy !== void 0 || status.phase === "connected",
											title: t("action.ensureHint"),
											onClick: () => {
												if (closeRunning && !window.confirm(t("action.ensureConfirm"))) return;
												runAction("ensure", () => onEnsureChrome(closeRunning ? { closeRunning: true } : void 0));
											},
											children: t("action.ensure")
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: CdpPanel_module_css_default.ensureClose,
									title: t("action.ensureHint"),
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: closeRunning,
										onChange: (event) => {
											setCloseRunning(event.target.checked);
										}
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("action.ensureCloseLabel") })]
								}),
								actionError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: CdpPanel_module_css_default.error,
									role: "alert",
									children: t("action.error", { message: actionError })
								})
							] })
						]
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: CdpPanel_module_css_default.footerButtons,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: CdpPanel_module_css_default.badge,
						"data-active": open || void 0,
						"aria-label": t("panel.trigger"),
						"aria-expanded": open,
						onClick: () => {
							setOpen((value) => !value);
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: CdpPanel_module_css_default.triggerDot,
								"data-state": dot,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
									state: dot,
									size: wide ? 10 : 12
								})
							}),
							wide && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: CdpPanel_module_css_default.badgeLabel,
								children: t("panel.trigger")
							}),
							wide && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: CdpPanel_module_css_default.badgeCount,
								children: statusLabel
							})
						]
					})
				})]
			});
		}
		/** Persistent bottom-right status pill (click toggles nothing; display only). */
		function CdpOverlay({ useStatus, t }) {
			const state = useStatus((snapshot) => snapshot);
			const dot = dotStateOf(state.status, state.rpcError);
			const label = state.rpcError !== void 0 ? t("status.error") : t(statusKeyOf(state.status));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: CdpPanel_module_css_default.overlay,
				"data-cdp-overlay": true,
				"aria-label": t("overlay.label"),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: dot }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: CdpPanel_module_css_default.overlayLabel,
					children: label
				})]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* Locale dictionaries for the Chrome CDP panel.
		*
		* @module dsh-chrome-cdp/client/locales
		*/
		/** Every key the panel renders, per locale. */
		const CDP_LOCALES = {
			en: {
				"panel.title": "Chrome CDP",
				"panel.trigger": "Chrome CDP",
				"panel.loading": "Loading connection status…",
				"panel.rpcFailed": "Cannot reach the host: {message}",
				"panel.badPayload": "Unexpected host reply.",
				"status.disconnected": "Disconnected",
				"status.connecting": "Connecting…",
				"status.connected": "Connected",
				"status.error": "Error",
				"status.unknown": "Unknown",
				"info.browser": "Browser",
				"info.targets": "Targets",
				"info.wsUrl": "WebSocket",
				"info.connectedAt": "Since",
				"info.attempts": "Attempts",
				"info.host": "Host",
				"info.port": "Port",
				"info.autoReconnect": "Auto-reconnect",
				"info.reconnectDelay": "Retry delay (s)",
				"error.label": "Last error: {message}",
				"targets.empty": "No attachable targets",
				"targets.refresh": "Refresh targets",
				"form.title": "Connection parameters",
				"form.host": "Host",
				"form.port": "Port",
				"form.autoReconnect": "Auto-reconnect when the socket drops",
				"form.reconnectDelay": "Retry delay (seconds)",
				"form.save": "Save & reconnect",
				"form.saved": "Saved",
				"action.ensure": "Ensure Chrome",
				"action.ensureHint": "Launch a separate Chrome with a CDP port when the endpoint is not answering. Existing Chrome is left open.",
				"action.ensureCloseLabel": "Before launch, close the running Chrome",
				"action.ensureConfirm": "This will close the running Chrome (unsaved page state is lost) and relaunch it with the debugging port. Continue?",
				"action.ensureNone": "Endpoint already answers; Chrome untouched.",
				"action.ensureStarted": "Chrome started with the debugging port.",
				"action.ensureStartedUntouched": "A separate Chrome started with the debugging port; the existing Chrome was left open.",
				"action.ensureRestarted": "Chrome restarted with the debugging port.",
				"action.ensureFailed": "Could not bring up a CDP-capable Chrome.",
				"action.connect": "Connect",
				"action.disconnect": "Disconnect",
				"action.reconnect": "Reconnect",
				"action.busy": "Working…",
				"action.error": "Action failed: {message}",
				"overlay.label": "Chrome CDP connection"
			},
			zh: {
				"panel.title": "Chrome CDP",
				"panel.trigger": "Chrome CDP",
				"panel.loading": "正在加载连接状态…",
				"panel.rpcFailed": "无法连接宿主: {message}",
				"panel.badPayload": "宿主返回了意外的数据。",
				"status.disconnected": "未连接",
				"status.connecting": "连接中…",
				"status.connected": "已连接",
				"status.error": "错误",
				"status.unknown": "未知",
				"info.browser": "浏览器",
				"info.targets": "目标数",
				"info.wsUrl": "WebSocket",
				"info.connectedAt": "连接时间",
				"info.attempts": "尝试次数",
				"info.host": "主机",
				"info.port": "端口",
				"info.autoReconnect": "自动重连",
				"info.reconnectDelay": "重试间隔(秒)",
				"error.label": "最后错误: {message}",
				"targets.empty": "没有可附加的目标",
				"targets.refresh": "刷新目标列表",
				"form.title": "连接参数",
				"form.host": "主机",
				"form.port": "端口",
				"form.autoReconnect": "Socket 断开时自动重连",
				"form.reconnectDelay": "重试间隔(秒)",
				"form.save": "保存并重连",
				"form.saved": "已保存",
				"action.ensure": "检测并启动 Chrome",
				"action.ensureHint": "端点不可用时启动一个独立的带 CDP 端口的 Chrome 实例,不关闭已打开的 Chrome。",
				"action.ensureCloseLabel": "启动前先关闭正在运行的 Chrome",
				"action.ensureConfirm": "将关闭正在运行的 Chrome(未保存的页面状态会丢失),并以调试端口重新启动。继续?",
				"action.ensureNone": "端点已可用,Chrome 未做改动。",
				"action.ensureStarted": "已启动带调试端口的 Chrome。",
				"action.ensureStartedUntouched": "已另起一个带调试端口的独立 Chrome 实例,原 Chrome 保持打开。",
				"action.ensureRestarted": "已重启 Chrome 并带调试端口。",
				"action.ensureFailed": "无法拉起可 CDP 连接的 Chrome。",
				"action.connect": "连接",
				"action.disconnect": "断开",
				"action.reconnect": "重连",
				"action.busy": "处理中…",
				"action.error": "操作失败: {message}",
				"overlay.label": "Chrome CDP 连接"
			}
		};
		//#endregion
		//#region src/client/stores.ts
		/**
		* Client stores: one polled observable over the `/cdp` RPC channel.
		*
		* The Host pushes nothing (custom host→client events are not forwarded to
		* out-of-tree plugins), so the panel polls `status` on an interval, after
		* every action, and on `connection/reset`. A generation counter discards
		* stale replies that arrive after a newer refresh started.
		*
		* @module dsh-chrome-cdp/client/stores
		*/
		const INITIAL_STATUS_STATE = {
			status: void 0,
			rpcError: void 0,
			generation: 0
		};
		/**
		* The polled status store backing both the sidebar panel and the overlay dot.
		* @param runtime - RPC caller plus reset signal.
		* @returns the snapshot store and its `refresh` action.
		*/
		function createCdpStatusStore(runtime) {
			const store = (0, _deepseek_ai_dsh_client_runtime_client.createSnapshotStore)(INITIAL_STATUS_STATE);
			let generation = 0;
			let inFlight;
			const refresh = () => {
				if (inFlight !== void 0) return inFlight;
				const mine = ++generation;
				inFlight = (async () => {
					const result = await runtime.call("status");
					if (mine !== generation) return;
					if (result.ok) {
						if (isCdpStatus(result.value)) store.set({
							status: result.value,
							rpcError: void 0,
							generation: mine
						});
						else store.set({
							status: void 0,
							rpcError: "unexpected status payload",
							generation: mine
						});
					} else store.set({
						status: void 0,
						rpcError: result.error,
						generation: mine
					});
					inFlight = void 0;
				})().catch(() => {
					if (mine === generation) inFlight = void 0;
				});
				return inFlight;
			};
			return {
				store,
				refresh
			};
		}
		/** Structural check for a Host status reply. */
		function isCdpStatus(value) {
			if (typeof value !== "object" || value === null) return false;
			const raw = value;
			return typeof raw.phase === "string" && typeof raw.host === "string" && typeof raw.port === "number" && Array.isArray(raw.targets);
		}
		/** Extract the runtime handle from a client context in one call site. */
		function runtimeOf(ctx) {
			const connection = ctx.get("connection");
			return {
				call: async (endpoint, payload) => {
					const result = await connection.rpc.call("/cdp", endpoint, payload ?? null);
					return result.ok ? {
						ok: true,
						value: result.value
					} : {
						ok: false,
						error: result.error.message
					};
				},
				onReset: (listener) => ctx.on("connection/reset", listener)
			};
		}
		//#endregion
		//#region src/client/index.ts
		/** Locale namespace this plugin owns. */
		const NS = "chrome-cdp";
		/** Client services this plugin consumes (cordis fiber inject). */
		const inject = [
			"connection",
			"locale",
			"slots"
		];
		/** How often the idle poll re-checks host status. */
		const POLL_INTERVAL_MS = 2e3;
		function apply(ctx) {
			ctx.locale.register(NS, {
				en: CDP_LOCALES.en,
				zh: CDP_LOCALES.zh
			});
			const runtime = runtimeOf(ctx);
			const { store, refresh } = createCdpStatusStore(runtime);
			const t = ctx.locale.bind(NS);
			refresh();
			const poll = setInterval(() => {
				refresh();
			}, POLL_INTERVAL_MS);
			ctx.effect(() => () => {
				clearInterval(poll);
			}, "chrome-cdp: status poll timer");
			ctx.on("connection/reset", () => {
				refresh();
			});
			/** Run an RPC action, mapping the envelope into the panel outcome. */
			const runAction = async (endpoint, payload, pick) => {
				const result = await runtime.call(endpoint, payload);
				if (!result.ok) return {
					ok: false,
					message: result.error
				};
				const value = result.value;
				if (value !== void 0 && typeof value.error === "string") return {
					ok: false,
					message: value.error
				};
				if (pick !== void 0) return pick(result.value);
				return { ok: true };
			};
			const face = {
				hooks: { status: store },
				onConnect: async () => runAction("connect"),
				onDisconnect: async () => {
					const outcome = await runAction("disconnect");
					refresh();
					return outcome;
				},
				onReconnect: async () => {
					await runtime.call("disconnect");
					return runAction("connect");
				},
				onEnsureChrome: async (options) => runAction("ensure", options ?? void 0, (raw) => {
					const value = raw;
					if (!value.endpointReady) return {
						ok: false,
						message: value.error ?? value.hint ?? "endpoint did not become ready"
					};
					const key = value.action === "none" ? "action.ensureNone" : value.action === "started" ? value.existingUntouched ? "action.ensureStartedUntouched" : "action.ensureStarted" : "action.ensureRestarted";
					return {
						ok: true,
						message: t(key)
					};
				}),
				onSetParams: async (params) => runAction("setParams", params),
				onRefreshTargets: async () => {
					const outcome = await runAction("targets");
					refresh();
					return outcome;
				}
			};
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "chrome-cdp-panel",
				order: 15,
				locale: NS,
				inject: () => face
			}, CdpPanel));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "chrome-cdp-overlay",
				order: 90,
				locale: NS,
				inject: () => ({ hooks: { status: store } })
			}, CdpOverlay));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map