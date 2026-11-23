import type { Prisma } from "../../generated/prisma/client.js";
import { writeAudit } from "../../lib/admin.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { packageInclude, toPackageResponse } from "../package/package.service.js";
import type {
  AdminPackageListQuery,
  AdminPackagePageResponse,
  AdminPackageResponse,
  ModeratePackageInput,
} from "./packages.schema.js";

// Same include students get, with the tutor's verification status added for the review.
const adminInclude = {
  ...packageInclude,
  tutor: { select: { ...packageInclude.tutor.select, verificationStatus: true } },
} as const;

type AdminRow = Prisma.TuitionPackageGetPayload<{ include: typeof adminInclude }>;

async function toAdminPackage(row: AdminRow): Promise<AdminPackageResponse> {
  // closed is always false here: the moderation view does not show application state.
  const pkg = await toPackageResponse(row, false, null);
  return {
    ...pkg,
    moderationNote: row.moderationNote,
    updatedAt: row.updatedAt,
    tutor: {
      ...pkg.tutor,
      verificationStatus: row.tutor.verificationStatus,
      isListed: row.tutor.isListed,
    },
  };
}

// PENDING is a work queue (oldest first). APPROVED and REJECTED are history (newest first).
// Both use keyset pagination over (created_at, id).
export async function listAdminPackages(
  query: AdminPackageListQuery,
): Promise<AdminPackagePageResponse> {
  const queue = query.moderationStatus === "PENDING";
  const where: Prisma.TuitionPackageWhereInput = { moderationStatus: query.moderationStatus };
  if (query.status) where.status = query.status;

  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    where.OR = queue
      ? [
          { createdAt: { gt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { gt: cursor.id } },
        ]
      : [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ];
  }

  const order: Prisma.SortOrder = queue ? "asc" : "desc";
  const rows = await prisma.tuitionPackage.findMany({
    where,
    orderBy: [{ createdAt: order }, { id: order }],
    take: query.limit + 1,
    include: adminInclude,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    packages: await Promise.all(page.map(toAdminPackage)),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

export async function getAdminPackage(id: string): Promise<AdminPackageResponse> {
  const row = await prisma.tuitionPackage.findUnique({ where: { id }, include: adminInclude });
  if (!row) throw notFound("Package not found");
  return await toAdminPackage(row);
}

export async function moderatePackage(
  id: string,
  input: ModeratePackageInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminPackageResponse> {
  return prisma.$transaction(async (tx) => {
    // Lock the package first so two admins cannot decide it at the same time.
    await tx.$queryRaw`SELECT id FROM tuition_package WHERE id = ${id}::uuid FOR UPDATE`;
    const current = await tx.tuitionPackage.findUnique({
      where: { id },
      select: { moderationStatus: true },
    });
    if (!current) throw notFound("Package not found");
    if (current.moderationStatus !== "PENDING") {
      throw appError("PackageAlreadyModerated", 409, "This package was already reviewed");
    }

    const moderationStatus = input.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    const note = input.note ?? null;
    const row = await tx.tuitionPackage.update({
      where: { id },
      data: { moderationStatus, moderationNote: note },
      include: adminInclude,
    });

    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "package.moderate",
      entityType: "tuition_package",
      entityId: id,
      before: { moderationStatus: "PENDING" },
      after: { moderationStatus, note },
      ip,
    });
    return await toAdminPackage(row);
  });
}
