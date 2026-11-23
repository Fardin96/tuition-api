import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createAdmin,
  createSession,
  createTestApp,
  getAuthHeaders,
} from "../../tests/helpers.js";
import { getWidget, resetDashboardCache } from "./dashboard.service.js";
import { CATALOG, DEFAULT_WIDGETS } from "./dashboard-registry.js";
import { dhakaDate } from "./dashboard-time.js";

const LAYOUT_URL = "/api/v1/admin/dashboard/layout";
const WIDGET_URL = "/api/v1/admin/dashboard/widgets";

const SAVED = ["mau", "signups", "bottleneck"];

describe("admin dashboard", () => {
  describe("layout", () => {
    it("returns the defaults with no-store for an admin who never saved", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: LAYOUT_URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toContain("no-store");
      const body = res.json();
      expect(body.isDefault).toBe(true);
      expect(body.updatedAt).toBeNull();
      expect(body.widgets).toEqual(DEFAULT_WIDGETS);
      expect(body.catalog).toHaveLength(CATALOG.length);
    });

    it("saves an ordered list and returns it on the next GET", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const headers = await getAuthHeaders(admin);

      const put = await app.inject({
        method: "PUT",
        url: LAYOUT_URL,
        headers,
        payload: { widgets: SAVED },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json().widgets).toEqual(SAVED);
      expect(put.json().isDefault).toBe(false);

      const get = await app.inject({ method: "GET", url: LAYOUT_URL, headers });
      expect(get.json().widgets).toEqual(SAVED);
      expect(get.json().isDefault).toBe(false);
      expect(get.json().updatedAt).not.toBeNull();
    });

    it("keeps each admin's layout separate", async () => {
      const app = await createTestApp();
      const adminA = await createAdmin({ status: "ACTIVE" });
      const adminB = await createAdmin({ status: "ACTIVE" });
      const headersA = await getAuthHeaders(adminA);
      const headersB = await getAuthHeaders(adminB);

      await app.inject({
        method: "PUT",
        url: LAYOUT_URL,
        headers: headersA,
        payload: { widgets: SAVED },
      });

      const getB = await app.inject({ method: "GET", url: LAYOUT_URL, headers: headersB });
      expect(getB.json().isDefault).toBe(true);
      expect(getB.json().widgets).toEqual(DEFAULT_WIDGETS);

      await app.inject({
        method: "PUT",
        url: LAYOUT_URL,
        headers: headersB,
        payload: { widgets: ["mau"] },
      });

      const getA = await app.inject({ method: "GET", url: LAYOUT_URL, headers: headersA });
      expect(getA.json().widgets).toEqual(SAVED);
    });

    it("rejects invalid saves with 400", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const headers = await getAuthHeaders(admin);
      const tooMany = Array.from({ length: 25 }, (_, i) => `widget-${i}`);

      const payloads = [
        { widgets: ["mau", "mau"] },
        { widgets: ["mau", "not-a-widget"] },
        { widgets: [] },
        { widgets: tooMany },
      ];
      for (const payload of payloads) {
        const res = await app.inject({ method: "PUT", url: LAYOUT_URL, headers, payload });
        expect(res.statusCode).toBe(400);
      }
    });

    it("drops unknown and repeated ids already stored", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      await prisma.adminDashboardLayout.create({
        data: { accountId: admin.id, widgets: ["gone-widget", "mau", "mau", "signups"] },
      });

      const res = await app.inject({
        method: "GET",
        url: LAYOUT_URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.json().widgets).toEqual(["mau", "signups"]);
      expect(res.json().isDefault).toBe(false);
    });

    it("falls back to the defaults when every stored id is unknown", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      await prisma.adminDashboardLayout.create({
        data: { accountId: admin.id, widgets: ["gone-widget"] },
      });

      const res = await app.inject({
        method: "GET",
        url: LAYOUT_URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.json().isDefault).toBe(true);
      expect(res.json().widgets).toEqual(DEFAULT_WIDGETS);
    });

    it("resets to the defaults on DELETE", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const headers = await getAuthHeaders(admin);
      await app.inject({ method: "PUT", url: LAYOUT_URL, headers, payload: { widgets: SAVED } });

      const res = await app.inject({ method: "DELETE", url: LAYOUT_URL, headers });

      expect(res.statusCode).toBe(200);
      expect(res.json().isDefault).toBe(true);
      expect(res.json().widgets).toEqual(DEFAULT_WIDGETS);
      expect(await prisma.adminDashboardLayout.count({ where: { accountId: admin.id } })).toBe(0);
    });

    it("rejects students with 403, pending admins with 403, and no token with 401", async () => {
      const app = await createTestApp();
      const student = await createAccount({ role: "STUDENT" });
      const pending = await createAdmin({ status: "PENDING" });

      for (const headers of [await getAuthHeaders(student), await getAuthHeaders(pending)]) {
        const res = await app.inject({ method: "GET", url: LAYOUT_URL, headers });
        expect(res.statusCode).toBe(403);
      }

      const anon = await app.inject({ method: "GET", url: LAYOUT_URL });
      expect(anon.statusCode).toBe(401);
      const anonPut = await app.inject({
        method: "PUT",
        url: LAYOUT_URL,
        payload: { widgets: SAVED },
      });
      expect(anonPut.statusCode).toBe(401);
    });
  });

  describe("widgets", () => {
    it("returns 404 for an unknown widget id", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: `${WIDGET_URL}/not-a-widget`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(404);
    });

    it("rejects a range outside 7d, 30d, 90d, 12m and all with 400", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: `${WIDGET_URL}/mau?range=forever`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(400);
    });

    it("accepts range=all", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: `${WIDGET_URL}/mau?range=all`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
    });

    it("rejects a student with 403", async () => {
      const app = await createTestApp();
      const student = await createAccount({ role: "STUDENT" });

      const res = await app.inject({
        method: "GET",
        url: `${WIDGET_URL}/mau`,
        headers: await getAuthHeaders(student),
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe("activity trigger", () => {
    it("records one account_activity_day row per Dhaka day, however many sessions", async () => {
      const account = await createAccount({ role: "STUDENT" });
      await createSession(account.id);
      await createSession(account.id);

      const rows = await prisma.accountActivityDay.findMany({ where: { accountId: account.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].day.toISOString().slice(0, 10)).toBe(dhakaDate(new Date()));
    });

    it("uses the Dhaka day of created_at, not the UTC day", async () => {
      const account = await createAccount({ role: "STUDENT" });
      await prisma.session.create({
        data: {
          accountId: account.id,
          refreshTokenHash: `hash-${account.id}`,
          expiresAt: new Date("2027-01-01T00:00:00Z"),
          createdAt: new Date("2026-12-01T18:30:00Z"),
        },
      });

      const rows = await prisma.accountActivityDay.findMany({ where: { accountId: account.id } });
      expect(rows.map((r) => r.day.toISOString().slice(0, 10))).toEqual(["2026-12-02"]);
    });
  });

  describe("all time", () => {
    it("starts at the earliest student or tutor signup and has no previous period", async () => {
      resetDashboardCache();
      const signup = await createAccount({ role: "TUTOR" });
      await prisma.account.update({
        where: { id: signup.id },
        data: { createdAt: new Date("2025-06-10T06:00:00Z") },
      });
      const now = new Date();

      const kpi = await getWidget("signups", "all", now);
      expect(kpi.data).toMatchObject({ kind: "kpi", value: 1, previous: null });

      const trend = await getWidget("signups-trend", "all", now);
      expect(trend.data).toMatchObject({ kind: "series" });
      if (trend.data.kind !== "series") throw new Error("expected a series");
      expect(trend.data.points[0]?.date).toBe("2025-06-01");
    });
  });

  describe("widget cache", () => {
    it("rejects an unknown widget id with 404", async () => {
      resetDashboardCache();
      await expect(getWidget("nope", "30d")).rejects.toMatchObject({ statusCode: 404 });
    });

    it("serves a widget from cache for 60 seconds, then recomputes", async () => {
      resetDashboardCache();
      const now = new Date("2026-12-15T06:00:00Z");
      const first = await getWidget("signups", "30d", now);
      expect(first.data).toMatchObject({ value: 0 });

      const signup = await createAccount({ role: "STUDENT" });
      await prisma.account.update({
        where: { id: signup.id },
        data: { createdAt: new Date("2026-12-10T06:00:00Z") },
      });

      // Same instant: the cached answer, so the new sign-up does not show yet.
      const cached = await getWidget("signups", "30d", now);
      expect(cached.generatedAt).toEqual(first.generatedAt);
      expect(cached.data).toMatchObject({ value: 0 });

      const later = new Date(now.getTime() + 61_000);
      const fresh = await getWidget("signups", "30d", later);
      expect(fresh.generatedAt).toEqual(later);
      expect(fresh.data).toMatchObject({ value: 1 });
    });
  });

  describe("account deletion", () => {
    it("removes the account's activity days and dashboard layout with it", async () => {
      const account = await createAccount({ role: "STUDENT" });
      await prisma.accountActivityDay.create({
        data: { accountId: account.id, day: new Date("2026-12-14T00:00:00Z") },
      });
      await prisma.adminDashboardLayout.create({
        data: { accountId: account.id, widgets: ["mau"] },
      });

      await prisma.account.delete({ where: { id: account.id } });

      expect(await prisma.accountActivityDay.count({ where: { accountId: account.id } })).toBe(0);
      expect(await prisma.adminDashboardLayout.count({ where: { accountId: account.id } })).toBe(0);
    });
  });
});
