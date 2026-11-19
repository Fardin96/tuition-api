import { Prisma } from "../../generated/prisma/client.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type { AuthContext } from "../auth/auth.schema.js";
import type {
  CreateReportInput,
  MyReportListQuery,
  MyReportPageResponse,
  MyReportResponse,
} from "./report.schema.js";

const ACCOUNT_NOT_FOUND = "Account not found";
const APPLICATION_NOT_FOUND = "Application not found";
const ALREADY_OPEN = "You already have an open report about this account.";
// The one-open-report-per-pair index. Any unique violation on insert can only come from it.
const ONE_OPEN_INDEX = "report_one_open_per_pair";

const reportInclude = {
  target: {
    select: {
      id: true,
      role: true,
      student: { select: { name: true } },
      tutor: { select: { name: true } },
    },
  },
} as const;

type ReportRow = Prisma.ReportGetPayload<{ include: typeof reportInclude }>;

function toMyReport(row: ReportRow): MyReportResponse {
  const closed = row.status === "RESOLVED" || row.status === "DISMISSED";
  return {
    id: row.id,
    category: row.category,
    details: row.details,
    status: row.status,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    resolutionNote: closed ? row.resolutionNote : null,
    target: {
      accountId: row.target.id,
      role: row.target.role,
      name: row.target.tutor?.name ?? row.target.student?.name ?? null,
    },
    applicationId: row.applicationId,
  };
}

function isOpenReportConflict(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return true;
  const text = err instanceof Error ? err.message : "";
  return text.includes(ONE_OPEN_INDEX) || text.includes("unique_violation");
}

export async function createReport(
  caller: AuthContext,
  input: CreateReportInput,
): Promise<MyReportResponse> {
  if (input.targetAccountId === caller.accountId) {
    throw appError("ValidationError", 400, "You can't report yourself.");
  }

  // With an application the caller must be a party; a missing target is the other party.
  let targetAccountId = input.targetAccountId;
  if (input.applicationId) {
    const application = await prisma.application.findUnique({
      where: { id: input.applicationId },
      select: { tutor: { select: { accountId: true } }, student: { select: { accountId: true } } },
    });
    const parties = application ? [application.tutor.accountId, application.student.accountId] : [];
    if (!parties.includes(caller.accountId)) throw notFound(APPLICATION_NOT_FOUND);
    targetAccountId ??= parties.find((id) => id !== caller.accountId);
    if (!targetAccountId || !parties.includes(targetAccountId)) {
      throw notFound(APPLICATION_NOT_FOUND);
    }
  }
  if (!targetAccountId) throw appError("ValidationError", 400, "Pick who you're reporting.");

  const target = await prisma.account.findUnique({
    where: { id: targetAccountId },
    select: { role: true, status: true },
  });
  if (!target || target.status === "DELETED") throw notFound(ACCOUNT_NOT_FOUND);
  if (target.role === "ADMIN") {
    throw appError("ReportNotAllowed", 409, "This account can't be reported.");
  }

  const open = await prisma.report.findFirst({
    where: {
      reporterId: caller.accountId,
      targetAccountId,
      status: { in: ["OPEN", "UNDER_REVIEW"] },
    },
    select: { id: true },
  });
  if (open) throw appError("ReportExists", 409, ALREADY_OPEN);

  try {
    const row = await prisma.report.create({
      data: {
        reporterId: caller.accountId,
        targetAccountId,
        applicationId: input.applicationId ?? null,
        category: input.category,
        details: input.details,
      },
      include: reportInclude,
    });
    return toMyReport(row);
  } catch (err) {
    if (isOpenReportConflict(err)) throw appError("ReportExists", 409, ALREADY_OPEN);
    throw err;
  }
}

export async function listMyReports(
  caller: AuthContext,
  query: MyReportListQuery,
): Promise<MyReportPageResponse> {
  const where: Prisma.ReportWhereInput = { reporterId: caller.accountId };
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    where.OR = [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ];
  }

  const rows = await prisma.report.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    include: reportInclude,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    reports: page.map(toMyReport),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}
