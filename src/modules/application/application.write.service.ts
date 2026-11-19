import { Prisma } from "../../generated/prisma/client.js";
import type {
  ApplicationStatus,
  AppNotificationKind,
  InitiatedBy,
  ListingStatus,
  ModerationStatus,
  NotificationEvent,
} from "../../generated/prisma/enums.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { COMMISSION_DEFAULT_PERCENT } from "../admin/settings.service.js";
import type { AuthContext } from "../auth/auth.schema.js";
import { computeAllowedActions, type Side, type TargetState } from "./application.read.service.js";
import { type ApplicationAction, FEE_DUE_IN_DAYS } from "./application.schema.js";

type Db = Prisma.TransactionClient;

const TUTOR_PROFILE_NOT_FOUND = "Tutor profile not found";
const STUDENT_PROFILE_NOT_FOUND = "Student profile not found";
const APPLICATION_NOT_FOUND = "Application not found";
const CLOSED_STATUSES: ApplicationStatus[] = ["CONFIRMED", "COMPLETED"];

// Past participles for the InvalidApplicationState message ("can no longer be <action>ed").
const PAST_TENSE: Record<ApplicationAction, string> = {
  confirm: "confirmed",
  reject: "rejected",
  withdraw: "withdrawn",
  reopen: "reopened",
  cancel: "cancelled",
  complete: "completed",
};

// Asks "would the application state alone allow this?" once the listing is ruled out as a blocker.
const OPEN_TARGET: TargetState = { status: "OPEN", closed: false, moderationStatus: "APPROVED" };

type AppRow = {
  id: string;
  requirementId: string | null;
  packageId: string | null;
  tutorId: string;
  studentId: string;
  initiatedBy: InitiatedBy;
  status: ApplicationStatus;
  appliedAt: Date;
  confirmedAt: Date | null;
};

type TargetRow = {
  status: ListingStatus;
  salary: number | null;
  moderationStatus: ModerationStatus | null;
};

type Parties = { tutorAccountId: string; studentAccountId: string };

type OutboxInput = {
  eventType: NotificationEvent;
  recipientId: string;
  applicationId: string;
  templateName: string;
  dedupeKey: string;
};

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function alreadyApplied(applicationId?: string) {
  return appError(
    "AlreadyApplied",
    409,
    "You have already applied",
    applicationId ? { applicationId } : undefined,
  );
}

function invalidState(action: ApplicationAction) {
  return appError(
    "InvalidApplicationState",
    409,
    `This application can no longer be ${PAST_TENSE[action]}`,
  );
}

function targetWhere(app: AppRow): Prisma.ApplicationWhereInput {
  return app.requirementId ? { requirementId: app.requirementId } : { packageId: app.packageId };
}

async function isClosed(tx: Db, where: Prisma.ApplicationWhereInput): Promise<boolean> {
  const count = await tx.application.count({
    where: { ...where, status: { in: CLOSED_STATUSES } },
  });
  return count > 0;
}

// Locks the listing row when the action decides something about it (confirm, reopen).
// `salary` is the money the placement fee is based on: a requirement's monthly salary, or a
// package's total price.
async function loadTarget(tx: Db, app: AppRow, lock: boolean): Promise<TargetRow> {
  const forUpdate = lock ? Prisma.sql`FOR UPDATE` : Prisma.empty;
  const [row] = app.requirementId
    ? await tx.$queryRaw<TargetRow[]>`
        SELECT status, salary, NULL::text AS "moderationStatus"
        FROM tuition_requirement
        WHERE id = ${app.requirementId}::uuid ${forUpdate}
      `
    : await tx.$queryRaw<TargetRow[]>`
        SELECT status, price AS salary, moderation_status AS "moderationStatus"
        FROM tuition_package
        WHERE id = ${app.packageId}::uuid ${forUpdate}
      `;
  if (!row) throw notFound("Listing not found");
  return row;
}

function toTargetState(row: TargetRow, closed: boolean): TargetState {
  return { status: row.status, closed, moderationStatus: row.moderationStatus };
}

// Same checks for confirm and reopen; each gives its own 409.
function assertListingOpen(target: TargetState) {
  if (target.status !== "OPEN") {
    throw appError("ListingNotOpen", 409, "This listing is no longer open");
  }
  if (target.closed) {
    throw appError("ApplicationClosed", 409, "This tuition is no longer taking applications");
  }
}

