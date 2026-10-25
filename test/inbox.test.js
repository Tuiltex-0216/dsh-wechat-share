// T5: inbox watcher tests (node:test, ESM, zero deps).
// Run: node --test wxshare-plugin/plugin/test/inbox.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readdir, stat, copyFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const { createInboxWatcher, scanReady, moveToDone } = await import("../lib/inbox.js");

async function makeRoot() {
  // Workspace-local temp (DSH sandbox confines node writes to the session workspace).
  const TEST_TMP = path.join(import.meta.dirname, "..", ".test-tmp");
  await mkdir(TEST_TMP, { recursive: true });
  const root = await mkdtemp(path.join(TEST_TMP, "wxshare-test-"));
  await mkdir(path.join(root, "Ready"), { recursive: true });
  await mkdir(path.join(root, "Done"), { recursive: true });
  return root;
}

// Write a complete Ready batch per the T1 manifest contract (lowercase keys, Z-suffix UTC).
async function writeBatch(root, batchId, files = { "聊天记录.txt": "hello", "聊天记录内的图片、视频和文件/a.png": Buffer.from([1, 2, 3]) }, createdAt = new Date().toISOString()) {
  const dir = path.join(root, "Ready", batchId);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  const items = Object.entries(files).map(([rel, content]) => ({
    name: path.basename(rel),
    size: content.length,
    relativePath: rel.split(path.sep).join("/"),
    contentType: rel.toLowerCase().endsWith(".png") ? "image/png" : "text/plain",
  }));
  const manifest = { schemaVersion: 1, batchId, createdAt, source: "wechat-share", items };
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

test("scanReady_ignoresCorruptManifest", async () => {
  const root = await makeRoot();
  try {
    await writeBatch(root, "good-batch");
    const bad = path.join(root, "Ready", "bad-batch");
    await mkdir(bad, { recursive: true });
    await writeFile(path.join(bad, "manifest.json"), "{not json");
    const batches = await scanReady(root);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].batchId, "good-batch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Y1 (review): the manifest is externally writable — reject traversal.
test("scanReady_rejectsRelativePathTraversal", async () => {
  const root = await makeRoot();
  try {
    await writeBatch(root, "good-batch");
    const evil = path.join(root, "Ready", "evil-batch");
    await mkdir(path.join(evil, "files"), { recursive: true });
    const payload = Buffer.from("sensitive");
    await writeFile(path.join(evil, "files", "in.zip"), payload);
    // relativePath escapes the batch dir (size matches the real file)
    await writeFile(path.join(evil, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      batchId: "evil-batch",
      createdAt: new Date().toISOString(),
      source: "wechat-share",
      items: [{
        name: "in.zip",
        size: payload.length,
        relativePath: "../../../../Documents/secret.txt",
        contentType: "application/zip",
      }],
    }));
    const batches = await scanReady(root, (msg) => {});
    assert.equal(batches.length, 1);
    assert.equal(batches[0].batchId, "good-batch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scanReady_rejectsBatchIdDirnameMismatch", async () => {
  const root = await makeRoot();
  try {
    await writeBatch(root, "good-batch");
    const liar = path.join(root, "Ready", "dir-name");
    await mkdir(path.join(liar, "files"), { recursive: true });
    const payload = Buffer.from("zz");
    await writeFile(path.join(liar, "files", "a.zip"), payload);
    // manifest.batchId != directory name → spoofed identity
    await writeFile(path.join(liar, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      batchId: "other-batch",
      createdAt: new Date().toISOString(),
      source: "wechat-share",
      items: [{ name: "a.zip", size: 2, relativePath: "files/a.zip", contentType: "application/zip" }],
    }));
    const batches = await scanReady(root, (msg) => {});
    assert.equal(batches.length, 1);
    assert.equal(batches[0].batchId, "good-batch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scanReady_reportsItemSizesAndTotal", async () => {
  const root = await makeRoot();
  try {
    await writeBatch(root, "size-batch", { "a.txt": "12345", "b.txt": "67" });
    const batches = await scanReady(root);
    assert.equal(batches.length, 1);
    const b = batches[0];
    assert.equal(b.totalBytes, 7);
    assert.equal(b.items.length, 2);
    const a = b.items.find((i) => i.name === "a.txt");
    assert.equal(a.size, 5);
    assert.equal(a.relativePath, "a.txt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("watcher_callbacksOncePerBatch", async () => {
  const root = await makeRoot();
  try {
    const seen = [];
    const w = createInboxWatcher({ root, onBatch: (b) => seen.push(b.batchId), onLog: () => {} });
    await new Promise((r) => setTimeout(r, 150)); // let startup sweep finish
    await writeBatch(root, "first");
    await new Promise((r) => setTimeout(r, 600));
    await writeBatch(root, "second");
    await new Promise((r) => setTimeout(r, 600));
    await w.dispose();
    assert.deepEqual(seen, ["first", "second"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("watcher_startupSweep_picksUpColdBatch", async () => {
  const root = await makeRoot();
  try {
    await writeBatch(root, "cold-batch"); // written BEFORE the watcher exists
    const seen = [];
    const w = createInboxWatcher({ root, onBatch: (b) => seen.push(b.batchId), onLog: () => {} });
    await new Promise((r) => setTimeout(r, 400));
    await w.dispose();
    assert.deepEqual(seen, ["cold-batch"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("moveToDone_movesUnderDateFolder", async () => {
  const root = await makeRoot();
  try {
    await writeBatch(root, "done-batch");
    await moveToDone(root, "done-batch", "delivered");
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const doneDir = path.join(root, "Done", today, "done-batch");
    await stat(path.join(doneDir, "manifest.json"));
    const ready = await readdir(path.join(root, "Ready"));
    assert.equal(ready.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sweep_prunesStaleReadyAndDone", async () => {
  const root = await makeRoot();
  try {
    const oldReady = await writeBatch(root, "old-ready");
    const oldReadyTime = new Date(Date.now() - 31 * 86400_000);
    await utimes(oldReady, oldReadyTime, oldReadyTime);
    const oldDone = path.join(root, "Done", "20200101", "old-done");
    await mkdir(oldDone, { recursive: true });
    await writeFile(path.join(oldDone, "manifest.json"), "{}");
    const oldDoneTime = new Date(Date.now() - 8 * 86400_000);
    await utimes(oldDone, oldDoneTime, oldDoneTime);
    const fresh = await writeBatch(root, "fresh-batch");
    const w = createInboxWatcher({ root, onBatch: () => {}, onLog: () => {} });
    await w.sweepNow();
    await w.dispose();
    await stat(fresh); // fresh survives (the real check; the former tautology line removed)
    await assert.rejects(stat(oldReady)); // 31d ready pruned
    await assert.rejects(stat(oldDone)); // 8d done pruned
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
