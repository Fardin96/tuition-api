import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createAdmin,
  createTestApp,
  createTutorProfile,
  createTutorZone,
  createZoneLimitRequest,
  getAuthHeaders,
} from "../../tests/helpers.js";

const LIST_URL = "/api/v1/admin/zone-limit-requests";

async function setupTutor(zoneLimit?: number) {
  const account = await createAccount({ role: "TUTOR" });
  const tutor = await createTutorProfile(account.id);
  if (zoneLimit !== undefined) {
    await prisma.tutor.update({ where: { id: tutor.id }, data: { zoneLimit } });
  }
  return tutor;
}

describe("admin zone-limit request queue", () => {
  describe("GET /api/v1/admin/zone-limit-requests", () => {
    it("lists only PENDING requests by default", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const tutor = await setupTutor();
      const pending = await createZoneLimitRequest(tutor.id);
      await createZoneLimitRequest(tutor.id, {
        status: "APPROVED",
        decidedById: admin.id,
      });

      const res = await app.inject({
        method: "GET",
        url: LIST_URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.requests.map((r: { id: string }) => r.id)).toEqual([pending.id]);
      expect(body.nextCursor).toBeNull();
    });

    it("filters by status", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const tutor = await setupTutor();
      await createZoneLimitRequest(tutor.id);
      const approved = await createZoneLimitRequest(tutor.id, {
        status: "APPROVED",
        decidedById: admin.id,
      });

      const res = await app.inject({
        method: "GET",
        url: `${LIST_URL}?status=APPROVED`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.requests.map((r: { id: string }) => r.id)).toEqual([approved.id]);
      expect(body.requests[0].status).toBe("APPROVED");
      expect(body.requests[0].decidedAt).not.toBeNull();
    });

    it("returns oldest first", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const newest = await createZoneLimitRequest((await setupTutor()).id, {
        createdAt: new Date("2026-03-03T00:00:00Z"),
      });
      const oldest = await createZoneLimitRequest((await setupTutor()).id, {
        createdAt: new Date("2026-03-01T00:00:00Z"),
      });
      const middle = await createZoneLimitRequest((await setupTutor()).id, {
        createdAt: new Date("2026-03-02T00:00:00Z"),
      });

      const res = await app.inject({
        method: "GET",
        url: LIST_URL,
        headers: await getAuthHeaders(admin),
      });

      const ids = JSON.parse(res.body).requests.map((r: { id: string }) => r.id);
      expect(ids).toEqual([oldest.id, middle.id, newest.id]);
    });

    it("paginates with limit and nextCursor", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const first = await createZoneLimitRequest((await setupTutor()).id, {
        createdAt: new Date("2026-04-01T00:00:00Z"),
      });
      const second = await createZoneLimitRequest((await setupTutor()).id, {
        createdAt: new Date("2026-04-02T00:00:00Z"),
      });
      const third = await createZoneLimitRequest((await setupTutor()).id, {
        createdAt: new Date("2026-04-03T00:00:00Z"),
      });
      const headers = await getAuthHeaders(admin);

      const page1 = await app.inject({
        method: "GET",
        url: `${LIST_URL}?limit=2`,
        headers,
      });
      expect(page1.statusCode).toBe(200);
      const body1 = JSON.parse(page1.body);
      expect(body1.requests.map((r: { id: string }) => r.id)).toEqual([first.id, second.id]);
      expect(body1.nextCursor).toEqual(expect.any(String));

      const page2 = await app.inject({
        method: "GET",
        url: `${LIST_URL}?limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
        headers,
      });
      expect(page2.statusCode).toBe(200);
      const body2 = JSON.parse(page2.body);
      expect(body2.requests.map((r: { id: string }) => r.id)).toEqual([third.id]);
      expect(body2.nextCursor).toBeNull();
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

    it("includes the tutor's zoneLimit and zonesUsed count", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const tutor = await setupTutor(8);
      await createTutorZone(tutor.id, { label: "Gulshan" });
      await createTutorZone(tutor.id, { label: "Banani" });
      const request = await createZoneLimitRequest(tutor.id, { requestedLimit: 12 });

      const res = await app.inject({
        method: "GET",
        url: LIST_URL,
        headers: await getAuthHeaders(admin),
      });

      const item = JSON.parse(res.body).requests[0];
      expect(item.id).toBe(request.id);
      expect(item.requestedLimit).toBe(12);
      expect(item.tutor).toEqual({
        id: tutor.id,
        name: tutor.name,
        zoneLimit: 8,
        zonesUsed: 2,
      });
    });

    it("sends Cache-Control private, no-store", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: LIST_URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.headers["cache-control"]).toBe("private, no-store");
    });
  });

  describe("POST /api/v1/admin/zone-limit-requests/:id/decide", () => {
    it("approve sets the tutor zoneLimit to the requested limit", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const tutor = await setupTutor();
      const request = await createZoneLimitRequest(tutor.id, { requestedLimit: 12 });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${request.id}/decide`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "APPROVE" },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("APPROVED");
      expect(body.decidedAt).toEqual(expect.any(String));
      expect(body.tutor.zoneLimit).toBe(12);

      const updatedTutor = await prisma.tutor.findUniqueOrThrow({ where: { id: tutor.id } });
      expect(updatedTutor.zoneLimit).toBe(12);
      const updatedRequest = await prisma.zoneLimitRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      expect(updatedRequest.status).toBe("APPROVED");
      expect(updatedRequest.decidedById).toBe(admin.id);
    });

    it("approve with an approvedLimit below the current limit keeps the current limit", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const tutor = await setupTutor(12);
      const request = await createZoneLimitRequest(tutor.id, { requestedLimit: 20 });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${request.id}/decide`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "APPROVE", approvedLimit: 6 },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).tutor.zoneLimit).toBe(12);
      const updatedTutor = await prisma.tutor.findUniqueOrThrow({ where: { id: tutor.id } });
      expect(updatedTutor.zoneLimit).toBe(12);
    });

    it("approve with an approvedLimit above the current limit uses approvedLimit", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const tutor = await setupTutor();
      const request = await createZoneLimitRequest(tutor.id, { requestedLimit: 10 });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${request.id}/decide`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "APPROVE", approvedLimit: 15, note: "Verified" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).tutor.zoneLimit).toBe(15);
      expect(JSON.parse(res.body).decisionNote).toBe("Verified");
    });

    it("deny leaves the zoneLimit unchanged", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const tutor = await setupTutor(7);
      const request = await createZoneLimitRequest(tutor.id, { requestedLimit: 20 });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${request.id}/decide`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "DENY", note: "Not enough evidence" },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("DENIED");
      expect(body.decisionNote).toBe("Not enough evidence");
      expect(body.tutor.zoneLimit).toBe(7);
      const updatedTutor = await prisma.tutor.findUniqueOrThrow({ where: { id: tutor.id } });
      expect(updatedTutor.zoneLimit).toBe(7);
    });

    it("deciding twice returns 409 ZONE_REQUEST_DECIDED", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const tutor = await setupTutor();
      const request = await createZoneLimitRequest(tutor.id);
      const headers = await getAuthHeaders(admin);

      const first = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${request.id}/decide`,
        headers,
        payload: { decision: "DENY" },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${request.id}/decide`,
        headers,
        payload: { decision: "APPROVE" },
      });
      expect(second.statusCode).toBe(409);
      expect(JSON.parse(second.body).code).toBe("ZONE_REQUEST_DECIDED");
    });

    it("unknown id returns 404", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${crypto.randomUUID()}/decide`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "APPROVE" },
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).code).toBe("NOT_FOUND");
    });

    it("approvedLimit with DENY returns 400", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const tutor = await setupTutor();
      const request = await createZoneLimitRequest(tutor.id);

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${request.id}/decide`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "DENY", approvedLimit: 10 },
      });

      expect(res.statusCode).toBe(400);
      const pending = await prisma.zoneLimitRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      expect(pending.status).toBe("PENDING");
    });

    it("writes an audit_log row", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const tutor = await setupTutor(6);
      const request = await createZoneLimitRequest(tutor.id, { requestedLimit: 10 });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${request.id}/decide`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "APPROVE" },
      });
      expect(res.statusCode).toBe(200);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityType: "zone_limit_request", entityId: request.id },
      });
      expect(audit.action).toBe("zone_limit_request.decide");
      expect(audit.actorAccountId).toBe(admin.id);
      expect(audit.before).toEqual({ status: "PENDING", zoneLimit: 6 });
      expect(audit.after).toEqual({ status: "APPROVED", zoneLimit: 10, approvedLimit: 10 });
    });

    it("writes a notification_log row with no personal data in the payload", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id, { name: "Secret Name" });
      const request = await createZoneLimitRequest(tutor.id, { requestedLimit: 9 });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${request.id}/decide`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "APPROVE" },
      });
      expect(res.statusCode).toBe(200);

      const notification = await prisma.notificationLog.findUniqueOrThrow({
        where: { dedupeKey: `zone_limit_decided:${request.id}` },
      });
      expect(notification.eventType).toBe("ZONE_LIMIT_DECIDED");
      expect(notification.recipientId).toBe(account.id);
      expect(notification.templateName).toBe("zone_limit_decided");
      expect(notification.payload).toEqual({ decision: "APPROVED", zoneLimit: 9 });
      expect(JSON.stringify(notification.payload)).not.toContain("Secret Name");
    });

    it("PENDING admin gets 403", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "PENDING" });
      const tutor = await setupTutor();
      const request = await createZoneLimitRequest(tutor.id);

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${request.id}/decide`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "APPROVE" },
      });

      expect(res.statusCode).toBe(403);
    });

    it("REMOVED admin gets 403 on the list", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "REMOVED" });

      const res = await app.inject({
        method: "GET",
        url: LIST_URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(403);
    });

    it("tutor token gets 403", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await setupTutor();
      const request = await createZoneLimitRequest(tutor.id);

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${request.id}/decide`,
        headers: await getAuthHeaders(account),
        payload: { decision: "APPROVE" },
      });

      expect(res.statusCode).toBe(403);
    });

    it("no token gets 401", async () => {
      const app = await createTestApp();

      const res = await app.inject({
        method: "GET",
        url: LIST_URL,
      });

      expect(res.statusCode).toBe(401);
    });

    it("sends Cache-Control private, no-store", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const tutor = await setupTutor();
      const request = await createZoneLimitRequest(tutor.id);

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${request.id}/decide`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "DENY" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
    });
  });
});
