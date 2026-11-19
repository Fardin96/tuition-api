import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createAdmin,
  createFileAsset,
  createTestApp,
  createTutorProfile,
  getAuthHeaders,
} from "../../tests/helpers.js";

async function adminWithHeaders() {
  const admin = await createAdmin();
  return { admin, headers: await getAuthHeaders(admin) };
}

async function uploaderAccount() {
  const account = await createAccount({ role: "TUTOR" });
  await createTutorProfile(account.id);
  return account;
}

function historyUrl(accountId: string, query = "") {
  return `/api/v1/admin/accounts/${accountId}/uploads${query}`;
}

function blockUrl(accountId: string) {
  return `/api/v1/admin/accounts/${accountId}/upload-block`;
}

function liftUrl(accountId: string) {
  return `/api/v1/admin/accounts/${accountId}/upload-block/lift`;
}

const VALID_BLOCK = { blocksVideos: true, blocksDocuments: false, note: "Video was off topic." };

async function seedReview(
  accountId: string,
  action: "APPROVED" | "REJECTED" | "REVOKED" | "REMOVED" | "BLOCKED" | "UNBLOCKED",
  overrides: {
    createdAt?: Date;
    note?: string | null;
    noteVisible?: boolean;
    actorAccountId?: string;
    fileId?: string;
  } = {},
) {
  return prisma.uploadReview.create({
    data: {
      accountId,
      action,
      note:
        overrides.note === undefined ? (action === "APPROVED" ? null : "A note") : overrides.note,
      noteVisible: overrides.noteVisible ?? true,
      actorAccountId: overrides.actorAccountId ?? null,
      fileId: overrides.fileId ?? null,
      createdAt: overrides.createdAt,
      ...(action === "BLOCKED" || action === "UNBLOCKED"
        ? {}
        : {
            purpose: "CREDENTIAL",
            fileName: "cert.pdf",
            contentType: "application/pdf",
            sizeBytes: 2048,
          }),
    },
  });
}

