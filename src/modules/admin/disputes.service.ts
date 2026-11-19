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
  AdminDisputeDetailResponse,
  AdminDisputeListQuery,
  AdminDisputePageResponse,
  AdminDisputeResponse,
} from "./disputes.schema.js";

const disputeInclude = {
  raisedBy: partyInclude,
  against: partyInclude,
  handledBy: handlerInclude,
} as const;

type DisputeRow = Prisma.DisputeGetPayload<{ include: typeof disputeInclude }>;

function toAdminDispute(row: DisputeRow): AdminDisputeResponse {
  return {
    id: row.id,
    applicationId: row.applicationId,
    type: row.type,
    details: row.details,
    status: row.status,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    resolutionNote: row.resolutionNote,
    raisedBy: toAdminParty(row.raisedBy),
    against: toAdminParty(row.against),
    handledBy: toHandler(row.handledBy),
  };
}

// queue=open is the work queue (oldest first); queue=closed is history (newest first).
export async function listAdminDisputes(
  query: AdminDisputeListQuery,
): Promise<AdminDisputePageResponse> {
  const { where, orderBy } = caseQueuePage(query.queue, query.cursor);
  const rows = await prisma.dispute.findMany({
    where: {
      ...where,
      ...(query.type ? { type: query.type } : {}),
      ...(query.applicationId ? { applicationId: query.applicationId } : {}),
    },
    orderBy,
    take: query.limit + 1,
    include: disputeInclude,
  });

  const { page, nextCursor } = sliceCasePage(rows, query.limit);
  return { disputes: page.map(toAdminDispute), nextCursor };
}

export async function getAdminDispute(id: string): Promise<AdminDisputeDetailResponse> {
  const row = await prisma.dispute.findUnique({ where: { id }, include: disputeInclude });
  if (!row) throw notFound("Dispute not found");

  const [application, otherOpenDisputes] = await Promise.all([
    prisma.application.findUniqueOrThrow({
      where: { id: row.applicationId },
      select: {
        id: true,
        status: true,
        confirmedAt: true,
        endedAt: true,
        tutorId: true,
        studentId: true,
      },
    }),
    prisma.dispute.count({
      where: {
        applicationId: row.applicationId,
        id: { not: row.id },
        status: { in: [...OPEN_STATUSES] },
      },
    }),
  ]);

  return { ...toAdminDispute(row), application, otherOpenDisputes };
}

export async function actOnDispute(
  id: string,
  input: CaseActionInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminDisputeDetailResponse> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM dispute WHERE id = ${id}::uuid FOR UPDATE`;
    const current = await tx.dispute.findUnique({
      where: { id },
      select: { status: true, handledById: true },
    });
    if (!current) throw notFound("Dispute not found");

    const change = planCaseChange(current, input, admin.accountId);
    await tx.dispute.update({ where: { id }, data: change.data });
    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: `dispute.${change.verb}`,
      entityType: "dispute",
      entityId: id,
      before: { status: current.status, handledBy: current.handledById },
      after: {
        status: change.data.status,
        handledBy: admin.accountId,
        ...(input.note ? { note: input.note } : {}),
      },
      ip,
    });
  });
  return getAdminDispute(id);
}
