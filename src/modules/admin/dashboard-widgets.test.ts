import { describe, expect, it } from "vitest";
import type { PaymentAttemptStatus, Role } from "../../generated/prisma/enums.js";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createAdmin,
  createArea,
  createRequirement,
  createStudentProfile,
  createTuitionPackage,
  createTutorFeeFixture,
  createTutorProfile,
} from "../../tests/helpers.js";
import type {
  DashboardRange,
  DonutPayload,
  KpiPayload,
  QueuePayload,
  SeriesPayload,
} from "./dashboard.schema.js";
import { WIDGET_IDS } from "./dashboard-registry.js";
import { QUEUE_SLA_HOURS, WIDGETS } from "./dashboard-widgets.js";

// Fixed "now": 12:00 on 15 Dec 2026 in Dhaka. The 30-day window is 16 Nov to 15 Dec; the previous one is 17 Oct to 15 Nov.
const NOW = new Date("2026-12-15T06:00:00Z");
const HOUR_MS = 60 * 60 * 1000;
const ctx = (range: DashboardRange = "30d") => ({ range, now: NOW });
const hoursBefore = (h: number) => new Date(NOW.getTime() - h * HOUR_MS);

async function accountAt(role: Role, createdAt: Date, status: "ACTIVE" | "BLOCKED" = "ACTIVE") {
  const account = await createAccount({ role, status });
  return prisma.account.update({ where: { id: account.id }, data: { createdAt } });
}

function activityOn(accountId: string, day: string) {
  return prisma.accountActivityDay.create({
    data: { accountId, day: new Date(`${day}T00:00:00Z`) },
  });
}

/** A fee on an existing application. Dates are set explicitly so window tests are stable. */
function extraFee(
  base: { tutorId: string; applicationId: string },
  data: {
    amountDue: number;
    dueDate: string;
    createdAt: Date;
    status?: "DUE" | "WAIVED" | "VOID";
  },
) {
  return prisma.platformFee.create({
    data: {
      tutorId: base.tutorId,
      applicationId: base.applicationId,
      feeType: "OTHER", // one PLACEMENT fee per application
      amountDue: data.amountDue,
      dueDate: new Date(`${data.dueDate}T00:00:00Z`),
      createdAt: data.createdAt,
      status: data.status ?? "DUE",
    },
  });
}

/** Ledger rows are append-only, so the timestamp is set on insert. */
function ledgerRow(
  feeId: string,
  recordedById: string,
  data: { amount: number; receivedAt: Date; reversesPaymentId?: string },
) {
  return prisma.feePayment.create({
    data: {
      feeId,
      recordedById,
      method: "CASH",
      amount: data.amount,
      receivedAt: data.receivedAt,
      kind: data.reversesPaymentId ? "REVERSAL" : "PAYMENT",
      reversesPaymentId: data.reversesPaymentId ?? null,
      reason: data.reversesPaymentId ? "Refund" : null,
    },
  });
}

function attemptRow(
  base: { feeId: string; tutorId: string },
  data: {
    tranId: string;
    status: PaymentAttemptStatus;
    createdAt: Date;
    paymentId?: string;
  },
) {
  return prisma.paymentAttempt.create({
    data: {
      feeId: base.feeId,
      tutorId: base.tutorId,
      tranId: data.tranId,
      feeAmount: 100,
      chargeAmount: 0,
      totalAmount: 100,
      status: data.status,
      createdAt: data.createdAt,
      paymentId: data.paymentId ?? null,
    },
  });
}

