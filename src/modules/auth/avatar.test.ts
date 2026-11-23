import { describe, expect, it } from "vitest";
import type { Prisma } from "../../generated/prisma/client.js";
import { avatarUrlFor } from "../../lib/avatar.js";
import { prisma } from "../../lib/prisma.js";
import { setStorageForTests } from "../../lib/storage.js";
import {
  createAccount,
  createAdmin,
  createApplication,
  createArea,
  createFakeStorage,
  createFileAsset,
  createRequirement,
  createStudentProfile,
  createTestApp,
  createTuitionPackage,
  createTutorProfile,
  fakeFileBytes,
  getAuthHeaders,
} from "../../tests/helpers.js";
import { runFileCleanup } from "../files/file-cleanup.service.js";
import { EMBED_URL_TTL } from "../files/file-policy.js";
import { discardFile, publishFile } from "../files/files.service.js";
import * as authService from "./auth.service.js";

const ME_AVATAR = "/api/v1/me/avatar";
const ADMIN_ACCOUNTS = "/api/v1/admin/accounts";
const MB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

function installFake() {
  const fake = createFakeStorage();
  setStorageForTests(fake.storage);
  return fake;
}

/** An UPLOADED AVATAR file with its bytes in the fake private bucket, as after a browser PUT. */
async function uploadedPhoto(fake: ReturnType<typeof createFakeStorage>, ownerId: string) {
  const file = await createFileAsset(ownerId, "AVATAR", { contentType: "image/png" });
  fake.put(file.storageKey, fakeFileBytes("image/png", 64), "image/png");
  return file;
}

/** The signed read link the fake storage returns for an unpublished photo. */
function signedPhoto(key: string): string {
  return `https://fake-r2.test/private/${key}?get&expires=${EMBED_URL_TTL}`;
}

async function studentWithHeaders(overrides: { googlePictureUrl?: string | null } = {}) {
  const account = await createAccount({ role: "STUDENT" });
  await prisma.account.update({
    where: { id: account.id },
    data: { googlePictureUrl: overrides.googlePictureUrl ?? null },
  });
  const area = await createArea();
  await createStudentProfile(account.id, area.id);
  return { account, headers: await getAuthHeaders(account) };
}

