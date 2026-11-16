import type { Prisma } from "../../generated/prisma/client.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type {
  AdminZoneRequestListQuery,
  AdminZoneRequestResponse,
  DecideZoneRequestInput,
} from "../zone/zone.schema.js";

const requestInclude = {
  tutor: {
    select: {
      id: true,
      accountId: true,
      name: true,
      zoneLimit: true,
      _count: { select: { zones: true } },
    },
  },
} satisfies Prisma.ZoneLimitRequestInclude;

type RequestRow = Prisma.ZoneLimitRequestGetPayload<{ include: typeof requestInclude }>;

function toResponse(row: RequestRow): AdminZoneRequestResponse {
  return {
    id: row.id,
    requestedLimit: row.requestedLimit,
    reason: row.reason,
    status: row.status,
    decisionNote: row.decisionNote,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    tutor: {
      id: row.tutor.id,
      name: row.tutor.name,
      zoneLimit: row.tutor.zoneLimit,
      zonesUsed: row.tutor._count.zones,
    },
  };
}

// Work queue: oldest first. Keyset pagination over (created_at, id).
export async function listAdminZoneRequests(query: AdminZoneRequestListQuery) {
  const where: Prisma.ZoneLimitRequestWhereInput = { status: query.status };
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    where.OR = [
      { createdAt: { gt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { gt: cursor.id } },
    ];
  }

  const rows = await prisma.zoneLimitRequest.findMany({
    where,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: query.limit + 1,
    include: requestInclude,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    requests: page.map(toResponse),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

export async function decideZoneRequest(
  requestId: string,
  input: DecideZoneRequestInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminZoneRequestResponse> {
  return prisma.$transaction(async (tx) => {
    // Lock the request first so two admins cannot decide the same row concurrently.
    await tx.$queryRaw`SELECT id FROM zone_limit_request WHERE id = ${requestId}::uuid FOR UPDATE`;
    const request = await tx.zoneLimitRequest.findUnique({
      where: { id: requestId },
      select: { id: true, tutorId: true, requestedLimit: true, status: true },
    });
    if (!request) {
      throw notFound("Zone limit request not found");
    }
    if (request.status !== "PENDING") {
      throw appError("ZoneRequestDecided", 409, "This request was already decided");
    }

    await tx.$queryRaw`SELECT id FROM tutor WHERE id = ${request.tutorId}::uuid FOR UPDATE`;
    const tutor = await tx.tutor.findUniqueOrThrow({
      where: { id: request.tutorId },
      select: { accountId: true, zoneLimit: true },
    });

    const approve = input.decision === "APPROVE";
    const approvedLimit = approve ? (input.approvedLimit ?? request.requestedLimit) : null;
    // A grant never shrinks an existing limit.
    const newLimit =
      approvedLimit === null ? tutor.zoneLimit : Math.max(tutor.zoneLimit, approvedLimit);
    const status = approve ? "APPROVED" : "DENIED";
    const decidedAt = new Date();

    if (approve && newLimit !== tutor.zoneLimit) {
      await tx.tutor.update({ where: { id: request.tutorId }, data: { zoneLimit: newLimit } });
    }

    const updated = await tx.zoneLimitRequest.update({
      where: { id: requestId },
      data: {
        status,
        decidedById: admin.accountId,
        decidedAt,
        decisionNote: input.note ?? null,
      },
      include: requestInclude,
    });

    await tx.auditLog.create({
      data: {
        actorAccountId: admin.accountId,
        action: "zone_limit_request.decide",
        entityType: "zone_limit_request",
        entityId: requestId,
        before: { status: "PENDING", zoneLimit: tutor.zoneLimit },
        after: { status, zoneLimit: newLimit, approvedLimit },
        ip: ip ?? null,
      },
    });

    // Payload carries no names, phone numbers or addresses.
    await tx.notificationLog.create({
      data: {
        eventType: "ZONE_LIMIT_DECIDED",
        recipientId: tutor.accountId,
        dedupeKey: `zone_limit_decided:${requestId}`,
        templateName: "zone_limit_decided",
        payload: {
          decision: approve ? "APPROVED" : "DENIED",
          zoneLimit: newLimit,
        },
      },
    });

    return toResponse(updated);
  });
}