// Readiness comes from SQL tutor_missing_requirements(); never duplicate those checks here.
async function assertProfileComplete(tx: Db, tutorId: string) {
  const [row] = await tx.$queryRaw<{ missing: string[] }[]>`
    SELECT tutor_missing_requirements(${tutorId}::uuid) AS missing
  `;
  const missing = row?.missing ?? [];
  if (missing.length > 0) {
    throw appError("ProfileIncomplete", 403, "Complete your profile before applying", { missing });
  }
}

async function loadParties(tx: Db, tutorId: string, studentId: string): Promise<Parties> {
  const [row] = await tx.$queryRaw<{ tutorAccountId: string; studentAccountId: string }[]>`
    SELECT t.account_id AS "tutorAccountId", s.account_id AS "studentAccountId"
    FROM tutor t, student s
    WHERE t.id = ${tutorId}::uuid AND s.id = ${studentId}::uuid
  `;
  if (!row) throw notFound(APPLICATION_NOT_FOUND);
  return row;
}

function accountOf(side: Side, parties: Parties): string {
  return side === "TUTOR" ? parties.tutorAccountId : parties.studentAccountId;
}

function otherSide(side: Side): Side {
  return side === "TUTOR" ? "STUDENT" : "TUTOR";
}

async function enqueue(tx: Db, input: OutboxInput) {
  await tx.notificationLog.create({
    data: {
      eventType: input.eventType,
      recipientId: input.recipientId,
      applicationId: input.applicationId,
      templateName: input.templateName,
      dedupeKey: input.dedupeKey,
      payload: { applicationId: input.applicationId },
    },
  });
}

// In-app alert for the dashboard bell. Written in the same transaction as the status change.
async function alert(
  tx: Db,
  recipientId: string,
  kind: AppNotificationKind,
  applicationId: string,
) {
  await tx.appNotification.create({ data: { recipientId, kind, applicationId } });
}

// Alerts the other party of the caller, who is always a party to the application here.
async function alertCounterpart(
  tx: Db,
  app: AppRow,
  side: Side,
  kind: AppNotificationKind,
): Promise<void> {
  const parties = await loadParties(tx, app.tutorId, app.studentId);
  await alert(tx, accountOf(otherSide(side), parties), kind, app.id);
}

// The caller's side of the application, or null when the caller is not a party.
async function callerSide(tx: Db, account: AuthContext, app: AppRow): Promise<Side | null> {
  if (account.role === "TUTOR") {
    const tutor = await tx.tutor.findUnique({
      where: { accountId: account.accountId },
      select: { id: true },
    });
    return tutor?.id === app.tutorId ? "TUTOR" : null;
  }
  if (account.role === "STUDENT") {
    const student = await tx.student.findUnique({
      where: { accountId: account.accountId },
      select: { id: true },
    });
    return student?.id === app.studentId ? "STUDENT" : null;
  }
  return null;
}