describe("dashboard widgets", () => {
  it("implements every catalog widget except the bottleneck funnel", () => {
    const expected = WIDGET_IDS.filter((id) => id !== "bottleneck").sort();
    expect(Object.keys(WIDGETS).sort()).toEqual(expected);
  });

  describe("sign-ups", () => {
    it("splits students and tutors, leaves out admins, and zero-fills 30 days", async () => {
      await accountAt("STUDENT", new Date("2026-12-10T10:00:00Z"));
      await accountAt("TUTOR", new Date("2026-12-10T10:00:00Z"));
      await accountAt("TUTOR", new Date("2026-11-01T10:00:00Z")); // previous window only
      await accountAt("ADMIN", new Date("2026-12-10T10:00:00Z"));

      const res = (await WIDGETS.signups(ctx("30d"))) as KpiPayload;

      expect(res.value).toBe(2);
      expect(res.previous).toBe(1);
      expect(res.breakdown).toEqual([
        { label: "Students", value: 1 },
        { label: "Tutors", value: 1 },
      ]);
      expect(res.spark).toHaveLength(30);
      expect(res.spark[0]?.date).toBe("2026-11-16");
      expect(res.spark[0]?.values.value).toBe(0);
      expect(res.spark.find((p) => p.date === "2026-12-10")?.values.value).toBe(2);
      expect(res.note).toBeNull();
    });

    it("counts by Dhaka day, so 18:30 UTC on the 14th is the 15th", async () => {
      await accountAt("STUDENT", new Date("2026-12-14T18:30:00Z"));
      await accountAt("TUTOR", new Date("2026-12-14T17:30:00Z"));

      const res = (await WIDGETS["signups-trend"](ctx("30d"))) as SeriesPayload;
      const day = (date: string) => res.points.find((p) => p.date === date);

      expect(day("2026-12-15")?.values).toEqual({ students: 1, tutors: 0 });
      expect(day("2026-12-14")?.values).toEqual({ students: 0, tutors: 1 });
      expect(res.totals).toEqual({ students: 1, tutors: 1 });
      expect(res.chart).toBe("stacked-area");
    });

    it("gives one point per month on 12m, zero-filled", async () => {
      await accountAt("STUDENT", new Date("2026-03-04T10:00:00Z"));

      const res = (await WIDGETS["signups-trend"](ctx("12m"))) as SeriesPayload;

      expect(res.points).toHaveLength(12);
      expect(res.points[0]?.date).toBe("2026-01-01");
      expect(res.points[11]?.date).toBe("2026-12-01");
      expect(res.points.find((p) => p.date === "2026-03-01")?.values.students).toBe(1);
      expect(res.points.find((p) => p.date === "2026-06-01")?.values.students).toBe(0);
    });

    it("gives one point per month from the earliest signup's month on all", async () => {
      await accountAt("STUDENT", new Date("2025-06-10T10:00:00Z"));
      const since = new Date("2025-06-10T10:00:00Z");

      const res = (await WIDGETS["signups-trend"]({
        range: "all",
        now: NOW,
        since,
      })) as SeriesPayload;

      expect(res.points[0]?.date).toBe("2025-06-01");
      expect(res.points.at(-1)?.date).toBe("2026-12-01");
      expect(res.points).toHaveLength(19);
      expect(res.points.find((p) => p.date === "2025-06-01")?.values.students).toBe(1);
      expect(res.totals).toEqual({ students: 1, tutors: 0 });
    });

    it("range-based sign-up KPIs have no previous under all", async () => {
      const since = new Date("2026-12-10T10:00:00Z");
      await accountAt("STUDENT", since);

      const res = (await WIDGETS.signups({ range: "all", now: NOW, since })) as KpiPayload;

      expect(res.value).toBe(1);
      expect(res.previous).toBeNull();
    });
  });

  describe("fees", () => {
    it("collected is payments minus the completed refund's reversal, counted once", async () => {
      const admin = await createAdmin();
      const fx = await createTutorFeeFixture(1500);
      const payment = await ledgerRow(fx.fee.id, admin.id, {
        amount: 1000,
        receivedAt: new Date("2026-12-10T06:00:00Z"),
      });
      await ledgerRow(fx.fee.id, admin.id, {
        amount: 300,
        receivedAt: new Date("2026-12-12T06:00:00Z"),
        reversesPaymentId: payment.id,
      });
      await ledgerRow(fx.fee.id, admin.id, {
        amount: 500,
        receivedAt: new Date("2026-11-01T06:00:00Z"), // previous window only
      });

      const res = (await WIDGETS.collected(ctx("30d"))) as KpiPayload;

      expect(res.value).toBe(700);
      expect(res.previous).toBe(500);
      expect(res.spark.find((p) => p.date === "2026-12-10")?.values.value).toBe(1000);
      expect(res.spark.find((p) => p.date === "2026-12-12")?.values.value).toBe(-300);
    });

    it("revenue-trend shows payments and refunds as separate positive bars", async () => {
      const admin = await createAdmin();
      const fx = await createTutorFeeFixture(1500);
      const payment = await ledgerRow(fx.fee.id, admin.id, {
        amount: 1000,
        receivedAt: new Date("2026-12-10T06:00:00Z"),
      });
      await ledgerRow(fx.fee.id, admin.id, {
        amount: 300,
        receivedAt: new Date("2026-12-12T06:00:00Z"),
        reversesPaymentId: payment.id,
      });

      const res = (await WIDGETS["revenue-trend"](ctx("30d"))) as SeriesPayload;

      expect(res.chart).toBe("bar");
      expect(res.series.map((s) => s.key)).toEqual(["collected", "refunded"]);
      expect(res.points.find((p) => p.date === "2026-12-10")?.values).toEqual({
        collected: 1000,
        refunded: 0,
      });
      expect(res.points.find((p) => p.date === "2026-12-12")?.values).toEqual({
        collected: 0,
        refunded: 300,
      });
      expect(res.totals).toEqual({ collected: 1000, refunded: 300 });
    });

    it("collection-rate is paid over due, leaving out waived and void fees", async () => {
      const admin = await createAdmin();
      const fx = await createTutorFeeFixture(1000);
      await prisma.platformFee.update({
        where: { id: fx.fee.id },
        data: { createdAt: new Date("2026-12-01T06:00:00Z") },
      });
      await ledgerRow(fx.fee.id, admin.id, {
        amount: 1000,
        receivedAt: new Date("2026-12-02T06:00:00Z"),
      });
      const base = { tutorId: fx.tutor.id, applicationId: fx.application.id };
      await extraFee(base, {
        amountDue: 5000,
        dueDate: "2027-01-10",
        createdAt: new Date("2026-12-02T06:00:00Z"),
        status: "WAIVED",
      });
      await extraFee(base, {
        amountDue: 800,
        dueDate: "2027-01-10",
        createdAt: new Date("2026-12-03T06:00:00Z"),
        status: "VOID",
      });
      await extraFee(base, {
        amountDue: 1000,
        dueDate: "2027-01-10",
        createdAt: new Date("2026-12-04T06:00:00Z"),
      });

      const res = (await WIDGETS["collection-rate"](ctx("30d"))) as KpiPayload;

      expect(res.format).toBe("percent");
      expect(res.value).toBe(0.5);
      expect(res.higherIsBetter).toBe(true);
    });

    it("collection-rate is null when only waived fees exist", async () => {
      const fx = await createTutorFeeFixture(1000);
      await prisma.platformFee.update({
        where: { id: fx.fee.id },
        data: { status: "WAIVED", createdAt: new Date("2026-12-01T06:00:00Z") },
      });

      const res = (await WIDGETS["collection-rate"](ctx("30d"))) as KpiPayload;

      expect(res.value).toBeNull();
    });

    it("overdue-fees groups unpaid remainders by age and ignores the range", async () => {
      const admin = await createAdmin();
      const fx = await createTutorFeeFixture(1000);
      const base = { tutorId: fx.tutor.id, applicationId: fx.application.id };
      await prisma.platformFee.update({
        where: { id: fx.fee.id },
        data: {
          createdAt: new Date("2026-11-20T06:00:00Z"),
          dueDate: new Date("2026-12-10T00:00:00Z"), // 5 days overdue
        },
      });
      const partial = await extraFee(base, {
        amountDue: 2000,
        dueDate: "2026-12-01", // 14 days overdue
        createdAt: new Date("2026-11-20T06:00:00Z"),
      });
      await ledgerRow(partial.id, admin.id, {
        amount: 500,
        receivedAt: new Date("2026-12-02T06:00:00Z"),
      });
      await extraFee(base, {
        amountDue: 3000,
        dueDate: "2026-11-01", // 44 days overdue
        createdAt: new Date("2026-10-20T06:00:00Z"),
      });
      await extraFee(base, {
        amountDue: 900,
        dueDate: "2026-12-15", // due today, not overdue yet
        createdAt: new Date("2026-11-20T06:00:00Z"),
      });
      await extraFee(base, {
        amountDue: 5000,
        dueDate: "2026-11-01",
        createdAt: new Date("2026-10-20T06:00:00Z"),
        status: "WAIVED",
      });

      const res = (await WIDGETS["overdue-fees"](ctx("7d"))) as DonutPayload;

      expect(res.slices.map((s) => [s.key, s.value])).toEqual([
        ["d1_7", 1000],
        ["d8_30", 1500],
        ["d30", 3000],
      ]);
      expect(res.center).toEqual({ label: "Overdue", value: 5500, format: "money" });
      expect(res.note).toBe("Now, whatever range is selected.");
    });
  });

  describe("placements and fill", () => {
    it("counts confirmations by source and compares with the previous window", async () => {
      const area = await createArea();
      const studentAccount = await createAccount({ role: "STUDENT" });
      const student = await createStudentProfile(studentAccount.id, area.id);
      const tutors = [];
      for (let i = 0; i < 3; i++) {
        const acc = await createAccount({ role: "TUTOR" });
        tutors.push(await createTutorProfile(acc.id));
      }
      const [t1, t2, t3] = tutors;
      if (!t1 || !t2 || !t3) throw new Error("tutors missing");
      const r1 = await createRequirement({ studentId: student.id });
      const r2 = await createRequirement({ studentId: student.id });
      const pkg = await createTuitionPackage(t3.id);

      const confirmed = (tutorId: string, at: Date, extra: object) =>
        prisma.application.create({
          data: {
            tutorId,
            studentId: student.id,
            initiatedBy: "TUTOR",
            status: "CONFIRMED",
            confirmedAt: at,
            ...extra,
          },
        });
      await confirmed(t1.id, new Date("2026-12-03T06:00:00Z"), { requirementId: r1.id });
      await confirmed(t2.id, new Date("2026-12-04T06:00:00Z"), { requirementId: r2.id });
      // Package requests are student-initiated (tutor-initiated ones need a requirement).
      await prisma.application.create({
        data: {
          tutorId: t3.id,
          studentId: student.id,
          packageId: pkg.id,
          initiatedBy: "STUDENT",
          status: "CONFIRMED",
          confirmedAt: new Date("2026-12-05T06:00:00Z"),
        },
      });
      await confirmed(t3.id, new Date("2026-11-01T06:00:00Z"), { requirementId: r1.id });
      await prisma.application.create({
        data: {
          tutorId: t1.id,
          studentId: student.id,
          requirementId: r2.id,
          initiatedBy: "TUTOR",
          status: "PENDING",
        },
      });

      const res = (await WIDGETS.placements(ctx("30d"))) as KpiPayload;

      expect(res.value).toBe(3);
      expect(res.previous).toBe(1);
      expect(res.breakdown).toEqual([
        { label: "From requirements", value: 2 },
        { label: "From packages", value: 1 },
      ]);
    });

    it("fill rate is the share of non-draft requirements with a confirmed hire", async () => {
      const area = await createArea();
      const studentAccount = await createAccount({ role: "STUDENT" });
      const student = await createStudentProfile(studentAccount.id, area.id);
      const t1 = await createTutorProfile((await createAccount({ role: "TUTOR" })).id);
      const t2 = await createTutorProfile((await createAccount({ role: "TUTOR" })).id);
      const posted = async (createdAt: string, status: "OPEN" | "DRAFT" = "OPEN") => {
        const r = await createRequirement({ studentId: student.id, status });
        return prisma.tuitionRequirement.update({
          where: { id: r.id },
          data: { createdAt: new Date(createdAt) },
        });
      };
      const r1 = await posted("2026-12-01T06:00:00Z");
      const r2 = await posted("2026-12-02T06:00:00Z");
      const r3 = await posted("2026-12-03T06:00:00Z");
      await posted("2026-12-04T06:00:00Z", "DRAFT");

      await prisma.application.create({
        data: {
          requirementId: r1.id,
          tutorId: t1.id,
          studentId: student.id,
          initiatedBy: "TUTOR",
          status: "CONFIRMED",
          confirmedAt: new Date("2026-12-05T06:00:00Z"),
        },
      });
      await prisma.application.create({
        data: {
          requirementId: r2.id,
          tutorId: t2.id,
          studentId: student.id,
          initiatedBy: "TUTOR",
          status: "CONFIRMED",
          confirmedAt: new Date("2026-12-06T06:00:00Z"),
        },
      });
      await prisma.application.create({
        data: {
          requirementId: r3.id,
          tutorId: t1.id,
          studentId: student.id,
          initiatedBy: "TUTOR",
          status: "PENDING",
        },
      });

      const res = (await WIDGETS["fill-rate"](ctx("30d"))) as KpiPayload;

      expect(res.format).toBe("percent");
      expect(res.value).toBeCloseTo(2 / 3, 5);
      expect(res.previous).toBeNull();
      expect(res.note).toBe("Recent requirements may still fill.");
    });

    it("time to hire is the median of an even number of samples", async () => {
      const area = await createArea();
      const studentAccount = await createAccount({ role: "STUDENT" });
      const student = await createStudentProfile(studentAccount.id, area.id);
      const t1 = await createTutorProfile((await createAccount({ role: "TUTOR" })).id);
      const t2 = await createTutorProfile((await createAccount({ role: "TUTOR" })).id);
      const r1 = await createRequirement({ studentId: student.id });
      const r2 = await createRequirement({ studentId: student.id });
      await prisma.tuitionRequirement.update({
        where: { id: r1.id },
        data: { createdAt: new Date("2026-12-01T00:00:00Z") },
      });
      await prisma.tuitionRequirement.update({
        where: { id: r2.id },
        data: { createdAt: new Date("2026-12-02T00:00:00Z") },
      });
      // Hires take 2 days and 4 days, so the median is 3.
      await prisma.application.create({
        data: {
          requirementId: r1.id,
          tutorId: t1.id,
          studentId: student.id,
          initiatedBy: "TUTOR",
          status: "CONFIRMED",
          confirmedAt: new Date("2026-12-03T00:00:00Z"),
        },
      });
      await prisma.application.create({
        data: {
          requirementId: r2.id,
          tutorId: t2.id,
          studentId: student.id,
          initiatedBy: "TUTOR",
          status: "CONFIRMED",
          confirmedAt: new Date("2026-12-06T00:00:00Z"),
        },
      });

      const res = (await WIDGETS["time-to-hire"](ctx("30d"))) as KpiPayload;

      expect(res.format).toBe("days");
      expect(res.higherIsBetter).toBe(false);
      expect(res.value).toBe(3);
      expect(res.previous).toBeNull();
    });
  });

  describe("payments and cases", () => {
    it("payment-health lists slices in order with the success rate", async () => {
      const admin = await createAdmin();
      const fx = await createTutorFeeFixture(10000);
      const base = { feeId: fx.fee.id, tutorId: fx.tutor.id };
      const p1 = await ledgerRow(fx.fee.id, admin.id, {
        amount: 100,
        receivedAt: new Date("2026-12-05T06:00:00Z"),
      });
      const p2 = await ledgerRow(fx.fee.id, admin.id, {
        amount: 100,
        receivedAt: new Date("2026-12-05T07:00:00Z"),
      });
      const at = new Date("2026-12-06T06:00:00Z");
      await attemptRow(base, {
        tranId: "ok-1",
        status: "SUCCEEDED",
        createdAt: at,
        paymentId: p1.id,
      });
      await attemptRow(base, {
        tranId: "ok-2",
        status: "SUCCEEDED",
        createdAt: at,
        paymentId: p2.id,
      });
      await attemptRow(base, { tranId: "rev-1", status: "REVIEW", createdAt: at });
      await attemptRow(base, { tranId: "rev-2", status: "UNAPPLIED", createdAt: at });
      await attemptRow(base, { tranId: "bad-1", status: "FAILED", createdAt: at });
      await attemptRow(base, { tranId: "open-1", status: "PENDING", createdAt: at });
      await attemptRow(base, {
        tranId: "old-1",
        status: "FAILED",
        createdAt: new Date("2026-11-01T06:00:00Z"),
      });

      const res = (await WIDGETS["payment-health"](ctx("30d"))) as DonutPayload;

      expect(res.slices.map((s) => [s.key, s.label, s.value, s.color])).toEqual([
        ["succeeded", "Succeeded", 2, "good"],
        ["review", "Needs a decision", 2, "warn"],
        ["failed", "Failed or cancelled", 1, "bad"],
        ["other", "Still open", 1, "chart-4"],
      ]);
      expect(res.center).toEqual({ label: "Success rate", value: 0.4, format: "percent" });
    });

    it("trust-cases counts opened by created_at and closed by resolved_at", async () => {
      const admin = await createAdmin();
      const fx = await createTutorFeeFixture(1000);
      const reporter = fx.studentAccount.id;
      const target = fx.tutorAccount.id;
      await prisma.report.create({
        data: {
          reporterId: reporter,
          targetAccountId: target,
          category: "SPAM",
          details: "spam",
          createdAt: new Date("2026-12-01T06:00:00Z"),
          status: "RESOLVED",
          resolvedAt: new Date("2026-12-12T06:00:00Z"),
          handledById: admin.id,
        },
      });
      await prisma.report.create({
        data: {
          reporterId: reporter,
          targetAccountId: target,
          category: "SPAM",
          details: "spam again",
          createdAt: new Date("2026-12-10T06:00:00Z"),
        },
      });
      await prisma.dispute.create({
        data: {
          applicationId: fx.application.id,
          raisedById: reporter,
          againstId: target,
          type: "NO_SHOW",
          details: "did not turn up",
          createdAt: new Date("2026-12-11T06:00:00Z"),
        },
      });

      const res = (await WIDGETS["trust-cases"](ctx("30d"))) as SeriesPayload;
      const day = (date: string) => res.points.find((p) => p.date === date)?.values;

      expect(res.totals).toEqual({ opened: 3, closed: 1 });
      expect(day("2026-12-01")).toEqual({ opened: 1, closed: 0 });
      expect(day("2026-12-11")).toEqual({ opened: 1, closed: 0 });
      expect(day("2026-12-12")).toEqual({ opened: 0, closed: 1 });
    });
  });

  describe("activity", () => {
    it("mau excludes admins and blocked accounts, and compares with the previous 30 days", async () => {
      const a = await accountAt("STUDENT", new Date("2026-09-01T00:00:00Z"));
      const b = await accountAt("TUTOR", new Date("2026-09-01T00:00:00Z"));
      const admin = await accountAt("ADMIN", new Date("2026-09-01T00:00:00Z"));
      const blocked = await accountAt("STUDENT", new Date("2026-09-01T00:00:00Z"), "BLOCKED");
      const d = await accountAt("STUDENT", new Date("2026-09-01T00:00:00Z"));
      await activityOn(a.id, "2026-12-14");
      await activityOn(b.id, "2026-12-15");
      await activityOn(admin.id, "2026-12-14");
      await activityOn(blocked.id, "2026-12-13");
      await activityOn(a.id, "2026-10-20"); // previous window
      await activityOn(d.id, "2026-10-01"); // oldest row: history reaches the previous window

      const res = (await WIDGETS.mau(ctx("7d"))) as KpiPayload;

      // Previous window (17 Oct to 15 Nov) holds only a. d's 1 Oct row makes the history reach it.
      expect(res.value).toBe(2);
      expect(res.previous).toBe(1);
      expect(res.spark).toHaveLength(30);
      expect(res.spark.find((p) => p.date === "2026-12-14")?.values.value).toBe(1);
      expect(res.spark.find((p) => p.date === "2026-12-13")?.values.value).toBe(0);
      expect(res.note).toBeNull();
    });

    it("mau keeps its previous 30 days under all, which has no range-based previous", async () => {
      const a = await accountAt("STUDENT", new Date("2025-06-01T00:00:00Z"));
      const b = await accountAt("TUTOR", new Date("2025-06-01T00:00:00Z"));
      await activityOn(a.id, "2026-10-17"); // first day of the previous 30 days
      await activityOn(a.id, "2026-12-14");
      await activityOn(b.id, "2026-11-20");

      const res = (await WIDGETS.mau({
        range: "all",
        now: NOW,
        since: new Date("2025-06-01T00:00:00Z"),
      })) as KpiPayload;

      expect(res.value).toBe(2);
      expect(res.previous).toBe(1);
      expect(res.note).toBeNull();
    });

    it("mau has no previous value and a tracking note when history starts late", async () => {
      const a = await accountAt("STUDENT", new Date("2026-09-01T00:00:00Z"));
      await activityOn(a.id, "2026-12-01");
      await activityOn(a.id, "2026-12-14");

      const res = (await WIDGETS.mau(ctx())) as KpiPayload;

      expect(res.value).toBe(1);
      expect(res.previous).toBeNull();
      expect(res.note).toBe("Tracking since 1 Dec 2026");
    });

    it("activity-trend counts distinct actives per month on 12m", async () => {
      const a = await accountAt("STUDENT", new Date("2026-01-01T00:00:00Z"));
      const b = await accountAt("TUTOR", new Date("2026-01-01T00:00:00Z"));
      const admin = await accountAt("ADMIN", new Date("2026-01-01T00:00:00Z"));
      await activityOn(a.id, "2026-01-05");
      await activityOn(a.id, "2026-12-01");
      await activityOn(a.id, "2026-12-14");
      await activityOn(b.id, "2026-12-14");
      await activityOn(admin.id, "2026-12-14");

      const res = (await WIDGETS["activity-trend"](ctx("12m"))) as SeriesPayload;
      const month = (date: string) => res.points.find((p) => p.date === date)?.values.active;

      expect(res.points).toHaveLength(12);
      expect(month("2026-12-01")).toBe(2);
      expect(month("2026-01-01")).toBe(1);
      expect(month("2026-06-01")).toBe(0);
      expect(res.series).toEqual([{ key: "active", label: "Active users", color: "chart-1" }]);
      expect(res.note).toBe("Tracking since 5 Jan 2026");
    });

    it("activity-trend starts at the first tracked day, not at zeros before it", async () => {
      const a = await accountAt("STUDENT", new Date("2026-01-01T00:00:00Z"));
      await activityOn(a.id, "2026-12-10");

      const res = (await WIDGETS["activity-trend"](ctx("30d"))) as SeriesPayload;

      expect(res.points[0]?.date).toBe("2026-12-10");
      expect(res.points.at(-1)?.date).toBe("2026-12-15");
      expect(res.note).toBe("Tracking since 10 Dec 2026");
    });
  });

  describe("needs attention", () => {
    it("ranks queue rows by age against their targets", async () => {
      const tutor = await createTutorProfile((await createAccount({ role: "TUTOR" })).id);
      await createTuitionPackage(tutor.id, {
        moderationStatus: "PENDING",
        createdAt: hoursBefore(30),
      });
      const reporter = await createAccount({ role: "STUDENT" });
      await prisma.report.create({
        data: {
          reporterId: reporter.id,
          targetAccountId: tutor.accountId,
          category: "SPAM",
          details: "spam",
          createdAt: hoursBefore(13),
        },
      });
      const storyAuthor = await createAccount({ role: "STUDENT" });
      await prisma.story.create({
        data: {
          accountId: storyAuthor.id,
          role: "STUDENT",
          headline: "Great tutor",
          body: "Great tutor",
          consentAt: hoursBefore(2),
          createdAt: hoursBefore(2),
        },
      });
      const area = await createArea();
      const student = await createStudentProfile(storyAuthor.id, area.id);
      const requirement = await createRequirement({ studentId: student.id });
      await prisma.tuitionRequirement.update({
        where: { id: requirement.id },
        data: { createdAt: hoursBefore(100) },
      });

      const res = (await WIDGETS.queues(ctx())) as QueuePayload;
      const row = (key: string) => res.rows.find((r) => r.key === key);

      expect(res.rows.map((r) => r.key)).toEqual([
        "verifications",
        "packages",
        "videos",
        "stories",
        "reports",
        "disputes",
        "refunds",
        "payments-review",
        "payments-unapplied",
        "zone-requests",
        "unserved",
      ]);
      expect(row("packages")).toMatchObject({
        count: 1,
        oldestHours: 30,
        status: "late",
        href: "/dashboard/admin/packages",
      });
      expect(row("reports")).toMatchObject({ count: 1, oldestHours: 13, status: "watch" });
      expect(row("stories")).toMatchObject({ count: 1, oldestHours: 2, status: "ok" });
      // Posted 100 hours ago: 28 hours past the 72-hour mark, past the 24-hour watch line.
      expect(row("unserved")).toMatchObject({
        count: 1,
        oldestHours: 28,
        status: "watch",
        href: "/dashboard/admin/matching?tab=unmatched",
      });
      expect(row("videos")).toEqual({
        key: "videos",
        label: "Videos to review",
        count: 0,
        oldestHours: null,
        status: "ok",
        href: "/dashboard/admin/videos",
      });
      expect(QUEUE_SLA_HOURS.packages).toBe(24);
    });

    it("rates unserved requirements by hours past the 72-hour mark: watch from 24, late from 48", async () => {
      const student = await createStudentProfile(
        (await createAccount({ role: "STUDENT" })).id,
        (await createArea()).id,
      );
      const requirement = await createRequirement({ studentId: student.id });
      const unserved = async (hoursPast: number) => {
        await prisma.tuitionRequirement.update({
          where: { id: requirement.id },
          data: { createdAt: hoursBefore(72 + hoursPast) },
        });
        const res = (await WIDGETS.queues(ctx())) as QueuePayload;
        return res.rows.find((r) => r.key === "unserved");
      };

      expect(await unserved(23)).toMatchObject({ oldestHours: 23, status: "ok" });
      expect(await unserved(24)).toMatchObject({ oldestHours: 24, status: "watch" });
      expect(await unserved(48)).toMatchObject({ oldestHours: 48, status: "late" });
    });
  });

  describe("activity trend", () => {
    it("leaves out blocked accounts and counts each active account once over the window", async () => {
      const a = await accountAt("STUDENT", new Date("2026-09-01T00:00:00Z"));
      const c = await accountAt("TUTOR", new Date("2026-09-01T00:00:00Z"));
      const blocked = await accountAt("STUDENT", new Date("2026-09-01T00:00:00Z"), "BLOCKED");
      await activityOn(a.id, "2026-11-20");
      await activityOn(a.id, "2026-12-14");
      await activityOn(a.id, "2026-12-15");
      await activityOn(c.id, "2026-11-20");
      await activityOn(blocked.id, "2026-12-14");

      const res = (await WIDGETS["activity-trend"](ctx("30d"))) as SeriesPayload;

      expect(res.points.find((p) => p.date === "2026-12-14")?.values.active).toBe(1);
      // a is active on three days and c on one: the window has two people, not four.
      expect(res.totals.active).toBe(2);
    });
  });
});
