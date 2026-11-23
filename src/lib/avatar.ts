import type { FileAsset } from "../generated/prisma/client.js";
import { fileUrl } from "../modules/files/files.service.js";

// Nest under an account relation (`account: { select: avatarSelect }`) so the avatar comes in the same query.
export const avatarSelect = {
  status: true,
  googlePictureUrl: true,
  avatarFile: { select: { storageKey: true, status: true, publishedAt: true } },
} as const;

export type AvatarAccount = {
  status: string;
  googlePictureUrl: string | null;
  avatarFile: Pick<FileAsset, "storageKey" | "status" | "publishedAt"> | null;
};

/**
 * The picture a page shows for an account: its uploaded avatar (the public URL once published),
 * else the Google picture from its last sign-in, else null. Only an ACTIVE account shows one, so a
 * blocked or deleted account's photo leaves every public card.
 */
export async function avatarUrlFor(
  account: AvatarAccount | null | undefined,
): Promise<string | null> {
  if (account?.status !== "ACTIVE") return null;
  if (account.avatarFile) {
    const url = await fileUrl(account.avatarFile);
    if (url) return url;
  }
  return account.googlePictureUrl;
}

/** Google's picture is kept only as an https URL of at most 1000 characters; anything else is null. */
export function googlePictureFor(picture: string | undefined): string | null {
  if (!picture || picture.length > 1000) return null;
  try {
    return new URL(picture).protocol === "https:" ? picture : null;
  } catch {
    return null;
  }
}

/** Moves the nested account off a row and puts its avatarUrl in its place, so the account never leaves the API. */
export async function withAvatarUrl<T extends { account: AvatarAccount }>(
  row: T,
): Promise<Omit<T, "account"> & { avatarUrl: string | null }> {
  const { account, ...rest } = row;
  return { ...rest, avatarUrl: await avatarUrlFor(account) };
}
