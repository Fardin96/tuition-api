import { prisma } from "../../lib/prisma.js";
import { storageConfigured } from "../../lib/storage.js";
import { fileInUse, removeObjects, unattachedFileWhere } from "./files.service.js";

// Daily sweep. Each step works in batches so one run never holds many rows or objects at once.

const BATCH = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const UPLOAD_EXPIRY_MS = DAY_MS;
const ORPHAN_AFTER_MS = 7 * DAY_MS;
const PURGE_AFTER_MS = 30 * DAY_MS;

export type FileCleanupResult = {
  /** Unfinished uploads older than a day, marked DELETED. */
  expiredUploads: number;
  /** Uploaded files no record uses for a week, marked DELETED. */
  orphansRemoved: number;
  /** DELETED rows purged after 30 days. */
  purged: number;
};

/** Runs the three cleanup steps. Does nothing (all zeros) when storage is not configured. */
export async function runFileCleanup(now = new Date()): Promise<FileCleanupResult> {
  const result: FileCleanupResult = { expiredUploads: 0, orphansRemoved: 0, purged: 0 };
  if (!storageConfigured()) return result;

  // 1. Uploads that were never completed.
  const staleUploads = new Date(now.getTime() - UPLOAD_EXPIRY_MS);
  for (;;) {
    const batch = await prisma.fileAsset.findMany({
      where: { status: "PENDING_UPLOAD", createdAt: { lt: staleUploads } },
      select: { id: true, storageKey: true },
      take: BATCH,
    });
    if (batch.length === 0) break;
    await removeObjects(batch);
    const { count } = await prisma.fileAsset.updateMany({
      where: { id: { in: batch.map((f) => f.id) }, status: "PENDING_UPLOAD" },
      data: { status: "DELETED", deletedAt: now },
    });
    result.expiredUploads += count;
  }

  // 2. Uploaded files that nothing uses any more. The public copy goes too. Each file is locked
  // and checked again, as claimFile does, so a file attached during the sweep is never deleted.
  const orphanCutoff = new Date(now.getTime() - ORPHAN_AFTER_MS);
  let orphanAfterId: string | undefined;
  for (;;) {
    const batch = await prisma.fileAsset.findMany({
      where: {
        status: "UPLOADED",
        uploadedAt: { lt: orphanCutoff },
        ...unattachedFileWhere,
        ...(orphanAfterId ? { id: { gt: orphanAfterId } } : {}),
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: BATCH,
    });
    if (batch.length === 0) break;
    orphanAfterId = batch[batch.length - 1]?.id;
    const removed: { storageKey: string }[] = [];
    for (const { id } of batch) {
      const file = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM file_asset WHERE id = ${id}::uuid FOR UPDATE`;
        const row = await tx.fileAsset.findUnique({ where: { id } });
        if (row?.status !== "UPLOADED" || (await fileInUse(tx, id))) return null;
        return tx.fileAsset.update({
          where: { id },
          data: { status: "DELETED", deletedAt: now, publishedAt: null },
        });
      });
      if (file) removed.push(file);
    }
    await removeObjects(removed);
    result.orphansRemoved += removed.length;
  }

  // 3. Deleted files past the grace period: objects again (an earlier removal may have failed),
  // then the row. A row whose object still will not go is kept for the next run.
  const purgeCutoff = new Date(now.getTime() - PURGE_AFTER_MS);
  let afterId: string | undefined;
  for (;;) {
    const batch = await prisma.fileAsset.findMany({
      where: {
        status: "DELETED",
        deletedAt: { lt: purgeCutoff },
        ...unattachedFileWhere,
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      select: { id: true, storageKey: true },
      orderBy: { id: "asc" },
      take: BATCH,
    });
    if (batch.length === 0) break;
    afterId = batch[batch.length - 1]?.id;
    const failed = new Set(await removeObjects(batch));
    const { count } = await prisma.fileAsset.deleteMany({
      where: {
        id: { in: batch.filter((f) => !failed.has(f.storageKey)).map((f) => f.id) },
        ...unattachedFileWhere,
      },
    });
    result.purged += count;
  }

  return result;
}
