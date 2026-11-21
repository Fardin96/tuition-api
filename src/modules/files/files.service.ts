import { randomUUID } from "node:crypto";
import type { FileAsset, Prisma } from "../../generated/prisma/client.js";
import type { FilePurpose } from "../../generated/prisma/enums.js";
import { writeAudit } from "../../lib/admin.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { getStorage, maybeStorage } from "../../lib/storage.js";
import {
  DOWNLOAD_URL_TTL,
  EMBED_URL_TTL,
  extensionFor,
  FILE_POLICY,
  MAX_UNUSED_UPLOADS,
  SNIFF_BYTES,
  sniffMatches,
  UPLOAD_URL_TTL,
} from "./file-policy.js";
import type {
  CreateUploadUrlInput,
  DownloadUrlResponse,
  FileAssetResponse,
  UploadUrlResponse,
} from "./files.schema.js";
import { assertUploadsAllowed } from "./upload-review.service.js";

// Upload flow: createUploadUrl (row PENDING_UPLOAD + signed PUT) -> the browser PUTs to R2 ->
// completeUpload checks the object and marks it UPLOADED -> a feature endpoint attaches it with
// claimFile. Files are never public unless published (approved videos, blog covers).

type Db = Prisma.TransactionClient | typeof prisma;

/** Purposes whose files are personal documents: an admin viewing one is audited. */
const SENSITIVE: ReadonlySet<FilePurpose> = new Set(["STUDENT_ID", "TUTOR_ID", "CREDENTIAL"]);

export function toFileAsset(row: FileAsset): FileAssetResponse {
  return {
    id: row.id,
    purpose: row.purpose,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    status: row.status,
    fileName: row.originalName,
    createdAt: row.createdAt,
    uploadedAt: row.uploadedAt,
  };
}

function checkPolicy(purpose: FilePurpose, contentType: string, sizeBytes: number) {
  const policy = FILE_POLICY[purpose];
  if (!policy.contentTypes.includes(contentType)) {
    throw appError("UnsupportedFileType", 400, "This file type is not accepted here.", {
      allowed: policy.contentTypes,
    });
  }
  if (sizeBytes > policy.maxBytes) {
    throw appError(
      "FileTooLarge",
      400,
      `The file is too large. The limit is ${Math.round(policy.maxBytes / (1024 * 1024))} MB.`,
      { maxBytes: policy.maxBytes },
    );
  }
}

/** The caller's role was already checked against FILE_POLICY[purpose].roles by the route. */
export async function createUploadUrl(
  ownerAccountId: string,
  input: CreateUploadUrlInput,
): Promise<UploadUrlResponse> {
  checkPolicy(input.purpose, input.contentType, input.sizeBytes);
  await assertUploadsAllowed(prisma, ownerAccountId, input.purpose);
  const storage = getStorage();

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const unused = await prisma.fileAsset.count({
    where: {
      ownerAccountId,
      createdAt: { gte: since },
      OR: [{ status: "PENDING_UPLOAD" }, { status: "UPLOADED", ...unattachedFileWhere }],
    },
  });
  if (unused >= MAX_UNUSED_UPLOADS) {
    throw appError(
      "UploadLimitReached",
      409,
      "Too many uploads that are not used yet. Use or remove one, or try again tomorrow.",
      { limit: MAX_UNUSED_UPLOADS },
    );
  }

  const key = `${input.purpose.toLowerCase()}/${ownerAccountId}/${randomUUID()}.${extensionFor(input.contentType)}`;
  const uploadUrl = await storage.presignPut({
    key,
    contentType: input.contentType,
    contentLength: input.sizeBytes,
    expiresIn: UPLOAD_URL_TTL,
  });
  const row = await prisma.fileAsset.create({
    data: {
      ownerAccountId,
      purpose: input.purpose,
      storageKey: key,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      originalName: input.fileName ?? null,
    },
  });

  return {
    file: toFileAsset(row),
    uploadUrl,
    method: "PUT",
    headers: { "Content-Type": input.contentType },
    expiresAt: new Date(Date.now() + UPLOAD_URL_TTL * 1000),
  };
}

