// wxshare plugin — host half entry (T7).
// ESM, zero deps. apply(ctx, config) wires:
//   - the Ready/Done inbox watcher (lib/inbox.js)
//   - three webServer routes (conditional inject — webServer is not ready
//     at apply time; the host enables it after webStartup resolves):
//       GET  /wxshare/api/state   → {ok, pending, workspaces, degraded?}
//       POST /wxshare/api/deliver → {ok, requestId} | {ok:false, code, message}
//       POST /wxshare/api/dismiss → {ok:true}
//   Delivery orchestration lives in lib/deliver.js (batch-preserving errors).

import path from "node:path";
import os from "node:os";

import { createInboxWatcher, scanReady, moveToDone } from "./lib/inbox.js";
import { deliverBatch, DeliverError } from "./lib/deliver.js";

export const name = "dsh-wechat-share";
export const inject = [];

// ── tiny http utilities (same shape as dsh-wechat; local, no import) ──────

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function defaultInboxRoot() {
  const appdata = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appdata, "dsh-desktop", "harness", "wxshare");
}

// ── apply ─────────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  const onLog = (msg) => ctx.logger?.info?.(`[dsh-wechat-share] ${msg}`);
  const inboxRoot = config.inboxRoot ?? defaultInboxRoot();

  // pending cache: watcher increments + deliver/dismiss remove; state falls
  // back to an immediate scan when the cache is empty (cold start race).
  const pending = new Map(); // batchId → BatchInfo

  const watcher = createInboxWatcher({
    root: inboxRoot,
    onLog: (msg) => onLog(msg),
    onBatch: (b) => {
      pending.set(b.batchId, b);
      onLog(`batch ready: ${b.batchId} (${b.items.length} file(s), ${b.totalBytes} B)`);
    },
  });

  // serial delivery slot (one prompt chain at a time — concurrency guard)
  let deliverChain = Promise.resolve();

  function findBatch(batchId) {
    return pending.get(batchId) ?? null;
  }

  async function projectWorkspaces() {
    const reg = ctx.get("workspaceRegistry");
    if (!reg?.list) return { workspaces: [], degraded: "workspaceRegistry" };
    try {
      const list = await reg.list();
      const workspaces = (Array.isArray(list) ? list : []).map((ws) => ({
        path: ws.path ?? ws.root ?? "",
        title: ws.title ?? ws.name ?? path.basename(ws.path ?? ws.root ?? ""),
        sessions: (ws.sessions ?? []).map((s) => ({
          id: s.id ?? s.sessionId ?? "",
          title: s.title ?? s.name ?? "",
          cwd: s.cwd ?? s.directory ?? "",
          updatedAt: s.updatedAt ?? s.lastActivityAt ?? null,
        })),
      }));
      return { workspaces, degraded: undefined };
    } catch (err) {
      onLog(`workspaceRegistry.list failed: ${err.message}`);
      return { workspaces: [], degraded: "workspaceRegistry" };
    }
  }

  // ── routes (conditional inject: webServer may be undefined at apply) ────
  if (typeof ctx.inject === "function") {
    ctx.inject(["webServer"], (httpCtx) => {
      const webServer = httpCtx.get("webServer");
      if (!webServer) {
        onLog("webServer unavailable — routes not mounted; inbox keeps accumulating (degraded mode)");
        return;
      }

      webServer.register({
        kind: "exact",
        path: "/wxshare/api/state",
        handler: async (_req, res) => {
          if (pending.size === 0) {
            try {
              const scanned = await scanReady(inboxRoot, (m) => onLog(m));
              for (const b of scanned) if (!pending.has(b.batchId)) pending.set(b.batchId, b);
            } catch (err) {
              onLog(`state fallback scan failed: ${err.message}`);
            }
          }
          const { workspaces, degraded } = await projectWorkspaces();
          sendJson(res, 200, {
            ok: true,
            pending: [...pending.values()],
            workspaces,
            ...(degraded ? { degraded } : {}),
          });
        },
      });

      webServer.register({
        kind: "exact",
        path: "/wxshare/api/deliver",
        handler: async (req, res) => {
          const body = await readJsonBody(req);
          const { batchId, sessionId } = body ?? {};
          if (!batchId || !sessionId) {
            sendJson(res, 400, { ok: false, code: "bad-request", message: "batchId and sessionId required" });
            return;
          }
          const batch = findBatch(batchId);
          if (!batch) {
            sendJson(res, 400, { ok: false, code: "batch-not-found", message: `unknown batch ${batchId}` });
            return;
          }
          const services = {
            fileUploads: ctx.get("fileUploads"),
            sessionController: ctx.get("sessionController"),
          };
          deliverChain = deliverChain
            .then(async () => {
              try {
                const result = await deliverBatch({ batch, sessionId, services, onLog: (m) => onLog(m) });
                await moveToDone(inboxRoot, batchId, "delivered");
                pending.delete(batchId);
                return result;
              } catch (err) {
                if (err instanceof DeliverError) {
                  onLog(`deliver ${batchId} failed (${err.code}); batch preserved in Ready`);
                  return { ok: false, code: err.code, message: err.message };
                }
                onLog(`deliver ${batchId} failed: ${err.message}`);
                return { ok: false, code: "gateway/internal", message: err.message };
              }
            })
            .catch((err) => ({ ok: false, code: "gateway/internal", message: err.message }));
          const result = await deliverChain;
          sendJson(res, 200, result);
        },
      });

      webServer.register({
        kind: "exact",
        path: "/wxshare/api/dismiss",
        handler: async (req, res) => {
          const body = await readJsonBody(req);
          const { batchId } = body ?? {};
          if (!batchId) {
            sendJson(res, 400, { ok: false, code: "bad-request", message: "batchId required" });
            return;
          }
          if (!findBatch(batchId)) {
            sendJson(res, 400, { ok: false, code: "batch-not-found", message: `unknown batch ${batchId}` });
            return;
          }
          try {
            await moveToDone(inboxRoot, batchId, "dismissed");
            pending.delete(batchId);
            sendJson(res, 200, { ok: true });
          } catch (err) {
            onLog(`dismiss ${batchId} failed: ${err.message}`);
            sendJson(res, 500, { ok: false, code: "gateway/internal", message: err.message });
          }
        },
      });

      onLog("routes mounted: /wxshare/api/state|deliver|dismiss");
    });
  } else {
    onLog("ctx.inject unavailable — routes not mounted (degraded mode)");
  }

  // disposer
  return async function dispose() {
    await watcher.dispose();
    onLog("disposed");
  };
}