describe("GET /api/v1/admin/accounts/:accountId/uploads", () => {
  it("no token gets 401 and private responses", async () => {
    const app = await createTestApp();
    const account = await uploaderAccount();

    const res = await app.inject({ method: "GET", url: historyUrl(account.id) });

    expect(res.statusCode).toBe(401);
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it("a tutor gets 403", async () => {
    const app = await createTestApp();
    const account = await uploaderAccount();
    const tutor = await uploaderAccount();

    const res = await app.inject({
      method: "GET",
      url: historyUrl(account.id),
      headers: await getAuthHeaders(tutor),
    });

    expect(res.statusCode).toBe(403);
  });

  it("an unknown account gets 404", async () => {
    const app = await createTestApp();
    const { headers } = await adminWithHeaders();

    const res = await app.inject({
      method: "GET",
      url: historyUrl("00000000-0000-4000-8000-000000000000"),
      headers,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe("Account not found");
  });

  it("an account with no history gets an empty page", async () => {
    const app = await createTestApp();
    const { headers } = await adminWithHeaders();
    const account = await uploaderAccount();

    const res = await app.inject({ method: "GET", url: historyUrl(account.id), headers });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      block: null,
      summary: { recentIssues: 0, total: 0, windowDays: 30, threshold: 3 },
      events: [],
      nextCursor: null,
    });
  });

  it("pages newest first with a keyset cursor", async () => {
    const app = await createTestApp();
    const { headers } = await adminWithHeaders();
    const account = await uploaderAccount();
    const base = Date.now() - 10 * 60 * 1000;
    const oldest = await seedReview(account.id, "APPROVED", { createdAt: new Date(base) });
    const middle = await seedReview(account.id, "APPROVED", { createdAt: new Date(base + 1000) });
    const newest = await seedReview(account.id, "APPROVED", { createdAt: new Date(base + 2000) });

    const first = await app.inject({
      method: "GET",
      url: historyUrl(account.id, "?limit=2"),
      headers,
    });
    expect(first.statusCode).toBe(200);
    const page1 = first.json();
    expect(page1.events.map((e: { id: string }) => e.id)).toEqual([newest.id, middle.id]);
    expect(page1.nextCursor).toEqual(expect.any(String));
    expect(page1.summary.total).toBe(3);

    const second = await app.inject({
      method: "GET",
      url: historyUrl(account.id, `?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`),
      headers,
    });
    const page2 = second.json();
    expect(page2.events.map((e: { id: string }) => e.id)).toEqual([oldest.id]);
    expect(page2.nextCursor).toBeNull();
  });

  it("rejects a malformed cursor and an out-of-range limit", async () => {
    const app = await createTestApp();
    const { headers } = await adminWithHeaders();
    const account = await uploaderAccount();

    const badCursor = await app.inject({
      method: "GET",
      url: historyUrl(account.id, "?cursor=not-a-cursor"),
      headers,
    });
    expect(badCursor.statusCode).toBe(400);

    const badLimit = await app.inject({
      method: "GET",
      url: historyUrl(account.id, "?limit=101"),
      headers,
    });
    expect(badLimit.statusCode).toBe(400);
  });

  it("returns file details, availability, the admin actor and hidden notes to admins", async () => {
    const app = await createTestApp();
    const { admin, headers } = await adminWithHeaders();
    const account = await uploaderAccount();
    const live = await createFileAsset(account.id, "CREDENTIAL", { originalName: "cert.pdf" });
    const gone = await createFileAsset(account.id, "CREDENTIAL", { status: "DELETED" });

    await seedReview(account.id, "REJECTED", {
      actorAccountId: admin.id,
      note: "Blurry scan.",
      noteVisible: false,
      fileId: live.id,
    });
    await seedReview(account.id, "REMOVED", { actorAccountId: admin.id, fileId: gone.id });

    const res = await app.inject({ method: "GET", url: historyUrl(account.id), headers });
    const { events } = res.json();

    expect(events).toHaveLength(2);
    const [removed, rejected] = events;
    expect(removed).toMatchObject({
      action: "REMOVED",
      fileId: gone.id,
      fileAvailable: false,
      purpose: "CREDENTIAL",
      fileName: "cert.pdf",
      contentType: "application/pdf",
      sizeBytes: 2048,
      actor: { accountId: admin.id, name: "Test Admin" },
    });
    expect(rejected).toMatchObject({
      action: "REJECTED",
      fileId: live.id,
      fileAvailable: true,
      note: "Blurry scan.",
      noteVisible: false,
    });
  });

  it("counts issues in the last 30 days and the total over all rows", async () => {
    const app = await createTestApp();
    const { headers } = await adminWithHeaders();
    const account = await uploaderAccount();
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);

    await seedReview(account.id, "REJECTED");
    await seedReview(account.id, "REVOKED");
    await seedReview(account.id, "REMOVED");
    await seedReview(account.id, "APPROVED");
    await seedReview(account.id, "REJECTED", { createdAt: old });

    const res = await app.inject({ method: "GET", url: historyUrl(account.id), headers });

    expect(res.json().summary).toEqual({ recentIssues: 3, total: 5, windowDays: 30, threshold: 3 });
  });

  it("includes the active block with its admin and hides none of it from admins", async () => {
    const app = await createTestApp();
    const { admin, headers } = await adminWithHeaders();
    const account = await uploaderAccount();
    await prisma.uploadBlock.create({
      data: {
        accountId: account.id,
        blocksVideos: false,
        blocksDocuments: true,
        note: "Documents are unclear.",
        noteVisible: false,
        blockedById: admin.id,
      },
    });

    const res = await app.inject({ method: "GET", url: historyUrl(account.id), headers });

    expect(res.json().block).toMatchObject({
      blocksVideos: false,
      blocksDocuments: true,
      note: "Documents are unclear.",
      noteVisible: false,
      blockedBy: { accountId: admin.id, name: "Test Admin" },
    });
  });

  it("does not show a closed block as active", async () => {
    const app = await createTestApp();
    const { headers } = await adminWithHeaders();
    const account = await uploaderAccount();
    await prisma.uploadBlock.create({
      data: {
        accountId: account.id,
        blocksVideos: true,
        blocksDocuments: false,
        note: "Done.",
        unblockedAt: new Date(),
      },
    });

    const res = await app.inject({ method: "GET", url: historyUrl(account.id), headers });

    expect(res.json().block).toBeNull();
  });
});

describe("PUT /api/v1/admin/accounts/:accountId/upload-block", () => {
  it("a non-admin gets 403 and nothing is written", async () => {
    const app = await createTestApp();
    const account = await uploaderAccount();
    const other = await uploaderAccount();

    const res = await app.inject({
      method: "PUT",
      url: blockUrl(account.id),
      headers: await getAuthHeaders(other),
      payload: VALID_BLOCK,
    });

    expect(res.statusCode).toBe(403);
    expect(await prisma.uploadBlock.count()).toBe(0);
  });

  it("creates the block, a history row, an alert and an audit row", async () => {
    const app = await createTestApp();
    const { admin, headers } = await adminWithHeaders();
    const account = await uploaderAccount();

    const res = await app.inject({
      method: "PUT",
      url: blockUrl(account.id),
      headers,
      payload: VALID_BLOCK,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      blocksVideos: true,
      blocksDocuments: false,
      note: "Video was off topic.",
      noteVisible: true,
      blockedBy: { accountId: admin.id, name: "Test Admin" },
    });

    const history = await prisma.uploadReview.findMany({ where: { accountId: account.id } });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      action: "BLOCKED",
      fileId: null,
      purpose: null,
      actorAccountId: admin.id,
    });

    const alerts = await prisma.appNotification.findMany({
      where: { recipientId: account.id, kind: "UPLOADS_BLOCKED" },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      note: "Video was off topic.",
      blocksVideos: true,
      blocksDocuments: false,
      applicationId: null,
    });

    const audit = await prisma.auditLog.findFirst({ where: { action: "uploads.block" } });
    expect(audit).toMatchObject({
      actorAccountId: admin.id,
      entityType: "account",
      entityId: account.id,
    });
    expect(audit?.before).toBeNull();
    expect(audit?.after).toMatchObject({
      blocksVideos: true,
      blocksDocuments: false,
      noteVisible: true,
    });
  });

  it("updates the active block in place and keeps one active row", async () => {
    const app = await createTestApp();
    const { admin, headers } = await adminWithHeaders();
    const account = await uploaderAccount();
    const first = await app.inject({
      method: "PUT",
      url: blockUrl(account.id),
      headers,
      payload: VALID_BLOCK,
    });
    const firstId = first.json().id;

    const res = await app.inject({
      method: "PUT",
      url: blockUrl(account.id),
      headers,
      payload: {
        blocksVideos: true,
        blocksDocuments: true,
        note: "Both are paused for review.",
        noteVisible: false,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: firstId,
      blocksVideos: true,
      blocksDocuments: true,
      note: "Both are paused for review.",
      noteVisible: false,
    });
    const active = await prisma.uploadBlock.findMany({
      where: { accountId: account.id, unblockedAt: null },
    });
    expect(active).toHaveLength(1);

    const history = await prisma.uploadReview.findMany({
      where: { accountId: account.id, action: "BLOCKED" },
    });
    expect(history).toHaveLength(2);

    const alerts = await prisma.appNotification.findMany({
      where: { recipientId: account.id, kind: "UPLOADS_BLOCKED" },
      orderBy: { createdAt: "asc" },
    });
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toMatchObject({ note: null, blocksDocuments: true });

    const audit = await prisma.auditLog.findMany({
      where: { action: "uploads.block", entityId: account.id },
      orderBy: { createdAt: "asc" },
    });
    expect(audit).toHaveLength(2);
    expect(audit[1]?.before).toMatchObject({
      blocksVideos: true,
      blocksDocuments: false,
      noteVisible: true,
    });
    expect(audit[1]?.actorAccountId).toBe(admin.id);
  });

  it("refuses a block that pauses nothing with 400 on blocksVideos", async () => {
    const app = await createTestApp();
    const { headers } = await adminWithHeaders();
    const account = await uploaderAccount();

    const res = await app.inject({
      method: "PUT",
      url: blockUrl(account.id),
      headers,
      payload: { blocksVideos: false, blocksDocuments: false, note: "Nothing to pause." },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(res.json())).toContain("Pick videos, documents or both.");
    expect(await prisma.uploadBlock.count()).toBe(0);
  });

  it("refuses a short note and unknown fields", async () => {
    const app = await createTestApp();
    const { headers } = await adminWithHeaders();
    const account = await uploaderAccount();

    const shortNote = await app.inject({
      method: "PUT",
      url: blockUrl(account.id),
      headers,
      payload: { ...VALID_BLOCK, note: "ok" },
    });
    expect(shortNote.statusCode).toBe(400);

    const extra = await app.inject({
      method: "PUT",
      url: blockUrl(account.id),
      headers,
      payload: { ...VALID_BLOCK, reason: "extra" },
    });
    expect(extra.statusCode).toBe(400);
  });

  it("refuses to block an admin account with 400", async () => {
    const app = await createTestApp();
    const { headers } = await adminWithHeaders();
    const otherAdmin = await createAdmin();

    const res = await app.inject({
      method: "PUT",
      url: blockUrl(otherAdmin.id),
      headers,
      payload: VALID_BLOCK,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("Admin accounts can't be blocked from uploads.");
    expect(await prisma.uploadBlock.count()).toBe(0);
  });

  it("an unknown account gets 404", async () => {
    const app = await createTestApp();
    const { headers } = await adminWithHeaders();

    const res = await app.inject({
      method: "PUT",
      url: blockUrl("00000000-0000-4000-8000-000000000000"),
      headers,
      payload: VALID_BLOCK,
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/v1/admin/accounts/:accountId/upload-block/lift", () => {
  it("closes the block with a visible note and writes history, alert and audit", async () => {
    const app = await createTestApp();
    const { admin, headers } = await adminWithHeaders();
    const account = await uploaderAccount();
    await app.inject({ method: "PUT", url: blockUrl(account.id), headers, payload: VALID_BLOCK });

    const res = await app.inject({
      method: "POST",
      url: liftUrl(account.id),
      headers,
      payload: { note: "Thanks for fixing the file.", noteVisible: true },
    });

    expect(res.statusCode).toBe(204);
    const block = await prisma.uploadBlock.findFirstOrThrow({ where: { accountId: account.id } });
    expect(block.unblockedAt).toBeInstanceOf(Date);
    expect(block.unblockedById).toBe(admin.id);

    const history = await prisma.uploadReview.findFirst({
      where: { accountId: account.id, action: "UNBLOCKED" },
    });
    expect(history).toMatchObject({
      note: "Thanks for fixing the file.",
      noteVisible: true,
      actorAccountId: admin.id,
    });

    const alert = await prisma.appNotification.findFirst({
      where: { recipientId: account.id, kind: "UPLOADS_UNBLOCKED" },
    });
    expect(alert?.note).toBe("Thanks for fixing the file.");

    const audit = await prisma.auditLog.findFirst({ where: { action: "uploads.unblock" } });
    expect(audit).toMatchObject({ actorAccountId: admin.id, entityId: account.id });
  });

  it("works with no body, and the alert carries no note", async () => {
    const app = await createTestApp();
    const { headers } = await adminWithHeaders();
    const account = await uploaderAccount();
    await app.inject({ method: "PUT", url: blockUrl(account.id), headers, payload: VALID_BLOCK });

    const res = await app.inject({ method: "POST", url: liftUrl(account.id), headers });

    expect(res.statusCode).toBe(204);
    const alert = await prisma.appNotification.findFirst({
      where: { recipientId: account.id, kind: "UPLOADS_UNBLOCKED" },
    });
    expect(alert).not.toBeNull();
    expect(alert?.note).toBeNull();
    const history = await prisma.uploadReview.findFirst({
      where: { accountId: account.id, action: "UNBLOCKED" },
    });
    expect(history?.note).toBeNull();
  });

  it("keeps a hidden note out of the alert but in the history", async () => {
    const app = await createTestApp();
    const { headers } = await adminWithHeaders();
    const account = await uploaderAccount();
    await app.inject({ method: "PUT", url: blockUrl(account.id), headers, payload: VALID_BLOCK });

    await app.inject({
      method: "POST",
      url: liftUrl(account.id),
      headers,
      payload: { note: "Internal check passed.", noteVisible: false },
    });

    const alert = await prisma.appNotification.findFirst({
      where: { recipientId: account.id, kind: "UPLOADS_UNBLOCKED" },
    });
    expect(alert?.note).toBeNull();
    const history = await prisma.uploadReview.findFirst({
      where: { accountId: account.id, action: "UNBLOCKED" },
    });
    expect(history).toMatchObject({ note: "Internal check passed.", noteVisible: false });
  });

  it("lifting with nothing blocked gets 404", async () => {
    const app = await createTestApp();
    const { headers } = await adminWithHeaders();
    const account = await uploaderAccount();

    const res = await app.inject({ method: "POST", url: liftUrl(account.id), headers });

    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe("No active upload block");
  });

  it("lifting twice gets 404 the second time", async () => {
    const app = await createTestApp();
    const { headers } = await adminWithHeaders();
    const account = await uploaderAccount();
    await app.inject({ method: "PUT", url: blockUrl(account.id), headers, payload: VALID_BLOCK });
    await app.inject({ method: "POST", url: liftUrl(account.id), headers });

    const res = await app.inject({ method: "POST", url: liftUrl(account.id), headers });

    expect(res.statusCode).toBe(404);
  });

  it("an unknown account gets 404", async () => {
    const app = await createTestApp();
    const { headers } = await adminWithHeaders();

    const res = await app.inject({
      method: "POST",
      url: liftUrl("00000000-0000-4000-8000-000000000000"),
      headers,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe("Account not found");
  });
});

describe("GET /api/v1/files/upload-status", () => {
  it("no token gets 401", async () => {
    const app = await createTestApp();

    const res = await app.inject({ method: "GET", url: "/api/v1/files/upload-status" });

    expect(res.statusCode).toBe(401);
  });

  it("is all false and null when nothing is paused", async () => {
    const app = await createTestApp();
    const account = await uploaderAccount();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/files/upload-status",
      headers: await getAuthHeaders(account),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.json()).toEqual({
      blocksVideos: false,
      blocksDocuments: false,
      note: null,
      blockedAt: null,
    });
  });

  it("shows the visible note of an active block", async () => {
    const app = await createTestApp();
    const { headers } = await adminWithHeaders();
    const account = await uploaderAccount();
    await app.inject({ method: "PUT", url: blockUrl(account.id), headers, payload: VALID_BLOCK });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/files/upload-status",
      headers: await getAuthHeaders(account),
    });

    expect(res.json()).toMatchObject({
      blocksVideos: true,
      blocksDocuments: false,
      note: "Video was off topic.",
      blockedAt: expect.any(String),
    });
  });

  it("hides a note the admin kept private", async () => {
    const app = await createTestApp();
    const { headers } = await adminWithHeaders();
    const account = await uploaderAccount();
    await app.inject({
      method: "PUT",
      url: blockUrl(account.id),
      headers,
      payload: { ...VALID_BLOCK, noteVisible: false },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/files/upload-status",
      headers: await getAuthHeaders(account),
    });

    expect(res.json()).toMatchObject({ blocksVideos: true, note: null });
  });

  it("a lifted block reads as not paused", async () => {
    const app = await createTestApp();
    const { headers } = await adminWithHeaders();
    const account = await uploaderAccount();
    await app.inject({ method: "PUT", url: blockUrl(account.id), headers, payload: VALID_BLOCK });
    await app.inject({ method: "POST", url: liftUrl(account.id), headers });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/files/upload-status",
      headers: await getAuthHeaders(account),
    });

    expect(res.json()).toEqual({
      blocksVideos: false,
      blocksDocuments: false,
      note: null,
      blockedAt: null,
    });
  });
});
