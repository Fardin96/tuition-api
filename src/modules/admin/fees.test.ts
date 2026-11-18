import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createAdmin,
  createApplication,
  createArea,
  createPlatformFee,
  createRequirement,
  createStudentProfile,
  createTestApp,
  createTutorProfile,
  getAuthHeaders,
} from "../../tests/helpers.js";

const FEES_URL = "/api/v1/admin/fees";
const PAYMENTS_URL = "/api/v1/admin/payments";
const DAY_MS = 24 * 60 * 60 * 1000;

// A confirmed requirement application with a student and a tutor.
async function setupApplication(
  opts: { status?: "PENDING" | "CONFIRMED" | "COMPLETED"; confirmedAt?: Date } = {},
) {
  const area = await createArea();
  const student = await createStudentProfile(
    (await createAccount({ role: "STUDENT" })).id,
    area.id,
  );
  const tutor = await createTutorProfile((await createAccount({ role: "TUTOR" })).id);
  const requirement = await createRequirement({ studentId: student.id });
  const application = await createApplication({
    requirementId: requirement.id,
    tutorId: tutor.id,
    studentId: student.id,
    initiatedBy: "TUTOR",
    status: opts.status ?? "CONFIRMED",
    confirmedAt: opts.confirmedAt,
  });
  return { student, tutor, application };
}

// An OTHER fee by default, so several fees can share one application.
async function makeFee(
  setup: { tutor: { id: string }; application: { id: string } },
  overrides: {
    feeType?: "PLACEMENT" | "RECURRING" | "OTHER";
    status?: "DUE" | "WAIVED" | "VOID";
    dueDate?: Date;
    createdAt?: Date;
  } = {},
) {
  const fee = await createPlatformFee({
    tutorId: setup.tutor.id,
    applicationId: setup.application.id,
    feeType: overrides.feeType ?? "OTHER",
    status: overrides.status,
    dueDate: overrides.dueDate,
  });
  if (overrides.createdAt) {
    await prisma.platformFee.update({
      where: { id: fee.id },
      data: { createdAt: overrides.createdAt },
    });
  }
  return fee;
}

async function pay(
  app: Awaited<ReturnType<typeof createTestApp>>,
  headers: Record<string, string>,
  feeId: string,
  amount: number,
  extra: { txnReference?: string; receivedAt?: string } = {},
) {
  return app.inject({
    method: "POST",
    url: `${FEES_URL}/${feeId}/payments`,
    headers,
    payload: { amount, ...extra },
  });
}

