// wxshare plugin — batch delivery orchestration (host half, T6).
// ESM, zero deps. Streams each zip of a Ready batch through the host
// fileUploads service and submits one queued prompt (text + file parts)
// via sessionController. Any failure throws DeliverError and leaves the
// batch untouched in Ready (the caller keeps it for retry).

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const CHUNK_SIZE = 64 * 1024;

export class DeliverError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DeliverError";
    this.code = code;
    this.batchPreserved = true;
  }
}

// Normalize a host error to a DeliverError code: objects carrying a `code`
// pass it through; anything else is "gateway/internal".
function codeOf(err) {
  if (err && typeof err.code === "string" && err.code.length > 0) return err.code;
  return "gateway/internal";
}

// 64KB-chunked async iterable over a file's bytes.
async function* streamFile(file) {
  const stream = createReadStream(file, { highWaterMark: CHUNK_SIZE });
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? new Uint8Array(chunk) : new Uint8Array(chunk);
      // re-chunk to at most CHUNK_SIZE (fs may yield larger buffers)
      let off = 0;
      while (off < buf.length) {
        yield buf.subarray(off, Math.min(off + CHUNK_SIZE, buf.length));
        off += CHUNK_SIZE;
      }
    }
  } finally {
    stream.destroy();
  }
}

// Pure: the prompt body text (Global Constraints template).
export function buildPromptText(batch) {
  const n = batch.items.length;
  const mb = batch.totalBytes / (1024 * 1024);
  return `微信聊天记录转发（来自微信，${n} 个文件，共 ${mb.toFixed(1)} MB）。请解压并阅读：`;
}

// Deliver one Ready batch to a DSH session.
// services: duck-typed { fileUploads: {uploadStream}, sessionController: {prompt} }
export async function deliverBatch({ batch, sessionId, services, onLog = () => {} }) {
  if (!batch || !batch.directory) throw new DeliverError("gateway/internal", "batch invalid");
  if (!sessionId) throw new DeliverError("session/not-found", "sessionId required");
  if (!services?.fileUploads?.uploadStream) throw new DeliverError("gateway/internal", "fileUploads service missing");
  if (!services?.sessionController?.prompt) throw new DeliverError("gateway/internal", "sessionController service missing");

  // zip detection: the stub guarantees zips; defensively filter non-zip items.
  const zips = batch.items.filter((it) => String(it.name).toLowerCase().endsWith(".zip"));
  const skipped = batch.items.length - zips.length;
  if (skipped > 0) onLog(`deliver: skipped ${skipped} non-zip item(s) in batch ${batch.batchId}`);
  if (zips.length === 0) throw new DeliverError("gateway/internal", `no zip items in batch ${batch.batchId}`);

  // 1) upload every zip → receiptIds
  const fileParts = [];
  for (const it of zips) {
    const file = path.join(batch.directory, it.relativePath);
    let st;
    try {
      st = await stat(file);
    } catch {
      throw new DeliverError("gateway/internal", `batch file missing: ${it.relativePath}`);
    }
    let receipt;
    try {
      receipt = await services.fileUploads.uploadStream({
        sessionId,
        data: streamFile(file),
        name: it.name,
      });
    } catch (err) {
      throw new DeliverError(codeOf(err), `upload failed for ${it.name}: ${err.message}`);
    }
    if (!receipt?.receiptId) throw new DeliverError("gateway/internal", `upload returned no receiptId for ${it.name}`);
    fileParts.push({ type: "file", receiptId: receipt.receiptId });
    void st;
  }

  // 2) one queued prompt: body template + all file parts
  const requestId = randomUUID();
  const content = [{ type: "text", text: buildPromptText(batch) }, ...fileParts];
  try {
    // The host prompt() dereferences signal.throwIfAborted() unguarded —
    // a real AbortSignal is mandatory (undefined crashes with
    // "Cannot read properties of undefined (reading 'throwIfAborted')").
    const ac = new AbortController();
    const res = await services.sessionController.prompt(
      { requestId, sessionId, mode: "queue", content },
      ac.signal
    );
    if (res && res.accepted === false) {
      throw new DeliverError("gateway/internal", "prompt not accepted");
    }
  } catch (err) {
    if (err instanceof DeliverError) throw err;
    throw new DeliverError(codeOf(err), `prompt failed: ${err.message}`);
  }

  return { ok: true, requestId };
}
