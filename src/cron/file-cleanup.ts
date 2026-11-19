import { prisma } from "../lib/prisma.js";
import { storageConfigured } from "../lib/storage.js";
import { runFileCleanup } from "../modules/files/file-cleanup.service.js";

async function main() {
  if (!storageConfigured()) {
    console.log("file-cleanup skipped: storage not configured");
    return;
  }
  const result = await runFileCleanup();
  console.log(
    `file-cleanup complete: expired uploads ${result.expiredUploads}, orphans removed ${result.orphansRemoved}, purged ${result.purged}`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
