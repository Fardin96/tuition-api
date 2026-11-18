import { Prisma } from "../../generated/prisma/client.js";
import { FeeStatus } from "../../generated/prisma/enums.js";
import { writeAudit } from "../../lib/admin.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { FEE_UNPAID_AFTER_DAYS } from "../application/application.schema.js";
import type {
  AdminFeeDetailResponse,
  AdminFeeListQuery,
  AdminFeeResponse,
  CreateFeeInput,
  RecordPaymentInput,
  ReversePaymentInput,
  UpdateFeeInput,
} from "./fees.schema.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_FEE_STATUSES: FeeStatus[] = [FeeStatus.DUE, FeeStatus.PARTIAL];

// Today's date in Asia/Dhaka (UTC+6, no DST), as YYYY-MM-DD.
export function dhakaToday(): string {
  return new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
}

// dueDate is a DATE column, stored as UTC midnight.
function dateOnly(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

const feeInclude = {
  tutor: { select: { id: true, name: true } },
  application: {
    select: {
      id: true,
      status: true,
      confirmedAt: true,
      packageId: true,
      package: { select: { title: true } },
      student: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.PlatformFeeInclude;

const detailInclude = {
  ...feeInclude,
  payments: {
    orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }],
    include: {
      recordedBy: { select: { name: true } },
      reversals: { select: { amount: true } },
    },
  },
  attempts: {
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 20,
    select: {
      tranId: true,
      status: true,
      totalAmount: true,
      failureReason: true,
      createdAt: true,
      settledAt: true,
    },
  },
} satisfies Prisma.PlatformFeeInclude;

type FeeRow = Prisma.PlatformFeeGetPayload<{ include: typeof feeInclude }>;
type FeeDetailRow = Prisma.PlatformFeeGetPayload<{ include: typeof detailInclude }>;

function sumOf(amounts: Prisma.Decimal[]): Prisma.Decimal {
  return amounts.reduce((sum, a) => sum.plus(a), new Prisma.Decimal(0));
}

function toAdminFee(row: FeeRow, today: string, now: Date): AdminFeeResponse {
  const open = OPEN_FEE_STATUSES.includes(row.status);
  const dueDate = row.dueDate.toISOString().slice(0, 10);
  const { confirmedAt } = row.application;
  return {
    id: row.id,
    feeType: row.feeType,
    status: row.status,
    amountDue: row.amountDue.toFixed(2),
    amountPaid: row.amountPaid.toFixed(2),
    remaining: row.amountDue.minus(row.amountPaid).toFixed(2),
    dueDate,
    overdue: open && dueDate < today,
    unpaid:
      open &&
      confirmedAt !== null &&
      confirmedAt.getTime() + FEE_UNPAID_AFTER_DAYS * DAY_MS < now.getTime(),
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    tutor: { id: row.tutor.id, name: row.tutor.name },
    student: { id: row.application.student.id, name: row.application.student.name },
    application: {
      id: row.application.id,
      status: row.application.status,
      kind: row.application.packageId ? "PACKAGE" : "REQUIREMENT",
      confirmedAt,
      packageTitle: row.application.package?.title ?? null,
    },
  };
}

function toAdminFeeDetail(row: FeeDetailRow): AdminFeeDetailResponse {
  const now = new Date();
  return {
    ...toAdminFee(row, dhakaToday(), now),
    payments: row.payments.map((p) => ({
      id: p.id,
      kind: p.kind,
      amount: p.amount.toFixed(2),
      method: p.method,
      txnReference: p.txnReference,
      reason: p.reason,
      receivedAt: p.receivedAt,
      createdAt: p.createdAt,
      recordedByName: p.recordedBy?.name ?? null,
      reversesPaymentId: p.reversesPaymentId,
      reversedAmount: sumOf(p.reversals.map((r) => r.amount)).toFixed(2),
    })),
    attempts: row.attempts.map((a) => ({
      tranId: a.tranId,
      status: a.status,
      totalAmount: a.totalAmount.toFixed(2),
      failureReason: a.failureReason,
      createdAt: a.createdAt,
      settledAt: a.settledAt,
    })),
  };
}

// Re-reads the fee after a write, so status and amountPaid reflect the ledger trigger.
async function readFee(db: Prisma.TransactionClient, feeId: string) {
  const row = await db.platformFee.findUnique({ where: { id: feeId }, include: detailInclude });
  if (!row) throw notFound("Fee not found");
  return toAdminFeeDetail(row);
}

// Serialises ledger writes and status changes on one fee.
async function lockFee(tx: Prisma.TransactionClient, feeId: string) {
  await tx.$queryRaw`SELECT id FROM platform_fee WHERE id = ${feeId}::uuid FOR UPDATE`;
}

export async function createFee(
  input: CreateFeeInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminFeeDetailResponse> {
  return prisma.$transaction(async (tx) => {
    // Locking the application keeps placement-fee creation in step with confirm and cancel.
    await tx.$queryRaw`SELECT id FROM application WHERE id = ${input.applicationId}::uuid FOR UPDATE`;
    const application = await tx.application.findUnique({
      where: { id: input.applicationId },
      select: { id: true, tutorId: true, status: true },
    });
    if (!application) {
      throw notFound("Application not found");
    }
    if (application.status !== "CONFIRMED" && application.status !== "COMPLETED") {
      throw appError(
        "InvalidFeeState",
        409,
        "Fees can only be added to confirmed or completed applications",
      );
    }
    if (input.feeType === "PLACEMENT") {
      const existing = await tx.platformFee.findFirst({
        where: { applicationId: application.id, feeType: "PLACEMENT", status: { not: "VOID" } },
        select: { id: true },
      });
      if (existing) {
        throw appError("InvalidFeeState", 409, "This application already has a placement fee");
      }
    }

    const amountDue = new Prisma.Decimal(input.amountDue).toFixed(2);
    const fee = await tx.platformFee.create({
      data: {
        tutorId: application.tutorId,
        applicationId: application.id,
        feeType: input.feeType,
        amountDue,
        dueDate: dateOnly(input.dueDate),
        note: input.note ?? null,
      },
    });

    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "fee.create",
      entityType: "platform_fee",
      entityId: fee.id,
      after: { feeType: input.feeType, amountDue, dueDate: input.dueDate },
      ip: ip ?? null,
    });
    return readFee(tx, fee.id);
  });
}

// Keyset over (createdAt desc, id desc). Overdue uses the same Dhaka "today" as the response flag.
export async function listFees(query: AdminFeeListQuery): Promise<{
  fees: AdminFeeResponse[];
  nextCursor: string | null;
}> {
  const today = dhakaToday();
  const todayDate = dateOnly(today);
  const clauses: Prisma.PlatformFeeWhereInput[] = [];

  if (query.status) clauses.push({ status: query.status });
  if (query.tutorId) clauses.push({ tutorId: query.tutorId });
  if (query.overdue === "true") {
    clauses.push({ status: { in: OPEN_FEE_STATUSES }, dueDate: { lt: todayDate } });
  } else if (query.overdue === "false") {
    clauses.push({
      OR: [{ status: { notIn: OPEN_FEE_STATUSES } }, { dueDate: { gte: todayDate } }],
    });
  }
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    clauses.push({
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ],
    });
  }

  const rows = await prisma.platformFee.findMany({
    where: { AND: clauses },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    include: feeInclude,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  const now = new Date();

  return {
    fees: page.map((row) => toAdminFee(row, today, now)),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

export async function getFee(feeId: string): Promise<AdminFeeDetailResponse> {
  const row = await prisma.platformFee.findUnique({ where: { id: feeId }, include: detailInclude });
  if (!row) throw notFound("Fee not found");
  return toAdminFeeDetail(row);
}

export async function updateFee(
  feeId: string,
  input: UpdateFeeInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminFeeDetailResponse> {
  return prisma.$transaction(async (tx) => {
    await lockFee(tx, feeId);
    const fee = await tx.platformFee.findUnique({
      where: { id: feeId },
      select: { status: true, amountPaid: true, dueDate: true, note: true },
    });
    if (!fee) {
      throw notFound("Fee not found");
    }
    if (fee.status === "VOID") {
      throw appError("InvalidFeeState", 409, "A void fee cannot be changed");
    }
    if (input.status === "WAIVED" && !OPEN_FEE_STATUSES.includes(fee.status)) {
      throw appError("InvalidFeeState", 409, "Only due or partly paid fees can be waived");
    }
    if (input.status === "VOID") {
      if (fee.status === "PAID") {
        throw appError("InvalidFeeState", 409, "A paid fee cannot be voided");
      }
      if (fee.amountPaid.greaterThan(0)) {
        throw appError("InvalidFeeState", 409, "Reverse the payments before voiding this fee");
      }
    }

    const data: Prisma.PlatformFeeUpdateInput = {};
    const before: Record<string, string | null> = {};
    const after: Record<string, string | null> = {};
    if (input.dueDate !== undefined) {
      data.dueDate = dateOnly(input.dueDate);
      before.dueDate = fee.dueDate.toISOString().slice(0, 10);
      after.dueDate = input.dueDate;
    }
    if (input.note !== undefined) {
      data.note = input.note;
      before.note = fee.note;
      after.note = input.note;
    }
    if (input.status !== undefined) {
      data.status = input.status;
      before.status = fee.status;
      after.status = input.status;
    }

    await tx.platformFee.update({ where: { id: feeId }, data });
    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "fee.update",
      entityType: "platform_fee",
      entityId: feeId,
      before,
      after,
      ip: ip ?? null,
    });
    return readFee(tx, feeId);
  });
}

export async function recordPayment(
  feeId: string,
  input: RecordPaymentInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminFeeDetailResponse> {
  return prisma.$transaction(async (tx) => {
    await lockFee(tx, feeId);
    const fee = await tx.platformFee.findUnique({
      where: { id: feeId },
      select: { status: true, amountDue: true, amountPaid: true },
    });
    if (!fee) {
      throw notFound("Fee not found");
    }
    if (!OPEN_FEE_STATUSES.includes(fee.status)) {
      throw appError("InvalidFeeState", 409, "This fee does not accept payments");
    }

    const remaining = fee.amountDue.minus(fee.amountPaid);
    const amount = new Prisma.Decimal(input.amount);
    if (amount.greaterThan(remaining)) {
      throw appError(
        "InvalidFeeState",
        409,
        `Payment is more than the ৳${remaining.toFixed(2)} still due`,
      );
    }

    // Same rule as the fee_payment_before_insert trigger, checked first to return a clear 409.
    if (input.txnReference) {
      const earlier = await tx.feePayment.findMany({
        where: { kind: "PAYMENT", method: "CASH", txnReference: input.txnReference },
        select: { amount: true, reversals: { select: { amount: true } } },
      });
      const taken = earlier.some((p) =>
        p.amount.greaterThan(sumOf(p.reversals.map((r) => r.amount))),
      );
      if (taken) {
        throw appError("InvalidFeeState", 409, "This transaction reference is already recorded");
      }
    }

    const payment = await tx.feePayment.create({
      data: {
        feeId,
        kind: "PAYMENT",
        amount: amount.toFixed(2),
        method: "CASH",
        txnReference: input.txnReference ?? null,
        receivedAt: input.receivedAt ? new Date(input.receivedAt) : new Date(),
        recordedById: admin.accountId,
      },
    });

    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "fee.payment",
      entityType: "platform_fee",
      entityId: feeId,
      after: { amount: amount.toFixed(2), paymentId: payment.id },
      ip: ip ?? null,
    });
    return readFee(tx, feeId);
  });
}

export async function reversePayment(
  paymentId: string,
  input: ReversePaymentInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminFeeDetailResponse> {
  return prisma.$transaction(async (tx) => {
    const original = await tx.feePayment.findUnique({
      where: { id: paymentId },
      select: { id: true, feeId: true, kind: true, amount: true, method: true },
    });
    if (!original) {
      throw notFound("Payment not found");
    }
    if (original.kind === "REVERSAL") {
      throw appError("InvalidFeeState", 409, "A reversal cannot be reversed");
    }

    await lockFee(tx, original.feeId);
    const fee = await tx.platformFee.findUniqueOrThrow({
      where: { id: original.feeId },
      select: { status: true },
    });
    if (fee.status === "WAIVED" || fee.status === "VOID") {
      throw appError("InvalidFeeState", 409, "Payments on a waived or void fee cannot be reversed");
    }

    const reversals = await tx.feePayment.findMany({
      where: { reversesPaymentId: paymentId },
      select: { amount: true },
    });
    const left = original.amount.minus(sumOf(reversals.map((r) => r.amount)));
    const amount = input.amount === undefined ? left : new Prisma.Decimal(input.amount);
    if (amount.lessThanOrEqualTo(0) || amount.greaterThan(left)) {
      throw appError(
        "InvalidFeeState",
        409,
        "That is more than is left to reverse on this payment",
      );
    }

    const reversal = await tx.feePayment.create({
      data: {
        feeId: original.feeId,
        kind: "REVERSAL",
        reversesPaymentId: paymentId,
        amount: amount.toFixed(2),
        method: original.method,
        reason: input.reason,
        receivedAt: new Date(),
        recordedById: admin.accountId,
      },
    });

    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "payment.reverse",
      entityType: "fee_payment",
      entityId: paymentId,
      after: { reversalId: reversal.id, amount: amount.toFixed(2), reason: input.reason },
      ip: ip ?? null,
    });
    return readFee(tx, original.feeId);
  });
}
