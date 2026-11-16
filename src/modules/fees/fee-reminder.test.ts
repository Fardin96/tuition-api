import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createApplication,
  createArea,
  createRequirement,
  createStudentProfile,
  createTutorProfile,
} from "../../tests/helpers.js";
import { runFeeReminders } from "./fee-reminder.service.js";

// 2026-11-16 10:00 in Asia/Dhaka
const NOW = new Date("2026-11-16T04:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

async function setupConfirmedApplication(confirmedAt: Date) {
  const area = await createArea();
  const studentAccount = await createAccount({ role: "STUDENT" });
  const student = await createStudentProfile(studentAccount.id, area.id);
  const tutorAccount = await createAccount({ role: "TUTOR" });
  const tutor = await createTutorProfile(tutorAccount.id);
  const requirement = await createRequirement({ studentId: student.id, areaId: area.id });
  const application = await createApplication({
    requirementId: requirement.id,
    tutorId: tutor.id,
    studentId: student.id,
    initiatedBy: "TUTOR",
    status: "CONFIRMED",
    confirmedAt,
  });
  return { tutor, tutorAccount, application };
}

async function createPlacementFee(
  tutorId: string,
  applicationId: string,
  overrides: { dueDate: Date; status?: "DUE" | "PARTIAL" | "PAID" | "VOID" },
) {
  return prisma.platformFee.create({
    data: {
      tutorId,
      applicationId,
      feeType: "PLACEMENT",
      amountDue: 1500,
      // fee_status_matches_paid: PAID requires amount_paid = amount_due
      amountPaid: overrides.status === "PAID" ? 1500 : 0,
      dueDate: overrides.dueDate,
      status: overrides.status ?? "DUE",
    },
  });
}

async function reminderRows() {
  return prisma.notificationLog.findMany({ where: { eventType: "PAYMENT_REMINDER" } });
}

describe("runFeeReminders", () => {
  it("queues one reminder to the tutor for an overdue fee within the 21-day window", async () => {
    const { tutor, tutorAccount, application } = await setupConfirmedApplication(
      new Date(NOW.getTime() - 10 * DAY_MS),
    );
    const fee = await createPlacementFee(tutor.id, application.id, {
      dueDate: new Date("2026-11-15"),
    });

    const result = await runFeeReminders(NOW);

    expect(result).toEqual({ queued: 1 });
    const rows = await reminderRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipientId: tutorAccount.id,
      applicationId: application.id,
      channel: "WHATSAPP",
      templateName: "payment_reminder",
      dedupeKey: `payment_reminder:${fee.id}:2026-11-16`,
    });
    expect(rows[0].payload).toMatchObject({ feeId: fee.id, applicationId: application.id });
  });

  it("queues nothing when run twice on the same day", async () => {
    const { tutor, application } = await setupConfirmedApplication(
      new Date(NOW.getTime() - 10 * DAY_MS),
    );
    await createPlacementFee(tutor.id, application.id, { dueDate: new Date("2026-11-16") });

    expect(await runFeeReminders(NOW)).toEqual({ queued: 1 });
    expect(await runFeeReminders(NOW)).toEqual({ queued: 0 });
    expect(await reminderRows()).toHaveLength(1);
  });

  it("queues nothing when the fee is not yet due", async () => {
    const { tutor, application } = await setupConfirmedApplication(
      new Date(NOW.getTime() - 3 * DAY_MS),
    );
    await createPlacementFee(tutor.id, application.id, { dueDate: new Date("2026-11-20") });

    expect(await runFeeReminders(NOW)).toEqual({ queued: 0 });
    expect(await reminderRows()).toHaveLength(0);
  });

  it("queues nothing once 21 days have passed since confirmation", async () => {
    const { tutor, application } = await setupConfirmedApplication(
      new Date(NOW.getTime() - 22 * DAY_MS),
    );
    await createPlacementFee(tutor.id, application.id, { dueDate: new Date("2026-11-10") });

    expect(await runFeeReminders(NOW)).toEqual({ queued: 0 });
    expect(await reminderRows()).toHaveLength(0);
  });

  it.each(["PAID", "VOID"] as const)("queues nothing for a %s fee", async (status) => {
    const { tutor, application } = await setupConfirmedApplication(
      new Date(NOW.getTime() - 10 * DAY_MS),
    );
    await createPlacementFee(tutor.id, application.id, {
      dueDate: new Date("2026-11-15"),
      status,
    });

    expect(await runFeeReminders(NOW)).toEqual({ queued: 0 });
    expect(await reminderRows()).toHaveLength(0);
  });
});