/** Resolves once some request is blocked on a row lock, so it has already read the rows. */
async function waitUntilBlockedOnLock(): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const [row] = await prisma.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND datname = current_database()`;
    if (row && row.waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("No request reached the row lock");
}

/**
 * Runs `change` in a transaction and holds its row locks until `request` is blocked on one. The
 * request reads the rows before the change commits, the way a concurrent request would.
 */
async function changeWhileRequestWaits<T>(
  change: (tx: Prisma.TransactionClient) => Promise<void>,
  request: () => Promise<T>,
): Promise<T> {
  let changed!: () => void;
  const ready = new Promise<void>((resolve) => {
    changed = resolve;
  });
  let commit!: () => void;
  const hold = new Promise<void>((resolve) => {
    commit = resolve;
  });
  const writer = prisma.$transaction(async (tx) => {
    await change(tx);
    changed();
    await hold;
  });
  await Promise.race([ready, writer]);
  const pending = request();
  try {
    await waitUntilBlockedOnLock();
  } finally {
    commit();
    await writer;
  }
  return pending;
}

describe("profile photo: PUT and DELETE /api/v1/me/avatar", () => {
  it("a student's uploaded photo becomes the profile photo, is served through a signed URL and is never published", async () => {
    const app = await createTestApp();
    const fake = installFake();
    const { account, headers } = await studentWithHeaders();
    const photo = await uploadedPhoto(fake, account.id);

    const res = await app.inject({
      method: "PUT",
      url: ME_AVATAR,
      headers,
      payload: { fileId: photo.id },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ avatarUrl: signedPhoto(photo.storageKey) });
    const row = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(row.avatarFileId).toBe(photo.id);
    const file = await prisma.fileAsset.findUniqueOrThrow({ where: { id: photo.id } });
    expect(file.publishedAt).toBeNull();
    expect(fake.publicObjects.has(photo.storageKey)).toBe(false);
  });

  it("a tutor's photo is published and shown at its public URL", async () => {
    const app = await createTestApp();
    const fake = installFake();
    const account = await createAccount({ role: "TUTOR" });
    await createTutorProfile(account.id);
    const photo = await uploadedPhoto(fake, account.id);

    const res = await app.inject({
      method: "PUT",
      url: ME_AVATAR,
      headers: await getAuthHeaders(account),
      payload: { fileId: photo.id },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ avatarUrl: `https://media.test/${photo.storageKey}` });
    const row = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(row.avatarFileId).toBe(photo.id);
    const file = await prisma.fileAsset.findUniqueOrThrow({ where: { id: photo.id } });
    expect(file.publishedAt).not.toBeNull();
    expect(fake.publicObjects.has(photo.storageKey)).toBe(true);
  });

  it("replacing the photo discards the old file and removes its stored copies", async () => {
    const app = await createTestApp();
    const fake = installFake();
    const { account, headers } = await studentWithHeaders({
      googlePictureUrl: "https://lh3.googleusercontent.com/a/old",
    });
    const first = await uploadedPhoto(fake, account.id);
    await app.inject({ method: "PUT", url: ME_AVATAR, headers, payload: { fileId: first.id } });
    const second = await uploadedPhoto(fake, account.id);

    const res = await app.inject({
      method: "PUT",
      url: ME_AVATAR,
      headers,
      payload: { fileId: second.id },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ avatarUrl: signedPhoto(second.storageKey) });
    const old = await prisma.fileAsset.findUniqueOrThrow({ where: { id: first.id } });
    expect(old.status).toBe("DELETED");
    expect(fake.objects.has(first.storageKey)).toBe(false);
    expect(fake.publicObjects.has(first.storageKey)).toBe(false);
    const row = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(row.avatarFileId).toBe(second.id);
    // Replacing a photo never touches the Google picture.
    expect(row.googlePictureUrl).toBe("https://lh3.googleusercontent.com/a/old");
  });

  it("setting the photo it already has changes nothing", async () => {
    const app = await createTestApp();
    const fake = installFake();
    const { account, headers } = await studentWithHeaders();
    const photo = await uploadedPhoto(fake, account.id);
    await app.inject({ method: "PUT", url: ME_AVATAR, headers, payload: { fileId: photo.id } });

    const res = await app.inject({
      method: "PUT",
      url: ME_AVATAR,
      headers,
      payload: { fileId: photo.id },
    });

    expect(res.statusCode).toBe(200);
    const file = await prisma.fileAsset.findUniqueOrThrow({ where: { id: photo.id } });
    expect(file.status).toBe("UPLOADED");
  });

  it("the same photo sent twice in a row answers 200 both times with the same URL", async () => {
    const app = await createTestApp();
    const fake = installFake();
    const { account, headers } = await studentWithHeaders();
    const photo = await uploadedPhoto(fake, account.id);
    const put = () =>
      app.inject({ method: "PUT", url: ME_AVATAR, headers, payload: { fileId: photo.id } });

    const first = await put();
    const second = await put();

    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body)).toEqual(JSON.parse(first.body));
    expect(JSON.parse(second.body)).toEqual({ avatarUrl: signedPhoto(photo.storageKey) });
  });

  it("a double click's second request gets the photo it asked for, not a conflict", async () => {
    const app = await createTestApp();
    const fake = installFake();
    const { account, headers } = await studentWithHeaders();
    const photo = await uploadedPhoto(fake, account.id);

    // The first request attaches the photo and commits while the second one waits on the file lock.
    const res = await changeWhileRequestWaits(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM file_asset WHERE id = ${photo.id}::uuid FOR UPDATE`;
        await tx.account.update({ where: { id: account.id }, data: { avatarFileId: photo.id } });
      },
      () => app.inject({ method: "PUT", url: ME_AVATAR, headers, payload: { fileId: photo.id } }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ avatarUrl: signedPhoto(photo.storageKey) });
    const file = await prisma.fileAsset.findUniqueOrThrow({ where: { id: photo.id } });
    expect(file.publishedAt).toBeNull();
    expect(fake.publicObjects.has(photo.storageKey)).toBe(false);
  });

  it("409 INVALID_ACCOUNT_STATE when the photo changes between the read and the lock", async () => {
    const app = await createTestApp();
    const fake = installFake();
    const { account, headers } = await studentWithHeaders();
    const photo = await uploadedPhoto(fake, account.id);
    const other = await uploadedPhoto(fake, account.id);

    // Another request swaps the photo while this one has read the account but not yet locked it.
    const res = await changeWhileRequestWaits(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM account WHERE id = ${account.id}::uuid FOR UPDATE`;
        await tx.account.update({ where: { id: account.id }, data: { avatarFileId: other.id } });
      },
      () => app.inject({ method: "PUT", url: ME_AVATAR, headers, payload: { fileId: photo.id } }),
    );

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("INVALID_ACCOUNT_STATE");
    const row = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(row.avatarFileId).toBe(other.id);
  });

  it("clearing the photo discards it and falls back to the Google picture", async () => {
    const app = await createTestApp();
    const fake = installFake();
    const google = "https://lh3.googleusercontent.com/a/me";
    const { account, headers } = await studentWithHeaders({ googlePictureUrl: google });
    const photo = await uploadedPhoto(fake, account.id);
    await app.inject({ method: "PUT", url: ME_AVATAR, headers, payload: { fileId: photo.id } });

    const res = await app.inject({ method: "DELETE", url: ME_AVATAR, headers });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ avatarUrl: google });
    const row = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(row.avatarFileId).toBeNull();
    expect(row.googlePictureUrl).toBe(google);
    const file = await prisma.fileAsset.findUniqueOrThrow({ where: { id: photo.id } });
    expect(file.status).toBe("DELETED");
    expect(fake.objects.has(photo.storageKey)).toBe(false);
  });

  it("rejects a file of another purpose, someone else's file, and an unfinished upload with 400", async () => {
    const app = await createTestApp();
    const fake = installFake();
    const { account, headers } = await studentWithHeaders();
    const other = await createAccount({ role: "STUDENT" });

    const wrongPurpose = await createFileAsset(account.id, "STORY_IMAGE", {
      contentType: "image/png",
    });
    const someoneElses = await uploadedPhoto(fake, other.id);
    const unfinished = await createFileAsset(account.id, "AVATAR", {
      status: "PENDING_UPLOAD",
      contentType: "image/png",
    });

    for (const file of [wrongPurpose, someoneElses, unfinished]) {
      const res = await app.inject({
        method: "PUT",
        url: ME_AVATAR,
        headers,
        payload: { fileId: file.id },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("INVALID_FILE");
    }
    const row = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(row.avatarFileId).toBeNull();
  });

  it("refuses a photo while an admin has paused document uploads, with 403", async () => {
    const app = await createTestApp();
    const fake = installFake();
    const admin = await createAdmin({ status: "ACTIVE" });
    const { account, headers } = await studentWithHeaders();
    await prisma.uploadBlock.create({
      data: {
        accountId: account.id,
        blocksVideos: false,
        blocksDocuments: true,
        note: "Paused for review.",
        noteVisible: true,
        blockedById: admin.id,
      },
    });
    const photo = await uploadedPhoto(fake, account.id);

    const res = await app.inject({
      method: "PUT",
      url: ME_AVATAR,
      headers,
      payload: { fileId: photo.id },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe("UPLOADS_BLOCKED");
    const row = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(row.avatarFileId).toBeNull();
  });

  it("admins get 403 on both photo routes", async () => {
    const app = await createTestApp();
    const fake = installFake();
    const admin = await createAdmin({ status: "ACTIVE" });
    const photo = await uploadedPhoto(fake, admin.id);
    const headers = await getAuthHeaders(admin);

    const put = await app.inject({
      method: "PUT",
      url: ME_AVATAR,
      headers,
      payload: { fileId: photo.id },
    });
    const del = await app.inject({ method: "DELETE", url: ME_AVATAR, headers });

    expect(put.statusCode).toBe(403);
    expect(del.statusCode).toBe(403);
  });

  it("refuses a photo over 2 MB when the upload is started", async () => {
    const app = await createTestApp();
    installFake();
    const { headers } = await studentWithHeaders();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/files/upload-url",
      headers,
      payload: { purpose: "AVATAR", contentType: "image/png", sizeBytes: 3 * MB },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("FILE_TOO_LARGE");
  });
});

describe("avatarUrl", () => {
  it("GET /me shows the Google picture when there is no photo, and null when there is neither", async () => {
    const app = await createTestApp();
    const google = "https://lh3.googleusercontent.com/a/picture";
    const withGoogle = await studentWithHeaders({ googlePictureUrl: google });
    const plain = await studentWithHeaders();

    const a = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: withGoogle.headers,
    });
    const b = await app.inject({ method: "GET", url: "/api/v1/me", headers: plain.headers });

    expect(JSON.parse(a.body).account.avatarUrl).toBe(google);
    expect(JSON.parse(b.body).account.avatarUrl).toBeNull();
    // The account row itself never leaves the API.
    expect(JSON.parse(a.body).account.googlePictureUrl).toBeUndefined();
  });

  it("a listed tutor's profile and search card carry the published photo", async () => {
    const app = await createTestApp();
    const fake = installFake();
    const account = await createAccount({ role: "TUTOR" });
    const tutor = await createTutorProfile(account.id, { isListed: true });
    const photo = await uploadedPhoto(fake, account.id);
    await app.inject({
      method: "PUT",
      url: ME_AVATAR,
      headers: await getAuthHeaders(account),
      payload: { fileId: photo.id },
    });

    const res = await app.inject({ method: "GET", url: `/api/v1/tutors/${tutor.id}` });
    const search = await app.inject({ method: "GET", url: "/api/v1/tutors" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).tutor.avatarUrl).toBe(`https://media.test/${photo.storageKey}`);
    expect(search.statusCode).toBe(200);
    expect(JSON.parse(search.body).tutors[0].avatarUrl).toBe(
      `https://media.test/${photo.storageKey}`,
    );
  });

  it("a tutor's photo shows on the application, package and review payloads", async () => {
    const app = await createTestApp();
    const fake = installFake();
    const tutorAccount = await createAccount({ role: "TUTOR" });
    const tutor = await createTutorProfile(tutorAccount.id, { isListed: true });
    const photo = await uploadedPhoto(fake, tutorAccount.id);
    await app.inject({
      method: "PUT",
      url: ME_AVATAR,
      headers: await getAuthHeaders(tutorAccount),
      payload: { fileId: photo.id },
    });
    const url = `https://media.test/${photo.storageKey}`;

    const studentAccount = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const student = await createStudentProfile(studentAccount.id, area.id);
    const headers = await getAuthHeaders(studentAccount);
    const requirement = await createRequirement({ studentId: student.id, areaId: area.id });
    await createApplication({
      requirementId: requirement.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
      status: "CONFIRMED",
    });
    const pkg = await createTuitionPackage(tutor.id);
    await prisma.review.create({
      data: {
        tutorId: tutor.id,
        studentId: student.id,
        direction: "TUTOR_TO_STUDENT",
        rating: 4,
        comment: "Punctual",
      },
    });

    const applications = await app.inject({ method: "GET", url: "/api/v1/applications", headers });
    const packageRes = await app.inject({
      method: "GET",
      url: `/api/v1/packages/${pkg.id}`,
      headers,
    });
    const reviews = await app.inject({
      method: "GET",
      url: `/api/v1/students/${student.id}/reviews`,
      headers,
    });

    expect(applications.json().applications[0].tutor.avatarUrl).toBe(url);
    expect(packageRes.json().tutor.avatarUrl).toBe(url);
    expect(reviews.json().reviews[0].tutor.avatarUrl).toBe(url);
  });

  it("is null for a blocked or deleted account, even with a photo or a Google picture", async () => {
    const blocked = await avatarUrlFor({
      status: "BLOCKED",
      googlePictureUrl: "https://lh3.googleusercontent.com/a/x",
      avatarFile: null,
    });
    const deleted = await avatarUrlFor({
      status: "DELETED",
      googlePictureUrl: "https://lh3.googleusercontent.com/a/x",
      avatarFile: null,
    });
    expect(blocked).toBeNull();
    expect(deleted).toBeNull();
  });
});

