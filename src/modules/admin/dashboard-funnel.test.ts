import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createApplication,
  createArea,
  createFileAsset,
  createPlatformFee,
  createRequirement,
  createStudentProfile,
  createSuperAdmin,
  createTuitionPackage,
  createTutorProfile,
} from "../../tests/helpers.js";
import {
  bottleneckWidget,
  computeFunnel,
  type Entrant,
  measureStage,
  median,
  type StageSpec,
} from "./dashboard-funnel.js";
import { flagWindows } from "./dashboard-time.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-23T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

async function bottleneck() {
  return bottleneckWidget({ range: "30d", now: NOW });
}

function funnel(
  result: Awaited<ReturnType<typeof bottleneck>>,
  key: "placement" | "tutors" | "students",
) {
  const found = result.funnels.find((f) => f.key === key);
  if (!found) throw new Error(`missing funnel ${key}`);
  return found.stages;
}

async function backdateRequirement(id: string, createdAt: Date) {
  await prisma.tuitionRequirement.update({ where: { id }, data: { createdAt } });
}

async function backdateAccount(id: string, createdAt: Date) {
  await prisma.account.update({ where: { id }, data: { createdAt } });
}

async function makeStudent(areaId: number, createdAt = ago(30)) {
  const account = await createAccount({ role: "STUDENT" });
  await backdateAccount(account.id, createdAt);
  return createStudentProfile(account.id, areaId);
}

async function makeTutor(createdAt = ago(30)) {
  const account = await createAccount({ role: "TUTOR" });
  await backdateAccount(account.id, createdAt);
  return createTutorProfile(account.id);
}

/** Creates an application with explicit applied / confirmed times. */
async function applyTo(args: {
  requirementId?: string;
  packageId?: string;
  tutorId: string;
  studentId: string;
  initiatedBy: "TUTOR" | "STUDENT";
  status?: "PENDING" | "CONFIRMED" | "CANCELLED";
  appliedAt: Date;
  confirmedAt?: Date;
}) {
  const app = await createApplication({
    requirementId: args.requirementId,
    packageId: args.packageId,
    tutorId: args.tutorId,
    studentId: args.studentId,
    initiatedBy: args.initiatedBy,
    status: args.status,
    confirmedAt: args.confirmedAt,
  });
  return prisma.application.update({
    where: { id: app.id },
    data: { appliedAt: args.appliedAt },
  });
}

