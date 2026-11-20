import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createAdmin,
  createApplication,
  createArea,
  createRequirement,
  createSession,
  createStudentProfile,
  createSuperAdmin,
  createTestApp,
  createTuitionPackage,
  createTutorProfile,
  getAuthHeaders,
} from "../../tests/helpers.js";

const LIST_URL = "/api/v1/admin/accounts";

async function setCreatedAt(accountId: string, createdAt: string) {
  await prisma.account.update({
    where: { id: accountId },
    data: { createdAt: new Date(createdAt) },
  });
}

function ids(body: string): string[] {
  return JSON.parse(body).accounts.map((a: { id: string }) => a.id);
}

describe("admin accounts", () => {
  describe("GET /api/v1/admin/accounts", () => {
    it("no token gets 401", async () => {
      const app = await createTestApp();

      const res = await app.inject({ method: "GET", url: LIST_URL });

      expect(res.statusCode).toBe(401);
      expect(res.headers["cache-control"]).toBe("private, no-store");
    });

    it("STUDENT gets 403", async () => {
      const app = await createTestApp();
      const student = await createAccount({ role: "STUDENT" });

      const res = await app.inject({
        method: "GET",
        url: LIST_URL,
        headers: await getAuthHeaders(student),
      });

      expect(res.statusCode).toBe(403);
    });

    it("PENDING admin gets 403", async () => {
      const app = await createTestApp();
      const pending = await createAdmin({ status: "PENDING" });

      const res = await app.inject({
        method: "GET",
        url: LIST_URL,
        headers: await getAuthHeaders(pending),
      });

      expect(res.statusCode).toBe(403);
    });

    it("returns newest first and filters by role", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const oldest = await createAccount({ role: "STUDENT" });
      await setCreatedAt(oldest.id, "2026-03-01T00:00:00Z");
      const newest = await createAccount({ role: "STUDENT" });
      await setCreatedAt(newest.id, "2026-03-03T00:00:00Z");
      const middle = await createAccount({ role: "STUDENT" });
      await setCreatedAt(middle.id, "2026-03-02T00:00:00Z");
      await createAccount({ role: "TUTOR" });

      const res = await app.inject({
        method: "GET",
        url: `${LIST_URL}?role=STUDENT`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(ids(res.body)).toEqual([newest.id, middle.id, oldest.id]);
      expect(body.nextCursor).toBeNull();
      expect(body.accounts[0]).toMatchObject({ role: "STUDENT", status: "ACTIVE", name: null });
    });

    it("filters by status", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const blocked = await createAccount({ role: "STUDENT" });
      await prisma.accountBlock.create({
        data: { accountId: blocked.id, blockedById: superAdmin.id, reason: "Spam listings" },
      });
      const deleted = await createAccount({ role: "STUDENT" });
      await prisma.account.update({
        where: { id: deleted.id },
        data: { status: "DELETED", deletedAt: new Date() },
      });

      const blockedRes = await app.inject({
        method: "GET",
        url: `${LIST_URL}?status=BLOCKED`,
        headers: await getAuthHeaders(superAdmin),
      });
      expect(ids(blockedRes.body)).toEqual([blocked.id]);

      const deletedRes = await app.inject({
        method: "GET",
        url: `${LIST_URL}?status=DELETED`,
        headers: await getAuthHeaders(superAdmin),
      });
      expect(ids(deletedRes.body)).toEqual([deleted.id]);
    });

    it("searches by email, case-insensitively", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const match = await createAccount({ role: "STUDENT", email: "Nusrat.Test@Example.com" });
      await createAccount({ role: "STUDENT", email: "someone.else@example.com" });

      const res = await app.inject({
        method: "GET",
        url: `${LIST_URL}?q=NUSRAT.test&role=STUDENT`,
        headers: await getAuthHeaders(admin),
      });

      expect(ids(res.body)).toEqual([match.id]);
    });

    it("searches by student name, tutor phone (exact) and admin name", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const area = await createArea();
      const studentAccount = await createAccount({ role: "STUDENT" });
      await createStudentProfile(studentAccount.id, area.id, { name: "Nusrat Jahan" });
      const tutorAccount = await createAccount({ role: "TUTOR" });
      await createTutorProfile(tutorAccount.id, { phoneNumber: "+8801911222333" });
      const headers = await getAuthHeaders(admin);

      const byName = await app.inject({
        method: "GET",
        url: `${LIST_URL}?q=nusrat%20jah`,
        headers,
      });
      expect(ids(byName.body)).toEqual([studentAccount.id]);
      expect(JSON.parse(byName.body).accounts[0].name).toBe("Nusrat Jahan");

      const byPhone = await app.inject({
        method: "GET",
        url: `${LIST_URL}?q=${encodeURIComponent("+8801911222333")}`,
        headers,
      });
      expect(ids(byPhone.body)).toEqual([tutorAccount.id]);

      const byPartialPhone = await app.inject({
        method: "GET",
        url: `${LIST_URL}?q=01911222`,
        headers,
      });
      expect(ids(byPartialPhone.body)).toEqual([]);

      const byAdminName = await app.inject({
        method: "GET",
        url: `${LIST_URL}?q=test%20admin&role=ADMIN`,
        headers,
      });
      expect(ids(byAdminName.body)).toContain(admin.id);
    });

    it("rejects an empty search term with 400", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: `${LIST_URL}?q=%20%20%20`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
    });

    it("paginates with limit and nextCursor", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const first = await createAccount({ role: "STUDENT" });
      await setCreatedAt(first.id, "2026-04-03T00:00:00Z");
      const second = await createAccount({ role: "STUDENT" });
      await setCreatedAt(second.id, "2026-04-02T00:00:00Z");
      const third = await createAccount({ role: "STUDENT" });
      await setCreatedAt(third.id, "2026-04-01T00:00:00Z");
      const headers = await getAuthHeaders(admin);

      const page1 = await app.inject({
        method: "GET",
        url: `${LIST_URL}?role=STUDENT&limit=2`,
        headers,
      });
      expect(page1.statusCode).toBe(200);
      const body1 = JSON.parse(page1.body);
      expect(ids(page1.body)).toEqual([first.id, second.id]);
      expect(body1.nextCursor).toEqual(expect.any(String));

      const page2 = await app.inject({
        method: "GET",
        url: `${LIST_URL}?role=STUDENT&limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
        headers,
      });
      expect(page2.statusCode).toBe(200);
      expect(ids(page2.body)).toEqual([third.id]);
      expect(JSON.parse(page2.body).nextCursor).toBeNull();
    });

    it("rejects an invalid cursor with 400", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: `${LIST_URL}?cursor=not-a-cursor`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
    });
  });

  describe("GET /api/v1/admin/accounts/:id", () => {
    it("returns a student with counts and no block", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const area = await createArea();
      const account = await createAccount({ role: "STUDENT" });
      const student = await createStudentProfile(account.id, area.id, {
        name: "Rahim Uddin",
        whatsappNumber: "+8801722000111",
      });
      const tutorAccount = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(tutorAccount.id);
      const requirement = await createRequirement({ studentId: student.id, areaId: area.id });
      await createApplication({
        requirementId: requirement.id,
        tutorId: tutor.id,
        studentId: student.id,
        initiatedBy: "TUTOR",
      });

      const res = await app.inject({
        method: "GET",
        url: `${LIST_URL}/${account.id}`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        id: account.id,
        role: "STUDENT",
        status: "ACTIVE",
        name: "Rahim Uddin",
        phoneNumber: student.phoneNumber,
        whatsappNumber: "+8801722000111",
        studentId: student.id,
        tutorId: null,
        verificationStatus: "NOT_SUBMITTED",
        isListed: null,
        instituteName: null,
        adminRole: null,
        adminStatus: null,
        activeBlock: null,
        blocks: [],
        counts: { applications: 1, openRequirements: 1, openPackages: 0 },
      });
      expect(body.consentVersion).toBe("v1");
      expect(body.consentAcceptedAt).toEqual(expect.any(String));
    });

    it("returns a tutor with listing, institute and open packages", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id, {
        instituteName: "BUET",
        isListed: true,
      });
      await createTuitionPackage(tutor.id);
      await createTuitionPackage(tutor.id, { status: "CLOSED" });

      const res = await app.inject({
        method: "GET",
        url: `${LIST_URL}/${account.id}`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        role: "TUTOR",
        tutorId: tutor.id,
        studentId: null,
        isListed: true,
        instituteName: "BUET",
        verificationStatus: "APPROVED",
        counts: { applications: 0, openRequirements: 0, openPackages: 1 },
      });
    });

    it("shows an admin's role and status", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: `${LIST_URL}/${admin.id}`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        role: "ADMIN",
        name: "Test Admin",
        adminRole: "ADMIN",
        adminStatus: "ACTIVE",
      });
    });

    it("shows when a verified phone was verified and null for an unverified one", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const area = await createArea();
      const verifiedAccount = await createAccount({ role: "STUDENT" });
      const verifiedAt = new Date("2026-11-10T08:30:00Z");
      const student = await createStudentProfile(verifiedAccount.id, area.id);
      await prisma.student.update({
        where: { id: student.id },
        data: { phoneVerifiedAt: verifiedAt },
      });
      const unverifiedAccount = await createAccount({ role: "TUTOR" });
      await createTutorProfile(unverifiedAccount.id);
      const headers = await getAuthHeaders(admin);

      const verifiedRes = await app.inject({
        method: "GET",
        url: `${LIST_URL}/${verifiedAccount.id}`,
        headers,
      });
      const unverifiedRes = await app.inject({
        method: "GET",
        url: `${LIST_URL}/${unverifiedAccount.id}`,
        headers,
      });

      expect(JSON.parse(verifiedRes.body).phoneVerifiedAt).toBe(verifiedAt.toISOString());
      expect(JSON.parse(unverifiedRes.body).phoneVerifiedAt).toBeNull();
    });

    it("shows null instead of a deleted account's phone tombstone", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const area = await createArea();
      const account = await createAccount({ role: "STUDENT" });
      await createStudentProfile(account.id, area.id, {
        phoneNumber: `deleted:${account.id}:01711000000`,
      });
      await prisma.account.update({
        where: { id: account.id },
        data: { status: "DELETED", deletedAt: new Date() },
      });

      const res = await app.inject({
        method: "GET",
        url: `${LIST_URL}/${account.id}`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.phoneNumber).toBeNull();
      expect(body.whatsappNumber).toBeNull();
      expect(body.status).toBe("DELETED");
    });

    it("unknown id returns 404", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: `${LIST_URL}/${crypto.randomUUID()}`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("NOT_FOUND");
      expect(body.message).toBe("Account not found");
    });
  });

  describe("POST /api/v1/admin/accounts/:id/block", () => {
    it("no token gets 401", async () => {
      const app = await createTestApp();
      const student = await createAccount({ role: "STUDENT" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${student.id}/block`,
        payload: { reason: "Spam listings" },
      });

      expect(res.statusCode).toBe(401);
    });

    it("plain ACTIVE admin gets 403", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const student = await createAccount({ role: "STUDENT" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${student.id}/block`,
        headers: await getAuthHeaders(admin),
        payload: { reason: "Spam listings" },
      });

      expect(res.statusCode).toBe(403);
      const row = await prisma.account.findUniqueOrThrow({ where: { id: student.id } });
      expect(row.status).toBe("ACTIVE");
    });

    it("super admin blocks a student: sets BLOCKED, revokes sessions, writes an audit row", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const student = await createAccount({ role: "STUDENT" });
      await createSession(student.id);
      await createSession(student.id);

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${student.id}/block`,
        headers: await getAuthHeaders(superAdmin),
        payload: { reason: "  Spam listings  " },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("BLOCKED");
      expect(body.activeBlock).toMatchObject({
        reason: "Spam listings",
        blockedByName: "Test Super Admin",
        blockedAt: expect.any(String),
      });
      expect(body.blocks).toHaveLength(1);
      expect(body.blocks[0].unblockedAt).toBeNull();

      const row = await prisma.account.findUniqueOrThrow({ where: { id: student.id } });
      expect(row.status).toBe("BLOCKED");

      const sessions = await prisma.session.findMany({ where: { accountId: student.id } });
      expect(sessions).toHaveLength(2);
      expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "account.block", entityId: student.id },
      });
      expect(audit.entityType).toBe("account");
      expect(audit.actorAccountId).toBe(superAdmin.id);
      expect(audit.after).toEqual({ reason: "Spam listings" });
    });

    it("blocking a tutor takes them out of the listing", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id, { isListed: true });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${account.id}/block`,
        headers: await getAuthHeaders(superAdmin),
        payload: { reason: "Fake credentials" },
      });

      expect(res.statusCode).toBe(200);
      const row = await prisma.tutor.findUniqueOrThrow({ where: { id: tutor.id } });
      expect(row.isListed).toBe(false);
    });

    it("reason shorter than 3 characters returns 400", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const student = await createAccount({ role: "STUDENT" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${student.id}/block`,
        headers: await getAuthHeaders(superAdmin),
        payload: { reason: "  x  " },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
    });

    it("blocking yourself returns 409", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${superAdmin.id}/block`,
        headers: await getAuthHeaders(superAdmin),
        payload: { reason: "Testing" },
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("INVALID_ACCOUNT_STATE");
      expect(body.message).toBe("You cannot block yourself");
    });

    it("blocking a super admin returns 409", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const otherSuperAdmin = await createAdmin({ adminRole: "SUPER_ADMIN" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${otherSuperAdmin.id}/block`,
        headers: await getAuthHeaders(superAdmin),
        payload: { reason: "Testing" },
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("INVALID_ACCOUNT_STATE");
      expect(body.message).toBe("A super admin cannot be blocked");
    });

    it("blocking a deleted account returns 409", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const deleted = await createAccount({ role: "STUDENT" });
      await prisma.account.update({
        where: { id: deleted.id },
        data: { status: "DELETED", deletedAt: new Date() },
      });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${deleted.id}/block`,
        headers: await getAuthHeaders(superAdmin),
        payload: { reason: "Spam listings" },
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("INVALID_ACCOUNT_STATE");
      expect(body.message).toBe("Deleted accounts cannot be blocked");
    });

    it("blocking an already blocked account returns 409", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const student = await createAccount({ role: "STUDENT" });
      const headers = await getAuthHeaders(superAdmin);
      const first = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${student.id}/block`,
        headers,
        payload: { reason: "Spam listings" },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${student.id}/block`,
        headers,
        payload: { reason: "Spam listings" },
      });

      expect(second.statusCode).toBe(409);
      const body = JSON.parse(second.body);
      expect(body.code).toBe("INVALID_ACCOUNT_STATE");
      expect(body.message).toBe("This account is already blocked");
    });

    it("unknown id returns 404", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${crypto.randomUUID()}/block`,
        headers: await getAuthHeaders(superAdmin),
        payload: { reason: "Spam listings" },
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).code).toBe("NOT_FOUND");
    });
  });

  describe("POST /api/v1/admin/accounts/:id/unblock", () => {
    it("plain ACTIVE admin gets 403", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const admin = await createAdmin({ status: "ACTIVE" });
      const student = await createAccount({ role: "STUDENT" });
      await prisma.accountBlock.create({
        data: { accountId: student.id, blockedById: superAdmin.id, reason: "Spam listings" },
      });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${student.id}/unblock`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(403);
      const row = await prisma.account.findUniqueOrThrow({ where: { id: student.id } });
      expect(row.status).toBe("BLOCKED");
    });

    it("super admin unblocks: sets ACTIVE and closes the block", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const student = await createAccount({ role: "STUDENT" });
      const headers = await getAuthHeaders(superAdmin);
      await app.inject({
        method: "POST",
        url: `${LIST_URL}/${student.id}/block`,
        headers,
        payload: { reason: "Spam listings" },
      });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${student.id}/unblock`,
        headers,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("ACTIVE");
      expect(body.activeBlock).toBeNull();
      expect(body.blocks[0]).toMatchObject({
        reason: "Spam listings",
        blockedByName: "Test Super Admin",
        unblockedByName: "Test Super Admin",
        unblockedAt: expect.any(String),
      });

      const row = await prisma.account.findUniqueOrThrow({ where: { id: student.id } });
      expect(row.status).toBe("ACTIVE");

      const block = await prisma.accountBlock.findFirstOrThrow({
        where: { accountId: student.id },
      });
      expect(block.unblockedAt).not.toBeNull();
      expect(block.unblockedById).toBe(superAdmin.id);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "account.unblock", entityId: student.id },
      });
      expect(audit.actorAccountId).toBe(superAdmin.id);
      expect(audit.before).toEqual({ status: "BLOCKED" });
      expect(audit.after).toEqual({ status: "ACTIVE" });
    });

    it("unblocking an account that is not blocked returns 409", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const student = await createAccount({ role: "STUDENT" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${student.id}/unblock`,
        headers: await getAuthHeaders(superAdmin),
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("INVALID_ACCOUNT_STATE");
      expect(body.message).toBe("This account is not blocked");
    });

    it("unknown id returns 404", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${crypto.randomUUID()}/unblock`,
        headers: await getAuthHeaders(superAdmin),
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).code).toBe("NOT_FOUND");
    });
  });
});