describe("cleanup, admin removal and hard delete", () => {
  it("the daily cleanup keeps an attached photo older than 7 days and removes an unused one", async () => {
    const fake = installFake();
    const now = new Date();
    const account = await createAccount({ role: "STUDENT" });
    const old = new Date(now.getTime() - 10 * DAY);
    const attached = await createFileAsset(account.id, "AVATAR", {
      contentType: "image/png",
      uploadedAt: old,
      createdAt: old,
    });
    fake.put(attached.storageKey, fakeFileBytes("image/png", 64), "image/png");
    await prisma.account.update({
      where: { id: account.id },
      data: { avatarFileId: attached.id },
    });
    const unused = await createFileAsset(account.id, "AVATAR", {
      contentType: "image/png",
      uploadedAt: old,
      createdAt: old,
    });
    fake.put(unused.storageKey, fakeFileBytes("image/png", 64), "image/png");

    const result = await runFileCleanup(now);

    expect(result.orphansRemoved).toBe(1);
    const kept = await prisma.fileAsset.findUniqueOrThrow({ where: { id: attached.id } });
    expect(kept.status).toBe("UPLOADED");
    expect(fake.objects.has(attached.storageKey)).toBe(true);
    const gone = await prisma.fileAsset.findUniqueOrThrow({ where: { id: unused.id } });
    expect(gone.status).toBe("DELETED");
  });

  it("an admin removing the photo clears it and tells the owner", async () => {
    const app = await createTestApp();
    const fake = installFake();
    const admin = await createAdmin({ status: "ACTIVE" });
    const { account } = await studentWithHeaders();
    const photo = await uploadedPhoto(fake, account.id);
    await prisma.account.update({ where: { id: account.id }, data: { avatarFileId: photo.id } });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/files/${photo.id}/remove`,
      headers: await getAuthHeaders(admin),
      payload: { note: "This is not a face photo.", noteVisible: true },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ id: photo.id, status: "DELETED" });
    const row = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(row.avatarFileId).toBeNull();
    expect(fake.objects.has(photo.storageKey)).toBe(false);
    const alert = await prisma.appNotification.findFirst({
      where: { recipientId: account.id, kind: "FILE_REMOVED" },
    });
    expect(alert).toMatchObject({ filePurpose: "AVATAR", note: "This is not a face photo." });
  });

  it("an admin sees a profile photo as in use, so the list offers Remove rather than Delete", async () => {
    const app = await createTestApp();
    const fake = installFake();
    const admin = await createAdmin({ status: "ACTIVE" });
    const { account } = await studentWithHeaders();
    const photo = await uploadedPhoto(fake, account.id);
    await prisma.account.update({ where: { id: account.id }, data: { avatarFileId: photo.id } });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/files?purpose=AVATAR",
      headers: await getAuthHeaders(admin),
    });

    expect(res.statusCode).toBe(200);
    const listed = JSON.parse(res.body).files.find((f: { id: string }) => f.id === photo.id);
    expect(listed).toMatchObject({ inUse: true, published: false });
  });

  it("blocking takes the public copy down and hides the photo; unblocking puts the copy back", async () => {
    const app = await createTestApp();
    const fake = installFake();
    const admin = await createAdmin({ status: "ACTIVE" });
    const adminHeaders = await getAuthHeaders(admin);
    const account = await createAccount({ role: "TUTOR" });
    await createTutorProfile(account.id);
    const headers = await getAuthHeaders(account);
    const photo = await uploadedPhoto(fake, account.id);
    await app.inject({ method: "PUT", url: ME_AVATAR, headers, payload: { fileId: photo.id } });
    const listRow = async (status: string) => {
      const res = await app.inject({
        method: "GET",
        url: `${ADMIN_ACCOUNTS}?status=${status}&q=${encodeURIComponent(account.email)}`,
        headers: adminHeaders,
      });
      return JSON.parse(res.body).accounts.find((a: { id: string }) => a.id === account.id);
    };
    expect(await listRow("ACTIVE")).toMatchObject({
      avatarUrl: `https://media.test/${photo.storageKey}`,
    });

    const block = await app.inject({
      method: "POST",
      url: `${ADMIN_ACCOUNTS}/${account.id}/block`,
      headers: adminHeaders,
      payload: { reason: "Spam listings" },
    });

    expect(block.statusCode).toBe(200);
    expect(fake.publicObjects.has(photo.storageKey)).toBe(false);
    expect(await listRow("BLOCKED")).toMatchObject({ status: "BLOCKED", avatarUrl: null });

    const unblock = await app.inject({
      method: "POST",
      url: `${ADMIN_ACCOUNTS}/${account.id}/unblock`,
      headers: adminHeaders,
    });

    expect(unblock.statusCode).toBe(200);
    expect(fake.publicObjects.has(photo.storageKey)).toBe(true);
    const file = await prisma.fileAsset.findUniqueOrThrow({ where: { id: photo.id } });
    expect(file.publishedAt).not.toBeNull();
  });

  it("deactivating an account takes the public copy down and keeps the photo for a return", async () => {
    const app = await createTestApp();
    const fake = installFake();
    const admin = await createAdmin({ status: "ACTIVE" });
    const account = await createAccount({ role: "TUTOR" });
    await createTutorProfile(account.id);
    const headers = await getAuthHeaders(account);
    const photo = await uploadedPhoto(fake, account.id);
    await app.inject({ method: "PUT", url: ME_AVATAR, headers, payload: { fileId: photo.id } });
    expect(fake.publicObjects.has(photo.storageKey)).toBe(true);

    const res = await app.inject({
      method: "POST",
      url: `${ADMIN_ACCOUNTS}/${account.id}/deactivate`,
      headers: await getAuthHeaders(admin),
      payload: { reason: "Duplicate account" },
    });

    expect(res.statusCode).toBe(200);
    expect(fake.publicObjects.has(photo.storageKey)).toBe(false);
    const row = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(row.avatarFileId).toBe(photo.id);
    const file = await prisma.fileAsset.findUniqueOrThrow({ where: { id: photo.id } });
    expect(file.status).toBe("UPLOADED");
  });

  it("deleting the account removes the photo's stored copy", async () => {
    const app = await createTestApp();
    const fake = installFake();
    const { account, headers } = await studentWithHeaders();
    const photo = await uploadedPhoto(fake, account.id);
    await prisma.account.update({ where: { id: account.id }, data: { avatarFileId: photo.id } });

    const res = await app.inject({ method: "DELETE", url: "/api/v1/me/hard-delete", headers });

    expect(res.statusCode).toBe(204);
    expect(fake.objects.has(photo.storageKey)).toBe(false);
    expect(await prisma.fileAsset.findUnique({ where: { id: photo.id } })).toBeNull();
  });
});

