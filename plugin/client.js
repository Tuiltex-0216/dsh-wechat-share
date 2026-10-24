/**
 * dsh-wechat-share client half — shell.overlay delivery picker.
 *
 * Authored directly in the DSH client module format (window.__ModuleLoader__),
 * the same delivery shape as dsh-wechat's prebuilt client bundle: the host-side
 * client-modules service serves this file at /plugins/dsh-wechat-share/client.js
 * and the browser kernel loads it. Communicates with the host through the
 * plugin's own HTTP API (/wxshare/api/*) registered on the GUI webserver —
 * no @deepseek-ai imports at runtime.
 *
 * Behavior: 2s polling of GET /wxshare/api/state (paused while the document
 * is hidden); when a Ready batch is pending a full-screen mask card appears:
 * batch summary, workspace→session two-level radio list (default = most
 * recently active session), 投递/忽略 actions. Success auto-closes after 1.5s;
 * failure shows code+message and keeps the batch for retry.
 */
window.__ModuleLoader__.load({
	id: "dsh-wechat-share",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const createElement = react.createElement;
		const { useState, useEffect, useRef } = react;

		const inject = ["slots"];

		// Component-local styles. Theme via --dsw-alias-* tokens (fallbacks
		// inline); class names wxshare- prefixed.
		const css = `
.wxshare-mask{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);backdrop-filter:blur(2px)}
.wxshare-card{width:min(520px,92vw);max-height:84vh;overflow:auto;border:1px solid var(--dsw-alias-border,#444);border-radius:14px;background:var(--dsw-alias-surface,#1e1e1e);color:var(--dsw-alias-text,#eee);padding:18px 20px;display:flex;flex-direction:column;gap:12px;box-shadow:0 12px 40px rgba(0,0,0,.5)}
.wxshare-title{font-weight:600;font-size:15px}
.wxshare-batch{display:flex;flex-direction:column;gap:4px;border:1px solid var(--dsw-alias-border,#444);border-radius:10px;padding:10px 12px}
.wxshare-item{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wxshare-meta{font-size:12px;color:var(--dsw-alias-label-secondary,#999);margin-top:4px}
.wxshare-list{display:flex;flex-direction:column;gap:8px;max-height:34vh;overflow:auto;padding:2px}
.wxshare-ws{display:flex;flex-direction:column;gap:4px}
.wxshare-ws-head{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#999);text-transform:uppercase;letter-spacing:.04em}
.wxshare-sess{display:flex;align-items:center;gap:8px;font-size:13px;padding:4px 8px;border-radius:8px;cursor:pointer}
.wxshare-sess:hover{background:rgba(128,128,128,.12)}
.wxshare-sess input{margin:0}
.wxshare-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:4px}
.wxshare-btn{cursor:pointer;font-size:13px;padding:7px 16px;border-radius:9px;border:1px solid var(--dsw-alias-border,#555);background:transparent;color:inherit}
.wxshare-btn:hover{background:rgba(128,128,128,.14)}
.wxshare-btn:disabled{opacity:.5;cursor:default}
.wxshare-btn.primary{border-color:transparent;background:var(--dsw-alias-accent,#1f6feb);color:#fff}
.wxshare-btn.primary:hover{filter:brightness(1.1)}
.wxshare-ok{color:var(--dsw-alias-success,#2e7d32);font-size:13px}
.wxshare-err{color:var(--dsw-alias-danger,#c62828);font-size:13px;word-break:break-all}
.wxshare-spin{width:14px;height:14px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;display:inline-block;animation:wxshare-rot .8s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes wxshare-rot{to{transform:rotate(360deg)}}
`;

		/** Idempotent module-level <style> (dsh-wechat pattern). */
		function ensureStyles() {
			let tag = document.querySelector('style[data-plugin-css="dsh-wechat-share/overlay"]');
			if (!tag) {
				tag = document.createElement("style");
				tag.setAttribute("data-plugin-css", "dsh-wechat-share/overlay");
				tag.textContent = css;
				document.head.appendChild(tag);
			}
			return tag;
		}

		// Same-origin relative API (the plugin's own webserver routes).
		async function api(pathName, opts = {}) {
			const res = await fetch(pathName, {
				method: opts.method ?? "GET",
				headers: opts.body ? { "Content-Type": "application/json" } : undefined,
				body: opts.body ? JSON.stringify(opts.body) : undefined,
			});
			return res.json().catch(() => ({}));
		}

		function formatSize(bytes) {
			const mb = Number(bytes) / (1024 * 1024);
			return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(Number(bytes) / 1024))} KB`;
		}

		function formatTime(iso) {
			if (!iso) return "";
			const d = new Date(iso);
			if (Number.isNaN(d.getTime())) return String(iso);
			const p = (n) => String(n).padStart(2, "0");
			return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
		}

		function WxShareOverlay() {
			useEffect(() => {
				ensureStyles();
			}, []);

			const [state, setState] = useState(null); // {ok, pending, workspaces, degraded?}
			const [sel, setSel] = useState(null); // {wsPath, sessionId, sessionTitle}
			const [busy, setBusy] = useState(false);
			const [result, setResult] = useState(null); // {kind:'ok'|'err', text}
			const timer = useRef(null);

			// 2s polling; paused while the document is hidden.
			useEffect(() => {
				let alive = true;
				async function poll() {
					if (!alive) return;
					if (document.visibilityState === "visible") {
						try {
							const s = await api("/wxshare/api/state");
							if (alive && s && s.ok) setState(s);
						} catch {
							/* transient — next tick */
						}
					}
					timer.current = setTimeout(poll, 2000);
				}
				poll();
				return () => {
					alive = false;
					if (timer.current) clearTimeout(timer.current);
				};
			}, []);

			// Default selection: most recently active session across workspaces.
			useEffect(() => {
				if (!state || !Array.isArray(state.pending) || state.pending.length === 0) return;
				if (sel) return;
				const wsList = (state.workspaces || []).filter((w) => Array.isArray(w.sessions) && w.sessions.length > 0);
				let best = null;
				for (const w of wsList) {
					for (const s of w.sessions) {
						if (!best || String(s.updatedAt || "") > String(best.updatedAt || "")) {
							best = { wsPath: w.path, sessionId: s.id, sessionTitle: s.title || s.id, updatedAt: s.updatedAt };
						}
					}
				}
				if (best) setSel(best);
			}, [state]); // eslint-disable-line react-hooks/exhaustive-deps

			// Success → auto close after 1.5s.
			useEffect(() => {
				if (result && result.kind === "ok") {
					const t = setTimeout(() => {
						setResult(null);
						setState(null);
					}, 1500);
					return () => clearTimeout(t);
				}
			}, [result]);

			if (!state || !Array.isArray(state.pending) || state.pending.length === 0) return null;

			const batch = state.pending[0];
			const queued = state.pending.length - 1;
			const workspaces = (state.workspaces || []).filter((w) => Array.isArray(w.sessions) && w.sessions.length > 0);
			const degraded = state.degraded === "workspaceRegistry" || workspaces.length === 0;

			async function deliver() {
				if (!sel || busy || result?.kind === "ok") return;
				setBusy(true);
				setResult(null);
				try {
					const r = await api("/wxshare/api/deliver", {
						method: "POST",
						body: { batchId: batch.batchId, sessionId: sel.sessionId },
					});
					if (r && r.ok) setResult({ kind: "ok", text: `已投递到「${sel.sessionTitle}」` });
					else setResult({ kind: "err", text: `${r?.code ?? "unknown"}：${r?.message ?? "投递失败"}` });
				} catch (e) {
					setResult({ kind: "err", text: String(e) });
				}
				setBusy(false);
			}

			async function dismiss() {
				if (busy) return;
				setBusy(true);
				try {
					await api("/wxshare/api/dismiss", { method: "POST", body: { batchId: batch.batchId } });
				} catch {
					/* best effort */
				}
				setBusy(false);
				setResult(null);
				setState(null);
			}

			return createElement(
				"div",
				{ className: "wxshare-mask", role: "dialog", "aria-modal": "true" },
				createElement("div", { className: "wxshare-card" },
					createElement("div", { className: "wxshare-title" }, "微信聊天记录待投递"),
					createElement("div", { className: "wxshare-batch" },
						(batch.items || []).map((it) =>
							createElement("div", { key: it.relativePath, className: "wxshare-item" },
								`${it.name}　${formatSize(it.size)}`)),
						createElement("div", { className: "wxshare-meta" },
							`共 ${formatSize(batch.totalBytes)} · ${formatTime(batch.createdAt)}` +
							(queued > 0 ? ` · 还有 ${queued} 批排队` : ""))),
					degraded
						? createElement("div", { className: "wxshare-err" }, "无法读取会话列表，请打开任意会话后重试")
						: null,
					createElement("div", { className: "wxshare-list" },
						workspaces.map((w) =>
							createElement("div", { key: w.path, className: "wxshare-ws" },
								createElement("div", { className: "wxshare-ws-head" }, w.title || w.path),
								w.sessions.map((s) =>
									createElement("label", { key: s.id, className: "wxshare-sess" },
										createElement("input", {
											type: "radio",
											name: "wxshare-session",
											checked: sel?.sessionId === s.id,
											disabled: busy,
											onChange: () => setSel({ wsPath: w.path, sessionId: s.id, sessionTitle: s.title || s.id }),
										}),
										` ${s.title || s.id}`))))),
					result
						? createElement("div", { className: result.kind === "ok" ? "wxshare-ok" : "wxshare-err" }, result.text)
						: null,
					createElement("div", { className: "wxshare-actions" },
						createElement("button", {
							type: "button",
							className: "wxshare-btn primary",
							disabled: busy || !sel || degraded || result?.kind === "ok",
							onClick: deliver,
						}, busy ? createElement("span", { className: "wxshare-spin" }) : null, busy ? " 投递中…" : " 投递"),
						createElement("button", {
							type: "button",
							className: "wxshare-btn",
							disabled: busy,
							onClick: dismiss,
						}, "忽略"))),
			);
		}

		function apply(ctx) {
			// Park the registration on the plugin's fiber (dsh-wechat pattern):
			// slots.inject returns a disposer; ctx.effect owns it so unload
			// unregisters cleanly.
			const register = () => ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "wxshare",
				order: 10,
				label: "微信直转",
			}, WxShareOverlay));
			if (ctx.effect) ctx.effect(register);
			else register();
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