describe("bottleneck funnel (DB)", () => {
  it("counts placement stages, conversions and wait medians", async () => {
    const area = await createArea();
    const student = await makeStudent(area.id);
    const tutor1 = await makeTutor();
    const tutor2 = await makeTutor();
    const admin = await createSuperAdmin();

    const r1 = await createRequirement({ studentId: student.id });
    const r2 = await createRequirement({ studentId: student.id });
    const r3 = await createRequirement({ studentId: student.id });
    const draft = await createRequirement({ studentId: student.id, status: "DRAFT" });
    for (const r of [r1, r2, r3, draft]) await backdateRequirement(r.id, ago(10));

    // R1: applied 9 days ago, confirmed 7 days ago, fee paid 5 days ago (2 days after confirm).
    const a1 = await applyTo({
      requirementId: r1.id,
      tutorId: tutor1.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
      status: "CONFIRMED",
      appliedAt: ago(9),
      confirmedAt: ago(7),
    });
    // R2: applied 8 days ago, still pending.
    await applyTo({
      requirementId: r2.id,
      tutorId: tutor2.id,
      studentId: student.id,
      initiatedBy: "STUDENT",
      appliedAt: ago(8),
    });

    const fee = await createPlatformFee({
      tutorId: tutor1.id,
      applicationId: a1.id,
      amountDue: 1500,
    });
    await prisma.feePayment.create({
      data: {
        feeId: fee.id,
        amount: 1500,
        method: "CASH",
        kind: "PAYMENT",
        receivedAt: ago(5),
        recordedById: admin.id,
      },
    });

    const stages = funnel(await bottleneck(), "placement");
    const [posted, applied, hired, paid] = stages;

    expect(posted?.count).toBe(3);
    expect(posted?.conversion).toBeNull();
    expect(applied?.count).toBe(2);
    expect(applied?.conversion).toBeCloseTo(2 / 3);
    expect(applied?.medianDays).toBe(1.5);
    expect(hired?.count).toBe(1);
    expect(hired?.conversion).toBe(0.5);
    expect(hired?.medianDays).toBe(2);
    expect(paid?.count).toBe(1);
    expect(paid?.conversion).toBe(1);
    expect(paid?.medianDays).toBe(2);
  });

  it("keeps a hire whose application was cancelled after confirmation", async () => {
    const area = await createArea();
    const student = await makeStudent(area.id);
    const tutor = await makeTutor();
    const requirement = await createRequirement({ studentId: student.id });
    await backdateRequirement(requirement.id, ago(10));
    await applyTo({
      requirementId: requirement.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
      status: "CANCELLED",
      appliedAt: ago(9),
      confirmedAt: ago(7),
    });

    const [, , hired, paid] = funnel(await bottleneck(), "placement");
    expect(hired?.count).toBe(1);
    expect(paid?.count).toBe(0);
    expect(paid?.conversion).toBe(0);
  });

  it("removes VOID fees from the paid denominator and counts WAIVED as settled without a wait", async () => {
    const area = await createArea();
    const student = await makeStudent(area.id);
    const tutorVoid = await makeTutor();
    const tutorWaived = await makeTutor();

    const rVoid = await createRequirement({ studentId: student.id });
    const rWaived = await createRequirement({ studentId: student.id });
    await backdateRequirement(rVoid.id, ago(10));
    await backdateRequirement(rWaived.id, ago(10));

    const appVoid = await applyTo({
      requirementId: rVoid.id,
      tutorId: tutorVoid.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
      status: "CONFIRMED",
      appliedAt: ago(9),
      confirmedAt: ago(7),
    });
    const appWaived = await applyTo({
      requirementId: rWaived.id,
      tutorId: tutorWaived.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
      status: "CONFIRMED",
      appliedAt: ago(9),
      confirmedAt: ago(7),
    });
    await createPlatformFee({ tutorId: tutorVoid.id, applicationId: appVoid.id, status: "VOID" });
    await createPlatformFee({
      tutorId: tutorWaived.id,
      applicationId: appWaived.id,
      status: "WAIVED",
    });

    const [, , hired, paid] = funnel(await bottleneck(), "placement");
    expect(hired?.count).toBe(2);
    expect(paid?.count).toBe(1);
    // Two hires, one of them VOID: the denominator is 1, so the conversion is 1, not 0.5.
    expect(paid?.conversion).toBe(1);
    expect(paid?.medianDays).toBeNull();
  });

  it("counts tutor and student funnels, including a package hire that is not a placement", async () => {
    const area = await createArea();
    const admin = await createSuperAdmin();
    const tutorAccount = await createAccount({ role: "TUTOR" });
    await backdateAccount(tutorAccount.id, ago(20));
    const tutor = await createTutorProfile(tutorAccount.id);
    const file = await createFileAsset(tutorAccount.id, "TUTOR_ID");
    await prisma.tutorVerification.create({
      data: {
        tutorId: tutor.id,
        fileId: file.id,
        status: "APPROVED",
        decidedAt: ago(18),
        reviewedById: admin.id,
      },
    });
    const pkg = await createTuitionPackage(tutor.id);

    const student = await makeStudent(area.id, ago(20));
    const requirement = await createRequirement({ studentId: student.id });
    await backdateRequirement(requirement.id, ago(15));

    // The tutor first applies to the requirement; any application or package request counts as "First application or request".
    await applyTo({
      requirementId: requirement.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
      appliedAt: ago(14),
    });
    // The student then requests the package (student-initiated, no requirement) and it is confirmed.
    await applyTo({
      packageId: pkg.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "STUDENT",
      status: "CONFIRMED",
      appliedAt: ago(13),
      confirmedAt: ago(12),
    });

    const result = await bottleneck();
    const tutors = funnel(result, "tutors");
    const students = funnel(result, "students");
    const placement = funnel(result, "placement");

    expect(tutors.map((s) => s.count)).toEqual([1, 1, 1, 1]);
    expect(students.map((s) => s.count)).toEqual([1, 1, 1]);
    expect(students[1]?.medianDays).toBe(5);
    // The package hire has no requirement, so the placement funnel sees only the posted requirement.
    expect(placement.map((s) => s.count)).toEqual([1, 1, 0, 0]);
  });

  it("counts a package-only student as having hired a tutor", async () => {
    const area = await createArea();
    const student = await makeStudent(area.id, ago(20));
    const tutor = await makeTutor(ago(20));
    const pkg = await createTuitionPackage(tutor.id);
    await applyTo({
      packageId: pkg.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "STUDENT",
      status: "CONFIRMED",
      appliedAt: ago(13),
      confirmedAt: ago(12),
    });

    const students = funnel(await bottleneck(), "students");
    expect(students.map((s) => s.count)).toEqual([1, 0, 1]);
    expect(students[2]?.conversion).toBe(1);
  });

  it("counts an unverified tutor who applies and is placed in both applied and placed", async () => {
    const area = await createArea();
    const student = await makeStudent(area.id, ago(20));
    const tutor = await makeTutor(ago(20));
    const requirement = await createRequirement({ studentId: student.id });
    await backdateRequirement(requirement.id, ago(15));
    await applyTo({
      requirementId: requirement.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
      status: "CONFIRMED",
      appliedAt: ago(14),
      confirmedAt: ago(12),
    });

    const tutors = funnel(await bottleneck(), "tutors");
    expect(tutors.map((s) => s.count)).toEqual([1, 0, 1, 1]);
    expect(tutors[2]?.conversion).toBe(1);
    expect(tutors[3]?.conversion).toBe(1);
  });

  it("counts a re-hire as paid when the cancelled hire's fee is VOID", async () => {
    const area = await createArea();
    const admin = await createSuperAdmin();
    const student = await makeStudent(area.id, ago(20));
    const cancelledTutor = await makeTutor(ago(20));
    const newTutor = await makeTutor(ago(20));
    const requirement = await createRequirement({ studentId: student.id });
    await backdateRequirement(requirement.id, ago(10));

    const cancelled = await applyTo({
      requirementId: requirement.id,
      tutorId: cancelledTutor.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
      status: "CANCELLED",
      appliedAt: ago(9),
      confirmedAt: ago(8),
    });
    await createPlatformFee({
      tutorId: cancelledTutor.id,
      applicationId: cancelled.id,
      status: "VOID",
    });

    const rehire = await applyTo({
      requirementId: requirement.id,
      tutorId: newTutor.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
      status: "CONFIRMED",
      appliedAt: ago(6),
      confirmedAt: ago(5),
    });
    const fee = await createPlatformFee({
      tutorId: newTutor.id,
      applicationId: rehire.id,
      amountDue: 1500,
    });
    await prisma.feePayment.create({
      data: {
        feeId: fee.id,
        amount: 1500,
        method: "CASH",
        kind: "PAYMENT",
        receivedAt: ago(4),
        recordedById: admin.id,
      },
    });

    const [, , hired, paid] = funnel(await bottleneck(), "placement");
    expect(hired?.count).toBe(1);
    expect(paid?.count).toBe(1);
    expect(paid?.conversion).toBe(1);
  });
});

