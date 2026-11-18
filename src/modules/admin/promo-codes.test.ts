import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createAdmin,
  createSuperAdmin,
  createTestApp,
  createTutorFeeFixture,
  getAuthHeaders,
} from "../../tests/helpers.js";

const URL = "/api/v1/admin/promo-codes";
const DAY_MS = 24 * 60 * 60 * 1000;

type AdminPromoCode = {
  id: string;
  code: string;
  description: string | null;
  discountType: "PERCENT" | "FLAT";
  discountValue: string;
  maxDiscount: string | null;
  startsAt: string | null;
  endsAt: string | null;
  maxRedemptions: number | null;
  maxPerTutor: number;
  isActive: boolean;
  redemptionCount: number;
  createdByName: string;
};

type AdminPromoCodeDetail = AdminPromoCode & {
  redemptions: {
    id: string;
    feeId: string;
    tutor: { id: string; name: string };
    originalAmount: string;
    discountAmount: string;
    status: "ACTIVE" | "RELEASED";
    releasedAt: string | null;
    releaseReason: string | null;
  }[];
};

type PromoOverrides = {
  code?: string;
  discountType?: "PERCENT" | "FLAT";
  discountValue?: number;
  maxDiscount?: number | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  maxRedemptions?: number | null;
  maxPerTutor?: number;
  isActive?: boolean;
  createdAt?: Date;
};

