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

describe("admin invites", () => {
  const INVITES_URL = `${LIST_URL}/invites`;
  const inDays = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  describe("POST /api/v1/admin/admins/invites", () => {
    it("super admin creates an invite (lowercased, trimmed) and writes an audit row", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();

      const res = await app.inject({
        method: "POST",
        url: INVITES_URL,
        headers: await getAuthHeaders(superAdmin),
        payload: { email: "  New.Admin@Example.com " },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        email: "new.admin@example.com",
        invitedByName: "Test Super Admin",
        expired: false,
      });
      expect(body.createdAt).toEqual(expect.any(String));
      const expiresAt = new Date(body.expiresAt).getTime();
      expect(expiresAt - Date.now()).toBeGreaterThan(13 * 24 * 60 * 60 * 1000);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "admin.invite", entityId: body.id },
      });
      expect(audit.entityType).toBe("admin_invite");
      expect(audit.actorAccountId).toBe(superAdmin.id);
      expect(audit.after).toEqual({ email: "new.admin@example.com" });
    });

    it("plain ACTIVE admin gets 403 and creates nothing", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "POST",
        url: INVITES_URL,
        headers: await getAuthHeaders(admin),
        payload: { email: "nope@example.com" },
      });

      expect(res.statusCode).toBe(403);
      expect(await prisma.adminInvite.count()).toBe(0);
    });

    it("a malformed email returns 400 VALIDATION_ERROR", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();

      const res = await app.inject({
        method: "POST",
        url: INVITES_URL,
        headers: await getAuthHeaders(superAdmin),
        payload: { email: "not-an-email" },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
      expect(await prisma.adminInvite.count()).toBe(0);
    });

    it("no token gets 401 and creates nothing", async () => {
      const app = await createTestApp();

      const res = await app.inject({
        method: "POST",
        url: INVITES_URL,
        payload: { email: "anon@example.com" },
      });

      expect(res.statusCode).toBe(401);
      expect(await prisma.adminInvite.count()).toBe(0);
    });

    it("an email that already has an account returns 409 ACCOUNT_EXISTS", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      await createAccount({ role: "TUTOR", email: "taken@example.com" });

      const res = await app.inject({
        method: "POST",
        url: INVITES_URL,
        headers: await getAuthHeaders(superAdmin),
        payload: { email: "taken@example.com" },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("ACCOUNT_EXISTS");
    });

    it("a super admin email returns 409 SUPER_ADMIN_EMAIL", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      await prisma.superAdminEmail.create({ data: { slot: 2, email: "future-root@example.com" } });

      const res = await app.inject({
        method: "POST",
        url: INVITES_URL,
        headers: await getAuthHeaders(superAdmin),
        payload: { email: "future-root@example.com" },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("SUPER_ADMIN_EMAIL");
    });

    it("a second invite for an open invite returns 409 INVITE_EXISTS", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const headers = await getAuthHeaders(superAdmin);
      await app.inject({
        method: "POST",
        url: INVITES_URL,
        headers,
        payload: { email: "dup@example.com" },
      });

      const res = await app.inject({
        method: "POST",
        url: INVITES_URL,
        headers,
        payload: { email: "dup@example.com" },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("INVITE_EXISTS");
      expect(await prisma.adminInvite.count()).toBe(1);
    });

    it("an expired invite is replaced by a new one", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const oldInviter = await createAdmin({ status: "REMOVED" });
      await prisma.adminInvite.create({
        data: {
          email: "again@example.com",
          invitedById: oldInviter.id,
          createdAt: inDays(-30),
          expiresAt: inDays(-16),
        },
      });

      const res = await app.inject({
        method: "POST",
        url: INVITES_URL,
        headers: await getAuthHeaders(superAdmin),
        payload: { email: "again@example.com" },
      });

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).expired).toBe(false);
      const invite = await prisma.adminInvite.findUniqueOrThrow({
        where: { email: "again@example.com" },
      });
      expect(invite.invitedById).toBe(superAdmin.id);
      expect(invite.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe("GET /api/v1/admin/admins/invites", () => {
    it("lists invites newest first, with expired ones flagged", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      await prisma.adminInvite.create({
        data: {
          email: "old@example.com",
          invitedById: superAdmin.id,
          createdAt: inDays(-20),
          expiresAt: inDays(-6),
        },
      });
      await prisma.adminInvite.create({
        data: {
          email: "open@example.com",
          invitedById: superAdmin.id,
          createdAt: inDays(-1),
          expiresAt: inDays(13),
        },
      });

      const res = await app.inject({
        method: "GET",
        url: INVITES_URL,
        headers: await getAuthHeaders(superAdmin),
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      const { invites } = JSON.parse(res.body);
      expect(invites.map((i: { email: string; expired: boolean }) => [i.email, i.expired])).toEqual(
        [
          ["open@example.com", false],
          ["old@example.com", true],
        ],
      );
    });

    it("plain ACTIVE admin gets 403", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: INVITES_URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe("DELETE /api/v1/admin/admins/invites/:id", () => {
    it("revokes the invite (204), deletes its row and writes an audit row", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const invite = await prisma.adminInvite.create({
        data: {
          email: "revoke@example.com",
          invitedById: superAdmin.id,
          expiresAt: inDays(14),
        },
      });

      const res = await app.inject({
        method: "DELETE",
        url: `${INVITES_URL}/${invite.id}`,
        headers: await getAuthHeaders(superAdmin),
      });

      expect(res.statusCode).toBe(204);
      expect(await prisma.adminInvite.findUnique({ where: { id: invite.id } })).toBeNull();
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "admin.invite_revoke", entityId: invite.id },
      });
      expect(audit.actorAccountId).toBe(superAdmin.id);
      expect(audit.before).toEqual({ email: "revoke@example.com" });
    });

    it("an unknown id returns 404", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();

      const res = await app.inject({
        method: "DELETE",
        url: `${INVITES_URL}/${crypto.randomUUID()}`,
        headers: await getAuthHeaders(superAdmin),
      });

      expect(res.statusCode).toBe(404);
    });

    it("plain ACTIVE admin gets 403 and the invite stays", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const admin = await createAdmin({ status: "ACTIVE" });
      const invite = await prisma.adminInvite.create({
        data: { email: "keep@example.com", invitedById: superAdmin.id, expiresAt: inDays(14) },
      });

      const res = await app.inject({
        method: "DELETE",
        url: `${INVITES_URL}/${invite.id}`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(403);
      expect(await prisma.adminInvite.findUnique({ where: { id: invite.id } })).not.toBeNull();
    });
  });
});