describe("bottleneck wait flag and maturity (pure)", () => {
  const flag = flagWindows(NOW);
  const stages: StageSpec[] = [
    { key: "signed_up", label: "Signed up", maturityDays: 0 },
    { key: "posted", label: "Posted", maturityDays: 7 },
  ];
  const currentEntry = new Date(flag.start.getTime() - 7 * DAY_MS + DAY_MS);
  const previousEntry = new Date(flag.prevStart.getTime() - 7 * DAY_MS + DAY_MS);

  /** `count` entrants who all reached stage 1, `days` after entering. */
  function waitCohort(count: number, days: number, entryAt: Date): Entrant[] {
    return Array.from({ length: count }, () => ({
      entered: entryAt,
      reached: [true, true],
      times: [entryAt, new Date(entryAt.getTime() + Math.round(days * DAY_MS))],
      voidFee: false,
    }));
  }

  it("flags a wait that grew 25% or more, with 40 entrants in each window", () => {
    const entrants = [...waitCohort(40, 2.6, currentEntry), ...waitCohort(40, 2.0, previousEntry)];
    const posted = computeFunnel(entrants, stages, flag, flag)[1];
    expect(posted?.flagged).toBe(true);
    expect(posted?.flagReason).toBe("Wait 2.6 days, up from 2.0 days");
  });

  it("judges the wait on unrounded medians, not the one-decimal display values", () => {
    // 2.04 shows as 2.0 and 2.5 as 2.5: the rounded ratio is 1.25, the real one 1.225.
    const entrants = [...waitCohort(40, 2.5, currentEntry), ...waitCohort(40, 2.04, previousEntry)];
    const posted = computeFunnel(entrants, stages, flag, flag)[1];
    expect(posted?.flagged).toBe(false);
  });

  it("leaves out entrants who entered within the maturity days of the current window", () => {
    const young: Entrant[] = [
      { entered: ago(2), reached: [true, false], times: [ago(2), null], voidFee: false },
    ];
    expect(measureStage(young, stages, 1, flag, 7).denominator).toBe(0);
    expect(measureStage(young, stages, 1, flag).denominator).toBe(1);
  });
});

