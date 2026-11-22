// Gives every object in the public bucket PUBLIC_MEDIA_CACHE_CONTROL. Objects copied before that
// header existed carry none. Each object is copied onto itself with its own Content-Type.
// Dry run by default: lists the keys and a count, writes nothing. Pass --apply to write.
// Run: yarn r2:backfill-cache-control            (dry run)
//      yarn r2:backfill-cache-control --apply    (writes)

import { getStorage, publicBucketConfigured, storageConfigured } from "../src/lib/storage.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const unknown = args.filter((arg) => arg !== "--apply");
if (unknown.length > 0) {
  console.error(`Unknown argument: ${unknown.join(" ")}. The only flag is --apply.`);
  process.exit(1);
}

if (!storageConfigured() || !publicBucketConfigured()) {
  console.error(
    "Refusing to run: set R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PUBLIC_BUCKET and R2_PUBLIC_URL_PREFIX in .env first.",
  );
  process.exit(1);
}

const storage = getStorage();
console.log(
  apply
    ? "APPLY: rewriting Cache-Control on every public object."
    : "DRY RUN: listing public objects only. Pass --apply to write.",
);

let listed = 0;
let rewritten = 0;
let failed = 0;
try {
  for await (const key of storage.publicKeys()) {
    listed++;
    if (!apply) {
      console.log(key);
      continue;
    }
    try {
      await storage.applyPublicCacheControl(key);
      rewritten++;
      console.log(`ok     ${key}`);
    } catch (err) {
      failed++;
      console.error(`FAILED ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
} catch (err) {
  failed++;
  console.error(`FAILED listing: ${err instanceof Error ? err.message : String(err)}`);
}

if (apply) {
  console.log(`rewritten ${rewritten} of ${listed} object(s); failed ${failed}.`);
} else {
  console.log(`${listed} object(s) in the public bucket; nothing written.`);
}
if (failed > 0) process.exitCode = 1;
