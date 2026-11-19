import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { contentDisposition, setStorageForTests } from "../../lib/storage.js";
import {
  createAccount,
  createAdmin,
  createFakeStorage,
  createFileAsset,
  createTestApp,
  createTutorProfile,
  fakeFileBytes,
  getAuthHeaders,
} from "../../tests/helpers.js";
import { cleanFileName, MAX_FILE_NAME } from "./file-policy.js";

const PDF_SIZE = 64;
const MB = 1024 * 1024;

function installFakeStorage() {
  const fake = createFakeStorage();
  setStorageForTests(fake.storage);
  return fake;
}

async function tutorWithHeaders() {
  const account = await createAccount({ role: "TUTOR" });
  return { account, headers: await getAuthHeaders(account) };
}

async function startUpload(
  app: Awaited<ReturnType<typeof createTestApp>>,
  headers: Record<string, string>,
  body: Record<string, unknown>,
) {
  return app.inject({ method: "POST", url: "/api/v1/files/upload-url", headers, payload: body });
}

async function storageKeyOf(fileId: string): Promise<string> {
  return (await prisma.fileAsset.findUniqueOrThrow({ where: { id: fileId } })).storageKey;
}

/** Starts an upload and, when bytes are given, plays the browser's PUT into the fake bucket. */
async function uploadedFile(
  app: Awaited<ReturnType<typeof createTestApp>>,
  fake: ReturnType<typeof createFakeStorage>,
  headers: Record<string, string>,
  bytes: Uint8Array | null = fakeFileBytes("application/pdf", PDF_SIZE),
) {
  const res = await startUpload(app, headers, {
    purpose: "CREDENTIAL",
    contentType: "application/pdf",
    sizeBytes: PDF_SIZE,
    fileName: "certificate.pdf",
  });
  expect(res.statusCode).toBe(201);
  const { file } = res.json();
  const key = await storageKeyOf(file.id);
  if (bytes) fake.put(key, bytes, "application/pdf");
  return { id: file.id as string, key };
}

