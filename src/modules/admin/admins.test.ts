import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createAdmin,
  createSession,
  createSuperAdmin,
  createTestApp,
  getAuthHeaders,
} from "../../tests/helpers.js";

const LIST_URL = "/api/v1/admin/admins";

async function setAdminCreatedAt(accountId: string, createdAt: string) {
  await prisma.adminUser.update({
    where: { accountId },
    data: { createdAt: new Date(createdAt) },
  });
}

describe("admin team", () => {
  describe("GET /api/v1/admin/admins", () => {
    it("no token gets 401", async () => {
      const app = await createTestApp();

      const res = await app.inject({ method: "GET", url: LIST_URL });

      expect(res.statusCode).toBe(401);
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

    it("lists PENDING first, then ACTIVE, then REMOVED, oldest first inside each group", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      await setAdminCreatedAt(superAdmin.id, "2026-01-01T00:00:00Z");
      const activeNew = await createAdmin({ status: "ACTIVE" });
      await setAdminCreatedAt(activeNew.id, "2026-03-02T00:00:00Z");
      const activeOld = await createAdmin({ status: "ACTIVE" });
      await setAdminCreatedAt(activeOld.id, "2026-03-01T00:00:00Z");
      const pending = await createAdmin({ status: "PENDING" });
      await setAdminCreatedAt(pending.id, "2026-04-01T00:00:00Z");
      const removed = await createAdmin({ status: "REMOVED" });
      await setAdminCreatedAt(removed.id, "2025-01-01T00:00:00Z");

      const res = await app.inject({
        method: "GET",
        url: LIST_URL,
        headers: await getAuthHeaders(superAdmin),
      });

      expect(res.statusCode).toBe(200);
      const admins = JSON.parse(res.body).admins;
      expect(admins.map((a: { accountId: string }) => a.accountId)).toEqual([
        pending.id,
        superAdmin.id,
        activeOld.id,
        activeNew.id,
        removed.id,
      ]);
      expect(admins[0].status).toBe("PENDING");
      expect(admins[0].approvedAt).toBeNull();
      expect(admins[0].approvedByName).toBeNull();
      expect(admins[2].approvedByName).toBe("Test Super Admin");
      expect(admins[4].status).toBe("REMOVED");
      expect(admins[4].removedAt).not.toBeNull();
    });

    it("sends Cache-Control private, no-store", async () => {
      const app = await createTestApp();

      const res = await app.inject({ method: "GET", url: LIST_URL });

      expect(res.statusCode).toBe(401);
      expect(res.headers["cache-control"]).toBe("private, no-store");
    });
  });

  describe("POST /api/v1/admin/admins/:accountId/approve", () => {
    it("no token gets 401", async () => {
      const app = await createTestApp();
      const pending = await createAdmin({ status: "PENDING" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${pending.id}/approve`,
      });

      expect(res.statusCode).toBe(401);
    });

    it("plain ACTIVE admin gets 403", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const pending = await createAdmin({ status: "PENDING" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${pending.id}/approve`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(403);
      const stillPending = await prisma.adminUser.findUniqueOrThrow({
        where: { accountId: pending.id },
      });
      expect(stillPending.status).toBe("PENDING");
    });

    it("PENDING admin gets 403", async () => {
      const app = await createTestApp();
      const caller = await createAdmin({ status: "PENDING" });
      const pending = await createAdmin({ status: "PENDING" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${pending.id}/approve`,
        headers: await getAuthHeaders(caller),
      });

      expect(res.statusCode).toBe(403);
    });

    it("super admin approves a pending admin and writes an audit row", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const pending = await createAdmin({ status: "PENDING" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${pending.id}/approve`,
        headers: await getAuthHeaders(superAdmin),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.accountId).toBe(pending.id);
      expect(body.status).toBe("ACTIVE");
      expect(body.approvedAt).toEqual(expect.any(String));
      expect(body.approvedByName).toBe("Test Super Admin");

      const admin = await prisma.adminUser.findUniqueOrThrow({
        where: { accountId: pending.id },
      });
      expect(admin.status).toBe("ACTIVE");
      expect(admin.approvedById).toBe(superAdmin.id);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "admin.approve", entityId: pending.id },
      });
      expect(audit.entityType).toBe("admin_user");
      expect(audit.actorAccountId).toBe(superAdmin.id);
      expect(audit.before).toEqual({ status: "PENDING" });
      expect(audit.after).toEqual({ status: "ACTIVE" });
    });

    it("approving an ACTIVE admin returns 409 INVALID_ADMIN_STATE", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const active = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${active.id}/approve`,
        headers: await getAuthHeaders(superAdmin),
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("INVALID_ADMIN_STATE");
      expect(body.message).toBe("Only pending admins can be approved");
    });

    it("approving a pending admin whose account is blocked returns 409", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const pending = await createAdmin({ status: "PENDING" });
      await prisma.accountBlock.create({
        data: { accountId: pending.id, blockedById: superAdmin.id, reason: "Spam sign-up" },
      });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${pending.id}/approve`,
        headers: await getAuthHeaders(superAdmin),
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("INVALID_ADMIN_STATE");
      expect(body.message).toBe("This account is blocked or deleted");
      const admin = await prisma.adminUser.findUniqueOrThrow({
        where: { accountId: pending.id },
      });
      expect(admin.status).toBe("PENDING");
    });

    it("unknown account returns 404", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${crypto.randomUUID()}/approve`,
        headers: await getAuthHeaders(superAdmin),
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).code).toBe("NOT_FOUND");
    });
  });

  describe("POST /api/v1/admin/admins/:accountId/remove", () => {
    it("no token gets 401", async () => {
      const app = await createTestApp();
      const active = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${active.id}/remove`,
      });

      expect(res.statusCode).toBe(401);
    });

    it("plain ACTIVE admin gets 403", async () => {
      const app = await createTestApp();
      const caller = await createAdmin({ status: "ACTIVE" });
      const target = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${target.id}/remove`,
        headers: await getAuthHeaders(caller),
      });

      expect(res.statusCode).toBe(403);
      const stillActive = await prisma.adminUser.findUniqueOrThrow({
        where: { accountId: target.id },
      });
      expect(stillActive.status).toBe("ACTIVE");
    });

    it("PENDING admin gets 403", async () => {
      const app = await createTestApp();
      const caller = await createAdmin({ status: "PENDING" });
      const target = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${target.id}/remove`,
        headers: await getAuthHeaders(caller),
      });

      expect(res.statusCode).toBe(403);
    });

    it("removes an ACTIVE admin, revokes their sessions, and writes an audit row", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const admin = await createAdmin({ status: "ACTIVE" });
      await createSession(admin.id);

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${admin.id}/remove`,
        headers: await getAuthHeaders(superAdmin),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("REMOVED");
      expect(body.removedAt).toEqual(expect.any(String));

      const row = await prisma.adminUser.findUniqueOrThrow({ where: { accountId: admin.id } });
      expect(row.status).toBe("REMOVED");
      expect(row.removedById).toBe(superAdmin.id);
      expect(row.removedAt).not.toBeNull();

      const sessions = await prisma.session.findMany({ where: { accountId: admin.id } });
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "admin.remove", entityId: admin.id },
      });
      expect(audit.actorAccountId).toBe(superAdmin.id);
      expect(audit.before).toEqual({ status: "ACTIVE" });
      expect(audit.after).toEqual({ status: "REMOVED" });
    });

    it("a removed admin gets 403 on the admin list", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const admin = await createAdmin({ status: "ACTIVE" });
      const adminHeaders = await getAuthHeaders(admin);

      const before = await app.inject({ method: "GET", url: LIST_URL, headers: adminHeaders });
      expect(before.statusCode).toBe(200);

      const removeRes = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${admin.id}/remove`,
        headers: await getAuthHeaders(superAdmin),
      });
      expect(removeRes.statusCode).toBe(200);

      // The access token is still valid until it expires; requireAdmin re-checks the row.
      const after = await app.inject({ method: "GET", url: LIST_URL, headers: adminHeaders });
      expect(after.statusCode).toBe(403);
    });

    it("removes a PENDING admin", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const pending = await createAdmin({ status: "PENDING" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${pending.id}/remove`,
        headers: await getAuthHeaders(superAdmin),
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).status).toBe("REMOVED");
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "admin.remove", entityId: pending.id },
      });
      expect(audit.before).toEqual({ status: "PENDING" });
    });

    it("removing yourself returns 409", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${superAdmin.id}/remove`,
        headers: await getAuthHeaders(superAdmin),
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("INVALID_ADMIN_STATE");
      expect(body.message).toBe("You cannot remove yourself");
    });

    it("removing a super admin returns 409", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const otherSuperAdmin = await createAdmin({ adminRole: "SUPER_ADMIN" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${otherSuperAdmin.id}/remove`,
        headers: await getAuthHeaders(superAdmin),
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("INVALID_ADMIN_STATE");
      expect(body.message).toBe("A super admin cannot be removed");
    });

    it("removing an already removed admin returns 409", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const removed = await createAdmin({ status: "REMOVED" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${removed.id}/remove`,
        headers: await getAuthHeaders(superAdmin),
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("INVALID_ADMIN_STATE");
      expect(body.message).toBe("This admin was already removed");
    });

    it("unknown account returns 404", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${crypto.randomUUID()}/remove`,
        headers: await getAuthHeaders(superAdmin),
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).code).toBe("NOT_FOUND");
    });
  });
});
