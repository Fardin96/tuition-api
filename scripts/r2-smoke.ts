// Round-trips one 64-byte PDF through the real R2 buckets: signed PUT, head, read, signed GET, and
// (when R2_PUBLIC_BUCKET and R2_PUBLIC_URL_PREFIX are set) copy to the public bucket and fetch it.
// Writes under smoke/ and deletes what it wrote. Run: yarn r2:smoke

import { getStorage, storageConfigured } from "../src/lib/storage.js";

if (!storageConfigured()) {
  console.error(
    "Refusing to run: set R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in .env first.",
  );
  process.exit(1);
}

const storage = getStorage();
const key = `smoke/${Date.now()}-${crypto.randomUUID()}.pdf`;
const body = new Uint8Array(64);
body.set(new TextEncoder().encode("%PDF-1.7\n"));

function step(name: string, detail?: string) {
  console.log(`ok   ${name}${detail ? ` (${detail})` : ""}`);
}

async function main() {
  const putUrl = await storage.presignPut({ key, contentType: "application/pdf", expiresIn: 300 });
  step("presign PUT");

  const put = await fetch(putUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    body,
  });
  if (!put.ok) throw new Error(`upload failed: HTTP ${put.status}`);
  step("upload", `HTTP ${put.status}`);

  const head = await storage.head(key);
  if (head?.size !== body.length) {
    throw new Error(`head: expected ${body.length} bytes, got ${head?.size ?? "no object"}`);
  }
  step("head", `${head.size} bytes`);

  const start = new TextDecoder().decode(await storage.readStart(key, 8));
  if (start !== "%PDF-1.7") throw new Error(`read: expected a PDF signature, got "${start}"`);
  step("read first bytes");

  const getUrl = await storage.presignGet({ key, expiresIn: 300, fileName: "smoke.pdf" });
  const get = await fetch(getUrl);
  const downloaded = new Uint8Array(await get.arrayBuffer());
  if (!get.ok || downloaded.length !== body.length) {
    throw new Error(`signed GET: HTTP ${get.status}, ${downloaded.length} bytes`);
  }
  step("presign GET and fetch", `HTTP ${get.status}`);

  const publicUrl = storage.publicUrl(key);
  if (publicUrl) {
    await storage.copyToPublic(key);
    const pub = await fetch(publicUrl);
    if (!pub.ok) throw new Error(`public fetch failed: HTTP ${pub.status}`);
    step("copy to public bucket and fetch", publicUrl);
  } else {
    step("public bucket", "skipped: R2_PUBLIC_BUCKET or R2_PUBLIC_URL_PREFIX not set");
  }
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
}

try {
  await storage.delete(key);
  if (storage.publicUrl(key)) await storage.delete(key, "public");
  step("cleanup");
} catch (err) {
  failed = true;
  console.error(`FAILED cleanup: ${err instanceof Error ? err.message : String(err)}`);
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log("r2 smoke: all steps passed");
}
