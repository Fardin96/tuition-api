import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createApplication,
  createArea,
  createCategory,
  createFileAsset,
  createRequirement,
  createSession,
  createStudentProfile,
  createSubject,
  createTestApp,
  createTutorProfile,
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
      const category = await createCategory();
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
      const pkg = await prisma.tuitionPackage.create({
        data: {
          tutorId: tutor.id,
          categoryId: category.id,
          subjectId: subject.id,
          classLevel: 10,
          timeOfDay: new Date("2024-01-01T10:00:00Z"),
          daysPerWeek: 3,
          expectedSalary: 5000,
          availableFrom: new Date("2024-01-01"),
          status: "OPEN",
        },
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
  const payload = (sub: string, email: string) => ({ sub, email });

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
    const category = await createCategory();
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
      categoryId: category.id,
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

  it("requires authentication", async () => {
    const app = await createTestApp();
    const res = await app.inject({ method: "DELETE", url: "/api/v1/me/hard-delete" });
    expect(res.statusCode).toBe(401);
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
