import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createAdmin,
  createArea,
  createStudentProfile,
  createSuperAdmin,
  createTestApp,
  createTutorProfile,
  getAuthHeaders,
} from "../../tests/helpers.js";

const URL = "/api/v1/admin/audit-logs";

type Entry = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  ip: string | null;
  createdAt: string;
  actor: { accountId: string; email: string; name: string | null } | null;
};

async function writeAudit(
  overrides: {
    actorAccountId?: string | null;
    action?: string;
    entityType?: string;
    entityId?: string;
  } = {},
) {
  return prisma.auditLog.create({
    data: {
      actorAccountId: overrides.actorAccountId ?? null,
      action: overrides.action ?? "test.action",
      entityType: overrides.entityType ?? "test_entity",
      entityId: overrides.entityId ?? "1",
      before: { status: "OLD" },
      after: { status: "NEW" },
      ip: "203.0.113.7",
    },
  });
}

describe("admin audit log", () => {
  describe("GET /api/v1/admin/audit-logs", () => {
    it("rejects a request without a token with 401", async () => {
      const app = await createTestApp();

      const res = await app.inject({ method: "GET", url: URL });

      expect(res.statusCode).toBe(401);
    });

    it("rejects a student token with 403", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });

      const res = await app.inject({
        method: "GET",
        url: URL,
        headers: await getAuthHeaders(account),
      });

      expect(res.statusCode).toBe(403);
    });

    it("returns newest first, with the actor's name from its profile", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const tutorAccount = await createAccount({ role: "TUTOR" });
      await createTutorProfile(tutorAccount.id, { name: "Tutor Name" });
      const studentAccount = await createAccount({ role: "STUDENT" });
      const area = await createArea();
      await createStudentProfile(studentAccount.id, area.id, { name: "Student Name" });

      const adminRow = await writeAudit({ actorAccountId: admin.id });
      const tutorRow = await writeAudit({ actorAccountId: tutorAccount.id });
      const studentRow = await writeAudit({ actorAccountId: studentAccount.id });
      const systemRow = await writeAudit({ actorAccountId: null });

      const res = await app.inject({
        method: "GET",
        url: URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { entries: Entry[]; nextCursor: string | null };
      expect(body.entries.map((e) => e.id)).toEqual([
        String(systemRow.id),
        String(studentRow.id),
        String(tutorRow.id),
        String(adminRow.id),
      ]);
      expect(body.entries[0]?.actor).toBeNull();
      expect(body.entries[1]?.actor?.name).toBe("Student Name");
      expect(body.entries[2]?.actor?.name).toBe("Tutor Name");
      expect(body.entries[3]?.actor).toEqual({
        accountId: admin.id,
        email: admin.email,
        name: "Test Admin",
      });
      expect(body.nextCursor).toBeNull();
    });

    it("returns the entry fields, with the id as a string and before and after as stored", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const row = await writeAudit({
        actorAccountId: admin.id,
        action: "thing.change",
        entityType: "thing",
        entityId: "42",
      });

      const res = await app.inject({
        method: "GET",
        url: URL,
        headers: await getAuthHeaders(admin),
      });

      const entry = (JSON.parse(res.body) as { entries: Entry[] }).entries[0];
      expect(entry).toEqual({
        id: String(row.id),
        action: "thing.change",
        entityType: "thing",
        entityId: "42",
        before: { status: "OLD" },
        after: { status: "NEW" },
        ip: "203.0.113.7",
        createdAt: expect.any(String),
        actor: { accountId: admin.id, email: admin.email, name: "Test Admin" },
      });
    });

    it("filters by entityType and entityId", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const wanted = await writeAudit({ entityType: "subject", entityId: "7" });
      await writeAudit({ entityType: "subject", entityId: "8" });
      await writeAudit({ entityType: "platform_setting", entityId: "7" });
      const headers = await getAuthHeaders(admin);

      const byType = await app.inject({
        method: "GET",
        url: `${URL}?entityType=subject&entityId=7`,
        headers,
      });

      const ids = (JSON.parse(byType.body) as { entries: Entry[] }).entries.map((e) => e.id);
      expect(ids).toEqual([String(wanted.id)]);
    });

    it("filters by actorAccountId and action", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const other = await createSuperAdmin();
      const headers = await getAuthHeaders(admin);
      const wanted = await writeAudit({ actorAccountId: admin.id, action: "subject.create" });
      await writeAudit({ actorAccountId: other.id, action: "subject.create" });
      await writeAudit({ actorAccountId: admin.id, action: "subject.update" });

      const res = await app.inject({
        method: "GET",
        url: `${URL}?actorAccountId=${admin.id}&action=subject.create`,
        headers,
      });

      expect(res.statusCode).toBe(200);
      const ids = (JSON.parse(res.body) as { entries: Entry[] }).entries.map((e) => e.id);
      expect(ids).toEqual([String(wanted.id)]);
    });

    it("rejects a malformed actorAccountId with 400", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: `${URL}?actorAccountId=not-a-uuid`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
    });

    it("pages through every entry with nextCursor, without repeats", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const headers = await getAuthHeaders(admin);
      const written: string[] = [];
      for (let i = 0; i < 5; i++) {
        written.push(String((await writeAudit({ entityId: String(i) })).id));
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : "?limit=2";
        const res = await app.inject({ method: "GET", url: `${URL}${query}`, headers });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { entries: Entry[]; nextCursor: string | null };
        seen.push(...body.entries.map((e) => e.id));
        cursor = body.nextCursor;
        pages++;
      } while (cursor && pages < 10);

      expect(pages).toBe(3);
      expect(seen).toEqual([...written].reverse());
    });

    it("gives a nextCursor only when more entries follow", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      await writeAudit();
      await writeAudit();

      const res = await app.inject({
        method: "GET",
        url: `${URL}?limit=2`,
        headers: await getAuthHeaders(admin),
      });

      const body = JSON.parse(res.body) as { entries: Entry[]; nextCursor: string | null };
      expect(body.entries).toHaveLength(2);
      expect(body.nextCursor).toBeNull();
    });

    it("rejects an invalid cursor with 400", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: `${URL}?cursor=not-a-cursor`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
    });

    it("records a settings change in the log", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const headers = await getAuthHeaders(superAdmin);
      await app.inject({
        method: "PUT",
        url: "/api/v1/admin/settings/commission_percent",
        headers,
        payload: { value: 3 },
      });

      const res = await app.inject({
        method: "GET",
        url: `${URL}?entityType=platform_setting&entityId=commission_percent`,
        headers,
      });

      const entries = (JSON.parse(res.body) as { entries: Entry[] }).entries;
      expect(entries).toHaveLength(1);
      expect(entries[0]?.action).toBe("setting.update");
      expect(entries[0]?.after).toEqual({ value: 3 });
      expect(entries[0]?.actor?.name).toBe("Test Super Admin");
    });

    it("sends Cache-Control private, no-store", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.headers["cache-control"]).toBe("private, no-store");
    });
  });
});
