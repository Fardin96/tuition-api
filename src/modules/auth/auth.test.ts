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

describe("auth service", () => {
  it("round-trips an access token", async () => {
    const token = await authService.signAccessToken({
      accountId: "acc-id",
      role: "STUDENT",
      email: "test@example.com",
    });
    const payload = await authService.verifyAccessToken(token);
    expect(payload.accountId).toBe("acc-id");
    expect(payload.role).toBe("STUDENT");
  });

  it("hashes tokens deterministically", () => {
    const hash1 = authService.hashToken("abc");
    const hash2 = authService.hashToken("abc");
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe("abc");
  });
});
