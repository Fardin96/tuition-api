import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createAdmin,
  createSuperAdmin,
  createTestApp,
  createTutorProfile,
  getAuthHeaders,
} from "../../tests/helpers.js";

const URL = "/api/v1/admin/settings";

type Setting = {
  key: string;
  value: number | boolean;
  updatedAt: string | null;
  updatedByName: string | null;
};

async function isListed(tutorId: string) {
  const tutor = await prisma.tutor.findUniqueOrThrow({ where: { id: tutorId } });
  return tutor.isListed;
}

describe("admin platform settings", () => {
  describe("GET /api/v1/admin/settings", () => {
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

    it("rejects a PENDING admin with 403", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "PENDING" });

      const res = await app.inject({
        method: "GET",
        url: URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(403);
    });

    it("lists the three known settings in order, with defaults for missing rows", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { settings: Setting[] };
      expect(body.settings.map((s) => s.key)).toEqual([
        "commission_percent",
        "require_tutor_verification",
        "require_phone_verification",
      ]);
      // commission_percent has no seeded row, so it reports the default with no timestamp.
      expect(body.settings[0]).toEqual({
        key: "commission_percent",
        value: 0,
        updatedAt: null,
        updatedByName: null,
      });
      expect(body.settings.slice(1).map((s) => s.value)).toEqual([false, false]);
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

  describe("PUT /api/v1/admin/settings/:key", () => {
    it("rejects a request without a token with 401", async () => {
      const app = await createTestApp();

      const res = await app.inject({
        method: "PUT",
        url: `${URL}/commission_percent`,
        payload: { value: 5 },
      });

      expect(res.statusCode).toBe(401);
    });

    it("rejects a plain ADMIN with 403", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE", adminRole: "ADMIN" });

      const res = await app.inject({
        method: "PUT",
        url: `${URL}/commission_percent`,
        headers: await getAuthHeaders(admin),
        payload: { value: 5 },
      });

      expect(res.statusCode).toBe(403);
    });

    it("rejects an unknown key with 400", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();

      const res = await app.inject({
        method: "PUT",
        url: `${URL}/maintenance_mode`,
        headers: await getAuthHeaders(superAdmin),
        payload: { value: true },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
    });

    it.each([
      ["commission_percent", -1],
      ["commission_percent", 100.5],
      ["commission_percent", 12.345],
      ["commission_percent", true],
      ["require_tutor_verification", 1],
      ["require_phone_verification", 50],
      ["require_phone_verification", "yes"],
    ])("rejects %s set to %j with 400", async (key, value) => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();

      const res = await app.inject({
        method: "PUT",
        url: `${URL}/${key}`,
        headers: await getAuthHeaders(superAdmin),
        payload: { value },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
    });

    it("reports the bad field in issues for a service-level rule", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();

      const res = await app.inject({
        method: "PUT",
        url: `${URL}/commission_percent`,
        headers: await getAuthHeaders(superAdmin),
        payload: { value: 101 },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.message).toBe("Invalid setting value");
      expect(body.issues[0].path).toEqual(["value"]);
    });

    it("accepts the commission boundaries and two decimal places", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const headers = await getAuthHeaders(superAdmin);

      for (const value of [0, 100, 12.34]) {
        const res = await app.inject({
          method: "PUT",
          url: `${URL}/commission_percent`,
          headers,
          payload: { value },
        });
        expect(res.statusCode, String(value)).toBe(200);
      }
    });

    it("saves commission_percent and reports who changed it", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();

      const res = await app.inject({
        method: "PUT",
        url: `${URL}/commission_percent`,
        headers: await getAuthHeaders(superAdmin),
        payload: { value: 7.25 },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({
        key: "commission_percent",
        value: 7.25,
        updatedAt: expect.any(String),
        updatedByName: "Test Super Admin",
      });

      const row = await prisma.platformSetting.findUniqueOrThrow({
        where: { key: "commission_percent" },
      });
      expect(row.value).toBe(7.25);
      expect(row.updatedById).toBe(superAdmin.id);

      const list = await app.inject({
        method: "GET",
        url: URL,
        headers: await getAuthHeaders(superAdmin),
      });
      const commission = JSON.parse(list.body).settings[0];
      expect(commission.value).toBe(7.25);
    });

    it("unlists a tutor with verification NOT_SUBMITTED when require_tutor_verification turns on", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id);
      // With verification optional, an active tutor is listed.
      await prisma.$executeRaw`SELECT recompute_is_listed(${tutor.id}::uuid)`;
      expect(await isListed(tutor.id)).toBe(true);

      const res = await app.inject({
        method: "PUT",
        url: `${URL}/require_tutor_verification`,
        headers: await getAuthHeaders(superAdmin),
        payload: { value: true },
      });

      expect(res.statusCode).toBe(200);
      expect(await isListed(tutor.id)).toBe(false);
    });

    it("relists the tutor when require_tutor_verification turns back off", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const headers = await getAuthHeaders(superAdmin);
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id);
      await app.inject({
        method: "PUT",
        url: `${URL}/require_tutor_verification`,
        headers,
        payload: { value: true },
      });
      expect(await isListed(tutor.id)).toBe(false);

      const res = await app.inject({
        method: "PUT",
        url: `${URL}/require_tutor_verification`,
        headers,
        payload: { value: false },
      });

      expect(res.statusCode).toBe(200);
      expect(await isListed(tutor.id)).toBe(true);
    });

    it("writes an audit_log row with the old and new value", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const headers = await getAuthHeaders(superAdmin);

      await app.inject({
        method: "PUT",
        url: `${URL}/commission_percent`,
        headers,
        payload: { value: 5 },
      });
      await app.inject({
        method: "PUT",
        url: `${URL}/require_tutor_verification`,
        headers,
        payload: { value: true },
      });

      const commission = await prisma.auditLog.findFirstOrThrow({
        where: { action: "setting.update", entityId: "commission_percent" },
      });
      expect(commission.entityType).toBe("platform_setting");
      expect(commission.actorAccountId).toBe(superAdmin.id);
      expect(commission.before).toEqual({ value: 0 });
      expect(commission.after).toEqual({ value: 5 });

      const verification = await prisma.auditLog.findFirstOrThrow({
        where: { action: "setting.update", entityId: "require_tutor_verification" },
      });
      expect(verification.before).toEqual({ value: false });
      expect(verification.after).toEqual({ value: true });
    });
  });
});
