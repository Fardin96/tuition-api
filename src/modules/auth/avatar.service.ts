import type { FileAsset, Prisma } from "../../generated/prisma/client.js";
import { avatarSelect, avatarUrlFor } from "../../lib/avatar.js";
import { appError, ERROR_CODES } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import {
  claimFile,
  discardFile,
  publishFile,
  removeObjects,
  unpublishFile,
} from "../files/files.service.js";

// Profile pictures: an AVATAR file the account owns. Replacing or clearing it discards the old file.
// Lock order is file rows first, then the account row, as removeFile in admin/files.service.ts does.

type Tx = Prisma.TransactionClient;

/** Locks the account's current avatar file and the account, and returns the avatar file id it has. */
async function lockAvatar(tx: Tx, accountId: string): Promise<string | null> {
  const before = await tx.account.findUniqueOrThrow({
    where: { id: accountId },
    select: { avatarFileId: true },
  });
  if (before.avatarFileId) {
    await tx.$queryRaw`SELECT id FROM file_asset WHERE id = ${before.avatarFileId}::uuid FOR UPDATE`;
  }
  await tx.$queryRaw`SELECT id FROM account WHERE id = ${accountId}::uuid FOR UPDATE`;
  const locked = await tx.account.findUniqueOrThrow({
    where: { id: accountId },
    select: { avatarFileId: true },
  });
  // Another request replaced or removed the photo while this one waited for the locks.
  if (locked.avatarFileId !== before.avatarFileId) {
    throw appError("InvalidAccountState", 409, "Your photo changed just now. Try again.");
  }
  return locked.avatarFileId;
}

async function currentAvatarUrl(accountId: string): Promise<string | null> {
  const account = await prisma.account.findUniqueOrThrow({
    where: { id: accountId },
    select: avatarSelect,
  });
  return avatarUrlFor(account);
}

function isFileInUse(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === ERROR_CODES.FileInUse;
}

async function hasAvatar(accountId: string, fileId: string): Promise<boolean> {
  const account = await prisma.account.findUniqueOrThrow({
    where: { id: accountId },
    select: { avatarFileId: true },
  });
  return account.avatarFileId === fileId;
}

/**
 * Makes an uploaded AVATAR file the account's photo. 400 INVALID_FILE for another owner, purpose
 * or an unfinished upload; 409 FILE_IN_USE for a file already attached elsewhere; 403 while an
 * admin has paused document uploads. The previous photo is discarded and its objects removed
 * after the commit. Setting the photo it already has changes nothing, and so does a repeat that
 * lost a race to the first request (a double click): the photo is already the one asked for.
 * Only a tutor's photo is published; a student's stays behind signed URLs (students may be minors).
 */
export async function setAvatar(
  accountId: string,
  fileId: string,
): Promise<{ avatarUrl: string | null }> {
  const current = await prisma.account.findUniqueOrThrow({
    where: { id: accountId },
    select: { avatarFileId: true, role: true },
  });
  if (current.avatarFileId !== fileId) {
    let replaced: FileAsset | null = null;
    try {
      replaced = await prisma.$transaction(async (tx) => {
        await claimFile(tx, { fileId, ownerAccountId: accountId, purpose: "AVATAR" });
        const previous = await lockAvatar(tx, accountId);
        await tx.account.update({ where: { id: accountId }, data: { avatarFileId: fileId } });
        return previous ? discardFile(tx, previous) : null;
      });
    } catch (err) {
      if (!isFileInUse(err) || !(await hasAvatar(accountId, fileId))) throw err;
    }
    // Both after the commit: a failed copy is logged and the file stays served through signed URLs.
    if (current.role === "TUTOR") {
      await publishFile(fileId);
      // A block that committed while the copy ran missed this file, so take the copy down again.
      // A hard delete that committed meanwhile leaves no row: unpublish too, rather than 500.
      const row = await prisma.account.findUnique({
        where: { id: accountId },
        select: { status: true },
      });
      if (row?.status !== "ACTIVE") await unpublishFile(fileId);
    }
    if (replaced) await removeObjects([replaced]);
  }
  return { avatarUrl: await currentAvatarUrl(accountId) };
}

/** Removes the account's photo. The Google picture, if any, shows again. */
export async function clearAvatar(accountId: string): Promise<{ avatarUrl: string | null }> {
  const removed = await prisma.$transaction(async (tx) => {
    const previous = await lockAvatar(tx, accountId);
    if (!previous) return null;
    await tx.account.update({ where: { id: accountId }, data: { avatarFileId: null } });
    return discardFile(tx, previous);
  });
  if (removed) await removeObjects([removed]);
  return { avatarUrl: await currentAvatarUrl(accountId) };
}
