import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { setStorageForTests } from "../../lib/storage.js";
import {
  createAccount,
  createFakeStorage,
  createFileAsset,
  createTutorProfile,
  fakeFileBytes,
} from "../../tests/helpers.js";
import { runFileCleanup } from "./file-cleanup.service.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function ago(now: Date, ms: number): Date {
  return new Date(now.getTime() - ms);
}

function installFake() {
  const fake = createFakeStorage();
  setStorageForTests(fake.storage);
  return fake;
}

describe("runFileCleanup", () => {
  it("expires uploads that were never completed after a day", async () => {
    const fake = installFake();
    const now = new Date();
    const account = await createAccount({ role: "TUTOR" });

    const stale = await createFileAsset(account.id, "CREDENTIAL", {
      status: "PENDING_UPLOAD",
      createdAt: ago(now, 25 * HOUR),
    });
    fake.put(stale.storageKey, fakeFileBytes("application/pdf", 64), "application/pdf");
    const fresh = await createFileAsset(account.id, "CREDENTIAL", {
      status: "PENDING_UPLOAD",
      createdAt: ago(now, 23 * HOUR),
    });

    const result = await runFileCleanup(now);
    expect(result).toEqual({ expiredUploads: 1, orphansRemoved: 0, purged: 0 });

    const staleRow = await prisma.fileAsset.findUniqueOrThrow({ where: { id: stale.id } });
    expect(staleRow.status).toBe("DELETED");
    expect(staleRow.deletedAt?.getTime()).toBe(now.getTime());
    expect(fake.objects.has(stale.storageKey)).toBe(false);

    const freshRow = await prisma.fileAsset.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(freshRow.status).toBe("PENDING_UPLOAD");
  });

  it("removes uploaded files nothing uses after a week, including the public copy", async () => {
    const fake = installFake();
    const now = new Date();
    const account = await createAccount({ role: "TUTOR" });
    const tutor = await createTutorProfile(account.id);

    const orphan = await createFileAsset(account.id, "TUTOR_VIDEO", {
      uploadedAt: ago(now, 8 * DAY),
      publishedAt: ago(now, 8 * DAY),
    });
    fake.put(orphan.storageKey, fakeFileBytes("video/mp4", 64), "video/mp4");
    await fake.storage.copyToPublic(orphan.storageKey);

    const attached = await createFileAsset(account.id, "CREDENTIAL", {
      uploadedAt: ago(now, 8 * DAY),
    });
    await prisma.tutorCredential.create({
      data: { tutorId: tutor.id, examLabel: "SSC", result: "A+", fileId: attached.id },
    });

    const recent = await createFileAsset(account.id, "CREDENTIAL", {
      uploadedAt: ago(now, 6 * DAY),
    });

    const result = await runFileCleanup(now);
    expect(result).toEqual({ expiredUploads: 0, orphansRemoved: 1, purged: 0 });

    const orphanRow = await prisma.fileAsset.findUniqueOrThrow({ where: { id: orphan.id } });
    expect(orphanRow.status).toBe("DELETED");
    expect(orphanRow.publishedAt).toBeNull();
    expect(fake.objects.has(orphan.storageKey)).toBe(false);
    expect(fake.publicObjects.has(orphan.storageKey)).toBe(false);

    expect((await prisma.fileAsset.findUniqueOrThrow({ where: { id: attached.id } })).status).toBe(
      "UPLOADED",
    );
    expect((await prisma.fileAsset.findUniqueOrThrow({ where: { id: recent.id } })).status).toBe(
      "UPLOADED",
    );
  });

  it("purges deleted rows and their objects after 30 days", async () => {
    const fake = installFake();
    const now = new Date();
    const account = await createAccount({ role: "TUTOR" });

    const old = await createFileAsset(account.id, "CREDENTIAL", {
      status: "DELETED",
      deletedAt: ago(now, 31 * DAY),
    });
    fake.put(old.storageKey, fakeFileBytes("application/pdf", 64), "application/pdf");

    const recent = await createFileAsset(account.id, "CREDENTIAL", {
      status: "DELETED",
      deletedAt: ago(now, 29 * DAY),
    });

    const result = await runFileCleanup(now);
    expect(result).toEqual({ expiredUploads: 0, orphansRemoved: 0, purged: 1 });

    expect(await prisma.fileAsset.findUnique({ where: { id: old.id } })).toBeNull();
    expect(fake.objects.has(old.storageKey)).toBe(false);
    expect(await prisma.fileAsset.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });

  it("keeps a deleted row whose object could not be removed, and finishes the run", async () => {
    const fake = installFake();
    const now = new Date();
    const account = await createAccount({ role: "TUTOR" });
    const stuck = await createFileAsset(account.id, "CREDENTIAL", {
      status: "DELETED",
      deletedAt: ago(now, 31 * DAY),
    });
    fake.failNext();

    const result = await runFileCleanup(now);
    expect(result.purged).toBe(0);
    expect(await prisma.fileAsset.findUnique({ where: { id: stuck.id } })).not.toBeNull();

    expect((await runFileCleanup(now)).purged).toBe(1);
  });

  it("does nothing and reports zeros when storage is not configured", async () => {
    const now = new Date();
    const account = await createAccount({ role: "TUTOR" });
    const stale = await createFileAsset(account.id, "CREDENTIAL", {
      status: "PENDING_UPLOAD",
      createdAt: ago(now, 2 * DAY),
    });

    const result = await runFileCleanup(now);
    expect(result).toEqual({ expiredUploads: 0, orphansRemoved: 0, purged: 0 });

    const row = await prisma.fileAsset.findUniqueOrThrow({ where: { id: stale.id } });
    expect(row.status).toBe("PENDING_UPLOAD");
  });
});