async function addPromo(createdById: string, overrides: PromoOverrides = {}) {
  return prisma.promoCode.create({
    data: {
      code: overrides.code ?? `P${crypto.randomUUID().slice(0, 10)}`.toUpperCase(),
      discountType: overrides.discountType ?? "PERCENT",
      discountValue: overrides.discountValue ?? 10,
      maxDiscount: overrides.maxDiscount ?? null,
      startsAt: overrides.startsAt ?? null,
      endsAt: overrides.endsAt ?? null,
      maxRedemptions: overrides.maxRedemptions ?? null,
      maxPerTutor: overrides.maxPerTutor ?? 1,
      isActive: overrides.isActive ?? true,
      createdById,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });
}

function futureDate(days = 30) {
  return new Date(Date.now() + days * DAY_MS);
}

describe("admin promo codes", () => {
  describe("GET /api/v1/admin/promo-codes", () => {
    it("rejects a request without a token with 401", async () => {
      const app = await createTestApp();

      const res = await app.inject({ method: "GET", url: URL });

      expect(res.statusCode).toBe(401);
    });

    it("rejects a tutor token with 403", async () => {
      const app = await createTestApp();
      const tutor = await createAccount({ role: "TUTOR" });

      const res = await app.inject({
        method: "GET",
        url: URL,
        headers: await getAuthHeaders(tutor),
      });

      expect(res.statusCode).toBe(403);
    });

    it("lets a plain admin read the list, with no-store caching", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(JSON.parse(res.body)).toEqual({ promoCodes: [], nextCursor: null });
    });

    it("lists newest first, filters on active, and pages with a cursor", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const base = Date.now() - 10 * DAY_MS;
      const oldest = await addPromo(superAdmin.id, {
        code: "OLDEST",
        createdAt: new Date(base),
      });
      const middle = await addPromo(superAdmin.id, {
        code: "MIDDLE",
        isActive: false,
        createdAt: new Date(base + 1000),
      });
      const newest = await addPromo(superAdmin.id, {
        code: "NEWEST",
        createdAt: new Date(base + 2000),
      });
      const headers = await getAuthHeaders(superAdmin);

      const firstPage = await app.inject({ method: "GET", url: `${URL}?limit=2`, headers });
      expect(firstPage.statusCode).toBe(200);
      const first = JSON.parse(firstPage.body) as {
        promoCodes: AdminPromoCode[];
        nextCursor: string;
      };
      expect(first.promoCodes.map((p) => p.id)).toEqual([newest.id, middle.id]);
      expect(first.nextCursor).not.toBeNull();

      const secondPage = await app.inject({
        method: "GET",
        url: `${URL}?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
        headers,
      });
      const second = JSON.parse(secondPage.body) as {
        promoCodes: AdminPromoCode[];
        nextCursor: null;
      };
      expect(second.promoCodes.map((p) => p.id)).toEqual([oldest.id]);
      expect(second.nextCursor).toBeNull();

      const inactive = await app.inject({ method: "GET", url: `${URL}?active=false`, headers });
      expect(JSON.parse(inactive.body).promoCodes.map((p: AdminPromoCode) => p.id)).toEqual([
        middle.id,
      ]);

      const active = await app.inject({ method: "GET", url: `${URL}?active=true`, headers });
      expect(JSON.parse(active.body).promoCodes.map((p: AdminPromoCode) => p.id)).toEqual([
        newest.id,
        oldest.id,
      ]);
    });

    it("rejects a malformed cursor with 400", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: `${URL}?cursor=not-a-cursor`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /api/v1/admin/promo-codes", () => {
    it("rejects a request without a token with 401", async () => {
      const app = await createTestApp();

      const res = await app.inject({
        method: "POST",
        url: URL,
        payload: { code: "SAVE10", discountType: "PERCENT", discountValue: 10 },
      });

      expect(res.statusCode).toBe(401);
    });

    it("creates an uppercase code with 201, the creator's name and an audit row", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const adminRow = await prisma.adminUser.findUniqueOrThrow({
        where: { accountId: superAdmin.id },
        select: { name: true },
      });

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await getAuthHeaders(superAdmin),
        payload: {
          code: "  save10  ",
          description: "Ten percent off",
          discountType: "PERCENT",
          discountValue: 10,
          maxDiscount: 200,
          maxRedemptions: 50,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as AdminPromoCodeDetail;
      expect(body.code).toBe("SAVE10");
      expect(body.description).toBe("Ten percent off");
      expect(body.discountType).toBe("PERCENT");
      expect(body.discountValue).toBe("10.00");
      expect(body.maxDiscount).toBe("200.00");
      expect(body.maxRedemptions).toBe(50);
      expect(body.maxPerTutor).toBe(1);
      expect(body.isActive).toBe(true);
      expect(body.redemptionCount).toBe(0);
      expect(body.redemptions).toEqual([]);
      expect(body.createdByName).toBe(adminRow.name);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "promo.create", entityId: body.id },
      });
      expect(audit.entityType).toBe("promo_code");
      expect(audit.actorAccountId).toBe(superAdmin.id);
      expect(audit.after).toMatchObject({
        code: "SAVE10",
        discountValue: "10.00",
        maxDiscount: "200.00",
      });
    });

    it("refuses a code that exists in any letter case with 409 PROMO_CODE_EXISTS", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const headers = await getAuthHeaders(superAdmin);
      await app.inject({
        method: "POST",
        url: URL,
        headers,
        payload: { code: "SAVE10", discountType: "PERCENT", discountValue: 10 },
      });

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers,
        payload: { code: "save10", discountType: "FLAT", discountValue: 100 },
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("PROMO_CODE_EXISTS");
      expect(body.message).toBe("A promo code with that name already exists.");
    });

    it("refuses a maxDiscount on a FLAT code with 400", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await getAuthHeaders(superAdmin),
        payload: { code: "FLAT200", discountType: "FLAT", discountValue: 200, maxDiscount: 50 },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.issues).toContainEqual(expect.objectContaining({ path: ["maxDiscount"] }));
    });

    it("refuses a PERCENT value above 100 with 400", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await getAuthHeaders(superAdmin),
        payload: { code: "HALFOFF", discountType: "PERCENT", discountValue: 150 },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).issues).toContainEqual(
        expect.objectContaining({ path: ["discountValue"] }),
      );
    });

    it("refuses an endsAt before startsAt with 400", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const startsAt = futureDate(10).toISOString();
      const endsAt = futureDate(5).toISOString();

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await getAuthHeaders(superAdmin),
        payload: { code: "WINDOW1", discountType: "FLAT", discountValue: 100, startsAt, endsAt },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).issues).toContainEqual(
        expect.objectContaining({ path: ["endsAt"] }),
      );
    });

    it("refuses an endsAt in the past with 400", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await getAuthHeaders(superAdmin),
        payload: {
          code: "OLDDEAL",
          discountType: "FLAT",
          discountValue: 100,
          endsAt: new Date(Date.now() - DAY_MS).toISOString(),
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it("refuses a code with characters outside the allowed set with 400", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await getAuthHeaders(superAdmin),
        payload: { code: "NO SPACES", discountType: "FLAT", discountValue: 100 },
      });

      expect(res.statusCode).toBe(400);
    });

    it("rejects a plain admin with 403", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE", adminRole: "ADMIN" });

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await getAuthHeaders(admin),
        payload: { code: "SAVE10", discountType: "PERCENT", discountValue: 10 },
      });

      expect(res.statusCode).toBe(403);
      expect(await prisma.promoCode.count()).toBe(0);
    });

    it("rejects a tutor with 403", async () => {
      const app = await createTestApp();
      const tutor = await createAccount({ role: "TUTOR" });

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await getAuthHeaders(tutor),
        payload: { code: "SAVE10", discountType: "PERCENT", discountValue: 10 },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe("GET /api/v1/admin/promo-codes/:id", () => {
    it("returns 404 for an unknown id", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: `${URL}/${crypto.randomUUID()}`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toBe("Promo code not found");
    });

    it("returns redemptionCount over ACTIVE rows only, and the redemptions newest first", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const promo = await addPromo(superAdmin.id, { code: "DETAIL10", maxPerTutor: 2 });
      const fixture = await createTutorFeeFixture(1500);
      await prisma.promoRedemption.create({
        data: {
          promoId: promo.id,
          feeId: fixture.fee.id,
          tutorId: fixture.tutor.id,
          originalAmount: 1500,
          discountAmount: 150,
          status: "RELEASED",
          releasedAt: new Date(),
          releaseReason: "Removed by tutor",
          createdAt: new Date(Date.now() - 1000),
        },
      });
      const active = await prisma.promoRedemption.create({
        data: {
          promoId: promo.id,
          feeId: fixture.fee.id,
          tutorId: fixture.tutor.id,
          originalAmount: 1500,
          discountAmount: 150,
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `${URL}/${promo.id}`,
        headers: await getAuthHeaders(superAdmin),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as AdminPromoCodeDetail;
      expect(body.code).toBe("DETAIL10");
      expect(body.maxPerTutor).toBe(2);
      expect(body.redemptionCount).toBe(1);
      expect(body.redemptions.map((r) => r.status)).toEqual(["ACTIVE", "RELEASED"]);
      expect(body.redemptions[0]?.id).toBe(active.id);
      expect(body.redemptions[0]).toMatchObject({
        feeId: fixture.fee.id,
        tutor: { id: fixture.tutor.id, name: fixture.tutor.name },
        originalAmount: "1500.00",
        discountAmount: "150.00",
        status: "ACTIVE",
        releasedAt: null,
        releaseReason: null,
      });
      expect(body.redemptions[1]).toMatchObject({
        status: "RELEASED",
        releaseReason: "Removed by tutor",
      });
    });
  });

  describe("PATCH /api/v1/admin/promo-codes/:id", () => {
    it("deactivates a code and writes an audit row with only the changed fields", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const promo = await addPromo(superAdmin.id, { code: "PATCH1", maxRedemptions: 10 });

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/${promo.id}`,
        headers: await getAuthHeaders(superAdmin),
        payload: { isActive: false },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        id: promo.id,
        isActive: false,
        maxRedemptions: 10,
      });

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "promo.update", entityId: promo.id },
      });
      expect(audit.actorAccountId).toBe(superAdmin.id);
      expect(audit.before).toEqual({ isActive: true });
      expect(audit.after).toEqual({ isActive: false });
    });

    it("clears endsAt with null and sets then clears maxRedemptions", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const headers = await getAuthHeaders(superAdmin);
      const promo = await addPromo(superAdmin.id, { code: "PATCH2", endsAt: futureDate(7) });

      const cleared = await app.inject({
        method: "PATCH",
        url: `${URL}/${promo.id}`,
        headers,
        payload: { endsAt: null, maxRedemptions: 5 },
      });
      expect(cleared.statusCode).toBe(200);
      expect(JSON.parse(cleared.body)).toMatchObject({ endsAt: null, maxRedemptions: 5 });

      const unlimited = await app.inject({
        method: "PATCH",
        url: `${URL}/${promo.id}`,
        headers,
        payload: { maxRedemptions: null, description: "Open to all" },
      });
      expect(unlimited.statusCode).toBe(200);
      expect(JSON.parse(unlimited.body)).toMatchObject({
        maxRedemptions: null,
        description: "Open to all",
      });

      const audits = await prisma.auditLog.findMany({
        where: { action: "promo.update", entityId: promo.id },
        orderBy: { id: "asc" },
      });
      expect(audits).toHaveLength(2);
      expect(audits[0]?.before).toEqual({ endsAt: expect.any(String), maxRedemptions: null });
      expect(audits[0]?.after).toEqual({ endsAt: null, maxRedemptions: 5 });
    });

    it("moves endsAt to a later future date", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const promo = await addPromo(superAdmin.id, { code: "PATCH3", endsAt: futureDate(3) });
      const later = futureDate(60).toISOString();

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/${promo.id}`,
        headers: await getAuthHeaders(superAdmin),
        payload: { endsAt: later },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).endsAt).toBe(later);
    });

    it("refuses an endsAt in the past with 400", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const promo = await addPromo(superAdmin.id, { code: "PATCH4" });

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/${promo.id}`,
        headers: await getAuthHeaders(superAdmin),
        payload: { endsAt: new Date(Date.now() - DAY_MS).toISOString() },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.issues).toContainEqual(expect.objectContaining({ path: ["endsAt"] }));
      const unchanged = await prisma.promoCode.findUniqueOrThrow({ where: { id: promo.id } });
      expect(unchanged.endsAt).toBeNull();
    });

    it("refuses an endsAt that is not after the stored startsAt with 400", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const promo = await addPromo(superAdmin.id, {
        code: "PATCH5",
        startsAt: futureDate(10),
      });

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/${promo.id}`,
        headers: await getAuthHeaders(superAdmin),
        payload: { endsAt: futureDate(5).toISOString() },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).issues).toContainEqual(
        expect.objectContaining({ path: ["endsAt"] }),
      );
    });

    it("returns 404 for an unknown id", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/${crypto.randomUUID()}`,
        headers: await getAuthHeaders(superAdmin),
        payload: { isActive: false },
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toBe("Promo code not found");
    });

    it("refuses discount terms, which are immutable, with 400", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const promo = await addPromo(superAdmin.id, { code: "PATCH6" });

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/${promo.id}`,
        headers: await getAuthHeaders(superAdmin),
        payload: { discountValue: 50 },
      });

      expect(res.statusCode).toBe(400);
    });

    it("rejects a plain admin with 403 and leaves the row alone", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const admin = await createAdmin({ status: "ACTIVE", adminRole: "ADMIN" });
      const promo = await addPromo(superAdmin.id, { code: "PATCH7" });

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/${promo.id}`,
        headers: await getAuthHeaders(admin),
        payload: { isActive: false },
      });

      expect(res.statusCode).toBe(403);
      const unchanged = await prisma.promoCode.findUniqueOrThrow({ where: { id: promo.id } });
      expect(unchanged.isActive).toBe(true);
    });
  });

  describe("database rules", () => {
    it("releases the ACTIVE redemption when its fee is voided", async () => {
      const superAdmin = await createSuperAdmin();
      const promo = await addPromo(superAdmin.id, { code: "VOIDME" });
      const fixture = await createTutorFeeFixture(1500);
      const redemption = await prisma.promoRedemption.create({
        data: {
          promoId: promo.id,
          feeId: fixture.fee.id,
          tutorId: fixture.tutor.id,
          originalAmount: 1500,
          discountAmount: 150,
        },
      });

      await prisma.platformFee.update({ where: { id: fixture.fee.id }, data: { status: "VOID" } });

      const after = await prisma.promoRedemption.findUniqueOrThrow({
        where: { id: redemption.id },
      });
      expect(after.status).toBe("RELEASED");
      expect(after.releaseReason).toBe("Fee voided");
      expect(after.releasedAt).not.toBeNull();
    });

    it("refuses a second ACTIVE redemption on the same fee", async () => {
      const superAdmin = await createSuperAdmin();
      const first = await addPromo(superAdmin.id, { code: "FIRSTONE" });
      const second = await addPromo(superAdmin.id, { code: "SECONDONE" });
      const fixture = await createTutorFeeFixture(1500);
      await prisma.promoRedemption.create({
        data: {
          promoId: first.id,
          feeId: fixture.fee.id,
          tutorId: fixture.tutor.id,
          originalAmount: 1500,
          discountAmount: 150,
        },
      });

      const attempt = prisma.promoRedemption.create({
        data: {
          promoId: second.id,
          feeId: fixture.fee.id,
          tutorId: fixture.tutor.id,
          originalAmount: 1500,
          discountAmount: 300,
        },
      });

      await expect(attempt).rejects.toThrow(/promo_redemption_one_active_per_fee/);
    });
  });
});
