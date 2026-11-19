import type { Prisma } from "../../generated/prisma/client.js";
import { writeAudit } from "../../lib/admin.js";
import { notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import {
  type CaseActionInput,
  caseQueuePage,
  handlerInclude,
  OPEN_STATUSES,
  partyInclude,
  planCaseChange,
  sliceCasePage,
  toAdminParty,
  toHandler,
} from "./cases.js";
import type {
  AdminReportDetailResponse,
  AdminReportListQuery,
  AdminReportPageResponse,
  AdminReportResponse,
} from "./reports.schema.js";

const reportInclude = {
  reporter: partyInclude,
  target: partyInclude,
  handledBy: handlerInclude,
} as const;

type ReportRow = Prisma.ReportGetPayload<{ include: typeof reportInclude }>;

function toAdminReport(row: ReportRow): AdminReportResponse {
  return {
    id: row.id,
    category: row.category,
    details: row.details,
    status: row.status,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    resolutionNote: row.resolutionNote,
    reporter: toAdminParty(row.reporter),
    target: toAdminParty(row.target),
    applicationId: row.applicationId,
    handledBy: toHandler(row.handledBy),
  };
}

// queue=open is the work queue (oldest first); queue=closed is history (newest first).
export async function listAdminReports(
  query: AdminReportListQuery,
): Promise<AdminReportPageResponse> {
  const { where, orderBy } = caseQueuePage(query.queue, query.cursor);
  const rows = await prisma.report.findMany({
    where: {
      ...where,
      ...(query.category ? { category: query.category } : {}),
      ...(query.targetAccountId ? { targetAccountId: query.targetAccountId } : {}),
    },
    orderBy,
    take: query.limit + 1,
    include: reportInclude,
  });

  const { page, nextCursor } = sliceCasePage(rows, query.limit);
  return { reports: page.map(toAdminReport), nextCursor };
}

export async function getAdminReport(id: string): Promise<AdminReportDetailResponse> {
  const row = await prisma.report.findUnique({ where: { id }, include: reportInclude });
  if (!row) throw notFound("Report not found");

  const [targetOpenReports, targetReportCount, block, application] = await Promise.all([
    prisma.report.count({
      where: { targetAccountId: row.targetAccountId, status: { in: [...OPEN_STATUSES] } },
    }),
    prisma.report.count({ where: { targetAccountId: row.targetAccountId } }),
    prisma.accountBlock.findFirst({
      where: { accountId: row.targetAccountId, unblockedAt: null },
      select: { reason: true, blockedAt: true },
    }),
    row.applicationId
      ? prisma.application.findUnique({
          where: { id: row.applicationId },
          select: { id: true, status: true, confirmedAt: true },
        })
      : null,
  ]);

  return {
    ...toAdminReport(row),
    targetOpenReports,
    targetReportCount,
    targetActiveBlock: block,
    application,
  };
}

export async function actOnReport(
  id: string,
  input: CaseActionInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminReportDetailResponse> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM report WHERE id = ${id}::uuid FOR UPDATE`;
    const current = await tx.report.findUnique({
      where: { id },
      select: { status: true, handledById: true },
    });
    if (!current) throw notFound("Report not found");

    const change = planCaseChange(current, input, admin.accountId);
    await tx.report.update({ where: { id }, data: change.data });
    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: `report.${change.verb}`,
      entityType: "report",
      entityId: id,
      before: { status: current.status, handledBy: current.handledById },
      after: {
        status: change.data.status,
        handledBy: admin.accountId,
        ...(change.data.resolutionNote ? { note: change.data.resolutionNote } : {}),
      },
      ip,
    });
  });
  return getAdminReport(id);
}