describe("admin fees", () => {
  describe("POST /api/v1/admin/fees", () => {
    it("adds a fee to a confirmed application, with the tutor from the application", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const setup = await setupApplication();

      const res = await app.inject({
        method: "POST",
        url: FEES_URL,
        headers: await getAuthHeaders(admin),
        payload: {
          applicationId: setup.application.id,
          amountDue: 1500,
          dueDate: "2031-01-15",
          note: "  Month one  ",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.feeType).toBe("OTHER");
      expect(body.status).toBe("DUE");
      expect(body.amountDue).toBe("1500.00");
      expect(body.amountPaid).toBe("0.00");
      expect(body.remaining).toBe("1500.00");
      expect(body.dueDate).toBe("2031-01-15");
      expect(body.note).toBe("Month one");
      expect(body.overdue).toBe(false);
      expect(body.tutor).toEqual({ id: setup.tutor.id, name: setup.tutor.name });
      expect(body.student).toEqual({ id: setup.student.id, name: setup.student.name });
      expect(body.application).toMatchObject({
        id: setup.application.id,
        status: "CONFIRMED",
        kind: "REQUIREMENT",
        packageTitle: null,
      });
      expect(body.payments).toEqual([]);
    });

    it("writes an audit_log row fee.create", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const setup = await setupApplication();

      const res = await app.inject({
        method: "POST",
        url: FEES_URL,
        headers: await getAuthHeaders(admin),
        payload: { applicationId: setup.application.id, amountDue: 800.5, dueDate: "2031-02-01" },
      });
      expect(res.statusCode).toBe(201);
      const feeId = JSON.parse(res.body).id;

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityType: "platform_fee", entityId: feeId, action: "fee.create" },
      });
      expect(audit.actorAccountId).toBe(admin.id);
      expect(audit.after).toEqual({ feeType: "OTHER", amountDue: "800.50", dueDate: "2031-02-01" });
    });

    it("accepts a COMPLETED application", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const setup = await setupApplication({ status: "COMPLETED", confirmedAt: new Date() });

      const res = await app.inject({
        method: "POST",
        url: FEES_URL,
        headers: await getAuthHeaders(admin),
        payload: { applicationId: setup.application.id, amountDue: 100, dueDate: "2031-03-01" },
      });

      expect(res.statusCode).toBe(201);
    });

    it("refuses a PENDING application with 409 INVALID_FEE_STATE", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const setup = await setupApplication({ status: "PENDING" });

      const res = await app.inject({
        method: "POST",
        url: FEES_URL,
        headers: await getAuthHeaders(admin),
        payload: { applicationId: setup.application.id, amountDue: 100, dueDate: "2031-03-01" },
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("INVALID_FEE_STATE");
      expect(body.message).toBe("Fees can only be added to confirmed or completed applications");
    });

    it("unknown application returns 404", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "POST",
        url: FEES_URL,
        headers: await getAuthHeaders(admin),
        payload: {
          applicationId: crypto.randomUUID(),
          amountDue: 100,
          dueDate: "2031-03-01",
        },
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toBe("Application not found");
    });

    it("refuses a second PLACEMENT fee while one is not VOID", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const setup = await setupApplication();
      await createPlatformFee({
        tutorId: setup.tutor.id,
        applicationId: setup.application.id,
        feeType: "PLACEMENT",
      });

      const res = await app.inject({
        method: "POST",
        url: FEES_URL,
        headers: await getAuthHeaders(admin),
        payload: {
          applicationId: setup.application.id,
          feeType: "PLACEMENT",
          amountDue: 1500,
          dueDate: "2031-01-15",
        },
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("INVALID_FEE_STATE");
      expect(body.message).toBe("This application already has a placement fee");
    });

    it("allows a PLACEMENT fee once the earlier one is VOID", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const setup = await setupApplication();
      await createPlatformFee({
        tutorId: setup.tutor.id,
        applicationId: setup.application.id,
        feeType: "PLACEMENT",
        status: "VOID",
      });

      const res = await app.inject({
        method: "POST",
        url: FEES_URL,
        headers: await getAuthHeaders(admin),
        payload: {
          applicationId: setup.application.id,
          feeType: "PLACEMENT",
          amountDue: 1500,
          dueDate: "2031-01-15",
        },
      });

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).feeType).toBe("PLACEMENT");
    });

    it("rejects invalid input with 400", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const setup = await setupApplication();
      const headers = await getAuthHeaders(admin);
      const base = { applicationId: setup.application.id, dueDate: "2031-01-15" };

      const cases = [
        { ...base, amountDue: 0 },
        { ...base, amountDue: -5 },
        { ...base, amountDue: 5_000_001 },
        { ...base, amountDue: 10.005 },
        { ...base, amountDue: 100, dueDate: "2031-02-30" },
        { ...base, amountDue: 100, dueDate: "15/01/2031" },
        { ...base, amountDue: 100, note: "   " },
      ];
      for (const payload of cases) {
        const res = await app.inject({ method: "POST", url: FEES_URL, headers, payload });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
      }
    });

    it("sends Cache-Control private, no-store", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const setup = await setupApplication();

      const res = await app.inject({
        method: "POST",
        url: FEES_URL,
        headers: await getAuthHeaders(admin),
        payload: { applicationId: setup.application.id, amountDue: 100, dueDate: "2031-03-01" },
      });

      expect(res.statusCode).toBe(201);
      expect(res.headers["cache-control"]).toBe("private, no-store");
    });
  });

  describe("GET /api/v1/admin/fees", () => {
    it("lists newest first and paginates with nextCursor", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const setup = await setupApplication();
      const oldest = await makeFee(setup, { createdAt: new Date("2026-04-01T00:00:00Z") });
      const middle = await makeFee(setup, { createdAt: new Date("2026-04-02T00:00:00Z") });
      const newest = await makeFee(setup, { createdAt: new Date("2026-04-03T00:00:00Z") });
      const headers = await getAuthHeaders(admin);

      const page1 = await app.inject({ method: "GET", url: `${FEES_URL}?limit=2`, headers });
      expect(page1.statusCode).toBe(200);
      const body1 = JSON.parse(page1.body);
      expect(body1.fees.map((f: { id: string }) => f.id)).toEqual([newest.id, middle.id]);
      expect(body1.nextCursor).toEqual(expect.any(String));

      const page2 = await app.inject({
        method: "GET",
        url: `${FEES_URL}?limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
        headers,
      });
      expect(page2.statusCode).toBe(200);
      const body2 = JSON.parse(page2.body);
      expect(body2.fees.map((f: { id: string }) => f.id)).toEqual([oldest.id]);
      expect(body2.nextCursor).toBeNull();
    });

    it("filters by status and tutorId", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const setup = await setupApplication();
      const other = await setupApplication();
      const due = await makeFee(setup);
      await makeFee(setup, { status: "WAIVED" });
      const otherDue = await makeFee(other);
      const headers = await getAuthHeaders(admin);

      const byStatus = await app.inject({
        method: "GET",
        url: `${FEES_URL}?status=WAIVED`,
        headers,
      });
      expect(JSON.parse(byStatus.body).fees.map((f: { status: string }) => f.status)).toEqual([
        "WAIVED",
      ]);

      const byTutor = await app.inject({
        method: "GET",
        url: `${FEES_URL}?tutorId=${setup.tutor.id}`,
        headers,
      });
      const tutorFees = JSON.parse(byTutor.body).fees.map((f: { id: string }) => f.id);
      expect(tutorFees).toHaveLength(2);
      expect(tutorFees).toContain(due.id);
      expect(tutorFees).not.toContain(otherDue.id);
    });

    it("overdue=true returns open fees whose due date is before today; overdue=false the rest", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const setup = await setupApplication();
      const pastDue = await makeFee(setup, { dueDate: new Date("2020-01-01T00:00:00Z") });
      const waivedPastDue = await makeFee(setup, {
        dueDate: new Date("2020-01-01T00:00:00Z"),
        status: "WAIVED",
      });
      const future = await makeFee(setup, { dueDate: new Date("2099-01-01T00:00:00Z") });
      const headers = await getAuthHeaders(admin);

      const overdue = await app.inject({
        method: "GET",
        url: `${FEES_URL}?overdue=true`,
        headers,
      });
      expect(overdue.statusCode).toBe(200);
      const overdueBody = JSON.parse(overdue.body);
      expect(overdueBody.fees.map((f: { id: string }) => f.id)).toEqual([pastDue.id]);
      expect(overdueBody.fees[0].overdue).toBe(true);

      const notOverdue = await app.inject({
        method: "GET",
        url: `${FEES_URL}?overdue=false`,
        headers,
      });
      const notOverdueBody = JSON.parse(notOverdue.body);
      expect(notOverdueBody.fees.map((f: { id: string }) => f.id).sort()).toEqual(
        [future.id, waivedPastDue.id].sort(),
      );
      expect(notOverdueBody.fees.every((f: { overdue: boolean }) => !f.overdue)).toBe(true);
    });

    it("sets unpaid when an open fee is more than 21 days past confirmation", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const old = await setupApplication({
        confirmedAt: new Date(Date.now() - 30 * DAY_MS),
      });
      const recent = await setupApplication({ confirmedAt: new Date() });
      const oldFee = await makeFee(old, { dueDate: new Date("2099-01-01T00:00:00Z") });
      const recentFee = await makeFee(recent, { dueDate: new Date("2099-01-01T00:00:00Z") });

      const res = await app.inject({
        method: "GET",
        url: FEES_URL,
        headers: await getAuthHeaders(admin),
      });
      const fees: { id: string; unpaid: boolean }[] = JSON.parse(res.body).fees;
      expect(fees.find((f) => f.id === oldFee.id)?.unpaid).toBe(true);
      expect(fees.find((f) => f.id === recentFee.id)?.unpaid).toBe(false);
    });

    it("rejects an invalid cursor with 400", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: `${FEES_URL}?cursor=not-a-cursor`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
    });
  });

  describe("GET /api/v1/admin/fees/:id", () => {
    it("returns the fee with its ledger, reversedAmount and the recording admin", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const setup = await setupApplication();
      const fee = await makeFee(setup, { dueDate: new Date("2031-01-15T00:00:00Z") });
      const headers = await getAuthHeaders(admin);

      const paid = await pay(app, headers, fee.id, 500, { txnReference: "TRX-DETAIL" });
      const paymentId = JSON.parse(paid.body).payments[0].id;
      await app.inject({
        method: "POST",
        url: `${PAYMENTS_URL}/${paymentId}/reverse`,
        headers,
        payload: { reason: "Keyed in twice", amount: 200 },
      });

      const res = await app.inject({ method: "GET", url: `${FEES_URL}/${fee.id}`, headers });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("PARTIAL");
      expect(body.amountPaid).toBe("300.00");
      expect(body.payments).toHaveLength(2);
      const [payment, reversal] = body.payments;
      expect(payment).toMatchObject({
        id: paymentId,
        kind: "PAYMENT",
        amount: "500.00",
        method: "CASH",
        txnReference: "TRX-DETAIL",
        recordedByName: "Test Admin",
        reversesPaymentId: null,
        reversedAmount: "200.00",
      });
      expect(reversal).toMatchObject({
        kind: "REVERSAL",
        amount: "200.00",
        reason: "Keyed in twice",
        reversesPaymentId: paymentId,
        reversedAmount: "0.00",
      });
    });

    it("shows a null recordedByName for an SSLCOMMERZ payment with no admin recorder", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const setup = await setupApplication();
      const fee = await makeFee(setup);
      await prisma.feePayment.create({
        data: {
          feeId: fee.id,
          amount: 500,
          method: "SSLCOMMERZ",
          txnReference: "TMTEST1",
          receivedAt: new Date(),
          recordedById: null,
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `${FEES_URL}/${fee.id}`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      const [payment] = JSON.parse(res.body).payments;
      expect(payment).toMatchObject({
        method: "SSLCOMMERZ",
        txnReference: "TMTEST1",
        recordedByName: null,
      });
    });

    it("lists the online attempts of the fee, newest first, with money as strings", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const setup = await setupApplication();
      const fee = await makeFee(setup);
      await prisma.paymentAttempt.create({
        data: {
          feeId: fee.id,
          tutorId: setup.tutor.id,
          tranId: "TATTEMPTOLD",
          status: "FAILED",
          feeAmount: 1500,
          chargeAmount: 37.5,
          totalAmount: 1537.5,
          failureReason: "Gateway status FAILED",
          createdAt: new Date("2031-01-01T00:00:00Z"),
        },
      });
      await prisma.paymentAttempt.create({
        data: {
          feeId: fee.id,
          tutorId: setup.tutor.id,
          tranId: "TATTEMPTNEW",
          status: "PENDING",
          feeAmount: 1500,
          chargeAmount: 37.5,
          totalAmount: 1537.5,
          createdAt: new Date("2031-01-02T00:00:00Z"),
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `${FEES_URL}/${fee.id}`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).attempts).toEqual([
        {
          tranId: "TATTEMPTNEW",
          status: "PENDING",
          totalAmount: "1537.50",
          failureReason: null,
          createdAt: "2031-01-02T00:00:00.000Z",
          settledAt: null,
        },
        {
          tranId: "TATTEMPTOLD",
          status: "FAILED",
          totalAmount: "1537.50",
          failureReason: "Gateway status FAILED",
          createdAt: "2031-01-01T00:00:00.000Z",
          settledAt: null,
        },
      ]);
    });

    it("shows the promo code applied to the fee, or null when there is none", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const setup = await setupApplication();
      const fee = await makeFee(setup, { dueDate: new Date("2031-01-15T00:00:00Z") });
      const headers = await getAuthHeaders(admin);

      const before = await app.inject({ method: "GET", url: `${FEES_URL}/${fee.id}`, headers });
      expect(JSON.parse(before.body).promo).toBeNull();

      const tutorAccount = await prisma.account.findUniqueOrThrow({
        where: { id: setup.tutor.accountId },
      });
      await prisma.promoCode.create({
        data: {
          code: "ADMINSEE",
          discountType: "FLAT",
          discountValue: 300,
          createdById: admin.id,
        },
      });
      const applied = await app.inject({
        method: "POST",
        url: `/api/v1/fees/${fee.id}/promo`,
        headers: await getAuthHeaders(tutorAccount),
        payload: { code: "ADMINSEE" },
      });
      expect(applied.statusCode).toBe(200);

      const res = await app.inject({ method: "GET", url: `${FEES_URL}/${fee.id}`, headers });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        amountDue: "1200.00",
        promo: { code: "ADMINSEE", discountAmount: "300.00", originalAmount: "1500.00" },
      });
    });

    it("unknown id returns 404", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: `${FEES_URL}/${crypto.randomUUID()}`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).code).toBe("NOT_FOUND");
    });
  });

  describe("PATCH /api/v1/admin/fees/:id", () => {
    it("waives a DUE fee and writes fee.update with before and after", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fee = await makeFee(await setupApplication());

      const res = await app.inject({
        method: "PATCH",
        url: `${FEES_URL}/${fee.id}`,
        headers: await getAuthHeaders(admin),
        payload: { status: "WAIVED" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).status).toBe("WAIVED");
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityType: "platform_fee", entityId: fee.id, action: "fee.update" },
      });
      expect(audit.before).toEqual({ status: "DUE" });
      expect(audit.after).toEqual({ status: "WAIVED" });
    });

    it("changes dueDate and clears the note with null", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const setup = await setupApplication();
      const fee = await makeFee(setup);
      await prisma.platformFee.update({ where: { id: fee.id }, data: { note: "Old note" } });
      const headers = await getAuthHeaders(admin);

      const res = await app.inject({
        method: "PATCH",
        url: `${FEES_URL}/${fee.id}`,
        headers,
        payload: { dueDate: "2031-06-30", note: null },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.dueDate).toBe("2031-06-30");
      expect(body.note).toBeNull();
      expect(body.status).toBe("DUE");
    });

    it("refuses to waive a PAID fee", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fee = await makeFee(await setupApplication(), {
        dueDate: new Date("2031-01-15T00:00:00Z"),
      });
      const headers = await getAuthHeaders(admin);
      await pay(app, headers, fee.id, 1500);

      const res = await app.inject({
        method: "PATCH",
        url: `${FEES_URL}/${fee.id}`,
        headers,
        payload: { status: "WAIVED" },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toBe("Only due or partly paid fees can be waived");
    });

    it("refuses to void a fee that has payments", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fee = await makeFee(await setupApplication());
      const headers = await getAuthHeaders(admin);
      await pay(app, headers, fee.id, 100);

      const res = await app.inject({
        method: "PATCH",
        url: `${FEES_URL}/${fee.id}`,
        headers,
        payload: { status: "VOID" },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toBe("Reverse the payments before voiding this fee");
    });

    it("voids an unpaid fee, after which it cannot be changed", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fee = await makeFee(await setupApplication());
      const headers = await getAuthHeaders(admin);

      const voided = await app.inject({
        method: "PATCH",
        url: `${FEES_URL}/${fee.id}`,
        headers,
        payload: { status: "VOID" },
      });
      expect(voided.statusCode).toBe(200);
      expect(JSON.parse(voided.body).status).toBe("VOID");

      const again = await app.inject({
        method: "PATCH",
        url: `${FEES_URL}/${fee.id}`,
        headers,
        payload: { note: "Changed my mind" },
      });
      expect(again.statusCode).toBe(409);
      expect(JSON.parse(again.body).message).toBe("A void fee cannot be changed");
    });

    it("an empty body returns 400", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fee = await makeFee(await setupApplication());

      const res = await app.inject({
        method: "PATCH",
        url: `${FEES_URL}/${fee.id}`,
        headers: await getAuthHeaders(admin),
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it("unknown id returns 404", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "PATCH",
        url: `${FEES_URL}/${crypto.randomUUID()}`,
        headers: await getAuthHeaders(admin),
        payload: { status: "WAIVED" },
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toBe("Fee not found");
    });
  });

  describe("POST /api/v1/admin/fees/:id/payments", () => {
    it("a partial payment makes the fee PARTIAL; paying the rest makes it PAID", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const setup = await setupApplication();
      const fee = await createPlatformFee({
        tutorId: setup.tutor.id,
        applicationId: setup.application.id,
        amountDue: 1500,
      });
      const headers = await getAuthHeaders(admin);

      const partial = await pay(app, headers, fee.id, 500);
      expect(partial.statusCode).toBe(201);
      const partialBody = JSON.parse(partial.body);
      expect(partialBody.status).toBe("PARTIAL");
      expect(partialBody.amountPaid).toBe("500.00");
      expect(partialBody.remaining).toBe("1000.00");
      expect(partialBody.payments).toHaveLength(1);
      expect(partialBody.payments[0]).toMatchObject({ kind: "PAYMENT", amount: "500.00" });

      const rest = await pay(app, headers, fee.id, 1000);
      expect(rest.statusCode).toBe(201);
      expect(JSON.parse(rest.body).status).toBe("PAID");
      expect(JSON.parse(rest.body).remaining).toBe("0.00");
    });

    it("writes an audit_log row fee.payment and stores the caller as recorder", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fee = await makeFee(await setupApplication());

      const res = await pay(app, await getAuthHeaders(admin), fee.id, 250.5, {
        receivedAt: "2026-05-01T10:00:00+06:00",
      });
      expect(res.statusCode).toBe(201);
      const paymentId = JSON.parse(res.body).payments[0].id;

      const payment = await prisma.feePayment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(payment.recordedById).toBe(admin.id);
      expect(payment.receivedAt.toISOString()).toBe("2026-05-01T04:00:00.000Z");

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityType: "platform_fee", entityId: fee.id, action: "fee.payment" },
      });
      expect(audit.after).toEqual({ amount: "250.50", paymentId });
    });

    it("refuses a payment above the amount still due with 409", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fee = await makeFee(await setupApplication());
      const headers = await getAuthHeaders(admin);
      await pay(app, headers, fee.id, 1000);

      const res = await pay(app, headers, fee.id, 500.5);

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("INVALID_FEE_STATE");
      expect(body.message).toBe("Payment is more than the ৳500.00 still due");
    });

    it("refuses payments on WAIVED fees with 409", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fee = await makeFee(await setupApplication(), { status: "WAIVED" });

      const res = await pay(app, await getAuthHeaders(admin), fee.id, 100);

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toBe("This fee does not accept payments");
    });

    it("refuses payments on PAID fees with 409", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fee = await makeFee(await setupApplication());
      const headers = await getAuthHeaders(admin);
      await pay(app, headers, fee.id, 1500);

      const res = await pay(app, headers, fee.id, 1);

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toBe("This fee does not accept payments");
    });

    it("refuses a transaction reference that is already recorded", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fee = await makeFee(await setupApplication());
      const headers = await getAuthHeaders(admin);
      const first = await pay(app, headers, fee.id, 100, { txnReference: "TRX-DUP" });
      expect(first.statusCode).toBe(201);

      const res = await pay(app, headers, fee.id, 100, { txnReference: "TRX-DUP" });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toBe("This transaction reference is already recorded");
    });

    it("rejects a receivedAt in the future with 400", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fee = await makeFee(await setupApplication());

      const res = await pay(app, await getAuthHeaders(admin), fee.id, 100, {
        receivedAt: new Date(Date.now() + DAY_MS).toISOString(),
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
    });

    it("unknown fee returns 404", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await pay(app, await getAuthHeaders(admin), crypto.randomUUID(), 100);

      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/v1/admin/payments/:id/reverse", () => {
    it("reversing the whole payment brings a PARTIAL fee back to DUE", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fee = await makeFee(await setupApplication());
      const headers = await getAuthHeaders(admin);
      const paid = await pay(app, headers, fee.id, 500);
      const paymentId = JSON.parse(paid.body).payments[0].id;

      const res = await app.inject({
        method: "POST",
        url: `${PAYMENTS_URL}/${paymentId}/reverse`,
        headers,
        payload: { reason: "Wrong student" },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("DUE");
      expect(body.amountPaid).toBe("0.00");
      expect(body.remaining).toBe("1500.00");
      const reversal = body.payments.find((p: { kind: string }) => p.kind === "REVERSAL");
      expect(reversal).toMatchObject({
        amount: "500.00",
        method: "CASH",
        reason: "Wrong student",
        reversesPaymentId: paymentId,
      });
      const original = body.payments.find((p: { id: string }) => p.id === paymentId);
      expect(original.reversedAmount).toBe("500.00");
    });

    it("a partial reversal leaves the fee PARTIAL; the rest of the payment can still be reversed", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fee = await makeFee(await setupApplication());
      const headers = await getAuthHeaders(admin);
      const paid = await pay(app, headers, fee.id, 500);
      const paymentId = JSON.parse(paid.body).payments[0].id;
      const reverseUrl = `${PAYMENTS_URL}/${paymentId}/reverse`;

      const first = await app.inject({
        method: "POST",
        url: reverseUrl,
        headers,
        payload: { reason: "Partly wrong", amount: 200 },
      });
      expect(first.statusCode).toBe(201);
      expect(JSON.parse(first.body).status).toBe("PARTIAL");
      expect(JSON.parse(first.body).amountPaid).toBe("300.00");

      const tooMuch = await app.inject({
        method: "POST",
        url: reverseUrl,
        headers,
        payload: { reason: "Too much", amount: 400 },
      });
      expect(tooMuch.statusCode).toBe(409);
      expect(JSON.parse(tooMuch.body).message).toBe(
        "That is more than is left to reverse on this payment",
      );

      const rest = await app.inject({
        method: "POST",
        url: reverseUrl,
        headers,
        payload: { reason: "The rest" },
      });
      expect(rest.statusCode).toBe(201);
      expect(JSON.parse(rest.body).status).toBe("DUE");
    });

    it("refuses to reverse a reversal with 409", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fee = await makeFee(await setupApplication());
      const headers = await getAuthHeaders(admin);
      const paid = await pay(app, headers, fee.id, 500);
      const paymentId = JSON.parse(paid.body).payments[0].id;
      const reversed = await app.inject({
        method: "POST",
        url: `${PAYMENTS_URL}/${paymentId}/reverse`,
        headers,
        payload: { reason: "Wrong student" },
      });
      const reversalId = JSON.parse(reversed.body).payments.find(
        (p: { kind: string }) => p.kind === "REVERSAL",
      ).id;

      const res = await app.inject({
        method: "POST",
        url: `${PAYMENTS_URL}/${reversalId}/reverse`,
        headers,
        payload: { reason: "Undo the undo" },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toBe("A reversal cannot be reversed");
    });

    it("refuses to reverse on a WAIVED fee with 409", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fee = await makeFee(await setupApplication());
      const headers = await getAuthHeaders(admin);
      const paid = await pay(app, headers, fee.id, 500);
      const paymentId = JSON.parse(paid.body).payments[0].id;
      await app.inject({
        method: "PATCH",
        url: `${FEES_URL}/${fee.id}`,
        headers,
        payload: { status: "WAIVED" },
      });

      const res = await app.inject({
        method: "POST",
        url: `${PAYMENTS_URL}/${paymentId}/reverse`,
        headers,
        payload: { reason: "Wrong student" },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toBe(
        "Payments on a waived or void fee cannot be reversed",
      );
    });

    it("writes an audit_log row payment.reverse", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fee = await makeFee(await setupApplication());
      const headers = await getAuthHeaders(admin);
      const paid = await pay(app, headers, fee.id, 500);
      const paymentId = JSON.parse(paid.body).payments[0].id;

      const res = await app.inject({
        method: "POST",
        url: `${PAYMENTS_URL}/${paymentId}/reverse`,
        headers,
        payload: { reason: "Wrong student" },
      });
      expect(res.statusCode).toBe(201);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "payment.reverse", entityId: paymentId },
      });
      expect(audit.entityType).toBe("fee_payment");
      expect(audit.actorAccountId).toBe(admin.id);
      expect(audit.after).toMatchObject({ amount: "500.00", reason: "Wrong student" });
    });

    it("rejects a reason shorter than 3 characters with 400", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fee = await makeFee(await setupApplication());
      const headers = await getAuthHeaders(admin);
      const paid = await pay(app, headers, fee.id, 500);
      const paymentId = JSON.parse(paid.body).payments[0].id;

      const res = await app.inject({
        method: "POST",
        url: `${PAYMENTS_URL}/${paymentId}/reverse`,
        headers,
        payload: { reason: "  a " },
      });

      expect(res.statusCode).toBe(400);
    });

    it("unknown payment returns 404", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "POST",
        url: `${PAYMENTS_URL}/${crypto.randomUUID()}/reverse`,
        headers: await getAuthHeaders(admin),
        payload: { reason: "Does not exist" },
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toBe("Payment not found");
    });
  });

  describe("ledger rules in the database", () => {
    it("refuses a CASH payment with no recorder", async () => {
      const setup = await setupApplication();
      const fee = await makeFee(setup);

      await expect(
        prisma.feePayment.create({
          data: {
            feeId: fee.id,
            amount: 500,
            method: "CASH",
            receivedAt: new Date(),
            recordedById: null,
          },
        }),
      ).rejects.toThrow(/fee_payment_recorder_required/);
    });
  });

  describe("access", () => {
    it("no token gets 401", async () => {
      const app = await createTestApp();

      const res = await app.inject({ method: "GET", url: FEES_URL });

      expect(res.statusCode).toBe(401);
    });

    it("student token gets 403", async () => {
      const app = await createTestApp();
      const student = await createAccount({ role: "STUDENT" });

      const res = await app.inject({
        method: "GET",
        url: FEES_URL,
        headers: await getAuthHeaders(student),
      });

      expect(res.statusCode).toBe(403);
    });

    it("PENDING admin gets 403 on writes", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "PENDING" });
      const fee = await makeFee(await setupApplication());

      const res = await pay(app, await getAuthHeaders(admin), fee.id, 100);

      expect(res.statusCode).toBe(403);
    });

    it("REMOVED admin gets 403 on the list", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "REMOVED" });

      const res = await app.inject({
        method: "GET",
        url: FEES_URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(403);
    });

    it("student token gets 403 on create even with a valid body", async () => {
      const app = await createTestApp();
      const student = await createAccount({ role: "STUDENT" });
      const setup = await setupApplication();

      const res = await app.inject({
        method: "POST",
        url: FEES_URL,
        headers: await getAuthHeaders(student),
        payload: { applicationId: setup.application.id, amountDue: 100, dueDate: "2031-03-01" },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