describe("bottleneck funnel (pure)", () => {
  const stages: StageSpec[] = [
    { key: "posted", label: "Posted", maturityDays: 0 },
    { key: "hired", label: "Hired", maturityDays: 14 },
  ];
  const span = { start: ago(30), end: NOW };

  it("computes the median, averaging the two middle values", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([5])).toBe(5);
    expect(median([])).toBeNull();
  });

  it("clamps a negative wait step to zero", () => {
    const entrants: Entrant[] = [
      {
        entered: ago(20),
        reached: [true, true],
        times: [ago(20), ago(21)],
        voidFee: false,
      },
    ];
    expect(measureStage(entrants, stages, 1, span).medianDays).toBe(0);
  });

  it("gives a null conversion when the previous stage count is zero", () => {
    const threeStages: StageSpec[] = [...stages, { key: "paid", label: "Paid", maturityDays: 21 }];
    // Reached stage 0 only, so the stage 1 count (the previous count for stage 2) is zero.
    const entrants: Entrant[] = [
      {
        entered: ago(20),
        reached: [true, false, false],
        times: [ago(20), null, null],
        voidFee: false,
      },
    ];
    const measured = measureStage(entrants, threeStages, 2, span);
    expect(measured.count).toBe(0);
    expect(measured.conversion).toBeNull();
    const funnel = computeFunnel(entrants, threeStages, flagWindows(NOW), flagWindows(NOW));
    expect(funnel[1]?.conversion).toBe(0);
    expect(funnel[2]?.conversion).toBeNull();
  });
});

describe("bottleneck flag rule (pure)", () => {
  const flag = flagWindows(NOW);
  const stages: StageSpec[] = [
    { key: "signed_up", label: "Signed up", maturityDays: 0 },
    { key: "posted", label: "Posted", maturityDays: 7 },
  ];

  /** `count` entrants entering at `entryAt`, of whom the first `reaching` reached stage 1. */
  function cohort(count: number, reaching: number, entryAt: Date): Entrant[] {
    return Array.from({ length: count }, (_, i) => ({
      entered: entryAt,
      reached: [true, i < reaching],
      times: [entryAt, null],
      voidFee: false,
    }));
  }
  // Entrants that entered 7 days before the windows (the maturity shift) land inside each window.
  const currentEntry = new Date(flag.start.getTime() - 7 * DAY_MS + DAY_MS);
  const previousEntry = new Date(flag.prevStart.getTime() - 7 * DAY_MS + DAY_MS);

  it("flags a 20-point drop with 40 matured entrants in each window", () => {
    const entrants = [...cohort(40, 16, currentEntry), ...cohort(40, 24, previousEntry)];
    const posted = computeFunnel(entrants, stages, flag, flag)[1];
    expect(posted?.flagged).toBe(true);
    expect(posted?.flagReason).toContain("down 20 pts");
  });

  it("does not flag the same drop with only 20 entrants in each window", () => {
    const entrants = [...cohort(20, 8, currentEntry), ...cohort(20, 12, previousEntry)];
    const posted = computeFunnel(entrants, stages, flag, flag)[1];
    expect(posted?.flagged).toBe(false);
    expect(posted?.flagReason).toBeNull();
  });
});