export async function applyToRequirement(
  account: AuthContext,
  requirementId: string,
): Promise<string> {
  const tutor = await prisma.tutor.findUnique({
    where: { accountId: account.accountId },
    select: { id: true },
  });
  if (!tutor) throw notFound(TUTOR_PROFILE_NOT_FOUND);

  try {
    return await prisma.$transaction(async (tx) => {
      const [requirement] = await tx.$queryRaw<{ studentId: string; status: ListingStatus }[]>`
        SELECT student_id AS "studentId", status
        FROM tuition_requirement
        WHERE id = ${requirementId}::uuid
        FOR UPDATE
      `;
      if (!requirement || requirement.status === "DRAFT") {
        throw notFound("Requirement not found");
      }

      await assertProfileComplete(tx, tutor.id);

      if (requirement.status !== "OPEN") {
        throw appError("ListingNotOpen", 409, "This listing is no longer open");
      }
      const where = { requirementId };
      if (await isClosed(tx, where)) {
        throw appError("ApplicationClosed", 409, "This tuition is no longer taking applications");
      }

      const existing = await tx.application.findFirst({
        where: { tutorId: tutor.id, requirementId },
        select: { id: true },
      });
      if (existing) throw alreadyApplied(existing.id);

      const created = await tx.application.create({
        data: {
          requirementId,
          tutorId: tutor.id,
          studentId: requirement.studentId,
          initiatedBy: "TUTOR",
          status: "PENDING",
        },
      });

      const parties = await loadParties(tx, tutor.id, requirement.studentId);
      await enqueue(tx, {
        eventType: "APPLICATION_RECEIVED",
        recipientId: parties.studentAccountId,
        applicationId: created.id,
        templateName: "application_received",
        dedupeKey: `application_received:${created.id}:${created.appliedAt.getTime()}`,
      });
      await alert(tx, parties.studentAccountId, "APPLICATION_RECEIVED", created.id);
      return created.id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Race: a concurrent apply won the (tutor_id, requirement_id) unique index.
      const existing = await prisma.application.findFirst({
        where: { tutorId: tutor.id, requirementId },
        select: { id: true },
      });
      throw alreadyApplied(existing?.id);
    }
    throw error;
  }
}

export async function requestPackage(account: AuthContext, packageId: string): Promise<string> {
  const student = await prisma.student.findUnique({
    where: { accountId: account.accountId },
    select: { id: true },
  });
  if (!student) throw notFound(STUDENT_PROFILE_NOT_FOUND);

  try {
    return await prisma.$transaction(async (tx) => {
      // Lock the package only; locking the tutor row would contend with zone and profile writes.
      const [pkg] = await tx.$queryRaw<
        {
          tutorId: string;
          status: ListingStatus;
          moderationStatus: ModerationStatus;
          isListed: boolean;
        }[]
      >`
        SELECT p.tutor_id AS "tutorId", p.status, p.moderation_status AS "moderationStatus",
               t.is_listed AS "isListed"
        FROM tuition_package p
        JOIN tutor t ON t.id = p.tutor_id
        WHERE p.id = ${packageId}::uuid
        FOR UPDATE OF p
      `;
      if (pkg?.moderationStatus !== "APPROVED" || !pkg.isListed) {
        throw notFound("Package not found");
      }

      const closed = await isClosed(tx, { packageId });
      assertListingOpen({
        status: pkg.status,
        closed,
        moderationStatus: pkg.moderationStatus,
      });

      const existing = await tx.application.findFirst({
        where: { studentId: student.id, packageId },
        select: { id: true },
      });
      if (existing) throw alreadyApplied(existing.id);

      const created = await tx.application.create({
        data: {
          packageId,
          tutorId: pkg.tutorId,
          studentId: student.id,
          initiatedBy: "STUDENT",
          status: "PENDING",
        },
      });

      const parties = await loadParties(tx, pkg.tutorId, student.id);
      await enqueue(tx, {
        eventType: "APPLICATION_RECEIVED",
        recipientId: parties.tutorAccountId,
        applicationId: created.id,
        templateName: "application_received",
        dedupeKey: `application_received:${created.id}:${created.appliedAt.getTime()}`,
      });
      await alert(tx, parties.tutorAccountId, "PACKAGE_REQUESTED", created.id);
      return created.id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Race: a concurrent request won the (student_id, package_id) unique index.
      const existing = await prisma.application.findFirst({
        where: { studentId: student.id, packageId },
        select: { id: true },
      });
      throw alreadyApplied(existing?.id);
    }
    throw error;
  }
}

export async function transitionApplication(
  account: AuthContext,
  id: string,
  action: ApplicationAction,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const [app] = await tx.$queryRaw<AppRow[]>`
      SELECT id, requirement_id AS "requirementId", package_id AS "packageId",
             tutor_id AS "tutorId", student_id AS "studentId", initiated_by AS "initiatedBy",
             status, applied_at AS "appliedAt", confirmed_at AS "confirmedAt"
      FROM application
      WHERE id = ${id}::uuid
      FOR UPDATE
    `;
    if (!app) throw notFound(APPLICATION_NOT_FOUND);

    const side = await callerSide(tx, account, app);
    if (!side) throw notFound(APPLICATION_NOT_FOUND);

    // Lock the listing before counting closure so two confirms on one listing serialise.
    const locksTarget = action === "confirm" || action === "reopen";
    const target = await loadTarget(tx, app, locksTarget);
    const targetState = toTargetState(target, await isClosed(tx, targetWhere(app)));

    const allowed = computeAllowedActions(app, side, targetState);
    if (!allowed.includes(action)) {
      // A reopen blocked only by the listing gets the listing's own error, not the generic one.
      if (computeAllowedActions(app, side, OPEN_TARGET).includes(action)) {
        assertListingOpen(targetState);
      }
      throw invalidState(action);
    }
    if (action === "confirm") assertListingOpen(targetState);
    if (action === "reopen" && app.initiatedBy === "TUTOR") {
      await assertProfileComplete(tx, app.tutorId);
    }

    switch (action) {
      case "confirm": {
        await tx.application.update({
          where: { id: app.id },
          data: { status: "CONFIRMED", confirmedAt: new Date() },
        });
        // Every other pending application on this listing is auto-rejected. Their applicants
        // are the tutor (requirement) or the student (package).
        const pending = await tx.application.findMany({
          where: { ...targetWhere(app), status: "PENDING", id: { not: app.id } },
          select: {
            id: true,
            tutor: { select: { accountId: true } },
            student: { select: { accountId: true } },
          },
        });
        if (pending.length > 0) {
          await tx.application.updateMany({
            where: { id: { in: pending.map((row) => row.id) } },
            data: { status: "REJECTED" },
          });
          const filled: Prisma.AppNotificationCreateManyInput[] = pending.map((row) => ({
            recipientId: app.requirementId ? row.tutor.accountId : row.student.accountId,
            kind: "LISTING_FILLED",
            applicationId: row.id,
          }));
          await tx.appNotification.createMany({ data: filled });
        }

        // Placement fee = commission_percent of target.salary: the monthly salary for a
        // requirement, the TOTAL package price for a package. A missing row (or null value) uses
        // COMMISSION_DEFAULT_PERCENT; an explicit 0 is skipped, as is a null salary.
        const [setting] = await tx.$queryRaw<{ pct: Prisma.Decimal | null }[]>`
          SELECT (value #>> '{}')::numeric AS pct
          FROM platform_setting
          WHERE key = 'commission_percent'
        `;
        const pct = Number(setting?.pct ?? COMMISSION_DEFAULT_PERCENT);
        if (target.salary !== null && pct > 0) {
          await tx.$executeRaw`
            INSERT INTO platform_fee (id, tutor_id, application_id, fee_type, amount_due, due_date, status, updated_at)
            VALUES (
              gen_random_uuid(),
              ${app.tutorId}::uuid,
              ${app.id}::uuid,
              'PLACEMENT'::"FeeType",
              ROUND(${target.salary}::numeric * ${pct}::numeric / 100, 2),
              (now() AT TIME ZONE 'Asia/Dhaka')::date + ${FEE_DUE_IN_DAYS}::int,
              'DUE'::"FeeStatus",
              now()
            )
          `;
        }

        const parties = await loadParties(tx, app.tutorId, app.studentId);
        await enqueue(tx, {
          eventType: "APPLICATION_CONFIRMED",
          recipientId: accountOf(app.initiatedBy, parties),
          applicationId: app.id,
          templateName: "application_confirmed",
          dedupeKey: `application_confirmed:${app.id}`,
        });
        await alert(tx, accountOf(otherSide(side), parties), "APPLICATION_ACCEPTED", app.id);
        return;
      }

      case "reject":
        await tx.application.update({ where: { id: app.id }, data: { status: "REJECTED" } });
        await alertCounterpart(tx, app, side, "APPLICATION_DECLINED");
        return;

      case "withdraw":
        await tx.application.update({ where: { id: app.id }, data: { status: "WITHDRAWN" } });
        await alertCounterpart(tx, app, side, "APPLICATION_WITHDRAWN");
        return;

      case "reopen": {
        const reopened = await tx.application.update({
          where: { id: app.id },
          data: { status: "PENDING", appliedAt: new Date() },
        });

        // New appliedAt means a new dedupe key, so the counterparty gets a fresh notice.
        const parties = await loadParties(tx, app.tutorId, app.studentId);
        await enqueue(tx, {
          eventType: "APPLICATION_RECEIVED",
          recipientId: accountOf(otherSide(app.initiatedBy), parties),
          applicationId: app.id,
          templateName: "application_received",
          dedupeKey: `application_received:${app.id}:${reopened.appliedAt.getTime()}`,
        });
        await alert(tx, accountOf(otherSide(side), parties), "APPLICATION_REOPENED", app.id);
        return;
      }

      case "cancel":
        await tx.application.update({
          where: { id: app.id },
          data: { status: "CANCELLED", endedAt: new Date() },
        });
        await tx.$executeRaw`
          UPDATE platform_fee
          SET status = 'VOID'::"FeeStatus", updated_at = now()
          WHERE application_id = ${app.id}::uuid
            AND fee_type = 'PLACEMENT'::"FeeType"
            AND status = 'DUE'::"FeeStatus"
            AND amount_paid = 0
        `;
        await alertCounterpart(tx, app, side, "APPLICATION_CANCELLED");
        return;

      case "complete":
        await tx.application.update({
          where: { id: app.id },
          data: { status: "COMPLETED", endedAt: new Date() },
        });
        await alertCounterpart(tx, app, side, "APPLICATION_COMPLETED");
        return;
    }
  });
}
