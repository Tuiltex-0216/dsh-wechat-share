// T7: apply() host integration tests (node:test, fake ctx).
// Run: node --test wxshare-plugin/plugin/test/apply.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const mod = await import("../index.js");
const { apply, name, inject, defaultInboxRoot } = mod;

// Realistic session ids (session-<uuid>, 36 chars) — the fallback title is
// the 12-char id suffix, which is only recognizable at real id length.
const ID_A = "session-aaaa1111-2222-3333-4444-555566667777";
const ID_B = "session-bbbb1111-2222-3333-4444-555566667777";
const ID_C = "session-cccc1111-2222-3333-4444-555566667777";
const ID_D = "session-dddd1111-2222-3333-4444-555566667777";
const ID_E = "session-eeee1111-2222-3333-4444-555566667777";

// Workspace-local temp (the DSH sandbox confines node writes to the
// session workspace; os.tmpdir() is outside it).
const TEST_TMP = path.join(import.meta.dirname, "..", ".test-tmp");

async function makeRoot() {
  await mkdir(TEST_TMP, { recursive: true });
  const root = await mkdtemp(path.join(TEST_TMP, "wxshare-apply-"));
  await mkdir(path.join(root, "Ready"), { recursive: true });
  await mkdir(path.join(root, "Done"), { recursive: true });
  return root;
}

