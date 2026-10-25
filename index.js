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
import { readFileSync } from "node:fs";

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

// Y4 (review): the webserver is bound to 127.0.0.1 — any local process can
// POST. deliver/dismiss bodies are a few dozen bytes; cap at 1MB and reply
// 413 beyond that (no unbounded Buffer.concat).
const MAX_BODY_BYTES = 1024 * 1024;

async function readJsonBody(req, res) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > MAX_BODY_BYTES) {
      sendJson(res, 413, { ok: false, code: "body-too-large", message: "request body exceeds 1MB" });
      req.destroy?.();
      return null;
    }
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// The stub writes to <Root>\inbox\{Ready,Staging,Done} (InboxPaths.cs:
// InboxRoot = Path.Combine(Root, "inbox")); the watcher root must be the
// INBOX directory, not the wxshare root.
export function defaultInboxRoot() {
  const appdata = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appdata, "dsh-desktop", "harness", "wxshare", "inbox");
}

// ── apply ─────────────────────────────────────────────────────────────────

// Module-level wiring state: HMR may re-run apply() without disposing the
// previous wiring (a failed bundle prepare mid-apply leaks routes/watchers).
// apply() is idempotent: re-entry tears down the previous wiring first.
let liveWiring = null;

export function apply(ctx, config = {}) {
  if (liveWiring) {
    const prev = liveWiring;
    liveWiring = null;
    try {
      prev.disposeAll();
    } catch {
      /* best effort */
    }
  }

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

  // Session detail enrichment: the sessions snapshot store (host service
  // `ctx.get("sessions")`, asar-verified: list.getSnapshot().byId[sessionId]
  // → {sessionId, updatedAt, running, blank, cwd?, title?, ...}). Synchronous
  // and cheap — safe to call per state request. Falls back to the session id
  // suffix when a summary is missing or has no title.
  function sessionSummaries() {
    try {
      const svc = ctx.get("sessions");
      const byId = svc?.list?.getSnapshot?.()?.byId ?? {};
      return byId;
    } catch {
      return {};
    }
  }

  // Persistent session metadata from the projection cache
  // (<dshHome>\storages\session_projcache\sessions\<id>.json — real shape:
  // record.rows.title.val, record.rows.sessionListMetadata.val.lastPromptAt).
  // The live summary store carries no titles, so the friendly labels (and
  // recency ordering) come from here. Read lazily and cached per session id
  // (the state route is polled every 2s — no re-reads).
  const dshHome = config.dshHome ?? process.env.DSH_HOME ?? path.join(
    process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
    "dsh-desktop", "harness"
  );
  const projCache = new Map(); // sessionId → {meta, at, missing?}
  // Y7 (review): a MISSING entry is time-sensitive — sessions created while
  // DSH runs get their projcache file shortly after (GUI projection), so a
  // negative cache must expire (default 60s) or new sessions show id suffixes
  // for the whole process lifetime. Positive entries are stable (the title
  // rarely changes) and cache long.
  const projCacheTtlMs = config.projCacheTtlMs ?? 60_000;

  function sessionProjMeta(sessionId) {
    const hit = projCache.get(sessionId);
    if (hit && (!hit.meta.missing || Date.now() - hit.at < projCacheTtlMs)) {
      return hit.meta;
    }
    let meta = { missing: true };
    try {
      const raw = readFileSync(path.join(dshHome, "storages", "session_projcache", "sessions", sessionId + ".json"), "utf8");
      const doc = JSON.parse(raw);
      const rows = doc?.record?.rows ?? {};
      meta = {
        title: typeof rows.title?.val === "string" && rows.title.val.length > 0 ? rows.title.val : undefined,
        lastPromptAt: rows.sessionListMetadata?.val?.lastPromptAt ?? undefined,
        blank: rows.sessionListMetadata?.val?.blank === true ? true : undefined,
      };
    } catch {
      meta = { missing: true };
    }
    projCache.set(sessionId, { meta, at: Date.now() });
    return meta;
  }

  async function projectWorkspaces() {
    const reg = ctx.get("workspaceRegistry");
    if (!reg?.list) return { workspaces: [], degraded: "workspaceRegistry" };
    try {
      const list = await reg.list();
      const byId = sessionSummaries();
      const workspaces = (Array.isArray(list) ? list : []).map((ws) => {
        // REAL host shape: sessionIds (string[]). Duck-typing fallback for
        // object-array shapes (test harnesses).
        let ids = [];
        if (Array.isArray(ws.sessionIds)) ids = ws.sessionIds;
        else if (Array.isArray(ws.sessions)) ids = ws.sessions.map((s) => (typeof s === "string" ? s : s.id ?? s.sessionId ?? ""));
        const sessions = ids
          .filter(Boolean)
          .map((id) => {
            const s = byId[id] ?? {};
            const pm = sessionProjMeta(id);
            const liveTitle = typeof s.title === "string" && s.title.length > 0 ? s.title : undefined;
            const title = liveTitle || pm.title;
            return {
              id,
              // blank sessions without any title are hidden (GUI sidebar
              // parity — cold empty sessions have no conversation to deliver
              // into and no label to show); a titled session is always kept.
              hidden: !title && (s.blank === true || pm.blank === true),
              title: title || id.slice(-12),
              cwd: s.cwd ?? "",
              // projcache lastPromptAt is the GUI sidebar's recency source
              // (the "N 小时前" labels); prefer it over the live snapshot.
              updatedAt: pm.lastPromptAt ?? s.updatedAt ?? s.lastPromptAt ?? null,
              running: !!s.running,
            };
          })
          .filter((s) => !s.hidden)
          .map(({ hidden, ...rest }) => rest);
        // most recently active session first (updatedAt desc, nulls last)
        sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
        return {
          path: ws.path ?? ws.root ?? "",
          title: ws.title ?? ws.name ?? path.basename(ws.path ?? ws.root ?? ""),
          sessions,
        };
      });
      // most recently active workspace first
      workspaces.sort(
        (a, b) =>
          (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0)
      );
      return { workspaces, degraded: undefined };
    } catch (err) {
      onLog(`workspaceRegistry.list failed: ${err.message}`);
      return { workspaces: [], degraded: "workspaceRegistry" };
    }
  }

  // ── routes (conditional inject: webServer may be undefined at apply) ────
  // webServer.register(route) returns an UNREGISTER function (host-webserver
  // source: `return () => table.delete(route.path)`) — capture all three so
  // the wiring teardown detaches them (idempotent apply on HMR re-runs).
  const unregisters = [];
  if (typeof ctx.inject === "function") {
    ctx.inject(["webServer"], (httpCtx) => {
      const webServer = httpCtx.get("webServer");
      if (!webServer) {
        onLog("webServer unavailable — routes not mounted; inbox keeps accumulating (degraded mode)");
        return;
      }

      const unregState = webServer.register({
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
      if (typeof unregState === "function") unregisters.push(unregState);

      const unregDeliver = webServer.register({
        kind: "exact",
        path: "/wxshare/api/deliver",
        handler: async (req, res) => {
          const body = await readJsonBody(req, res);
          if (body === null) return; // 413 already sent
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
                // Y6 (review): a hung host service must not wedge the whole
                // serial chain — overall 10min timeout, then the chain frees.
                const DELIVER_TIMEOUT_MS = 10 * 60_000;
                const result = await Promise.race([
                  deliverBatch({ batch, sessionId, services, onLog: (m) => onLog(m) }),
                  new Promise((_, reject) =>
                    setTimeout(() => reject(new DeliverError("gateway/timeout", `delivery timed out after ${DELIVER_TIMEOUT_MS / 60000}min`)), DELIVER_TIMEOUT_MS).unref?.()
                  ),
                ]);
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
      if (typeof unregDeliver === "function") unregisters.push(unregDeliver);

      const unregDismiss = webServer.register({
        kind: "exact",
        path: "/wxshare/api/dismiss",
        handler: async (req, res) => {
          const body = await readJsonBody(req, res);
          if (body === null) return; // 413 already sent
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
      if (typeof unregDismiss === "function") unregisters.push(unregDismiss);

      onLog("routes mounted: /wxshare/api/state|deliver|dismiss");
    });
  } else {
    onLog("ctx.inject unavailable — routes not mounted (degraded mode)");
  }

  // disposer
  const disposeAll = async () => {
    for (const unreg of unregisters.splice(0)) {
      try {
        unreg();
      } catch {
        /* best effort */
      }
    }
    await watcher.dispose();
    onLog("wiring disposed");
  };
  liveWiring = { disposeAll };
  return async function dispose() {
    if (liveWiring) liveWiring = null;
    await disposeAll();
    onLog("disposed");
  };
}