/** Checks the uploaded object and marks it UPLOADED. Idempotent. Other accounts get 404. */
export async function completeUpload(
  ownerAccountId: string,
  fileId: string,
): Promise<FileAssetResponse> {
  const row = await prisma.fileAsset.findUnique({ where: { id: fileId } });
  if (!row || row.ownerAccountId !== ownerAccountId || row.status === "DELETED") {
    throw notFound("File not found");
  }
  if (row.status === "UPLOADED") return toFileAsset(row);

  const storage = getStorage();
  const head = await storage.head(row.storageKey);
  if (!head) {
    throw appError("UploadNotFound", 409, "The file has not been uploaded yet.");
  }

  const policy = FILE_POLICY[row.purpose];
  const start = head.size > 0 ? await storage.readStart(row.storageKey, SNIFF_BYTES) : null;
  const problem =
    head.size > policy.maxBytes
      ? appError("FileTooLarge", 400, "The uploaded file is too large.", {
          maxBytes: policy.maxBytes,
        })
      : head.size !== row.sizeBytes
        ? appError("InvalidFile", 400, "The uploaded file is not the one that was declared.")
        : !start || !sniffMatches(row.contentType, start)
          ? appError("UnsupportedFileType", 400, "The file's contents do not match its type.", {
              allowed: policy.contentTypes,
            })
          : null;

  if (problem) {
    await storage.delete(row.storageKey);
    await prisma.fileAsset.update({
      where: { id: row.id },
      data: { status: "DELETED", deletedAt: new Date() },
    });
    throw problem;
  }

  // Conditional update: a concurrent complete may have won already.
  await prisma.fileAsset.updateMany({
    where: { id: row.id, status: "PENDING_UPLOAD" },
    data: { status: "UPLOADED", uploadedAt: new Date() },
  });
  const done = await prisma.fileAsset.findUniqueOrThrow({ where: { id: row.id } });
  return toFileAsset(done);
}

export type FileViewer = { accountId: string; isAdmin: boolean };

/** Short-lived read URL for the owner or an admin. Admin views of personal documents are audited. */
export async function getDownloadUrl(
  viewer: FileViewer,
  fileId: string,
  ip: string | undefined,
): Promise<DownloadUrlResponse> {
  const row = await prisma.fileAsset.findUnique({ where: { id: fileId } });
  const allowed = row && (row.ownerAccountId === viewer.accountId || viewer.isAdmin);
  if (!row || !allowed || row.status !== "UPLOADED") throw notFound("File not found");

  const storage = getStorage();
  const url = await storage.presignGet({
    key: row.storageKey,
    expiresIn: DOWNLOAD_URL_TTL,
    fileName: row.originalName,
  });

  if (viewer.isAdmin && row.ownerAccountId !== viewer.accountId && SENSITIVE.has(row.purpose)) {
    await prisma.$transaction((tx) =>
      writeAudit(tx, {
        actorAccountId: viewer.accountId,
        action: "file.view",
        entityType: "file_asset",
        entityId: row.id,
        after: { purpose: row.purpose, ownerAccountId: row.ownerAccountId },
        ip,
      }),
    );
  }
  return { url, expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL * 1000) };
}

/** True when any record points at the file. Keep in step with the FileAsset relations. */
export async function fileInUse(db: Db, fileId: string): Promise<boolean> {
  const [student, verification, credential, video, post, site, story] = [
    await db.student.count({ where: { verificationFileId: fileId } }),
    await db.tutorVerification.count({ where: { fileId } }),
    await db.tutorCredential.count({ where: { fileId } }),
    await db.tutorVideo.count({ where: { fileId } }),
    await db.blogPost.count({ where: { coverFileId: fileId } }),
    await db.siteContentFile.count({ where: { fileId } }),
    await db.story.count({ where: { OR: [{ imageFileId: fileId }, { videoFileId: fileId }] } }),
  ];
  return student + verification + credential + video + post + site + story > 0;
}

/** Prisma filter for files no record points at. Keep in step with fileInUse. */
export const unattachedFileWhere = {
  studentVerifications: { none: {} },
  tutorVerifications: { none: {} },
  credentials: { none: {} },
  videos: { none: {} },
  blogCovers: { none: {} },
  siteContentUses: { none: {} },
  storyImages: { none: {} },
  storyVideos: { none: {} },
} satisfies Prisma.FileAssetWhereInput;

/**
 * Locks an uploaded file for attaching to a record, inside the caller's transaction.
 * 400 INVALID_FILE when it is not the caller's, not uploaded, or the wrong purpose;
 * 409 FILE_IN_USE when another record already uses it; 403 UPLOADS_BLOCKED when an admin paused
 * this kind of upload for the owner.
 */
export async function claimFile(
  tx: Prisma.TransactionClient,
  input: { fileId: string; ownerAccountId: string; purpose: FilePurpose },
): Promise<FileAsset> {
  await tx.$queryRaw`SELECT id FROM file_asset WHERE id = ${input.fileId}::uuid FOR UPDATE`;
  const row = await tx.fileAsset.findUnique({ where: { id: input.fileId } });
  if (!row || row.ownerAccountId !== input.ownerAccountId || row.status === "DELETED") {
    throw appError("InvalidFile", 400, "File not found. Upload it again.");
  }
  if (row.status !== "UPLOADED") {
    throw appError("InvalidFile", 400, "The upload is not finished yet.");
  }
  if (row.purpose !== input.purpose) {
    throw appError("InvalidFile", 400, "This file was uploaded for something else.");
  }
  await assertUploadsAllowed(tx, input.ownerAccountId, input.purpose);
  if (await fileInUse(tx, row.id)) {
    throw appError("FileInUse", 409, "This file is already attached to something else.");
  }
  return row;
}

