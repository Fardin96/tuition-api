import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createAdmin,
  createTestApp,
  createTuitionPackage,
  createTutorProfile,
  createTutorRequirement,
  createTutorZone,
  createZoneLimitRequest,
  getAuthHeaders,
} from "../../tests/helpers.js";

const BASE = "/api/v1/tutors/me";

function zoneBody(overrides: Record<string, unknown> = {}) {
  return {
    label: "Mirpur 10",
    lat: 23.8069,
    lng: 90.3687,
    radiusM: 2000,
    ...overrides,
  };
}

async function setupTutor(overrides: { zoneLimit?: number } = {}) {
  const account = await createAccount({ role: "TUTOR" });
  const tutor = await createTutorProfile(account.id);
  if (overrides.zoneLimit !== undefined) {
    await prisma.tutor.update({
      where: { id: tutor.id },
      data: { zoneLimit: overrides.zoneLimit },
    });
  }
  const headers = await getAuthHeaders(account);
  return { account, tutor, headers };
}

async function geogSourceOf(zoneId: string) {
  const [row] = await prisma.$queryRaw<{ source: string }[]>`
    SELECT geog_source::text AS source FROM tutor_zone WHERE id = ${zoneId}::uuid
  `;
  return row?.source;
}

describe("zone routes", () => {
  describe("POST /zones and GET /zones", () => {
    it("creates a zone and lists it back with every field", async () => {
      const app = await createTestApp();
      const { headers } = await setupTutor();

      const created = await app.inject({
        method: "POST",
        url: `${BASE}/zones`,
        headers,
        payload: zoneBody({ placeId: "place-mirpur-10", addressText: "Mirpur 10, Dhaka" }),
      });

      expect(created.statusCode).toBe(201);
      const zone = JSON.parse(created.body);
      expect(zone).toMatchObject({
        label: "Mirpur 10",
        lat: 23.8069,
        lng: 90.3687,
        radiusM: 2000,
        placeId: "place-mirpur-10",
        addressText: "Mirpur 10, Dhaka",
        requirementIds: [],
      });
      expect(new Date(zone.createdAt).toISOString()).toBe(zone.createdAt);
      expect(await geogSourceOf(zone.id)).toBe("PIN");

      const listed = await app.inject({ method: "GET", url: `${BASE}/zones`, headers });
      expect(listed.statusCode).toBe(200);
      const body = JSON.parse(listed.body);
      expect(body.limit).toBe(5);
      expect(body.used).toBe(1);
      expect(body.pendingRequest).toBeNull();
      expect(body.zones).toEqual([zone]);
    });

    it("stores placeId and addressText as labels only, with geog_source PIN", async () => {
      const app = await createTestApp();
      const { headers } = await setupTutor();

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/zones`,
        headers,
        payload: zoneBody({ placeId: "place-x", addressText: "Somewhere" }),
      });

      expect(res.statusCode).toBe(201);
      expect(await geogSourceOf(JSON.parse(res.body).id)).toBe("PIN");
    });

    it("lists zones oldest first and includes linked requirementIds", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      const older = await createTutorZone(tutor.id, { label: "Older" });
      const newer = await createTutorZone(tutor.id, { label: "Newer" });
      await prisma.tutorZone.update({
        where: { id: older },
        data: { createdAt: new Date("2026-01-01T00:00:00Z") },
      });
      await prisma.tutorZone.update({
        where: { id: newer },
        data: { createdAt: new Date("2026-02-01T00:00:00Z") },
      });
      const requirement = await createTutorRequirement(tutor.id, { zoneIds: [newer] });

      const res = await app.inject({ method: "GET", url: `${BASE}/zones`, headers });

      const zones = JSON.parse(res.body).zones;
      expect(zones.map((z: { id: string }) => z.id)).toEqual([older, newer]);
      expect(zones[0].requirementIds).toEqual([]);
      expect(zones[1].requirementIds).toEqual([requirement.id]);
    });

    it("lists the OPEN package ids per zone, ascending, and leaves out CLOSED packages", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      const zoneA = await createTutorZone(tutor.id, { label: "A" });
      const zoneB = await createTutorZone(tutor.id, { label: "B", lat: 23.7 });
      const first = await createTuitionPackage(tutor.id, { zoneIds: [zoneA] });
      const second = await createTuitionPackage(tutor.id, { zoneIds: [zoneA] });
      await createTuitionPackage(tutor.id, { zoneIds: [zoneA], status: "CLOSED" });

      const res = await app.inject({ method: "GET", url: `${BASE}/zones`, headers });

      const zones: { id: string; packageIds: string[] }[] = JSON.parse(res.body).zones;
      const byId = Object.fromEntries(zones.map((z) => [z.id, z]));
      expect(byId[zoneA].packageIds).toEqual([first.id, second.id].sort());
      expect(byId[zoneB].packageIds).toEqual([]);
    });

    it("rejects a radius below 1000 m", async () => {
      const app = await createTestApp();
      const { headers } = await setupTutor();

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/zones`,
        headers,
        payload: zoneBody({ radiusM: 999 }),
      });

      expect(res.statusCode).toBe(400);
    });

    it("rejects a radius above 5000 m", async () => {
      const app = await createTestApp();
      const { headers } = await setupTutor();

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/zones`,
        headers,
        payload: zoneBody({ radiusM: 5001 }),
      });

      expect(res.statusCode).toBe(400);
    });

    it("rejects a centre outside Bangladesh", async () => {
      const app = await createTestApp();
      const { headers } = await setupTutor();

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/zones`,
        headers,
        payload: zoneBody({ lat: 30.0 }),
      });

      expect(res.statusCode).toBe(400);
    });

    it("returns 409 ZONE_LIMIT_REACHED at the sixth zone, and succeeds after the limit is raised", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      for (let i = 0; i < 5; i++) {
        await createTutorZone(tutor.id, { label: `Zone ${i}`, lat: 23.7 + i * 0.01 });
      }

      const blocked = await app.inject({
        method: "POST",
        url: `${BASE}/zones`,
        headers,
        payload: zoneBody(),
      });

      expect(blocked.statusCode).toBe(409);
      const error = JSON.parse(blocked.body);
      expect(error.code).toBe("ZONE_LIMIT_REACHED");
      expect(error.message).toBe("You can have at most 5 zones");

      await prisma.tutor.update({ where: { id: tutor.id }, data: { zoneLimit: 6 } });

      const allowed = await app.inject({
        method: "POST",
        url: `${BASE}/zones`,
        headers,
        payload: zoneBody(),
      });
      expect(allowed.statusCode).toBe(201);
    });

    it("returns 429 on the 21st create within a minute", async () => {
      const app = await createTestApp();
      const { headers } = await setupTutor({ zoneLimit: 50 });

      for (let i = 0; i < 20; i++) {
        const res = await app.inject({
          method: "POST",
          url: `${BASE}/zones`,
          headers,
          payload: zoneBody({ label: `Zone ${i}` }),
        });
        expect(res.statusCode).toBe(201);
      }

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/zones`,
        headers,
        payload: zoneBody({ label: "Zone 21" }),
      });

      expect(res.statusCode).toBe(429);
      expect(JSON.parse(res.body).message).toBe("Too many requests. Try again in a minute.");
    });
  });

  describe("PATCH /zones/:id", () => {
    it("updates label, centre and radius", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      const zoneId = await createTutorZone(tutor.id, { label: "Old" });

      const res = await app.inject({
        method: "PATCH",
        url: `${BASE}/zones/${zoneId}`,
        headers,
        payload: { label: "New label", lat: 23.75, lng: 90.39, radiusM: 3500 },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        id: zoneId,
        label: "New label",
        lat: 23.75,
        lng: 90.39,
        radiusM: 3500,
      });
    });

    it("clears addressText when sent as null", async () => {
      const app = await createTestApp();
      const { headers } = await setupTutor();
      const created = await app.inject({
        method: "POST",
        url: `${BASE}/zones`,
        headers,
        payload: zoneBody({ addressText: "Mirpur 10" }),
      });
      const zoneId = JSON.parse(created.body).id;

      const res = await app.inject({
        method: "PATCH",
        url: `${BASE}/zones/${zoneId}`,
        headers,
        payload: { addressText: null },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).addressText).toBeNull();
    });

    it("rejects lat without lng", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      const zoneId = await createTutorZone(tutor.id);

      const res = await app.inject({
        method: "PATCH",
        url: `${BASE}/zones/${zoneId}`,
        headers,
        payload: { lat: 23.75 },
      });

      expect(res.statusCode).toBe(400);
    });

    it("returns 404 for another tutor's zone", async () => {
      const app = await createTestApp();
      const { headers } = await setupTutor();
      const other = await setupTutor();
      const otherZoneId = await createTutorZone(other.tutor.id);

      const res = await app.inject({
        method: "PATCH",
        url: `${BASE}/zones/${otherZoneId}`,
        headers,
        payload: { label: "Hijack" },
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toBe("Zone not found");
    });
  });

  describe("DELETE /zones/:id", () => {
    it("removes the zone and its requirement links, and reports remaining zone counts", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      const shared = await createTutorZone(tutor.id, { label: "Shared" });
      const kept = await createTutorZone(tutor.id, { label: "Kept", lat: 23.7 });
      const sets = [
        await createTutorRequirement(tutor.id, { name: "Both", zoneIds: [shared, kept] }),
        await createTutorRequirement(tutor.id, { name: "Only shared", zoneIds: [shared] }),
      ];

      const res = await app.inject({
        method: "DELETE",
        url: `${BASE}/zones/${shared}`,
        headers,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(shared);
      expect(body.affectedRequirements).toHaveLength(2);
      const byName = Object.fromEntries(
        body.affectedRequirements.map((r: { name: string }) => [r.name, r]),
      );
      expect(byName.Both).toMatchObject({
        id: sets[0].id,
        isDefault: false,
        isActive: true,
        teachesOnline: true,
        remainingZoneCount: 1,
      });
      expect(byName["Only shared"]).toMatchObject({
        id: sets[1].id,
        remainingZoneCount: 0,
      });

      const links = await prisma.tutorRequirementZone.count({ where: { zoneId: shared } });
      expect(links).toBe(0);
      const zoneGone = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM tutor_zone WHERE id = ${shared}::uuid
      `;
      expect(zoneGone).toHaveLength(0);
    });

    it("reports the OPEN packages that used the zone, with the zones each has left", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      const shared = await createTutorZone(tutor.id, { label: "Shared" });
      const kept = await createTutorZone(tutor.id, { label: "Kept", lat: 23.7 });
      const both = await createTuitionPackage(tutor.id, {
        title: "Both zones",
        zoneIds: [shared, kept],
      });
      const onlyShared = await createTuitionPackage(tutor.id, {
        title: "Only shared",
        zoneIds: [shared],
        teachesOnline: false,
      });
      const onlineShared = await createTuitionPackage(tutor.id, {
        title: "Online too",
        zoneIds: [shared],
        teachesOnline: true,
      });
      await createTuitionPackage(tutor.id, {
        title: "Closed",
        zoneIds: [shared],
        status: "CLOSED",
      });

      const res = await app.inject({
        method: "DELETE",
        url: `${BASE}/zones/${shared}`,
        headers,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.affectedPackages).toHaveLength(3);
      const byId = Object.fromEntries(body.affectedPackages.map((p: { id: string }) => [p.id, p]));
      expect(byId[both.id]).toEqual({
        id: both.id,
        title: "Both zones",
        teachesOnline: false,
        remainingZoneCount: 1,
      });
      expect(byId[onlyShared.id]).toEqual({
        id: onlyShared.id,
        title: "Only shared",
        teachesOnline: false,
        remainingZoneCount: 0,
      });
      expect(byId[onlineShared.id]).toMatchObject({
        title: "Online too",
        teachesOnline: true,
        remainingZoneCount: 0,
      });

      // The package stays OPEN; only its zone link is gone.
      const pkg = await prisma.tuitionPackage.findUniqueOrThrow({ where: { id: onlyShared.id } });
      expect(pkg.status).toBe("OPEN");
      expect(await prisma.packageZone.count({ where: { packageId: onlyShared.id } })).toBe(0);
    });

    it("returns 404 for another tutor's zone", async () => {
      const app = await createTestApp();
      const { headers } = await setupTutor();
      const other = await setupTutor();
      const otherZoneId = await createTutorZone(other.tutor.id);

      const res = await app.inject({
        method: "DELETE",
        url: `${BASE}/zones/${otherZoneId}`,
        headers,
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toBe("Zone not found");
    });
  });

  describe("access control", () => {
    it("returns 403 for a student", async () => {
      const app = await createTestApp();
      const student = await createAccount({ role: "STUDENT" });

      const res = await app.inject({
        method: "GET",
        url: `${BASE}/zones`,
        headers: await getAuthHeaders(student),
      });

      expect(res.statusCode).toBe(403);
    });

    it("returns 401 without auth", async () => {
      const app = await createTestApp();

      const res = await app.inject({ method: "GET", url: `${BASE}/zones` });

      expect(res.statusCode).toBe(401);
    });

    it("returns 404 for a tutor account without a profile", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });

      const res = await app.inject({
        method: "GET",
        url: `${BASE}/zones`,
        headers: await getAuthHeaders(account),
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toBe("Tutor profile not found");
    });

    it("sends Cache-Control private, no-store on success", async () => {
      const app = await createTestApp();
      const { headers } = await setupTutor();

      const res = await app.inject({ method: "GET", url: `${BASE}/zones`, headers });

      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
    });
  });

  describe("POST /zone-limit-requests and GET /zone-limit-requests", () => {
    it("creates a request, then rejects a second while one is pending", async () => {
      const app = await createTestApp();
      const { headers } = await setupTutor();
      const payload = {
        requestedLimit: 10,
        reason: "I teach across several neighbourhoods",
      };

      const first = await app.inject({
        method: "POST",
        url: `${BASE}/zone-limit-requests`,
        headers,
        payload,
      });
      expect(first.statusCode).toBe(201);
      expect(JSON.parse(first.body)).toMatchObject({
        requestedLimit: 10,
        status: "PENDING",
        decisionNote: null,
        decidedAt: null,
      });

      const second = await app.inject({
        method: "POST",
        url: `${BASE}/zone-limit-requests`,
        headers,
        payload,
      });
      expect(second.statusCode).toBe(409);
      expect(JSON.parse(second.body).code).toBe("ZONE_REQUEST_PENDING");
    });

    it("rejects a requested limit that does not exceed the current limit", async () => {
      const app = await createTestApp();
      const { headers } = await setupTutor({ zoneLimit: 6 });

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/zone-limit-requests`,
        headers,
        payload: { requestedLimit: 6, reason: "I teach across several neighbourhoods" },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toBe("Ask for more than your current limit of 6 zones");
    });

    it("returns 429 for a fourth request within 24 hours", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      // Only a FK target here; PENDING avoids the ACTIVE-admin approval and SUPER_ADMIN allowlist checks.
      const admin = await createAdmin({ status: "PENDING" });
      for (let i = 0; i < 3; i++) {
        await createZoneLimitRequest(tutor.id, {
          status: "DENIED",
          decidedById: admin.id,
          createdAt: new Date(Date.now() - (i + 1) * 60 * 1000),
        });
      }

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/zone-limit-requests`,
        headers,
        payload: { requestedLimit: 10, reason: "I teach across several neighbourhoods" },
      });

      expect(res.statusCode).toBe(429);
      expect(JSON.parse(res.body).message).toBe("Daily limit reached. Try again tomorrow.");
    });

    it("pages through requests newest first with limit and nextCursor", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      // Only a FK target here; PENDING avoids the ACTIVE-admin approval and SUPER_ADMIN allowlist checks.
      const admin = await createAdmin({ status: "PENDING" });
      const now = Date.now();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const row = await createZoneLimitRequest(tutor.id, {
          status: "APPROVED",
          decidedById: admin.id,
          requestedLimit: 10 + i,
          createdAt: new Date(now - (3 - i) * 60 * 1000),
        });
        ids.push(row.id);
      }
      const newestFirst = [...ids].reverse();

      const page1 = await app.inject({
        method: "GET",
        url: `${BASE}/zone-limit-requests?limit=2`,
        headers,
      });
      expect(page1.statusCode).toBe(200);
      const body1 = JSON.parse(page1.body);
      expect(body1.requests.map((r: { id: string }) => r.id)).toEqual(newestFirst.slice(0, 2));
      expect(body1.nextCursor).not.toBeNull();

      const page2 = await app.inject({
        method: "GET",
        url: `${BASE}/zone-limit-requests?limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
        headers,
      });
      expect(page2.statusCode).toBe(200);
      const body2 = JSON.parse(page2.body);
      expect(body2.requests.map((r: { id: string }) => r.id)).toEqual(newestFirst.slice(2));
      expect(body2.nextCursor).toBeNull();
    });

    it("returns the pending request in GET /zones", async () => {
      const app = await createTestApp();
      const { headers } = await setupTutor();
      const created = await app.inject({
        method: "POST",
        url: `${BASE}/zone-limit-requests`,
        headers,
        payload: { requestedLimit: 10, reason: "I teach across several neighbourhoods" },
      });
      const request = JSON.parse(created.body);

      const res = await app.inject({ method: "GET", url: `${BASE}/zones`, headers });

      expect(JSON.parse(res.body).pendingRequest).toEqual(request);
    });
  });
});