describe("Google picture on sign-in", () => {
  const sub = (tag: string) => `google-pic-${tag}-${crypto.randomUUID()}`;

  it("stores an https picture for a new account", async () => {
    const picture = "https://lh3.googleusercontent.com/a/new-user";
    const result = await authService.createOrUpdateAccount(
      { sub: sub("new"), email: `pic-new-${crypto.randomUUID()}@example.com`, picture },
      "STUDENT",
    );

    expect(result.account.googlePictureUrl).toBe(picture);
  });

  it("keeps only https pictures of at most 1000 characters, and clears one Google no longer sends", async () => {
    const googleSub = sub("sign-in");
    const email = `pic-sign-${crypto.randomUUID()}@example.com`;
    await authService.createOrUpdateAccount(
      { sub: googleSub, email, picture: "https://lh3.googleusercontent.com/a/first" },
      "STUDENT",
    );

    const insecure = await authService.createOrUpdateAccount(
      { sub: googleSub, email, picture: "http://lh3.googleusercontent.com/a/plain" },
      undefined,
    );
    const script = await authService.createOrUpdateAccount(
      { sub: googleSub, email, picture: "javascript:alert(1)" },
      undefined,
    );
    const tooLong = await authService.createOrUpdateAccount(
      { sub: googleSub, email, picture: `https://example.com/${"a".repeat(1000)}` },
      undefined,
    );
    const https = await authService.createOrUpdateAccount(
      { sub: googleSub, email, picture: "https://lh3.googleusercontent.com/a/second" },
      undefined,
    );
    const removed = await authService.createOrUpdateAccount({ sub: googleSub, email }, undefined);

    expect(insecure.account.googlePictureUrl).toBeNull();
    expect(script.account.googlePictureUrl).toBeNull();
    expect(tooLong.account.googlePictureUrl).toBeNull();
    expect(https.account.googlePictureUrl).toBe("https://lh3.googleusercontent.com/a/second");
    expect(removed.account.googlePictureUrl).toBeNull();
  });

  it("deleting my account takes the public copy down; signing back in stores the new picture and republishes it", async () => {
    const app = await createTestApp();
    const fake = installFake();
    const googleSub = sub("reactivate");
    const email = `pic-back-${crypto.randomUUID()}@example.com`;
    const account = await createAccount({ role: "TUTOR", email, googleSub });
    await createTutorProfile(account.id);
    const headers = await getAuthHeaders(account);
    const photo = await uploadedPhoto(fake, account.id);
    await app.inject({ method: "PUT", url: ME_AVATAR, headers, payload: { fileId: photo.id } });

    const deleted = await app.inject({ method: "DELETE", url: "/api/v1/me", headers });
    expect(deleted.statusCode).toBe(204);
    expect(fake.publicObjects.has(photo.storageKey)).toBe(false);

    const picture = "https://lh3.googleusercontent.com/a/back";
    const back = await authService.createOrUpdateAccount(
      { sub: googleSub, email, picture },
      "TUTOR",
    );

    expect(back.account.status).toBe("ACTIVE");
    expect(back.account.googlePictureUrl).toBe(picture);
    expect(back.account.avatarFileId).toBe(photo.id);
    expect(fake.publicObjects.has(photo.storageKey)).toBe(true);
  });

  it("signing back in does not publish a student's photo", async () => {
    const app = await createTestApp();
    const fake = installFake();
    const googleSub = sub("reactivate-student");
    const email = `pic-student-${crypto.randomUUID()}@example.com`;
    const account = await createAccount({ role: "STUDENT", email, googleSub });
    await createStudentProfile(account.id, (await createArea()).id);
    const headers = await getAuthHeaders(account);
    const photo = await uploadedPhoto(fake, account.id);
    await app.inject({ method: "PUT", url: ME_AVATAR, headers, payload: { fileId: photo.id } });
    const deleted = await app.inject({ method: "DELETE", url: "/api/v1/me", headers });
    expect(deleted.statusCode).toBe(204);

    const back = await authService.createOrUpdateAccount(
      { sub: googleSub, email, picture: "https://lh3.googleusercontent.com/a/s" },
      "STUDENT",
    );

    expect(back.account.status).toBe("ACTIVE");
    expect(fake.publicObjects.has(photo.storageKey)).toBe(false);
  });

  it("does not change the photo the account uploaded", async () => {
    const googleSub = sub("keep");
    const email = `pic-keep-${crypto.randomUUID()}@example.com`;
    const created = await authService.createOrUpdateAccount(
      { sub: googleSub, email, picture: "https://lh3.googleusercontent.com/a/x" },
      "STUDENT",
    );
    const fake = installFake();
    const photo = await uploadedPhoto(fake, created.account.id);
    await prisma.account.update({
      where: { id: created.account.id },
      data: { avatarFileId: photo.id },
    });

    const again = await authService.createOrUpdateAccount(
      { sub: googleSub, email, picture: "https://lh3.googleusercontent.com/a/y" },
      undefined,
    );

    expect(again.account.avatarFileId).toBe(photo.id);
  });
});