/**
 * Marks a file DELETED inside the caller's transaction and returns it, so the caller can
 * remove its objects with removeObjects after the commit.
 */
export async function discardFile(
  tx: Prisma.TransactionClient,
  fileId: string,
): Promise<FileAsset | null> {
  const row = await tx.fileAsset.findUnique({ where: { id: fileId } });
  if (!row || row.status === "DELETED") return null;
  return tx.fileAsset.update({
    where: { id: fileId },
    data: { status: "DELETED", deletedAt: new Date(), publishedAt: null },
  });
}

/**
 * Best-effort removal of objects from both buckets. Returns the storage keys that could not be
 * removed; failures are logged and left for the file-cleanup cron, which removes DELETED files'
 * objects again before purging their rows.
 */
export async function removeObjects(files: { storageKey: string }[]): Promise<string[]> {
  const storage = maybeStorage();
  if (!storage) return files.map((file) => file.storageKey);
  const failed: string[] = [];
  for (const file of files) {
    try {
      await storage.delete(file.storageKey);
      await storage.delete(file.storageKey, "public");
    } catch (err) {
      failed.push(file.storageKey);
      console.warn(`file cleanup: could not delete ${file.storageKey}: ${String(err)}`);
    }
  }
  return failed;
}

/**
 * Deletes a file for its owner or an admin. 409 FILE_IN_USE while a record uses it: remove the
 * record (credential, video, cover) instead. `audit` is set for admin deletes.
 */
export async function deleteFile(
  viewer: FileViewer,
  fileId: string,
  audit?: { ip: string | undefined },
): Promise<void> {
  const removed = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM file_asset WHERE id = ${fileId}::uuid FOR UPDATE`;
    const row = await tx.fileAsset.findUnique({ where: { id: fileId } });
    const allowed = row && (row.ownerAccountId === viewer.accountId || viewer.isAdmin);
    if (!row || !allowed || row.status === "DELETED") throw notFound("File not found");
    if (await fileInUse(tx, row.id)) {
      throw appError("FileInUse", 409, "This file is still in use. Remove it from there first.");
    }
    const file = await discardFile(tx, row.id);
    if (audit) {
      await writeAudit(tx, {
        actorAccountId: viewer.accountId,
        action: "file.delete",
        entityType: "file_asset",
        entityId: row.id,
        before: { status: row.status, purpose: row.purpose, ownerAccountId: row.ownerAccountId },
        ip: audit.ip,
      });
    }
    return file;
  });
  if (removed) await removeObjects([removed]);
}

/**
 * URL a page can embed (video player, cover image): the public URL for a published file,
 * otherwise a signed URL valid for EMBED_URL_TTL. Null when storage is not configured or the
 * file is not uploaded.
 */
export async function fileUrl(file: {
  storageKey: string;
  status: FileAsset["status"];
  publishedAt: Date | null;
  originalName?: string | null;
}): Promise<string | null> {
  const storage = maybeStorage();
  if (!storage || file.status !== "UPLOADED") return null;
  if (file.publishedAt) {
    const url = storage.publicUrl(file.storageKey);
    if (url) return url;
  }
  return storage.presignGet({ key: file.storageKey, expiresIn: EMBED_URL_TTL });
}

/**
 * Copies a file to the public bucket and records it. No-op without a public bucket (fileUrl then
 * keeps signing URLs). Call after the transaction that made the file public-worthy commits;
 * a failure is logged and the file stays served through signed URLs.
 */
export async function publishFile(fileId: string): Promise<void> {
  const storage = maybeStorage();
  if (!storage) return;
  const row = await prisma.fileAsset.findUnique({ where: { id: fileId } });
  if (row?.status !== "UPLOADED" || row.publishedAt) return;
  if (!storage.publicUrl(row.storageKey)) return;
  try {
    await storage.copyToPublic(row.storageKey);
    await prisma.fileAsset.update({ where: { id: fileId }, data: { publishedAt: new Date() } });
  } catch (err) {
    console.warn(`publish: could not copy ${row.storageKey}: ${String(err)}`);
  }
}

/**
 * Removes the public copy, then clears the marker. Call after the transaction that took the file
 * down commits. If the delete fails the marker stays, so the copy is not forgotten; the caller's
 * status change already hides the file from every listing.
 */
export async function unpublishFile(fileId: string): Promise<void> {
  const row = await prisma.fileAsset.findUnique({ where: { id: fileId } });
  if (!row?.publishedAt) return;
  const storage = maybeStorage();
  if (storage) {
    try {
      await storage.delete(row.storageKey, "public");
    } catch (err) {
      console.warn(`unpublish: could not delete public ${row.storageKey}: ${String(err)}`);
      return;
    }
  }
  await prisma.fileAsset.updateMany({
    where: { id: fileId, publishedAt: row.publishedAt },
    data: { publishedAt: null },
  });
}
