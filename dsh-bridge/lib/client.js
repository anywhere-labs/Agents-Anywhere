window.__ModuleLoader__.load({
	id: "@agents-anywhere/dsh-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/index.tsx
		/** Client services required by the status entry. */
		const inject = ["slots", "sessions"];
		/** Register a visible AA Bridge status control in the DSH Desktop shell. */
		function apply(ctx) {
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "agents-anywhere-bridge",
				order: 80
			}, (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AgentsAnywhereBridgeStatus, {
				ctx,
				...props
			})));
		}
		function AgentsAnywhereBridgeStatus({ useSessions }) {
			const [open, setOpen] = (0, react.useState)(false);
			const sessionId = useSessions((state) => state.current);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("aside", {
				style: shellStyle,
				"data-agents-anywhere-bridge": "",
				children: [open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
					style: panelStyle,
					role: "status",
					"aria-label": "Agents Anywhere Bridge 状态",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
							style: titleStyle,
							children: "Agents Anywhere Bridge"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: copyStyle,
							children: "SDK 服务已由 DSH Desktop 托管"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: hintStyle,
							children: "Agents Anywhere Connector 通过本机端点连接此进程。"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: hintStyle,
							children: sessionId === void 0 ? "当前未选择会话。" : `当前会话：${sessionId}`
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					style: buttonStyle,
					"aria-expanded": open,
					"aria-label": "打开 Agents Anywhere Bridge 状态",
					onClick: () => {
						setOpen((value) => !value);
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: dotStyle,
						"aria-hidden": "true"
					}), "AA Bridge"]
				})]
			});
		}
		const shellStyle = {
			position: "absolute",
			right: 18,
			bottom: 18,
			display: "flex",
			flexDirection: "column",
			alignItems: "flex-end",
			gap: 8,
			color: "var(--dsw-alias-text-primary, #f5f5f5)",
			fontFamily: "inherit"
		};
		const panelStyle = {
			boxSizing: "border-box",
			width: 280,
			display: "flex",
			flexDirection: "column",
			gap: 6,
			padding: "14px 16px",
			border: "1px solid var(--dsw-alias-border-l2, #454545)",
			borderRadius: 12,
			background: "var(--dsw-alias-bg-overlay, #262626)",
			boxShadow: "0 12px 36px rgba(0, 0, 0, 0.28)"
		};
		const titleStyle = {
			fontSize: 14,
			lineHeight: 1.4
		};
		const copyStyle = {
			fontSize: 13,
			color: "var(--dsw-alias-text-success, #7ee787)"
		};
		const hintStyle = {
			fontSize: 12,
			lineHeight: 1.5,
			color: "var(--dsw-alias-text-secondary, #b5b5b5)"
		};
		const buttonStyle = {
			display: "inline-flex",
			alignItems: "center",
			gap: 8,
			padding: "9px 13px",
			border: "1px solid var(--dsw-alias-border-l2, #454545)",
			borderRadius: 999,
			background: "var(--dsw-alias-button-floating-fill, #2f2f2f)",
			color: "inherit",
			font: "inherit",
			fontSize: 13,
			cursor: "pointer",
			boxShadow: "0 6px 20px rgba(0, 0, 0, 0.22)"
		};
		const dotStyle = {
			width: 8,
			height: 8,
			borderRadius: "50%",
			background: "#3fb950",
			boxShadow: "0 0 0 3px rgba(63, 185, 80, 0.14)"
		};
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map