describe("publishing a photo while it changes state", () => {
  it("a file discarded during its public copy loses that copy and keeps no publish marker", async () => {
    const fake = installFake();
    const account = await createAccount({ role: "TUTOR" });
    const photo = await uploadedPhoto(fake, account.id);
    // The file is discarded after the copy lands, so publishFile must remove the copy it just made.
    const copy = fake.storage.copyToPublic;
    fake.storage.copyToPublic = async (key) => {
      await copy(key);
      await prisma.$transaction((tx) => discardFile(tx, photo.id));
    };

    await publishFile(photo.id);

    expect(fake.publicObjects.has(photo.storageKey)).toBe(false);
    const file = await prisma.fileAsset.findUniqueOrThrow({ where: { id: photo.id } });
    expect(file.publishedAt).toBeNull();
  });

  it("a block that commits while a tutor's photo is copied takes the copy back down", async () => {
    const app = await createTestApp();
    const fake = installFake();
    const admin = await createAdmin({ status: "ACTIVE" });
    const account = await createAccount({ role: "TUTOR" });
    await createTutorProfile(account.id);
    const headers = await getAuthHeaders(account);
    const photo = await uploadedPhoto(fake, account.id);
    // The block lands during the copy, after the block's own unpublish already ran.
    const copy = fake.storage.copyToPublic;
    fake.storage.copyToPublic = async (key) => {
      await copy(key);
      await prisma.accountBlock.create({
        data: { accountId: account.id, blockedById: admin.id, reason: "Spam listings" },
      });
    };

    const res = await app.inject({
      method: "PUT",
      url: ME_AVATAR,
      headers,
      payload: { fileId: photo.id },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ avatarUrl: null });
    expect(fake.publicObjects.has(photo.storageKey)).toBe(false);
    const file = await prisma.fileAsset.findUniqueOrThrow({ where: { id: photo.id } });
    expect(file.publishedAt).toBeNull();
  });
});
