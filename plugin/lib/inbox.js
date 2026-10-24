// wxshare plugin — inbox watcher (host half, T5).
// ESM, zero dependencies. Watches <root>\Ready for share batches dropped by
// the WeChat share-target stub (T1/T2 manifest contract: lowercase keys,
// Z-suffix UTC createdAt), reports each batch once via onBatch, prunes stale
// Ready/Done entries by TTL.

import { watch } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, copyFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_SWEEP_MS = 6 * 3600_000;
const DEFAULT_READY_TTL_MS = 30 * 86400_000;
const DEFAULT_DONE_TTL_MS = 7 * 86400_000;
const POLL_FALLBACK_MS = 2000;

function readyDir(root) {
  return path.join(root, "Ready");
}
function doneDir(root) {
  return path.join(root, "Done");
}

// Read one Ready\<batchId> directory. Returns BatchInfo or null (corrupt /
// incomplete — caller logs via onLog when invoked from the watcher).
async function readBatch(root, batchId, now = Date.now()) {
  const dir = path.join(readyDir(root), batchId);
  let raw;
  try {
    raw = await readFile(path.join(dir, "manifest.json"), "utf8");
  } catch {
    return { ok: false, reason: "manifest missing/unreadable" };
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "manifest corrupt JSON" };
  }
  if (!manifest || typeof manifest.batchId !== "string" || !Array.isArray(manifest.items)) {
    return { ok: false, reason: "manifest missing batchId/items" };
  }
  // completeness: every manifest item must exist on disk with the declared size
  const items = [];
  let totalBytes = 0;
  for (const it of manifest.items) {
    let st;
    try {
      st = await stat(path.join(dir, it.relativePath));
    } catch {
      return { ok: false, reason: `item missing: ${it.relativePath}` };
    }
    if (st.size !== it.size) {
      return { ok: false, reason: `item size mismatch: ${it.relativePath}` };
    }
    items.push({ name: it.name, size: it.size, relativePath: it.relativePath });
    totalBytes += it.size;
  }
  return {
    ok: true,
    batch: {
      batchId: manifest.batchId,
      createdAt: manifest.createdAt,
      directory: dir,
      items,
      totalBytes,
      fresh: true,
    },
  };
}