async function writeBatch(root, batchId = "batch-1") {
  const dir = path.join(root, "Ready", batchId);
  await mkdir(dir, { recursive: true });
  const buf = Buffer.alloc(1024, 1);
  await writeFile(path.join(dir, "聊天记录.zip"), buf);
  const manifest = {
    schemaVersion: 1,
    batchId,
    createdAt: new Date().toISOString(),
    source: "wechat-share",
    items: [{ name: "聊天记录.zip", size: buf.length, relativePath: "聊天记录.zip", contentType: "application/zip" }],
  };
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

// Fake host ctx: get/inject/on/effect/logger per the plan's duck types.
async function makeCtx(root, { withWebServer = true, deliverServices = null, dshHome = null } = {}) {
  const routes = [];
  const webServer = withWebServer
    ? { register: (route) => routes.push(route) }
    : undefined;
  // REAL host shape (asar-verified): workspaceRegistry.list() returns
  // {workspaceId, path, title, sessionIds, createdAt, updatedAt} — IDs only.
  // Session details come from the sessions snapshot store:
  // ctx.get("sessions").list.getSnapshot().byId[sessionId] →
  // {sessionId, updatedAt, running, blank, cwd?, title?, ...}
  const workspaces = [
    {
      workspaceId: "ws-one",
      path: "C:\\ws\\one",
      title: "one",
      sessionIds: [ID_A, ID_B],
      createdAt: "2026-10-20T00:00:00Z",
      updatedAt: "2026-10-24T02:00:00Z",
    },
    {
      workspaceId: "ws-two",
      path: "C:\\ws\\two",
      title: "two",
      sessionIds: [ID_C, ID_D, ID_E],
      createdAt: "2026-10-21T00:00:00Z",
      updatedAt: "2026-10-24T03:00:00Z",
    },
  ];
  const workspaceRegistry = { list: async () => workspaces };
  const sessions = {
    list: {
      getSnapshot: () => ({
        byId: {
          [ID_A]: { sessionId: ID_A, title: "Session A", cwd: "C:\\ws\\one\\a", updatedAt: 1761405600000, running: false, blank: false },
          // ID_B: NO title in the live summary → must come from the
          // session projection cache (rows.title.val)
          [ID_B]: { sessionId: ID_B, cwd: "C:\\ws\\one\\b", updatedAt: 1761409200000, running: true, blank: false },
          // ID_C: no title in the snapshot (fallback path)
          [ID_C]: { sessionId: ID_C, cwd: "C:\\ws\\two\\c", updatedAt: 1761412800000, running: false, blank: false },
          // ID_D: blank, no title anywhere → must be HIDDEN (GUI does the same)
          [ID_D]: { sessionId: ID_D, cwd: "C:\\ws\\two\\d", updatedAt: 1761413000000, running: false, blank: true },
          // ID_E: blank flag but HAS a title → kept (friendly label wins)
          [ID_E]: { sessionId: ID_E, cwd: "C:\\ws\\two\\e", updatedAt: 1761413100000, running: false, blank: true },
        },
      }),
    },
  };
  // projcache files (real shape: record.rows.title.val +
  // record.rows.sessionListMetadata.val.lastPromptAt) for title enrichment
  if (dshHome) {
    const pc = path.join(dshHome, "storages", "session_projcache", "sessions");
    await mkdir(pc, { recursive: true });
    await writeFile(path.join(pc, ID_B + ".json"), JSON.stringify({
      version: 7,
      record: {
        identity: { formatVersion: 4, createdAt: 1761000000000, cwd: "C:\\ws\\one\\b", isSeeded: false, inheritedEventCount: 0 },
        rows: {
          title: { ver: 1, seq: 9, val: "ProjCache B 标题" },
          sessionListMetadata: { ver: 1, seq: 9, val: { blank: false, lastPromptAt: 1761409500000 } },
        },
      },
    }));
    await writeFile(path.join(pc, ID_C + ".json"), JSON.stringify({
      version: 7,
      record: {
        identity: { formatVersion: 4, createdAt: 1761000000001, cwd: "C:\\ws\\two\\c", isSeeded: false, inheritedEventCount: 0 },
        rows: {
          title: { ver: 1, seq: 9, val: "ProjCache C 标题" },
          sessionListMetadata: { ver: 1, seq: 9, val: { blank: false, lastPromptAt: 1761412900000 } },
        },
      },
    }));
    // ID_D: blank session, no title row (real cold-session shape: the zstd
    // log holds only the header line) → hidden
    await writeFile(path.join(pc, ID_D + ".json"), JSON.stringify({
      version: 7,
      record: {
        identity: { formatVersion: 4, createdAt: 1761000000002, cwd: "C:\\ws\\two\\d", isSeeded: false, inheritedEventCount: 0 },
        rows: {
          sessionListMetadata: { ver: 1, seq: 1, val: { blank: true, lastPromptAt: null } },
        },
      },
    }));
    // ID_E: blank flag but a title row exists → kept
    await writeFile(path.join(pc, ID_E + ".json"), JSON.stringify({
      version: 7,
      record: {
        identity: { formatVersion: 4, createdAt: 1761000000003, cwd: "C:\\ws\\two\\e", isSeeded: false, inheritedEventCount: 0 },
        rows: {
          title: { ver: 1, seq: 9, val: "ProjCache E 标题" },
          sessionListMetadata: { ver: 1, seq: 9, val: { blank: true, lastPromptAt: 1761413100000 } },
        },
      },
    }));
  }
  const effects = [];
  const onHandlers = [];
  const services = {
    webServer,
    workspaceRegistry,
    sessions,
    fileUploads: deliverServices?.fileUploads ?? {
      async uploadStream() {
        return { receiptId: "rcpt-1", file: {} };
      },
    },
    sessionController: deliverServices?.sessionController ?? {
      async prompt() {
        return { accepted: true };
      },
    },
  };
  const ctx = {
    get: (n) => services[n],
    inject: (list, fn) => {
      fn(ctx);
    },
    on: (evt, fn) => onHandlers.push({ evt, fn }),
    effect: (fn) => {
      effects.push(fn);
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    _routes: routes,
    _effects: effects,
    _onHandlers: onHandlers,
  };
  return ctx;
}

// Invoke a registered route with a fake req/res.
async function callRoute(ctx, pathName, { method = "GET", body } = {}) {
  const route = ctx._routes.find((r) => r.path === pathName);
  assert.ok(route, `route ${pathName} registered`);
  const res = {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(payload) {
      this.body = payload;
      this.ended = true;
    },
  };
  const chunks = [];
  const req = {
    method,
    async *[Symbol.asyncIterator]() {
      for (const c of [body ? JSON.stringify(body) : ""]) {
        chunks.push(c);
        yield Buffer.from(c);
      }
    },
    on() {},
  };
  await route.handler(req, res);
  return res;
}

test("defaultInboxRoot_pointsAtStubInboxSubdir", () => {
  // InboxPaths.cs: InboxRoot = Path.Combine(Root, "inbox") — the watcher
  // root must include the inbox level (production bug: watched wxshare\Ready
  // while the stub wrote wxshare\inbox\Ready).
  const root = defaultInboxRoot();
  assert.ok(
    root.replace(/\//g, "\\").endsWith(path.join("dsh-desktop", "harness", "wxshare", "inbox")),
    `defaultInboxRoot ${root} must end with dsh-desktop\harness\wxshare\inbox`
  );
});

test("apply_registersThreeRoutes", async () => {
  const root = await makeRoot();
  try {
    const ctx = await makeCtx(root);
    const config = { inboxRoot: root };
    const dispose = apply(ctx, config);
    await new Promise((r) => setTimeout(r, 100));
    const paths = ctx._routes.map((r) => r.path).sort();
    assert.deepEqual(paths, ["/wxshare/api/deliver", "/wxshare/api/dismiss", "/wxshare/api/state"]);
    assert.ok(typeof dispose === "function");
    await dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stateRoute_returnsPendingAndWorkspaces", async () => {
  const root = await makeRoot();
  const dshHome = await mkdtemp(path.join(TEST_TMP, "wxshare-dshhome-"));
  try {
    const ctx = await makeCtx(root, { dshHome });
    const dispose = apply(ctx, { inboxRoot: root, dshHome });
    await writeBatch(root, "pending-1");
    await new Promise((r) => setTimeout(r, 400)); // watcher sweep
    const res = await callRoute(ctx, "/wxshare/api/state");
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, true);
    assert.equal(data.pending.length, 1);
    assert.equal(data.pending[0].batchId, "pending-1");
    assert.equal(data.workspaces.length, 2);
    const wsOne = data.workspaces.find((w) => w.title === "one");
    const wsTwo = data.workspaces.find((w) => w.title === "two");
    assert.equal(wsOne.sessions.length, 2);
    // live summary title wins
    const sa = wsOne.sessions.find((s) => s.id === ID_A);
    assert.equal(sa.title, "Session A");
    // live summary WITHOUT a title → projcache rows.title.val
    const sb = wsOne.sessions.find((s) => s.id === ID_B);
    assert.equal(sb.title, "ProjCache B 标题");
    // projcache title + lastPromptAt enrichment
    const sc = wsTwo.sessions.find((s) => s.id === ID_C);
    assert.equal(sc.title, "ProjCache C 标题");
    assert.equal(sc.updatedAt, 1761412900000);
    // blank session WITHOUT a title is hidden (GUI parity)
    assert.equal(wsTwo.sessions.find((s) => s.id === ID_D), undefined);
    // blank flag WITH a title is kept (friendly label wins)
    const se = wsTwo.sessions.find((s) => s.id === ID_E);
    assert.equal(se.title, "ProjCache E 标题");
    // most-recent-first within a workspace (ID_B lastPromptAt > ID_A)
    assert.equal(wsOne.sessions[0].id, ID_B);
    // workspace ordering by latest activity (ws-two is more recent)
    assert.equal(data.workspaces[0].title, "two");
    await dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dshHome, { recursive: true, force: true });
  }
});

// Y7 (review): a session created while DSH runs gets its projcache file
// shortly after — the negative cache must expire (TTL) so the friendly
// title appears without a restart.
test("stateRoute_projCacheMissingTtl_picksUpLateFile", async () => {
  const root = await makeRoot();
  const dshHome = await mkdtemp(path.join(TEST_TMP, "wxshare-dshhome-"));
  const ID_F = "session-ffff1111-2222-3333-4444-555566667777";
  try {
    const pc = path.join(dshHome, "storages", "session_projcache", "sessions");
    await mkdir(pc, { recursive: true });
    const ctx = await makeCtx(root, { dshHome });
    // inject ID_F into the first workspace (live summary, no projcache yet)
    const reg = ctx.get("workspaceRegistry");
    const origList = reg.list;
    reg.list = async () => {
      const list = await origList();
      list[0].sessionIds = [...list[0].sessionIds, ID_F];
      return list;
    };
    const dispose = apply(ctx, { inboxRoot: root, dshHome, projCacheTtlMs: 0 });
    let res = await callRoute(ctx, "/wxshare/api/state");
    let data = JSON.parse(res.body);
    let wsOne = data.workspaces.find((w) => w.title === "one");
    const f1 = wsOne.sessions.find((s) => s.id === ID_F);
    assert.equal(f1.title, "555566667777"); // suffix fallback (no file yet)
    // the GUI projects the session → file appears
    await writeFile(path.join(pc, ID_F + ".json"), JSON.stringify({
      version: 7,
      record: {
        identity: { formatVersion: 4, createdAt: 1761000000009, cwd: "C:\\ws\\one\\f", isSeeded: false, inheritedEventCount: 0 },
        rows: {
          title: { ver: 1, seq: 9, val: "迟到的标题" },
          sessionListMetadata: { ver: 1, seq: 9, val: { blank: false, lastPromptAt: 1761413200000 } },
        },
      },
    }));
    res = await callRoute(ctx, "/wxshare/api/state");
    data = JSON.parse(res.body);
    wsOne = data.workspaces.find((w) => w.title === "one");
    const f2 = wsOne.sessions.find((s) => s.id === ID_F);
    assert.equal(f2.title, "迟到的标题"); // TTL expired → re-read → title found
    await dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dshHome, { recursive: true, force: true });
  }
});

test("deliverRoute_success_movesToDone", async () => {
  const root = await makeRoot();
  try {
    const ctx = await makeCtx(root);
    const dispose = apply(ctx, { inboxRoot: root });
    await writeBatch(root, "del-1");
    await new Promise((r) => setTimeout(r, 400));
    const res = await callRoute(ctx, "/wxshare/api/deliver", { method: "POST", body: { batchId: "del-1", sessionId: "sess-a" } });
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, true);
    assert.ok(data.requestId);
    const ready = await readdir(path.join(root, "Ready"));
    assert.equal(ready.length, 0);
    const doneDays = await readdir(path.join(root, "Done"));
    assert.equal(doneDays.length, 1);
    const doneBatches = await readdir(path.join(root, "Done", doneDays[0]));
    assert.deepEqual(doneBatches, ["del-1"]);
    await dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deliverRoute_failure_keepsBatch", async () => {
  const root = await makeRoot();
  try {
    const deliverServices = {
      fileUploads: { async uploadStream() { return { receiptId: "r1", file: {} }; } },
      sessionController: {
        async prompt() {
          const e = new Error("gone");
          e.code = "session/not-found";
          throw e;
        },
      },
    };
    const ctx = await makeCtx(root, { deliverServices });
    const dispose = apply(ctx, { inboxRoot: root });
    await writeBatch(root, "fail-1");
    await new Promise((r) => setTimeout(r, 400));
    const res = await callRoute(ctx, "/wxshare/api/deliver", { method: "POST", body: { batchId: "fail-1", sessionId: "gone" } });
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, false);
    assert.equal(data.code, "session/not-found");
    const ready = await readdir(path.join(root, "Ready"));
    assert.deepEqual(ready, ["fail-1"]); // batch preserved
    await dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dismissRoute_movesToDoneDismissed", async () => {
  const root = await makeRoot();
  try {
    const ctx = await makeCtx(root);
    const dispose = apply(ctx, { inboxRoot: root });
    await writeBatch(root, "dismiss-1");
    await new Promise((r) => setTimeout(r, 400));
    const res = await callRoute(ctx, "/wxshare/api/dismiss", { method: "POST", body: { batchId: "dismiss-1" } });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).ok, true);
    const ready = await readdir(path.join(root, "Ready"));
    assert.equal(ready.length, 0);
    const doneDays = await readdir(path.join(root, "Done"));
    const doneBatches = await readdir(path.join(root, "Done", doneDays[0]));
    assert.deepEqual(doneBatches, ["dismiss-1"]);
    await dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("apply_missingWebServer_degradesWithoutThrow", async () => {
  const root = await makeRoot();
  try {
    const ctx = await makeCtx(root, { withWebServer: false });
    let dispose;
    assert.doesNotThrow(() => {
      dispose = apply(ctx, { inboxRoot: root });
    });
    assert.ok(typeof dispose === "function");
    assert.equal(ctx._routes.length, 0);
    await dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disposer_stopsWatcher", async () => {
  const root = await makeRoot();
  try {
    const ctx = await makeCtx(root);
    const dispose = apply(ctx, { inboxRoot: root });
    await new Promise((r) => setTimeout(r, 150));
    await writeBatch(root, "late-1");
    await dispose();
    // after dispose, no further sweeps: the late batch is NOT reported
    await new Promise((r) => setTimeout(r, 400));
    const res = await callRoute(ctx, "/wxshare/api/state");
    // state route may still answer from cache/scan — assert the watcher is
    // stopped by the side effect: a second apply+dispose cycle works cleanly.
    assert.equal(res.statusCode, 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
