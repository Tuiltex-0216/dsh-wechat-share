// T6: delivery orchestration tests (node:test, fake services).
// Run: node --test wxshare-plugin/plugin/test/deliver.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const { deliverBatch, buildPromptText, DeliverError } = await import("../lib/deliver.js");

async function makeBatch(zipNames, sizes = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "wxshare-deliver-"));
  const dir = path.join(root, "Ready", "batch-1");
  await mkdir(dir, { recursive: true });
  const items = [];
  for (const name of zipNames) {
    const buf = Buffer.alloc(sizes[name] ?? 200_000, 7);
    await writeFile(path.join(dir, name), buf);
    items.push({ name, size: buf.length, relativePath: name });
  }
  const batch = {
    batchId: "batch-1",
    createdAt: new Date().toISOString(),
    directory: dir,
    items,
    totalBytes: items.reduce((s, i) => s + i.size, 0),
    fresh: true,
  };
  return { root, batch };
}

test("deliverBatch_happyPath_contentShape", async () => {
  const { root, batch } = await makeBatch(["聊天记录.zip", "附件.zip"]);
  try {
    const calls = { uploads: [], prompts: [] };
    let receipt = 0;
    const services = {
      fileUploads: {
        async uploadStream({ sessionId, name }) {
          calls.uploads.push({ sessionId, name });
          return { receiptId: `rcpt-${++receipt}`, file: { name } };
        },
      },
      sessionController: {
        async prompt(req) {
          calls.prompts.push(req);
          return { accepted: true };
        },
      },
    };
    const result = await deliverBatch({ batch, sessionId: "sess-1", services, onLog: () => {} });
    assert.equal(result.ok, true);
    assert.match(result.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(calls.uploads.length, 2);
    assert.equal(calls.uploads[0].name, "聊天记录.zip");
    assert.equal(calls.uploads[1].name, "附件.zip");
    assert.equal(calls.prompts.length, 1);
    const p = calls.prompts[0];
    assert.equal(p.sessionId, "sess-1");
    assert.equal(p.mode, "queue");
    assert.equal(p.requestId, result.requestId);
    assert.equal(p.content[0].type, "text");
    assert.ok(p.content[0].text.includes("2 个文件"));
    assert.equal(p.content[1].type, "file");
    assert.equal(p.content[1].receiptId, "rcpt-1");
    assert.equal(p.content[2].type, "file");
    assert.equal(p.content[2].receiptId, "rcpt-2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deliverBatch_streamsIn64kChunks", async () => {
  const { root, batch } = await makeBatch(["big.zip"], { "big.zip": 200_000 });
  try {
    let maxChunk = 0;
    let totalBytes = 0;
    const services = {
      fileUploads: {
        async uploadStream({ data }) {
          for await (const chunk of data) {
            maxChunk = Math.max(maxChunk, chunk.length);
            totalBytes += chunk.length;
          }
          return { receiptId: "rcpt-1", file: {} };
        },
      },
      sessionController: {
        async prompt() {
          return { accepted: true };
        },
      },
    };
    await deliverBatch({ batch, sessionId: "s", services, onLog: () => {} });
    assert.equal(totalBytes, 200_000);
    assert.ok(maxChunk <= 65536, `max chunk ${maxChunk}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deliverBatch_uploadFailure_preservesBatchAndThrows", async () => {
  const { root, batch } = await makeBatch(["a.zip", "b.zip"]);
  try {
    const services = {
      fileUploads: {
        async uploadStream({ name }) {
          if (name === "b.zip") throw new Error("disk on fire");
          return { receiptId: "rcpt-1", file: {} };
        },
      },
      sessionController: {
        async prompt() {
          throw new Error("prompt must not be called");
        },
      },
    };
    await assert.rejects(
      () => deliverBatch({ batch, sessionId: "s", services, onLog: () => {} }),
      (err) => {
        assert.ok(err instanceof DeliverError);
        assert.equal(err.code, "gateway/internal");
        assert.equal(err.batchPreserved, true);
        return true;
      }
    );
    // batch untouched: directory + files still present
    await mkdir(batch.directory, { recursive: true }).catch(() => {});
    const st = await import("node:fs/promises").then((m) => m.stat(path.join(batch.directory, "b.zip")));
    assert.ok(st.size > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deliverBatch_promptSessionNotFound_throwsCode", async () => {
  const { root, batch } = await makeBatch(["a.zip"]);
  try {
    const services = {
      fileUploads: {
        async uploadStream() {
          return { receiptId: "rcpt-1", file: {} };
        },
      },
      sessionController: {
        async prompt() {
          const e = new Error("no such session");
          e.code = "session/not-found";
          throw e;
        },
      },
    };
    await assert.rejects(
      () => deliverBatch({ batch, sessionId: "gone", services, onLog: () => {} }),
      (err) => {
        assert.ok(err instanceof DeliverError);
        assert.equal(err.code, "session/not-found");
        return true;
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildPromptText_formatsSize", () => {
  const b18 = { totalBytes: Math.round(1.8 * 1024 * 1024), items: [{ name: "聊天记录.zip" }, { name: "x.png" }] };
  const t18 = buildPromptText(b18);
  assert.ok(t18.includes("共 1.8 MB"), t18);
  const b04 = { totalBytes: Math.round(0.4 * 1024 * 1024), items: [{ name: "a.zip" }] };
  const t04 = buildPromptText(b04);
  assert.ok(t04.includes("共 0.4 MB"), t04);
});