// Scan <root>\Ready → BatchInfo[] (corrupt/incomplete dirs are skipped).
export async function scanReady(root, onLog = () => {}) {
  const out = [];
  let dirs;
  try {
    dirs = await readdir(readyDir(root), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const r = await readBatch(root, d.name);
    if (r.ok) out.push(r.batch);
    else onLog(`scanReady: skipping ${d.name}: ${r.reason}`);
  }
  return out;
}

// Move Ready\<batchId> → Done\<yyyyMMdd>\<batchId> (manifest + files kept).
export async function moveToDone(root, batchId, outcome = "moved") {
  const from = path.join(readyDir(root), batchId);
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const destParent = path.join(doneDir(root), day);
  await mkdir(destParent, { recursive: true });
  const to = path.join(destParent, batchId);
  try {
    await rename(from, to);
  } catch {
    // cross-device / transient lock: copy tree then remove source
    await copyTree(from, to);
    await rm(from, { recursive: true, force: true });
  }
  return to;
}

async function copyTree(src, dst) {
  await mkdir(dst, { recursive: true });
  for (const e of await readdir(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyTree(s, d);
    else await copyFile(s, d);
  }
}

// createInboxWatcher — see plan T5 interface.
export function createInboxWatcher({
  root,
  onBatch,
  onLog = () => {},
  sweepMs = DEFAULT_SWEEP_MS,
  readyTtlMs = DEFAULT_READY_TTL_MS,
  doneTtlMs = DEFAULT_DONE_TTL_MS,
  now = Date.now,
} = {}) {
  if (!root) throw new Error("createInboxWatcher: root required");
  if (typeof onBatch !== "function") throw new Error("createInboxWatcher: onBatch required");

  const seen = new Set();
  let disposed = false;
  let pollTimer = null;
  let watchHandle = null;
  let watchFallbackLogged = false;
  let sweepChain = Promise.resolve();

  async function pruneDir(p, ttlMs, label, t) {
    let st;
    try {
      st = await stat(p);
    } catch {
      return;
    }
    if (t - st.mtimeMs > ttlMs) {
      try {
        await rm(p, { recursive: true, force: true });
        onLog(`sweep: pruned stale ${label} ${path.basename(p)}`);
      } catch (err) {
        onLog(`sweep: prune failed ${label} ${path.basename(p)}: ${err.message}`);
      }
    }
  }

  // Ready: batch dirs directly under <root>\Ready (one level).
  async function pruneReady(ttlMs, t) {
    let entries;
    try {
      entries = await readdir(readyDir(root), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      await pruneDir(path.join(readyDir(root), e.name), ttlMs, "Ready", t);
    }
  }

  // Done: <root>\Done\<yyyyMMdd>\<batchId> — prune stale BATCH dirs (two
  // levels; the date folder's own mtime is fresh by construction), then
  // remove date folders left empty.
  async function pruneDone(ttlMs, t) {
    let days;
    try {
      days = await readdir(doneDir(root), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of days) {
      if (!d.isDirectory()) continue;
      const dayDir = path.join(doneDir(root), d.name);
      let batches;
      try {
        batches = await readdir(dayDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const b of batches) {
        if (!b.isDirectory()) continue;
        await pruneDir(path.join(dayDir, b.name), ttlMs, "Done", t);
      }
      // empty date folder cleanup
      let remaining;
      try {
        remaining = await readdir(dayDir);
      } catch {
        continue;
      }
      if (remaining.length === 0) {
        try {
          await rm(dayDir, { recursive: true, force: true });
        } catch {}
      }
    }
  }

  async function sweepOnce() {
    if (disposed) return;
    // TTL pruning
    const t = now();
    await pruneReady(readyTtlMs, t);
    await pruneDone(doneTtlMs, t);
    // batch discovery (each batchId reported once)
    const batches = await scanReady(root, (msg) => onLog(msg));
    for (const b of batches) {
      if (seen.has(b.batchId)) continue;
      seen.add(b.batchId);
      b.fresh = true;
      try {
        onBatch(b);
      } catch (err) {
        onLog(`onBatch threw for ${b.batchId}: ${err.message}`);
      }
    }
  }

  // serialize sweeps (watch events + polling + startup must not interleave)
  function sweepNow() {
    sweepChain = sweepChain.then(sweepOnce).catch((err) => onLog(`sweep error: ${err.message}`));
    return sweepChain;
  }

  function startPolling() {
    if (pollTimer || disposed) return;
    pollTimer = setInterval(() => sweepNow(), POLL_FALLBACK_MS);
    pollTimer.unref?.();
  }

  async function start() {
    await mkdir(readyDir(root), { recursive: true });
    await mkdir(doneDir(root), { recursive: true });
    // startup sweep: pick up batches dropped while DSH was not running
    sweepNow();
    try {
      watchHandle = watch(readyDir(root), { recursive: true }, () => sweepNow());
      watchHandle.on("error", (err) => {
        if (!watchFallbackLogged) {
          watchFallbackLogged = true;
          onLog(`fs.watch failed (${err.message}); falling back to ${POLL_FALLBACK_MS}ms polling`);
        }
        try {
          watchHandle?.close();
        } catch {}
        watchHandle = null;
        startPolling();
      });
    } catch (err) {
      if (!watchFallbackLogged) {
        watchFallbackLogged = true;
        onLog(`fs.watch unavailable (${err.message}); falling back to ${POLL_FALLBACK_MS}ms polling`);
      }
      startPolling();
    }
  }

  void start();

  return {
    sweepNow,
    async dispose() {
      disposed = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (watchHandle) {
        try {
          watchHandle.close();
        } catch {}
        watchHandle = null;
      }
      await sweepChain.catch(() => {});
    },
  };
}
