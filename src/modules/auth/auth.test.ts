import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { setStorageForTests } from "../../lib/storage.js";
import {
  createAccount,
  createAdmin,
  createApplication,
  createArea,
  createFakeStorage,
  createFileAsset,
  createLandingRow,
  createRequirement,
  createSession,
  createStoryRow,
  createStudentProfile,
  createSubject,
  createSuperAdmin,
  createTestApp,
  createTuitionPackage,
  createTutorProfile,
  fakeFileBytes,
  getAuthHeaders,
  setStudentLocation,
  setTutorLocation,
} from "../../tests/helpers.js";
import * as authService from "./auth.service.js";

describe("auth routes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("POST /api/v1/auth/google", () => {
    it("creates a new account and returns tokens", async () => {
      const app = await createTestApp();
      const payload = {
        sub: "google-123",
        email: "new@example.com",
        email_verified: true,
        name: "New User",
      };
      vi.spyOn(authService, "verifyGoogleIdToken").mockResolvedValue(payload);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/google",
        payload: { idToken: "fake-id-token", role: "STUDENT" },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.accessToken).toBeDefined();
      expect(body.refreshToken).toBeDefined();
      expect(body.account.email).toBe("new@example.com");
      expect(body.account.role).toBe("STUDENT");

      const account = await prisma.account.findUnique({ where: { email: "new@example.com" } });
      expect(account).not.toBeNull();
      expect(account?.googleSub).toBe("google-123");
    });

    it("returns tokens for an existing account", async () => {
      const app = await createTestApp();
      const existing = await createAccount({
        role: "TUTOR",
        email: "existing@example.com",
        googleSub: "google-456",
      });
      vi.spyOn(authService, "verifyGoogleIdToken").mockResolvedValue({
        sub: existing.googleSub,
        email: existing.email,
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/google",
        payload: { idToken: "fake-id-token", role: "TUTOR" },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.account.id).toBe(existing.id);
    });

    it("creates an admin user with PENDING status", async () => {
      const app = await createTestApp();
      vi.spyOn(authService, "verifyGoogleIdToken").mockResolvedValue({
        sub: "admin-1",
        email: "admin@example.com",
        name: "Admin User",
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/google",
        payload: { idToken: "fake-id-token", role: "ADMIN" },
      });

      expect(res.statusCode).toBe(200);
      const admin = await prisma.adminUser.findUnique({
        where: { accountId: JSON.parse(res.body).account.id },
      });
      expect(admin).not.toBeNull();
      expect(admin?.status).toBe("PENDING");
    });

    it("signs in an existing account without a role", async () => {
      const app = await createTestApp();
      const existing = await createAccount({ role: "TUTOR" });
      vi.spyOn(authService, "verifyGoogleIdToken").mockResolvedValue({
        sub: existing.googleSub,
        email: existing.email,
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/google",
        payload: { idToken: "fake-id-token" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).account.id).toBe(existing.id);
    });

    it("rejects sign-in for an unknown account and creates nothing", async () => {
      const app = await createTestApp();
      vi.spyOn(authService, "verifyGoogleIdToken").mockResolvedValue({
        sub: "google-unknown",
        email: "unknown@example.com",
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/google",
        payload: { idToken: "fake-id-token" },
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toMatch(/Sign up first/);
      const account = await prisma.account.findUnique({
        where: { email: "unknown@example.com" },
      });
      expect(account).toBeNull();
    });

    it("rejects missing idToken", async () => {
      const app = await createTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/google",
        payload: { role: "STUDENT" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /api/v1/auth/refresh", () => {
    it("rotates a refresh token", async () => {
      const app = await createTestApp();
      const account = await createAccount();
      const refreshToken = await createSession(account.id);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.accessToken).toBeDefined();
      expect(body.refreshToken).not.toBe(refreshToken);

      const oldSession = await prisma.session.findFirst({
        where: { refreshTokenHash: authService.hashToken(refreshToken) },
      });
      expect(oldSession?.revokedAt).not.toBeNull();
    });

    it("rejects an invalid refresh token", async () => {
      const app = await createTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken: "invalid" },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /api/v1/auth/logout", () => {
    it("revokes the current session", async () => {
      const app = await createTestApp();
      const account = await createAccount();
      const refreshToken = await createSession(account.id);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        payload: { refreshToken },
      });

      expect(res.statusCode).toBe(204);
      const session = await prisma.session.findFirst({
        where: { refreshTokenHash: authService.hashToken(refreshToken) },
      });
      expect(session?.revokedAt).not.toBeNull();
    });

    it("returns 204 without a token", async () => {
      const app = await createTestApp();
      const res = await app.inject({ method: "POST", url: "/api/v1/auth/logout" });
      expect(res.statusCode).toBe(204);
    });
  });

  describe("POST /api/v1/auth/logout-all", () => {
    it("revokes all sessions for the account", async () => {
      const app = await createTestApp();
      const account = await createAccount();
      await createSession(account.id);
      await createSession(account.id);
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout-all",
        headers,
      });

      expect(res.statusCode).toBe(204);
      const active = await prisma.session.count({
        where: { accountId: account.id, revokedAt: null },
      });
      expect(active).toBe(0);
    });

    it("requires authentication", async () => {
      const app = await createTestApp();
      const res = await app.inject({ method: "POST", url: "/api/v1/auth/logout-all" });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("GET /api/v1/auth/sessions", () => {
    it("lists active sessions", async () => {
      const app = await createTestApp();
      const account = await createAccount();
      await createSession(account.id);
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/sessions",
        headers,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.sessions).toHaveLength(1);
    });
  });

  describe("DELETE /api/v1/auth/sessions/:id", () => {
    it("revokes a specific session", async () => {
      const app = await createTestApp();
      const account = await createAccount();
      const token = await createSession(account.id);
      const session = await prisma.session.findFirstOrThrow({
        where: { refreshTokenHash: authService.hashToken(token) },
      });
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/auth/sessions/${session.id}`,
        headers,
      });

      expect(res.statusCode).toBe(204);
      const updated = await prisma.session.findUnique({ where: { id: session.id } });
      expect(updated?.revokedAt).not.toBeNull();
    });

    it("returns 404 for unknown session", async () => {
      const app = await createTestApp();
      const account = await createAccount();
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/auth/sessions/00000000-0000-0000-0000-000000000000",
        headers,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/v1/auth/consent", () => {
    it("records consent for a student", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/consent",
        headers,
        payload: { version: "v1" },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.consentVersion).toBe("v1");

      const updated = await prisma.account.findUnique({ where: { id: account.id } });
      expect(updated?.consentVersion).toBe("v1");
    });

    it("rejects admin consent", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "ADMIN" });
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/consent",
        headers,
        payload: { version: "v1" },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});

describe("me routes", () => {
  describe("GET /api/v1/me", () => {
    it("returns the current account", async () => {
      const app = await createTestApp();
      const account = await createAccount({ email: "me@example.com" });
      const headers = await getAuthHeaders(account);

      const res = await app.inject({ method: "GET", url: "/api/v1/me", headers });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.account.email).toBe("me@example.com");
    });

    it("requires authentication", async () => {
      const app = await createTestApp();
      const res = await app.inject({ method: "GET", url: "/api/v1/me" });
      expect(res.statusCode).toBe(401);
    });

    it("returns applyReadiness with the missing list for a tutor", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      await createTutorProfile(account.id);
      const headers = await getAuthHeaders(account);

      const res = await app.inject({ method: "GET", url: "/api/v1/me", headers });

      expect(res.statusCode).toBe(200);
      const { applyReadiness } = JSON.parse(res.body).account;
      expect(applyReadiness).toEqual({
        ready: false,
        missing: ["location_pin", "area", "default_requirement"],
        verificationRequired: false,
      });
    });

    it("omits applyReadiness for a student", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const headers = await getAuthHeaders(account);

      const res = await app.inject({ method: "GET", url: "/api/v1/me", headers });

      expect(JSON.parse(res.body).account.applyReadiness).toBeUndefined();
    });
  });

  describe("DELETE /api/v1/me", () => {
    it("soft-deletes the account and revokes sessions", async () => {
      const app = await createTestApp();
      const account = await createAccount();
      await createSession(account.id);
      const headers = await getAuthHeaders(account);

      const res = await app.inject({ method: "DELETE", url: "/api/v1/me", headers });

      expect(res.statusCode).toBe(204);
      const updated = await prisma.account.findUnique({ where: { id: account.id } });
      expect(updated?.deletedAt).not.toBeNull();
      expect(updated?.status).toBe("DELETED");
      const sessions = await prisma.session.count({
        where: { accountId: account.id, revokedAt: null },
      });
      expect(sessions).toBe(0);
    });

    it("tombstones numbers, closes listings and withdraws applications on both sides", async () => {
      const app = await createTestApp();
      const area = await createArea();
      const subject = await createSubject();

      const studentAccount = await createAccount({ role: "STUDENT" });
      const student = await createStudentProfile(studentAccount.id, area.id, {
        whatsappNumber: "+8801711111111",
        phoneNumber: "+8801722222222",
      });
      await createSession(studentAccount.id);
      const requirement = await createRequirement({ studentId: student.id });

      const tutorAccount = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(tutorAccount.id, {
        isListed: true,
        whatsappNumber: "+8801733333333",
        phoneNumber: "+8801744444444",
      });
      const pkg = await createTuitionPackage(tutor.id, {
        subjectIds: [subject.id],
        levelMin: 10,
        levelMax: 10,
        curricula: ["BANGLA_MEDIUM"],
        status: "OPEN",
      });

      const otherStudentAccount = await createAccount({ role: "STUDENT" });
      const otherStudent = await createStudentProfile(otherStudentAccount.id, area.id);
      const otherRequirement = await createRequirement({ studentId: otherStudent.id });
      const pendingToTutor = await createApplication({
        requirementId: otherRequirement.id,
        tutorId: tutor.id,
        studentId: otherStudent.id,
        initiatedBy: "STUDENT",
      });
      const pendingToStudent = await createApplication({
        requirementId: requirement.id,
        tutorId: tutor.id,
        studentId: student.id,
        initiatedBy: "TUTOR",
      });

      const studentRes = await app.inject({
        method: "DELETE",
        url: "/api/v1/me",
        headers: await getAuthHeaders(studentAccount),
      });
      const tutorRes = await app.inject({
        method: "DELETE",
        url: "/api/v1/me",
        headers: await getAuthHeaders(tutorAccount),
      });
      expect(studentRes.statusCode).toBe(204);
      expect(tutorRes.statusCode).toBe(204);

      const deletedStudent = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
      expect(deletedStudent.phoneNumber).toBe(`deleted:${studentAccount.id}:+8801722222222`);
      expect(deletedStudent.whatsappNumber).toBe(`deleted:${studentAccount.id}:+8801711111111`);
      expect(
        await prisma.session.count({ where: { accountId: studentAccount.id, revokedAt: null } }),
      ).toBe(0);
      expect(
        (await prisma.tuitionRequirement.findUniqueOrThrow({ where: { id: requirement.id } }))
          .status,
      ).toBe("CLOSED");
      expect(
        (await prisma.application.findUniqueOrThrow({ where: { id: pendingToTutor.id } })).status,
      ).toBe("WITHDRAWN");
      expect(
        (await prisma.application.findUniqueOrThrow({ where: { id: pendingToStudent.id } })).status,
      ).toBe("WITHDRAWN");

      const deletedTutor = await prisma.tutor.findUniqueOrThrow({ where: { id: tutor.id } });
      expect(deletedTutor.phoneNumber).toBe(`deleted:${tutorAccount.id}:+8801744444444`);
      expect(deletedTutor.isListed).toBe(false);
      expect(
        (await prisma.tuitionPackage.findUniqueOrThrow({ where: { id: pkg.id } })).status,
      ).toBe("CLOSED");

      const reused = await createAccount({ role: "STUDENT" });
      await expect(
        createStudentProfile(reused.id, area.id, {
          whatsappNumber: "+8801711111111",
          phoneNumber: "+8801722222222",
        }),
      ).resolves.toMatchObject({ whatsappNumber: "+8801711111111" });
    });
  });
});

async function superAdmin() {
  await prisma.superAdminEmail.create({ data: { slot: 1, email: "root@example.com" } });
  const account = await createAccount({ role: "ADMIN", email: "root@example.com" });
  await prisma.adminUser.create({
    data: { accountId: account.id, name: "Root", adminRole: "SUPER_ADMIN", status: "ACTIVE" },
  });
  return account;
}

describe("createOrUpdateAccount", () => {
  const payload = (sub: string, email: string) => ({ sub, email, email_verified: true });

  it("creates an ACTIVE super admin on first sign-in for an allowlisted email, with no sign-up", async () => {
    await prisma.superAdminEmail.create({ data: { slot: 1, email: "owner@example.com" } });

    const result = await authService.createOrUpdateAccount(
      payload("google-owner", "owner@example.com"),
      undefined,
    );

    expect(result.isNew).toBe(true);
    expect(result.account.role).toBe("ADMIN");
    const admin = await prisma.adminUser.findUniqueOrThrow({
      where: { accountId: result.account.id },
    });
    expect(admin).toMatchObject({ adminRole: "SUPER_ADMIN", status: "ACTIVE" });
  });

  it("still refuses sign-in without an account for an email that is not allowlisted", async () => {
    await expect(
      authService.createOrUpdateAccount(payload("google-nobody", "nobody@example.com"), undefined),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("an allowlisted email that Google has not verified is not a super admin", async () => {
    await prisma.superAdminEmail.create({ data: { slot: 1, email: "owner@example.com" } });

    await expect(
      authService.createOrUpdateAccount(
        { sub: "google-unverified-owner", email: "owner@example.com", email_verified: false },
        undefined,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(await prisma.account.findUnique({ where: { email: "owner@example.com" } })).toBeNull();
  });

  it("refuses sign-in for a self-deleted account; sign-up reactivates it and restores its numbers", async () => {
    const area = await createArea();
    const account = await createAccount({
      role: "STUDENT",
      email: "back@example.com",
      googleSub: "google-back",
    });
    const student = await createStudentProfile(account.id, area.id, {
      whatsappNumber: "+8801711111111",
      phoneNumber: "+8801722222222",
    });
    await authService.softDeleteAccount(account.id);

    await expect(
      authService.createOrUpdateAccount(payload("google-back", "back@example.com"), undefined),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "Account was deleted. Sign up to reactivate it.",
    });

    const result = await authService.createOrUpdateAccount(
      payload("google-back", "back@example.com"),
      "STUDENT",
    );

    expect(result.isNew).toBe(false);
    expect(result.account.status).toBe("ACTIVE");
    expect(result.account.deletedAt).toBeNull();
    const restored = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(restored.phoneNumber).toBe("+8801722222222");
    expect(restored.whatsappNumber).toBe("+8801711111111");
  });

  it("keeps a restored number tombstoned when another account has taken it", async () => {
    const area = await createArea();
    const account = await createAccount({ role: "STUDENT", googleSub: "google-taken" });
    const student = await createStudentProfile(account.id, area.id, {
      whatsappNumber: "+8801711111111",
      phoneNumber: "+8801722222222",
    });
    await authService.softDeleteAccount(account.id);
    const other = await createAccount({ role: "TUTOR" });
    await createTutorProfile(other.id, { phoneNumber: "+8801722222222" });

    await authService.createOrUpdateAccount(payload("google-taken", account.email), "STUDENT");

    const restored = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(restored.whatsappNumber).toBe("+8801711111111");
    expect(restored.phoneNumber).toBe(`deleted:${account.id}:+8801722222222`);
  });

  it("round-trips a profile without a WhatsApp number through soft delete and reactivation", async () => {
    const area = await createArea();
    const account = await createAccount({
      role: "STUDENT",
      email: "nowa@example.com",
      googleSub: "google-nowa",
    });
    const student = await createStudentProfile(account.id, area.id, {
      phoneNumber: "+8801722222222",
    });
    await authService.softDeleteAccount(account.id);

    const deleted = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(deleted.phoneNumber).toBe(`deleted:${account.id}:+8801722222222`);
    expect(deleted.whatsappNumber).toBeNull();

    await authService.createOrUpdateAccount(payload("google-nowa", "nowa@example.com"), "STUDENT");

    const restored = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(restored.phoneNumber).toBe("+8801722222222");
    expect(restored.whatsappNumber).toBeNull();
  });

  it("rejects a blocked, self-deleted account on sign-up too", async () => {
    const admin = await superAdmin();
    const account = await createAccount({
      role: "STUDENT",
      email: "blk@example.com",
      googleSub: "google-blk",
    });
    await authService.softDeleteAccount(account.id);
    await prisma.accountBlock.create({
      data: { accountId: account.id, blockedById: admin.id, reason: "spam" },
    });

    await expect(
      authService.createOrUpdateAccount(payload("google-blk", "blk@example.com"), "STUDENT"),
    ).rejects.toMatchObject({ statusCode: 403, message: "Account is blocked" });
  });

  it("rejects a blocked account, and unblocking restores it to ACTIVE", async () => {
    const admin = await superAdmin();
    const account = await createAccount({
      role: "STUDENT",
      email: "blocked@example.com",
      googleSub: "google-blocked",
    });
    const block = await prisma.accountBlock.create({
      data: { accountId: account.id, blockedById: admin.id, reason: "spam" },
    });

    await expect(
      authService.createOrUpdateAccount(
        payload("google-blocked", "blocked@example.com"),
        undefined,
      ),
    ).rejects.toThrow("Account is blocked");

    await prisma.accountBlock.update({
      where: { id: block.id },
      data: { unblockedAt: new Date(), unblockedById: admin.id },
    });
    const unblocked = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(unblocked.status).toBe("ACTIVE");
  });

  it("keeps a deleted account deleted when its block is lifted", async () => {
    const admin = await superAdmin();
    const account = await createAccount({
      role: "STUDENT",
      email: "gone@example.com",
      googleSub: "google-gone",
    });
    await authService.softDeleteAccount(account.id);
    const block = await prisma.accountBlock.create({
      data: { accountId: account.id, blockedById: admin.id, reason: "spam" },
    });

    await expect(
      authService.createOrUpdateAccount(payload("google-gone", "gone@example.com"), undefined),
    ).rejects.toThrow("Account is blocked");

    await prisma.accountBlock.update({
      where: { id: block.id },
      data: { unblockedAt: new Date(), unblockedById: admin.id },
    });
    const stillDeleted = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(stillDeleted.status).toBe("DELETED");
  });
});

describe("DELETE /api/v1/me/hard-delete", () => {
  it("permanently deletes the account and all related data, then allows Google re-sign-up", async () => {
    const app = await createTestApp();

    const area = await createArea();
    const subject = await createSubject();

    const studentAccount = await createAccount({
      role: "STUDENT",
      email: "hard-delete-student@example.com",
      googleSub: "google-hard-delete-student",
    });
    const studentProfile = await createStudentProfile(studentAccount.id, area.id);
    await setStudentLocation(studentProfile.id);

    const verificationFile = await createFileAsset(studentAccount.id, "STUDENT_ID");
    await prisma.student.update({
      where: { id: studentProfile.id },
      data: { verificationFileId: verificationFile.id, verificationStatus: "PENDING" },
    });

    await createSession(studentAccount.id);

    await prisma.notificationLog.create({
      data: {
        eventType: "APPLICATION_RECEIVED",
        channel: "WHATSAPP",
        recipientId: studentAccount.id,
        dedupeKey: `test-${studentAccount.id}`,
        templateName: "application_received",
        payload: {},
      },
    });

    const tutorAccount = await createAccount({
      role: "TUTOR",
      email: "hard-delete-tutor@example.com",
      googleSub: "google-hard-delete-tutor",
    });
    const tutorProfile = await createTutorProfile(tutorAccount.id);
    await setTutorLocation(tutorProfile.id);

    const requirement = await createRequirement({
      studentId: studentProfile.id,
      areaId: area.id,
      subjectId: subject.id,
    });

    const application = await createApplication({
      requirementId: requirement.id,
      tutorId: tutorProfile.id,
      studentId: studentProfile.id,
      initiatedBy: "TUTOR",
      status: "COMPLETED",
    });

    await prisma.review.create({
      data: {
        tutorId: tutorProfile.id,
        studentId: studentProfile.id,
        direction: "STUDENT_TO_TUTOR",
        rating: 5,
        comment: "Great tutor",
      },
    });

    await prisma.report.create({
      data: {
        reporterId: studentAccount.id,
        targetAccountId: tutorAccount.id,
        applicationId: application.id,
        category: "SPAM",
        details: "Spam",
      },
    });

    const headers = await getAuthHeaders(studentAccount);
    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/me/hard-delete",
      headers,
    });

    expect(res.statusCode).toBe(204);

    expect(await prisma.account.findUnique({ where: { id: studentAccount.id } })).toBeNull();
    expect(await prisma.student.findUnique({ where: { accountId: studentAccount.id } })).toBeNull();
    expect(await prisma.studentLocation.count({ where: { studentId: studentProfile.id } })).toBe(0);
    expect(await prisma.tuitionRequirement.count({ where: { studentId: studentProfile.id } })).toBe(
      0,
    );
    expect(
      await prisma.application.count({
        where: { OR: [{ studentId: studentProfile.id }, { tutorId: tutorProfile.id }] },
      }),
    ).toBe(0);
    expect(
      await prisma.review.count({
        where: { OR: [{ studentId: studentProfile.id }, { tutorId: tutorProfile.id }] },
      }),
    ).toBe(0);
    expect(await prisma.report.count({ where: { reporterId: studentAccount.id } })).toBe(0);
    expect(await prisma.session.count({ where: { accountId: studentAccount.id } })).toBe(0);
    expect(await prisma.notificationLog.count({ where: { recipientId: studentAccount.id } })).toBe(
      0,
    );
    expect(await prisma.fileAsset.count({ where: { ownerAccountId: studentAccount.id } })).toBe(0);

    // Tutor account and profile are untouched.
    expect(await prisma.account.findUnique({ where: { id: tutorAccount.id } })).not.toBeNull();
    expect(await prisma.tutor.findUnique({ where: { accountId: tutorAccount.id } })).not.toBeNull();

    // The same Google account can sign up again.
    vi.spyOn(authService, "verifyGoogleIdToken").mockResolvedValue({
      sub: studentAccount.googleSub,
      email: studentAccount.email,
      email_verified: true,
      name: "Recreated Student",
    });

    const signupRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/google",
      payload: { idToken: "fake-token", role: "STUDENT" },
    });

    expect(signupRes.statusCode).toBe(200);
    const body = JSON.parse(signupRes.body);
    expect(body.account.id).not.toBe(studentAccount.id);
    expect(body.account.email).toBe(studentAccount.email);
  });

  it("removes the account's stored objects from storage", async () => {
    const app = await createTestApp();
    const fake = createFakeStorage();
    setStorageForTests(fake.storage);

    const area = await createArea();
    const studentAccount = await createAccount({ role: "STUDENT" });
    const studentProfile = await createStudentProfile(studentAccount.id, area.id);
    const file = await createFileAsset(studentAccount.id, "STUDENT_ID", {
      storageKey: `student_id/${studentAccount.id}/id.pdf`,
    });
    fake.put(file.storageKey, fakeFileBytes("application/pdf", 64), "application/pdf");
    await prisma.student.update({
      where: { id: studentProfile.id },
      data: { verificationFileId: file.id, verificationStatus: "PENDING" },
    });

    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/me/hard-delete",
      headers: await getAuthHeaders(studentAccount),
    });

    expect(res.statusCode).toBe(204);
    expect(fake.objects.has(file.storageKey)).toBe(false);
    expect(await prisma.fileAsset.count({ where: { id: file.id } })).toBe(0);
  });

  it("clears an admin's review on student ID checks so the admin can be deleted", async () => {
    const app = await createTestApp();
    const area = await createArea();
    const studentAccount = await createAccount({ role: "STUDENT" });
    const studentProfile = await createStudentProfile(studentAccount.id, area.id);
    const admin = await createAdmin();
    const file = await createFileAsset(studentAccount.id, "STUDENT_ID");
    await prisma.student.update({
      where: { id: studentProfile.id },
      data: {
        verificationFileId: file.id,
        verificationStatus: "APPROVED",
        verificationReviewedById: admin.id,
        verificationDecidedAt: new Date(),
      },
    });

    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/me/hard-delete",
      headers: await getAuthHeaders(admin),
    });

    expect(res.statusCode).toBe(204);
    expect(await prisma.account.findUnique({ where: { id: admin.id } })).toBeNull();
    const student = await prisma.student.findUniqueOrThrow({ where: { id: studentProfile.id } });
    expect(student.verificationReviewedById).toBeNull();
  });

  it("requires authentication", async () => {
    const app = await createTestApp();
    const res = await app.inject({ method: "DELETE", url: "/api/v1/me/hard-delete" });
    expect(res.statusCode).toBe(401);
  });
});

describe("hard delete and upload moderation rows", () => {
  it("removes the upload history and blocks addressed to the deleted user and keeps everyone else's", async () => {
    const app = await createTestApp();
    const area = await createArea();
    const student = await createAccount({ role: "STUDENT" });
    await createStudentProfile(student.id, area.id);
    const otherStudent = await createAccount({ role: "STUDENT" });
    await createStudentProfile(otherStudent.id, area.id);
    const admin = await createAdmin();
    const file = await createFileAsset(student.id, "STUDENT_ID");

    await prisma.uploadReview.create({
      data: {
        accountId: student.id,
        fileId: file.id,
        purpose: "STUDENT_ID",
        fileName: "id.pdf",
        action: "REMOVED",
        note: "Remove this file.",
        noteVisible: true,
        actorAccountId: admin.id,
      },
    });
    await prisma.uploadBlock.create({
      data: {
        accountId: student.id,
        blocksVideos: true,
        blocksDocuments: false,
        note: "Paused for review.",
        noteVisible: true,
        blockedById: admin.id,
      },
    });
    const keptReview = await prisma.uploadReview.create({
      data: {
        accountId: otherStudent.id,
        purpose: null,
        action: "BLOCKED",
        note: "Paused.",
        noteVisible: true,
        actorAccountId: admin.id,
      },
    });
    const keptBlock = await prisma.uploadBlock.create({
      data: {
        accountId: otherStudent.id,
        blocksVideos: false,
        blocksDocuments: true,
        note: "Paused.",
        noteVisible: true,
        blockedById: admin.id,
      },
    });

    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/me/hard-delete",
      headers: await getAuthHeaders(student),
    });

    expect(res.statusCode).toBe(204);
    expect(await prisma.uploadReview.count({ where: { accountId: student.id } })).toBe(0);
    expect(await prisma.uploadBlock.count({ where: { accountId: student.id } })).toBe(0);
    expect(await prisma.uploadReview.findUnique({ where: { id: keptReview.id } })).not.toBeNull();
    expect(await prisma.uploadBlock.findUnique({ where: { id: keptBlock.id } })).not.toBeNull();
  });

  it("keeps the upload history a deleted admin wrote, with the actor cleared", async () => {
    const app = await createTestApp();
    const area = await createArea();
    const student = await createAccount({ role: "STUDENT" });
    await createStudentProfile(student.id, area.id);
    const admin = await createAdmin();

    const review = await prisma.uploadReview.create({
      data: {
        accountId: student.id,
        purpose: null,
        action: "UNBLOCKED",
        note: null,
        noteVisible: true,
        actorAccountId: admin.id,
      },
    });
    const block = await prisma.uploadBlock.create({
      data: {
        accountId: student.id,
        blocksVideos: true,
        blocksDocuments: true,
        note: "Paused.",
        noteVisible: true,
        blockedById: admin.id,
        unblockedById: admin.id,
        unblockedAt: new Date(),
      },
    });

    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/me/hard-delete",
      headers: await getAuthHeaders(admin),
    });

    expect(res.statusCode).toBe(204);
    expect(await prisma.account.findUnique({ where: { id: admin.id } })).toBeNull();
    const keptReview = await prisma.uploadReview.findUniqueOrThrow({ where: { id: review.id } });
    expect(keptReview).toMatchObject({
      action: "UNBLOCKED",
      accountId: student.id,
      actorAccountId: null,
    });
    const keptBlock = await prisma.uploadBlock.findUniqueOrThrow({ where: { id: block.id } });
    expect(keptBlock).toMatchObject({ blockedById: null, unblockedById: null });
  });
});

describe("blocked and deleted accounts lose access", () => {
  it("rejects a self-deleted account's token on a protected route", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const headers = await getAuthHeaders(account);
    await authService.softDeleteAccount(account.id);

    const res = await app.inject({ method: "GET", url: "/api/v1/me", headers });

    expect(res.statusCode).toBe(401);
  });

  it("rejects a blocked account's token on a protected route", async () => {
    const app = await createTestApp();
    const admin = await superAdmin();
    const account = await createAccount({ role: "STUDENT" });
    const headers = await getAuthHeaders(account);
    await prisma.accountBlock.create({
      data: { accountId: account.id, blockedById: admin.id, reason: "spam" },
    });

    const res = await app.inject({ method: "GET", url: "/api/v1/me", headers });

    expect(res.statusCode).toBe(401);
  });

  it("refuses to soft-delete a blocked account", async () => {
    const admin = await superAdmin();
    const account = await createAccount({ role: "STUDENT" });
    await prisma.accountBlock.create({
      data: { accountId: account.id, blockedById: admin.id, reason: "spam" },
    });

    await expect(authService.softDeleteAccount(account.id)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

describe("auth service", () => {
  it("round-trips an access token", async () => {
    const account = await createAccount({ role: "STUDENT" });
    const token = await authService.signAccessToken({
      accountId: account.id,
      role: "STUDENT",
      email: account.email,
    });
    const payload = await authService.verifyAccessToken(token);
    expect(payload.accountId).toBe(account.id);
    expect(payload.role).toBe("STUDENT");
  });

  it("hashes tokens deterministically", () => {
    const hash1 = authService.hashToken("abc");
    const hash2 = authService.hashToken("abc");
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe("abc");
  });
});

describe("account deletion takes landing cards off", () => {
  async function studentWithLandingStory() {
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    await createStudentProfile(account.id, area.id);
    const photo = await createFileAsset(account.id, "STORY_IMAGE", { contentType: "image/png" });
    const story = await createStoryRow(account.id, { status: "APPROVED", imageFileId: photo.id });
    await createLandingRow("testimonials", [
      {
        name: "Ana",
        role: "Student",
        photo: `file:${photo.id}`,
        quote: "Great help",
        comment: "Clear lessons every week",
        source: { kind: "story", id: story.id },
      },
    ]);
    await prisma.siteContentFile.create({ data: { key: "testimonials", fileId: photo.id } });
    return { account, photo, story };
  }

  it("soft delete removes the story card from the landing page", async () => {
    const app = await createTestApp();
    const { account } = await studentWithLandingStory();

    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/me",
      headers: await getAuthHeaders(account),
    });

    expect(res.statusCode).toBe(204);
    expect(await prisma.siteContent.count({ where: { key: "testimonials" } })).toBe(0);
  });

  it("hard delete succeeds with a story on the landing page and removes its files", async () => {
    const app = await createTestApp();
    const { account, photo } = await studentWithLandingStory();

    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/me/hard-delete",
      headers: await getAuthHeaders(account),
    });

    expect(res.statusCode).toBe(204);
    expect(await prisma.account.count({ where: { id: account.id } })).toBe(0);
    expect(await prisma.fileAsset.count({ where: { id: photo.id } })).toBe(0);
    expect(await prisma.siteContent.count({ where: { key: "testimonials" } })).toBe(0);
  });
});

describe("admin invites at sign-in", () => {
  const inDays = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  it("an open invite and no role make the Google account an ACTIVE admin", async () => {
    const app = await createTestApp();
    const inviter = await createSuperAdmin();
    await prisma.adminInvite.create({
      data: { email: "invited@example.com", invitedById: inviter.id, expiresAt: inDays(14) },
    });
    vi.spyOn(authService, "verifyGoogleIdToken").mockResolvedValue({
      sub: "google-invited",
      email: "invited@example.com",
      email_verified: true,
      name: "Invited Person",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/google",
      payload: { idToken: "fake-id-token" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.account.role).toBe("ADMIN");
    const admin = await prisma.adminUser.findUniqueOrThrow({
      where: { accountId: body.account.id },
    });
    expect(admin).toMatchObject({
      name: "Invited Person",
      adminRole: "ADMIN",
      status: "ACTIVE",
      approvedById: inviter.id,
    });
    expect(admin.approvedAt).toBeInstanceOf(Date);
    expect(
      await prisma.adminInvite.findUnique({ where: { email: "invited@example.com" } }),
    ).toBeNull();
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "admin.invite_accept", entityId: body.account.id },
    });
    expect(audit.actorAccountId).toBe(body.account.id);
    expect(audit.entityType).toBe("admin_user");
    expect(audit.after).toEqual({ status: "ACTIVE", invitedBy: inviter.id });
    expect(audit.ip).toBe("127.0.0.1");
  });

  it("an expired invite is ignored: sign-in without a role still gets 404", async () => {
    const app = await createTestApp();
    const inviter = await createSuperAdmin();
    await prisma.adminInvite.create({
      data: { email: "late@example.com", invitedById: inviter.id, expiresAt: inDays(-1) },
    });
    vi.spyOn(authService, "verifyGoogleIdToken").mockResolvedValue({
      sub: "google-late",
      email: "late@example.com",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/google",
      payload: { idToken: "fake-id-token" },
    });

    expect(res.statusCode).toBe(404);
    expect(await prisma.account.findUnique({ where: { email: "late@example.com" } })).toBeNull();
    expect(await prisma.adminInvite.count({ where: { email: "late@example.com" } })).toBe(1);
  });

  it("an invite whose inviter is no longer a super admin gives 403 and is kept", async () => {
    const app = await createTestApp();
    const removed = await createAdmin({ status: "REMOVED" });
    await prisma.adminInvite.create({
      data: { email: "orphan@example.com", invitedById: removed.id, expiresAt: inDays(14) },
    });
    vi.spyOn(authService, "verifyGoogleIdToken").mockResolvedValue({
      sub: "google-orphan",
      email: "orphan@example.com",
      email_verified: true,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/google",
      payload: { idToken: "fake-id-token" },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).message).toMatch(/no longer valid/);
    expect(await prisma.account.findUnique({ where: { email: "orphan@example.com" } })).toBeNull();
    expect(await prisma.adminInvite.count({ where: { email: "orphan@example.com" } })).toBe(1);
  });

  it("a student sign-up gets the STUDENT account and drops the stale invite", async () => {
    const app = await createTestApp();
    const inviter = await createSuperAdmin();
    const invite = await prisma.adminInvite.create({
      data: { email: "student@example.com", invitedById: inviter.id, expiresAt: inDays(14) },
    });
    vi.spyOn(authService, "verifyGoogleIdToken").mockResolvedValue({
      sub: "google-student-invite",
      email: "student@example.com",
      email_verified: true,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/google",
      payload: { idToken: "fake-id-token", role: "STUDENT" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).account.role).toBe("STUDENT");
    expect(
      await prisma.adminUser.findFirst({ where: { account: { email: "student@example.com" } } }),
    ).toBeNull();
    // The email now has an account, so the invite can never be accepted.
    expect(await prisma.adminInvite.count({ where: { email: "student@example.com" } })).toBe(0);
    const revoke = await prisma.auditLog.findFirstOrThrow({
      where: { action: "admin.invite_revoke", entityId: invite.id },
    });
    expect(revoke.actorAccountId).toBe(JSON.parse(res.body).account.id);
    expect(revoke.before).toEqual({ email: "student@example.com", reason: "account_created" });
  });

  it("role ADMIN with an unverified email becomes a PENDING admin, and the open invite is dropped with an audit row", async () => {
    const app = await createTestApp();
    const inviter = await createSuperAdmin();
    const invite = await prisma.adminInvite.create({
      data: { email: "pending-admin@example.com", invitedById: inviter.id, expiresAt: inDays(14) },
    });
    vi.spyOn(authService, "verifyGoogleIdToken").mockResolvedValue({
      sub: "google-pending-admin",
      email: "pending-admin@example.com",
      email_verified: false,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/google",
      payload: { idToken: "fake-id-token", role: "ADMIN" },
    });

    expect(res.statusCode).toBe(200);
    const accountId = JSON.parse(res.body).account.id;
    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { accountId } });
    expect(admin).toMatchObject({ adminRole: "ADMIN", status: "PENDING" });
    expect(await prisma.adminInvite.findUnique({ where: { id: invite.id } })).toBeNull();
    const revoke = await prisma.auditLog.findFirstOrThrow({
      where: { action: "admin.invite_revoke", entityId: invite.id },
    });
    expect(revoke.actorAccountId).toBe(accountId);
    expect(revoke.before).toEqual({
      email: "pending-admin@example.com",
      reason: "account_created",
    });
  });

  it("an unverified Google email gets 404 and the invite stays", async () => {
    const app = await createTestApp();
    const inviter = await createSuperAdmin();
    await prisma.adminInvite.create({
      data: { email: "unverified@example.com", invitedById: inviter.id, expiresAt: inDays(14) },
    });
    vi.spyOn(authService, "verifyGoogleIdToken").mockResolvedValue({
      sub: "google-unverified",
      email: "unverified@example.com",
      email_verified: false,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/google",
      payload: { idToken: "fake-id-token" },
    });

    expect(res.statusCode).toBe(404);
    expect(
      await prisma.account.findUnique({ where: { email: "unverified@example.com" } }),
    ).toBeNull();
    expect(await prisma.adminInvite.count({ where: { email: "unverified@example.com" } })).toBe(1);
  });

  it("role ADMIN with an open invite becomes an ACTIVE admin, not PENDING", async () => {
    const app = await createTestApp();
    const inviter = await createSuperAdmin();
    await prisma.adminInvite.create({
      data: { email: "role-admin@example.com", invitedById: inviter.id, expiresAt: inDays(14) },
    });
    vi.spyOn(authService, "verifyGoogleIdToken").mockResolvedValue({
      sub: "google-role-admin",
      email: "role-admin@example.com",
      email_verified: true,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/google",
      payload: { idToken: "fake-id-token", role: "ADMIN" },
    });

    expect(res.statusCode).toBe(200);
    const admin = await prisma.adminUser.findUniqueOrThrow({
      where: { accountId: JSON.parse(res.body).account.id },
    });
    expect(admin).toMatchObject({ adminRole: "ADMIN", status: "ACTIVE", approvedById: inviter.id });
  });

  it("an inviter who is a plain ACTIVE admin gives 403 and the invite stays", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    await prisma.adminInvite.create({
      data: { email: "plain@example.com", invitedById: admin.id, expiresAt: inDays(14) },
    });
    vi.spyOn(authService, "verifyGoogleIdToken").mockResolvedValue({
      sub: "google-plain",
      email: "plain@example.com",
      email_verified: true,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/google",
      payload: { idToken: "fake-id-token" },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).message).toMatch(/no longer valid/);
    expect(await prisma.account.findUnique({ where: { email: "plain@example.com" } })).toBeNull();
    expect(await prisma.adminInvite.count({ where: { email: "plain@example.com" } })).toBe(1);
  });

  it("an inviter who is a super admin with a BLOCKED account gives 403 and the invite stays", async () => {
    const app = await createTestApp();
    const inviter = await createAccount({
      role: "ADMIN",
      email: "blocked-inviter@example.com",
      status: "BLOCKED",
    });
    await prisma.superAdminEmail.create({
      data: { slot: 1, email: "blocked-inviter@example.com" },
    });
    await prisma.adminUser.create({
      data: {
        accountId: inviter.id,
        name: "Blocked Super Admin",
        adminRole: "SUPER_ADMIN",
        status: "ACTIVE",
      },
    });
    await prisma.adminInvite.create({
      data: { email: "blocked-case@example.com", invitedById: inviter.id, expiresAt: inDays(14) },
    });
    vi.spyOn(authService, "verifyGoogleIdToken").mockResolvedValue({
      sub: "google-blocked-case",
      email: "blocked-case@example.com",
      email_verified: true,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/google",
      payload: { idToken: "fake-id-token" },
    });

    expect(res.statusCode).toBe(403);
    expect(
      await prisma.account.findUnique({ where: { email: "blocked-case@example.com" } }),
    ).toBeNull();
    expect(await prisma.adminInvite.count({ where: { email: "blocked-case@example.com" } })).toBe(
      1,
    );
  });

  it("an email on the super admin allowlist and invited signs in as super admin, and the stale invite is dropped with an audit row", async () => {
    const app = await createTestApp();
    const inviter = await createSuperAdmin();
    await prisma.superAdminEmail.create({ data: { slot: 2, email: "both@example.com" } });
    const invite = await prisma.adminInvite.create({
      data: { email: "both@example.com", invitedById: inviter.id, expiresAt: inDays(14) },
    });
    vi.spyOn(authService, "verifyGoogleIdToken").mockResolvedValue({
      sub: "google-both",
      email: "both@example.com",
      email_verified: true,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/google",
      payload: { idToken: "fake-id-token" },
    });

    expect(res.statusCode).toBe(200);
    const admin = await prisma.adminUser.findUniqueOrThrow({
      where: { accountId: JSON.parse(res.body).account.id },
    });
    expect(admin).toMatchObject({ adminRole: "SUPER_ADMIN", status: "ACTIVE" });
    expect(admin.approvedById).toBeNull();
    expect(await prisma.adminInvite.count({ where: { email: "both@example.com" } })).toBe(0);
    const revoke = await prisma.auditLog.findFirstOrThrow({
      where: { action: "admin.invite_revoke", entityId: invite.id },
    });
    expect(revoke.before).toEqual({ email: "both@example.com", reason: "account_created" });
  });

  it("an invite used or revoked after the lookup gives 409 INVALID_ADMIN_STATE", async () => {
    const app = await createTestApp();
    const inviter = await createSuperAdmin();
    const invite = await prisma.adminInvite.create({
      data: { email: "race@example.com", invitedById: inviter.id, expiresAt: inDays(14) },
    });
    await prisma.adminInvite.delete({ where: { id: invite.id } });
    // The lookup still returns the row, as it would when a revoke lands right after it.
    vi.spyOn(prisma.adminInvite, "findFirst").mockResolvedValueOnce(invite);
    vi.spyOn(authService, "verifyGoogleIdToken").mockResolvedValue({
      sub: "google-race",
      email: "race@example.com",
      email_verified: true,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/google",
      payload: { idToken: "fake-id-token" },
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("INVALID_ADMIN_STATE");
    expect(await prisma.account.findUnique({ where: { email: "race@example.com" } })).toBeNull();
    vi.restoreAllMocks();
  });
});