describe("POST /api/v1/files/upload-url", () => {
  it("reserves a pending file and returns a signed PUT URL", async () => {
    const app = await createTestApp();
    const fake = installFakeStorage();
    const { account, headers } = await tutorWithHeaders();

    const res = await startUpload(app, headers, {
      purpose: "CREDENTIAL",
      contentType: "application/pdf",
      sizeBytes: PDF_SIZE,
      fileName: "certificate.pdf",
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.method).toBe("PUT");
    expect(body.headers).toEqual({ "Content-Type": "application/pdf" });
    expect(body.uploadUrl).toContain("fake-r2.test");
    expect(body.file).toMatchObject({
      purpose: "CREDENTIAL",
      contentType: "application/pdf",
      sizeBytes: PDF_SIZE,
      status: "PENDING_UPLOAD",
      fileName: "certificate.pdf",
    });

    const row = await prisma.fileAsset.findUniqueOrThrow({ where: { id: body.file.id } });
    expect(row.status).toBe("PENDING_UPLOAD");
    expect(row.storageKey.startsWith(`credential/${account.id}/`)).toBe(true);
    expect(fake.presignedPuts).toEqual([
      { key: row.storageKey, contentType: "application/pdf", contentLength: PDF_SIZE },
    ]);
  });

  it("answers 403 when a student asks for a tutor video", async () => {
    const app = await createTestApp();
    installFakeStorage();
    const student = await createAccount({ role: "STUDENT" });

    const res = await startUpload(app, await getAuthHeaders(student), {
      purpose: "TUTOR_VIDEO",
      contentType: "video/mp4",
      sizeBytes: 1000,
    });
    expect(res.statusCode).toBe(403);
  });

  it("answers 403 when a tutor asks for a blog cover", async () => {
    const app = await createTestApp();
    installFakeStorage();
    const { headers } = await tutorWithHeaders();

    const res = await startUpload(app, headers, {
      purpose: "BLOG_COVER",
      contentType: "image/png",
      sizeBytes: 1000,
    });
    expect(res.statusCode).toBe(403);
  });

  it("answers 403 for a blog cover when the admin is still pending", async () => {
    const app = await createTestApp();
    installFakeStorage();
    const admin = await createAdmin({ status: "PENDING" });

    const res = await startUpload(app, await getAuthHeaders(admin), {
      purpose: "BLOG_COVER",
      contentType: "image/png",
      sizeBytes: 1000,
    });
    expect(res.statusCode).toBe(403);
  });

  it("lets an active admin upload a blog cover", async () => {
    const app = await createTestApp();
    installFakeStorage();
    const admin = await createAdmin();

    const res = await startUpload(app, await getAuthHeaders(admin), {
      purpose: "BLOG_COVER",
      contentType: "image/png",
      sizeBytes: 1000,
    });
    expect(res.statusCode).toBe(201);
  });

  it("answers 400 UNSUPPORTED_FILE_TYPE for a type the purpose does not accept", async () => {
    const app = await createTestApp();
    installFakeStorage();
    const { headers } = await tutorWithHeaders();

    const res = await startUpload(app, headers, {
      purpose: "CREDENTIAL",
      contentType: "text/plain",
      sizeBytes: 100,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("UNSUPPORTED_FILE_TYPE");
  });

  it("answers 400 FILE_TOO_LARGE above the purpose limit", async () => {
    const app = await createTestApp();
    installFakeStorage();
    const { headers } = await tutorWithHeaders();

    const res = await startUpload(app, headers, {
      purpose: "CREDENTIAL",
      contentType: "application/pdf",
      sizeBytes: 2 * MB + 1,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("FILE_TOO_LARGE");
  });

  it("answers 409 UPLOAD_LIMIT_REACHED after 10 unfinished uploads", async () => {
    const app = await createTestApp();
    installFakeStorage();
    const { headers } = await tutorWithHeaders();
    const body = { purpose: "CREDENTIAL", contentType: "application/pdf", sizeBytes: PDF_SIZE };

    for (let i = 0; i < 10; i++) {
      expect((await startUpload(app, headers, body)).statusCode).toBe(201);
    }
    const res = await startUpload(app, headers, body);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("UPLOAD_LIMIT_REACHED");
  });

  it("counts finished but unused uploads toward the limit, and not attached ones", async () => {
    const app = await createTestApp();
    installFakeStorage();
    const { account, headers } = await tutorWithHeaders();
    const tutor = await createTutorProfile(account.id);
    const body = { purpose: "CREDENTIAL", contentType: "application/pdf", sizeBytes: PDF_SIZE };

    const used = await Promise.all(
      Array.from({ length: 3 }, () => createFileAsset(account.id, "CREDENTIAL")),
    );
    for (const file of used) {
      await prisma.tutorCredential.create({
        data: { tutorId: tutor.id, examLabel: "SSC", result: "A+", fileId: file.id },
      });
    }
    for (let i = 0; i < 6; i++) await createFileAsset(account.id, "CREDENTIAL");
    await createFileAsset(account.id, "CREDENTIAL", { status: "DELETED" });

    // 6 unused uploaded + 3 pending = 9; the 3 attached and the deleted one do not count.
    for (let i = 0; i < 3; i++) {
      expect((await startUpload(app, headers, body)).statusCode).toBe(201);
    }
    expect((await startUpload(app, headers, body)).statusCode).toBe(201);
    const res = await startUpload(app, headers, body);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("UPLOAD_LIMIT_REACHED");
  });

  it("cleans the file name instead of refusing it", async () => {
    const app = await createTestApp();
    installFakeStorage();
    const { headers } = await tutorWithHeaders();
    const base = { purpose: "CREDENTIAL", contentType: "application/pdf", sizeBytes: PDF_SIZE };

    const spoofed = await startUpload(app, headers, {
      ...base,
      fileName: "C:\\fakepath\\cert\u202Efdp.exe",
    });
    expect(spoofed.statusCode).toBe(201);
    expect(spoofed.json().file.fileName).toBe("certfdp.exe");

    const blank = await startUpload(app, headers, { ...base, fileName: "   " });
    expect(blank.statusCode).toBe(201);
    expect(blank.json().file.fileName).toBeNull();

    const long = await startUpload(app, headers, { ...base, fileName: `${"a".repeat(400)}.pdf` });
    expect(long.statusCode).toBe(201);
    expect(long.json().file.fileName).toHaveLength(MAX_FILE_NAME);
    expect(long.json().file.fileName.endsWith(".pdf")).toBe(true);
  });

  it("answers 503 STORAGE_UNAVAILABLE when storage is not configured", async () => {
    const app = await createTestApp();
    const { headers } = await tutorWithHeaders();

    const res = await startUpload(app, headers, {
      purpose: "CREDENTIAL",
      contentType: "application/pdf",
      sizeBytes: PDF_SIZE,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("STORAGE_UNAVAILABLE");
  });
});

describe("POST /api/v1/files/:id/complete", () => {
  it("answers 409 UPLOAD_NOT_FOUND when nothing was PUT yet", async () => {
    const app = await createTestApp();
    const fake = installFakeStorage();
    const { headers } = await tutorWithHeaders();
    const file = await uploadedFile(app, fake, headers, null);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/files/${file.id}/complete`,
      headers,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("UPLOAD_NOT_FOUND");
  });

  it("marks the uploaded file UPLOADED", async () => {
    const app = await createTestApp();
    const fake = installFakeStorage();
    const { headers } = await tutorWithHeaders();
    const file = await uploadedFile(app, fake, headers);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/files/${file.id}/complete`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: file.id, status: "UPLOADED", sizeBytes: PDF_SIZE });
    expect(res.json().uploadedAt).not.toBeNull();

    const row = await prisma.fileAsset.findUniqueOrThrow({ where: { id: file.id } });
    expect(row.status).toBe("UPLOADED");
  });

  it("returns the same file when called again", async () => {
    const app = await createTestApp();
    const fake = installFakeStorage();
    const { headers } = await tutorWithHeaders();
    const file = await uploadedFile(app, fake, headers);
    const url = `/api/v1/files/${file.id}/complete`;

    const first = await app.inject({ method: "POST", url, headers });
    const second = await app.inject({ method: "POST", url, headers });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });

  it("deletes the object and the row when the stored size differs from the declared size", async () => {
    const app = await createTestApp();
    const fake = installFakeStorage();
    const { headers } = await tutorWithHeaders();
    const file = await uploadedFile(app, fake, headers, fakeFileBytes("application/pdf", 32));

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/files/${file.id}/complete`,
      headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_FILE");

    const row = await prisma.fileAsset.findUniqueOrThrow({ where: { id: file.id } });
    expect(row.status).toBe("DELETED");
    expect(fake.objects.has(file.key)).toBe(false);
  });

  it("deletes the object and the row when the bytes do not match the content type", async () => {
    const app = await createTestApp();
    const fake = installFakeStorage();
    const { headers } = await tutorWithHeaders();
    const file = await uploadedFile(app, fake, headers, new Uint8Array(PDF_SIZE));

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/files/${file.id}/complete`,
      headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("UNSUPPORTED_FILE_TYPE");

    const row = await prisma.fileAsset.findUniqueOrThrow({ where: { id: file.id } });
    expect(row.status).toBe("DELETED");
    expect(fake.objects.has(file.key)).toBe(false);
  });

  it("answers 404 for another account's file", async () => {
    const app = await createTestApp();
    const fake = installFakeStorage();
    const owner = await tutorWithHeaders();
    const other = await tutorWithHeaders();
    const file = await uploadedFile(app, fake, owner.headers);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/files/${file.id}/complete`,
      headers: other.headers,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/v1/files/:id/download-url", () => {
  it("gives the owner a short-lived link that is never cached", async () => {
    const app = await createTestApp();
    installFakeStorage();
    const { account, headers } = await tutorWithHeaders();
    const file = await createFileAsset(account.id, "CREDENTIAL");

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/files/${file.id}/download-url`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.json().url).toContain(file.storageKey);
    expect(new Date(res.json().expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("answers 404 for another user", async () => {
    const app = await createTestApp();
    installFakeStorage();
    const { account } = await tutorWithHeaders();
    const file = await createFileAsset(account.id, "CREDENTIAL");
    const student = await createAccount({ role: "STUDENT" });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/files/${file.id}/download-url`,
      headers: await getAuthHeaders(student),
    });
    expect(res.statusCode).toBe(404);
  });

  it("lets an active admin read a tutor ID and writes an audit row", async () => {
    const app = await createTestApp();
    installFakeStorage();
    const { account } = await tutorWithHeaders();
    const file = await createFileAsset(account.id, "TUTOR_ID");
    const admin = await createAdmin();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/files/${file.id}/download-url`,
      headers: await getAuthHeaders(admin),
    });
    expect(res.statusCode).toBe(200);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "file.view", entityId: file.id },
    });
    expect(audit?.actorAccountId).toBe(admin.id);
  });

  it("answers 404 for a file that is not uploaded yet", async () => {
    const app = await createTestApp();
    installFakeStorage();
    const { account, headers } = await tutorWithHeaders();
    const file = await createFileAsset(account.id, "CREDENTIAL", { status: "PENDING_UPLOAD" });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/files/${file.id}/download-url`,
      headers,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /api/v1/files/:id", () => {
  it("deletes an unattached file and its object", async () => {
    const app = await createTestApp();
    const fake = installFakeStorage();
    const { account, headers } = await tutorWithHeaders();
    const file = await createFileAsset(account.id, "CREDENTIAL", {
      storageKey: `credential/${account.id}/unattached.pdf`,
    });
    fake.put(file.storageKey, fakeFileBytes("application/pdf", PDF_SIZE), "application/pdf");

    const res = await app.inject({ method: "DELETE", url: `/api/v1/files/${file.id}`, headers });
    expect(res.statusCode).toBe(204);

    const row = await prisma.fileAsset.findUniqueOrThrow({ where: { id: file.id } });
    expect(row.status).toBe("DELETED");
    expect(fake.objects.has(file.storageKey)).toBe(false);
  });

  it("answers 409 FILE_IN_USE while a credential uses the file", async () => {
    const app = await createTestApp();
    installFakeStorage();
    const { account, headers } = await tutorWithHeaders();
    const tutor = await createTutorProfile(account.id);
    const file = await createFileAsset(account.id, "CREDENTIAL");
    await prisma.tutorCredential.create({
      data: { tutorId: tutor.id, examLabel: "SSC", result: "A+", fileId: file.id },
    });

    const res = await app.inject({ method: "DELETE", url: `/api/v1/files/${file.id}`, headers });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("FILE_IN_USE");

    const row = await prisma.fileAsset.findUniqueOrThrow({ where: { id: file.id } });
    expect(row.status).toBe("UPLOADED");
  });

  it("answers 404 for another user's file", async () => {
    const app = await createTestApp();
    installFakeStorage();
    const { account } = await tutorWithHeaders();
    const file = await createFileAsset(account.id, "CREDENTIAL");
    const other = await tutorWithHeaders();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/files/${file.id}`,
      headers: other.headers,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("file routes need a signed-in account", () => {
  it("answers 401 without a token", async () => {
    const app = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/files/upload-url",
      payload: { purpose: "CREDENTIAL", contentType: "application/pdf", sizeBytes: PDF_SIZE },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("upload blocks", () => {
  /** Blocks are written straight to the table here; the admin endpoints are tested in uploads.test.ts. */
  function block(
    accountId: string,
    scope: { blocksVideos: boolean; blocksDocuments: boolean },
    overrides: { noteVisible?: boolean } = {},
  ) {
    return prisma.uploadBlock.create({
      data: {
        accountId,
        ...scope,
        note: "Paused for review.",
        noteVisible: overrides.noteVisible ?? true,
      },
    });
  }

  it("a video block stops video uploads with 403 and leaves documents open", async () => {
    const app = await createTestApp();
    installFakeStorage();
    const { account, headers } = await tutorWithHeaders();
    await block(account.id, { blocksVideos: true, blocksDocuments: false });

    const video = await startUpload(app, headers, {
      purpose: "TUTOR_VIDEO",
      contentType: "video/mp4",
      sizeBytes: PDF_SIZE,
      fileName: "intro.mp4",
    });
    expect(video.statusCode).toBe(403);
    expect(video.json()).toMatchObject({
      code: "UPLOADS_BLOCKED",
      details: { category: "VIDEOS", note: "Paused for review." },
    });

    const document = await startUpload(app, headers, {
      purpose: "CREDENTIAL",
      contentType: "application/pdf",
      sizeBytes: PDF_SIZE,
      fileName: "certificate.pdf",
    });
    expect(document.statusCode).toBe(201);
  });

  it("a document block stops ID and certificate uploads and hides a private note", async () => {
    const app = await createTestApp();
    installFakeStorage();
    const { account, headers } = await tutorWithHeaders();
    await block(account.id, { blocksVideos: false, blocksDocuments: true }, { noteVisible: false });

    const document = await startUpload(app, headers, {
      purpose: "CREDENTIAL",
      contentType: "application/pdf",
      sizeBytes: PDF_SIZE,
      fileName: "certificate.pdf",
    });
    expect(document.statusCode).toBe(403);
    expect(document.json()).toMatchObject({
      code: "UPLOADS_BLOCKED",
      details: { category: "DOCUMENTS", note: null },
    });
    expect(JSON.stringify(document.json())).not.toContain("Paused for review.");

    const video = await startUpload(app, headers, {
      purpose: "TUTOR_VIDEO",
      contentType: "video/mp4",
      sizeBytes: PDF_SIZE,
      fileName: "intro.mp4",
    });
    expect(video.statusCode).toBe(201);
  });

  it("a block placed after the upload started stops attaching the file", async () => {
    const app = await createTestApp();
    installFakeStorage();
    const { account, headers } = await tutorWithHeaders();
    await createTutorProfile(account.id);
    const file = await createFileAsset(account.id, "CREDENTIAL", { originalName: "cert.pdf" });
    await block(account.id, { blocksVideos: false, blocksDocuments: true });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tutors/me/credentials",
      headers,
      payload: { examLabel: "IELTS", result: "7.5", fileId: file.id },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("UPLOADS_BLOCKED");
    expect(await prisma.tutorCredential.count()).toBe(0);
  });

  it("a video block does not stop a certificate from being attached", async () => {
    const app = await createTestApp();
    installFakeStorage();
    const { account, headers } = await tutorWithHeaders();
    await createTutorProfile(account.id);
    const file = await createFileAsset(account.id, "CREDENTIAL", { originalName: "cert.pdf" });
    await block(account.id, { blocksVideos: true, blocksDocuments: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tutors/me/credentials",
      headers,
      payload: { examLabel: "IELTS", result: "7.5", fileId: file.id },
    });

    expect(res.statusCode).toBe(201);
  });

  it("blog covers are never blocked", async () => {
    const app = await createTestApp();
    installFakeStorage();
    const admin = await createAdmin();
    // Admins cannot be blocked through the API; a row written directly must still not stop a cover.
    await block(admin.id, { blocksVideos: true, blocksDocuments: true });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/files/upload-url",
      headers: await getAuthHeaders(admin),
      payload: { purpose: "BLOG_COVER", contentType: "image/png", sizeBytes: PDF_SIZE },
    });

    expect(res.statusCode).toBe(201);
  });
});

describe("cleanFileName", () => {
  it("keeps an ordinary name, including non-Latin scripts", () => {
    expect(cleanFileName("certificate.pdf")).toBe("certificate.pdf");
    expect(cleanFileName("জাতীয় পরিচয়পত্র.jpg")).toBe("জাতীয় পরিচয়পত্র.jpg");
  });

  it("drops paths, control and direction characters, and folds whitespace", () => {
    expect(cleanFileName("C:\\fakepath\\id.png")).toBe("id.png");
    expect(cleanFileName("../../etc/passwd")).toBe("passwd");
    expect(cleanFileName("my\u202Egnp.exe")).toBe("mygnp.exe");
    expect(cleanFileName("a\u0000b\n c\t.pdf")).toBe("ab c.pdf");
    expect(cleanFileName("\u200B \u00A0 ")).toBeNull();
  });

  it("shortens long names and keeps the extension", () => {
    const name = cleanFileName(`${"x".repeat(500)}.webm`);
    expect(name).toHaveLength(MAX_FILE_NAME);
    expect(name?.endsWith(".webm")).toBe(true);
    // Never splits a character made of two UTF-16 units.
    const emoji = cleanFileName(`${"😀".repeat(300)}.png`) ?? "";
    expect([...emoji]).toHaveLength(MAX_FILE_NAME);
    expect(() => encodeURIComponent(emoji)).not.toThrow();
  });
});

describe("contentDisposition", () => {
  it("adds an RFC 5987 name so non-ASCII names survive", () => {
    expect(contentDisposition("id.pdf")).toBe(`inline; filename="id.pdf"; filename*=UTF-8''id.pdf`);
    const header = contentDisposition('জাতীয় "ID" (scan).pdf');
    expect(header.startsWith("inline; filename=\"ID (scan).pdf\"; filename*=UTF-8''")).toBe(true);
    const encoded = header.split("filename*=UTF-8''")[1] ?? "";
    expect(encoded).not.toMatch(/[\s"'()]/);
    expect(decodeURIComponent(encoded)).toBe('জাতীয় "ID" (scan).pdf');
  });

  it("falls back to a plain name when nothing ASCII is left", () => {
    expect(contentDisposition("পরিচয়").startsWith('inline; filename="file";')).toBe(true);
  });
});
