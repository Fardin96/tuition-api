import type { Prisma } from "../../generated/prisma/client.js";
import { writeAudit } from "../../lib/admin.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type { AdminTeamMember } from "./admins.schema.js";

const memberInclude = {
  account: { select: { email: true, lastLoginAt: true } },
  approvedBy: { select: { name: true } },
} satisfies Prisma.AdminUserInclude;

type AdminRow = Prisma.AdminUserGetPayload<{ include: typeof memberInclude }>;

function toMember(row: AdminRow): AdminTeamMember {
  return {
    accountId: row.accountId,
    name: row.name,
    email: row.account.email,
    adminRole: row.adminRole,
    status: row.status,
    mfaEnabled: row.mfaEnabled,
    approvedAt: row.approvedAt,
    approvedByName: row.approvedBy?.name ?? null,
    removedAt: row.removedAt,
    createdAt: row.createdAt,
    lastLoginAt: row.account.lastLoginAt,
  };
}

// AdminStatus is declared PENDING, ACTIVE, REMOVED, and Postgres sorts enums in that order.
export async function listAdminTeam(): Promise<{ admins: AdminTeamMember[] }> {
  const rows = await prisma.adminUser.findMany({
    include: memberInclude,
    orderBy: [{ status: "asc" }, { createdAt: "asc" }, { accountId: "asc" }],
    take: 200,
  });
  return { admins: rows.map(toMember) };
}

export async function approveAdmin(
  accountId: string,
  caller: { accountId: string },
  ip: string | undefined,
): Promise<AdminTeamMember> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT account_id FROM admin_user WHERE account_id = ${accountId}::uuid FOR UPDATE`;
    const admin = await tx.adminUser.findUnique({
      where: { accountId },
      select: { status: true, account: { select: { status: true } } },
    });
    if (!admin) {
      throw notFound("Admin not found");
    }
    if (admin.status !== "PENDING") {
      throw appError("InvalidAdminState", 409, "Only pending admins can be approved");
    }
    if (admin.account.status !== "ACTIVE") {
      throw appError("InvalidAdminState", 409, "This account is blocked or deleted");
    }

    const updated = await tx.adminUser.update({
      where: { accountId },
      data: { status: "ACTIVE", approvedById: caller.accountId, approvedAt: new Date() },
      include: memberInclude,
    });

    await writeAudit(tx, {
      actorAccountId: caller.accountId,
      action: "admin.approve",
      entityType: "admin_user",
      entityId: accountId,
      before: { status: "PENDING" },
      after: { status: "ACTIVE" },
      ip,
    });
    return toMember(updated);
  });
}

export async function removeAdmin(
  accountId: string,
  caller: { accountId: string },
  ip: string | undefined,
): Promise<AdminTeamMember> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT account_id FROM admin_user WHERE account_id = ${accountId}::uuid FOR UPDATE`;
    const admin = await tx.adminUser.findUnique({
      where: { accountId },
      select: { status: true, adminRole: true },
    });
    if (!admin) {
      throw notFound("Admin not found");
    }
    if (accountId === caller.accountId) {
      throw appError("InvalidAdminState", 409, "You cannot remove yourself");
    }
    if (admin.adminRole === "SUPER_ADMIN") {
      throw appError("InvalidAdminState", 409, "A super admin cannot be removed");
    }
    if (admin.status === "REMOVED") {
      throw appError("InvalidAdminState", 409, "This admin was already removed");
    }

    const now = new Date();
    const updated = await tx.adminUser.update({
      where: { accountId },
      data: { status: "REMOVED", removedById: caller.accountId, removedAt: now },
      include: memberInclude,
    });
    await tx.session.updateMany({
      where: { accountId, revokedAt: null },
      data: { revokedAt: now },
    });

    await writeAudit(tx, {
      actorAccountId: caller.accountId,
      action: "admin.remove",
      entityType: "admin_user",
      entityId: accountId,
      before: { status: admin.status },
      after: { status: "REMOVED" },
      ip,
    });
    return toMember(updated);
  });
}
